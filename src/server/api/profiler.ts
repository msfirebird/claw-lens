import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';
import * as crypto from 'crypto';

export function profilerRouter(db: Database.Database): Router {
  const r = Router();

  // GET /api/profiler/sessions?orderBy=cost|duration&from=ts&to=ts&agent=name
  // Session list with tool_ms per session for the mini stacked bar
  r.get('/sessions', (req: Request, res: Response) => {
    const orderByParam = req.query.orderBy as string;
    const orderCol =
      orderByParam === 'duration' ? '(s.ended_at - s.started_at)' : 's.total_cost';
    const from = req.query.from ? Number(req.query.from) : 0;
    const to   = req.query.to   ? Number(req.query.to)   : 0;
    const agent = req.query.agent as string | undefined;

    const wheres: string[] = [];
    const params: (number | string)[] = [];
    if (from)  { wheres.push('s.started_at >= ?'); params.push(from); }
    if (to)    { wheres.push('s.started_at <= ?'); params.push(to); }
    if (agent) { wheres.push('s.agent_name = ?');  params.push(agent); }
    const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';

    const rows = db.prepare(`
      SELECT
        s.id, s.agent_name, s.started_at, s.ended_at,
        s.total_cost, s.total_tokens, s.error_count,
        (s.ended_at - s.started_at) AS duration_ms,
        (SELECT COUNT(*) FROM tool_calls tc
         WHERE tc.session_id = s.id) AS tool_call_count,
        (SELECT COALESCE(SUM(tc2.duration_ms), 0) FROM tool_calls tc2
         WHERE tc2.session_id = s.id AND tc2.duration_ms IS NOT NULL) AS tool_ms
      FROM sessions s
      ${where}
      ORDER BY ${orderCol} DESC
      LIMIT 50
    `).all(...params);

    res.json(rows);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // TOKEN PROFILER
  // ════════════════════════════════════════════════════════════════════════════

  // GET /api/profiler/tokens — token consumption by agent (supports from/to filtering)
  r.get('/tokens', (req: Request, res: Response) => {
    const from = req.query.from ? Number(req.query.from) : undefined;
    const to = req.query.to ? Number(req.query.to) : undefined;

    let where = "WHERE role = 'assistant' AND model NOT IN ('delivery-mirror', 'gateway-injected')";
    const params: number[] = [];
    if (from) { where += ' AND timestamp >= ?'; params.push(from); }
    if (to)   { where += ' AND timestamp < ?';  params.push(to); }

    const rows = db.prepare(`
      SELECT
        agent_name,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cache_read) AS cache_read,
        SUM(cache_write) AS cache_write,
        SUM(total_tokens) AS total_tokens,
        SUM(cost_total) AS total_cost,
        COUNT(*) AS message_count,
        COUNT(DISTINCT session_id) AS session_count
      FROM messages
      ${where}
      GROUP BY agent_name
      ORDER BY total_tokens DESC
    `).all(...params) as Array<{
      agent_name: string;
      input_tokens: number; output_tokens: number;
      cache_read: number; cache_write: number; total_tokens: number;
      total_cost: number; message_count: number; session_count: number;
    }>;

    res.json(rows);
  });

  // GET /api/profiler/tokens/:agent/sessions — top sessions by token for an agent
  r.get('/tokens/:agent/sessions', (req: Request, res: Response) => {
    const agent = req.params.agent;
    const from = req.query.from ? Number(req.query.from) : undefined;
    const to = req.query.to ? Number(req.query.to) : undefined;

    let where = "WHERE m.role = 'assistant' AND m.model NOT IN ('delivery-mirror', 'gateway-injected') AND m.agent_name = ?";
    const params: (string | number)[] = [agent];
    if (from) { where += ' AND m.timestamp >= ?'; params.push(from); }
    if (to)   { where += ' AND m.timestamp < ?';  params.push(to); }

    const rows = db.prepare(`
      SELECT
        m.session_id,
        SUM(m.input_tokens) AS input_tokens,
        SUM(m.output_tokens) AS output_tokens,
        SUM(m.cache_read) AS cache_read,
        SUM(m.total_tokens) AS total_tokens,
        SUM(m.cost_total) AS total_cost,
        COUNT(*) AS message_count,
        s.started_at
      FROM messages m
      LEFT JOIN sessions s ON s.id = m.session_id
      ${where}
      GROUP BY m.session_id
      ORDER BY total_tokens DESC
      LIMIT 15
    `).all(...params);

    res.json(rows);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // AGENT LOOP DETECTOR
  // ════════════════════════════════════════════════════════════════════════════

  // ── Argument normalisation ────────────────────────────────────────────────
  // Strip noise (timestamps, UUIDs, absolute paths, large numerics) so that two
  // calls with semantically identical inputs produce the same hash even when raw
  // JSON differs.
  function deepNormalize(value: unknown): unknown {
    if (typeof value === 'string') {
      if (value.startsWith('/') && value.includes('/'))
        return value.split('/').pop() || value;           // absolute path → basename
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
        return '__uuid__';
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value))
        return '__ts__';
      return value;
    }
    if (typeof value === 'number') return value > 1e12 ? '__big__' : value;
    if (Array.isArray(value)) return value.map(deepNormalize);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>))
        out[k] = deepNormalize(v);
      return out;
    }
    return value;
  }

  function pairKey(toolName: string, argsJson: string | null): string {
    const norm = argsJson
      ? (() => { try { return JSON.stringify(deepNormalize(JSON.parse(argsJson))); } catch { return argsJson; } })()
      : '';
    const hash = crypto.createHash('sha256').update(toolName + '\0' + norm).digest('hex').slice(0, 8);
    return `${toolName}:${hash}`;
  }

  // ── Period detector ───────────────────────────────────────────────────────
  // Operates on pairKey sequences (tool_name:hash).
  // Each period P has its own (ratioThresh, minSeqLen) — longer periods need
  // more evidence to rule out coincidence.
  function detectPeriod(seq: string[]): { period: number; ratio: number } {
    const cfg: Record<number, { ratioThresh: number; minLen: number }> = {
      1: { ratioThresh: 0.90, minLen: 3 },  // ≥3 identical consecutive calls
      2: { ratioThresh: 0.80, minLen: 6 },  // ≥3 complete A→B cycles
      3: { ratioThresh: 0.75, minLen: 6 },  // ≥2 complete A→B→C cycles
      4: { ratioThresh: 0.70, minLen: 8 },  // ≥2 complete A→B→C→D cycles
    };
    let best = { period: 0, ratio: 0 };
    for (let p = 1; p <= 4 && p < seq.length; p++) {
      if (seq.length < cfg[p].minLen) continue;
      let matches = 0;
      for (let i = p; i < seq.length; i++) {
        if (seq[i] === seq[i - p]) matches++;
      }
      const ratio = matches / (seq.length - p);
      if (ratio >= cfg[p].ratioThresh && ratio > best.ratio)
        best = { period: p, ratio };
    }
    return best;
  }

  // GET /api/profiler/loops
  r.get('/loops', (_req: Request, res: Response) => {
    const WARN_DEPTH  = 8;   // ≥8 LLM calls in one user turn → flag
    const ERROR_DEPTH = 15;  // ≥15 → severe

    const msgs = db.prepare(`
      SELECT id, session_id, agent_name, role, timestamp, stop_reason, cost_total, is_tool_result
      FROM messages
      ORDER BY session_id, timestamp ASC
    `).all() as Array<{
      id: string; session_id: string; agent_name: string;
      role: string; timestamp: number; stop_reason: string | null;
      cost_total: number; is_tool_result: number;
    }>;

    // Tool calls with arguments, keyed by message
    const tcRows = db.prepare(
      `SELECT message_id, tool_name, arguments FROM tool_calls ORDER BY timestamp ASC`
    ).all() as Array<{ message_id: string; tool_name: string; arguments: string | null }>;

    const toolsByMsg = new Map<string, Array<{ name: string; key: string }>>();
    for (const tc of tcRows) {
      if (!toolsByMsg.has(tc.message_id)) toolsByMsg.set(tc.message_id, []);
      toolsByMsg.get(tc.message_id)!.push({
        name: tc.tool_name,
        key:  pairKey(tc.tool_name, tc.arguments),
      });
    }

    const bySession = new Map<string, typeof msgs>();
    for (const m of msgs) {
      if (!bySession.has(m.session_id)) bySession.set(m.session_id, []);
      bySession.get(m.session_id)!.push(m);
    }

    type LoopType = 'consecutive' | 'alternating' | 'cyclic' | 'deep';

    interface LoopyTurn {
      session_id: string; agent_name: string; started_at: number;
      loop_depth: number; cost: number; tool_sequence: string[];
      loop_type: LoopType; period: number; period_ratio: number;
      severity: 'warning' | 'error'; turn_seq: number;
      unique_ratio: number;  // unique pairKeys / total calls — low = repetitive
    }

    const loopyTurns: LoopyTurn[] = [];

    for (const [sessionId, sessionMsgs] of bySession) {
      let userTs: number | null = null;
      let depth = 0, cost = 0;
      let pairSeq: string[] = [];   // (tool:hash) keys — used for detection
      let nameSeq: string[] = [];   // tool names — used for display
      let agentName = '', assistantSeq = 0, turnStartSeq = 0;

      for (const m of sessionMsgs) {
        if (m.role === 'user' && !m.is_tool_result) {
          userTs = m.timestamp;
          depth = 0; cost = 0; pairSeq = []; nameSeq = [];
          turnStartSeq = assistantSeq + 1;
        } else if (m.role === 'assistant') {
          agentName = m.agent_name;
          assistantSeq++;
          depth++;
          cost += m.cost_total;
          const tools = toolsByMsg.get(m.id) || [];
          if (tools.length > 0) {
            pairSeq.push(tools[0].key);
            nameSeq.push(tools[0].name);
          }

          if (m.stop_reason !== 'toolUse' && m.stop_reason !== 'tool_use' && userTs !== null) {
            if (depth >= WARN_DEPTH) {
              const { period, ratio } = detectPeriod(pairSeq);
              const loop_type: LoopType =
                period === 0 ? 'deep'
                : period === 1 ? 'consecutive'
                : period === 2 ? 'alternating'
                :                'cyclic';

              const uniqueKeys = new Set(pairSeq).size;
              const unique_ratio = pairSeq.length > 0
                ? Math.round((uniqueKeys / pairSeq.length) * 100) / 100
                : 1;

              loopyTurns.push({
                session_id: sessionId, agent_name: agentName, started_at: userTs,
                loop_depth: depth, cost, tool_sequence: nameSeq,
                loop_type, period,
                period_ratio: Math.round(ratio * 100) / 100,
                severity: depth >= ERROR_DEPTH ? 'error' : 'warning',
                turn_seq: turnStartSeq,
                unique_ratio,
              });
            }
            userTs = null; depth = 0; cost = 0; pairSeq = []; nameSeq = [];
          }
        }
      }
    }

    loopyTurns.sort((a, b) => b.loop_depth - a.loop_depth);

    const agentAgg = new Map<string, {
      agent_name: string; count: number; max_depth: number;
      total_cost: number; error_count: number;
    }>();
    for (const t of loopyTurns) {
      if (!agentAgg.has(t.agent_name))
        agentAgg.set(t.agent_name, { agent_name: t.agent_name, count: 0, max_depth: 0, total_cost: 0, error_count: 0 });
      const a = agentAgg.get(t.agent_name)!;
      a.count++;
      a.max_depth = Math.max(a.max_depth, t.loop_depth);
      a.total_cost += t.cost;
      if (t.severity === 'error') a.error_count++;
    }

    res.json({
      thresholds: { warn: WARN_DEPTH, error: ERROR_DEPTH },
      summary: {
        total:             loopyTurns.length,
        error_count:       loopyTurns.filter(t => t.severity === 'error').length,
        warn_count:        loopyTurns.filter(t => t.severity === 'warning').length,
        consecutive_count: loopyTurns.filter(t => t.loop_type === 'consecutive').length,
        alternating_count: loopyTurns.filter(t => t.loop_type === 'alternating').length,
        cyclic_count:      loopyTurns.filter(t => t.loop_type === 'cyclic').length,
        deep_count:        loopyTurns.filter(t => t.loop_type === 'deep').length,
        loop_detected_count: loopyTurns.filter(t => t.loop_type !== 'deep').length,
        max_depth:         loopyTurns.length ? loopyTurns[0].loop_depth : 0,
        total_cost:        loopyTurns.reduce((s, t) => s + t.cost, 0),
        avg_unique_ratio:  loopyTurns.length
          ? Math.round(loopyTurns.reduce((s, t) => s + t.unique_ratio, 0) / loopyTurns.length * 100) / 100
          : 1,
      },
      by_agent: [...agentAgg.values()].sort((a, b) => b.count - a.count),
      turns: loopyTurns.slice(0, 100),
    });
  });

  return r;
}
