import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useFetch, fmtCost, fmtTs } from '../hooks';
import { PageHeader, InfoTooltip as Tooltip, Dropdown, Loading, AlertBanner } from '../components/ui';

// ── Types ─────────────────────────────────────────────────────────────────────

interface DeepTurnSummary {
  total: number;
  error_count: number;
  warn_count: number;
  max_depth: number;
  total_cost: number;
  avg_unique_ratio: number;
}

interface AgentRow {
  agent_name: string;
  count: number;
  max_depth: number;
  total_cost: number;
  error_count: number;
}

interface DeepTurn {
  session_id: string;
  agent_name: string;
  started_at: number;
  loop_depth: number;
  cost: number;
  tool_sequence: string[];
  turn_seq: number;
  unique_ratio: number;
}

interface DeepTurnsData {
  thresholds: { warn: number; error: number };
  summary: DeepTurnSummary;
  by_agent: AgentRow[];
  turns: DeepTurn[];
}

// ── Design tokens ─────────────────────────────────────────────────────────────

const DEPTH_COLORS = {
  warn:   { bg: 'rgba(59,130,246,.14)',  text: '#60A5FA', border: 'rgba(59,130,246,.3)',  bar: '#3B82F6' },  // blue
  error:  { bg: 'rgba(245,158,11,.14)',  text: '#FBBF24', border: 'rgba(245,158,11,.3)',  bar: '#F59E0B' },  // amber
  severe: { bg: 'rgba(239,68,68,.14)',   text: '#F87171', border: 'rgba(239,68,68,.3)',   bar: '#EF4444' },  // red
};

const TIME_PRESET_KEYS: Array<{ labelKey: string; value: string; ms: number }> = [
  { labelKey: 'deepTurns.today',       value: 'today', ms: 0 },
  { labelKey: 'deepTurns.last7Days',   value: '7d',    ms: 7 * 86400000 },
  { labelKey: 'deepTurns.last30Days',  value: '30d',   ms: 30 * 86400000 },
  { labelKey: 'deepTurns.allTimeLabel',value: 'all',   ms: 0 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────


function UniqueRatioPill({ ratio }: { ratio: number }) {
  const pct = Math.round(ratio * 100);
  const color = pct <= 20 ? '#F87171' : pct <= 40 ? '#FBBF24' : 'var(--muted)';
  return (
    <span style={{
      fontSize: 11, fontVariantNumeric: 'tabular-nums', fontWeight: pct <= 40 ? 600 : 400,
      color,
    }}>
      {pct}%
    </span>
  );
}

function ToolPill({ name }: { name: string }) {
  return (
    <span style={{
      display: 'inline-block', fontSize: 10, padding: '1px 6px',
      borderRadius: 4,
      background: 'var(--surface2)',
      color: 'var(--muted)',
      fontFamily: 'var(--font-m)',
      border: '1px solid transparent',
    }}>
      {name}
    </span>
  );
}

function summariseSequence(seq: string[]): React.ReactNode {
  if (seq.length === 0) return <span style={{ color: 'var(--muted)', fontSize: 11 }}>—</span>;
  const runs: Array<{ tool: string; count: number }> = [];
  for (const item of seq) {
    if (runs.length && runs[runs.length - 1].tool === item) {
      runs[runs.length - 1].count++;
    } else {
      runs.push({ tool: item, count: 1 });
    }
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
      {runs.map((r, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <ToolPill name={r.tool} />
          {r.count > 1 && (
            <span style={{ fontSize: 10, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
              ×{r.count}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

function depthColor(depth: number, thresholds: { warn: number; error: number }) {
  if (depth >= 30) return DEPTH_COLORS.severe;
  if (depth >= thresholds.error) return DEPTH_COLORS.error;
  return DEPTH_COLORS.warn;
}

function timeRangeFrom(preset: string): number {
  if (preset === 'all') return 0;
  if (preset === 'today') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  const p = TIME_PRESET_KEYS.find(tp => tp.value === preset);
  return p ? Date.now() - p.ms : 0;
}

const SECTION_TITLE: React.CSSProperties = {
  fontSize: 13, fontWeight: 600, color: 'var(--muted)',
  textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 12,
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function AgentLoops() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [agent, setAgent] = useState('all');
  const [timeRange, setTimeRange] = useState('all');
  const [sortBy, setSortBy] = useState<'depth' | 'unique_ratio' | 'cost'>('depth');

  // Backend accepts ?agent= and ?from= so filtering happens in SQL. Previously the
  // frontend re-filtered a truncated top-100 list, which produced wrong totals when
  // the real dataset was larger than 100 loopy turns.
  // Memoize the URL so Date.now() is only evaluated when filters actually change,
  // preventing infinite re-fetch loops that cause flickering.
  const loopsUrl = useMemo(() => {
    const fromTs = timeRangeFrom(timeRange);
    const qs = new URLSearchParams();
    if (agent !== 'all') qs.set('agent', agent);
    if (fromTs > 0)      qs.set('from', String(fromTs));
    return `/api/profiler/loops${qs.toString() ? '?' + qs.toString() : ''}`;
  }, [agent, timeRange]);
  const { data, error } = useFetch<DeepTurnsData>(loopsUrl, [loopsUrl]);

  // Agent dropdown list must NOT shrink when the user picks an agent. Fetch the
  // full agent roster from /api/stats, which always returns every known agent.
  const { data: statsData } = useFetch<{ agents: string[] }>('/api/stats');
  const agentOptions = useMemo(() => {
    const names = statsData?.agents ?? [];
    return [
      { label: t('deepTurns.allAgents'), value: 'all' },
      ...names.map(n => ({ label: n, value: n })),
    ];
  }, [statsData, t]);

  if (error && !data) return <div style={{ padding: 'var(--space-5)' }}><AlertBanner variant="error">{error}</AlertBanner></div>;
  if (!data) return <Loading />;

  const { turns: allTurns, thresholds, summary: backendSummary } = data;

  // The backend already filtered by agent/time, so `allTurns` is the authoritative
  // filtered set (top 100 by depth). No further filtering here.
  const filtered = allTurns;

  // Apply sort (display-only; doesn't affect counts)
  const sorted = [...filtered].sort((a, b) =>
    sortBy === 'depth'
      ? b.loop_depth - a.loop_depth
      : sortBy === 'cost'
        ? b.cost - a.cost
        : a.unique_ratio - b.unique_ratio
  );

  // Use the backend's full-set summary directly. It reflects the real total across
  // ALL loopy turns matching the filter (not just the top 100 returned in `turns`).
  const fSummary = {
    total:            backendSummary.total,
    error_count:      backendSummary.error_count,
    max_depth:        backendSummary.max_depth,
    total_cost:       backendSummary.total_cost,
    avg_unique_ratio: backendSummary.avg_unique_ratio,
  };

  // Depth histogram: ideally computed from the full set, but the backend only returns
  // counts aggregated over all loop types. The top-100 sample is representative for the
  // shape of the distribution; label the chart as "top 100" when truncation is active.
  const depthBuckets = [
    { label: `${thresholds.warn}–${thresholds.error - 1}`, min: thresholds.warn,  max: thresholds.error - 1, color: '#3B82F6' },
    { label: `${thresholds.error}–29`,                     min: thresholds.error, max: 29,                   color: '#F59E0B' },
    { label: '30+',                                         min: 30,              max: Infinity,              color: '#EF4444' },
  ];
  const bucketed = depthBuckets.map(b => ({
    ...b,
    count: filtered.filter(dt => dt.loop_depth >= b.min && dt.loop_depth <= b.max).length,
  }));
  const maxBucket = Math.max(...bucketed.map(b => b.count), 1);

  const isFiltered = agent !== 'all' || timeRange !== 'all';

  return (
    <div>
      <PageHeader
        title={t('deepTurns.title')}
        subtitle={
          <>
            {t('deepTurns.flagsDesc')} {thresholds.warn} {t('deepTurns.callsToFinish')}{' '}
            <Tooltip label={<span style={{ borderBottom: '1px dashed var(--muted)', paddingBottom: 1 }}>{t('deepTurns.howItWorks')}</span>} width={420}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

                <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.55 }}>
                  {t('deepTurns.deepTurnExplain', { threshold: thresholds.warn })}
                  {' '}{t('deepTurns.depthColorCoded')}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {[
                    { label: `${thresholds.warn}–${thresholds.error - 1} ${t('deepTurns.calls')}`, color: DEPTH_COLORS.warn },
                    { label: `${thresholds.error}–29 ${t('deepTurns.calls')}`, color: DEPTH_COLORS.error },
                    { label: `30+ ${t('deepTurns.calls')}`, color: DEPTH_COLORS.severe },
                  ].map(d => (
                    <div key={d.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: d.color.bar, flexShrink: 0 }} />
                      <span style={{ fontSize: 11, color: d.color.text }}>{d.label}</span>
                    </div>
                  ))}
                </div>

                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>{t('deepTurns.uniqueRatioTitle')}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5, marginTop: 5 }}>
                    {t('deepTurns.uniqueRatioExplain')}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5, marginTop: 6, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
                    {t('deepTurns.normalizedExplain')}
                  </div>
                </div>

              </div>
            </Tooltip>
          </>
        }
      />

      {/* ── Filters ── */}
      <div style={{ padding: '0 2rem', marginTop: '0.75rem', display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
        <Dropdown value={agent} onChange={setAgent} options={agentOptions} />
        <Dropdown
          value={timeRange}
          onChange={setTimeRange}
          options={TIME_PRESET_KEYS.map(tp => ({ label: t(tp.labelKey), value: tp.value }))}
        />
        <Dropdown
          value={sortBy}
          onChange={v => setSortBy(v as 'depth' | 'unique_ratio' | 'cost')}
          options={[
            { label: t('deepTurns.sortByDepth'), value: 'depth' },
            { label: t('deepTurns.sortByUniqueRatio'), value: 'unique_ratio' },
            { label: t('deepTurns.sortByCost'), value: 'cost' },
          ]}
        />
      </div>

      {/* ── Summary KPIs ── */}
      <div style={{ padding: '0 2rem 1.5rem', marginTop: '1.25rem' }}>
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', justifyContent: 'space-between' }}>
          {[
            { label: t('deepTurns.deepTurnsCount'),        value: String(fSummary.total),       color: fSummary.total > 0 ? '#818CF8' : 'var(--C-green)' },
            { label: `≥${thresholds.error} ${t('deepTurns.calls')}`, value: String(fSummary.error_count), color: fSummary.error_count > 0 ? '#A78BFA' : 'var(--muted)' },
            { label: t('deepTurns.avgUniqueRatio'),   value: fSummary.total > 0 ? `${Math.round(fSummary.avg_unique_ratio * 100)}%` : '—', color: fSummary.avg_unique_ratio <= 0.3 ? '#FBBF24' : 'var(--text)' },
            { label: t('deepTurns.maxDepth'),          value: fSummary.max_depth > 0 ? `${fSummary.max_depth} ${t('deepTurns.calls')}` : '—', color: 'var(--text)' },
            { label: t('deepTurns.costOnDeep'), value: fSummary.total_cost > 0 ? fmtCost(fSummary.total_cost) : '—', color: '#14B8A6' },
          ].map(k => (
            <div key={k.label} style={{
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', padding: '12px 18px', flex: 1, minWidth: 0,
            }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>{k.label}</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: k.color, fontVariantNumeric: 'tabular-nums' }}>{k.value}</div>
            </div>
          ))}
        </div>

        {fSummary.total === 0 && (
          <div style={{
            border: '1px solid var(--border)', borderRadius: 'var(--radius)',
            padding: '2rem', textAlign: 'center', color: 'var(--muted)', fontSize: 13,
          }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>✓</div>
            {isFiltered
              ? t('deepTurns.noDeepTurns')
              : t('deepTurns.noDeepTurnsAll', { threshold: thresholds.warn })}
          </div>
        )}
      </div>

      {fSummary.total > 0 && (
        <>
          {/* ── Depth distribution ── */}
          <div style={{ padding: '0 2rem 1.5rem', maxWidth: 480 }}>
            <div style={SECTION_TITLE}>{t('deepTurns.depthDistribution')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {bucketed.map(b => (
                <div key={b.label} style={{ display: 'grid', gridTemplateColumns: '64px 1fr 28px', alignItems: 'center', gap: 8 }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {b.label}
                  </div>
                  <div style={{ height: 14, background: 'var(--surface2)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', borderRadius: 3,
                      width: `${(b.count / maxBucket) * 100}%`,
                      background: b.color,
                      minWidth: b.count > 0 ? 3 : 0,
                      transition: 'width .3s',
                    }} />
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
                    {b.count}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Deep Turns Table ── */}
          <div style={{ padding: '0 2rem 2rem' }}>
            <div style={SECTION_TITLE}>
              {t('deepTurns.deepTurnsTable')}
              {sortBy === 'unique_ratio' ? ` — ${t('deepTurns.sortedByUniqueRatio')}` : sortBy === 'cost' ? ` — ${t('deepTurns.sortedByCost')}` : ` — ${t('deepTurns.sortedByDepth')}`}
            </div>
            <div className="tbl">
              <table>
                <thead>
                  <tr>
                    <th>{t('deepTurns.thDepth')}</th>
                    <th>{t('deepTurns.thUniqueRatio')}</th>
                    <th>{t('deepTurns.thAgent')}</th>
                    <th>{t('deepTurns.thSession')}</th>
                    <th>{t('deepTurns.thTime')}</th>
                    <th>{t('deepTurns.thCost')}</th>
                    <th>{t('deepTurns.thToolSequence')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((dt, i) => {
                    const dc = depthColor(dt.loop_depth, thresholds);
                    return (
                      <tr
                        key={i}
                        style={{ cursor: 'pointer', borderLeft: `3px solid ${dc.bar}` }}
                        onClick={() => navigate(`/timeline?session=${dt.session_id}&turn=${dt.turn_seq}`)}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--surface2)'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = ''; }}
                      >
                        <td>
                          <span style={{
                            fontVariantNumeric: 'tabular-nums', fontWeight: 700,
                            color: dc.text, fontSize: 14,
                          }}>
                            {dt.loop_depth}
                          </span>
                          <span style={{ color: 'var(--muted)', fontSize: 11, marginLeft: 3 }}>{t('deepTurns.calls')}</span>
                        </td>
                        <td><UniqueRatioPill ratio={dt.unique_ratio} /></td>
                        <td style={{ fontFamily: 'var(--font-m)', fontSize: 12 }}>{dt.agent_name}</td>
                        <td>
                          <span style={{ fontFamily: 'var(--font-m)', fontSize: 11, color: 'var(--muted)' }}>
                            {dt.session_id.slice(0, 8)}…
                          </span>
                        </td>
                        <td style={{ color: 'var(--muted)', fontSize: 12, whiteSpace: 'nowrap' }}>{fmtTs(dt.started_at)}</td>
                        <td style={{ color: '#14B8A6', fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>
                          {fmtCost(dt.cost)}
                        </td>
                        <td style={{ maxWidth: 320 }}>
                          {summariseSequence(dt.tool_sequence)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
