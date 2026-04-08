import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useFetch, fmtCost, fmtTs, fmtPct, fmtTokens, fmt$$, tipBadge, tipBox } from '../hooks';
import type { SessionSummary, SessionsData } from '../hooks';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell,
} from 'recharts';
import { PageHeader, Loading } from '../components/ui';


interface DebugStatus {
  cacheTraceAvailable: boolean;
}


interface ContextTurn {
  seq: number;
  ts: string;
  system_tokens: number;
  history_tokens: number;
  tool_result_tokens: number;
  total_used: number;
  total_capacity: number;
  fill_pct: number;
  input_tokens:       number | null;
  output_tokens:      number | null;
  cache_read_tokens:  number | null;
  cache_write_tokens: number | null;
  cost_input:       number | null;
  cost_output:      number | null;
  cost_cache_read:  number | null;
  cost_cache_write: number | null;
  cost: number | null;
}

interface ContextData {
  available: boolean;
  turns: ContextTurn[];
}


const COMPOSITION_LAYERS: { key: string; color: string; labelKey: string; descKey: string }[] = [
  { key: 'System',    color: '#2563EB', labelKey: 'debugContext.systemLayer',  descKey: 'debugContext.systemDesc' },
  { key: 'History',   color: '#0891B2', labelKey: 'debugContext.historyLayer', descKey: 'debugContext.historyDesc' },
  { key: 'Tools',     color: '#D97706', labelKey: 'debugContext.toolsLayer',   descKey: 'debugContext.toolsDesc' },
];

function CustomCostTooltip({ active, payload, label, maxCost, costFormatter }: {
  active?: boolean; payload?: any[]; label?: string; maxCost: number;
  costFormatter: (v: number) => string;
}) {
  const { t } = useTranslation();
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload ?? {};
  const cost = (payload[0]?.value as number) ?? 0;
  const isSpike = maxCost > 0 && cost >= maxCost * 0.8;
  const isMid   = maxCost > 0 && cost >= maxCost * 0.5;

  const ROWS: { label: string; color: string; tok: number | null }[] = [
    { label: t('debugContext.tooltipInput'),       color: '#2563EB', tok: d.input_tokens ?? null },
    { label: t('debugContext.tooltipOutput'),      color: '#A78BFA', tok: d.output_tokens ?? null },
    { label: t('debugContext.tooltipCacheWrite'), color: '#0891B2', tok: d.cache_write_tokens ?? null },
    { label: t('debugContext.tooltipCacheRead'),  color: '#10B981', tok: d.cache_read_tokens  ?? null },
  ];

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-sm)', padding: '8px 12px', fontSize: 11,
      boxShadow: '0 4px 16px rgba(0,0,0,.3)', zIndex: 9999, position: 'relative',
    }}>
      <div style={{ color: 'var(--muted)', marginBottom: 6, fontWeight: 600 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <div style={{ width: 8, height: 8, borderRadius: 2, background: isSpike ? '#EF4444' : isMid ? '#D97706' : '#2563EB', flexShrink: 0 }} />
        <span style={{ color: 'var(--muted)', minWidth: 68 }}>{t('debugContext.totalCost')}</span>
        <span style={{ color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{costFormatter(cost)}</span>
      </div>
      {ROWS.map(({ label: rl, color, tok }) => tok != null && (
        <div key={rl} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
          <div style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
          <span style={{ color: 'var(--muted)', minWidth: 68 }}>{rl}</span>
          <span style={{ color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{fmtTokens(tok)} {t('debugContext.token')}</span>
        </div>
      ))}
    </div>
  );
}

function CustomCompositionTooltip({ active, payload, label }: { active?: boolean; payload?: any[]; label?: string }) {
  const { t } = useTranslation();
  if (!active || !payload?.length) return null;
  const layers = ['System', 'History', 'Tools'];
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-sm)', padding: '8px 12px', fontSize: 11,
      boxShadow: '0 4px 16px rgba(0,0,0,.3)',
    }}>
      <div style={{ color: 'var(--muted)', marginBottom: 6, fontWeight: 600 }}>{label}</div>
      {payload.filter(p => layers.includes(p.dataKey)).map(p => {
        const layer = COMPOSITION_LAYERS.find(l => l.key === p.dataKey);
        return (
          <div key={p.dataKey} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: layer?.color, flexShrink: 0 }} />
            <span style={{ color: 'var(--muted)', minWidth: 44 }}>{layer ? t(layer.labelKey) : p.dataKey}</span>
            <span style={{ color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
              {fmtTokens(p.value as number)} {t('debugContext.token')}
            </span>
          </div>
        );
      })}
    </div>
  );
}


/* ── SessionPicker ── */
function SessionPicker({
  sessions,
  value,
  onChange,
}: {
  sessions: SessionSummary[];
  value: string;
  onChange: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [open, setOpen]   = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef  = useRef<HTMLDivElement>(null);

  const selected = sessions.find(s => s.id === value) ?? null;

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
    ? sessions.filter(s => s.id.includes(q) || s.model.toLowerCase().includes(q) || s.agent_name.toLowerCase().includes(q))
    : sessions;

  function handleInput(e: React.ChangeEvent<HTMLInputElement>) {
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
  const BORDER_NORMAL  = '1px solid var(--border)';

  return (
    <div ref={rootRef} style={{ position: 'relative', maxWidth: 680 }}>
      {/* trigger / input row */}
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
        {/* search icon */}
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, opacity: 0.4 }}>
          <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.5"/>
          <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>

        {/* selected chip */}
        {selected && !open ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <span style={{ fontFamily: 'var(--font-m)', fontSize: 11, color: 'var(--text)', flexShrink: 0 }}>
              {selected.id}
            </span>
            {selected.agent_name && <span style={{ fontSize: 11, color: 'var(--C-blue)', flexShrink: 0 }}>{selected.agent_name}</span>}
            <span style={{ fontSize: 11, color: 'var(--C-purple, #a78bfa)', flexShrink: 0 }}>{selected.model}</span>
            {selected.total_cost > 0 && (
              <span style={{ fontSize: 11, color: 'var(--C-green)', flexShrink: 0 }}>{fmtCost(selected.total_cost)}</span>
            )}
            <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>{fmtTs(selected.max_ts)}</span>
          </div>
        ) : (
          <input
            ref={inputRef}
            value={query}
            onChange={handleInput}
            onFocus={() => setOpen(true)}
            placeholder={selected ? selected.id : t('debugContext.searchPlaceholder')}
            style={{
              flex: 1, background: 'none', border: 'none', outline: 'none',
              fontSize: 12, color: 'var(--text)',
              fontFamily: 'var(--font-m)',
              minWidth: 0,
            }}
            onClick={e => e.stopPropagation()}
          />
        )}

        {/* clear × */}
        {selected && (
          <button onClick={clear} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--muted)', fontSize: 15, lineHeight: 1,
            padding: '0 2px', flexShrink: 0,
          }}>×</button>
        )}

        {/* chevron */}
        <svg
          width="10" height="10" viewBox="0 0 10 10" fill="none"
          style={{ flexShrink: 0, opacity: 0.4, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}
        >
          <path d="M1 3l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>

      {/* dropdown panel */}
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
          {filtered.length === 0 ? (
            <div style={{ padding: '14px', color: 'var(--muted)', fontSize: 12 }}>{t('debugContext.noMatch')}</div>
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
                      <span style={{ marginLeft: 6, fontSize: 9, color: 'var(--C-blue)', background: 'rgba(59,130,246,.15)', padding: '1px 5px', borderRadius: 3 }}>{t('debugContext.selected')}</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 14, fontSize: 11 }}>
                    {s.agent_name && <span style={{ color: 'var(--C-blue)', fontWeight: 500 }}>{s.agent_name}</span>}
                    <span style={{ color: 'var(--C-purple, #a78bfa)' }}>{s.model}</span>
                    {s.total_cost > 0 && <span style={{ color: 'var(--C-green)' }}>{fmtCost(s.total_cost)}</span>}
                    <span style={{ color: 'var(--muted)' }}>{fmtTs(s.max_ts)}</span>
                    <span style={{ color: 'var(--muted)' }}>{s.entry_count} {t('debugContext.steps')}</span>
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

export default function DebugContext() {
  const { t } = useTranslation();
  const { data: status } = useFetch<DebugStatus>('/api/debug/status');
  const { data: sessionsData } = useFetch<SessionsData>('/api/debug/sessions');
  const [selectedSession, setSelectedSession] = useState('');

  const contextUrl = selectedSession ? `/api/debug/session/${selectedSession}/context-window` : '';
  const { data: contextData, loading } = useFetch<ContextData>(contextUrl, [selectedSession]);

  const available = status?.cacheTraceAvailable ?? false;
  const sessions = sessionsData?.sessions ?? [];

  const chartData = (contextData?.turns ?? []).map(turn => ({
    name: `S${turn.seq}`,
    System: turn.system_tokens,
    History: turn.history_tokens,
    Tools: turn.tool_result_tokens,
    Available: Math.max(0, turn.total_capacity - turn.total_used),
    fill_pct: turn.fill_pct,
    high: turn.fill_pct > 0.8,
    cost: turn.cost,
    total_used: turn.total_used,
    input_tokens:       turn.input_tokens,
    output_tokens:      turn.output_tokens,
    cache_read_tokens:  turn.cache_read_tokens,
    cache_write_tokens: turn.cache_write_tokens,
    cost_input:       turn.cost_input,
    cost_output:      turn.cost_output,
    cost_cache_read:  turn.cost_cache_read,
    cost_cache_write: turn.cost_cache_write,
  }));

  const hasCost = chartData.some(d => d.cost != null);
  const maxCost = hasCost ? Math.max(...chartData.map(d => d.cost ?? 0)) : 0;
  const costFormatter = (v: number) => v >= 0.001 ? fmt$$(v) : `$${v.toFixed(6)}`;
  const ctxCapacity = contextData?.turns[0]?.total_capacity ?? 200_000;
  const ctxCapacityLabel = ctxCapacity >= 1_000_000 ? `${ctxCapacity / 1_000_000}M` : `${Math.round(ctxCapacity / 1000)}K`;

  return (
    <div>
      <PageHeader title={t('debugContext.title')} subtitle={t('debugContext.subtitle')}>
        <div style={{ flex: '0 0 100%', fontSize: 12, color: 'var(--muted)', lineHeight: 1.7, marginTop: 6 }}>
          {t('debugContext.cacheTraceNote')}
          <span style={{ position: 'relative', display: 'inline-block' }} className="ctx-howto-wrap">
            <span style={{
              color: 'var(--C-blue)', cursor: 'help',
              borderBottom: '1px dashed var(--C-blue)', paddingBottom: 1,
            }}>
              {t('debugContext.howToEnable')}
            </span>
            <span className="ctx-howto-box" style={{
              display: 'none', position: 'absolute', left: 0, top: '100%', marginTop: 8,
              background: '#1a1a1a', border: '1px solid #333', borderRadius: 8,
              padding: '14px 16px', zIndex: 200, width: 340,
              fontSize: 11, lineHeight: 1.7, color: 'var(--text)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
              whiteSpace: 'normal' as const, textAlign: 'left' as const,
            }}>
              <div style={{ fontWeight: 600, marginBottom: 10 }}>{t('debugContext.twoWaysToEnable')}</div>

              <div style={{ marginBottom: 12 }}>
                <div style={{ color: 'var(--muted)', marginBottom: 4 }}>
                  {t('debugContext.addToConfig')} <code style={{ fontFamily: 'var(--font-m)' }}>~/.openclaw/openclaw.json</code>
                </div>
                <code style={{
                  display: 'block', padding: '6px 8px',
                  background: 'rgba(255,255,255,0.06)', borderRadius: 4,
                  color: '#F59E0B', fontFamily: 'var(--font-m)',
                  whiteSpace: 'pre' as const,
                }}>
{`"diagnostics": {
  "cacheTrace": {
    "enabled": true,
    "includeMessages": true,
    "includePrompt": true,
    "includeSystem": true
  }
}`}
                </code>
              </div>

              <div style={{ marginBottom: 12 }}>
                <div style={{ color: 'var(--muted)', marginBottom: 4 }}>
                  {t('debugContext.letOpenClawEnable')}
                </div>
                <code style={{
                  display: 'block', padding: '6px 8px',
                  background: 'rgba(255,255,255,0.06)', borderRadius: 4,
                  color: 'var(--C-blue)', fontFamily: 'var(--font-m)',
                }}>
                  OPENCLAW_CACHE_TRACE
                </code>
                <div style={{ color: 'var(--muted)', fontSize: 10, marginTop: 4 }}>
                  {t('debugContext.copyFlag')}
                </div>
              </div>

              <div style={{
                color: '#EF4444', borderTop: '1px solid rgba(239,68,68,0.25)',
                paddingTop: 10, fontSize: 11,
              }}>
                {t('debugContext.fileGrowsWarning')}
              </div>
            </span>
            <style>{`.ctx-howto-wrap:hover .ctx-howto-box { display: block !important; }`}</style>
          </span>
        </div>
      </PageHeader>

      <div style={{ padding: '0 var(--space-5)', marginBottom: 'var(--space-5)' }}>

        {/* Status dot — extra top margin */}
        <div style={{
          fontSize: 12, color: 'var(--muted)',
          display: 'flex', alignItems: 'center', gap: 6,
          marginBottom: 'var(--space-4)', marginTop: 'var(--space-5)',
        }}>
          <span style={{
            display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
            background: available ? '#10B981' : '#6B7280', flexShrink: 0,
          }} />
          {available ? t('debugContext.cacheTraceEnabled') : t('debugContext.cacheTraceNotFound')}
        </div>

        {available && (
          <div>
            <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.08em' }}>
              {t('debugContext.session')}
            </label>
            <SessionPicker
              sessions={sessions}
              value={selectedSession}
              onChange={setSelectedSession}
            />
          </div>
        )}
      </div>

      {(loading && selectedSession || contextData?.available && contextData.turns.length > 0) && (
      <div className="gc" style={{ margin: '0 var(--space-5)' }}>
        {loading && selectedSession && <Loading />}

        {contextData?.available && contextData.turns.length > 0 && (
          <>
            {hasCost && (
              <div style={{ marginBottom: 'var(--space-6)' }}>
                <div style={{ fontSize: 12, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 'var(--space-2)' }}>
                  {t('debugContext.perStepCost')}
                </div>
                <div style={{ height: 180 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} barCategoryGap="30%">
                      <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'var(--muted)' }} />
                      <YAxis tick={{ fontSize: 10, fill: 'var(--muted)' }} tickFormatter={costFormatter} width={64} />
                      <Tooltip
                        cursor={false}
                        position={{ y: -40 }}
                        allowEscapeViewBox={{ x: false, y: true }}
                        content={<CustomCostTooltip maxCost={maxCost} costFormatter={costFormatter} />}
                      />
                      <Bar dataKey="cost" name="Cost" radius={[2, 2, 0, 0]} isAnimationActive={false}>
                        {chartData.map((d, i) => (
                          <Cell
                            key={i}
                            fill={maxCost > 0 && (d.cost ?? 0) >= maxCost * 0.8 ? '#EF4444' : maxCost > 0 && (d.cost ?? 0) >= maxCost * 0.5 ? '#D97706' : '#2563EB'}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            <div style={{ marginBottom: 'var(--space-2)' }}>
              <div style={{ fontSize: 12, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 10 }}>
                {t('debugContext.contextComposition')}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 14 }}>
                {COMPOSITION_LAYERS.map(({ key, color, labelKey, descKey }) => (
                  <div key={key} style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <div style={{ width: 9, height: 9, borderRadius: 2, background: color, flexShrink: 0, marginTop: 1, border: key === 'Available' ? '1px solid var(--border)' : 'none' }} />
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)', minWidth: 48 }}>{t(labelKey)}</span>
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>{t(descKey)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ height: 280, marginBottom: 'var(--space-6)' }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} stackOffset="none">
                  <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'var(--muted)' }} />
                  <YAxis tick={{ fontSize: 10, fill: 'var(--muted)' }} tickFormatter={(v: number) => fmtTokens(v)} />
                  <Tooltip cursor={false} position={{ y: 0 }} allowEscapeViewBox={{ x: false, y: true }} content={<CustomCompositionTooltip />} />
                  <Bar dataKey="System" stackId="a" fill="#2563EB" isAnimationActive={false} />
                  <Bar dataKey="History" stackId="a" fill="#0891B2" isAnimationActive={false} />
                  <Bar dataKey="Tools" stackId="a" fill="#D97706" radius={[2, 2, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="tbl">
              <table>
                <thead>
                  <tr>
                    <th>{t('debugContext.step')}</th>
                    <th style={{ position: 'relative' }}>
                      <span className="ctx-tip-system" style={{ cursor: 'help' }}>
                        {t('debugContext.systemLayer')}<span style={tipBadge}>?</span>
                        <span className="ctx-tip-system-box" style={{ ...tipBox, width: 260 }}>
                          {t('debugContext.systemTooltip')}
                        </span>
                      </span>
                      <style>{`.ctx-tip-system:hover .ctx-tip-system-box { display: block !important; }`}</style>
                    </th>
                    <th style={{ position: 'relative' }}>
                      <span className="ctx-tip-history" style={{ cursor: 'help' }}>
                        {t('debugContext.historyLayer')}<span style={tipBadge}>?</span>
                        <span className="ctx-tip-history-box" style={{ ...tipBox, width: 280 }}>
                          {t('debugContext.historyTooltip')}
                        </span>
                      </span>
                      <style>{`.ctx-tip-history:hover .ctx-tip-history-box { display: block !important; }`}</style>
                    </th>
                    <th style={{ position: 'relative' }}>
                      <span className="ctx-tip-tools" style={{ cursor: 'help' }}>
                        {t('debugContext.toolsLayer')}<span style={tipBadge}>?</span>
                        <span className="ctx-tip-tools-box" style={{ ...tipBox, width: 280 }}>
                          {t('debugContext.toolsTooltip')}
                        </span>
                      </span>
                      <style>{`.ctx-tip-tools:hover .ctx-tip-tools-box { display: block !important; }`}</style>
                    </th>
                    <th style={{ position: 'relative' }}>
                      <span className="ctx-tip-total" style={{ cursor: 'help' }}>
                        {t('debugContext.totalTokenUsed')}<span style={tipBadge}>?</span>
                        <span className="ctx-tip-total-box" style={{ ...tipBox, width: 300 }}>
                          {t('debugContext.totalTokenTooltip')}
                        </span>
                      </span>
                      <style>{`.ctx-tip-total:hover .ctx-tip-total-box { display: block !important; }`}</style>
                    </th>
                    <th style={{ position: 'relative' }}>
                      <span className="ctx-tip-pressure" style={{ cursor: 'help' }}>
                        {t('debugContext.contextPressure')}<span style={tipBadge}>?</span>
                        <span className="ctx-tip-pressure-box" style={{ ...tipBox, width: 280 }}>
                          {t('debugContext.pressureTooltipPrefix', { capacity: ctxCapacityLabel, capacityNum: ctxCapacity.toLocaleString() })}
                          <span style={{ color: '#22c55e' }}>{t('debugContext.pressureHealthy')}</span>{`: ${t('debugContext.pressureHealthyRange')}\n`}
                          <span style={{ color: '#eab308' }}>{t('debugContext.pressureWarning')}</span>{`: ${t('debugContext.pressureWarningRange')}\n`}
                          <span style={{ color: '#ef4444' }}>{t('debugContext.pressureCritical')}</span>{`: ${t('debugContext.pressureCriticalRange')}`}
                        </span>
                      </span>
                      <style>{`.ctx-tip-pressure:hover .ctx-tip-pressure-box { display: block !important; }`}</style>
                    </th>
                    {hasCost && <th>{t('debugContext.costColumn')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {contextData.turns.map(turn => (
                    <tr
                      key={turn.seq}
                      style={turn.fill_pct > 0.8 ? { background: 'rgba(220,38,38,0.08)', color: 'var(--C-rose)' } : {}}
                    >
                      <td>{t('debugContext.stepPrefix', { seq: turn.seq })}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtTokens(turn.system_tokens)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtTokens(turn.history_tokens)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtTokens(turn.tool_result_tokens)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtTokens(turn.total_used)}</td>
                      <td style={{ color: turn.fill_pct > 0.8 ? 'var(--C-rose)' : turn.fill_pct > 0.6 ? 'var(--C-amber)' : 'var(--C-green)', fontVariantNumeric: 'tabular-nums' }}>
                        {fmtPct(turn.fill_pct, 1)}
                      </td>
                      {hasCost && (
                        <td style={{ fontVariantNumeric: 'tabular-nums', color: turn.cost != null && turn.cost >= maxCost * 0.8 ? 'var(--C-rose)' : 'var(--text)' }}>
                          {turn.cost != null ? costFormatter(turn.cost) : '—'}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      )}
    </div>
  );
}
