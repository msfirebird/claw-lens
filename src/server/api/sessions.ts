import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';
import { findSessionFiles, CLOSED_STOP_REASONS } from '../parser';
import { getContextLimit } from '../model-meta';
import { getClawHome, cleanSlackText } from '../paths';
import * as fs from 'fs';
import * as path from 'path';

export function sessionsRouter(db: Database.Database): Router {
  const r = Router();

  // GET /api/sessions — list all sessions with summary
  r.get('/', (req: Request, res: Response) => {
    const agentFilter = req.query.agent as string | undefined;
    const fromFilter  = req.query.from  as string | undefined;
    const fromTs = fromFilter ? Number(fromFilter) : 0;

    const wheres: string[] = [];
    const params: unknown[] = [];
    if (agentFilter) { wheres.push('s.agent_name = ?'); params.push(agentFilter); }
    // Include sessions that have ANY message in range (not just started_at)
    if (fromTs > 0) {
      wheres.push('(SELECT MAX(m0.timestamp) FROM messages m0 WHERE m0.session_id = s.id) >= ?');
      params.push(fromTs);
    }
    const where = wheres.length > 0 ? ' WHERE ' + wheres.join(' AND ') : '';

    // When time filter is active, compute cost/tokens from messages in range only
    // Use parameterized queries — push fromTs into params for each subquery placeholder
    const timeFilter = fromTs > 0;
    const costExpr = timeFilter
      ? `(SELECT COALESCE(SUM(mc.cost_total), 0) FROM messages mc WHERE mc.session_id = s.id AND mc.role = 'assistant' AND mc.model NOT IN ('delivery-mirror', 'gateway-injected') AND mc.timestamp >= ?)`
      : 's.total_cost';
    const tokensExpr = timeFilter
      ? `(SELECT COALESCE(SUM(mt.total_tokens), 0) FROM messages mt WHERE mt.session_id = s.id AND mt.role = 'assistant' AND mt.model NOT IN ('delivery-mirror', 'gateway-injected') AND mt.timestamp >= ?)`
      : 's.total_tokens';
    const msgsExpr = timeFilter
      ? `(SELECT COUNT(*) FROM messages mm WHERE mm.session_id = s.id AND mm.role = 'assistant' AND mm.model NOT IN ('delivery-mirror', 'gateway-injected') AND mm.timestamp >= ?)`
      : 's.total_messages';
    const errExpr = timeFilter
      ? `(SELECT COUNT(*) FROM messages me WHERE me.session_id = s.id AND me.has_error = 1 AND me.timestamp >= ?)`
      : 's.error_count';
    const crExpr = timeFilter
      ? `(SELECT COALESCE(SUM(m2.cache_read), 0) FROM messages m2 WHERE m2.session_id = s.id AND m2.role = 'assistant' AND m2.model NOT IN ('delivery-mirror', 'gateway-injected') AND m2.timestamp >= ?)`
      : `(SELECT COALESCE(SUM(m2.cache_read), 0) FROM messages m2 WHERE m2.session_id = s.id AND m2.role = 'assistant' AND m2.model NOT IN ('delivery-mirror', 'gateway-injected'))`;
    const cwExpr = timeFilter
      ? `(SELECT COALESCE(SUM(m2.cache_write), 0) FROM messages m2 WHERE m2.session_id = s.id AND m2.role = 'assistant' AND m2.model NOT IN ('delivery-mirror', 'gateway-injected') AND m2.timestamp >= ?)`
      : `(SELECT COALESCE(SUM(m2.cache_write), 0) FROM messages m2 WHERE m2.session_id = s.id AND m2.role = 'assistant' AND m2.model NOT IN ('delivery-mirror', 'gateway-injected'))`;
    const inpExpr = timeFilter
      ? `(SELECT COALESCE(SUM(m2.input_tokens), 0) FROM messages m2 WHERE m2.session_id = s.id AND m2.role = 'assistant' AND m2.model NOT IN ('delivery-mirror', 'gateway-injected') AND m2.timestamp >= ?)`
      : `(SELECT COALESCE(SUM(m2.input_tokens), 0) FROM messages m2 WHERE m2.session_id = s.id AND m2.role = 'assistant' AND m2.model NOT IN ('delivery-mirror', 'gateway-injected'))`;

    // Build parameterized params: subquery placeholders (in SELECT) bind BEFORE WHERE clause params
    const queryParams: unknown[] = [];
    if (timeFilter) {
      // 7 subqueries need fromTs: msgs, cost, tokens, errors, cache_read, cache_write, input_tokens
      for (let i = 0; i < 7; i++) queryParams.push(fromTs);
    }
    queryParams.push(...params);

    const rows = db.prepare(`
      SELECT
        s.id,
        s.agent_name,
        s.started_at,
        s.ended_at,
        ${msgsExpr} AS total_messages,
        ${costExpr} AS total_cost,
        ${tokensExpr} AS total_tokens,
        s.primary_model,
        ${errExpr} AS error_count,
        s.is_cron,
        s.cron_task,
        s.task_summary,
        (s.ended_at - s.started_at) AS duration_ms,
        (SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id) AS last_message_at,
        ${crExpr} AS cache_read,
        ${cwExpr} AS cache_write,
        ${inpExpr} AS input_tokens,
        (SELECT m3.stop_reason FROM messages m3 WHERE m3.session_id = s.id AND m3.role = 'assistant' ORDER BY m3.timestamp DESC LIMIT 1) AS last_stop_reason
      FROM sessions s${where}
      ORDER BY s.started_at DESC
    `).all(...queryParams) as Array<Record<string, unknown>>;

    // Enrich with context pressure + burn rate
    // getContextLimit imported from ../model-meta

    const lastMsgStmt = db.prepare(`
      SELECT input_tokens, cache_read, cache_write, timestamp
      FROM messages WHERE session_id = ? AND role = 'assistant'
        AND model NOT IN ('delivery-mirror', 'gateway-injected')
        AND (input_tokens + cache_read + cache_write) > 0
      ORDER BY timestamp DESC LIMIT 1
    `);
    const last3Stmt = db.prepare(`
      SELECT input_tokens, cache_read, cache_write, timestamp
      FROM messages WHERE session_id = ? AND role = 'assistant'
        AND model NOT IN ('delivery-mirror', 'gateway-injected')
        AND (input_tokens + cache_read + cache_write) > 0
      ORDER BY timestamp DESC LIMIT 3
    `);

    const enriched = rows.map(row => {
      const model = (row.primary_model as string) || '';
      const contextLimit = getContextLimit(model);
      const lastMsg = lastMsgStmt.get(row.id) as { input_tokens: number; cache_read: number; cache_write: number; timestamp: number } | undefined;
      const contextUsed = lastMsg ? lastMsg.input_tokens + lastMsg.cache_read + lastMsg.cache_write : 0;
      const utilizationPct = contextLimit > 0 ? Math.round((contextUsed / contextLimit) * 1000) / 10 : 0;

      const last3 = (last3Stmt.all(row.id) as Array<{ input_tokens: number; cache_read: number; cache_write: number; timestamp: number }>).reverse();
      let pacing: string = 'unknown';
      let burnTokensPerMin = 0;
      if (last3.length >= 3) {
        const sizes = last3.map(m => m.input_tokens + m.cache_read + m.cache_write);
        // Simplified: (C-A)/2 — use relative threshold based on context limit
        const avgGrowth = (sizes[2] - sizes[0]) / 2;
        const threshold = contextLimit * 0.005; // 0.5% of context per message
        pacing = avgGrowth > threshold ? 'rising' : avgGrowth < -threshold ? 'cooling' : 'stable';
        const elapsed = (last3[last3.length - 1].timestamp - last3[0].timestamp) / 60000;
        if (elapsed > 0) burnTokensPerMin = Math.round(((sizes[sizes.length - 1] - sizes[0]) / elapsed) * 10) / 10;
      }

      // Determine status: ok / warning / error / aborted
      let status = 'ok';
      if ((row.error_count as number) > 0) status = 'error';

      return { ...row, contextUsed, contextLimit, utilizationPct, pacing, burnTokensPerMin, status };
    });

    res.json(enriched);
  });

  // GET /api/sessions/:id/trace — live turn-by-turn trace parsed from JSONL
  r.get('/:id/trace', (req: Request, res: Response) => {
    const { id } = req.params;

    interface SessionRow { id: string; agent_name: string; started_at: number }
    const session = db.prepare(
      `SELECT id, agent_name, started_at FROM sessions WHERE id = ?`
    ).get(id) as SessionRow | undefined;
    if (!session) { res.status(404).json({ error: 'Session not found' }); return; }

    // Pre-fetch DB tool metrics (duration, success) keyed by tool_use id
    interface DbTool { id: string; duration_ms: number | null; success: number; timestamp: number }
    const dbTools = db.prepare(
      `SELECT id, duration_ms, success, timestamp FROM tool_calls WHERE session_id = ?`
    ).all(id) as DbTool[];
    const dbToolMap = new Map(dbTools.map(t => [t.id, t]));

    // Parse the JSONL file for turn structure
    const clawHome = getClawHome();
    const jsonlPath = path.join(clawHome, 'agents', session.agent_name, 'sessions', `${id}.jsonl`);

    type ContentBlock = Record<string, unknown>;
    interface TraceTool { id: string; tool_name: string; args_preview: string | null; duration_ms: number | null; success: boolean; timestamp: number; result_preview: string | null }
    interface TraceTurn  { index: number; thinking: string | null; assistant_text: string | null; tools: TraceTool[]; stop_error: string | null }

    const CLOSED = CLOSED_STOP_REASONS;
    const ARGS_KEYS = ['command', 'path', 'file_path', 'url', 'query', 'expression', 'pattern', 'old_string', 'content'];

    function argsPreview(input: Record<string, unknown>): string | null {
      for (const k of ARGS_KEYS) {
        if (typeof input[k] === 'string' && (input[k] as string).trim()) {
          const raw = (input[k] as string).trim().replace(/\s+/g, ' ');
          return raw.length > 90 ? raw.slice(0, 90) + '…' : raw;
        }
      }
      return null;
    }

    let last_user_msg: string | null = null;
    let is_open = true;
    const turns: TraceTurn[] = [];

    try {
      const raw = fs.readFileSync(jsonlPath, 'utf-8');
      // Only parse the last 600 lines to keep it fast for long sessions
      const lines = raw.split('\n').filter(Boolean);
      const slice = lines.length > 600 ? lines.slice(lines.length - 600) : lines;

      for (const line of slice) {
        let rec: Record<string, unknown>;
        try { rec = JSON.parse(line); } catch { continue; }

        const msg = rec.message as Record<string, unknown> | undefined;
        if (!msg) continue;
        const role  = msg.role  as string | undefined;
        const blocks: ContentBlock[] = Array.isArray(msg.content) ? (msg.content as ContentBlock[]) : [];

        if (role === 'user') {
          // Capture the most recent human-readable text (not tool_result)
          let newUserMsg: string | null = null;
          for (const b of blocks) {
            if (b.type !== 'text') continue;
            const text = cleanSlackText(((b.text as string) ?? '').trim());
            if (text.length >= 6 && !text.startsWith('[media attached')) {
              newUserMsg = text.length > 140 ? text.slice(0, 140) + '…' : text;
            }
          }
          if (typeof msg.content === 'string') {
            const text = cleanSlackText((msg.content as string).trim());
            if (text.length >= 6) newUserMsg = text.length > 140 ? text.slice(0, 140) + '…' : text;
          }
          // New user message = new task; reset turns so we only show what follows
          if (newUserMsg) { last_user_msg = newUserMsg; turns.length = 0; }
        } else if (role === 'assistant') {
          const stop = (msg.stopReason ?? msg.stop_reason) as string | undefined;
          // Track open state based on LAST assistant message only
          is_open = !(stop && CLOSED.has(stop));

          const isError = stop === 'error';
          let thinking: string | null = null;
          let assistant_text: string | null = null;
          let stop_error: string | null = null;
          const tools: TraceTool[] = [];

          for (const b of blocks) {
            if (b.type === 'thinking') {
              if (!thinking) thinking = ((b.thinking as string) ?? '').trim() || null;
            } else if (b.type === 'text') {
              const text = ((b.text as string) ?? '').trim();
              if (text && !assistant_text) assistant_text = text;
              // If this message errored, capture the text as the error description
              if (isError && text && !stop_error) stop_error = text.length > 300 ? text.slice(0, 300) + '…' : text;
            } else if (b.type === 'tool_use' || b.type === 'toolCall') {
              const toolId   = b.id   as string;
              const toolName = b.name as string;
              const input    = ((b.input ?? b.arguments) ?? {}) as Record<string, unknown>;
              const db_t     = dbToolMap.get(toolId);
              tools.push({
                id:           toolId,
                tool_name:    toolName,
                args_preview: argsPreview(input),
                duration_ms:  db_t?.duration_ms ?? null,
                success:      db_t ? db_t.success === 1 : true,
                timestamp:    db_t?.timestamp ?? 0,
                result_preview: null,
              });
            }
          }

          // For error messages with no content blocks, use a generic error label
          if (isError && !stop_error) stop_error = 'stop_reason: error';
          if (thinking !== null || assistant_text !== null || tools.length > 0 || stop_error !== null) {
            turns.push({ index: turns.length, thinking, assistant_text, tools, stop_error });
          }
        } else if (role === 'toolResult') {
          // Attach tool output to the matching tool in the last turn
          const lastTurn = turns[turns.length - 1];
          if (lastTurn) {
            const toolCallId = msg.toolCallId as string | undefined;
            const details    = msg.details as Record<string, unknown> | undefined;
            const aggregated = details?.aggregated as string | undefined;
            const contentText = Array.isArray(msg.content)
              ? (msg.content as ContentBlock[]).filter(b => b.type === 'text').map(b => (b.text as string) ?? '').filter(Boolean).join('\n')
              : typeof msg.content === 'string' ? msg.content as string : null;
            const rawResult = aggregated ?? contentText ?? null;
            // Real failure signal lives in details.status — msg.isError is almost
            // always false even for errored/failed/timed-out tools. Keep isError as
            // a last-resort fallback when details.status is missing.
            const status = details?.status;
            const FAILED_STATUSES_TR = new Set(['error', 'failed', 'timeout', 'approval-unavailable']);
            const isError = msg.isError as boolean | undefined;
            const toolFailed = typeof status === 'string' && FAILED_STATUSES_TR.has(status)
              || (status === undefined && Boolean(isError));
            if (toolCallId) {
              const tool = lastTurn.tools.find(t => t.id === toolCallId);
              if (tool) {
                tool.success = !toolFailed;
                if (rawResult) tool.result_preview = rawResult.length > 500 ? rawResult.slice(0, 500) + '…' : rawResult;
              }
            }
          }
        }
      }
    } catch { /* file unreadable — return empty */ }

    // If JSONL thinks session is still open, confirm against runs.sqlite:
    // if the latest run for this agent ended with 'timed_out', the session was
    // forcibly killed and we should treat it as closed (no spinner).
    // If the latest run succeeded, leave is_open as-is (trust JSONL).
    if (is_open) {
      try {
        const runsDbPath = path.join(getClawHome(), 'tasks', 'runs.sqlite');
        if (fs.existsSync(runsDbPath)) {
          const runsDb = new Database(runsDbPath, { readonly: true });
          const cutoff = Date.now() - 3 * 60 * 60 * 1000;
          const latestRun = runsDb.prepare(
            `SELECT status FROM task_runs
             WHERE agent_id = ? AND ended_at > ?
             ORDER BY ended_at DESC LIMIT 1`
          ).get(session.agent_name, cutoff) as { status: string } | undefined;
          runsDb.close();
          if (latestRun?.status === 'timed_out') is_open = false;
        }
      } catch { /* runs.sqlite unavailable — ignore */ }
    }

    // Only return last 8 turns to keep the UI manageable
    const visibleTurns = turns.slice(-8);

    res.json({
      session_id:    session.id,
      agent_name:    session.agent_name,
      last_user_msg,
      is_open,
      started_at:    session.started_at,
      total_turns:   turns.length,
      turns:         visibleTurns,
    });
  });

  // GET /api/sessions/:id — single session + per-model breakdown
  r.get('/:id', (req: Request, res: Response) => {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const modelBreakdown = db.prepare(`
      SELECT
        model,
        COUNT(*) AS message_count,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cache_read) AS cache_read,
        SUM(cache_write) AS cache_write,
        SUM(total_tokens) AS total_tokens,
        SUM(cost_total) AS cost_total
      FROM messages
      WHERE session_id = ? AND role = 'assistant' AND model NOT IN ('delivery-mirror', 'gateway-injected')
      GROUP BY model
      ORDER BY cost_total DESC
    `).all(req.params.id);

    const toolBreakdown = db.prepare(`
      SELECT
        tool_name,
        COUNT(*) AS call_count,
        AVG(duration_ms) AS avg_duration_ms,
        MIN(duration_ms) AS min_duration_ms,
        MAX(duration_ms) AS max_duration_ms
      FROM tool_calls
      WHERE session_id = ?
      GROUP BY tool_name
      ORDER BY call_count DESC
    `).all(req.params.id);

    res.json({ session, modelBreakdown, toolBreakdown });
  });

  // GET /api/sessions/:id/messages — per-message token timeline with seq and latency
  r.get('/:id/messages', (req: Request, res: Response) => {
    // Hide assistant rows from synthetic models (delivery-mirror, gateway-injected)
    // but keep user rows (which have empty model). Matches modelBreakdown above.
    const rows = db.prepare(`
      SELECT
        id, role, model, timestamp, parent_id,
        input_tokens, output_tokens, cache_read, cache_write, total_tokens,
        cost_total, stop_reason, has_error, error_message,
        ROW_NUMBER() OVER (ORDER BY timestamp) as seq
      FROM messages
      WHERE session_id = ?
        AND (role != 'assistant' OR model NOT IN ('delivery-mirror', 'gateway-injected'))
      ORDER BY timestamp ASC
    `).all(req.params.id) as Array<Record<string, unknown>>;

    // Compute latency_ms as diff from previous message timestamp
    const result = rows.map((row, i) => ({
      ...row,
      latency_ms: i === 0 ? null : (row.timestamp as number) - (rows[i - 1].timestamp as number),
    }));

    res.json(result);
  });

  // GET /api/sessions/:id/messages/:msgId/content — raw message content from JSONL
  r.get('/:id/messages/:msgId/content', async (req: Request, res: Response) => {
    const { id: sessionId, msgId } = req.params;
    try {
      const files = await findSessionFiles();
      const sessionFile = files.find(f => path.basename(f).startsWith(sessionId));
      if (!sessionFile) { res.json({ content: null }); return; }
      const lines = fs.readFileSync(sessionFile, 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'message' && entry.id === msgId) {
            const content = entry.message.content;
            // Flatten content to readable format
            if (Array.isArray(content)) {
              const items = content.map((c: Record<string, unknown>) => {
                if (c.type === 'text') return { type: 'text', text: c.text };
                if (c.type === 'tool_use') return { type: 'tool_use', name: c.name, id: c.id, input: c.input };
                if (c.type === 'tool_result') return { type: 'tool_result', tool_use_id: c.tool_use_id, content: c.content };
                return c;
              });
              res.json({ content: items });
            } else {
              res.json({ content: [{ type: 'text', text: String(content || '') }] });
            }
            return;
          }
        } catch { /* skip malformed lines */ }
      }
      res.json({ content: null });
    } catch (err) {
      console.error('session content read failed:', err);
      res.json({ content: null, error: 'Failed to read session content' });
    }
  });

  return r;
}
