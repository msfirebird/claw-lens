import * as fs from 'fs';
import path from 'path';
import os from 'os';

export function getClawHome(): string {
  return process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
}

/** Strip Slack/System noise from a user message to produce a clean task summary.
 *  Preserves channel name / DM source, e.g. "#general: hello" or "DM: hello".
 *  Removes "edited in #channel" notification lines (channel-rename noise). */
export function cleanSlackText(raw: string): string {
  let text = raw;
  // Remove "edited in #channel" notification lines (channel rename noise)
  text = text.replace(/^(?:System:\s*)?\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*Slack message edited in #[^\n]*\.?\n?/gim, '').trim();
  // Strip cron prefix
  text = text.replace(/^\[cron:[^\]]+\]\s*/, '').trim();
  // "System: [ts] Slack message in #channel from user: msg" → "#channel: msg"
  text = text.replace(/^System:\s*\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*Slack message in (#\S+)\s+from\s+[^:]+:\s*/i, '$1: ').trim();
  // "System: [ts] Slack DM from user: msg" → "DM: msg"
  text = text.replace(/^System:\s*\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*Slack DM\s+from\s+[^:]+:\s*/i, 'DM: ').trim();
  // Fallback: strip any remaining "System: [ts] Slack...: " prefix
  text = text.replace(/^System:\s*\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*Slack[^:]+:\s*/i, '').trim();
  // Same patterns without "System:" leader
  text = text.replace(/^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*Slack message in (#\S+)\s+from\s+[^:]+:\s*/i, '$1: ').trim();
  text = text.replace(/^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*Slack DM\s+from\s+[^:]+:\s*/i, 'DM: ').trim();
  text = text.replace(/^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*Slack[^:]+:\s*/i, '').trim();
  // Trim off trailing "Conversation info (untrusted metadata)..." block
  text = text.replace(/\s*Conversation info \(untrusted metadata\)[\s\S]*/i, '').trim();
  return text;
}

/** Registered agent ids from openclaw.json agents.list (source of truth).
 *  Falls back to scanning ~/.openclaw/agents/ directories if the config is missing. */
export function listRegisteredAgents(): string[] {
  const base = getClawHome();
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(base, 'openclaw.json'), 'utf-8'));
    const list = cfg?.agents?.list;
    if (Array.isArray(list) && list.length > 0) {
      return list.map((a: { id: string }) => a.id);
    }
  } catch { /* fall through */ }
  // Fallback: scan filesystem
  try {
    const agentsDir = path.join(base, 'agents');
    return fs.readdirSync(agentsDir).filter(name => {
      try { return fs.statSync(path.join(agentsDir, name)).isDirectory(); } catch { return false; }
    });
  } catch {
    return [];
  }
}
