import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell,
} from 'recharts';
import { useFetch, fmtCost, fmtTokens, fmtPct, TABLE_STYLE, TH_STYLE, TD_STYLE, MONO_STYLE } from '../hooks';
import {
  PageHeader, SectionLabel, Loading, EmptyState, Card, Dropdown, DateNavigator, AlertBanner, InfoTooltip,
} from '../components/ui';

// ── Types ──

interface TokenSummary {
  totals: {
    input: number; output: number; cacheRead: number; cacheWrite: number;
    total: number; cost: number; cacheHitRate: number;
    sessionCount: number; avgCostPerSession: number;
  };
  byDay: {
    date: string; input: number; output: number;
    cacheRead: number; cacheWrite: number; cost: number;
  }[];
  byModel: {
    model: string; provider: string; input: number; output: number;
    cacheRead: number; cacheWrite: number; total: number;
    cost: number; messages: number;
  }[];
  byAgent: {
    agent: string; input: number; output: number;
    cacheRead: number; cacheWrite: number; total: number;
    cost: number; sessions: number;
  }[];
  cronVsManual: {
    cron: { tokens: number; cost: number; sessions: number };
    manual: { tokens: number; cost: number; sessions: number };
  };
}

// ── Chart colors ──
const CHART_BLUE   = '#60a5fa';
const CHART_GREEN  = '#34d399';
const CHART_ORANGE = '#fb923c';
const CHART_PURPLE = '#c084fc';
const PIE_COLORS   = [CHART_BLUE, CHART_GREEN, CHART_ORANGE, CHART_PURPLE, '#fbbf24', '#22d3ee', '#f472b6', '#a3e635'];

/** Dashed empty donut when there's no data */
function EmptyPie() {
  const { t } = useTranslation();
  return (
    <svg width="100%" height={180} viewBox="0 0 180 180">
      <circle cx={90} cy={90} r={55} fill="none" stroke="#333" strokeWidth={30}
        strokeDasharray="6 4" opacity={0.5} />
      <text x={90} y={94} textAnchor="middle" fill="#555" fontSize={12}>{t('tokenUsage.noData')}</text>
    </svg>
  );
}

// ── Helpers ──

function hitRateColor(rate: number): string {
  if (rate >= 0.8) return 'var(--C-green)';
  if (rate >= 0.5) return 'var(--C-amber)';
  return 'var(--C-rose)';
}


// ── Styles ──

const tableStyle = TABLE_STYLE;
const thStyle = TH_STYLE;
const thRight: React.CSSProperties = { ...TH_STYLE, textAlign: 'right' };
const tdStyle = TD_STYLE;
const tdRight: React.CSSProperties = { ...TD_STYLE, textAlign: 'right' };
const monoStyle = MONO_STYLE;

const tooltipContentStyle: React.CSSProperties = {
  background: '#1a1a1a',
  border: 'none',
  borderRadius: 8,
  fontSize: 13,
  color: '#ededed',
  fontFamily: 'var(--font-b)',
  boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
  outline: 'none',
  padding: '12px 16px',
  minWidth: 200,
};

// ── Component ──

// ── Token Trend (independent component with own data) ──
interface TrendData {
  data: { bucket: string; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }[];
  agents: string[];
  granularity: string;
  days: number;
}

const EMPTY_BUCKET = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_ZH = ['日','一','二','三','四','五','六'];

/** Format X axis label to be human readable */
function fmtBucketLabel(v: string, gran: 'hour' | 'day' | 'week', lang = 'en'): string {
  if (gran === 'hour') {
    // "2026-03-22 14:00" → "2pm" / "14时"
    const h = parseInt(v.slice(11, 13), 10);
    if (lang === 'zh') return `${h}时`;
    if (h === 0) return '12am';
    if (h === 12) return '12pm';
    return h < 12 ? `${h}am` : `${h - 12}pm`;
  }
  if (gran === 'day') {
    // "2026-03-22" → "Sat 3/22" / "周六 3/22"
    const d = new Date(v + 'T00:00:00');
    if (lang === 'zh') return `周${WEEKDAYS_ZH[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`;
    return `${WEEKDAYS_EN[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`;
  }
  // week: bucket is Monday date "2026-03-17" → "3/17"
  const d = new Date(v + 'T00:00:00');
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** Date helpers */
function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
function fmtShortDate(d: Date, lang = 'en'): string {
  if (lang === 'zh') return `周${WEEKDAYS_ZH[d.getDay()]} ${d.getMonth()+1}/${d.getDate()}`;
  return `${WEEKDAYS_EN[d.getDay()]} ${d.getMonth()+1}/${d.getDate()}`;
}

function TokenTrend() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [trendAgent, setTrendAgent] = useState('all');
  const [trendGran, setTrendGran] = useState<'day' | 'hour' | 'week'>('day');
  const [calOpen, setCalOpen] = useState(false); void calOpen;
  // For "By Day": the start of the 7-day window (a Monday-ish)
  const today = new Date(); today.setHours(0,0,0,0);
  const [dayWindowEnd, setDayWindowEnd] = useState(today);
  // For "By Hour": which single day to show
  const [hourDate, setHourDate] = useState(today);

  // Compute API params based on granularity
  let apiDays: number;
  let apiFrom: string | undefined;
  let apiTo: string | undefined;
  let apiGran: 'day' | 'hour' = 'day';
  if (trendGran === 'day') {
    const windowStart = addDays(dayWindowEnd, -6);
    apiFrom = toDateStr(windowStart);
    apiTo = toDateStr(addDays(dayWindowEnd, 1));
    apiDays = 7;
  } else if (trendGran === 'hour') {
    apiFrom = toDateStr(hourDate);
    apiTo = toDateStr(addDays(hourDate, 1));
    apiDays = 1;
    apiGran = 'hour';
  } else {
    // week: last 90 days, grouped by day (we'll re-bucket to weeks on frontend)
    apiFrom = toDateStr(addDays(today, -89));
    apiTo = toDateStr(addDays(today, 1));
    apiDays = 90;
  }

  const { data: trend } = useFetch<TrendData>(
    `/api/tokens/trend?days=${apiDays}&agent=${trendAgent}&granularity=${apiGran}&from=${apiFrom}&to=${apiTo}`,
    [apiDays, trendAgent, trendGran, apiFrom, apiTo],
  );

  // Fill buckets for exact window
  const chartData = React.useMemo(() => {
    if (!trend) return [];
    const existing = new Map(trend.data.map(d => [d.bucket, d]));
    const result: TrendData['data'] = [];
    if (trendGran === 'hour') {
      for (let h = 0; h < 24; h++) {
        const bucket = `${toDateStr(hourDate)} ${String(h).padStart(2,'0')}:00`;
        result.push(existing.get(bucket) ?? { bucket, ...EMPTY_BUCKET });
      }
    } else if (trendGran === 'day') {
      const windowStart = addDays(dayWindowEnd, -6);
      for (let i = 0; i < 7; i++) {
        const d = addDays(windowStart, i);
        const bucket = toDateStr(d);
        result.push(existing.get(bucket) ?? { bucket, ...EMPTY_BUCKET });
      }
    } else {
      // Week: aggregate daily data into weekly buckets
      const numWeeks = 13;
      const todayDay = today.getDay();
      const mondayOffset = todayDay === 0 ? 6 : todayDay - 1;
      const thisMon = addDays(today, -mondayOffset);
      for (let w = numWeeks - 1; w >= 0; w--) {
        const weekStart = addDays(thisMon, -w * 7);
        const agg = { ...EMPTY_BUCKET, bucket: toDateStr(weekStart), cost: 0 };
        for (let d = 0; d < 7; d++) {
          const dayBucket = toDateStr(addDays(weekStart, d));
          const dayData = existing.get(dayBucket);
          if (dayData) {
            agg.input += dayData.input;
            agg.output += dayData.output;
            agg.cacheRead += dayData.cacheRead;
            agg.cacheWrite += dayData.cacheWrite;
            agg.cost += dayData.cost;
          }
        }
        result.push(agg);
      }
    }
    return result;
  }, [trend, trendGran, dayWindowEnd, hourDate, today]);

  // Navigation handlers (not needed for week)
  const earliest = addDays(today, -90);
  const canGoForward = trendGran === 'day'
    ? addDays(dayWindowEnd, 1) <= today
    : trendGran === 'hour' ? addDays(hourDate, 1) <= today : false;
  const _canGoBack = trendGran === 'day'
    ? addDays(dayWindowEnd, -7) >= earliest
    : trendGran === 'hour' ? addDays(hourDate, -1) >= earliest : false;

  const _goBack = () => {
    if (trendGran === 'day') {
      const next = addDays(dayWindowEnd, -7);
      if (next >= earliest) setDayWindowEnd(next);
    } else {
      const next = addDays(hourDate, -1);
      if (next >= earliest) setHourDate(next);
    }
  };
  const _goForward = () => {
    if (!canGoForward) return;
    if (trendGran === 'day') {
      const next = addDays(dayWindowEnd, 7);
      setDayWindowEnd(next <= today ? next : today);
    } else {
      const next = addDays(hourDate, 1);
      setHourDate(next <= today ? next : today);
    }
  };
  // Navigation handlers available for DateNavigator integration
  void _canGoBack; void _goBack; void _goForward;

  // Range label
  const _rangeLabel = trendGran === 'day'
    ? `${fmtShortDate(addDays(dayWindowEnd, -6), lang)} – ${fmtShortDate(dayWindowEnd, lang)}`
    : `${fmtShortDate(hourDate, lang)}`;
  void _rangeLabel;

  const handleGranChange = (g: 'day' | 'hour' | 'week') => {
    setTrendGran(g);
    setCalOpen(false);
    if (g === 'day') setDayWindowEnd(today);
    else if (g === 'hour') setHourDate(today);
  };

  // Build agent options dynamically
  const agentOptions = [
    { label: t('tokenUsage.allAgents'), value: 'all' },
    ...(trend?.agents ?? []).map(a => ({ label: a, value: a })),
  ];
  const granOptions = [
    { label: t('tokenUsage.byHour'), value: 'hour' as const },
    { label: t('tokenUsage.byDay'), value: 'day' as const },
    { label: t('tokenUsage.byWeek'), value: 'week' as const },
  ];

  return (
    <div style={{ marginTop: 'var(--space-6)' }}>
      {/* Title */}
      <div style={{ fontSize: 20, fontWeight: 600, color: 'var(--text)', marginBottom: 'var(--space-4)' }}>
        {t('tokenUsage.tokenTrend')}
      </div>
      {/* Filters row */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
        marginBottom: 'var(--space-4)',
      }}>
        <Dropdown value={trendAgent} onChange={setTrendAgent} options={agentOptions} />
        <Dropdown value={trendGran} onChange={v => handleGranChange(v as 'day' | 'hour' | 'week')} options={granOptions} />

        {trendGran === 'week'
          ? <DateNavigator mode="week" />
          : trendGran === 'day'
            ? <DateNavigator mode="day" value={dayWindowEnd} onChange={setDayWindowEnd} />
            : <DateNavigator mode="hour" value={hourDate} onChange={setHourDate} />
        }
      </div>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 'var(--space-4)', outline: 'none' }}>
        {chartData.length > 0 ? (
          <>
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="bucket"
                  tick={{ fontSize: 12, fill: '#b0b0b0' }}
                  tickLine={false}
                  axisLine={{ stroke: '#444' }}
                  tickFormatter={(v: string) => fmtBucketLabel(v, trendGran, lang)}
                />
                <YAxis
                  tick={{ fontSize: 12, fill: '#b0b0b0' }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => fmtTokens(v)}
                />
                <Tooltip
                  cursor={false}
                  content={({ active, payload, label }) => {
                    if (!active || !payload?.length) return null;
                    const s = String(label);
                    let title = s;
                    if (trendGran === 'week') {
                      const mon = new Date(s + 'T00:00:00');
                      const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
                      title = `${mon.getMonth()+1}/${mon.getDate()} – ${sun.getMonth()+1}/${sun.getDate()}`;
                    } else if (trendGran === 'hour') {
                      const d = new Date(s.replace(' ', 'T') + ':00');
                      const h = d.getHours();
                      const hStr = lang === 'zh' ? `${h}时` : h === 0 ? '12am' : h === 12 ? '12pm' : h < 12 ? `${h}am` : `${h-12}pm`;
                      title = lang === 'zh'
                        ? `周${WEEKDAYS_ZH[d.getDay()]} ${d.getMonth()+1}/${d.getDate()}, ${hStr}`
                        : `${WEEKDAYS_EN[d.getDay()]} ${d.getMonth()+1}/${d.getDate()}, ${hStr}`;
                    } else {
                      const d = new Date(s + 'T00:00:00');
                      title = lang === 'zh'
                        ? `周${WEEKDAYS_ZH[d.getDay()]} ${d.getMonth()+1}/${d.getDate()}`
                        : `${WEEKDAYS_EN[d.getDay()]} ${d.getMonth()+1}/${d.getDate()}`;
                    }
                    const total = payload.reduce((sum, p) => sum + (Number(p.value) || 0), 0);
                    const bucketCost = (payload[0]?.payload as Record<string, number>)?.cost ?? 0;
                    return (
                      <div style={tooltipContentStyle}>
                        <div style={{ fontWeight: 600, marginBottom: 6 }}>{title}</div>
                        {payload.map((p, i) => (
                          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 12, color: '#aaa' }}>
                            <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: p.color, marginRight: 6 }} />{p.name}</span>
                            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtTokens(Number(p.value) || 0)}</span>
                          </div>
                        ))}
                        <div style={{ borderTop: '1px solid #333', marginTop: 6, paddingTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 600 }}>
                            <span>{t('tokenUsage.total')}</span>
                            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtTokens(total)}</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 600, color: '#3b82f6' }}>
                            <span>{t('tokenUsage.cost')}</span>
                            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtCost(bucketCost)}</span>
                          </div>
                        </div>
                      </div>
                    );
                  }}
                />
                <Bar dataKey="cacheRead" name={t('tokenUsage.cacheRead')} stackId="tokens" fill={CHART_GREEN} radius={[0, 0, 0, 0]} />
                <Bar dataKey="cacheWrite" name={t('tokenUsage.cacheWrite')} stackId="tokens" fill={CHART_PURPLE} />
                <Bar dataKey="input" name={t('tokenUsage.input')} stackId="tokens" fill={CHART_BLUE} />
                <Bar dataKey="output" name={t('tokenUsage.output')} stackId="tokens" fill={CHART_ORANGE} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
            {/* Legend */}
            <div style={{ display: 'flex', gap: 'var(--space-5)', padding: 'var(--space-3) var(--space-4) 0', fontSize: 12, color: 'var(--muted)' }}>
              <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: CHART_GREEN, marginRight: 6, verticalAlign: 'middle' }} />{t('tokenUsage.cacheRead')}</span>
              <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: CHART_PURPLE, marginRight: 6, verticalAlign: 'middle' }} />{t('tokenUsage.cacheWrite')}</span>
              <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: CHART_BLUE, marginRight: 6, verticalAlign: 'middle' }} />{t('tokenUsage.input')}</span>
              <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: CHART_ORANGE, marginRight: 6, verticalAlign: 'middle' }} />{t('tokenUsage.output')}</span>
            </div>
          </>
        ) : (
          <div style={{ padding: 'var(--space-6)', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
            {t('tokenUsage.noTrendData')}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Period Row ──
// ── Token type mini card ──
function TokenTypeCard({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-sm)', padding: 'var(--space-2) var(--space-3)',
      borderLeft: `3px solid ${color}`,
    }}>
      <div style={{ fontSize: 11, color: 'var(--muted)' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 600, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{fmtTokens(value)}</div>
    </div>
  );
}

// ── Period Card ──
function PeriodRow({ label, data: d, active, onClick }: { label: string; data: TokenSummary['totals'] | null; active: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  const cardStyle: React.CSSProperties = {
    background: active ? 'var(--surface2)' : 'var(--surface)',
    border: `1px solid ${active ? 'var(--border3)' : 'var(--border2)'}`,
    borderRadius: 8, padding: 'var(--space-4)',
    cursor: 'default', transition: 'border-color 0.15s, box-shadow 0.15s',
    boxShadow: active
      ? '0 4px 16px rgba(255,255,255,0.06), 0 1px 4px rgba(255,255,255,0.04)'
      : '0 2px 8px rgba(255,255,255,0.03), 0 1px 2px rgba(255,255,255,0.02)',
  };
  if (!d) return <div style={cardStyle} onClick={onClick}><div style={{ fontSize: 13, color: 'var(--muted)' }}>{label}</div><div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 'var(--space-2)' }}>{t('tokenUsage.loading')}</div></div>;
  return (
    <div style={cardStyle} onClick={onClick}>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 'var(--space-2)', fontWeight: active ? 600 : 400 }}>{label}</div>
      {/* Big cost + token total */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)' }}>
        <div style={{ fontSize: 28, fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{fmtCost(d.cost)}</div>
        <span style={{ fontSize: 14, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{fmtTokens(d.total)} {t('tokenUsage.tokens')}</span>
      </div>
      {/* Breakdown bar */}
      <div style={{ display: 'flex', height: 4, borderRadius: 2, overflow: 'hidden', marginTop: 'var(--space-3)', background: 'var(--border)' }}>
        {d.total > 0 && <>
          <div style={{ width: `${(d.input / d.total) * 100}%`, background: CHART_BLUE }} />
          <div style={{ width: `${(d.output / d.total) * 100}%`, background: CHART_ORANGE }} />
          <div style={{ width: `${(d.cacheRead / d.total) * 100}%`, background: CHART_GREEN }} />
          <div style={{ width: `${(d.cacheWrite / d.total) * 100}%`, background: CHART_PURPLE }} />
        </>}
      </div>
      {/* 4 mini type cards */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
        <TokenTypeCard color={CHART_BLUE} label={t('tokenUsage.input')} value={d.input} />
        <TokenTypeCard color={CHART_ORANGE} label={t('tokenUsage.output')} value={d.output} />
        <TokenTypeCard color={CHART_GREEN} label={t('tokenUsage.cacheRead')} value={d.cacheRead} />
        <TokenTypeCard color={CHART_PURPLE} label={t('tokenUsage.cacheWrite')} value={d.cacheWrite} />
      </div>
      {/* Footer stats */}
      <div style={{ display: 'flex', gap: 'var(--space-4)', marginTop: 'var(--space-3)', fontSize: 12, color: 'var(--muted)', flexWrap: 'wrap' }}>
        <span>{t('tokenUsage.cacheHit')}: <span style={{ color: hitRateColor(d.cacheHitRate), fontWeight: 500 }}>{fmtPct(d.cacheHitRate)}</span></span>
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-4)', marginTop: 'var(--space-2)', fontSize: 12, color: 'var(--muted)', flexWrap: 'wrap' }}>
        <span>{d.sessionCount} {t('tokenUsage.sessions').toLowerCase()}</span>
        <span>{t('tokenUsage.avgPerSession')}: <span style={{ fontWeight: 500 }}>{fmtCost(d.avgCostPerSession)}</span></span>
      </div>
    </div>
  );
}

export default function TokenUsage() {
  const { t } = useTranslation();
  // useNavigate available for future drill-down navigation
  const [days, setDays] = useState(30);
  const { data: dataToday } = useFetch<TokenSummary>('/api/tokens/summary?days=1', []);
  const { data: data7d } = useFetch<TokenSummary>('/api/tokens/summary?days=7', []);
  const { data: data30d, loading, error: tokensError } = useFetch<TokenSummary>('/api/tokens/summary?days=30', []);
  const { data: dataAll } = useFetch<TokenSummary>('/api/tokens/summary?days=365', []);

  const dataMap: Record<number, TokenSummary | null> = { 1: dataToday ?? null, 7: data7d ?? null, 30: data30d ?? null, 365: dataAll ?? null };
  const data = dataMap[days];

  // Breakdown has its own independent time filter (uses DateNavigator)
  type BreakdownMode = 'preset' | 'day' | 'week';
  const [bdMode, setBdMode] = useState<BreakdownMode>('preset');
  const [bdPreset, setBdPreset] = useState(7);
  const bdToday = React.useMemo(() => { const d = new Date(); d.setHours(0,0,0,0); return d; }, []);
  // "day" mode: pick a single day (uses DateNavigator mode="hour" — calendar picker)
  const [bdSingleDay, setBdSingleDay] = useState(bdToday);
  // "week" mode: pick a 7-day window (uses DateNavigator mode="day" — week list picker)
  const [bdWeekEnd, setBdWeekEnd] = useState(bdToday);

  const bdApiUrl = React.useMemo(() => {
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const addD = (d: Date, n: number) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
    if (bdMode === 'day') {
      return `/api/tokens/summary?from=${fmt(bdSingleDay)}&to=${fmt(addD(bdSingleDay, 1))}`;
    }
    if (bdMode === 'week') {
      return `/api/tokens/summary?from=${fmt(addD(bdWeekEnd, -6))}&to=${fmt(addD(bdWeekEnd, 1))}`;
    }
    return `/api/tokens/summary?days=${bdPreset}`;
  }, [bdMode, bdPreset, bdSingleDay, bdWeekEnd]);

  const { data: breakdownData } = useFetch<TokenSummary>(bdApiUrl, [bdApiUrl]);


  if (loading && !data30d) return <Loading />;
  if (tokensError && !data30d && !data7d && !dataToday) return <div style={{ padding: 'var(--space-5)' }}><AlertBanner variant="error">{tokensError}</AlertBanner></div>;
  if (!data30d && !data7d && !dataToday) return <EmptyState>{t('tokenUsage.noTokenData')}</EmptyState>;

  const active = data ?? data30d!;
  const bd = breakdownData ?? active;
  const { byModel, byAgent, cronVsManual } = bd;

  return (
    <div style={{ padding: 'var(--space-5)' }}>
      {/* ── 1. Header ── */}
      <PageHeader title={t('tokenUsage.title')} />

      {/* ── 2. Summary ── */}
      <div style={{
        marginTop: 'var(--space-5)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: 'var(--space-4)',
        background: 'var(--bg-2)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', marginBottom: 'var(--space-4)' }}>
          <span style={{ fontSize: 20, fontWeight: 600, color: 'var(--text)' }}>{t('tokenUsage.summary')}</span>
          <InfoTooltip label={t('tokenUsage.breakdownLabel')} placement="bottom" width={520}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12, lineHeight: 1.7 }}>
              <div>
                <span style={{ fontWeight: 500, color: 'var(--text)' }}>{t('tokenUsage.tokenTotal')}</span>
                <span style={{ margin: '0 6px' }}>=</span>
                <span style={{ color: '#60a5fa' }}>{t('tokenUsage.input')}</span> + <span style={{ color: '#fb923c' }}>{t('tokenUsage.output')}</span> + <span style={{ color: '#34d399' }}>{t('tokenUsage.cacheRead')}</span> + <span style={{ color: '#c084fc' }}>{t('tokenUsage.cacheWrite')}</span>
                <br />
                <span style={{ opacity: 0.6 }}>{t('tokenUsage.tokenTotalNote')}</span>
              </div>
              <div>
                <span style={{ fontWeight: 500, color: 'var(--text)' }}>{t('tokenUsage.cost')}</span>
                <span style={{ margin: '0 6px' }}>=</span>
                <span style={{ color: '#60a5fa' }}>{t('tokenUsage.input')}</span>{' × '}<span style={{ color: '#60a5fa', opacity: 0.7 }}>P_input</span>
                {' + '}<span style={{ color: '#fb923c' }}>{t('tokenUsage.output')}</span>{' × '}<span style={{ color: '#fb923c', opacity: 0.7 }}>P_output</span>
                {' + '}<span style={{ color: '#34d399' }}>{t('tokenUsage.cacheRead')}</span>{' × '}<span style={{ color: '#34d399', opacity: 0.7 }}>P_read</span>
                {' + '}<span style={{ color: '#c084fc' }}>{t('tokenUsage.cacheWrite')}</span>{' × '}<span style={{ color: '#c084fc', opacity: 0.7 }}>P_write</span>
              </div>
              <div style={{ opacity: 0.6 }}>
                {t('tokenUsage.costNote1')}; {t('tokenUsage.costNote2')}; {t('tokenUsage.costNote3')}
              </div>
              <div style={{ marginTop: 4, paddingTop: 6, borderTop: '1px solid rgba(255,255,255,0.1)', opacity: 0.5, fontStyle: 'italic' }}>
                {t('tokenUsage.costDisclaimer')}
              </div>
            </div>
          </InfoTooltip>
        </div>
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 'var(--space-4)',
        }}>
          <PeriodRow label={t('tokenUsage.todaySince')} data={dataToday?.totals ?? null} active={days === 1} onClick={() => setDays(1)} />
          <PeriodRow label={t('tokenUsage.last7Days')} data={data7d?.totals ?? null} active={days === 7} onClick={() => setDays(7)} />
          <PeriodRow label={t('tokenUsage.last30Days')} data={data30d?.totals ?? null} active={days === 30} onClick={() => setDays(30)} />
          <PeriodRow label={t('tokenUsage.allTime')} data={dataAll?.totals ?? null} active={days === 365} onClick={() => setDays(365)} />
        </div>
      </div>

      {/* ── 3. Token Trend (independent) ── */}
      <div style={{ marginTop: 48 }}><TokenTrend /></div>

      {/* ── Breakdown ── */}
      <div style={{ fontSize: 20, fontWeight: 600, color: 'var(--text)', marginTop: 48 }}>{t('tokenUsage.breakdown')}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginTop: 'var(--space-3)', flexWrap: 'wrap' }}>
        <Dropdown
          value={bdMode === 'preset' ? `p_${bdPreset}` : bdMode}
          onChange={(v: string) => {
            if (v.startsWith('p_')) { setBdMode('preset'); setBdPreset(Number(v.slice(2))); }
            else if (v === 'day') { setBdMode('day'); setBdSingleDay(bdToday); }
            else if (v === 'week') { setBdMode('week'); setBdWeekEnd(bdToday); }
          }}
          options={[
            { label: t('tokenUsage.today'), value: 'p_1' },
            { label: t('tokenUsage.last7Days'), value: 'p_7' },
            { label: t('tokenUsage.last30Days'), value: 'p_30' },
            { label: t('tokenUsage.last90Days'), value: 'p_90' },
            { label: t('tokenUsage.allTime'), value: 'p_365' },
            { label: t('tokenUsage.byDay'), value: 'day' },
            { label: t('tokenUsage.byWeek'), value: 'week' },
          ]}
        />
        {bdMode === 'day' && <DateNavigator mode="hour" value={bdSingleDay} onChange={setBdSingleDay} />}
        {bdMode === 'week' && <DateNavigator mode="day" value={bdWeekEnd} onChange={setBdWeekEnd} />}
      </div>

      {/* ── 4. By Agent (first) ── */}
      <div style={{ marginTop: 'var(--space-4)' }}>
        <SectionLabel>{t('tokenUsage.byAgent')}</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 'var(--space-4)', marginTop: 'var(--space-3)', alignItems: 'start' }}>
          {(() => {
            const agentPieTotal = byAgent.reduce((s, a) => s + a.total, 0);
            const agentPieData = byAgent.filter(a => a.total > 0).map(a => ({
              name: a.agent, value: a.total, cost: a.cost, pct: agentPieTotal > 0 ? fmtPct(a.total / agentPieTotal, 1) : '0',
            }));
            return agentPieData.length === 0 ? <EmptyPie /> : (
          <ResponsiveContainer width="100%" height={180}>
            <PieChart>
              <Pie data={agentPieData} cx="50%" cy="50%" innerRadius={40} outerRadius={70} dataKey="value" strokeWidth={0}>
                {agentPieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
              </Pie>
              <Tooltip contentStyle={tooltipContentStyle} content={({ active, payload: pl }) => {
                if (!active || !pl?.[0]) return null;
                const d = pl[0].payload;
                if (!d) return null;
                return (<div style={{ ...tooltipContentStyle, padding: '8px 12px' }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>{d.name}</div>
                  <div>{t('tokenUsage.tokens')}: <strong>{fmtTokens(d.value)}</strong></div>
                  <div>{t('tokenUsage.share')}: <strong>{d.pct}</strong></div>
                  <div>{t('tokenUsage.cost')}: <strong>{fmtCost(d.cost)}</strong></div>
                </div>);
              }} />
            </PieChart>
          </ResponsiveContainer>
            );
          })()}
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>{t('tokenUsage.agent')}</th>
                  <th style={thRight}>{t('tokenUsage.tokens')}</th>
                  <th style={thRight}>{t('tokenUsage.percent')}</th>
                  <th style={thRight}>{t('tokenUsage.cacheHit')}</th>
                  <th style={thRight}>{t('tokenUsage.cost')}</th>
                  <th style={thRight}>{t('tokenUsage.sessions')}</th>
                </tr>
              </thead>
              <tbody>
                {(() => { const agentTotal = byAgent.reduce((s, a) => s + a.total, 0); return byAgent.map((a, i) => (
                  <tr key={a.agent}>
                    <td style={tdStyle}>
                      <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: PIE_COLORS[i % PIE_COLORS.length], marginRight: 'var(--space-2)' }} />
                      <span style={monoStyle}>{a.agent}</span>
                    </td>
                    <td style={tdRight}><strong>{fmtTokens(a.total)}</strong></td>
                    <td style={{ ...tdRight, color: 'var(--muted)' }}>{agentTotal > 0 ? fmtPct(a.total / agentTotal, 1) : '—'}</td>
                    <td style={{ ...tdRight, color: hitRateColor((a.cacheRead + a.input) > 0 ? a.cacheRead / (a.cacheRead + a.input) : 0), fontWeight: 500 }}>{(a.cacheRead + a.input) > 0 ? fmtPct(a.cacheRead / (a.cacheRead + a.input), 1) : '—'}</td>
                    <td style={tdRight}>{fmtCost(a.cost)}</td>
                    <td style={tdRight}>{a.sessions}</td>
                  </tr>
                )); })()}
              </tbody>
            </table>
          </Card>
        </div>
      </div>

      {/* ── 5. By Model ── */}
      <div style={{ marginTop: 40 }}>
        <SectionLabel>{t('tokenUsage.byModel')}</SectionLabel>
        {(() => {
          // Top 5 models, rest grouped as "Other"
          const sorted = [...byModel].sort((a, b) => b.total - a.total);
          const top = sorted.slice(0, 5);
          const rest = sorted.slice(5);
          const modelRows = rest.length > 0
            ? [...top, { model: `Other (${rest.length})`, total: rest.reduce((s, r) => s + r.total, 0), cost: rest.reduce((s, r) => s + r.cost, 0), messages: rest.reduce((s, r) => s + r.messages, 0), input: rest.reduce((s, r) => s + r.input, 0), output: rest.reduce((s, r) => s + r.output, 0), cacheRead: rest.reduce((s, r) => s + r.cacheRead, 0), cacheWrite: rest.reduce((s, r) => s + r.cacheWrite, 0), sessions: 0 }]
            : top;
          return (
        <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 'var(--space-4)', marginTop: 'var(--space-3)', alignItems: 'start' }}>
          {(() => {
            const modelPieTotal = modelRows.reduce((s, m) => s + m.total, 0);
            const modelPieData = modelRows.filter(m => m.total > 0).map(m => ({
              name: m.model, value: m.total, cost: m.cost, pct: modelPieTotal > 0 ? fmtPct(m.total / modelPieTotal, 1) : '0',
            }));
            return modelPieData.length === 0 ? <EmptyPie /> : (
          <ResponsiveContainer width="100%" height={180}>
            <PieChart>
              <Pie data={modelPieData} cx="50%" cy="50%" innerRadius={40} outerRadius={70} dataKey="value" strokeWidth={0}>
                {modelPieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
              </Pie>
              <Tooltip contentStyle={tooltipContentStyle} content={({ active, payload: pl }) => {
                if (!active || !pl?.[0]) return null;
                const d = pl[0].payload;
                if (!d) return null;
                return (<div style={{ ...tooltipContentStyle, padding: '8px 12px' }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>{d.name}</div>
                  <div>{t('tokenUsage.tokens')}: <strong>{fmtTokens(d.value)}</strong></div>
                  <div>{t('tokenUsage.share')}: <strong>{d.pct}</strong></div>
                  <div>{t('tokenUsage.cost')}: <strong>{fmtCost(d.cost)}</strong></div>
                </div>);
              }} />
            </PieChart>
          </ResponsiveContainer>
            );
          })()}
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>{t('tokenUsage.model')}</th>
                  <th style={thRight}>{t('tokenUsage.tokens')}</th>
                  <th style={thRight}>{t('tokenUsage.percent')}</th>
                  <th style={thRight}>{t('tokenUsage.cacheHit')}</th>
                  <th style={thRight}>{t('tokenUsage.cost')}</th>
                  <th style={thRight}>{t('tokenUsage.messages')}</th>
                </tr>
              </thead>
              <tbody>
                {(() => { const modelTotal = modelRows.reduce((s, m) => s + m.total, 0); return modelRows.map((m, i) => (
                  <tr key={m.model}>
                    <td style={tdStyle}>
                      <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: PIE_COLORS[i % PIE_COLORS.length], marginRight: 'var(--space-2)' }} />
                      <span style={monoStyle}>{m.model}</span>
                      {'provider' in m && m.provider && <span style={{ ...monoStyle, color: 'var(--muted)' }}> ({m.provider})</span>}
                    </td>
                    <td style={tdRight}><strong>{fmtTokens(m.total)}</strong></td>
                    <td style={{ ...tdRight, color: 'var(--muted)' }}>{modelTotal > 0 ? fmtPct(m.total / modelTotal, 1) : '—'}</td>
                    <td style={{ ...tdRight, color: hitRateColor((m.cacheRead + m.input) > 0 ? m.cacheRead / (m.cacheRead + m.input) : 0), fontWeight: 500 }}>{(m.cacheRead + m.input) > 0 ? fmtPct(m.cacheRead / (m.cacheRead + m.input), 1) : '—'}</td>
                    <td style={tdRight}>{fmtCost(m.cost)}</td>
                    <td style={tdRight}>{fmtTokens(m.messages)}</td>
                  </tr>
                )); })()}
              </tbody>
            </table>
          </Card>
        </div>
          );
        })()}
      </div>

      {/* ── 6. Cron vs Manual ── */}
      <div style={{ marginTop: 40 }}>
        <SectionLabel>{t('tokenUsage.cronVsManual')}</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 'var(--space-4)', marginTop: 'var(--space-3)', alignItems: 'center' }}>
          {(() => {
            const cronTotal = cronVsManual.cron.tokens + cronVsManual.manual.tokens;
            const cronPieData = [
              { name: 'Cron', value: cronVsManual.cron.cost, tokens: cronVsManual.cron.tokens },
              { name: 'Manual', value: cronVsManual.manual.cost, tokens: cronVsManual.manual.tokens },
            ].filter(d => d.value > 0 || d.tokens > 0);
            return cronPieData.length === 0 ? <EmptyPie /> : (
          <ResponsiveContainer width="100%" height={180}>
            <PieChart>
              <Pie data={cronPieData} cx="50%" cy="50%" innerRadius={40} outerRadius={70} dataKey="tokens" strokeWidth={0}>
                {cronPieData.map((d, i) => <Cell key={i} fill={d.name === 'Cron' ? CHART_PURPLE : CHART_BLUE} />)}
              </Pie>
              <Tooltip contentStyle={tooltipContentStyle} content={({ active, payload: pl }) => {
                if (!active || !pl?.length) return null;
                const d = pl[0].payload as { name: string; value: number; tokens: number } | undefined;
                if (!d) return null;
                const pct = cronTotal > 0 ? fmtPct(d.tokens / cronTotal, 1) : '0';
                return (<div style={{ ...tooltipContentStyle, padding: 'var(--space-3)' }}>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>{d.name}</div>
                  <div>{t('tokenUsage.tokens')}: <strong>{fmtTokens(d.tokens)}</strong></div>
                  <div>{t('tokenUsage.share')}: <strong>{pct}</strong></div>
                  <div>{t('tokenUsage.cost')}: <strong>{fmtCost(d.value)}</strong></div>
                </div>);
              }} />
            </PieChart>
          </ResponsiveContainer>
            );
          })()}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
            <Card>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 'var(--space-2)' }}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: CHART_PURPLE, marginRight: 6, verticalAlign: 'middle' }} />{t('tokenUsage.scheduledCron')}</div>
              <div style={{ fontSize: 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: CHART_PURPLE }}>{fmtTokens(cronVsManual.cron.tokens)}</div>
              <div style={{ display: 'flex', gap: 'var(--space-4)', marginTop: 'var(--space-2)', fontSize: 13, color: 'var(--muted)' }}>
                <span>{fmtCost(cronVsManual.cron.cost)}</span>
                <span>{cronVsManual.cron.sessions} {t('tokenUsage.sessions').toLowerCase()}</span>
              </div>
            </Card>
            <Card>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 'var(--space-2)' }}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: CHART_BLUE, marginRight: 6, verticalAlign: 'middle' }} />{t('tokenUsage.manualInteractive')}</div>
              <div style={{ fontSize: 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: CHART_BLUE }}>{fmtTokens(cronVsManual.manual.tokens)}</div>
              <div style={{ display: 'flex', gap: 'var(--space-4)', marginTop: 'var(--space-2)', fontSize: 13, color: 'var(--muted)' }}>
                <span>{fmtCost(cronVsManual.manual.cost)}</span>
                <span>{cronVsManual.manual.sessions} {t('tokenUsage.sessions').toLowerCase()}</span>
              </div>
            </Card>
          </div>
        </div>
      </div>

      {/* ── Token Usage by Agent ── */}
      <div style={{ marginTop: 48, marginBottom: 120 }}>
        <div style={{ fontSize: 20, fontWeight: 600, color: 'var(--text)', marginBottom: 16 }}>{t('tokenUsage.tokenUsageByAgent')}</div>
        <TokenByAgent />
      </div>

    </div>
  );
}

// ── Token By Agent section ──────────────────────────────────────────────────

interface TokenAgentRow {
  agent_name: string;
  input_tokens: number; output_tokens: number;
  cache_read: number; cache_write: number; total_tokens: number;
  total_cost: number; message_count: number; session_count: number;
}

const AGENT_COLORS = ['#60a5fa', '#c084fc', '#34d399', '#fbbf24', '#f472b6', '#22d3ee', '#fb923c', '#a3e635'];

interface TokenAgentSession {
  session_id: string; input_tokens: number; output_tokens: number;
  cache_read: number; total_tokens: number; total_cost: number;
  message_count: number; started_at: number;
}

function TokenAgentExpandable({ agent, totalAllTokens, maxTokens, colorIdx, timeQs }: {
  agent: TokenAgentRow; totalAllTokens: number; maxTokens: number; colorIdx: number; timeQs: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const _sessionQs = timeQs ? `?${timeQs.slice(1)}` : ''; // strip leading ? if any, re-add
  void _sessionQs; // used in fetch below
  const { data: topSessions } = useFetch<TokenAgentSession[]>(
    expanded ? `/api/profiler/tokens/${encodeURIComponent(agent.agent_name)}/sessions${timeQs}` : '',
    [expanded],
  );

  const color = AGENT_COLORS[colorIdx % AGENT_COLORS.length];
  const pct = totalAllTokens > 0 ? (agent.total_tokens / totalAllTokens) * 100 : 0;
  const cacheRate = (agent.cache_read + agent.input_tokens) > 0
    ? (agent.cache_read / (agent.cache_read + agent.input_tokens)) * 100 : 0;

  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      {/* Collapsed row */}
      <div
        style={{
          display: 'grid', gridTemplateColumns: '20px 80px 80px 72px 1fr 40px',
          alignItems: 'center', gap: 'var(--space-2)',
          padding: 'var(--space-2) 0', cursor: 'pointer', transition: 'background .1s',
        }}
        onClick={() => setExpanded(!expanded)}
        onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface2)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      >
        <div style={{ fontSize: 20, color: 'var(--muted)', textAlign: 'center', lineHeight: 1 }}>
          {expanded ? '▾' : '▸'}
        </div>
        <div style={{ fontWeight: 600, fontSize: 13, color }}>{agent.agent_name}</div>
        <div style={{ fontSize: 13, color: 'var(--text)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
          {fmtTokens(agent.total_tokens)}
        </div>
        <div style={{ fontSize: 13, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
          {fmtCost(agent.total_cost)}
        </div>
        <div style={{ height: 14, background: 'var(--surface2)', position: 'relative', overflow: 'hidden', borderRadius: 3 }}>
          <div style={{ position: 'absolute', inset: 0, width: `${(agent.total_tokens / maxTokens) * 100}%`, background: color, borderRadius: 3 }} />
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
          {fmtPct(pct / 100, 0)}
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div style={{ padding: '8px 16px 16px 28px', background: 'var(--surface)', borderTop: '1px solid var(--border)' }}>
          {/* Stats */}
          <div style={{ display: 'flex', gap: 20, fontSize: 13, marginBottom: 12, color: 'var(--muted)' }}>
            <span>{t('tokenUsage.input')}: <strong style={{ color: 'var(--text)' }}>{fmtTokens(agent.input_tokens)}</strong></span>
            <span>{t('tokenUsage.output')}: <strong style={{ color: 'var(--text)' }}>{fmtTokens(agent.output_tokens)}</strong></span>
            <span>{t('tokenUsage.cacheRead')}: <strong style={{ color: 'var(--text)' }}>{fmtTokens(agent.cache_read)}</strong></span>
            <span>{t('tokenUsage.cacheHit')}: <strong style={{ color: cacheRate > 90 ? '#34d399' : 'var(--text)' }}>{fmtPct(cacheRate / 100, 1)}</strong></span>
            <span>{t('tokenUsage.avgPerSession')}: <strong style={{ color: 'var(--text)' }}>{fmtTokens(Math.round(agent.total_tokens / Math.max(agent.session_count, 1)))}</strong></span>
          </div>

          {/* Token composition bar */}
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>{t('tokenUsage.tokenComposition')}</div>
          <div style={{ display: 'flex', height: 18, borderRadius: 3, overflow: 'hidden', marginBottom: 8 }}>
            {[
              { value: agent.input_tokens, color: AGENT_COLORS[0], label: t('tokenUsage.input') },
              { value: agent.output_tokens, color: '#fb923c', label: t('tokenUsage.output') },
              { value: agent.cache_read, color: '#34d399', label: t('tokenUsage.cacheRead') },
              { value: agent.cache_write, color: '#fbbf24', label: t('tokenUsage.cacheWrite') },
            ].map(seg => {
              const total = agent.input_tokens + agent.output_tokens + agent.cache_read + agent.cache_write;
              const w = total > 0 ? (seg.value / total) * 100 : 0;
              return w > 0 ? (
                <div key={seg.label} title={`${seg.label}: ${fmtTokens(seg.value)}`}
                  style={{ width: `${w}%`, background: seg.color, minWidth: seg.value > 0 ? 2 : 0 }} />
              ) : null;
            })}
          </div>
          <div style={{ display: 'flex', gap: 14, fontSize: 11, marginBottom: 16, color: 'var(--muted)' }}>
            {[
              { label: t('tokenUsage.input'), color: AGENT_COLORS[0] },
              { label: t('tokenUsage.output'), color: '#fb923c' },
              { label: t('tokenUsage.cacheR'), color: '#34d399' },
              { label: t('tokenUsage.cacheW'), color: '#fbbf24' },
            ].map(l => (
              <span key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <span style={{ width: 8, height: 8, borderRadius: 1, background: l.color, flexShrink: 0 }} />
                {l.label}
              </span>
            ))}
          </div>

          {/* Top sessions */}
          {topSessions && topSessions.length > 0 && (
            <div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>{t('tokenUsage.topSessionsByToken')}</div>
              {topSessions.slice(0, 5).map(s => (
                <div key={s.session_id}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '3px 6px', cursor: 'pointer', borderRadius: 3 }}
                  onClick={() => navigate(`/sessions?q=${s.session_id}`)}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface2)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <span style={{ fontFamily: 'var(--font-m)', color: 'var(--text)' }}>{s.session_id.slice(0, 20)}…</span>
                  <span style={{ color: 'var(--text)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmtTokens(s.total_tokens)}</span>
                  <span style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{fmtCost(s.total_cost)}</span>
                  <span style={{ color: 'var(--muted)', fontSize: 11 }}>{s.message_count} {t('tokenUsage.msgs')}</span>
                  <span style={{ color: 'var(--muted)', fontSize: 11, marginLeft: 'auto' }}>{t('tokenUsage.view')}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TokenByAgent() {
  const { t } = useTranslation();
  const [days, setDays] = useState(7);

  const now = useMemo(() => Date.now(), [days]); // recalc when days changes
  const fromTs = days >= 365 ? '' : String(now - days * 86400000);
  const qs = fromTs ? `?from=${fromTs}` : '';

  const { data: agents } = useFetch<TokenAgentRow[]>(`/api/profiler/tokens${qs}`, [days]);

  if (!agents || agents.length === 0) return null;

  const totalTokens = agents.reduce((s, a) => s + a.total_tokens, 0);
  const maxTokens = agents[0]?.total_tokens ?? 1;

  const timeOptions = [
    { label: t('tokenUsage.today'), value: 1 },
    { label: t('tokenUsage.last7Days'), value: 7 },
    { label: t('tokenUsage.last30Days'), value: 30 },
    { label: t('tokenUsage.last90Days'), value: 90 },
    { label: t('tokenUsage.allTime'), value: 365 },
  ];

  return (
    <div>
      {/* Time filter */}
      <div style={{ padding: '0 var(--space-4)', marginBottom: 'var(--space-3)', display: 'flex', gap: 6 }}>
        {timeOptions.map(o => (
          <button
            key={o.value}
            className={`tab${days === o.value ? ' on' : ''}`}
            onClick={() => setDays(o.value)}
            style={{ fontSize: 12, padding: '4px 10px' }}
          >
            {o.label}
          </button>
        ))}
      </div>

      <div style={{ padding: '0 var(--space-4)' }}>
        {/* Header */}
        <div style={{
          display: 'grid', gridTemplateColumns: '20px 80px 80px 72px 1fr 40px',
          gap: 'var(--space-2)', fontSize: 11, color: 'var(--muted)',
          textTransform: 'uppercase', letterSpacing: '.04em',
          padding: '0 0 6px', borderBottom: '1px solid var(--border)',
        }}>
          <div />
          <div>{t('tokenUsage.agent')}</div>
          <div>{t('tokenUsage.tokens')}</div>
          <div>{t('tokenUsage.cost')}</div>
          <div>{t('tokenUsage.share')}</div>
          <div />
        </div>

        {agents.map((a, i) => (
          <TokenAgentExpandable key={a.agent_name} agent={a} totalAllTokens={totalTokens} maxTokens={maxTokens} colorIdx={i} timeQs={qs} />
        ))}

        <div style={{ display: 'flex', gap: 'var(--space-4)', marginTop: 'var(--space-3)', fontSize: 13, color: 'var(--muted)' }}>
          <span>{t('tokenUsage.total')}: <strong style={{ color: 'var(--text)' }}>{fmtTokens(totalTokens)}</strong></span>
          <span>{t('tokenUsage.cost')}: <strong style={{ color: 'var(--text)' }}>{fmtCost(agents.reduce((s, a) => s + a.total_cost, 0))}</strong></span>
          <span>{t('tokenUsage.sessions')}: <strong style={{ color: 'var(--text)' }}>{agents.reduce((s, a) => s + a.session_count, 0)}</strong></span>
        </div>
      </div>
    </div>
  );
}
