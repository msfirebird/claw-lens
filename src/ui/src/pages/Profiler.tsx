import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  useFetch, fmtMs, fmtCost, fmtTokens, fmtPct, COLORS,
} from '../hooks';
import { PageHeader, InfoTooltip } from '../components/ui';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

interface ToolRow {
  tool_name: string; call_count: number; timed_count: number;
  avg_duration_ms: number; p50_ms: number; p95_ms: number; error_count: number;
}


// For the session list in session picker
interface SessionPickerRow {
  id: string; agent_name: string; started_at: number; ended_at: number;
  total_cost: number; total_tokens: number; duration_ms: number;
  total_messages: number;
}



// ═══════════════════════════════════════════════════════════════════════════════
// SEARCHABLE SESSION PICKER (reusable, matches Timeline's design)
// ═══════════════════════════════════════════════════════════════════════════════

function fmtPickerTime(ts: number): string {
  const locale = localStorage.getItem('claw-lens-lang') === 'zh' ? 'zh-CN' : 'en-US';
  const d = new Date(ts);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const dateStr = sameYear
    ? d.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
    : d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
  const timeStr = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  return `${dateStr} ${timeStr}`;
}

function ProfilerSessionPicker({
  sessions,
  value,
  onChange,
}: {
  sessions: SessionPickerRow[];
  value: string; // '' = all sessions
  onChange: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = value ? sessions.find(s => s.id === value) ?? null : null;

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? sessions.filter(s => s.id.includes(q) || s.agent_name.toLowerCase().includes(q))
    : sessions;

  function updateSearchQuery(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    setQuery(v);
    setOpen(true);
    const exact = sessions.find(s => s.id === v.trim());
    if (exact) { onChange(exact.id); setQuery(''); setOpen(false); }
  }

  function pick(id: string) {
    onChange(id);
    setQuery('');
    setOpen(false);
  }

  function clear(e: React.MouseEvent) {
    e.stopPropagation();
    onChange('');
    setQuery('');
  }

  const BORDER_FOCUSED = '1px solid var(--C-blue)';
  const BORDER_NORMAL = '1px solid var(--border)';

  return (
    <div ref={rootRef} style={{ position: 'relative', flex: 1, maxWidth: 680 }}>
      <div
        onClick={() => { setOpen(o => !o); setTimeout(() => inputRef.current?.focus(), 10); }}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          border: open ? BORDER_FOCUSED : BORDER_NORMAL,
          borderRadius: 'var(--radius-sm)',
          background: 'var(--surface)',
          padding: '6px 10px',
          cursor: 'text',
          transition: 'border-color .12s',
          minHeight: 38,
        }}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, opacity: 0.4 }}>
          <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.5"/>
          <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>

        {selected && !open ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <span style={{ fontFamily: 'var(--font-m)', fontSize: 11, color: 'var(--text)', flexShrink: 0 }}>
              {selected.id}
            </span>
            <span style={{ fontSize: 11, color: 'var(--C-blue)', flexShrink: 0 }}>{selected.agent_name}</span>
            <span style={{ fontSize: 11, color: 'var(--C-green)', flexShrink: 0 }}>{fmtCost(selected.total_cost)}</span>
            <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>{fmtPickerTime(selected.started_at)}</span>
          </div>
        ) : !value && !open ? (
          <span style={{ flex: 1, fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--font-m)' }}>
            {t('profiler.allSessions')}
          </span>
        ) : (
          <input
            ref={inputRef}
            value={query}
            onChange={updateSearchQuery}
            onFocus={() => setOpen(true)}
            placeholder={selected ? selected.id : t('profiler.searchPlaceholder')}
            style={{
              flex: 1, background: 'none', border: 'none', outline: 'none',
              fontSize: 12, color: 'var(--text)',
              fontFamily: 'var(--font-m)',
              minWidth: 0,
            }}
            onClick={e => e.stopPropagation()}
          />
        )}

        {selected && (
          <button onClick={clear} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--muted)', fontSize: 15, lineHeight: 1,
            padding: '0 2px', flexShrink: 0,
          }}>×</button>
        )}

        <svg
          width="10" height="10" viewBox="0 0 10 10" fill="none"
          style={{ flexShrink: 0, opacity: 0.4, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}
        >
          <path d="M1 3l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>

      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          boxShadow: '0 12px 32px rgba(0,0,0,.35)',
          maxHeight: 340, overflowY: 'auto',
          zIndex: 200,
        }}>
          {/* All Sessions option */}
          <div
            onClick={() => pick('')}
            style={{
              padding: '9px 14px',
              borderBottom: '1px solid var(--border)',
              cursor: 'pointer',
              background: !value ? 'var(--surface3)' : 'transparent',
              transition: 'background .08s',
            }}
            onMouseEnter={e => { if (value) (e.currentTarget as HTMLElement).style.background = 'var(--surface2)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = !value ? 'var(--surface3)' : 'transparent'; }}
          >
            <div style={{ fontSize: 12, color: 'var(--text)', fontWeight: 500 }}>
              {t('profiler.allSessions')}
              {!value && (
                <span style={{ marginLeft: 6, fontSize: 9, color: 'var(--C-blue)', background: 'rgba(59,130,246,.15)', padding: '1px 5px', borderRadius: 3 }}>{t('profiler.selected')}</span>
              )}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>{t('profiler.aggregateAll')}</div>
          </div>

          {filtered.length === 0 ? (
            <div style={{ padding: '14px 14px', color: 'var(--muted)', fontSize: 12 }}>{t('profiler.noSessionsMatch')}</div>
          ) : (
            filtered.map((s, i) => {
              const isActive = s.id === value;
              return (
                <div
                  key={s.id}
                  onClick={() => pick(s.id)}
                  style={{
                    padding: '9px 14px',
                    borderBottom: i < filtered.length - 1 ? '1px solid var(--border)' : 'none',
                    cursor: 'pointer',
                    background: isActive ? 'var(--surface3)' : 'transparent',
                    transition: 'background .08s',
                  }}
                  onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'var(--surface2)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = isActive ? 'var(--surface3)' : 'transparent'; }}
                >
                  <div style={{ fontFamily: 'var(--font-m)', fontSize: 11, color: 'var(--text)', marginBottom: 3, letterSpacing: '.01em' }}>
                    {s.id}
                    {isActive && (
                      <span style={{ marginLeft: 6, fontSize: 9, color: 'var(--C-blue)', background: 'rgba(59,130,246,.15)', padding: '1px 5px', borderRadius: 3 }}>{t('profiler.selected')}</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 14, fontSize: 11 }}>
                    <span style={{ color: 'var(--C-blue)', fontWeight: 500 }}>{s.agent_name}</span>
                    <span style={{ color: 'var(--C-green)' }}>{fmtCost(s.total_cost)}</span>
                    <span style={{ color: 'var(--muted)' }}>{fmtPickerTime(s.started_at)}</span>
                    <span style={{ color: 'var(--muted)' }}>{s.total_tokens ? fmtTokens(s.total_tokens) : ''}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIEW 2: HOTSPOTS
// ═══════════════════════════════════════════════════════════════════════════════

// ── Tool distribution types ──────────────────────────────────────────────────

interface DistBucket { label: string; min: number; max: number | null; count: number }
interface DistOutlier {
  id: string; session_id: string; agent_name: string;
  timestamp: number; duration_ms: number; success: number;
  total_messages: number; turn_number: number;
}
interface ToolDistribution {
  buckets: DistBucket[];
  outliers: DistOutlier[];
  slow_calls?: {
    slow_10s?: DistOutlier[];
    slow_1m?: DistOutlier[];
    slow_5m?: DistOutlier[];
  };
  error_calls?: DistOutlier[];
}

// ── Collapsible tool row with histogram ──────────────────────────────────────

function ToolProfileRow({
  tool,
  totalTime,
  maxTime,
  allToolsTime,
  colorIdx,
  sessionFilter,
}: {
  tool: ToolRow;
  totalTime: number;
  maxTime: number;
  allToolsTime: number; // sum of all tools' totalTime
  colorIdx: number;
  sessionFilter: string; // '' = all sessions
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const distQs = sessionFilter ? `?session=${encodeURIComponent(sessionFilter)}` : '';
  const { data: dist } = useFetch<ToolDistribution>(
    expanded ? `/api/tools/${encodeURIComponent(tool.tool_name)}/distribution${distQs}` : '',
    [expanded, sessionFilter],
  );

  const errorRate = tool.call_count > 0 ? (tool.error_count / tool.call_count) * 100 : 0;
  const color = COLORS[colorIdx % COLORS.length];

  const maxBucket = dist ? Math.max(...dist.buckets.map(b => b.count), 1) : 1;

  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      {/* ── Collapsed row ── */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '20px 100px 56px 60px 60px 60px 80px 1fr',
          alignItems: 'center',
          gap: '.5rem',
          padding: '.6rem 0',
          cursor: 'pointer',
          transition: 'background .1s',
        }}
        onClick={() => setExpanded(!expanded)}
        onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface2)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      >
        <div style={{ fontSize: 24, color: 'var(--muted)', textAlign: 'center', lineHeight: 1 }}>
          {expanded ? '▾' : '▸'}
        </div>
        <div style={{ fontWeight: 600, fontSize: '.85rem', color }}>
          {tool.tool_name}
        </div>
        <div style={{ fontSize: '.8rem', color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
          {tool.call_count}×
        </div>
        <div style={{ fontSize: '.8rem', color: 'var(--muted)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
          {fmtMs(tool.avg_duration_ms)}
        </div>
        <div style={{ fontSize: '.8rem', color: 'var(--text)', fontWeight: 600, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
          {fmtMs(tool.p50_ms)}
        </div>
        <div style={{ fontSize: '.8rem', color: 'var(--text)', fontWeight: 600, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
          {fmtMs(tool.p95_ms)}
        </div>
        <div style={{ fontSize: '.8rem', color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
          {fmtMs(totalTime)}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}>
          <div style={{
            flex: 1, height: 14, background: 'var(--surface2)',
            position: 'relative', overflow: 'hidden', borderRadius: 3,
          }}>
            <div style={{
              position: 'absolute', inset: 0,
              width: `${(totalTime / maxTime) * 100}%`,
              background: color,
              borderRadius: 3,
            }} />
          </div>
          <span style={{ fontSize: '.72rem', color: 'var(--muted)', width: 32, textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
            {allToolsTime > 0 ? fmtPct(totalTime / allToolsTime, 0) : ''}
          </span>
        </div>
      </div>

      {/* ── Expanded detail ── */}
      {expanded && (
        <div style={{
          padding: '.6rem 1.2rem 1.2rem 2.4rem',
          background: 'var(--surface)',
          borderTop: '1px solid var(--border)',
        }}>
          {/* Stats row */}
          <div style={{
            display: 'flex', gap: '1.5rem', fontSize: '.8rem',
            marginBottom: '1rem', color: 'var(--muted)',
          }}>
            <span>avg: <strong style={{ color: 'var(--text)' }}>{fmtMs(tool.avg_duration_ms)}</strong></span>
            <span>{t('profiler.p50Label')} <strong style={{ color: 'var(--text)' }}>{fmtMs(tool.p50_ms)}</strong></span>
            <span>{t('profiler.p95Label')} <strong style={{ color: 'var(--text)' }}>{fmtMs(tool.p95_ms)}</strong></span>
            <span>
              {t('profiler.errorRate')} <strong style={{ color: errorRate > 2 ? '#ef4444' : 'var(--text)' }}>
                {fmtPct(errorRate / 100, 1)}
              </strong>
            </span>
          </div>

          {/* Histogram — vertical stacked rows */}
          {dist ? (
            <>
              <div style={{ fontSize: '.85rem', fontWeight: 600, color: 'var(--muted)', marginBottom: '.5rem', display: 'flex', alignItems: 'center', gap: 8 }}>
                {t('profiler.durationDistribution')}
                <InfoTooltip width={380} label={
                  <span style={{ borderBottom: '1px dashed var(--muted)', paddingBottom: 1, cursor: 'help', fontSize: '.78rem', fontWeight: 400, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {t('profiler.howToRead')}
                    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 14, height: 14, borderRadius: '50%', border: '1px solid var(--muted)', fontSize: 9, fontWeight: 700, color: 'var(--muted)', lineHeight: 1 }}>?</span>
                  </span>
                } placement="bottom">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14, lineHeight: 1.7, fontSize: 12 }}>
                    {/* Duration ranges */}
                    <div>
                      <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 8, fontSize: 13 }}>{t('profiler.durationRanges')}</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div><span style={{ color: '#4ade80', fontWeight: 600 }}>&lt;1s</span> <span style={{ color: 'var(--muted)' }}>&mdash;</span> {t('profiler.durationLt1s')}</div>
                        <div><span style={{ color: '#60a5fa', fontWeight: 600 }}>1&ndash;10s</span> <span style={{ color: 'var(--muted)' }}>&mdash;</span> {t('profiler.duration1to10s')}</div>
                        <div><span style={{ color: '#fbbf24', fontWeight: 600 }}>10&ndash;60s</span> <span style={{ color: 'var(--muted)' }}>&mdash;</span> {t('profiler.duration10to60s')}</div>
                        <div><span style={{ color: '#fb923c', fontWeight: 600 }}>1&ndash;5m</span> <span style={{ color: 'var(--muted)' }}>&mdash;</span> {t('profiler.duration1to5m')}</div>
                        <div><span style={{ color: '#f87171', fontWeight: 600 }}>&gt;5m</span> <span style={{ color: 'var(--muted)' }}>&mdash;</span> {t('profiler.durationGt5m')}</div>
                      </div>
                    </div>

                    <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 12 }}>
                      <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 6, fontSize: 13 }}>{t('profiler.readingTheShape')}</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div><span style={{ color: '#4ade80' }}>{t('profiler.shapeConcentrated')}</span> {t('profiler.shapeConcentratedDesc')}</div>
                        <div><span style={{ color: '#fbbf24' }}>{t('profiler.shapeSpread')}</span> {t('profiler.shapeSpreadDesc')}</div>
                        <div><span style={{ color: '#f87171' }}>{t('profiler.shapeHeavyTail')}</span> {t('profiler.shapeHeavyTailDesc')}</div>
                      </div>
                    </div>
                  </div>
                </InfoTooltip>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '.3rem' }}>
                {dist.buckets.map(b => (
                  <div key={b.label} style={{
                    display: 'grid',
                    gridTemplateColumns: '52px 1fr 36px',
                    alignItems: 'center',
                    gap: '.5rem',
                  }}>
                    <div style={{
                      fontSize: '.76rem', color: 'var(--muted)',
                      textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                    }}>
                      {b.label}
                    </div>
                    <div style={{
                      height: 14, background: 'var(--surface2)',
                      position: 'relative', overflow: 'hidden', borderRadius: 3,
                    }}>
                      <div style={{
                        position: 'absolute', inset: 0,
                        width: `${maxBucket > 0 ? (b.count / maxBucket) * 100 : 0}%`,
                        background: ({ '<1s': '#4ade80', '1\u201310s': '#60a5fa', '10\u201360s': '#fbbf24', '1\u20135m': '#fb923c', '>5m': '#f87171' } as Record<string, string>)[b.label] || color,
                        opacity: 0.35,
                        borderRadius: 3,
                        minWidth: b.count > 0 ? 3 : 0,
                      }} />
                    </div>
                    <div style={{
                      fontSize: '.76rem', color: 'var(--text)', fontWeight: 600,
                      textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                    }}>
                      {b.count > 0 ? b.count : ''}
                    </div>
                  </div>
                ))}
              </div>

              {/* Slow calls by tier */}
              {dist.slow_calls && (() => {
                const tiers: Array<{ key: keyof NonNullable<typeof dist.slow_calls>; label: string; color: string; icon: string }> = [
                  { key: 'slow_5m',  label: t('profiler.tierGt5m'),    color: '#f87171', icon: '🔴' },
                  { key: 'slow_1m',  label: t('profiler.tier1to5m'),   color: '#fb923c', icon: '🟠' },
                  { key: 'slow_10s', label: t('profiler.tier10to60s'), color: '#fbbf24', icon: '🟡' },
                ];
                return tiers.map(tier => {
                  const calls = dist.slow_calls?.[tier.key];
                  if (!calls || calls.length === 0) return null;
                  return (
                    <div key={tier.key} style={{ marginTop: '.8rem' }}>
                      <div style={{
                        fontSize: '.78rem', color: tier.color, marginBottom: '.4rem',
                        display: 'flex', alignItems: 'center', gap: '.3rem',
                      }}>
                        {tier.icon} {t('profiler.slowCallsLabel', { count: calls.length, label: tier.label })}
                      </div>
                      <div style={{
                        display: 'flex', flexDirection: 'column', gap: '.25rem',
                        ...(calls.length > 10 ? { maxHeight: 10 * 32, overflowY: 'auto' as const } : {}),
                      }}>
                        {calls.map(o => (
                          <div
                            key={o.id}
                            style={{
                              fontSize: '.76rem', cursor: 'pointer',
                              padding: '4px 8px', borderRadius: 3,
                              display: 'flex', alignItems: 'center', gap: '.5rem', flexWrap: 'wrap',
                            }}
                            onClick={() => navigate(`/timeline?session=${o.session_id}${o.turn_number > 0 ? `&turn=${o.turn_number}` : ''}`)}
                            onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface2)')}
                            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                          >
                            <span style={{ fontFamily: 'var(--font-m)', color: 'var(--text)', fontSize: '.74rem' }}>{o.session_id}</span>
                            <span style={{ color: tier.color, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmtMs(o.duration_ms)}</span>
                            {!o.success && <span style={{ color: '#ef4444', fontSize: '.7rem' }}>✕ {t('profiler.failedLabel')}</span>}
                            <span style={{ color: 'var(--muted)', fontSize: '.7rem' }}>{o.agent_name}</span>
                            {o.turn_number > 0 && <span style={{ color: 'var(--muted)', fontSize: '.7rem' }}>{t('profiler.atStep', { step: o.turn_number })}</span>}
                            <span style={{ color: tier.color, fontSize: '.7rem', marginLeft: 12 }}>{t('profiler.viewArrow')}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                });
              })()}

              {/* Error calls */}
              {dist.error_calls && dist.error_calls.length > 0 && (
                <div style={{ marginTop: '.8rem' }}>
                  <div style={{
                    fontSize: '.78rem', color: '#ef4444', marginBottom: '.4rem',
                    display: 'flex', alignItems: 'center', gap: '.3rem',
                  }}>
                    ✕ {t('profiler.errorCallsLabel', { count: dist.error_calls.length })}
                  </div>
                  <div style={{
                    display: 'flex', flexDirection: 'column', gap: '.25rem',
                    ...(dist.error_calls.length > 10 ? { maxHeight: 10 * 32, overflowY: 'auto' as const } : {}),
                  }}>
                    {dist.error_calls.map(o => (
                      <div
                        key={o.id}
                        style={{
                          fontSize: '.76rem', cursor: 'pointer',
                          padding: '4px 8px', borderRadius: 3,
                          display: 'flex', alignItems: 'center', gap: '.5rem', flexWrap: 'wrap',
                        }}
                        onClick={() => navigate(`/timeline?session=${o.session_id}${o.turn_number > 0 ? `&turn=${o.turn_number}` : ''}`)}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface2)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      >
                        <span style={{ fontFamily: 'var(--font-m)', color: 'var(--text)', fontSize: '.74rem' }}>{o.session_id}</span>
                        {o.duration_ms != null && <span style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{fmtMs(o.duration_ms)}</span>}
                        <span style={{ color: '#ef4444', fontSize: '.7rem', fontWeight: 600 }}>✕ {t('profiler.failedLabel')}</span>
                        <span style={{ color: 'var(--muted)', fontSize: '.7rem' }}>{o.agent_name}</span>
                        {o.turn_number > 0 && <span style={{ color: 'var(--muted)', fontSize: '.7rem' }}>{t('profiler.atStep', { step: o.turn_number })}</span>}
                        <span style={{ color: '#ef4444', fontSize: '.7rem', marginLeft: 12 }}>{t('profiler.viewArrow')}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div style={{ fontSize: '.72rem', color: 'var(--muted)' }}>{t('profiler.loadingEllipsis')}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════

function HotspotsView() {
  const { t } = useTranslation();
  const [sessionFilter, setSessionFilter] = useState(''); // '' = all sessions

  // Session list for picker
  const { data: sessionList } = useFetch<SessionPickerRow[]>(
    '/api/profiler/sessions?orderBy=cost'
  );

  // Tools — filtered by session if selected
  const toolsQs = sessionFilter ? `?session=${encodeURIComponent(sessionFilter)}` : '';
  const { data: tools } = useFetch<ToolRow[]>(`/api/tools${toolsQs}`, [sessionFilter]);

  // Sort tools by total time
  const sortedTools = [...(tools ?? [])].sort(
    (a, b) => (b.avg_duration_ms * b.timed_count) - (a.avg_duration_ms * a.timed_count)
  );
  const maxToolTime = sortedTools[0] ? sortedTools[0].avg_duration_ms * sortedTools[0].timed_count : 1;
  const allToolsTime = sortedTools.reduce((s, row) => s + row.avg_duration_ms * row.timed_count, 0);

  return (
    <div>
      {/* ── Session scope picker ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '1rem',
        padding: '1rem 2rem',
      }}>
        <label style={{ fontSize: 12, color: 'var(--muted)', flexShrink: 0, textTransform: 'uppercase', letterSpacing: '.04em' }}>{t('profiler.sessionLabel')}</label>
        <ProfilerSessionPicker
          sessions={sessionList ?? []}
          value={sessionFilter}
          onChange={setSessionFilter}
        />
      </div>

      {/* ── Tool Profiling Table ── */}
      <div style={{ padding: '0.5rem 2rem 2rem' }}>
        {/* Header */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '20px 100px 56px 60px 60px 60px 80px 1fr',
          gap: '.5rem',
          fontSize: '.78rem',
          color: 'var(--muted)',
          textTransform: 'uppercase',
          letterSpacing: '.04em',
          fontWeight: 600,
          padding: '0 0 .5rem',
          borderBottom: '1px solid var(--border)',
        }}>
          <div />
          <div>{t('profiler.headerTool')}</div>
          <div>{t('profiler.headerCalls')}</div>
          <div style={{ textAlign: 'right' }}>{t('profiler.headerAvg')}</div>
          <div style={{ textAlign: 'right' }}>{t('profiler.headerP50')}</div>
          <div style={{ textAlign: 'right' }}>{t('profiler.headerP95')}</div>
          <div style={{ textAlign: 'right' }}>{t('profiler.headerTotalTime')}</div>
          <div>{t('profiler.headerTimeShare')}</div>
        </div>

        {sortedTools.map((tool, i) => (
          <ToolProfileRow
            key={tool.tool_name}
            tool={tool}
            totalTime={tool.avg_duration_ms * tool.timed_count}
            maxTime={maxToolTime}
            allToolsTime={allToolsTime}
            colorIdx={i}
            sessionFilter={sessionFilter}
          />
        ))}
      </div>

    </div>
  );
}



// ═══════════════════════════════════════════════════════════════════════════════
// MAIN EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

export default function Profiler() {
  const { t } = useTranslation();

  return (
    <div>
      <PageHeader title={t('profiler.title')} subtitle={t('profiler.subtitle')} />
      <HotspotsView />
    </div>
  );
}
