import { Router } from 'express';
import Database from 'better-sqlite3';
import { listRegisteredAgents } from '../paths';

// ── Shared helpers ────────────────────────────────────────────────────────────

function aggregateDirectories(pathRows: { target: string }[]): { topDirs: { path: string; count: number }[]; totalDirs: number } {
  const counts: Record<string, number> = {};
  for (const { target } of pathRows) {
    const dir = target.split('/').slice(0, -1).join('/') || '/';
    counts[dir] = (counts[dir] || 0) + 1;
  }
  const topDirs = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([path, count]) => ({ path, count }));
  return { topDirs, totalDirs: Object.keys(counts).length };
}

function extractDomains(domainRows: { target: string }[]): { domain: string; count: number }[] {
  const counts: Record<string, number> = {};
  for (const { target } of domainRows) {
    try {
      const m = target.match(/https?:\/\/([^/:\s]+)/);
      if (m) counts[m[1]] = (counts[m[1]] || 0) + 1;
    } catch { /* skip */ }
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([domain, count]) => ({ domain, count }));
}

function agentTrustLabel(db: Database.Database, agent_id: string): string {
  const extCount = (db.prepare("SELECT COUNT(*) as cnt FROM audit_events WHERE agent_id = ? AND event_type IN ('web_fetch','web_search')").get(agent_id) as { cnt: number }).cnt;
  if (extCount === 0) return 'local';
  const newDomainCount = (db.prepare("SELECT COUNT(*) as cnt FROM audit_events WHERE agent_id = ? AND risk_flags LIKE '%new_domain%'").get(agent_id) as { cnt: number }).cnt;
  const exfilCount = (db.prepare("SELECT COUNT(*) as cnt FROM audit_events WHERE agent_id = ? AND risk_flags LIKE '%exfil_pattern%'").get(agent_id) as { cnt: number }).cnt;
  return (newDomainCount > 0 || exfilCount > 0) ? 'opaque' : 'transparent';
}

function agentVerdict(db: Database.Database, agent_id: string): string {
  const injections = (db.prepare("SELECT COUNT(*) as cnt FROM sensitive_findings WHERE agent_id = ? AND dismissed = 0 AND pattern_type IN ('instruction_override','new_instructions','role_hijack','exfil_request','exfil_url','base64_payload','delimiter_escape','xml_injection','dan_jailbreak')").get(agent_id) as { cnt: number }).cnt;
  if (injections > 0) return 'unsafe';
  // Verdict is driven by the max severity of underlying findings, never by raw count.
  const maxSev = (db.prepare("SELECT severity FROM sensitive_findings WHERE agent_id = ? AND dismissed = 0 ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END LIMIT 1").get(agent_id) as { severity: string } | undefined)?.severity;
  if (maxSev === 'high') return 'unsafe';
  if (maxSev === 'medium' || maxSev === 'low') return 'caution';
  return 'safe';
}

export function auditRouter(db: Database.Database): Router {
  const r = Router();

  // GET /api/audit/timeline
  r.get('/timeline', (req, res) => {
    const { agentId, startDate, endDate, eventType, riskLevel, limit = '50', offset = '0' } = req.query as Record<string, string>;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (agentId) { conditions.push('agent_id = ?'); params.push(agentId); }
    if (startDate) { conditions.push("date(timestamp/1000, 'unixepoch', 'localtime') >= ?"); params.push(startDate); }
    if (endDate) { conditions.push("date(timestamp/1000, 'unixepoch', 'localtime') <= ?"); params.push(endDate); }
    if (eventType) {
      const types = eventType.split(',').map(t => t.trim()).filter(Boolean);
      if (types.length > 0) {
        conditions.push(`event_type IN (${types.map(() => '?').join(',')})`);
        params.push(...types);
      }
    }
    if (riskLevel === 'high') { conditions.push('risk_score = 3'); }
    else if (riskLevel === 'medium') { conditions.push('risk_score = 2'); }
    else if (riskLevel === 'low') { conditions.push('risk_score = 1'); }
    else if (riskLevel === 'all') { /* no filter — show all events including risk_score=0 */ }
    else { conditions.push('risk_score > 0'); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const lim = Math.min(Math.max(1, Number(limit) || 50), 500);
    const off = Math.max(0, Number(offset) || 0);

    const total = (db.prepare(`SELECT COUNT(*) as cnt FROM audit_events ${where}`).get(...params) as { cnt: number }).cnt;
    const events = db.prepare(`
      SELECT id, session_id, agent_id, timestamp, event_type, tool_name, target, risk_flags, risk_score
      FROM audit_events ${where}
      ORDER BY timestamp DESC LIMIT ? OFFSET ?
    `).all(...params, lim, off);

    res.json({ events, total });
  });

  // GET /api/audit/event/:id — full detail + agent baseline for anomaly context
  r.get('/event/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM audit_events WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!row) return res.status(404).json({ error: 'Audit event not found' });
    // Compute turn_number: count of assistant messages in this session up to (and including) this event's timestamp
    const turnRow = db.prepare(
      `SELECT COUNT(*) AS turn_number FROM messages WHERE session_id = ? AND role = 'assistant' AND timestamp <= ?`,
    ).get(row.session_id, row.timestamp) as { turn_number: number } | undefined;
    const turn_number = turnRow?.turn_number ?? 0;
    // Find the nearest message to this event's timestamp for Sessions drill-down.
    // Exclude synthetic assistants (delivery-mirror / gateway-injected) because
    // Sessions.tsx /messages endpoint filters them out — returning one of those ids
    // here would make the ?msg= highlight/scroll silently fail to find a matching row.
    const msgRow = db.prepare(
      `SELECT id FROM messages
       WHERE session_id = ? AND timestamp <= ?
         AND (role != 'assistant' OR model NOT IN ('delivery-mirror', 'gateway-injected'))
       ORDER BY timestamp DESC LIMIT 1`,
    ).get(row.session_id, row.timestamp) as { id: string } | undefined;
    const message_id = msgRow?.id ?? null;
    // Attach baseline context so UI can explain anomaly flags
    const baselineRow = db.prepare('SELECT typical_hours, avg_tool_calls_per_session, typical_paths FROM agent_baselines WHERE agent_id = ?').get(row.agent_id) as { typical_hours: string; avg_tool_calls_per_session: number; typical_paths: string } | undefined;
    const safeParseArr = (v: string | undefined | null): unknown[] => { try { return JSON.parse(v || '[]') ?? []; } catch { return []; } };
    const baseline = baselineRow ? {
      typical_hours: safeParseArr(baselineRow.typical_hours) as number[],
      avg_tool_calls_per_session: Math.round(baselineRow.avg_tool_calls_per_session),
      typical_paths: safeParseArr(baselineRow.typical_paths) as string[],
    } : null;
    res.json({ ...row, turn_number, message_id, baseline });
  });

  // GET /api/audit/event/:id/following-calls — external calls in the same session AFTER this event
  r.get('/event/:id/following-calls', (req, res) => {
    const ev = db.prepare('SELECT session_id, timestamp FROM audit_events WHERE id = ?').get(req.params.id) as { session_id: string; timestamp: number } | undefined;
    if (!ev) return res.status(404).json({ error: 'Audit event not found' });
    const calls = db.prepare(`
      SELECT id, timestamp, event_type, tool_name, target, risk_score
      FROM audit_events
      WHERE session_id = ? AND event_type IN ('web_fetch', 'web_search') AND timestamp > ?
      ORDER BY timestamp ASC LIMIT 20
    `).all(ev.session_id, ev.timestamp);
    res.json({ calls });
  });

  // GET /api/audit/findings
  r.get('/findings', (req, res) => {
    const { agentId, severity, dismissed = 'false', eventId, limit = '50', offset = '0' } = req.query as Record<string, string>;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (eventId) { conditions.push('audit_event_id = ?'); params.push(Number(eventId)); }
    if (agentId) { conditions.push('agent_id = ?'); params.push(agentId); }
    if (severity) { conditions.push('severity = ?'); params.push(severity); }
    if (!eventId && dismissed !== 'true') { conditions.push('dismissed = 0'); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const lim = Math.min(Math.max(1, Number(limit) || 50), 500);
    const off = Math.max(0, Number(offset) || 0);

    const total = (db.prepare(`SELECT COUNT(*) as cnt FROM sensitive_findings ${where}`).get(...params) as { cnt: number }).cnt;
    const findings = db.prepare(`
      SELECT id, audit_event_id, session_id, agent_id, timestamp,
             pattern_type, pattern_matched, context, followed_by_external_call, severity, dismissed
      FROM sensitive_findings ${where}
      ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END, timestamp DESC
      LIMIT ? OFFSET ?
    `).all(...params, lim, off);

    res.json({ findings, total });
  });

  // PATCH /api/audit/findings/:id/dismiss
  r.patch('/findings/:id/dismiss', (req, res) => {
    db.prepare('UPDATE sensitive_findings SET dismissed = 1 WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // GET /api/audit/agent-stats — unified per-agent data (risk counts, footprint, recommendations)
  r.get('/agent-stats', (_req, res) => {
    const agents = db.prepare('SELECT DISTINCT agent_id FROM audit_events ORDER BY agent_id').all() as { agent_id: string }[];
    const stats = agents.map(({ agent_id }) => {
      // Risk counts
      const highCount = (db.prepare("SELECT COUNT(*) as cnt FROM audit_events WHERE agent_id = ? AND risk_score = 3").get(agent_id) as { cnt: number }).cnt;
      const mediumCount = (db.prepare("SELECT COUNT(*) as cnt FROM audit_events WHERE agent_id = ? AND risk_score = 2").get(agent_id) as { cnt: number }).cnt;
      const lowCount = (db.prepare("SELECT COUNT(*) as cnt FROM audit_events WHERE agent_id = ? AND risk_score = 1").get(agent_id) as { cnt: number }).cnt;

      // Compact footprint: tools with counts
      const tools = db.prepare("SELECT tool_name, COUNT(*) as cnt FROM audit_events WHERE agent_id = ? GROUP BY tool_name ORDER BY cnt DESC").all(agent_id) as { tool_name: string; cnt: number }[];

      // Compact footprint: top 5 directories
      const pathRows = db.prepare("SELECT target FROM audit_events WHERE agent_id = ? AND event_type LIKE 'file_%' AND target IS NOT NULL AND target != ''").all(agent_id) as { target: string }[];
      const { topDirs, totalDirs } = aggregateDirectories(pathRows);

      // Compact footprint: domains with counts
      const domainRows = db.prepare("SELECT target FROM audit_events WHERE agent_id = ? AND event_type IN ('web_fetch', 'web_search') AND target IS NOT NULL").all(agent_id) as { target: string }[];
      const domains = extractDomains(domainRows);

      // Per-agent recommendations
      const recs: { severity: string; message: string; action: string }[] = [];

      const sensPathCount = (db.prepare("SELECT COUNT(*) as cnt FROM audit_events WHERE agent_id = ? AND risk_flags LIKE '%sensitive_path%'").get(agent_id) as { cnt: number }).cnt;
      if (sensPathCount >= 3) {
        const topTarget = db.prepare("SELECT target, COUNT(*) as cnt FROM audit_events WHERE agent_id = ? AND risk_flags LIKE '%sensitive_path%' GROUP BY target ORDER BY cnt DESC LIMIT 1").get(agent_id) as { target: string; cnt: number } | undefined;
        const hint = topTarget ? ` (most frequent: ${topTarget.target.split('/').pop()})` : '';
        recs.push({ severity: 'medium', message: `Accessed sensitive paths ${sensPathCount} times${hint}`, action: 'Add a whitelist rule in Audit Rules → Sensitive Paths, or review if expected.' });
      }

      const credCount = (db.prepare("SELECT COUNT(*) as cnt FROM sensitive_findings WHERE agent_id = ? AND dismissed = 0").get(agent_id) as { cnt: number }).cnt;
      if (credCount >= 2) {
        const topPattern = db.prepare("SELECT pattern_matched, COUNT(*) as cnt FROM sensitive_findings WHERE agent_id = ? AND dismissed = 0 GROUP BY pattern_matched ORDER BY cnt DESC LIMIT 1").get(agent_id) as { pattern_matched: string; cnt: number } | undefined;
        // Recommendation severity = max severity of underlying findings (never escalate beyond what was actually found)
        const maxSev = (db.prepare("SELECT severity FROM sensitive_findings WHERE agent_id = ? AND dismissed = 0 ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END LIMIT 1").get(agent_id) as { severity: string } | undefined)?.severity || 'low';
        recs.push({ severity: maxSev, message: `Exposed credentials ${credCount} times${topPattern ? ` (most common: ${topPattern.pattern_matched})` : ''}`, action: 'Rotate the affected credentials and review file access.' });
      }

      const newDomainEvents = db.prepare("SELECT DISTINCT target FROM audit_events WHERE agent_id = ? AND risk_flags LIKE '%new_domain%'").all(agent_id) as { target: string }[];
      const unknownDomains: string[] = [];
      for (const { target } of newDomainEvents) {
        try { const m = target.match(/https?:\/\/([^/:\s]+)/); if (m && !unknownDomains.includes(m[1])) unknownDomains.push(m[1]); } catch { /* skip */ }
      }
      if (unknownDomains.length >= 2) {
        recs.push({ severity: 'medium', message: `Accessed ${unknownDomains.length} unknown domains: ${unknownDomains.slice(0, 3).join(', ')}${unknownDomains.length > 3 ? '...' : ''}`, action: 'Review these domains. They will be added to baseline automatically over time.' });
      }

      const elevCount = (db.prepare("SELECT COUNT(*) as cnt FROM audit_events WHERE agent_id = ? AND risk_flags LIKE '%elevated_cmd%'").get(agent_id) as { cnt: number }).cnt;
      if (elevCount >= 5) {
        recs.push({ severity: 'medium', message: `Ran ${elevCount} elevated commands (sudo, ssh, curl, etc.)`, action: 'Review if these commands are necessary.' });
      }

      return { agent_id, highCount, mediumCount, lowCount, tools, topDirs, totalDirs, domains, recommendations: recs };
    });
    res.json(stats);
  });

  // GET /api/audit/summary
  r.get('/summary', (_req, res) => {
    const totalEvents = (db.prepare('SELECT COUNT(*) as cnt FROM audit_events').get() as { cnt: number }).cnt;
    const highRiskEvents = (db.prepare('SELECT COUNT(*) as cnt FROM audit_events WHERE risk_score = 3').get() as { cnt: number }).cnt;
    const mediumRiskEvents = (db.prepare('SELECT COUNT(*) as cnt FROM audit_events WHERE risk_score = 2').get() as { cnt: number }).cnt;
    const lowRiskEvents = (db.prepare('SELECT COUNT(*) as cnt FROM audit_events WHERE risk_score = 1').get() as { cnt: number }).cnt;
    const sensitiveDataEvents = (db.prepare("SELECT COUNT(*) as cnt FROM audit_events WHERE risk_flags LIKE '%sensitive_data%' OR risk_flags LIKE '%private_key%'").get() as { cnt: number }).cnt;
    const dangerousCmdEvents = (db.prepare("SELECT COUNT(*) as cnt FROM audit_events WHERE risk_flags LIKE '%critical_cmd%'").get() as { cnt: number }).cnt;
    const activeFindings = (db.prepare("SELECT COUNT(*) as cnt FROM sensitive_findings WHERE dismissed = 0").get() as { cnt: number }).cnt;
    const dismissedFindings = (db.prepare('SELECT COUNT(*) as cnt FROM sensitive_findings WHERE dismissed = 1').get() as { cnt: number }).cnt;

    // Injection count
    const injectionCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM sensitive_findings WHERE pattern_type IN ('instruction_override','new_instructions','role_hijack','exfil_request','exfil_url','base64_payload','delimiter_escape','xml_injection','dan_jailbreak') AND dismissed = 0"
    ).get() as { cnt: number }).cnt;

    // Agent trust labels + verdicts (only registered agents)
    const registeredSummary = new Set(listRegisteredAgents());
    const agents = (db.prepare('SELECT DISTINCT agent_id FROM audit_events').all() as { agent_id: string }[])
      .filter(a => registeredSummary.has(a.agent_id));
    const agentTrust: Record<string, string> = {};
    const agentVerdicts: Record<string, string> = {};
    for (const { agent_id } of agents) {
      agentTrust[agent_id] = agentTrustLabel(db, agent_id);
      agentVerdicts[agent_id] = agentVerdict(db, agent_id);
    }

    res.json({ totalEvents, highRiskEvents, mediumRiskEvents, lowRiskEvents, sensitiveDataEvents, dangerousCmdEvents, activeFindings, dismissedFindings, injectionCount, agentTrust, agentVerdicts });
  });

  // GET /api/audit/agents — list distinct agents with audit data (only registered agents)
  r.get('/agents', (_req, res) => {
    const registered = new Set(listRegisteredAgents());
    const rows = db.prepare("SELECT DISTINCT agent_id FROM audit_events ORDER BY agent_id").all() as { agent_id: string }[];
    res.json(rows.map(r => r.agent_id).filter(id => registered.has(id)));
  });

  // GET /api/audit/facets — distinct event types + severities for facet chips
  r.get('/facets', (_req, res) => {
    const eventTypes = (db.prepare("SELECT DISTINCT event_type FROM audit_events WHERE event_type IS NOT NULL AND risk_score > 0 ORDER BY event_type").all() as { event_type: string }[]).map(r => r.event_type);
    const severities = (db.prepare("SELECT DISTINCT severity FROM sensitive_findings WHERE severity IS NOT NULL ORDER BY severity").all() as { severity: string }[]).map(r => r.severity);
    res.json({ eventTypes, severities });
  });

  // ──────────────────────────────────────────────
  // Feature: Credential Inventory
  // ──────────────────────────────────────────────
  r.get('/credential-inventory', (_req, res) => {
    const rows = db.prepare(`
      SELECT
        pattern_matched as credential_type,
        COUNT(*) as total_exposures,
        SUM(CASE WHEN dismissed = 0 THEN 1 ELSE 0 END) as active_exposures,
        SUM(CASE WHEN dismissed = 1 THEN 1 ELSE 0 END) as dismissed_count,
        COUNT(DISTINCT session_id) as session_count,
        COUNT(DISTINCT agent_id) as agent_count,
        MAX(timestamp) as last_seen,
        SUM(followed_by_external_call) as confirmed_exfil_count,
        GROUP_CONCAT(DISTINCT agent_id) as agents
      FROM sensitive_findings
      GROUP BY pattern_matched
      ORDER BY active_exposures DESC, total_exposures DESC
    `).all();

    res.json(rows);
  });

  return r;
}
