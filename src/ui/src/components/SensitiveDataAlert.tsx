import { useState, useEffect, type ReactNode, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { fmtDatetime } from '../hooks';
import { type Finding, type EventDetail, type FollowingCall, PATTERN_LABELS, INJECTION_TYPES, severityColor } from '../constants/auditTypes';

function buildExplanation(f: Finding, t: TFunction, event?: EventDetail, followingCalls?: FollowingCall[]): ReactNode {
  const what = t('sensitiveAlert.patternLabels.' + f.pattern_type, { defaultValue: PATTERN_LABELS[f.pattern_type] || f.pattern_type });
  const tool = event?.tool_name || 'a tool';
  const target = event?.target;
  const isInjection = INJECTION_TYPES.has(f.pattern_type);
  const sev = f.severity;
  const sevColor = sev === 'high' ? 'var(--C-rose)' : sev === 'medium' ? 'var(--C-amber)' : 'var(--C-green)';

  const headingStyle: CSSProperties = { fontWeight: 600, marginBottom: '.3rem' };

  if (isInjection) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.75rem' }}>
        <div>
          <div style={headingStyle}>{t('sensitiveAlert.whatHappened')}</div>
          <div>{t('sensitiveAlert.injectionPre')}<span style={{ color: 'var(--C-rose)', fontWeight: 600 }}>{t('sensitiveAlert.promptInjection')}</span>{t('sensitiveAlert.injectionPatternPre')}<span style={{ color: 'var(--C-rose)' }}>{what}</span>{t('sensitiveAlert.injectionPatternMid')}<span style={{ color: 'var(--C-blue)' }}>{tool}</span>{t('sensitiveAlert.injectionCallSuffix')}{target ? <>{t('sensitiveAlert.injectionTargetPre')}<span className="mono" style={{ fontSize: '.85rem' }}>{target.slice(0, 80)}</span>{t('sensitiveAlert.injectionTargetSuf')}</> : ''}.</div>
        </div>
        <div>
          <div style={{ ...headingStyle, color: 'var(--C-rose)' }}>{t('sensitiveAlert.whyHighRisk')}</div>
          <div>{t('sensitiveAlert.promptInjectionWhyPre')}<span style={{ color: 'var(--C-rose)', fontWeight: 600 }}>{t('sensitiveAlert.promptInjectionAttacks')}</span>{t('sensitiveAlert.promptInjectionWhyPost')}</div>
        </div>
        <div>
          <div style={{ ...headingStyle, color: 'var(--C-blue)' }}>{t('sensitiveAlert.recommendation')}</div>
          <div>{t('sensitiveAlert.reviewSource')}</div>
        </div>
      </div>
    );
  }

  let whySection: ReactNode;
  if (sev === 'high') {
    whySection = (
      <div>
        <div style={{ ...headingStyle, color: 'var(--C-rose)' }}>{t('sensitiveAlert.whyHighRisk')}</div>
        <div>{t('sensitiveAlert.highRiskPre')}<span style={{ color: 'var(--C-rose)', fontWeight: 600 }}>{t('sensitiveAlert.externalNetworkCallsLabel')}</span>{t('sensitiveAlert.highRiskMid')}<span style={{ color: 'var(--C-rose)', fontWeight: 600 }}>{t('sensitiveAlert.transmittedOutsideLabel')}</span>{t('sensitiveAlert.highRiskPost')}</div>
        {followingCalls && followingCalls.length > 0 && (
          <div style={{ marginTop: '.5rem' }}>
            <div style={{ color: 'var(--C-rose)', fontWeight: 600, marginBottom: '.3rem' }}>{t('sensitiveAlert.externalCalls', { count: followingCalls.length })}:</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '.2rem' }}>
              {followingCalls.map(c => (
                <div key={c.id} style={{ fontFamily: 'var(--font-mono)', background: 'rgba(0,0,0,0.3)', padding: '.3rem .6rem', borderLeft: '2px solid var(--C-rose)', wordBreak: 'break-all' }}>
                  <span style={{ color: 'var(--C-rose)', fontWeight: 600, marginRight: '.4rem' }}>{c.event_type}</span>
                  <span>{c.target}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  } else if (sev === 'medium') {
    whySection = (
      <div>
        <div style={{ ...headingStyle, color: 'var(--C-amber)' }}>{t('sensitiveAlert.whyMediumRisk')}</div>
        <div>{t('sensitiveAlert.mediumExposedPre')}<span style={{ color: 'var(--C-amber)', fontWeight: 600 }}>{t('sensitiveAlert.noDirectEvidence')}</span>{t('sensitiveAlert.mediumExposedPost')}</div>
      </div>
    );
  } else {
    whySection = (
      <div>
        <div style={{ ...headingStyle, color: 'var(--C-green)' }}>{t('sensitiveAlert.whyLowRisk')}</div>
        <div>{t('sensitiveAlert.lowSeverityNote')}</div>
      </div>
    );
  }

  let recommendation: string;
  if (f.pattern_type === 'api_key' || f.pattern_type === 'aws_key') {
    recommendation = t('sensitiveAlert.recommendationApiKey');
  } else if (f.pattern_type === 'private_key' || f.pattern_type === 'blockchain_key' || f.pattern_type === 'mnemonic_seed') {
    recommendation = t('sensitiveAlert.recommendationPrivateKey');
  } else if (f.pattern_type === 'jwt') {
    recommendation = t('sensitiveAlert.recommendationJwt');
  } else if (f.pattern_type === 'database_uri') {
    recommendation = t('sensitiveAlert.recommendationDbUri');
  } else if (f.pattern_type === 'pii_phone_cn' || f.pattern_type === 'pii_id_cn' || f.pattern_type === 'credit_card') {
    recommendation = t('sensitiveAlert.recommendationPii');
  } else {
    recommendation = t('sensitiveAlert.recommendationDefault');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '.75rem' }}>
      <div>
        <div style={headingStyle}>{t('sensitiveAlert.whatHappened')}</div>
        <div>{t('sensitiveAlert.foundPre')}<span style={{ color: sevColor, fontWeight: 600 }}>{what.toLowerCase()}</span>{t('sensitiveAlert.foundMid')}<span style={{ color: 'var(--C-blue)' }}>{tool}</span>{t('sensitiveAlert.foundCallSuffix')}{target ? <>{t('sensitiveAlert.injectionTargetPre')}<span className="mono" style={{ fontSize: '.85rem' }}>{target.slice(0, 80)}</span>{t('sensitiveAlert.injectionTargetSuf')}</> : ''}.</div>
      </div>
      {whySection}
      <div>
        <div style={{ ...headingStyle, color: 'var(--C-blue)' }}>{t('sensitiveAlert.recommendation')}</div>
        <div>{recommendation}</div>
      </div>
    </div>
  );
}

function ExpandedDetail({ f }: { f: Finding }) {
  const { t } = useTranslation();
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [followingCalls, setFollowingCalls] = useState<FollowingCall[]>([]);
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const [eventRes, callsRes] = await Promise.all([
          fetch(`/api/audit/event/${f.audit_event_id}`),
          fetch(`/api/audit/event/${f.audit_event_id}/following-calls`),
        ]);
        const eventData = await eventRes.json();
        setEvent(eventData as EventDetail);
        const callsData = await callsRes.json();
        setFollowingCalls((callsData as { calls: FollowingCall[] }).calls || []);
      } catch {
        setFetchError(true);
      }
    }
    load();
  }, [f.audit_event_id]);

  const explanation = buildExplanation(f, t, event || undefined, followingCalls);

  return (
    <div style={{
      background: 'rgb(15, 23, 36)',
      border: '1px solid #1e3a5f',
      borderTop: 'none',
      borderLeft: '3px solid var(--C-blue)',
      padding: '1rem 1.25rem',
    }}>
      {fetchError && <div style={{ color: 'var(--C-amber)', fontSize: 13, marginBottom: '0.5rem' }}>{t('sensitiveAlert.failedLoadEventDetails')}</div>}

      {/* Explanation */}
      <div style={{ fontSize: '.92rem', lineHeight: 1.7, color: 'var(--text)', marginBottom: '1rem' }}>
        {explanation}
      </div>

      {/* User context — what was the agent asked to do */}
      {event?.user_context && (
        <div style={{ marginBottom: '1rem' }}>
          <div style={{ fontSize: '.85rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: '.35rem', fontWeight: 600 }}>
            {t('sensitiveAlert.whatTriggered')}{event.turn_number > 0 ? ` (${t('sensitiveAlert.turn', { num: event.turn_number })})` : ''}
          </div>
          <pre style={{ fontSize: '.88rem', color: 'var(--text)', background: 'rgba(0,0,0,0.3)', padding: '.6rem .75rem', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', borderLeft: '2px solid var(--C-blue)', maxHeight: 120, overflow: 'auto' }}>
            {event.user_context}
          </pre>
        </div>
      )}

      {/* Event metadata */}
      {event && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '.4rem .75rem', fontSize: '.88rem', marginBottom: '1rem' }}>
          <div><span style={{ color: 'var(--muted)' }}>{t('sensitiveAlert.timeLabel')}</span><span className="mono">{fmtDatetime(event.timestamp)}</span></div>
          <div><span style={{ color: 'var(--muted)' }}>{t('sensitiveAlert.agentLabel')}</span>{event.agent_id}</div>
          <div><span style={{ color: 'var(--muted)' }}>{t('sensitiveAlert.toolLabel')}</span>{event.tool_name} → {event.event_type}</div>
          <div style={{ gridColumn: '1 / -1' }}>
            <span style={{ color: 'var(--muted)' }}>{t('sensitiveAlert.sessionLabel')}</span>
            <span className="mono">{event.session_id}</span>
            {event.turn_number > 0 && (
              <span style={{ marginLeft: '.5rem', fontWeight: 600 }}>{t('sensitiveAlert.turn', { num: event.turn_number })}</span>
            )}
            <a
              href={`/timeline?session=${event.session_id}${event.turn_number > 0 ? `&turn=${event.turn_number}` : ''}`}
              style={{ marginLeft: '.75rem', color: 'var(--C-blue)', textDecoration: 'none' }}
            >
              {t('sensitiveAlert.viewInTimeline')}
            </a>
          </div>
          {event.target && (
            <div style={{ gridColumn: '1 / -1' }}><span style={{ color: 'var(--muted)' }}>{t('sensitiveAlert.targetLabel')}</span><span className="mono" style={{ wordBreak: 'break-all' }}>{event.target}</span></div>
          )}
        </div>
      )}

      {/* Context snippet */}
      {f.context && (
        <div>
          <div style={{ fontSize: '.88rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: '.35rem', fontWeight: 600 }}>{t('sensitiveAlert.matchedContent')} <span style={{ fontSize: '.78rem', fontWeight: 400, textTransform: 'none', letterSpacing: 'normal' }}>{t('sensitiveAlert.maskedNote')}</span></div>
          <pre style={{ fontSize: '.92rem', color: 'var(--text)', background: 'rgba(0,0,0,0.3)', padding: '.75rem', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', borderLeft: '2px solid #1e3a5f', maxHeight: 160, overflow: 'auto' }}>
            {f.context}
          </pre>
        </div>
      )}
    </div>
  );
}

function extractDomain(url: string): string {
  try { return new URL(url).hostname; } catch { return url.slice(0, 40); }
}

function FindingCard({ f, isExpanded, onToggle, onDismiss, isDimmed }: { f: Finding; isExpanded: boolean; onToggle: () => void; onDismiss: () => void; isDimmed: boolean }) {
  const { t } = useTranslation();
  const [domains, setDomains] = useState<string[]>([]);

  useEffect(() => {
    if (f.followed_by_external_call !== 1) return;
    fetch(`/api/audit/event/${f.audit_event_id}/following-calls`)
      .then(r => r.json())
      .then(d => {
        const calls = (d as { calls: FollowingCall[] }).calls || [];
        const unique = [...new Set(calls.map(c => extractDomain(c.target)))];
        setDomains(unique);
      })
      .catch(() => {});
  }, [f.audit_event_id, f.followed_by_external_call]);

  const isInjection = INJECTION_TYPES.has(f.pattern_type);

  return (
    <div style={{ opacity: isDimmed ? 0.5 : 1 }}>
      <div
        onClick={onToggle}
        style={{
          border: '1px solid var(--border)',
          borderLeft: `3px solid ${severityColor(f.severity)}`,
          borderBottom: isExpanded ? 'none' : '1px solid var(--border)',
          padding: '.85rem 1rem',
          background: 'var(--surface)',
          cursor: 'pointer',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '.5rem' }}>
          <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{
              background: severityColor(f.severity), color: '#fff',
              padding: '2px 8px', fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.06em',
            }}>
              {f.severity}
            </span>
            <span style={{ fontSize: '.9rem', fontWeight: 500 }}>
              {t('sensitiveAlert.patternLabels.' + f.pattern_type, { defaultValue: PATTERN_LABELS[f.pattern_type] || f.pattern_type })}
            </span>
            {isInjection && (
              <span style={{ background: 'var(--C-rose)', color: '#fff', padding: '2px 8px', fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                {t('sensitiveAlert.promptInjectionBadge')}
              </span>
            )}
            {domains.length > 0 && (
              <span style={{ background: 'var(--C-rose)', color: '#fff', padding: '2px 8px', fontSize: '.72rem' }}>
                {t('sensitiveAlert.sentToBadge', { domains: domains.slice(0, 3).join(', ') + (domains.length > 3 ? ` +${domains.length - 3}` : '') })}
              </span>
            )}
            {f.followed_by_external_call === 1 && domains.length === 0 && (
              <span style={{ background: 'var(--C-amber)', color: '#fff', padding: '2px 8px', fontSize: '.72rem' }}>
                {t('sensitiveAlert.externalCallsBadge')}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: '.4rem', flexShrink: 0, alignItems: 'center' }}>
            <span style={{ fontSize: '.78rem', color: 'var(--muted)' }}>{isExpanded ? '▲' : '▼'}</span>
            <button
              onClick={e => { e.stopPropagation(); onDismiss(); }}
              style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--muted)', padding: '.2rem .6rem', cursor: 'pointer', fontSize: '.72rem', whiteSpace: 'nowrap' }}
            >
              {t('common.dismiss')}
            </button>
          </div>
        </div>

        <div style={{ fontSize: '.82rem', color: 'var(--muted)', marginBottom: '.45rem' }}>
          {fmtDatetime(f.timestamp ?? 0)} · {f.agent_id} · <span className="mono" style={{ fontSize: '.78rem' }}>{f.pattern_matched}</span>
        </div>
      </div>

      {isExpanded && <ExpandedDetail f={f} />}
    </div>
  );
}

export default function SensitiveDataAlert({ agentId, onViewEvent: _onViewEvent, severity: severityFilter }: { agentId?: string; onViewEvent?: (eventId: number) => void; severity?: string }) {
  const { t } = useTranslation();
  const [showDismissed, setShowDismissed] = useState(false);
  const [localDismissed, setLocalDismissed] = useState<Set<number>>(new Set());
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  useEffect(() => { setLoaded(false); }, [agentId, severityFilter]);

  if (!loaded && !loading) {
    setLoading(true);
    const params = new URLSearchParams();
    if (agentId) params.set('agentId', agentId);
    if (severityFilter) params.set('severity', severityFilter);
    if (showDismissed) params.set('dismissed', 'true');
    params.set('limit', '100');
    fetch(`/api/audit/findings?${params}`)
      .then(r => r.json())
      .then(d => {
        setFindings(d.findings || []);
        setTotal(d.total || 0);
        setLoading(false);
        setLoaded(true);
      })
      .catch(() => { setLoading(false); setLoaded(true); setFetchError(true); });
  }

  function dismiss(id: number) {
    fetch(`/api/audit/findings/${id}/dismiss`, { method: 'PATCH' }).catch(() => {});
    setLocalDismissed(prev => new Set([...prev, id]));
    if (expandedId === id) setExpandedId(null);
  }

  const visible = (findings || []).filter(f => !localDismissed.has(f.id));

  if (loading) {
    return <div style={{ padding: '2rem 1.5rem', color: 'var(--muted)', fontSize: '.85rem' }}>{t('common.loading')}</div>;
  }

  if (fetchError && !findings?.length) {
    return <div style={{ padding: '2rem 1.5rem', color: 'var(--C-amber)', fontSize: 13 }}>{t('sensitiveAlert.failedLoadFindings')}</div>;
  }

  if (visible.length === 0) {
    return (
      <div style={{ padding: '2rem 1.5rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '.5rem' }}>
        <div style={{ fontSize: '1.5rem' }}>✓</div>
        <div style={{ color: 'var(--muted)', fontSize: '.85rem' }}>{t('sensitiveAlert.noFindings')}</div>
        {total > 0 && (
          <button
            onClick={() => { setShowDismissed(true); setLoaded(false); }}
            style={{ marginTop: '.5rem', background: 'none', border: '1px solid var(--border)', color: 'var(--muted)', padding: '.25rem .6rem', cursor: 'pointer', fontSize: '.78rem' }}
          >
            {t('sensitiveAlert.showDismissed')} {total}
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: '0 1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '.75rem 0' }}>
        <span style={{ fontSize: '.85rem', color: 'var(--muted)' }}>{t('sensitiveAlert.findingsCount', { count: total })}</span>
        <button
          onClick={() => { setShowDismissed(v => !v); setLoaded(false); }}
          style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--muted)', padding: '.2rem .5rem', cursor: 'pointer', fontSize: '.78rem' }}
        >
          {showDismissed ? t('sensitiveAlert.hideDismissed') : t('sensitiveAlert.showDismissed')}
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '.75rem' }}>
        {visible.map(f => (
          <FindingCard key={f.id} f={f} isExpanded={expandedId === f.id} onToggle={() => setExpandedId(expandedId === f.id ? null : f.id)} onDismiss={() => dismiss(f.id)} isDimmed={!!f.dismissed || localDismissed.has(f.id)} />
        ))}
      </div>
    </div>
  );
}
