import { AgentBaseline } from './baseline';

export function detectAnomalies(
  toolName: string,
  target: string,
  timestamp: number,
  sessionToolCount: number,
  baseline: AgentBaseline | null
): string[] {
  if (!baseline) return [];
  const flags: string[] = [];

  const hour = new Date(timestamp).getHours();
  if (baseline.typical_hours.length > 0 && !baseline.typical_hours.includes(hour)) {
    flags.push('anomaly_hour');
  }

  if (
    baseline.avg_tool_calls_per_session > 0 &&
    sessionToolCount > baseline.avg_tool_calls_per_session * 3
  ) {
    flags.push('anomaly_volume');
  }

  if (target && (toolName === 'read' || toolName === 'write' || toolName === 'edit')) {
    const parts = target.split('/');
    const dir = parts.slice(0, -1).join('/') || '/';
    const inTypical = baseline.typical_paths.some(p => dir.startsWith(p) || p.startsWith(dir));
    if (!inTypical && baseline.typical_paths.length > 0) {
      flags.push('anomaly_path');
    }
  }

  // new_domain is handled by assessRiskFlags in risk-scorer.ts — not duplicated here

  return flags;
}
