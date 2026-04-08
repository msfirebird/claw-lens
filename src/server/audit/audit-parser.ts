import * as fs from 'fs';
import Database from 'better-sqlite3';
import { isSensitivePath } from './sensitive-paths';
import { scanForSensitiveData } from './sensitive-data';
import { scanForInjection } from './injection-scanner';
import {
  resolveEventType, resolveTarget, resolveExtra,
  assessRiskFlags, computeRiskLevel,
} from './risk-scorer';
import { getBaseline } from './baseline';
import { detectAnomalies } from './anomaly';

const AUDIT_TOOLS = new Set([
  'read', 'write', 'edit', 'web_fetch', 'web_search',
  'exec', 'bash', 'image', 'computer',
]);

interface AuditEvent {
  session_id: string;
  agent_id: string;
  timestamp: number;
  event_type: string;
  tool_name: string;
  target: string;
  extra_json: string;
  risk_flags: string;
  risk_score: number;
  raw_input: string;
  raw_output: string;
}

interface SensitiveFindingRow {
  audit_event_id: number;
  session_id: string;
  agent_id: string;
  timestamp: number;
  pattern_type: string;
  pattern_matched: string;
  context: string;
  followed_by_external_call: number;
  severity: string;
}

export function ingestAuditEvents(
  db: Database.Database,
  filePath: string,
  sessionId: string,
  agentId: string
): { eventsInserted: number; findingsInserted: number } {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(Boolean);

  const baseline = getBaseline(db, agentId);
  const knownDomains = baseline?.known_domains || [];

  // Build toolCall map: id → { name, args, ts, user_context }
  const toolCallMap: Record<string, { name: string; args: Record<string, unknown>; ts: number; user_context: string }> = {};

  let currentUserContext = '';

  for (const line of lines) {
    let record: Record<string, unknown>;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.type !== 'message') continue;

    const msg = record.message as Record<string, unknown> | undefined;
    if (!msg) continue;

    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const texts = (msg.content as Record<string, unknown>[])
        .filter(c => c.type === 'text')
        .map(c => String(c.text || '').trim())
        .filter(Boolean)
        .join('\n');
      if (texts) {
        currentUserContext = texts.slice(0, 600);
      }
    } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const ts = (msg.timestamp as number) || new Date(record.timestamp as string).getTime();
      for (const item of msg.content as Record<string, unknown>[]) {
        if ((item.type === 'toolCall' || item.type === 'tool_use') && item.id && item.name) {
          toolCallMap[item.id as string] = {
            name: item.name as string,
            args: (item.arguments as Record<string, unknown>) || {},
            ts,
            user_context: currentUserContext,
          };
        }
      }
    }
  }

  // Pass 2: match tool results, collect raw events with flags (no risk score yet)
  interface RawEvent {
    session_id: string;
    agent_id: string;
    timestamp: number;
    event_type: string;
    tool_name: string;
    target: string;
    extra_json: string;
    flags: string[];
    raw_input: string;
    raw_output: string;
    user_context: string;
  }

  const rawEvents: RawEvent[] = [];
  // Track external calls with their timestamps and content for precise exfil detection
  const externalCalls: { timestamp: number; target: string; rawInput: string }[] = [];

  // Pre-compute total auditable tool calls for anomaly_volume detection
  const totalAuditToolCalls = Object.values(toolCallMap).filter(c => AUDIT_TOOLS.has(c.name)).length;

  for (const line of lines) {
    let record: Record<string, unknown>;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.type !== 'message') continue;

    const msg = record.message as Record<string, unknown> | undefined;
    if (!msg || msg.role !== 'toolResult') continue;

    const toolCallId = msg.toolCallId as string | undefined;
    if (!toolCallId) continue;
    const call = toolCallMap[toolCallId];
    if (!call) continue;
    if (!AUDIT_TOOLS.has(call.name)) continue;

    const contentArr = Array.isArray(msg.content) ? msg.content as Record<string, unknown>[] : [];
    const outputText = contentArr.map(c => String(c.text || c.content || '')).join('\n');
    const output = outputText.slice(0, 2048);

    const target = resolveTarget(call.name, call.args);
    const eventType = resolveEventType(call.name, call.args);

    const pathRule = (call.name === 'read' || call.name === 'write' || call.name === 'edit' || call.name === 'image')
      ? isSensitivePath(target)
      : null;

    const flags: string[] = assessRiskFlags(call.name, call.args, output, knownDomains);
    if (pathRule) {
      flags.push(pathRule.severity === 'medium' ? 'sensitive_path_medium' : 'sensitive_path');
    }

    const dataFindings = scanForSensitiveData(output);
    if (dataFindings.length > 0) flags.push('sensitive_data');

    // Scan user context for prompt injection patterns
    const injectionFindings = scanForInjection(call.user_context);
    if (injectionFindings.length > 0) flags.push('prompt_injection');

    const anomalyFlags = detectAnomalies(call.name, target, call.ts, totalAuditToolCalls, baseline);
    flags.push(...anomalyFlags);

    if (eventType === 'web_fetch' || eventType === 'web_search') {
      externalCalls.push({
        timestamp: call.ts,
        target,
        rawInput: JSON.stringify(call.args).slice(0, 4096),
      });
    }

    rawEvents.push({
      session_id: sessionId,
      agent_id: agentId,
      timestamp: call.ts,
      event_type: eventType,
      tool_name: call.name,
      target,
      extra_json: JSON.stringify(resolveExtra(call.name, call.args, output)),
      flags,
      raw_input: JSON.stringify(call.args).slice(0, 2048),
      raw_output: output,
      user_context: call.user_context,
    });
  }

  // Pass 3: compute final risk scores using full session context (who made external calls)
  const events: AuditEvent[] = rawEvents.map(ev => ({
    session_id: ev.session_id,
    agent_id: ev.agent_id,
    timestamp: ev.timestamp,
    event_type: ev.event_type,
    tool_name: ev.tool_name,
    target: ev.target,
    extra_json: ev.extra_json,
    risk_flags: JSON.stringify(ev.flags),
    risk_score: computeRiskLevel(ev.flags),
    raw_input: ev.raw_input,
    raw_output: ev.raw_output,
  }));

  if (events.length === 0) return { eventsInserted: 0, findingsInserted: 0 };

  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO audit_events
      (session_id, agent_id, timestamp, event_type, tool_name, target, extra_json, risk_flags, risk_score, raw_input, raw_output)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertFinding = db.prepare(`
    INSERT INTO sensitive_findings
      (audit_event_id, session_id, agent_id, timestamp, pattern_type, pattern_matched, context, followed_by_external_call, severity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let eventsInserted = 0;
  let findingsInserted = 0;

  const run = db.transaction(() => {
    // Delete old events for this session before re-inserting (re-parse on file change)
    db.prepare('DELETE FROM sensitive_findings WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM audit_events WHERE session_id = ?').run(sessionId);

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const rawEv = rawEvents[i];
      const r = insertEvent.run(
        ev.session_id, ev.agent_id, ev.timestamp, ev.event_type,
        ev.tool_name, ev.target, ev.extra_json, ev.risk_flags, ev.risk_score,
        ev.raw_input, ev.raw_output
      );
      const eventId = r.lastInsertRowid as number;
      eventsInserted++;

      // Insert sensitive findings
      let flags: string[] = [];
      try { flags = JSON.parse(ev.risk_flags); } catch { /* skip malformed flags */ }
      let hasHighFinding = false;
      if (flags.includes('sensitive_data')) {
        const findings = scanForSensitiveData(ev.raw_output);
        for (const f of findings) {
          // Precise exfil detection:
          // 1. External call must happen AFTER this event (timestamp >)
          // 2. External call's target or input must contain part of the matched secret
          //    Use a 12+ char substring from the middle of the value to reduce false positives
          const rawVal = f.rawValue;
          const searchStr = rawVal.length > 16
            ? rawVal.slice(4, Math.min(rawVal.length - 4, 20))
            : rawVal;
          const confirmedExfil = externalCalls.some(c =>
            c.timestamp > ev.timestamp &&
            (c.target.includes(searchStr) || c.rawInput.includes(searchStr))
          ) ? 1 : 0;

          // Map to finding severity:
          // High     = confirmed exfil (credential sent in subsequent external call)
          // Medium   = medium/high severity pattern (API keys, tokens, PII, etc.)
          // Low      = low-severity pattern
          const newSeverity = confirmedExfil === 1
            ? 'high'
            : (f.severity === 'low' ? 'low' : 'medium');
          if (newSeverity === 'high') hasHighFinding = true;
          insertFinding.run(
            eventId, ev.session_id, ev.agent_id, ev.timestamp,
            f.pattern_type, f.pattern_matched, f.context,
            confirmedExfil, newSeverity
          );
          findingsInserted++;
        }
      }

      // Elevate event risk_score to HIGH (3) if any finding is high severity
      if (hasHighFinding && ev.risk_score < 3) {
        db.prepare('UPDATE audit_events SET risk_score = 3 WHERE id = ?').run(eventId);
      }

      // Insert prompt injection findings
      if (flags.includes('prompt_injection')) {
        const injFindings = scanForInjection(rawEv.user_context);
        for (const f of injFindings) {
          insertFinding.run(
            eventId, ev.session_id, ev.agent_id, ev.timestamp,
            f.pattern_type, f.pattern_matched, f.context,
            0, 'high'
          );
          findingsInserted++;
        }
      }
    }
  });

  run();
  return { eventsInserted, findingsInserted };
}
