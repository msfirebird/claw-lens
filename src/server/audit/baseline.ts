import Database from 'better-sqlite3';

export interface AgentBaseline {
  agent_id: string;
  computed_at: number;
  common_tools: string[];
  typical_paths: string[];
  typical_hours: number[];
  avg_tool_calls_per_session: number;
  known_domains: string[];
}

export function buildBaseline(db: Database.Database, agentId: string): AgentBaseline {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

  // Common tools
  const toolRows = db.prepare(`
    SELECT tool_name, COUNT(*) as cnt FROM audit_events
    WHERE agent_id = ? AND timestamp > ?
    GROUP BY tool_name ORDER BY cnt DESC LIMIT 20
  `).all(agentId, cutoff) as { tool_name: string; cnt: number }[];
  const common_tools = toolRows.map(r => r.tool_name);

  // Typical paths (top dirs, not exact files)
  const pathRows = db.prepare(`
    SELECT target FROM audit_events
    WHERE agent_id = ? AND timestamp > ? AND event_type LIKE 'file_%'
    AND target IS NOT NULL AND target != ''
  `).all(agentId, cutoff) as { target: string }[];

  const dirCounts: Record<string, number> = {};
  for (const { target } of pathRows) {
    const parts = target.split('/');
    const dir = parts.slice(0, -1).join('/') || '/';
    dirCounts[dir] = (dirCounts[dir] || 0) + 1;
  }
  const typical_paths = Object.entries(dirCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([p]) => p);

  // Typical hours
  const hourRows = db.prepare(`
    SELECT CAST(strftime('%H', timestamp/1000, 'unixepoch') AS INTEGER) as hr, COUNT(*) as cnt
    FROM audit_events WHERE agent_id = ? AND timestamp > ?
    GROUP BY hr ORDER BY cnt DESC
  `).all(agentId, cutoff) as { hr: number; cnt: number }[];
  const typical_hours = hourRows.slice(0, 12).map(r => r.hr);

  // Avg tool calls per session
  const sessionStats = db.prepare(`
    SELECT session_id, COUNT(*) as cnt FROM audit_events
    WHERE agent_id = ? AND timestamp > ?
    GROUP BY session_id
  `).all(agentId, cutoff) as { session_id: string; cnt: number }[];
  const avg_tool_calls_per_session = sessionStats.length > 0
    ? sessionStats.reduce((s, r) => s + r.cnt, 0) / sessionStats.length
    : 0;

  // Known domains
  const domainRows = db.prepare(`
    SELECT DISTINCT target FROM audit_events
    WHERE agent_id = ? AND timestamp > ? AND event_type IN ('web_fetch', 'web_search')
    AND target IS NOT NULL AND target != ''
  `).all(agentId, cutoff) as { target: string }[];
  const known_domains: string[] = [];
  for (const { target } of domainRows) {
    try {
      const d = new URL(target).hostname;
      if (d && !known_domains.includes(d)) known_domains.push(d);
    } catch { /* skip */ }
  }

  const baseline: AgentBaseline = {
    agent_id: agentId,
    computed_at: Date.now(),
    common_tools,
    typical_paths,
    typical_hours,
    avg_tool_calls_per_session,
    known_domains,
  };

  db.prepare(`
    INSERT INTO agent_baselines (agent_id, computed_at, common_tools, typical_paths, typical_hours, avg_tool_calls_per_session, known_domains)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      computed_at = excluded.computed_at,
      common_tools = excluded.common_tools,
      typical_paths = excluded.typical_paths,
      typical_hours = excluded.typical_hours,
      avg_tool_calls_per_session = excluded.avg_tool_calls_per_session,
      known_domains = excluded.known_domains
  `).run(
    agentId,
    baseline.computed_at,
    JSON.stringify(common_tools),
    JSON.stringify(typical_paths),
    JSON.stringify(typical_hours),
    avg_tool_calls_per_session,
    JSON.stringify(known_domains),
  );

  return baseline;
}

export function getBaseline(db: Database.Database, agentId: string): AgentBaseline | null {
  const row = db.prepare('SELECT * FROM agent_baselines WHERE agent_id = ?').get(agentId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const safeParseArr = <T = string>(v: unknown): T[] => { try { const p = JSON.parse(v as string || '[]'); return Array.isArray(p) ? p : []; } catch { return []; } };
  return {
    agent_id: row.agent_id as string,
    computed_at: row.computed_at as number,
    common_tools: safeParseArr(row.common_tools),
    typical_paths: safeParseArr(row.typical_paths),
    typical_hours: safeParseArr<number>(row.typical_hours),
    avg_tool_calls_per_session: row.avg_tool_calls_per_session as number,
    known_domains: safeParseArr(row.known_domains),
  };
}

export function rebuildAllBaselines(db: Database.Database): void {
  const agents = db.prepare('SELECT DISTINCT agent_id FROM audit_events').all() as { agent_id: string }[];
  for (const { agent_id } of agents) {
    buildBaseline(db, agent_id);
  }
}
