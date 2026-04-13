import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';
export function timelineRouter(db: Database.Database): Router {
  const r = Router();

  // GET /api/timeline
  // Query: bucket=hour|day, from=ms, to=ms, agent=, days=7|30|90|all
  r.get('/', (req: Request, res: Response) => {
    const bucket = (req.query.bucket as string) || 'day';
    const agent = req.query.agent as string | undefined;

    // days shorthand takes priority over from/to
    const days = req.query.days ? Number(req.query.days) : undefined;
    const now = Date.now();
    const from = days
      ? now - days * 86400000
      : req.query.from ? Number(req.query.from) : undefined;
    const to = req.query.to ? Number(req.query.to) : undefined;

    let where = `WHERE role = 'assistant' AND model NOT IN ('delivery-mirror', 'gateway-injected')`;
    const params: (number | string)[] = [];

    if (from)  { where += ' AND timestamp >= ?'; params.push(from); }
    if (to)    { where += ' AND timestamp <= ?'; params.push(to); }
    if (agent) { where += ' AND agent_name = ?'; params.push(agent); }

    // Use localtime-aligned bucketing so day boundaries match user's timezone
    const bucketExpr = bucket === 'day'
      ? `strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch', 'localtime')`
      : `strftime('%Y-%m-%d %H:00', timestamp / 1000, 'unixepoch', 'localtime')`;

    const rows = db.prepare(`
      SELECT
        ${bucketExpr} AS bucket_key,
        MIN(timestamp) AS bucket_ts,
        COUNT(*) AS message_count,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cache_read) AS cache_read,
        SUM(cache_write) AS cache_write,
        SUM(total_tokens) AS total_tokens,
        SUM(cost_total) AS cost_total,
        SUM(CASE WHEN has_error = 1 THEN 1 ELSE 0 END) AS error_count
      FROM messages
      ${where}
      GROUP BY bucket_key
      ORDER BY bucket_key ASC
    `).all(...params) as Record<string, unknown>[];

    res.json(rows);
  });

  // GET /api/timeline/kpi — today / this-week / this-month / all-time costs
  r.get('/kpi', (req: Request, res: Response) => {
    const agent = req.query.agent as string | undefined;
    const now = Date.now();
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const weekStart = new Date(todayStart); weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const monthStart = new Date(todayStart); monthStart.setDate(1);

    function sumCost(fromMs: number): number {
      let where = `WHERE role = 'assistant' AND model NOT IN ('delivery-mirror', 'gateway-injected') AND timestamp >= ?`;
      const params: (number | string)[] = [fromMs];
      if (agent) { where += ' AND agent_name = ?'; params.push(agent); }
      const row = db.prepare(`SELECT SUM(cost_total) AS cost FROM messages ${where}`)
        .get(...params) as { cost: number | null };
      return row?.cost ?? 0;
    }

    // Cache hit rate: cache_read / (cache_read + input_tokens)
    let cacheWhere = `WHERE role = 'assistant' AND model NOT IN ('delivery-mirror', 'gateway-injected')`;
    const cacheParams: (number | string)[] = [];
    if (agent) { cacheWhere += ' AND agent_name = ?'; cacheParams.push(agent); }

    const cacheRow = db.prepare(`
      SELECT
        SUM(cache_read) AS total_cache_read,
        SUM(input_tokens) AS total_input,
        SUM(cache_write) AS total_cache_write
      FROM messages ${cacheWhere}
    `).get(...cacheParams) as { total_cache_read: number; total_input: number; total_cache_write: number };

    // cache_write is NOT a cache hit — exclude from denominator
    const totalInput = (cacheRow?.total_input ?? 0) + (cacheRow?.total_cache_read ?? 0);
    const hitRate = totalInput > 0 ? (cacheRow?.total_cache_read ?? 0) / totalInput : 0;

    // Daily cost for last 30 days (for avg)
    const recentRows = db.prepare(`
      SELECT SUM(cost_total) AS day_cost
      FROM messages
      WHERE role = 'assistant' AND model NOT IN ('delivery-mirror', 'gateway-injected')
        AND timestamp >= ?
        ${agent ? 'AND agent_name = ?' : ''}
      GROUP BY DATE(timestamp / 1000, 'unixepoch', 'localtime')
    `).all(...(agent ? [now - 30 * 86400000, agent] : [now - 30 * 86400000])) as { day_cost: number }[];

    // Divide by calendar days (30), not just days with activity
    const totalCost30d = recentRows.reduce((s, r) => s + r.day_cost, 0);
    const avgDailyCost = totalCost30d / 30;

    // Token usage by time period
    function sumTokens(fromMs: number) {
      let where = `WHERE role = 'assistant' AND model NOT IN ('delivery-mirror', 'gateway-injected') AND timestamp >= ?`;
      const params: (number | string)[] = [fromMs];
      if (agent) { where += ' AND agent_name = ?'; params.push(agent); }
      const row = db.prepare(`
        SELECT
          SUM(input_tokens) AS input,
          SUM(output_tokens) AS output,
          SUM(cache_read) AS cache_read,
          SUM(cache_write) AS cache_write,
          SUM(total_tokens) AS total,
          COUNT(*) AS messages
        FROM messages ${where}
      `).get(...params) as Record<string, number | null>;
      return {
        input: row?.input ?? 0,
        output: row?.output ?? 0,
        cache_read: row?.cache_read ?? 0,
        cache_write: row?.cache_write ?? 0,
        total: row?.total ?? 0,
        messages: row?.messages ?? 0,
      };
    }

    const tokensToday = sumTokens(todayStart.getTime());
    const tokensWeek = sumTokens(weekStart.getTime());
    const tokensMonth = sumTokens(monthStart.getTime());
    const tokensAll = sumTokens(0);

    // Last week cost (for week-over-week comparison)
    const prevWeekStart = new Date(weekStart);
    prevWeekStart.setDate(prevWeekStart.getDate() - 7);
    const lastWeekCost = sumCost(prevWeekStart.getTime()) - sumCost(weekStart.getTime());
    const thisWeekCost = sumCost(weekStart.getTime());

    // Avg cost per session (30d)
    const sessionCountRow = db.prepare(`
      SELECT COUNT(*) AS cnt FROM sessions
      WHERE started_at >= ?
      ${agent ? 'AND agent_name = ?' : ''}
    `).get(...(agent ? [now - 30 * 86400000, agent] : [now - 30 * 86400000])) as { cnt: number };
    const cost30d = sumCost(now - 30 * 86400000);
    const avgCostPerSession = sessionCountRow.cnt > 0 ? cost30d / sessionCountRow.cnt : 0;

    // 7-day sparkline data (daily costs for last 7 days)
    const sparklineRows = db.prepare(`
      SELECT DATE(timestamp / 1000, 'unixepoch', 'localtime') AS day_bucket, SUM(cost_total) AS cost
      FROM messages
      WHERE role = 'assistant' AND model NOT IN ('delivery-mirror', 'gateway-injected')
        AND timestamp >= ?
        ${agent ? 'AND agent_name = ?' : ''}
      GROUP BY day_bucket ORDER BY day_bucket ASC
    `).all(...(agent ? [now - 7 * 86400000, agent] : [now - 7 * 86400000])) as { cost: number }[];

    res.json({
      today: sumCost(todayStart.getTime()),
      this_week: thisWeekCost,
      this_month: sumCost(monthStart.getTime()),
      all_time: sumCost(0),
      avg_daily_30d: avgDailyCost,
      cache_hit_rate: hitRate,
      cache_read_total: cacheRow?.total_cache_read ?? 0,
      cache_write_total: cacheRow?.total_cache_write ?? 0,
      input_total: cacheRow?.total_input ?? 0,
      last_week_cost: lastWeekCost,
      week_change_pct: lastWeekCost > 0 ? ((thisWeekCost - lastWeekCost) / lastWeekCost) * 100 : 0,
      avg_cost_per_session: avgCostPerSession,
      sparkline_7d: sparklineRows.map(r => r.cost),
      tokens: {
        today: tokensToday,
        this_week: tokensWeek,
        this_month: tokensMonth,
        all_time: tokensAll,
      },
    });
  });

  return r;
}
