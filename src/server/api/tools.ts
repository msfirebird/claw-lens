import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';
import { percentile } from '../model-meta';

export function toolsRouter(db: Database.Database): Router {
  const r = Router();

  // GET /api/tools — overall tool usage stats
  r.get('/', (req: Request, res: Response) => {
    const agent = req.query.agent as string | undefined;
    const session = req.query.session as string | undefined;
    const from = req.query.from ? Number(req.query.from) : undefined;
    const to = req.query.to ? Number(req.query.to) : undefined;

    let where = 'WHERE 1=1';
    const params: (number | string)[] = [];

    if (session) { where += ' AND session_id = ?'; params.push(session); }
    if (from)    { where += ' AND timestamp >= ?'; params.push(from); }
    if (to)      { where += ' AND timestamp <= ?'; params.push(to); }
    if (agent)   { where += ' AND agent_name = ?'; params.push(agent); }

    const rows = db.prepare(`
      SELECT
        tool_name,
        COUNT(*) AS call_count,
        SUM(CASE WHEN duration_ms IS NOT NULL THEN 1 ELSE 0 END) AS timed_count,
        AVG(duration_ms) AS avg_duration_ms,
        MIN(duration_ms) AS min_duration_ms,
        MAX(duration_ms) AS max_duration_ms,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS error_count
      FROM tool_calls
      ${where}
      GROUP BY tool_name
      ORDER BY call_count DESC
    `).all(...params) as Record<string, unknown>[];

    // Compute p50/p95 per tool in JS (SQLite has no PERCENTILE_CONT)
    const durRows = db.prepare(`
      SELECT tool_name, duration_ms FROM tool_calls
      ${where} AND duration_ms IS NOT NULL
      ORDER BY tool_name, duration_ms
    `).all(...params) as { tool_name: string; duration_ms: number }[];

    const durByTool: Record<string, number[]> = {};
    for (const d of durRows) {
      (durByTool[d.tool_name] ||= []).push(d.duration_ms);
    }

    const enriched = rows.map(row => ({
      ...row,
      p50_ms: percentile(durByTool[row.tool_name as string] || [], 0.5),
      p95_ms: percentile(durByTool[row.tool_name as string] || [], 0.95),
    }));

    res.json(enriched);
  });

  // GET /api/tools/heatmap — assistant messages by date × hour-of-day (last 7 days)
  r.get('/heatmap', (req: Request, res: Response) => {
    const agent = req.query.agent as string | undefined;
    const days = parseInt(req.query.days as string) || 7;
    const wheres = ["m.role = 'assistant'", "m.model NOT IN ('delivery-mirror', 'gateway-injected')", `m.timestamp >= strftime('%s', 'now', '-${days} days') * 1000`];
    const params: (number | string)[] = [];
    if (agent) { wheres.push('s.agent_name = ?'); params.push(agent); }
    const where = 'WHERE ' + wheres.join(' AND ');

    const rows = db.prepare(`
      SELECT
        strftime('%Y-%m-%d', datetime(m.timestamp/1000, 'unixepoch', 'localtime')) AS date,
        CAST(strftime('%H', datetime(m.timestamp/1000, 'unixepoch', 'localtime')) AS INTEGER) AS hod,
        COUNT(*) AS call_count
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
      ${where}
      GROUP BY date, hod
      ORDER BY date, hod
    `).all(...params);

    res.json(rows);
  });

  // GET /api/tools/:name/distribution — histogram + outliers for a single tool
  r.get('/:name/distribution', (req: Request, res: Response) => {
    const toolName = req.params.name;
    const session = req.query.session as string | undefined;

    // Build WHERE clause
    let where = 'WHERE tool_name = ? AND duration_ms IS NOT NULL';
    const params: (string | number)[] = [toolName];
    if (session) { where += ' AND session_id = ?'; params.push(session); }

    // Get all durations for this tool
    const durations = db.prepare(`
      SELECT duration_ms FROM tool_calls
      ${where}
      ORDER BY duration_ms ASC
    `).all(...params) as { duration_ms: number }[];

    // Histogram buckets
    const bucketDefs = [
      { label: '<1s',    min: 0,      max: 999 },
      { label: '1–10s',  min: 1000,   max: 9999 },
      { label: '10–60s', min: 10000,  max: 59999 },
      { label: '1–5m',   min: 60000,  max: 299999 },
      { label: '>5m',    min: 300000, max: Infinity },
    ];

    const buckets = bucketDefs.map(b => ({
      ...b,
      max: b.max === Infinity ? null : b.max,
      count: durations.filter(d => d.duration_ms >= b.min && (b.max === Infinity ? true : d.duration_ms <= b.max)).length,
    }));

    // Slow calls by tier: 10-60s, 1-5m, >5m — with session info for drill-down
    const tiers = [
      { key: 'slow_10s',  min: 10000,  max: 59999,    limit: 50 },
      { key: 'slow_1m',   min: 60000,  max: 299999,   limit: 50 },
      { key: 'slow_5m',   min: 300000, max: Infinity,  limit: 50 },
    ];

    const slowCalls: Record<string, Array<{
      id: string; session_id: string; agent_name: string;
      timestamp: number; duration_ms: number; success: number;
      started_at: number; total_messages: number; turn_number: number;
    }>> = {};

    for (const tier of tiers) {
      let tierWhere = 'WHERE tc.tool_name = ? AND tc.duration_ms >= ? AND tc.duration_ms IS NOT NULL';
      const tierParams: (string | number)[] = [toolName, tier.min];
      if (tier.max !== Infinity) { tierWhere += ' AND tc.duration_ms <= ?'; tierParams.push(tier.max); }
      if (session) { tierWhere += ' AND tc.session_id = ?'; tierParams.push(session); }

      slowCalls[tier.key] = db.prepare(`
        SELECT tc.id, tc.session_id, tc.agent_name, tc.timestamp, tc.duration_ms, tc.success,
               s.started_at, s.total_messages,
               (SELECT COUNT(*) FROM messages m
                WHERE m.session_id = tc.session_id AND m.role = 'assistant' AND m.timestamp <= tc.timestamp) AS turn_number
        FROM tool_calls tc
        LEFT JOIN sessions s ON s.id = tc.session_id
        ${tierWhere}
        ORDER BY tc.duration_ms DESC
        LIMIT ${tier.limit}
      `).all(...tierParams) as typeof slowCalls[string];
    }

    // Error calls (success = 0), regardless of duration
    let errorWhere = 'WHERE tc.tool_name = ? AND tc.success = 0';
    const errorParams: (string | number)[] = [toolName];
    if (session) { errorWhere += ' AND tc.session_id = ?'; errorParams.push(session); }

    const errorCalls = db.prepare(`
      SELECT tc.id, tc.session_id, tc.agent_name, tc.timestamp, tc.duration_ms, tc.success,
             s.started_at, s.total_messages,
             (SELECT COUNT(*) FROM messages m
              WHERE m.session_id = tc.session_id AND m.role = 'assistant' AND m.timestamp <= tc.timestamp) AS turn_number
      FROM tool_calls tc
      LEFT JOIN sessions s ON s.id = tc.session_id
      ${errorWhere}
      ORDER BY tc.timestamp DESC
      LIMIT 50
    `).all(...errorParams);

    // Keep backward compat: outliers = slow_5m
    res.json({ buckets, outliers: slowCalls.slow_5m || [], slow_calls: slowCalls, error_calls: errorCalls });
  });

  return r;
}
