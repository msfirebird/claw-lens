import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useFetch, fmtDatetime } from '../hooks';
import { type EventDetail, type Finding, type FollowingCall, PATTERN_LABELS, severityColor } from '../constants/auditTypes';

interface AuditEvent {
  id: number;
  session_id: string;
  agent_id: string;
  timestamp: number;
  event_type: string;
  tool_name: string;
  target: string;
  risk_flags: string;
  risk_score: number;
}


const EVENT_ICONS: Record<string, string> = {
  file_read: '📄',
  file_write: '✏️',
  file_edit: '✏️',
  file_delete: '🗑',
  web_fetch: '🌐',
  web_search: '🔍',
  exec: '⚡',
};


const FLAG_RISK_LEVEL: Record<string, number> = {
  exfil_pattern: 3, critical_cmd: 3, prompt_injection: 3,
  sensitive_data: 2, elevated_cmd: 2, new_domain: 2, sensitive_path_medium: 2,
  sensitive_path: 1, anomaly_hour: 1, anomaly_volume: 1, anomaly_path: 1, anomaly: 1,
};

function flagColor(flag: string): string {
  const level = FLAG_RISK_LEVEL[flag] || 0;
  if (level === 3) return 'var(--C-rose)';
  if (level === 2) return 'var(--C-amber)';
  return 'var(--C-green)';
}

/** Given a flag and event detail, return what specifically triggered it */
function flagMatchDetail(flag: string, target: string, _eventType: string, t: (key: string, opts?: Record<string, unknown>) => string, timestamp?: number, baseline?: EventDetail['baseline']): string | null {
  const cmd = target.toLowerCase();
  if (flag === 'elevated_cmd') {
    const patterns: [RegExp, string][] = [
      [/\bsudo\s+/, 'sudo'],
      [/\bssh\s+/, 'ssh'],
      [/\bscp\s+/, 'scp'],
      [/\brsync\s+/, 'rsync'],
      [/\bcurl\s+/, 'curl'],
      [/\bwget\s+/, 'wget'],
      [/\bnc\s+/, 'nc (netcat)'],
      [/\bnetcat\s+/, 'netcat'],
      [/\bftp\s+/, 'ftp'],
      [/\bcat\s+.*(?:\.env|credentials|passwd|shadow)/, 'cat reads sensitive file'],
      [/\bchown\s+root/, 'chown root'],
    ];
    for (const [re, label] of patterns) {
      if (re.test(cmd)) return t('timeline.flagDescs.elevated_matched', { label });
    }
    return null;
  }
  if (flag === 'critical_cmd') {
    const patterns: [RegExp, string][] = [
      [/\brm\s+-[^\s]*r[^\s]*f/, 'rm -rf'],
      [/curl\s+.*\|\s*(?:bash|sh|zsh)/, 'curl | bash'],
      [/wget\s+.*\|\s*(?:bash|sh|zsh)/, 'wget | bash'],
      [/\bchmod\s+\+s\s+/, 'chmod +s (SUID)'],
      [/\bchmod\s+777\s+/, 'chmod 777'],
      [/\bdd\s+if=.*of=\/dev\//, 'dd to /dev/'],
      [/\biptables\s+-f/, 'iptables -F (flush firewall)'],
      [/\bmkfs\b/, 'mkfs (format disk)'],
    ];
    for (const [re, label] of patterns) {
      if (re.test(cmd)) return t('timeline.flagDescs.critical_cmd_matched', { label });
    }
    return null;
  }
  if (flag === 'sensitive_path' || flag === 'sensitive_path_medium') {
    const patterns: [RegExp, string][] = [
      [/\.ssh\//, '.ssh/ directory'],
      [/id_rsa/, 'SSH private key (id_rsa)'],
      [/\.env\b/, '.env file'],
      [/password|secret/, 'password/secret file'],
      [/keychains?\//, 'macOS Keychain'],
      [/\.pem\b|\.p12\b/, 'certificate/key file'],
    ];
    for (const [re, label] of patterns) {
      if (re.test(cmd)) return t('timeline.flagDescs.sensitive_path_matched', { label });
    }
    return t('timeline.flagDescs.sensitive_path_generic');
  }
  if (flag === 'exfil_pattern') {
    return t('timeline.flagDescs.exfil_pattern');
  }
  if (flag === 'new_domain') {
    try {
      const m = target.match(/https?:\/\/([^/:\s]+)/);
      if (m) return t('timeline.flagDescs.new_domain_first', { domain: m[1] });
    } catch { /* ignore */ }
    return t('timeline.flagDescs.new_domain_generic');
  }
  if (flag === 'anomaly_hour') {
    if (timestamp && baseline?.typical_hours) {
      const eventHour = new Date(timestamp).getHours();
      const sorted = [...baseline.typical_hours].sort((a, b) => a - b);
      const ranges: string[] = [];
      let start = sorted[0], end = sorted[0];
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] === end + 1) { end = sorted[i]; }
        else { ranges.push(start === end ? `${start}:00` : `${start}:00–${end}:59`); start = end = sorted[i]; }
      }
      if (sorted.length > 0) ranges.push(start === end ? `${start}:00` : `${start}:00–${end}:59`);
      return t('timeline.flagDescs.anomaly_hour', { hour: eventHour, ranges: ranges.join(', ') });
    }
    return t('timeline.flagDescs.anomaly_hour_generic');
  }
  if (flag === 'anomaly_volume') {
    if (baseline?.avg_tool_calls_per_session) {
      return t('timeline.flagDescs.anomaly_volume', { avg: baseline.avg_tool_calls_per_session });
    }
    return t('timeline.flagDescs.anomaly_volume_generic');
  }
  if (flag === 'anomaly_path') {
    if (baseline?.typical_paths) {
      return t('timeline.flagDescs.anomaly_path_detail', { paths: `${baseline.typical_paths.slice(0, 3).join(', ')}${baseline.typical_paths.length > 3 ? ', ...' : ''}` });
    }
    return t('timeline.flagDescs.anomaly_path_generic');
  }
  if (flag === 'anomaly') return t('timeline.flagDescs.anomaly');
  if (flag === 'sensitive_data') return t('timeline.flagDescs.sensitive_data');
  if (flag === 'prompt_injection') return t('timeline.flagDescs.prompt_injection');
  return null;
}

function riskColor(score: number): string {
  if (score === 3) return 'var(--C-rose)';
  if (score === 2) return 'var(--C-amber)';
  return 'var(--C-green)';
}



/** Try to extract a hostname from a URL-like target string */
function extractDomain(target: string): string {
  try {
    const m = target.match(/https?:\/\/([^/:\s]+)/);
    return m ? m[1] : target;
  } catch { return target; }
}

export default function DataAccessTimeline({ agentId, eventType, riskLevel, startDate = '', endDate = '' }: { agentId?: string; eventType?: string; riskLevel?: string; startDate?: string; endDate?: string }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [findingsLoading, setFindingsLoading] = useState(false);
  const [externalCalls, setExternalCalls] = useState<FollowingCall[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Fetch findings + external calls for the selected event
  const fetchFindingsAndFollowingCalls = useCallback(async (eventId: number) => {
    setFetchError(null);
    setFindingsLoading(true);
    try {
      const [fRes, cRes] = await Promise.all([
        fetch(`/api/audit/findings?eventId=${eventId}`),
        fetch(`/api/audit/event/${eventId}/following-calls`),
      ]);
      const fJson = await fRes.json() as { findings: Finding[] };
      const cJson = await cRes.json() as { calls: FollowingCall[] };
      setFindings(fJson.findings || []);
      setExternalCalls(cJson.calls || []);
    } catch {
      setFindings([]);
      setExternalCalls([]);
      setFetchError('timeline.failedLoadEventDetails');
    }
    setFindingsLoading(false);
  }, []);

  useEffect(() => {
    if (selectedId != null) fetchFindingsAndFollowingCalls(selectedId);
    else { setFindings([]); setExternalCalls([]); }
  }, [selectedId, fetchFindingsAndFollowingCalls]);

  async function dismissFinding(findingId: number) {
    try {
      const res = await fetch(`/api/audit/findings/${findingId}/dismiss`, { method: 'PATCH' });
      if (!res.ok) return;
      setFindings(prev => prev.map(f => f.id === findingId ? { ...f, dismissed: 1 } : f));
    } catch { /* network error — ignore */ }
  }

  // Reset page when filters change
  useEffect(() => { setPage(0); }, [startDate, endDate, agentId, eventType, riskLevel]);
  const limit = 50;

  const params = new URLSearchParams();
  if (agentId) params.set('agentId', agentId);
  if (eventType) params.set('eventType', eventType);
  if (riskLevel) params.set('riskLevel', riskLevel);
  if (startDate) params.set('startDate', startDate);
  if (endDate) params.set('endDate', endDate);
  params.set('limit', String(limit));
  params.set('offset', String(page * limit));

  const { data } = useFetch<{ events: AuditEvent[]; total: number }>(`/api/audit/timeline?${params}`);
  const { data: detail } = useFetch<EventDetail>(selectedId ? `/api/audit/event/${selectedId}` : '');

  const events = data?.events || [];
  const total = data?.total || 0;
  const totalPages = Math.ceil(total / limit);

  function exportTimelineAsJSON() {
    const exportParams = new URLSearchParams(params);
    exportParams.set('limit', '10000');
    exportParams.set('offset', '0');
    window.open(`/api/audit/timeline?${exportParams}`, '_blank');
  }

  async function exportTimelineAsCSV() {
    const exportParams = new URLSearchParams(params);
    exportParams.set('limit', '10000');
    exportParams.set('offset', '0');
    try {
    const res = await fetch(`/api/audit/timeline?${exportParams}`);
    if (!res.ok) return;
    const json = await res.json() as { events: AuditEvent[] };
    const rows = [
      ['id', 'timestamp', 'agent_id', 'session_id', 'event_type', 'tool_name', 'target', 'risk_score', 'risk_flags'],
      ...(json.events || []).map(e => [
        e.id,
        new Date(e.timestamp).toISOString(),
        e.agent_id,
        e.session_id,
        e.event_type,
        e.tool_name,
        `"${(e.target || '').replace(/"/g, '""')}"`,
        e.risk_score,
        `"${((() => { try { return JSON.parse(e.risk_flags || '[]'); } catch { return []; } })() as string[]).join(',')}"`,
      ]),
    ];
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-timeline-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    } catch { window.alert(t('timeline.failedExportCSV')); }
  }

  return (
    <div>
      {/* Export controls */}
      <div style={{ display: 'flex', gap: '.75rem', alignItems: 'center', padding: '0 1.5rem', marginTop: '1.5rem', marginBottom: '.75rem' }}>
        <span style={{ fontSize: '1rem', color: 'var(--text)', fontWeight: 600 }}>
          {total.toLocaleString()} {t('timeline.events')}
        </span>
        <button
          onClick={exportTimelineAsJSON}
          style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--muted)', padding: '.35rem .85rem', cursor: 'pointer', fontSize: '.85rem', borderRadius: 4 }}
        >{t('timeline.downloadJSON')}</button>
        <button
          onClick={exportTimelineAsCSV}
          style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--muted)', padding: '.35rem .85rem', cursor: 'pointer', fontSize: '.85rem', borderRadius: 4 }}
        >{t('timeline.downloadCSV')}</button>
      </div>

      <div>
        <div className="tbl" style={{ borderTop: 'none', overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 160, fontSize: 13 }}>{t('common.time')}</th>
                <th style={{ fontSize: 13 }}>{t('common.agent')}</th>
                <th style={{ fontSize: 13 }}>{t('common.type')}</th>
                <th style={{ fontSize: 13 }}>{t('common.target')}</th>
                <th className="r" style={{ width: 90, fontSize: 13 }}>{t('common.risk')}</th>
              </tr>
            </thead>
            <tbody>
              {events.length === 0 && (
                <tr><td colSpan={5} style={{ color: 'var(--muted)', textAlign: 'center', padding: '2rem', fontSize: 14 }}>{t('timeline.noEventsFound')}</td></tr>
              )}
              {events.map(ev => {
                const selected = ev.id === selectedId;
                return (
                  <React.Fragment key={ev.id}>
                  <tr
                    onClick={() => setSelectedId(selected ? null : ev.id)}
                    style={{
                      cursor: 'pointer',
                      borderLeft: selected ? '2px solid var(--C-blue)' : '2px solid transparent',
                    }}
                  >
                    <td className="mono" style={{ fontSize: 13, color: 'var(--muted)', whiteSpace: 'nowrap', padding: '8px 12px' }}>
                      {fmtDatetime(ev.timestamp)}
                    </td>
                    <td style={{ fontSize: 14, padding: '8px 12px' }}>{ev.agent_id}</td>
                    <td style={{ whiteSpace: 'nowrap', padding: '8px 12px' }}>
                      <span style={{ marginRight: '.35rem', fontSize: 15 }}>{EVENT_ICONS[ev.event_type] || '·'}</span>
                      <span style={{ fontSize: 13, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
                        {t('audit.eventTypeLabels.' + ev.event_type, { defaultValue: ev.event_type.replace('_', ' ') })}
                      </span>
                    </td>
                    <td className="mono" style={{ fontSize: 13, maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '8px 12px' }}
                      title={ev.target}>
                      {ev.target}
                    </td>
                    <td className="r" style={{ padding: '8px 12px' }}>
                      {ev.risk_score > 0 && (
                        <span style={{
                          background: riskColor(ev.risk_score),
                          color: '#fff',
                          padding: '3px 9px',
                          fontSize: 12,
                          fontWeight: 600,
                          textTransform: 'uppercase',
                          letterSpacing: '.05em',
                        }}>
                          {ev.risk_score === 3 ? t('common.high') : ev.risk_score === 2 ? t('common.medium') : t('common.low')}
                        </span>
                      )}
                    </td>
                  </tr>
                  {selected && detail && detail.id === ev.id && (
                    <tr key={`detail-${ev.id}`} style={{ background: 'rgb(15, 23, 36)' }}>
                      <td colSpan={5} style={{ padding: 0, borderLeft: '2px solid var(--C-blue)' }}>
                        <div style={{ padding: '1.25rem 1.5rem', borderTop: '1px solid #1e3a5f', borderBottom: '1px solid #1e3a5f' }}>
                          {/* Metadata grid */}
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '.6rem 1rem', fontSize: 14, marginBottom: '1.25rem' }}>
                            <div><span style={{ color: 'var(--muted)' }}>{t('timeline.detailTime')}</span><span className="mono">{fmtDatetime(detail.timestamp)}</span></div>
                            <div><span style={{ color: 'var(--muted)' }}>{t('timeline.detailAgent')}</span>{detail.agent_id}</div>
                            <div><span style={{ color: 'var(--muted)' }}>{t('timeline.detailTool')}</span>{detail.tool_name} → {detail.event_type}</div>
                            <div style={{ gridColumn: '1 / -1' }}>
                              <span style={{ color: 'var(--muted)' }}>{t('timeline.detailSession')}</span>
                              <span className="mono" style={{ fontSize: 13 }}>{detail.session_id}</span>
                              {detail.turn_number > 0 && (
                                <span style={{ marginLeft: '.5rem', color: 'var(--text)' }}>{t('timeline.turnNum', { num: detail.turn_number })}</span>
                              )}
                              <a
                                href={`/timeline?session=${detail.session_id}${detail.turn_number > 0 ? `&turn=${detail.turn_number}` : ''}`}
                                onClick={e => { e.stopPropagation(); }}
                                style={{ marginLeft: '.75rem', color: 'var(--C-blue)', fontSize: 13, textDecoration: 'none' }}
                              >
                                {t('timeline.viewInTimeline')}
                              </a>
                            </div>
                            <div style={{ gridColumn: '1 / -1' }}><span style={{ color: 'var(--muted)' }}>{t('timeline.detailTarget')}</span><span className="mono" style={{ wordBreak: 'break-all' }}>{detail.target}</span></div>
                            {(() => {
                              let flags: string[] = [];
                              try { flags = JSON.parse(detail.risk_flags || '[]'); } catch { /* ignore malformed */ }
                              return (
                                <>
                                  <div style={{ gridColumn: '1 / -1' }}>
                                    <span style={{ color: 'var(--muted)' }}>{t('timeline.detailRisk')}</span>
                                    <span style={{ color: riskColor(detail.risk_score), fontWeight: 600, fontSize: 15, textTransform: 'uppercase' }}>{detail.risk_score === 3 ? t('common.high') : detail.risk_score === 2 ? t('common.medium') : t('common.low')}</span>
                                  </div>
                                  <div style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: '.35rem' }}>
                                    {[...flags].sort((a, b) => (FLAG_RISK_LEVEL[b] || 0) - (FLAG_RISK_LEVEL[a] || 0)).map(f => {
                                      const matchDetail = flagMatchDetail(f, detail.target, detail.event_type, t, detail.timestamp, detail.baseline);
                                      return (
                                        <div key={f} style={{ display: 'flex', alignItems: 'baseline', gap: '.5rem', padding: '4px 10px', border: `1px solid ${flagColor(f)}`, background: 'rgba(0,0,0,0.2)' }}>
                                          <span style={{ color: flagColor(f), fontWeight: 600, fontSize: 11, flexShrink: 0 }}>{(FLAG_RISK_LEVEL[f] || 0) === 3 ? t('common.high') : (FLAG_RISK_LEVEL[f] || 0) === 2 ? t('common.medium') : t('common.low')}</span>
                                          <span style={{ color: flagColor(f), fontWeight: 600, fontSize: 13 }}>{t('timeline.flagLabels.' + f, { defaultValue: f })}</span>
                                          {matchDetail && (
                                            <span style={{ color: 'var(--muted)', fontSize: 12, marginLeft: '.25rem' }}>— {matchDetail}</span>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                </>
                              );
                            })()}
                          </div>

                          {/* What triggered this */}
                          {detail.user_context && (
                            <div style={{ marginBottom: '1rem' }}>
                              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', margin: '0 0 .4rem' }}>
                                {t('timeline.whatTriggered')}{detail.turn_number > 0 ? ` — ${t('timeline.turnNum', { num: detail.turn_number })}` : ''}
                              </div>
                              <pre style={{ fontSize: 13, color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 140, overflow: 'auto', background: 'rgba(0,0,0,0.3)', padding: '.75rem 1rem', margin: 0, borderLeft: '2px solid var(--C-blue)' }}>
                                {detail.user_context}
                              </pre>
                            </div>
                          )}

                          {/* Input / Output */}
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                            <div>
                              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', margin: '0 0 .4rem' }}>{t('common.input')}</div>
                              <pre style={{ fontSize: 13, color: 'var(--muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 220, overflow: 'auto', background: 'var(--surface2)', padding: '.85rem 1rem', margin: 0 }}>
                                {detail.raw_input}
                              </pre>
                            </div>
                            <div>
                              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', margin: '0 0 .4rem' }}>{t('common.output')} <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 12 }}>{t('timeline.truncated2KB')}</span></div>
                              <pre style={{ fontSize: 13, color: 'var(--muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 220, overflow: 'auto', background: 'var(--surface2)', padding: '.85rem 1rem', margin: 0 }}>
                                {detail.raw_output}
                              </pre>
                            </div>
                          </div>

                          {/* Findings for this event */}
                          {fetchError && (
                            <div style={{ fontSize: 14, color: 'var(--C-rose)', marginTop: '1rem' }}>{t(fetchError)}</div>
                          )}
                          {findingsLoading && (
                            <div style={{ fontSize: 14, color: 'var(--muted)', marginTop: '1rem' }}>{t('timeline.loadingFindings')}</div>
                          )}
                          {!findingsLoading && findings.length > 0 && (
                            <div style={{ marginTop: '1.25rem' }}>
                              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', margin: '0 0 .6rem' }}>
                                {t('timeline.sensitiveDataMatches')}
                                <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 13, marginLeft: '.5rem' }}>
                                  {findings.length} {findings.length !== 1 ? t('common.matches') : t('common.match')}
                                </span>
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '.6rem' }}>
                                {findings.map(f => (
                                  <div key={f.id} style={{
                                    padding: '.75rem 1rem',
                                    border: `1px solid ${f.dismissed ? 'var(--border)' : severityColor(f.severity)}`,
                                    background: f.dismissed ? 'transparent' : 'rgba(0,0,0,0.15)',
                                    opacity: f.dismissed ? 0.5 : 1,
                                  }}>
                                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '.75rem' }}>
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        {/* Finding header */}
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', marginBottom: '.35rem', flexWrap: 'wrap' }}>
                                          <span style={{
                                            fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
                                            letterSpacing: '.06em', color: severityColor(f.severity),
                                            padding: '2px 6px', border: `1px solid ${severityColor(f.severity)}`,
                                          }}>
                                            {t('common.' + f.severity, { defaultValue: f.severity })}
                                          </span>
                                          <span style={{ fontSize: 14, color: 'var(--text)', fontWeight: 600 }}>
                                            {t('timeline.patternLabels.' + f.pattern_type, { defaultValue: PATTERN_LABELS[f.pattern_type] || f.pattern_type })}
                                          </span>
                                          {f.dismissed === 1 && (
                                            <span style={{ fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>{t('common.dismissed')}</span>
                                          )}
                                        </div>

                                        {/* Matched pattern */}
                                        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: '.3rem' }}>
                                          <span style={{ color: 'var(--muted)', fontWeight: 600 }}>{t('timeline.matchedRule')} </span>
                                          <span className="mono">{f.pattern_matched}</span>
                                        </div>

                                        {/* Context */}
                                        {f.context && (
                                          <div style={{ fontSize: 13, color: 'var(--muted)', wordBreak: 'break-all', marginBottom: '.3rem' }}>
                                            <span style={{ fontWeight: 600 }}>{t('timeline.matchedContent')} </span>
                                            {f.context}
                                          </div>
                                        )}

                                        {/* External call details */}
                                        {f.followed_by_external_call === 1 && (
                                          <div style={{ marginTop: '.5rem', padding: '.6rem .85rem', background: 'rgba(255, 80, 80, 0.08)', border: '1px solid var(--C-rose)', borderRadius: 2 }}>
                                            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--C-rose)', marginBottom: '.4rem' }}>
                                              {t('timeline.confirmedExfil')}
                                            </div>
                                            <div
                                              style={{ fontSize: 13, color: 'var(--C-rose)', lineHeight: 1.7, marginBottom: '.5rem', wordBreak: 'break-word' }}
                                              dangerouslySetInnerHTML={{ __html: t('timeline.exfilDesc', { type: t('timeline.patternLabels.' + f.pattern_type, { defaultValue: PATTERN_LABELS[f.pattern_type] || f.pattern_type }) }) }}
                                            />
                                            {externalCalls.length > 0 ? (
                                              <div style={{ display: 'flex', flexDirection: 'column', gap: '.4rem', marginTop: '.4rem' }}>
                                                {externalCalls.map(c => (
                                                  <div key={c.id} style={{ padding: '6px 8px', background: 'rgba(0,0,0,0.2)', borderLeft: '2px solid var(--C-rose)' }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', marginBottom: '.2rem' }}>
                                                      <span className="mono" style={{ color: 'var(--muted)', fontSize: 12 }}>{fmtDatetime(c.timestamp)}</span>
                                                      <span style={{ fontSize: 11, color: 'var(--C-rose)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.05em' }}>{t('audit.eventTypeLabels.' + c.event_type, { defaultValue: c.event_type.replace('_', ' ') })}</span>
                                                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{extractDomain(c.target)}</span>
                                                    </div>
                                                    <div className="mono" style={{ color: 'var(--muted)', fontSize: 12, wordBreak: 'break-all', lineHeight: 1.4 }}>{c.target}</div>
                                                  </div>
                                                ))}
                                              </div>
                                            ) : (
                                              <div style={{ fontSize: 13, color: 'var(--muted)', fontStyle: 'italic' }}>{t('timeline.loadingExternalCalls')}</div>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                      {f.dismissed === 0 && (
                                        <button
                                          onClick={(e) => { e.stopPropagation(); dismissFinding(f.id); }}
                                          style={{
                                            flexShrink: 0, background: 'none',
                                            border: '1px solid var(--border)', color: 'var(--muted)',
                                            padding: '4px 12px', cursor: 'pointer', fontSize: 13,
                                          }}
                                        >
                                          {t('common.dismiss')}
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', padding: '.85rem 1.5rem', borderTop: '1px solid var(--border)' }}>
          <button
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
            style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--muted)', padding: '.3rem .75rem', cursor: 'pointer', fontSize: 13 }}
          >{t('common.prev')}</button>
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>
            {t('common.page')} {page + 1} {t('common.of')} {totalPages}
          </span>
          <button
            onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--muted)', padding: '.3rem .75rem', cursor: 'pointer', fontSize: 13 }}
          >{t('common.next')}</button>
        </div>
      )}
    </div>
  );
}
