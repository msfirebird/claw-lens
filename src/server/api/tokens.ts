import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';
import { listRegisteredAgents } from '../paths';
export function tokensRouter(db: Database.Database): Router {
  const r = Router();

  // GET /api/tokens/summary?days=30  OR  ?from=2026-03-20&to=2026-03-21
  r.get('/summary', (req: Request, res: Response) => {
    const fromParam = req.query.from as string | undefined;
    const toParam = req.query.to as string | undefined;
    let cutoff: number;
    let cutoffEnd: number | null = null;

    if (fromParam && toParam) {
      cutoff = new Date(fromParam).getTime();
      cutoffEnd = new Date(toParam).getTime();
    } else {
      const days = Math.min(Math.max(parseInt(req.query.days as string) || 30, 1), 365);
      const rolling = req.query.rolling === '1';
      if (days === 1 && !rolling) {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        cutoff = d.getTime();
      } else {
        cutoff = Date.now() - days * 86400000;
      }
    }

    // Base filters: assistant only, exclude non-billable models and bad cost data
    const baseWhere = `
      m.role = 'assistant'
      AND m.model NOT IN ('delivery-mirror', 'gateway-injected')
      AND m.cost_total >= 0
      AND m.timestamp >= ?
      ${cutoffEnd ? 'AND m.timestamp < ?' : ''}
    `;
    const baseParams = cutoffEnd ? [cutoff, cutoffEnd] : [cutoff];

    // ── Totals ──
    const totals = db.prepare(`
      SELECT
        COALESCE(SUM(m.input_tokens), 0)  AS input,
        COALESCE(SUM(m.output_tokens), 0) AS output,
        COALESCE(SUM(m.cache_read), 0)    AS cacheRead,
        COALESCE(SUM(m.cache_write), 0)   AS cacheWrite,
        COALESCE(SUM(m.total_tokens), 0)  AS total,
        COALESCE(SUM(m.cost_total), 0)    AS cost
      FROM messages m
      WHERE ${baseWhere}
    `).get(...baseParams) as {
      input: number; output: number; cacheRead: number;
      cacheWrite: number; total: number; cost: number;
    };

    const cacheRead = totals.cacheRead;
    const cacheWrite = totals.cacheWrite;
    const inputTokens = totals.input;
    // cache_write is NOT a cache hit — exclude from denominator
    const cacheHitRate = (cacheRead + inputTokens) > 0
      ? cacheRead / (cacheRead + inputTokens)
      : 0;

    // Session count: count sessions whose last assistant message is within the window
    const sessionCountSql = cutoffEnd
      ? `SELECT COUNT(*) AS sessionCount FROM (
          SELECT m.session_id, MAX(m.timestamp) AS last_msg
          FROM messages m
          WHERE m.role = 'assistant' AND m.model NOT IN ('delivery-mirror', 'gateway-injected')
          GROUP BY m.session_id
          HAVING last_msg >= ? AND last_msg < ?
        )`
      : `SELECT COUNT(*) AS sessionCount FROM (
          SELECT m.session_id, MAX(m.timestamp) AS last_msg
          FROM messages m
          WHERE m.role = 'assistant' AND m.model NOT IN ('delivery-mirror', 'gateway-injected')
          GROUP BY m.session_id
          HAVING last_msg >= ?
        )`;
    const sessionStats = db.prepare(sessionCountSql).get(...baseParams) as { sessionCount: number };
    const sessionCount = sessionStats.sessionCount;
    const avgCostPerSession = sessionCount > 0 ? totals.cost / sessionCount : 0;

    // ── By Day ──
    const byDay = db.prepare(`
      SELECT
        DATE(m.timestamp / 1000, 'unixepoch', 'localtime') AS date,
        COALESCE(SUM(m.input_tokens), 0)  AS input,
        COALESCE(SUM(m.output_tokens), 0) AS output,
        COALESCE(SUM(m.cache_read), 0)    AS cacheRead,
        COALESCE(SUM(m.cache_write), 0)   AS cacheWrite,
        COALESCE(SUM(m.cost_total), 0)    AS cost
      FROM messages m
      WHERE ${baseWhere}
      GROUP BY date
      ORDER BY date ASC
    `).all(...baseParams) as {
      date: string; input: number; output: number;
      cacheRead: number; cacheWrite: number; cost: number;
    }[];

    // ── By Model ──
    const byModel = db.prepare(`
      SELECT
        m.model,
        COALESCE(m.provider, '') AS provider,
        COALESCE(SUM(m.input_tokens), 0)  AS input,
        COALESCE(SUM(m.output_tokens), 0) AS output,
        COALESCE(SUM(m.cache_read), 0)    AS cacheRead,
        COALESCE(SUM(m.cache_write), 0)   AS cacheWrite,
        COALESCE(SUM(m.total_tokens), 0)  AS total,
        COALESCE(SUM(m.cost_total), 0)    AS cost,
        COUNT(*)                           AS messages
      FROM messages m
      WHERE ${baseWhere}
      GROUP BY m.model, m.provider
      ORDER BY total DESC
    `).all(...baseParams) as {
      model: string; provider: string; input: number; output: number;
      cacheRead: number; cacheWrite: number; total: number;
      cost: number; messages: number;
    }[];

    // ── By Agent ──
    // Only include registered agents (from openclaw.json agents.list)
    const registered = new Set(listRegisteredAgents());
    const allAgents = (db.prepare('SELECT DISTINCT agent_name FROM sessions').all() as { agent_name: string }[])
      .filter(a => registered.has(a.agent_name));
    const agentStats = db.prepare(`
      SELECT
        s.agent_name                       AS agent,
        COALESCE(SUM(m.input_tokens), 0)  AS input,
        COALESCE(SUM(m.output_tokens), 0) AS output,
        COALESCE(SUM(m.cache_read), 0)    AS cacheRead,
        COALESCE(SUM(m.cache_write), 0)   AS cacheWrite,
        COALESCE(SUM(m.total_tokens), 0)  AS total,
        COALESCE(SUM(m.cost_total), 0)    AS cost,
        COUNT(DISTINCT s.id)               AS sessions
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE ${baseWhere}
      GROUP BY s.agent_name
      ORDER BY total DESC
    `).all(...baseParams) as {
      agent: string; input: number; output: number;
      cacheRead: number; cacheWrite: number; total: number;
      cost: number; sessions: number;
    }[];
    const agentMap = new Map(agentStats.map(a => [a.agent, a]));
    const byAgent = allAgents.map(({ agent_name }) => agentMap.get(agent_name) ?? {
      agent: agent_name, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, sessions: 0,
    }).sort((a, b) => b.total - a.total);

    // ── Cron vs Manual ──
    // Use is_cron field (set during ingest by detecting [cron:...] in first user message)
    const cronSessions = db.prepare(`
      SELECT
        COALESCE(SUM(m.total_tokens), 0) AS tokens,
        COALESCE(SUM(m.cost_total), 0)   AS cost,
        COUNT(DISTINCT s.id)              AS sessions
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE ${baseWhere}
        AND s.is_cron = 1
    `).get(...baseParams) as { tokens: number; cost: number; sessions: number };

    const manualTokens = totals.total - cronSessions.tokens;
    const manualCost = totals.cost - cronSessions.cost;

    // Count total distinct manual sessions
    const totalSessions = (db.prepare(`
      SELECT COUNT(DISTINCT s.id) AS cnt
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE ${baseWhere}
    `).get(...baseParams) as { cnt: number }).cnt;

    const cronVsManual = {
      cron: {
        tokens: cronSessions.tokens,
        cost: parseFloat(cronSessions.cost.toFixed(4)),
        sessions: cronSessions.sessions,
      },
      manual: {
        tokens: manualTokens,
        cost: parseFloat(manualCost.toFixed(4)),
        sessions: totalSessions - cronSessions.sessions,
      },
    };

    res.json({
      totals: {
        ...totals,
        cost: parseFloat(totals.cost.toFixed(4)),
        cacheHitRate: parseFloat(cacheHitRate.toFixed(4)),
        sessionCount,
        avgCostPerSession: parseFloat(avgCostPerSession.toFixed(4)),
      },
      byDay,
      byModel: byModel.map(m => ({ ...m, cost: parseFloat(m.cost.toFixed(4)) })),
      byAgent: byAgent.map(a => ({ ...a, cost: parseFloat(a.cost.toFixed(4)) })),
      cronVsManual,
    });
  });

  // GET /api/tokens/trend?days=7&agent=main&granularity=day|hour
  r.get('/trend', (req: Request, res: Response) => {
    const agent = req.query.agent as string | undefined;
    const gran = req.query.granularity as string;
    const granularity = gran === 'hour' ? 'hour' : 'day';
    const fromParam = req.query.from as string | undefined;
    const toParam = req.query.to as string | undefined;

    let cutoff: number;
    let ceiling: number = Date.now() + 86400000; // far future default

    if (fromParam && toParam) {
      // Use explicit from/to date range
      cutoff = new Date(fromParam + 'T00:00:00').getTime();
      ceiling = new Date(toParam + 'T00:00:00').getTime();
    } else {
      const days = Math.min(Math.max(parseInt(req.query.days as string) || 7, 1), 365);
      if (granularity === 'hour') {
        cutoff = Date.now() - 24 * 3600000;
      } else {
        cutoff = Date.now() - days * 86400000;
      }
    }

    const agentFilter = agent && agent !== 'all'
      ? "AND s.agent_name = ?"
      : "";
    const params: (number | string)[] = [cutoff, ceiling];
    if (agent && agent !== 'all') params.push(agent);

    const groupExpr = granularity === 'hour'
      ? "strftime('%Y-%m-%d %H:00', m.timestamp / 1000, 'unixepoch', 'localtime')"
      : "DATE(m.timestamp / 1000, 'unixepoch', 'localtime')";

    const rows = db.prepare(`
      SELECT
        ${groupExpr} AS bucket,
        COALESCE(SUM(m.input_tokens), 0)  AS input,
        COALESCE(SUM(m.output_tokens), 0) AS output,
        COALESCE(SUM(m.cache_read), 0)    AS cacheRead,
        COALESCE(SUM(m.cache_write), 0)   AS cacheWrite,
        COALESCE(SUM(m.cost_total), 0)    AS cost
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE m.role = 'assistant'
        AND m.model NOT IN ('delivery-mirror', 'gateway-injected')
        AND m.timestamp >= ?
        AND m.timestamp < ?
        ${agentFilter}
      GROUP BY bucket
      ORDER BY bucket ASC
    `).all(...params);

    // Available agents for filter dropdown (only registered agents)
    const registeredTrend = new Set(listRegisteredAgents());
    const agents = (db.prepare(`
      SELECT DISTINCT s.agent_name
      FROM messages m JOIN sessions s ON m.session_id = s.id
      WHERE m.role = 'assistant' AND m.timestamp >= ?
    `).all(cutoff) as { agent_name: string }[])
      .filter(a => registeredTrend.has(a.agent_name));

    res.json({
      data: rows,
      agents: agents.map(a => a.agent_name),
      granularity,
      days: Math.round((ceiling - cutoff) / 86400000),
    });
  });

  return r;
}
