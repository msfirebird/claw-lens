import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ReferenceLine } from 'recharts';
import { useFetch, fmtCost, fmtTokens, fmtMs, fmtDatetime, fmtPct, tipBadge, tipBox, TABLE_STYLE, TH_STYLE, TD_STYLE, MONO_STYLE } from '../hooks';
import {
  PageHeader, KpiStrip, Kpi, Loading, TabBar, AlertBanner,
} from '../components/ui';

const ACTIVE_SESSION_THRESHOLD_MS = 10 * 60 * 1_000;
const COPIED_FEEDBACK_MS = 1_500;

interface Session {
  id: string; agent_name: string;
  started_at: number; ended_at: number;
  total_messages: number; total_cost: number; total_tokens: number;
  primary_model: string; error_count: number; duration_ms: number;
  last_message_at: number | null;
  cache_read: number; cache_write: number; input_tokens: number;
  last_stop_reason: string | null;
  is_cron: number; cron_task: string | null; task_summary: string | null;
  // enriched fields
  contextUsed: number; contextLimit: number; utilizationPct: number;
  pacing: 'rising' | 'stable' | 'cooling' | 'unknown';
  burnTokensPerMin: number;
  status: string;
}

interface SessionDetail {
  session: Session;
  modelBreakdown: { model: string; message_count: number; total_tokens: number; cost_total: number; input_tokens: number; output_tokens: number; cache_read: number; cache_write: number }[];
  toolBreakdown: { tool_name: string; call_count: number; avg_duration_ms: number }[];
}

interface Message {
  id: string;
  seq: number;
  role: string;
  model: string;
  timestamp: number;
  parent_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  total_tokens: number;
  cost_total: number;
  stop_reason: string | null;
  has_error: number;
  error_message: string | null;
  latency_ms: number | null;
}

// ── Helpers ──

// cache_write is NOT a cache hit — exclude from denominator (consistent with backend + OpenClaw UI)
function cacheHitRate(cacheRead: number, inputTokens: number): number {
  const total = cacheRead + inputTokens;
  if (total === 0) return 0;
  return cacheRead / total;
}


export default function Sessions() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRowRef = useRef<HTMLTableRowElement | null>(null);
  const shouldAutoScroll = useRef(false);
  const [agentFilter, setAgentFilter] = useState(() => searchParams.get('agent') || '');
  const [timeFilter, setTimeFilter] = useState('all');
  const [sortBy, setSortBy] = useState('newest');
  const [cronFilter, setCronFilter] = useState('all');
  const [sessionIdFilter, setSessionIdFilter] = useState('');
  const [detailTab, setDetailTab] = useState<'overview' | 'messages'>('overview');
  const [expandedMsgs, setExpandedMsgs] = useState<Set<string>>(new Set());
  const [msgContents, setMsgContents] = useState<Record<string, unknown[]>>({});

  // Sync agent filter from URL query param
  useEffect(() => {
    const agent = searchParams.get('agent');
    if (agent) setAgentFilter(agent);
  }, [searchParams]);

  // Sync selected session from URL query param
  useEffect(() => {
    const sessionId = searchParams.get('q');
    if (sessionId) { setSelected(sessionId); shouldAutoScroll.current = true; }
  }, [searchParams]);

  // Auto-scroll to selected row once sessions are loaded
  useEffect(() => {
    if (!shouldAutoScroll.current || !selected) return;
    // Poll until the row is in the DOM (sessions may not be loaded yet)
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      if (selectedRowRef.current) {
        clearInterval(poll);
        shouldAutoScroll.current = false;
        selectedRowRef.current.scrollIntoView({ block: 'start', behavior: 'smooth' });
      } else if (attempts > 20) {
        clearInterval(poll);
        shouldAutoScroll.current = false;
      }
    }, 100);
    return () => clearInterval(poll);
  }, [selected]);

  // Build query params for session list fetch
  const timeFrom = useMemo(() => {
    const now = Date.now();
    if (timeFilter === 'today') { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); }
    if (timeFilter === '7d') return now - 7 * 86400000;
    if (timeFilter === '30d') return now - 30 * 86400000;
    return 0; // all
  }, [timeFilter]);
  const sessQs = new URLSearchParams();
  if (agentFilter) sessQs.set('agent', agentFilter);
  if (timeFrom > 0) sessQs.set('from', String(timeFrom));
  const { data: sessions, loading, error: sessionsError } = useFetch<Session[]>(`/api/sessions?${sessQs}`, [agentFilter, timeFilter]);
  const { data: statsData } = useFetch<{ agents: string[] }>('/api/stats');
  const { data: detail } = useFetch<SessionDetail | null>(
    selected ? `/api/sessions/${selected}` : '',
    [selected]
  );
  const { data: messages } = useFetch<Message[]>(
    selected ? `/api/sessions/${selected}/messages` : '',
    [selected]
  );

  const filtered = useMemo(() => {
    // Session ID filter: search across all fetched sessions, bypass other filters
    if (sessionIdFilter.trim()) {
      const q = sessionIdFilter.trim().toLowerCase();
      return (sessions || []).filter(s => s.id.toLowerCase().includes(q));
    }
    let list = (sessions || []).filter(s => !agentFilter || s.agent_name === agentFilter);
    if (cronFilter === 'cron') list = list.filter(s => s.is_cron);
    else if (cronFilter === 'non-cron') list = list.filter(s => !s.is_cron);
    // Sort
    // cache_write is NOT a cache hit — exclude from denominator
    const cacheRate = (s: Session) => { const t = (s.cache_read || 0) + (s.input_tokens || 0); return t > 0 ? (s.cache_read || 0) / t : 0; };
    if (sortBy === 'newest') list = [...list].sort((a, b) => (b.last_message_at ?? b.started_at) - (a.last_message_at ?? a.started_at));
    else if (sortBy === 'tokens') list = [...list].sort((a, b) => b.total_tokens - a.total_tokens);
    else if (sortBy === 'cost') list = [...list].sort((a, b) => b.total_cost - a.total_cost);
    else if (sortBy === 'errors') list = [...list].sort((a, b) => b.error_count - a.error_count);
    else if (sortBy === 'cache_hit_asc') list = [...list].sort((a, b) => cacheRate(a) - cacheRate(b));
    return list;
  }, [sessions, agentFilter, cronFilter, sortBy, sessionIdFilter]);

  // ── KPI computations (derived from filtered list so all filters apply) ──
  const kpis = useMemo(() => {
    const now = Date.now();
    const todayMidnight = new Date(); todayMidnight.setHours(0,0,0,0);
    const d7 = now - 7 * 86400000;
    const d30 = now - 30 * 86400000;
    const totalSessions = filtered.length;
    const activeNow = filtered.filter(s => s.last_message_at && (now - s.last_message_at) < ACTIVE_SESSION_THRESHOLD_MS).length;
    const activeTs = (s: Session) => s.last_message_at ?? s.started_at;
    const errorsToday = filtered.filter(s => s.error_count > 0 && activeTs(s) >= todayMidnight.getTime()).length;
    const errors7d = filtered.filter(s => s.error_count > 0 && activeTs(s) >= d7).length;
    const errors30d = filtered.filter(s => s.error_count > 0 && activeTs(s) >= d30).length;
    return { totalSessions, activeNow, errorsToday, errors7d, errors30d };
  }, [filtered]);

  // Cost Delta: per-step cost
  const costGrowthData = (messages || []).filter(m => m.role === 'assistant').map(msg => ({
    seq: msg.seq,
    cost: msg.cost_total || 0,
  }));

  // Token Delta: per-step tokens
  const tokenGrowthData = (messages || []).filter(m => m.role === 'assistant').map(msg => ({
    seq: msg.seq,
    tokens: msg.total_tokens || 0,
  }));

  // Context Pressure: per-message context window size
  const selectedSession = selected ? filtered.find(s => s.id === selected) : null;
  const contextLimit = selectedSession?.contextLimit || 1000000;
  const contextPressureData = (() => {
    let lastGoodContext = 0;
    return (messages || []).filter(m => m.role === 'assistant').map(msg => {
      const isError = msg.has_error === 1;
      const rawContext = (msg.input_tokens || 0) + (msg.cache_read || 0) + (msg.cache_write || 0);
      if (!isError && rawContext > 0) lastGoodContext = rawContext;
      return {
        seq: msg.seq,
        contextSize: isError ? lastGoodContext : rawContext,
        errorContext: isError ? lastGoodContext : null,
      };
    });
  })();

  // Detail panel cache data
  const detailCache = useMemo(() => {
    if (!detail) return null;
    const mb = detail.modelBreakdown;
    const totalCacheRead = mb.reduce((a, m) => a + (m.cache_read || 0), 0);
    const totalCacheWrite = mb.reduce((a, m) => a + (m.cache_write || 0), 0);
    const totalInput = mb.reduce((a, m) => a + (m.input_tokens || 0), 0);
    const rate = cacheHitRate(totalCacheRead, totalInput);
    const barTotal = totalInput + totalCacheRead + totalCacheWrite;
    return { totalCacheRead, totalCacheWrite, totalInput, rate, barTotal };
  }, [detail]);

  function toggleSessionDetail(id: string) {
    if (id === selected) {
      setSelected(null);
      setSearchParams(p => { p.delete('q'); return p; }, { replace: true });
    } else {
      setSelected(id);
      setDetailTab('overview');
      setSearchParams(p => { p.set('q', id); return p; }, { replace: true });
    }
  }

  const fmtDateParts = (ts: number) => { const d = new Date(ts); return { date: `${d.getMonth()+1}/${d.getDate()}`, time: `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}` }; };

  return (
    <div style={{ padding: 'var(--space-5)' }}>
      {/* ── Header ── */}
      <PageHeader title={t('common.sessions')} subtitle={
        <span className="sess-src-tip" style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', cursor: 'help' }}>
          <span style={{ fontSize: 12, color: 'var(--muted)', textDecoration: 'underline dotted', textUnderlineOffset: 3 }}>
            {t('sessions.dataSourceTitle')}
          </span>
          <span className="sess-src-tip-box" style={{ ...tipBox, left: 0, width: 400 }}>
            {t('sessions.dataSourceBody')}{`\n`}
            <span style={{ fontFamily: 'var(--font-m)', fontSize: 11, color: '#aaa' }}>~/.openclaw/agents/{'{agent}'}/sessions/*.jsonl</span>
            {`\n\n`}
            <span style={{ color: '#f0a' }}>*.jsonl.reset.{'{timestamp}'}</span>
            {` — ${t('sessions.resetExplain')}\n\n`}
            <span style={{ color: '#fa0' }}>*.jsonl.deleted.{'{timestamp}'}</span>
            {` — ${t('sessions.deletedExplain')}`}
          </span>
          <style>{`.sess-src-tip:hover .sess-src-tip-box { display: block !important; }`}</style>
        </span>
      } />

      {/* ── KPI Strip ── */}
      <KpiStrip cols={5} style={{ marginTop: 'var(--space-4)' }}>
        <Kpi value={kpis.totalSessions} label={t('sessions.totalSessions')} />
        <Kpi value={kpis.activeNow} label={t('sessions.activeNow')} color={kpis.activeNow > 0 ? 'var(--C-green)' : undefined} />
        <Kpi value={kpis.errorsToday} label={t('sessions.errorsToday')} color={kpis.errorsToday > 0 ? 'var(--C-rose)' : undefined} />
        <Kpi value={kpis.errors7d} label={t('sessions.errors7d')} color={kpis.errors7d > 0 ? 'var(--C-rose)' : undefined} />
        <Kpi value={kpis.errors30d} label={t('sessions.errors30d')} color={kpis.errors30d > 0 ? 'var(--C-rose)' : undefined} />
      </KpiStrip>

      {/* ── Filters & Sort ── */}
      <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'calc(var(--space-5) + 10px)', marginBottom: 'var(--space-4)', alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder={t('sessions.searchPlaceholder')}
          value={sessionIdFilter}
          onChange={e => setSessionIdFilter(e.target.value)}
          style={{ fontFamily: 'var(--font-m)', fontSize: 12, padding: '3px 8px', background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 4, width: 240 }}
        />
        <span style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 var(--space-1)' }} />
        <select value={agentFilter} onChange={e => setAgentFilter(e.target.value)}>
          <option value="">{t('sessions.allAgents')}</option>
          {(statsData?.agents || []).map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <select value={timeFilter} onChange={e => setTimeFilter(e.target.value)}>
          <option value="today">{t('sessions.todayFilter')}</option>
          <option value="7d">{t('sessions.last7d')}</option>
          <option value="30d">{t('sessions.last30d')}</option>
          <option value="all">{t('sessions.allTime')}</option>
        </select>
        <select value={cronFilter} onChange={e => setCronFilter(e.target.value)}>
          <option value="all">{t('sessions.allSessions')}</option>
          <option value="cron">{t('sessions.cronOnly')}</option>
          <option value="non-cron">{t('sessions.nonCron')}</option>
        </select>
        <span style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 var(--space-1)' }} />
        <select value={sortBy} onChange={e => setSortBy(e.target.value)}>
          <option value="newest">{t('sessions.sortNewest')}</option>
          <option value="tokens">{t('sessions.sortTokens')}</option>
          <option value="cost">{t('sessions.sortCost')}</option>
          <option value="errors">{t('sessions.sortErrors')}</option>
          <option value="cache_hit_asc">{t('sessions.sortCacheHit')}</option>
        </select>
        {(agentFilter || cronFilter !== 'all' || timeFilter !== 'all' || sortBy !== 'newest' || sessionIdFilter) && (
          <button
            onClick={() => { setAgentFilter(''); setTimeFilter('all'); setCronFilter('all'); setSortBy('newest'); setSessionIdFilter(''); }}
            style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--muted)', padding: 'var(--space-1) var(--space-2)', cursor: 'pointer', fontSize: 12, letterSpacing: '.08em', textTransform: 'uppercase' }}
          >
            {t('common.clear')}
          </button>
        )}
      </div>

      <div style={{ overflow: 'auto' }}>
        {/* ── Sessions table ── */}
          {sessionsError ? (
            <div style={{ padding: 'var(--space-4)' }}><AlertBanner variant="error">{sessionsError}</AlertBanner></div>
          ) : loading ? (
            <Loading />
          ) : (
            <table style={TABLE_STYLE}>
              <thead>
                <tr>
                  <th style={TH_STYLE}>{t('common.session')}</th>
                  <th style={TH_STYLE}>{t('common.agent')}</th>
                  <th style={TH_STYLE}>{t('sessions.liveStatus')}</th>
                  <th style={TH_STYLE}>{t('common.model')}</th>
                  <th style={TH_STYLE}>{t('common.tokens')}</th>
                  <th style={TH_STYLE}>{t('common.cost')}</th>
                  <th style={{ ...TH_STYLE, position: 'relative' }}>
                    <span className="sess-tip-cache" style={{ cursor: 'help' }}>
                      {t('sessions.cacheHit')}
                      <span style={tipBadge}>?</span>
                      <span className="sess-tip-cache-box" style={{ ...tipBox, width: 280 }}>
                        {t('sessions.cacheHitTooltip')}{`\n\n`}
                        <span style={{ color: '#22c55e' }}>{t('sessions.cacheGreen')}</span>{`: ${t('sessions.cacheGreenDesc')}\n`}
                        <span style={{ color: '#eab308' }}>{t('sessions.cacheAmber')}</span>{`: ${t('sessions.cacheAmberDesc')}\n`}
                        <span style={{ color: '#ef4444' }}>{t('sessions.cacheRed')}</span>{`: ${t('sessions.cacheRedDesc')}`}
                      </span>
                    </span>
                    <style>{`.sess-tip-cache:hover .sess-tip-cache-box { display: block !important; }`}</style>
                  </th>
                  <th style={{ ...TH_STYLE, position: 'relative' }}>
                    <span className="sess-tip-ctx" style={{ cursor: 'help' }}>
                      {t('sessions.contextPressure')}
                      <span style={tipBadge}>?</span>
                      <span className="sess-tip-ctx-box" style={{ ...tipBox, width: 260 }}>
                        {t('sessions.contextPressureTooltip')}{`\n\n`}
                        <span style={{ color: '#22c55e' }}>{t('common.healthy')}</span>{`: 0–69%\n`}
                        <span style={{ color: '#eab308' }}>{t('common.warning')}</span>{`: 70–89%\n`}
                        <span style={{ color: '#ef4444' }}>{t('common.critical')}</span>{`: ≥ 90%`}
                      </span>
                    </span>
                    <style>{`.sess-tip-ctx:hover .sess-tip-ctx-box { display: block !important; }`}</style>
                  </th>
                  <th style={{ ...TH_STYLE, position: 'relative', width: 52 }}>
                    <span className="sess-tip-burn" style={{ cursor: 'help' }}>
                      {t('sessions.burnRate')}
                      <span style={tipBadge}>?</span>
                      <span className="sess-tip-burn-box" style={{ ...tipBox, width: 280 }}>
                        {t('sessions.burnRateTooltip')}{`\n\n`}
                        <span style={{ color: '#ef4444' }}>{t('sessions.rising')}</span>{`: avg growth > 5K tokens/msg\n`}
                        <span style={{ color: '#eab308' }}>{t('sessions.stable')}</span>{`: ±5K\n`}
                        <span style={{ color: '#22c55e' }}>{t('sessions.cooling')}</span>{`: avg growth < −5K\n\n`}
                        {t('sessions.burnRateFormula')}
                      </span>
                    </span>
                    <style>{`.sess-tip-burn:hover .sess-tip-burn-box { display: block !important; }`}</style>
                  </th>
                  <th style={{ ...TH_STYLE, position: 'relative' }}>
                    <span className="sess-tip-status" style={{ cursor: 'help' }}>
                      {t('sessions.lastSignal')}
                      <span style={tipBadge}>?</span>
                      <span className="sess-tip-status-box" style={{ ...tipBox, width: 300 }}>
                        {t('sessions.lastSignalTooltip')}{`\n\n`}
                        <span style={{ color: '#888' }}>{t('sessions.normalSignal')}</span>{` ${t('sessions.normalSignalDesc')}\n`}
                        <span style={{ color: '#ef4444' }}>{t('sessions.errorSignal')}</span>{` ${t('sessions.errorSignalDesc')}\n`}
                        <span style={{ color: '#eab308' }}>{t('sessions.abortedSignal')}</span>{` ${t('sessions.abortedSignalDesc')}\n`}
                        <span style={{ color: '#f97316' }}>{t('sessions.maxTokensSignal')}</span>{` ${t('sessions.maxTokensSignalDesc')}\n`}
                        <span style={{ color: '#3b82f6' }}>{t('sessions.activeSignal')}</span>{` ${t('sessions.activeSignalDesc')}`}
                      </span>
                    </span>
                    <style>{`.sess-tip-status:hover .sess-tip-status-box { display: block !important; }`}</style>
                  </th>
                  <th style={TH_STYLE}>{t('common.errors')}</th>
                  <th style={TH_STYLE}>{t('common.duration')}</th>
                  <th style={{ ...TH_STYLE, position: 'relative' }}>
                    <span className="sess-tip-avg" style={{ cursor: 'help' }}>
                      {t('sessions.avgPerMsg')}
                      <span style={tipBadge}>?</span>
                      <span className="sess-tip-avg-box" style={{ ...tipBox, width: 240 }}>
                        {t('sessions.avgTooltip')}
                      </span>
                    </span>
                    <style>{`.sess-tip-avg:hover .sess-tip-avg-box { display: block !important; }`}</style>
                  </th>
                  <th style={TH_STYLE}>{t('sessions.lastActive')}</th>
                  <th style={TH_STYLE}>{t('sessions.started')}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(s => {
                  const rate = cacheHitRate(s.cache_read || 0, s.input_tokens || 0);
                  const hitPct = fmtPct(rate, 4);
                  const hitClr = rate >= 0.8 ? 'var(--green, #22c55e)' : rate >= 0.5 ? 'var(--yellow, #eab308)' : 'var(--red, #ef4444)';
                  const pColor = s.utilizationPct >= 90 ? '#ef4444' : s.utilizationPct >= 70 ? '#eab308' : '#22c55e';
                  const pBg = s.utilizationPct >= 90 ? 'rgba(239,68,68,0.15)' : s.utilizationPct >= 70 ? 'rgba(234,179,8,0.15)' : 'rgba(34,197,94,0.15)';
                  const pLabel = s.utilizationPct >= 90 ? t('common.critical') : s.utilizationPct >= 70 ? t('common.warning') : t('common.healthy');
                  const durationMin = Math.round((s.duration_ms || 0) / 60000);
                  const durationStr = durationMin < 60 ? `${durationMin}m` : `${Math.floor(durationMin / 60)}h${durationMin % 60}m`;
                  const avgPerMsg = s.total_messages > 0 ? Math.round(s.total_tokens / s.total_messages) : 0;
                  const lastActiveParts = fmtDateParts(s.last_message_at || s.started_at);
                  const startedParts = fmtDateParts(s.started_at);
                  const isSelected = s.id === selected;
                  return (
                    <React.Fragment key={s.id}>
                    <tr
                      ref={isSelected ? selectedRowRef : null}
                      onClick={() => toggleSessionDetail(s.id)}
                      style={{
                        cursor: 'pointer',
                        background: isSelected ? 'var(--surface2)' : undefined,
                        borderLeft: isSelected ? '3px solid var(--C-blue)' : '3px solid transparent',
                      }}
                    >
                      <td style={TD_STYLE}>
                        <span style={{ ...MONO_STYLE, color: '#60a5fa', cursor: 'pointer' }}>{s.id.slice(0, 12)}…</span>
                      </td>
                      <td style={TD_STYLE}>{s.agent_name}</td>
                      <td style={TD_STYLE}>
                        {(() => {
                          const IDLE_THRESHOLD = 30 * 60 * 1000;
                          const lastTs = s.last_message_at || s.started_at;
                          const isRunning = (Date.now() - lastTs) < IDLE_THRESHOLD;
                          return (
                            <span style={{
                              fontSize: 11, padding: '1px 6px', borderRadius: 9, fontWeight: 500,
                              background: isRunning ? 'rgba(34,197,94,0.15)' : 'rgba(59,130,246,0.15)',
                              color: isRunning ? '#22c55e' : '#60a5fa',
                              whiteSpace: 'nowrap',
                            }}>
                              {isRunning ? t('common.running') : t('common.idle')}
                            </span>
                          );
                        })()}
                      </td>
                      <td style={TD_STYLE}><span style={MONO_STYLE}>{s.primary_model}</span></td>
                      <td style={TD_STYLE}><strong>{fmtTokens(s.total_tokens)}</strong></td>
                      <td style={TD_STYLE}>{fmtCost(s.total_cost)}</td>
                      <td style={TD_STYLE}><span style={{ color: hitClr }}>{hitPct}</span></td>
                      <td style={TD_STYLE}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 9, fontWeight: 500, background: pBg, color: pColor, whiteSpace: 'nowrap', flexShrink: 0 }}>{pLabel}</span>
                          <span style={{ color: pColor, fontVariantNumeric: 'tabular-nums' }}>{fmtPct((s.utilizationPct ?? 0) / 100, 1)}</span>
                          <div style={{ width: 40, height: 3, borderRadius: 2, background: 'var(--border)' }}>
                            <div style={{ width: `${Math.min(100, s.utilizationPct ?? 0)}%`, height: '100%', borderRadius: 2, background: pColor }} />
                          </div>
                        </div>
                      </td>
                      <td style={TD_STYLE}>
                        <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 9, fontWeight: 500,
                          background: s.pacing === 'rising' ? 'rgba(239,68,68,0.15)' : s.pacing === 'stable' ? 'rgba(234,179,8,0.15)' : s.pacing === 'cooling' ? 'rgba(34,197,94,0.15)' : 'rgba(100,100,100,0.15)',
                          color: s.pacing === 'rising' ? '#ef4444' : s.pacing === 'stable' ? '#eab308' : s.pacing === 'cooling' ? '#22c55e' : '#888' }}>
                          {s.pacing === 'rising' ? t('sessions.rising') : s.pacing === 'stable' ? t('sessions.stable') : s.pacing === 'cooling' ? t('sessions.cooling') : '—'}
                        </span>
                      </td>
                      {(() => {
                        const sr = s.last_stop_reason || '';
                        // pi-ai stop_reason values OpenClaw actually emits:
                        // 'stop' / 'toolUse' / 'error' / 'aborted' / 'length' (= max_tokens)
                        const statusMap: Record<string, { label: string; color: string; bg: string }> = {
                          'stop': { label: t('sessions.normalSignal'), color: '#888', bg: 'rgba(100,100,100,0.15)' },
                          'error': { label: t('sessions.errorSignal'), color: '#ef4444', bg: 'rgba(239,68,68,0.15)' },
                          'aborted': { label: t('sessions.abortedSignal'), color: '#eab308', bg: 'rgba(234,179,8,0.15)' },
                          'length': { label: t('sessions.maxTokensSignal'), color: '#f97316', bg: 'rgba(249,115,22,0.15)' },
                          'toolUse': { label: t('sessions.activeSignal'), color: '#3b82f6', bg: 'rgba(59,130,246,0.15)' },
                        };
                        const st = statusMap[sr] || { label: sr || '—', color: '#888', bg: 'rgba(100,100,100,0.15)' };
                        return (
                          <td style={TD_STYLE}>
                            <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 9, fontWeight: 500, background: st.bg, color: st.color }}>{st.label}</span>
                          </td>
                        );
                      })()}
                      <td style={{ ...TD_STYLE, color: s.error_count > 0 ? '#ef4444' : 'var(--muted)' }}>
                        {s.error_count > 0 ? s.error_count : '—'}
                      </td>
                      <td style={TD_STYLE}>{durationStr}</td>
                      <td style={TD_STYLE}>{fmtTokens(avgPerMsg)}</td>
                      <td style={{ ...TD_STYLE, fontSize: 12, lineHeight: 1.4, color: 'var(--muted)' }}>{lastActiveParts.date}<br/>{lastActiveParts.time}</td>
                      <td style={{ ...TD_STYLE, fontSize: 12, lineHeight: 1.4, color: 'var(--muted)' }}>{startedParts.date}<br/>{startedParts.time}</td>
                    </tr>
                    {isSelected && detail && (
                      <tr>
                        <td colSpan={17} style={{ padding: 0, borderBottom: '2px solid var(--C-blue)' }}>
                          <div style={{ background: '#0f1724', padding: 'var(--space-5) var(--space-6)' }}>
                            {/* Header */}
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                                <span style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)' }}>{t('sessions.sessionId')}</span>
                                <span style={{ fontFamily: 'var(--font-m)', fontSize: 12, color: 'var(--text)' }}>{detail.session.id}</span>
                                <button
                                  title={t('sessions.copySessionIdTitle')}
                                  onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(detail.session.id); const btn = e.currentTarget; btn.textContent = t('common.copied'); setTimeout(() => { btn.textContent = t('common.copyId'); }, COPIED_FEEDBACK_MS); }}
                                  style={{ background: 'rgba(96,165,250,0.15)', border: '1px solid rgba(96,165,250,0.4)', borderRadius: 4, color: '#60a5fa', cursor: 'pointer', fontSize: 11, padding: '2px 8px', fontFamily: 'var(--font-m)', letterSpacing: '.02em' }}
                                >{t('common.copyId')}</button>
                                <button
                                  title={t('sessions.openInTimelineTitle')}
                                  onClick={e => { e.stopPropagation(); navigate(`/timeline?session=${detail.session.id}`); }}
                                  style={{ background: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.4)', borderRadius: 4, color: '#a78bfa', cursor: 'pointer', fontSize: 11, padding: '2px 8px', fontFamily: 'var(--font-m)', letterSpacing: '.02em' }}
                                >{t('sessions.viewInTimeline')}</button>
                              </div>
                              <button onClick={e => { e.stopPropagation(); setSelected(null); }} style={{ background: 'none', border: 'none', color: 'var(--faint)', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>×</button>
                            </div>
                            <div style={{ marginTop: 10, marginBottom: 'var(--space-4)' }}>
                              <TabBar tabs={[{ key: 'overview', label: t('common.overview') }, { key: 'messages', label: t('common.messages') }]} active={detailTab} onChange={setDetailTab} />
                            </div>

                            {detailTab === 'overview' && (<>
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-5)' }}>
                                {/* Col 1: Stats */}
                                {(() => {
                                  const ds = detail.session;
                                  const listSession = filtered.find(x => x.id === ds.id);
                                  const lastMsgAt = listSession?.last_message_at || null;
                                  const dur = ds.duration_ms > 0 ? ds.duration_ms : (lastMsgAt ? lastMsgAt - ds.started_at : 0);
                                  const lastUpdated = lastMsgAt ? fmtDatetime(lastMsgAt) : '—';
                                  const statStyle: React.CSSProperties = { fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)' };
                                  const valStyle: React.CSSProperties = { fontSize: 13, color: 'var(--text)', fontWeight: 500, marginTop: 2, fontVariantNumeric: 'tabular-nums' };
                                  return (
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
                                  <div><div style={statStyle}>{t('sessions.detailAgent')}</div><div style={valStyle}>{ds.agent_name}</div></div>
                                  <div><div style={statStyle}>{t('sessions.detailDuration')}</div><div style={valStyle}>{fmtMs(dur)}</div></div>
                                  <div><div style={statStyle}>{t('sessions.detailStarted')}</div><div style={{ ...valStyle, fontFamily: 'var(--font-m)', fontSize: 12 }}>{fmtDatetime(ds.started_at)}</div></div>
                                  <div><div style={statStyle}>{t('sessions.detailLastUpdated')}</div><div style={{ ...valStyle, fontFamily: 'var(--font-m)', fontSize: 12 }}>{lastUpdated}</div></div>
                                  <div><div style={statStyle}>{t('sessions.detailMessages')}</div><div style={valStyle}>{ds.total_messages}</div></div>
                                  <div><div style={statStyle}>{t('sessions.detailErrors')}</div><div style={{ ...valStyle, color: ds.error_count > 0 ? 'var(--C-rose)' : 'var(--text)' }}>{ds.error_count || '—'}</div></div>
                                  <div><div style={statStyle}>{t('sessions.detailCost')}</div><div style={{ fontFamily: 'var(--font-b)', fontSize: 16, color: 'var(--C-blue)', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>{fmtCost(ds.total_cost)}</div></div>
                                  <div><div style={statStyle}>{t('sessions.detailTokens')}</div><div style={valStyle}>{fmtTokens(ds.total_tokens)}</div></div>
                                  <div style={{ gridColumn: '1 / -1' }}>
                                    <div style={statStyle}>{t('sessions.detailIsCron')}</div>
                                    <div style={{ ...valStyle, color: ds.is_cron === 1 ? '#fbbf24' : 'var(--muted)' }}>
                                      {ds.is_cron === 1 ? `${t('sessions.detailYes')}${ds.cron_task ? ` · ${ds.cron_task}` : ''}` : t('sessions.detailNo')}
                                    </div>
                                  </div>
                                </div>
                                  );
                                })()}
                                {/* Col 2: Cache */}
                                <div>
                                  {detailCache && detailCache.barTotal > 0 ? (<>
                                    <div style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 'var(--space-2)' }}>{t('sessions.cache')}</div>
                                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
                                      <span style={{ fontSize: 28, fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1, color: detailCache.rate >= 0.8 ? 'var(--C-green)' : detailCache.rate >= 0.5 ? 'var(--C-amber)' : 'var(--C-rose)' }}>{fmtPct(detailCache.rate, 4)}</span>
                                      <span style={{ fontSize: 13, color: 'var(--muted)' }}>{t('sessions.cacheHitRateLabel')}</span>
                                    </div>
                                    <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', background: 'var(--surface2)', marginBottom: 'var(--space-2)' }}>
                                      <div style={{ width: `${(detailCache.totalInput / detailCache.barTotal) * 100}%`, background: '#3b82f6' }} />
                                      <div style={{ width: `${(detailCache.totalCacheRead / detailCache.barTotal) * 100}%`, background: '#22c55e' }} />
                                      <div style={{ width: `${(detailCache.totalCacheWrite / detailCache.barTotal) * 100}%`, background: '#a855f7' }} />
                                    </div>
                                    <div style={{ display: 'flex', gap: 'var(--space-3)', fontSize: 12, color: 'var(--muted)', flexWrap: 'wrap' }}>
                                      <span><span style={{ color: '#3b82f6' }}>●</span> {t('sessions.cacheInput')} {fmtTokens(detailCache.totalInput)}</span>
                                      <span><span style={{ color: '#22c55e' }}>●</span> {t('sessions.cacheRead')} {fmtTokens(detailCache.totalCacheRead)}</span>
                                      <span><span style={{ color: '#a855f7' }}>●</span> {t('sessions.cacheWrite')} {fmtTokens(detailCache.totalCacheWrite)}</span>
                                    </div>
                                  </>) : <div style={{ fontSize: 13, color: 'var(--muted)' }}>{t('sessions.noCacheData')}</div>}
                                </div>
                                {/* Col 3: Models + Tools */}
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                                  {detail.modelBreakdown.length > 0 && (<div>
                                    <div style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 'var(--space-2)' }}>{t('sessions.models')}</div>
                                    {detail.modelBreakdown.map(m => (
                                      <div key={m.model} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0', color: 'var(--text)' }}>
                                        <span>{m.model.replace('claude-', '').replace('-latest', '')}</span>
                                        <span style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{m.message_count} msgs · {fmtCost(m.cost_total)}</span>
                                      </div>
                                    ))}
                                  </div>)}
                                  {detail.toolBreakdown.length > 0 && (<div>
                                    <div style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 'var(--space-2)' }}>{t('sessions.toolsLabel')}</div>
                                    {detail.toolBreakdown.map(tb => (
                                      <div key={tb.tool_name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0', color: 'var(--text)' }}>
                                        <span>{tb.tool_name}</span>
                                        <span style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{tb.call_count}× · {fmtMs(tb.avg_duration_ms)}</span>
                                      </div>
                                    ))}
                                  </div>)}
                                </div>
                              </div>
                              {/* Three charts stacked vertically */}
                              {(costGrowthData.length > 0 || tokenGrowthData.length > 0 || contextPressureData.length > 0) && (
                                <div style={{ marginTop: 'var(--space-5)', borderTop: '1px solid var(--border)', paddingTop: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
                                  {/* Cost Delta */}
                                  {costGrowthData.length > 0 && (
                                    <div style={{ height: 170 }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>
                                        <span style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)' }}>{t('sessions.costPerStep')}</span>
                                        <span style={{ fontSize: 10, color: 'var(--faint)' }}>{t('sessions.costDeltaPerStep')}</span>
                                      </div>
                                      <ResponsiveContainer width="100%" height={130}>
                                        <BarChart data={costGrowthData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                                          <XAxis dataKey="seq" tick={{ fontSize: 10, fill: 'var(--faint)' }} tickLine={false} axisLine={false} />
                                          <YAxis tick={{ fontSize: 10, fill: 'var(--faint)' }} tickLine={false} axisLine={false} tickFormatter={(v: number) => fmtCost(v)} width={52} />
                                          <Tooltip cursor={false} contentStyle={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 6, fontSize: 12, color: '#ccc' }} wrapperStyle={{ background: 'transparent', border: 'none', boxShadow: 'none', outline: 'none' }} labelStyle={{ color: '#aaa' }} formatter={(v: unknown) => [fmtCost(Number(v)), 'Cost']} labelFormatter={(l: unknown) => `Step ${l}`} />
                                          <Bar dataKey="cost" fill="#a78bfa" radius={[2, 2, 0, 0]} isAnimationActive={false} />
                                        </BarChart>
                                      </ResponsiveContainer>
                                    </div>
                                  )}
                                  {/* Token Delta */}
                                  {tokenGrowthData.length > 0 && (
                                    <div style={{ height: 170 }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>
                                        <span style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)' }}>{t('sessions.tokensPerStep')}</span>
                                        <span style={{ fontSize: 10, color: 'var(--faint)' }}>{t('sessions.tokenDeltaPerStep')}</span>
                                      </div>
                                      <ResponsiveContainer width="100%" height={130}>
                                        <BarChart data={tokenGrowthData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                                          <XAxis dataKey="seq" tick={{ fontSize: 10, fill: 'var(--faint)' }} tickLine={false} axisLine={false} />
                                          <YAxis tick={{ fontSize: 10, fill: 'var(--faint)' }} tickLine={false} axisLine={false} tickFormatter={(v: number) => fmtTokens(v)} width={45} />
                                          <Tooltip cursor={false} contentStyle={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 6, fontSize: 12, color: '#ccc' }} wrapperStyle={{ background: 'transparent', border: 'none', boxShadow: 'none', outline: 'none' }} labelStyle={{ color: '#aaa' }} formatter={(v: unknown) => [fmtTokens(Number(v)), 'Tokens']} labelFormatter={(l: unknown) => `Step ${l}`} />
                                          <Bar dataKey="tokens" fill="var(--C-blue)" radius={[2, 2, 0, 0]} isAnimationActive={false} />
                                        </BarChart>
                                      </ResponsiveContainer>
                                    </div>
                                  )}
                                  {/* Context Pressure */}
                                  {contextPressureData.length > 0 && (
                                    <div style={{ height: 170 }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>
                                        <span style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)' }}>{t('sessions.contextPressureLabel')}</span>
                                        <span style={{ fontSize: 10, color: 'var(--faint)' }}>{t('sessions.contextWindowPerStep', { limit: fmtTokens(contextLimit) })}</span>
                                      </div>
                                      <ResponsiveContainer width="100%" height={130}>
                                        <LineChart data={contextPressureData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                                          <XAxis dataKey="seq" tick={{ fontSize: 10, fill: 'var(--faint)' }} tickLine={false} axisLine={false} />
                                          <YAxis tick={{ fontSize: 10, fill: 'var(--faint)' }} tickLine={false} axisLine={false} tickFormatter={(v: number) => fmtTokens(v)} width={45} domain={[0, (dataMax: number) => Math.max(dataMax * 1.1, contextLimit * 0.3)]} />
                                          <Tooltip cursor={false} content={(props: any) => {
                                            if (!props.active || !props.payload?.length) return null;
                                            const seq = props.label;
                                            const val = props.payload[0]?.value;
                                            const d = contextPressureData.find(p => p.seq === seq);
                                            const isError = d?.errorContext !== null;
                                            return (
                                              <div style={{ background: '#1a1a1a', border: `1px solid ${isError ? '#ef4444' : '#333'}`, borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#ccc', minWidth: 160 }}>
                                                {isError && (
                                                  <div style={{ color: '#ef4444', fontWeight: 700, fontSize: 11, letterSpacing: '.08em', marginBottom: 5 }}>
                                                    ● {t('sessions.errorStep')}
                                                  </div>
                                                )}
                                                <div style={{ color: '#aaa', marginBottom: 4 }}>{t('sessions.step', { seq })}</div>
                                                <div style={{ color: isError ? '#f97316' : '#ccc' }}>
                                                  {t('sessions.contextColon')} <strong>{fmtTokens(val)}</strong>
                                                </div>
                                                {isError && <div style={{ color: '#666', fontSize: 10, marginTop: 3 }}>{t('sessions.carriedFromLastOk')}</div>}
                                              </div>
                                            );
                                          }} />
                                          <ReferenceLine y={contextLimit} stroke="#ef4444" strokeDasharray="6 3" strokeWidth={1} label={{ value: t('sessions.limitLabel', { limit: fmtTokens(contextLimit) }), position: 'right', fontSize: 9, fill: '#ef4444' }} />
                                          <ReferenceLine y={contextLimit * 0.7} stroke="#eab308" strokeDasharray="4 4" strokeWidth={0.5} />
                                          <Line type="monotone" dataKey="contextSize" stroke="#f97316" strokeWidth={1.5} dot={(props: any) => {
                                            const d = contextPressureData[props.index];
                                            if (!d || d.errorContext === null) return <circle key={props.index} r={0} />;
                                            return <circle key={props.index} cx={props.cx} cy={props.cy} r={3.5} fill="#ef4444" stroke="none" />;
                                          }} />
                                        </LineChart>
                                      </ResponsiveContainer>
                                    </div>
                                  )}
                                </div>
                              )}
                            </>)}

                            {detailTab === 'messages' && (<>
                              <div style={{ maxHeight: 600, overflow: 'auto' }}>
                                {!messages || messages.length === 0 ? (
                                  <div style={{ padding: 'var(--space-3) 0', color: 'var(--muted)', fontSize: 13 }}>{t('sessions.noMessagesFound')}</div>
                                ) : (
                                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                                    <thead><tr>
                                      <th style={{ ...TH_STYLE, width: 20 }}></th>
                                      <th style={TH_STYLE}>{t('sessions.msgSeq')}</th><th style={TH_STYLE}>{t('sessions.msgModel')}</th><th style={TH_STYLE}>{t('sessions.msgRole')}</th><th style={TH_STYLE}>{t('sessions.msgIn')}</th><th style={TH_STYLE}>{t('sessions.msgOut')}</th><th style={TH_STYLE}>{t('sessions.msgCacheR')}</th><th style={TH_STYLE}>{t('sessions.msgCacheW')}</th><th style={TH_STYLE}>{t('sessions.msgTotal')}</th><th style={TH_STYLE}>{t('sessions.msgCost')}</th><th style={TH_STYLE}>{t('sessions.msgError')}</th><th style={TH_STYLE}>{t('sessions.msgLatency')}</th>
                                    </tr></thead>
                                    <tbody>
                                      {messages.map(msg => {
                                        const isExp = expandedMsgs.has(msg.id);
                                        return (
                                        <React.Fragment key={msg.id}>
                                        <tr
                                          onClick={e => { e.stopPropagation(); setExpandedMsgs(prev => { const next = new Set(prev); if (next.has(msg.id)) next.delete(msg.id); else { next.add(msg.id); if (!msgContents[msg.id] && selected) { fetch(`/api/sessions/${selected}/messages/${msg.id}/content`).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }).then(d => { if (d.content) setMsgContents(prev2 => ({ ...prev2, [msg.id]: d.content })); }).catch(() => {}); } } return next; }); }}
                                          style={{ cursor: 'pointer', background: isExp ? 'rgba(59,130,246,0.05)' : undefined }}
                                        >
                                          <td style={{ ...TD_STYLE, color: 'var(--muted)', fontSize: 10 }}>{isExp ? '▼' : '▶'}</td>
                                          <td style={{ ...TD_STYLE, color: 'var(--faint)' }}>{msg.seq}</td>
                                          <td style={TD_STYLE}><span style={MONO_STYLE}>{(msg.model || '').replace('claude-', '').slice(0, 20)}</span></td>
                                          <td style={{ ...TD_STYLE, color: 'var(--muted)' }}>{t(`common.role${msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'Other'}`)}</td>
                                          <td style={TD_STYLE}>{fmtTokens(msg.input_tokens)}</td>
                                          <td style={TD_STYLE}>{fmtTokens(msg.output_tokens)}</td>
                                          <td style={{ ...TD_STYLE, color: msg.cache_read > 0 ? 'var(--C-green)' : undefined }}>{fmtTokens(msg.cache_read)}</td>
                                          <td style={{ ...TD_STYLE, color: msg.cache_write > 0 ? 'var(--C-purple, #a855f7)' : undefined }}>{fmtTokens(msg.cache_write)}</td>
                                          <td style={{ ...TD_STYLE, fontWeight: 500 }}>{fmtTokens(msg.total_tokens)}</td>
                                          <td style={{ ...TD_STYLE, color: 'var(--C-blue)' }}>{fmtCost(msg.cost_total)}</td>
                                          <td style={{ ...TD_STYLE, color: msg.has_error ? '#ef4444' : 'var(--muted)' }}>{msg.has_error ? t('sessions.msgYes') : '—'}</td>
                                          <td style={{ ...TD_STYLE, color: 'var(--faint)' }}>{fmtMs(msg.latency_ms)}</td>
                                        </tr>
                                        {isExp && (
                                          <tr>
                                            <td colSpan={12} style={{ padding: 0, borderBottom: '1px solid var(--border)' }}>
                                              <div style={{ padding: 'var(--space-3) var(--space-4)', background: '#151e2e', fontSize: 12 }}>
                                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
                                                  <div><span style={{ color: 'var(--muted)' }}>{t('sessions.messageId')}</span><br/><span style={{ fontFamily: 'var(--font-m)', fontSize: 11, wordBreak: 'break-all' }}>{msg.id}</span></div>
                                                  <div><span style={{ color: 'var(--muted)' }}>{t('sessions.parentId')}</span><br/><span style={{ fontFamily: 'var(--font-m)', fontSize: 11, wordBreak: 'break-all' }}>{msg.parent_id || '—'}</span></div>
                                                  <div><span style={{ color: 'var(--muted)' }}>{t('sessions.timestamp')}</span><br/><span style={{ fontFamily: 'var(--font-m)', fontSize: 11 }}>{fmtDatetime(msg.timestamp)}</span></div>
                                                  <div><span style={{ color: 'var(--muted)' }}>{t('sessions.role')}</span><br/><span>{t(`common.role${msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'Other'}`)}</span></div>
                                                </div>
                                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
                                                  <div><span style={{ color: 'var(--muted)' }}>{t('sessions.inputTokens')}</span><br/><span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtTokens(msg.input_tokens)}</span></div>
                                                  <div><span style={{ color: 'var(--muted)' }}>{t('sessions.outputTokens')}</span><br/><span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtTokens(msg.output_tokens)}</span></div>
                                                  <div><span style={{ color: 'var(--muted)' }}>{t('sessions.cacheReadLabel')}</span><br/><span style={{ fontVariantNumeric: 'tabular-nums', color: msg.cache_read > 0 ? 'var(--C-green)' : undefined }}>{fmtTokens(msg.cache_read)}</span></div>
                                                  <div><span style={{ color: 'var(--muted)' }}>{t('sessions.cacheWriteLabel')}</span><br/><span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtTokens(msg.cache_write)}</span></div>
                                                </div>
                                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 'var(--space-3)' }}>
                                                  <div><span style={{ color: 'var(--muted)' }}>{t('sessions.totalTokens')}</span><br/><span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmtTokens(msg.total_tokens)}</span></div>
                                                  <div><span style={{ color: 'var(--muted)' }}>{t('sessions.costLabel')}</span><br/><span style={{ color: 'var(--C-blue)', fontVariantNumeric: 'tabular-nums' }}>{fmtCost(msg.cost_total)}</span></div>
                                                  <div>
                                                    <span style={{ color: 'var(--muted)', position: 'relative', display: 'inline-block' }} className="msg-stop-wrap">
                                                      {t('sessions.stopReason')} <span style={tipBadge}>?</span>
                                                      <span className="msg-stop-tip" style={{ ...tipBox, width: 260 }}>
                                                        {`${t('sessions.stopReasonTooltip')}\n\n`}
                                                        <span style={{ color: '#22c55e' }}>stop</span>{` ${t('sessions.stopReasonFinished')}\n`}
                                                        <span style={{ color: '#3b82f6' }}>toolUse</span>{` ${t('sessions.stopReasonToolUseDesc')}\n`}
                                                        <span style={{ color: '#f97316' }}>length</span>{` ${t('sessions.stopReasonMaxTokensDesc')}\n`}
                                                        <span style={{ color: '#ef4444' }}>error</span>{` ${t('sessions.stopReasonErrorDesc')}\n`}
                                                        <span style={{ color: '#eab308' }}>aborted</span>{` ${t('sessions.abortedSignalDesc', '— cancelled by user')}`}
                                                      </span>
                                                      <style>{`.msg-stop-wrap:hover .msg-stop-tip { display: block !important; }`}</style>
                                                    </span>
                                                    <br/><span>{msg.stop_reason || '—'}</span>
                                                  </div>
                                                  <div><span style={{ color: 'var(--muted)' }}>{t('sessions.latency')}</span><br/><span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMs(msg.latency_ms)}</span></div>
                                                </div>
                                                {msg.has_error > 0 && msg.error_message && (
                                                  <div style={{ marginTop: 'var(--space-3)', padding: 'var(--space-2) var(--space-3)', background: 'rgba(239,68,68,0.1)', borderRadius: 4, border: '1px solid rgba(239,68,68,0.2)' }}>
                                                    <div style={{ fontSize: 11, color: '#ef4444', fontWeight: 600, marginBottom: 4 }}>{t('sessions.errorLabel')}</div>
                                                    <div style={{ fontSize: 12, color: '#fca5a5', whiteSpace: 'pre-wrap', fontFamily: 'var(--font-m)' }}>{msg.error_message}</div>
                                                  </div>
                                                )}
                                                {/* Message content from JSONL */}
                                                <div style={{ marginTop: 'var(--space-3)', borderTop: '1px solid var(--border)', paddingTop: 'var(--space-3)' }}>
                                                  <div style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 'var(--space-2)' }}>{t('sessions.content')}</div>
                                                  {msgContents[msg.id] ? (
                                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                                                      {(msgContents[msg.id] as Array<Record<string, unknown>>).map((item, idx) => {
                                                        const isToolCall = item.type === 'tool_use' || item.type === 'toolCall';
                                                        const isToolResult = item.type === 'tool_result' || item.type === 'toolResult';
                                                        const isText = item.type === 'text';
                                                        const toolInput = (item as Record<string, unknown>).input || (item as Record<string, unknown>).arguments;
                                                        return (
                                                        <div key={idx} style={{ padding: 'var(--space-2) var(--space-3)', borderRadius: 4, background: isToolCall ? 'rgba(59,130,246,0.08)' : 'var(--bg-1)', border: `1px solid ${isToolCall ? 'rgba(59,130,246,0.2)' : 'var(--border)'}` }}>
                                                          <div style={{ fontSize: 10, color: isToolCall ? '#60a5fa' : isToolResult ? '#a855f7' : 'var(--muted)', fontWeight: 600, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.08em' }}>
                                                            {isToolCall ? 'TOOL_USE' : isToolResult ? 'TOOL_RESULT' : String(item.type)}{isToolCall && item.name ? `: ${String(item.name)}` : ''}
                                                          </div>
                                                          {isText && <div style={{ fontSize: 12, color: 'var(--text)', whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto', lineHeight: 1.5 }}>{String(item.text || '')}</div>}
                                                          {isToolCall && !!toolInput && (
                                                            <pre style={{ fontSize: 11, color: '#93c5fd', margin: 0, whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto', fontFamily: 'var(--font-m)' }}>{JSON.stringify(toolInput, null, 2)}</pre>
                                                          )}
                                                          {isToolResult && (
                                                            <pre style={{ fontSize: 11, color: '#c4b5fd', margin: 0, whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto', fontFamily: 'var(--font-m)' }}>{typeof item.content === 'string' ? item.content : JSON.stringify(item.content, null, 2)}</pre>
                                                          )}
                                                        </div>
                                                        );
                                                      })}
                                                    </div>
                                                  ) : (
                                                    <div style={{ fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>{t('sessions.loadingContent')}</div>
                                                  )}
                                                </div>
                                              </div>
                                            </td>
                                          </tr>
                                        )}
                                        </React.Fragment>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                )}
                              </div>
                            </>)}
                          </div>
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}

      </div>
    </div>
  );
}
