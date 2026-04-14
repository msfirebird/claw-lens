import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { getContextLimit } from '../model-meta';
import { getClawHome, listRegisteredAgents, cleanSlackText } from '../paths';

interface AgentConfig {
  files: number;
  tools_profile: string;
  skills: string[];
  channels: string[];
  cron_tasks: string[];
}

interface OpenClawConfig {
  agents?: { list?: Array<{ id: string; name?: string; workspace?: string; identity?: { name?: string; emoji?: string } }> };
  tools?: { profile?: string };
  bindings?: Array<{ agentId?: string; match?: { channel?: string } }>;
  channels?: Record<string, { enabled?: boolean }>;
}

/** Read per-agent config: skills, channels, files, tools, cron tasks */
function readAgentConfig(agentId: string, db: Database.Database): AgentConfig {
  const base = getClawHome();

  // --- tool profile (global) ---
  let toolsProfile = 'default';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(base, 'openclaw.json'), 'utf-8')) as OpenClawConfig;
    toolsProfile = cfg.tools?.profile ?? 'default';

    // --- channels: from bindings ---
    const channels = (cfg.bindings ?? [])
      .filter(b => b.agentId === agentId && b.match?.channel)
      .map(b => b.match!.channel!);
    const uniqueChannels = [...new Set(channels)];

    // --- skills: from most recent sessions.json ---
    const sessionsJsonPath = path.join(base, 'agents', agentId, 'sessions', 'sessions.json');
    let skills: string[] = [];
    try {
      const sessions = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf-8')) as Record<string, { skillsSnapshot?: { skills?: Array<{ name: string }> } }>;
      for (const s of Object.values(sessions)) {
        const ss = s.skillsSnapshot?.skills;
        if (ss && ss.length > 0) { skills = ss.map(sk => sk.name); break; }
      }
    } catch { /* no sessions yet */ }

    // --- workspace files (*.md only — context docs) ---
    const agentEntry = (cfg.agents?.list ?? []).find(a => a.id === agentId);
    const workspaceDir = agentEntry?.workspace
      ?? (agentId === 'main' ? path.join(base, 'workspace') : path.join(base, `workspace-${agentId}`));
    let fileCount = 0;
    try {
      fileCount = fs.readdirSync(workspaceDir)
        .filter(f => f.endsWith('.md') || f.endsWith('.txt')).length;
    } catch { /* workspace not created yet */ }

    // --- cron tasks from live jobs.json (always reflects current names) ---
    let cronTasks: string[] = [];
    try {
      const jobsPath = path.join(getClawHome(), 'cron', 'jobs.json');
      const jobsFile = JSON.parse(fs.readFileSync(jobsPath, 'utf-8')) as {
        jobs?: Array<{ agentId?: string; name?: string; enabled?: boolean }>;
      };
      cronTasks = (jobsFile.jobs ?? [])
        .filter(j => j.agentId === agentId && j.name)
        .map(j => j.name!);
    } catch { /* jobs.json not present */ }

    return { files: fileCount, tools_profile: toolsProfile, skills, channels: uniqueChannels, cron_tasks: cronTasks };
  } catch {
    return { files: 0, tools_profile: toolsProfile, skills: [], channels: [], cron_tasks: [] };
  }
}

/** Registered agent names (delegates to shared helper in paths.ts). */
const listAgentDirs = listRegisteredAgents;

const HEARTBEAT_RE = /\b(heartbeat|heart.beat|health.?check|ping|keep.?alive)\b/i;

// getContextLimit imported from ../model-meta (single source of truth)

interface LastSessionOutcome {
  ok: boolean;           // true if last session had no errors
  context_pct: number | null; // input_tokens of last msg / model context limit × 100
}

function getLastSessionOutcome(agentName: string, db: Database.Database): LastSessionOutcome {
  interface SRow { id: string; error_count: number; primary_model: string | null }
  const s = db.prepare(
    `SELECT id, error_count, primary_model FROM sessions WHERE agent_name = ? ORDER BY started_at DESC LIMIT 1`
  ).get(agentName) as SRow | undefined;

  if (!s) return { ok: true, context_pct: null };

  const ok = s.error_count === 0;

  // Context window usage = input_tokens + cache_read + cache_write (total input side)
  interface MRow { context_tokens: number; model: string }
  const m = db.prepare(
    `SELECT (input_tokens + cache_read + cache_write) AS context_tokens, model
     FROM messages WHERE session_id = ? AND role = 'assistant'
       AND model NOT IN ('delivery-mirror', 'gateway-injected')
     ORDER BY timestamp DESC LIMIT 1`
  ).get(s.id) as MRow | undefined;

  let context_pct: number | null = null;
  if (m) {
    const limit = getContextLimit(m.model || s.primary_model);
    if (limit && m.context_tokens > 0) {
      context_pct = Math.round((m.context_tokens / limit) * 100);
    }
  }
  return { ok, context_pct };
}

type HealthStatus = 'healthy' | 'warning' | 'error';
interface HealthResult {
  status: HealthStatus;
  reasons: string[];
}

/**
 * Compute agent health from the most recent active session's last MESSAGE_WINDOW messages.
 * Old sessions with historical errors do NOT affect current health status.
 * If the most recent message is older than STALE_MS, health is automatically "healthy"
 * (old errors are no longer actionable).
 */
const MESSAGE_WINDOW = 10;
const STALE_MS = 6 * 60 * 60 * 1000; // 6 hours

function computeHealth(agentName: string, db: Database.Database): HealthResult {
  // Find the most recent non-cron session
  interface SessionRow { id: string }
  const activeSession = db.prepare(
    `SELECT id FROM sessions WHERE agent_name = ? AND is_cron = 0 ORDER BY started_at DESC LIMIT 1`
  ).get(agentName) as SessionRow | undefined;

  if (!activeSession) return { status: 'healthy', reasons: [] };

  // Check if the most recent message is older than 6h — if so, stale errors are not actionable
  const lastTs = db.prepare(
    `SELECT MAX(timestamp) AS ts FROM messages WHERE session_id = ?`
  ).get(activeSession.id) as { ts: number | null } | undefined;

  if (!lastTs?.ts || (Date.now() - lastTs.ts > STALE_MS)) {
    return { status: 'healthy', reasons: [] };
  }

  interface MsgStats {
    tool_errors: number;
    has_stop_error: number;
    has_length: number;
  }
  // Look at only the last MESSAGE_WINDOW messages in the current session.
  // OpenClaw uses pi-ai stop_reason names: 'stop' / 'toolUse' / 'error' / 'aborted' / 'length'.
  // 'length' is the equivalent of Anthropic's max_tokens (output token limit hit).
  const stats = db.prepare(`
    SELECT
      COALESCE(SUM(has_error), 0)                                          AS tool_errors,
      MAX(CASE WHEN stop_reason = 'error'  THEN 1 ELSE 0 END)              AS has_stop_error,
      MAX(CASE WHEN stop_reason = 'length' THEN 1 ELSE 0 END)              AS has_length
    FROM (
      SELECT has_error, stop_reason
      FROM messages
      WHERE session_id = ?
      ORDER BY timestamp DESC
      LIMIT ${MESSAGE_WINDOW}
    )
  `).get(activeSession.id) as MsgStats;

  const reasons: string[] = [];

  // Error conditions
  if (stats.has_stop_error === 1) reasons.push('session ended with an error');
  if (stats.tool_errors >= 3)     reasons.push(`${stats.tool_errors} tool failures in last ${MESSAGE_WINDOW} messages`);
  if (reasons.length > 0) return { status: 'error', reasons };

  // Warning conditions
  if (stats.tool_errors >= 1) reasons.push(`${stats.tool_errors} tool failure in last ${MESSAGE_WINDOW} messages`);
  if (stats.has_length === 1) reasons.push('hit length limit — model output truncated');
  if (reasons.length > 0) return { status: 'warning', reasons };

  return { status: 'healthy', reasons: [] };
}


/**
 * Read the latest JSONL session file for an agent and return the last user
 * message text, truncated to 70 chars.  Returns null if nothing useful found.
 */
interface LastUserMessage { text: string; source: 'slack' | 'direct' | null; session_id: string | null }

function getLastUserMessage(agentId: string): LastUserMessage | null {
  try {
    const sessionsDir = path.join(getClawHome(), 'agents', agentId, 'sessions');
    const files = fs.readdirSync(sessionsDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f, mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) return null;

    const sessionId = files[0].f.replace('.jsonl', '');
    const latestPath = path.join(sessionsDir, files[0].f);
    const lines = fs.readFileSync(latestPath, 'utf-8').split('\n').filter(Boolean);

    for (let i = lines.length - 1; i >= 0; i--) {
      let rec: Record<string, unknown>;
      try { rec = JSON.parse(lines[i]); } catch { continue; }

      const msg = rec.message as Record<string, unknown> | undefined;
      if (!msg || msg.role !== 'user') continue;

      const raw = msg.content;
      let text = '';
      if (typeof raw === 'string') {
        text = raw;
      } else if (Array.isArray(raw) && raw.length > 0) {
        // Skip messages that are purely image/tool_result with no text content
        const hasImageOnly = (raw as Record<string, unknown>[]).every(
          item => item.type === 'image' || item.type === 'tool_result'
        );
        if (hasImageOnly) continue;
        // Find first text item
        const textItem = (raw as Record<string, unknown>[]).find(
          item => item.type === 'text' || typeof item === 'string'
        ) as Record<string, unknown> | string | undefined;
        if (!textItem) continue;
        text = (typeof textItem === 'string' ? textItem : (textItem.text as string)) ?? '';
      }

      // Detect source before stripping
      const isSlack = /slack/i.test(text.slice(0, 120));

      text = cleanSlackText(text);
      if (text.startsWith('Conversation info (untrusted metadata)')) continue;
      if (text.startsWith('[media attached:')) continue; // skip screenshot/image-only messages
      if (!text) continue;

      text = text.replace(/\s+/g, ' ').trim();
      if (HEARTBEAT_RE.test(text) || text.length < 6) return { text: 'Heartbeat check', source: null, session_id: sessionId };

      return {
        text: text.length > 70 ? text.slice(0, 70) + '…' : text,
        source: isSlack ? 'slack' : 'direct',
        session_id: sessionId,
      };
    }
  } catch { /* file not readable */ }
  return null;
}

export function statsRouter(db: Database.Database): Router {
  const r = Router();

  type LiveStep =
    | { type: 'user';    text: string }
    | { type: 'ai';      text: string }
    | { type: 'tool';    name: string }
    | { type: 'error';   text: string }
    | { type: 'waiting' }
    | { type: 'done' };

  function buildSteps(filePath: string, status: string): LiveStep[] {
    try {
      const stat = fs.statSync(filePath);
      const fd = fs.openSync(filePath, 'r');
      const chunkSize = Math.min(65536, stat.size);
      const buf = Buffer.alloc(chunkSize);
      fs.readSync(fd, buf, 0, chunkSize, Math.max(0, stat.size - chunkSize));
      fs.closeSync(fd);

      const raw = buf.toString('utf-8');
      // drop potentially partial first line when reading from middle of file
      const allLines = raw.split('\n');
      const lines = stat.size > chunkSize ? allLines.slice(1) : allLines;

      // Find index of last user message so we only show current turn
      let startIdx = 0;
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i].trim();
        if (!l) continue;
        try {
          const e = JSON.parse(l);
          const m = (e.message ?? e) as Record<string, unknown>;
          if (m.role === 'user') { startIdx = i; break; }
        } catch { /* skip */ }
      }

      const steps: LiveStep[] = [];
      let lastStepType = '';

      for (let i = startIdx; i < lines.length; i++) {
        const l = lines[i].trim();
        if (!l) continue;
        let entry: Record<string, unknown>;
        try { entry = JSON.parse(l); } catch { continue; }
        const msg = (entry.message ?? entry) as Record<string, unknown>;
        const role = msg.role as string;
        if (!role) continue;

        if (role === 'user') {
          const c = msg.content;
          let raw = typeof c === 'string'
            ? c
            : Array.isArray(c)
              ? (c as Record<string,unknown>[]).filter(b => b.type === 'text').map(b => b.text as string).join(' ')
              : '';
          // Strip cron prefix
          raw = raw.replace(/^\[cron:[^\]]+\]\s*/, '');
          // Remove metadata JSON blocks (```json...```)
          raw = raw.replace(/```[\s\S]*?```/g, '');
          // Remove Conversation info / Sender labels
          raw = raw.replace(/(Conversation info|Sender)\s*\([^)]*\):\s*/g, '');
          // Remove System: [timestamp] header lines
          raw = raw.replace(/^System:\s*\[[^\]]+\]\s*[^\n]*/gm, '');
          const text = raw.replace(/\n{2,}/g, ' ').trim();
          if (text.length >= 2) { steps.push({ type: 'user', text }); lastStepType = 'user'; }

        } else if (role === 'assistant') {
          const c = msg.content;
          if (!Array.isArray(c)) continue;
          const stop = (msg.stopReason ?? msg.stop_reason) as string | undefined;
          let aiText = '';
          for (const b of c as Record<string,unknown>[]) {
            if ((b.type === 'tool_use' || b.type === 'toolCall') && b.name) {
              steps.push({ type: 'tool', name: b.name as string });
              lastStepType = 'tool';
            } else if (b.type === 'text' && !aiText) {
              aiText = ((b.text as string) ?? '').trim();
            }
          }
          // pi-ai stop_reason values: 'stop' / 'toolUse' / 'error' / 'aborted' / 'length'.
          // 'length' = max_tokens equivalent (output truncated). 'stop' = normal completion.
          if (stop === 'error' || stop === 'aborted' || stop === 'length') {
            steps.push({ type: 'error', text: aiText || `stop: ${stop}` });
            lastStepType = 'error';
          } else if (aiText) {
            steps.push({ type: 'ai', text: aiText });
            lastStepType = 'ai';
          }
          if (stop === 'stop' && !aiText && lastStepType !== 'tool') {
            steps.push({ type: 'done' });
            lastStepType = 'done';
          }
        }
      }

      // Add terminal state if still running and last visible step is a tool
      if (status === 'running' && (lastStepType === 'tool' || lastStepType === 'user')) {
        steps.push({ type: 'waiting' });
      }

      return steps;
    } catch { return []; }
  }

  // GET /api/stats/live-sessions — all sessions active in last 3h, for Live Monitor
  r.get('/live-sessions', (_req: Request, res: Response) => {
    const now = Date.now();
    const WINDOW_MS        = 3  * 60 * 60 * 1000; // show for 3 hours
    const IDLE_THRESHOLD   = 30 * 60 * 1000;       // idle after 30 min
    const cutoff = now - WINDOW_MS;

    interface IngestRow { file_path: string; mtime_ms: number }
    const ingestRows = db.prepare(`
      SELECT file_path, mtime_ms FROM ingest_state
      WHERE mtime_ms > ?
        AND file_path NOT LIKE '%.deleted%'
        AND file_path NOT LIKE '%.reset%'
        AND file_path LIKE '%.jsonl'
      ORDER BY mtime_ms DESC
    `).all(cutoff) as IngestRow[];

    const lastToolStmt = db.prepare(
      `SELECT tool_name FROM tool_calls WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1`
    );
    const failuresStmt = db.prepare(`
      SELECT COUNT(*) AS cnt FROM (
        SELECT success FROM tool_calls WHERE session_id = ? ORDER BY timestamp DESC LIMIT 5
      ) WHERE success = 0
    `);
    const lastStopStmt = db.prepare(
      `SELECT stop_reason FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY timestamp DESC LIMIT 1`
    );
    const sessionStmt = db.prepare(`SELECT agent_name, task_summary FROM sessions WHERE id = ?`);

    const seen = new Set<string>();
    const results: unknown[] = [];

    for (const row of ingestRows) {
      const sessionId = path.basename(row.file_path).replace('.jsonl', '');
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);

      const session = sessionStmt.get(sessionId) as { agent_name: string; task_summary: string | null } | undefined;
      if (!session) continue;

      const lastTool       = lastToolStmt.get(sessionId) as { tool_name: string } | undefined;
      const failures       = failuresStmt.get(sessionId) as { cnt: number } | undefined;
      const lastStop       = lastStopStmt.get(sessionId) as { stop_reason: string | null } | undefined;
      const hasFailures    = (failures?.cnt ?? 0) > 0
        || lastStop?.stop_reason === 'error'
        || lastStop?.stop_reason === 'length'
        || lastStop?.stop_reason === 'aborted';

      const idleMs = now - row.mtime_ms;
      const status = idleMs >= IDLE_THRESHOLD
        ? 'idle'
        : hasFailures ? 'stuck' : 'running';

      const taskSummary = session.task_summary
        ? cleanSlackText(session.task_summary).slice(0, 80) || null
        : null;

      const steps = buildSteps(row.file_path, status);

      results.push({
        session_id:           sessionId,
        agent_name:           session.agent_name,
        task_summary:         taskSummary,
        file_mtime_ms:        row.mtime_ms,
        idle_ms:              idleMs,
        status,
        last_tool:            lastTool?.tool_name ?? null,
        stop_reason:          lastStop?.stop_reason ?? null,
        has_recent_failures:  hasFailures,
        steps,
      });
    }

    res.json({ sessions: results });
  });

  // GET /api/stats — top-level summary numbers for dashboard header
  r.get('/', (req: Request, res: Response) => {
    const agentFilter = req.query.agent as string | undefined;
    const modelFilter = req.query.model as string | undefined;
    const fromFilter  = req.query.from  as string | undefined;

    // Session-level WHERE conditions — go into outer WHERE
    const sessionWheres: string[] = [];
    const sessionParams: unknown[] = [];
    if (agentFilter) { sessionWheres.push('s.agent_name = ?'); sessionParams.push(agentFilter); }
    if (fromFilter)  { sessionWheres.push('s.started_at >= ?'); sessionParams.push(Number(fromFilter)); }

    // Message-level conditions — MUST go into the LEFT JOIN ON clause, not WHERE.
    // Putting m.* filters in WHERE turns LEFT JOIN into effective INNER JOIN and drops
    // sessions that have no matching assistant rows from total_sessions.
    const joinConds: string[] = [
      "m.role = 'assistant'",
      "m.model NOT IN ('delivery-mirror', 'gateway-injected')",
    ];
    const joinParams: unknown[] = [];
    if (modelFilter) { joinConds.push('m.model = ?'); joinParams.push(modelFilter); }

    const whereClause = sessionWheres.length > 0 ? ' WHERE ' + sessionWheres.join(' AND ') : '';

    const row = db.prepare(`
      SELECT
        COUNT(DISTINCT s.id)                            AS total_sessions,
        COUNT(DISTINCT s.agent_name)                    AS total_agents,
        COUNT(m.id)                                     AS total_messages,
        COALESCE(SUM(m.cost_total), 0)                  AS total_cost,
        COALESCE(SUM(m.total_tokens), 0)                AS total_tokens,
        MIN(m.timestamp)                                AS first_ts,
        MAX(m.timestamp)                                AS last_ts
      FROM sessions s
      LEFT JOIN messages m ON m.session_id = s.id AND ${joinConds.join(' AND ')}
      ${whereClause}
    `).get(...joinParams, ...sessionParams) as Record<string, unknown>;

    const toolWheres: string[] = [];
    const toolParams: unknown[] = [];
    if (agentFilter) { toolWheres.push('s.agent_name = ?'); toolParams.push(agentFilter); }
    if (fromFilter)  { toolWheres.push('s.started_at >= ?'); toolParams.push(Number(fromFilter)); }
    const toolWhere = toolWheres.length > 0 ? ' WHERE ' + toolWheres.join(' AND ') : '';
    const toolRow = db.prepare(`
      SELECT COUNT(*) AS total_tool_calls
      FROM tool_calls tc
      ${agentFilter || fromFilter ? `JOIN sessions s ON tc.session_id = s.id${toolWhere}` : ''}
    `).get(...toolParams) as { total_tool_calls: number };

    const agents = db.prepare(`
      SELECT DISTINCT agent_name FROM sessions ORDER BY agent_name
    `).all() as { agent_name: string }[];

    // Merge DB agents + FS dirs, exclude agents whose directories no longer exist
    const activeDirs = new Set(listAgentDirs());
    const agentNames = [
      ...new Set([
        ...agents.map(a => a.agent_name).filter(n => activeDirs.has(n)),
        ...activeDirs,
      ]),
    ].sort();

    res.json({
      ...row,
      total_tool_calls: toolRow.total_tool_calls,
      agents: agentNames,
    });
  });

  // GET /api/stats/models — model cost breakdown
  r.get('/models', (req: Request, res: Response) => {
    const agentFilter = req.query.agent as string | undefined;
    const modelFilter = req.query.model as string | undefined;
    const fromFilter  = req.query.from  as string | undefined;

    const wheres: string[] = ["m.role = 'assistant'", "m.model NOT IN ('delivery-mirror', 'gateway-injected')"];
    const params: unknown[] = [];
    let join = '';

    if (agentFilter || fromFilter) {
      join = ' JOIN sessions s ON m.session_id = s.id';
      if (agentFilter) { wheres.push('s.agent_name = ?'); params.push(agentFilter); }
      if (fromFilter)  { wheres.push('s.started_at >= ?'); params.push(Number(fromFilter)); }
    }
    if (modelFilter) { wheres.push('m.model = ?'); params.push(modelFilter); }

    const rows = db.prepare(`
      SELECT
        m.model,
        COUNT(*) AS message_count,
        SUM(m.input_tokens) AS input_tokens,
        SUM(m.output_tokens) AS output_tokens,
        SUM(m.cache_read) AS cache_read,
        SUM(m.cache_write) AS cache_write,
        SUM(m.total_tokens) AS total_tokens,
        SUM(m.cost_total) AS cost_total
      FROM messages m${join}
      WHERE ${wheres.join(' AND ')}
      GROUP BY m.model
      ORDER BY cost_total DESC
    `).all(...params);
    res.json(rows);
  });

  // GET /api/stats/agents — per-agent status & health
  r.get('/agents', (req: Request, res: Response) => {
    const now = Date.now();
    const fromFilter = req.query.from ? Number(req.query.from) : undefined;
    const day30 = fromFilter ?? (now - 30 * 86400000);
    const day7  = now - 7  * 86400000;
    // "Today" = from midnight local time (not rolling 24h)
    const todayMidnight = new Date(now);
    todayMidnight.setHours(0, 0, 0, 0);
    const dayStart = todayMidnight.getTime();

    interface AgentRow {
      agent_name: string;
      total_sessions: number;
      total_cost: number;
      total_messages: number;
      total_errors: number;
      first_seen: number;
      last_session_start: number;
      avg_duration_ms: number | null;
      primary_model: string | null;
    }
    interface AgentMsg {
      agent_name: string;
      last_msg_ts: number;
    }
    interface AgentPeriod {
      agent_name: string;
      sessions: number;
      cost: number;
      errors: number;
      error_sessions?: number;   // sessions that had ≥1 error
      total_messages?: number;   // total messages in the period
    }

    interface AgentCurrentTask {
      agent_name: string;
      current_task: string | null;
    }
    interface AgentCronFlag {
      agent_name: string;
      has_cron: number;
    }

    const agentRows = db.prepare(`
      SELECT
        agent_name,
        COUNT(*) as total_sessions,
        COALESCE(SUM(total_cost), 0) as total_cost,
        COALESCE(SUM(total_messages), 0) as total_messages,
        COALESCE(SUM(error_count), 0) as total_errors,
        MIN(started_at) as first_seen,
        MAX(started_at) as last_session_start,
        AVG(CASE WHEN ended_at IS NOT NULL AND ended_at > started_at THEN ended_at - started_at END) as avg_duration_ms,
        (SELECT primary_model FROM sessions s2
          WHERE s2.agent_name = sessions.agent_name
            AND primary_model IS NOT NULL
            AND primary_model NOT IN ('auto', 'default', 'unknown')
          ORDER BY started_at DESC LIMIT 1) as primary_model
      FROM sessions
      GROUP BY agent_name
      ORDER BY SUM(total_tokens) DESC
    `).all() as AgentRow[];

    // Whether agent has ever had a cron session
    const cronFlagRows = db.prepare(`
      SELECT agent_name, MAX(is_cron) AS has_cron FROM sessions GROUP BY agent_name
    `).all() as AgentCronFlag[];
    const cronMap = new Map(cronFlagRows.map(r => [r.agent_name, r.has_cron === 1]));

    // All known agent names (DB + filesystem dirs)
    const dbAgentNames = new Set(agentRows.map(r => r.agent_name));
    const fsAgentNames = listAgentDirs();

    const lastMsgRows = db.prepare(`
      SELECT agent_name, MAX(timestamp) as last_msg_ts
      FROM messages GROUP BY agent_name
    `).all() as AgentMsg[];
    const lastMsgMap = new Map(lastMsgRows.map(r => [r.agent_name, r.last_msg_ts]));

    // Aggregate by MESSAGE timestamp, not session.started_at, so that a session which
    // started before the window but is still active contributes its in-window activity.
    // Counts are derived from assistant messages in real (billable) models only — matching
    // the canonical definition used by /api/tokens/summary and /api/timeline.
    const periodAggSql = `
      SELECT s.agent_name,
        COUNT(DISTINCT s.id)                                           AS sessions,
        COALESCE(SUM(m.cost_total), 0)                                 AS cost,
        COALESCE(SUM(m.has_error), 0)                                  AS errors,
        COUNT(DISTINCT CASE WHEN m.has_error = 1 THEN s.id END)        AS error_sessions,
        COUNT(m.id)                                                    AS total_messages
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE m.timestamp >= ?
        AND m.role = 'assistant'
        AND m.model NOT IN ('delivery-mirror', 'gateway-injected')
      GROUP BY s.agent_name
    `;
    const rows30d = db.prepare(periodAggSql).all(day30) as AgentPeriod[];
    const map30d = new Map(rows30d.map(r => [r.agent_name, r]));

    const rows7d = db.prepare(periodAggSql).all(day7) as AgentPeriod[];
    const map7d = new Map(rows7d.map(r => [r.agent_name, r]));

    // Cache hit rate (7d): cache_read / (input_tokens + cache_read) per agent.
    // Filter by message timestamp to match rows7d/rows30d semantics.
    interface CacheRow { agent_name: string; cache_read: number; cache_write: number; input_tokens: number }
    const cacheRows7d = db.prepare(`
      SELECT s.agent_name,
        COALESCE(SUM(m.cache_read), 0)    AS cache_read,
        COALESCE(SUM(m.cache_write), 0)   AS cache_write,
        COALESCE(SUM(m.input_tokens), 0)  AS input_tokens
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE m.timestamp >= ? AND m.role = 'assistant' AND m.model NOT IN ('delivery-mirror', 'gateway-injected')
      GROUP BY s.agent_name
    `).all(day7) as CacheRow[];
    const cacheMap7d = new Map(cacheRows7d.map(r => [r.agent_name, r]));

    const rowsToday = db.prepare(`
      SELECT s.agent_name,
        COUNT(DISTINCT s.id) as sessions,
        COALESCE(SUM(m.cost_total), 0) as cost
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE m.timestamp >= ? AND m.role = 'assistant' AND m.model NOT IN ('delivery-mirror', 'gateway-injected')
      GROUP BY s.agent_name
    `).all(dayStart) as AgentPeriod[];
    const mapToday = new Map(rowsToday.map(r => [r.agent_name, r]));

    // Hourly activity: last 24 hours, bucketed by MESSAGE timestamp (not session.started_at)
    // so a long-running session shows up in every hour it emits a message.
    interface HourlyCell { hour_slot: number; sessions: number; error_sessions: number }
    interface AgentHourlyRow { agent_name: string; hour_slot: number; sessions: number; error_sessions: number }
    const hour24Ago = now - 24 * 3600000;
    const hourlyRows = db.prepare(`
      SELECT s.agent_name,
        CAST(strftime('%s', m.timestamp / 1000, 'unixepoch', 'localtime') / 3600 AS INTEGER) AS hour_slot,
        COUNT(DISTINCT s.id) AS sessions,
        COUNT(DISTINCT CASE WHEN m.has_error = 1 THEN s.id END) AS error_sessions
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE m.timestamp >= ?
        AND m.role = 'assistant'
        AND m.model NOT IN ('delivery-mirror', 'gateway-injected')
      GROUP BY s.agent_name, hour_slot
    `).all(hour24Ago) as AgentHourlyRow[];
    const hourlyMap = new Map<string, HourlyCell[]>();
    for (const row of hourlyRows) {
      if (!hourlyMap.has(row.agent_name)) hourlyMap.set(row.agent_name, []);
      hourlyMap.get(row.agent_name)!.push({ hour_slot: row.hour_slot, sessions: row.sessions, error_sessions: row.error_sessions });
    }

    const buildAgent = (row: AgentRow) => {
      const lastMsg = lastMsgMap.get(row.agent_name) ?? row.last_session_start;

      const IDLE_THRESHOLD = 30 * 60 * 1000;

      const ingestRow = db.prepare(
        `SELECT mtime_ms FROM ingest_state
         WHERE file_path LIKE ? AND file_path NOT LIKE '%.deleted%' AND file_path NOT LIKE '%.reset%'
         ORDER BY mtime_ms DESC LIMIT 1`
      ).get(`%/agents/${row.agent_name}/sessions/%.jsonl`) as { mtime_ms: number } | undefined;

      const lastToolRow = db.prepare(
        `SELECT tc.tool_name FROM tool_calls tc
         JOIN sessions s ON tc.session_id = s.id
         WHERE s.agent_name = ? ORDER BY tc.timestamp DESC LIMIT 1`
      ).get(row.agent_name) as { tool_name: string } | undefined;

      const failuresRow = db.prepare(`
        SELECT COUNT(*) AS cnt FROM (
          SELECT tc.success FROM tool_calls tc
          JOIN sessions s ON tc.session_id = s.id
          WHERE s.agent_name = ? ORDER BY tc.timestamp DESC LIMIT 5
        ) WHERE success = 0
      `).get(row.agent_name) as { cnt: number } | undefined;

      const lastStopRow = db.prepare(
        `SELECT m.stop_reason FROM messages m
         JOIN sessions s ON m.session_id = s.id
         WHERE s.agent_name = ? AND m.role = 'assistant'
         ORDER BY m.timestamp DESC LIMIT 1`
      ).get(row.agent_name) as { stop_reason: string | null } | undefined;

      const fileMtimeMs = ingestRow?.mtime_ms ?? null;
      const hasFailures = (failuresRow?.cnt ?? 0) > 0
        || lastStopRow?.stop_reason === 'error'
        || lastStopRow?.stop_reason === 'length'
        || lastStopRow?.stop_reason === 'aborted';
      const mtimeAge = fileMtimeMs !== null ? now - fileMtimeMs : Infinity;

      const status: 'running' | 'stuck' | 'idle' | 'stale' =
        mtimeAge >= IDLE_THRESHOLD ? 'idle' :
        hasFailures ? 'stuck' : 'running';

      const d30    = map30d.get(row.agent_name);
      const d7     = map7d.get(row.agent_name);
      const dToday = mapToday.get(row.agent_name);
      // Error rate: % of 7d sessions that had ≥1 error (session-level)
      const errorRate7d = d7 && d7.sessions > 0
        ? (d7.error_sessions ?? 0) / d7.sessions
        : null;
      const cacheData = cacheMap7d.get(row.agent_name);
      // cache_write is NOT a cache hit — exclude from denominator
      const cacheHitRate7d = cacheData && (cacheData.input_tokens + cacheData.cache_read) > 0
        ? cacheData.cache_read / (cacheData.input_tokens + cacheData.cache_read)
        : null;
      const lastOutcome = getLastSessionOutcome(row.agent_name, db);
      const health = computeHealth(row.agent_name, db);

      // Elevate health based on context pressure from last session
      if (lastOutcome.context_pct !== null && health.status !== 'error') {
        if (lastOutcome.context_pct >= 100) {
          health.reasons.push(`context at ${lastOutcome.context_pct}% — likely hit limit`);
          health.status = 'error';
        } else if (lastOutcome.context_pct >= 80 && health.status === 'healthy') {
          health.reasons.push(`context at ${lastOutcome.context_pct}% — approaching limit`);
          health.status = 'warning';
        }
      }

      const activityTs = fileMtimeMs ?? lastMsg;

      return {
        agent_name: row.agent_name,
        dir_exists: fsAgentNames.includes(row.agent_name),
        status,
        last_activity_ts: activityTs,
        idle_ms: now - activityTs,
        first_seen: row.first_seen,
        primary_model: row.primary_model,
        avg_session_duration_ms: row.avg_duration_ms ? Math.round(row.avg_duration_ms) : null,
        error_rate: errorRate7d !== null ? parseFloat(errorRate7d.toFixed(4)) : null,
        cache_hit_rate: cacheHitRate7d !== null ? parseFloat(cacheHitRate7d.toFixed(4)) : null,
        current_task: getLastUserMessage(row.agent_name),
        last_tool: lastToolRow?.tool_name ?? null,
        file_mtime_ms: fileMtimeMs,
        health,
        in_schedule: cronMap.get(row.agent_name) ?? false,
        config: readAgentConfig(row.agent_name, db),
        today: {
          sessions: dToday?.sessions ?? 0,
          cost: parseFloat((dToday?.cost ?? 0).toFixed(4)),
        },
        last_session: lastOutcome,
        all_time: {
          sessions: row.total_sessions,
          cost: parseFloat(row.total_cost.toFixed(4)),
          messages: row.total_messages,
          errors: row.total_errors,
        },
        last_30d: {
          sessions: d30?.sessions ?? 0,
          cost: parseFloat((d30?.cost ?? 0).toFixed(4)),
          errors: d30?.errors ?? 0,
        },
        last_7d: {
          sessions: d7?.sessions ?? 0,
          cost: parseFloat((d7?.cost ?? 0).toFixed(4)),
        },
        hourly: hourlyMap.get(row.agent_name) ?? [],
      };
    };

    const agents = [
      ...agentRows.map(buildAgent),
      // Agents that exist on disk but have no sessions yet
      ...fsAgentNames
        .filter(name => !dbAgentNames.has(name))
        .map(name => ({
          agent_name: name,
          dir_exists: true,
          status: 'stale' as const,
          last_activity_ts: 0,
          idle_ms: Infinity,
          first_seen: 0,
          primary_model: null,
          avg_session_duration_ms: null,
          error_rate: null,
          cache_hit_rate: null,
          current_task: null,
          last_tool: null,
          health: { status: 'healthy' as HealthStatus, reasons: [] },
          in_schedule: false,
          config: readAgentConfig(name, db),
          today:      { sessions: 0, cost: 0 },
          last_session: { ok: true, context_pct: null } as LastSessionOutcome,
          all_time:  { sessions: 0, cost: 0, messages: 0, errors: 0 },
          last_30d:  { sessions: 0, cost: 0, errors: 0 },
          last_7d:   { sessions: 0, cost: 0 },
          hourly:    [],
        })),
    ].filter(a => a.dir_exists);

    const summary = {
      total:   agents.length,
      running: agents.filter(a => a.status === 'running' || a.status === 'stuck').length,
      idle:    agents.filter(a => a.status === 'idle').length,
      stale:   agents.filter(a => a.status === 'stale').length,
    };

    res.json({ agents, summary });
  });

  // GET /api/stats/agents/:name/daily — daily sessions + tokens for the last 30 days
  r.get('/agents/:name/daily', (req: Request, res: Response) => {
    const agentName = req.params.name;
    const days = Math.min(Number(req.query.days ?? 30), 90);
    const now = Date.now();
    const from = now - days * 86400000;

    interface DayRow {
      day: string;
      sessions: number;
      messages: number;
      total_tokens: number;
      total_cost: number;
      worst_health: 0 | 1 | 2 | null;  // 0=healthy, 1=warning, 2=error, null=no sessions
      error_sessions: number;
      max_tokens_sessions: number;     // sessions where any msg hit length (max_tokens equivalent)
      interrupted_sessions: number;    // sessions where any msg was aborted
    }

    // Bucket by MESSAGE day, not session.started_at. A long session emits messages on
    // multiple days; each day should reflect that day's cost/tokens/activity.
    // pi-ai stop_reason names: 'length' = max_tokens, 'aborted' = interrupted.
    const rows = db.prepare(`
      SELECT
        date(m.timestamp / 1000, 'unixepoch', 'localtime')             AS day,
        COUNT(DISTINCT m.session_id)                                    AS sessions,
        COUNT(m.id)                                                     AS messages,
        COALESCE(SUM(m.total_tokens), 0)                                AS total_tokens,
        COALESCE(SUM(m.cost_total),   0)                                AS total_cost,
        COUNT(DISTINCT CASE WHEN m.has_error = 1 THEN m.session_id END) AS error_sessions,
        COUNT(DISTINCT CASE WHEN m.stop_reason = 'length'  THEN m.session_id END) AS max_tokens_sessions,
        COUNT(DISTINCT CASE WHEN m.stop_reason = 'aborted' THEN m.session_id END) AS interrupted_sessions,
        MAX(CASE
          WHEN m.has_error = 1 THEN 2
          WHEN m.stop_reason IN ('length', 'aborted') THEN 1
          ELSE 0
        END)                                                            AS worst_health
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
      WHERE s.agent_name = ?
        AND m.timestamp >= ?
        AND m.role = 'assistant'
        AND m.model NOT IN ('delivery-mirror', 'gateway-injected')
      GROUP BY day
      ORDER BY day ASC
    `).all(agentName, from) as DayRow[];

    const zero: DayRow = { day: '', sessions: 0, messages: 0, total_tokens: 0, total_cost: 0, worst_health: null, error_sessions: 0, max_tokens_sessions: 0, interrupted_sessions: 0 };
    const filled: DayRow[] = [];
    for (let d = 0; d < days; d++) {
      const date = new Date(now - (days - 1 - d) * 86400000);
      const dateStr = date.toLocaleDateString('en-CA');
      const found = rows.find(r => r.day === dateStr);
      filled.push(found ?? { ...zero, day: dateStr });
    }

    res.json(filled);
  });

  return r;
}
