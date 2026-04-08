import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useState, useEffect } from 'react';
import { useFetch, fmtCost, fmtTokens, fmtMs, fmtPct } from '../hooks';
import DataRetentionNote from '../components/DataRetentionNote';
import {
  PageHeader, Loading, AlertBanner,
  KpiStrip, Badge, StatusDot, ProgressBar,
} from '../components/ui';
import {
  ResponsiveContainer, BarChart, Bar, ComposedChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip,
} from 'recharts';

/* ── tiny helpers ────────────────────────────────────────────────────── */
const navLink: React.CSSProperties = { color: 'inherit', textDecoration: 'none' };
const arrow = <ArrowUpRight size={10} style={{ opacity: 0.35, marginLeft: 2, verticalAlign: 'middle' }} />;

function relTime(ts: number | null | undefined, t: TFunction): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 0) {
    // Future timestamp
    const abs = -diff;
    if (abs < 60_000) return 'in <1m';
    if (abs < 3_600_000) return t('common.inH', { n: Math.floor(abs / 60_000) });
    if (abs < 86_400_000) return t('common.inH', { n: Math.floor(abs / 3_600_000) });
    return t('common.inD', { n: Math.floor(abs / 86_400_000) });
  }
  if (diff < 60_000) return t('common.justNow');
  if (diff < 3_600_000) return t('common.minsAgo', { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('common.hoursAgo', { n: Math.floor(diff / 3_600_000) });
  return t('common.daysAgo', { n: Math.floor(diff / 86_400_000) });
}

const HEALTH_COLOR: Record<string, string> = {
  healthy: 'var(--C-green)',
  warning: 'var(--C-amber)',
  error: 'var(--C-rose)',
};
const HEALTH_VARIANT: Record<string, 'green' | 'amber' | 'red'> = {
  healthy: 'green',
  warning: 'amber',
  error: 'red',
};

/* ── Types ───────────────────────────────────────────────────────────── */
type LiveStep =
  | { type: 'user';    text: string }
  | { type: 'ai';      text: string }
  | { type: 'tool';    name: string }
  | { type: 'error';   text: string }
  | { type: 'waiting' }
  | { type: 'done' };

interface LiveSession {
  session_id: string;
  agent_name: string;
  idle_ms: number;
  status: 'running' | 'stuck' | 'idle';
  last_tool: string | null;
  stop_reason: string | null;
  has_recent_failures: boolean;
  task_summary: string | null;
  steps: LiveStep[];
}

interface Stats {
  total_sessions: number; total_agents: number;
  total_messages: number; total_tool_calls: number;
  total_cost: number; total_tokens: number;
  first_ts: number; last_ts: number; agents: string[];
}

interface TokenBreakdown {
  input: number; output: number; cache_read: number; cache_write: number;
  total: number; messages: number;
}

interface KPI {
  today: number; this_week: number; this_month: number; all_time: number;
  avg_daily_30d: number; cache_hit_rate: number;
  cache_read_total: number; cache_write_total: number; input_total: number;
  last_week_cost: number; week_change_pct: number;
  avg_cost_per_session: number;
  sparkline_7d: number[];
  tokens?: {
    today: TokenBreakdown; this_week: TokenBreakdown;
    this_month: TokenBreakdown; all_time: TokenBreakdown;
  };
}

interface ModelRow {
  model: string; message_count: number;
  input_tokens: number; output_tokens: number;
  cache_read: number; cache_write: number;
  total_tokens: number; cost_total: number;
}

interface AgentInfo {
  agent_name: string;
  dir_exists: boolean;
  status: string;
  last_activity_ts: number;
  primary_model: string | null;
  error_rate: number;
  cache_hit_rate: number;
  health: { status: string; reasons: string[] };
  current_task: { text: string; source: string; session_id: string } | null;
  last_session: { ok: boolean; context_pct: number | null } | null;
  today: { sessions: number; cost: number };
  last_30d: { sessions: number; cost: number; errors: number };
  last_7d: { sessions: number; cost: number };
  config: { channels: string[]; skills: string[]; cron_tasks: string[] };
}

interface AgentsResponse {
  agents: AgentInfo[];
}


interface SessionRow {
  id: string; agent_name: string; started_at: number;
  total_messages: number; total_cost: number; total_tokens: number;
  primary_model: string; error_count: number; duration_ms: number;
  status: string; is_cron: boolean; last_message_at: number;
  task_summary?: string;
}

interface CronJob {
  id: string; agentId: string; name: string; enabled: boolean;
  schedule: { kind: string; expr?: string };
  state?: {
    nextRunAtMs?: number; lastRunAtMs?: number;
    lastRunStatus?: string; lastDurationMs?: number;
    consecutiveErrors?: number;
  };
}

interface CronRun {
  ts: number; jobId: string; status: string; durationMs?: number;
}

interface TokensSummary {
  totals: { total: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  cronVsManual?: {
    cron: { tokens: number; cost: number; sessions: number };
    manual: { tokens: number; cost: number; sessions: number };
  };
  byModel?: { model: string; cost: number; messages: number; total: number }[];
}

interface TimelineBucket {
  bucket_ts: number; message_count: number;
  input_tokens: number; output_tokens: number;
  cache_read: number; cache_write: number;
  total_tokens: number; cost_total: number; error_count: number;
}


/* ── Component ───────────────────────────────────────────────────────── */
export default function Overview() {
  const { t, i18n } = useTranslation();
  const dateLocale = i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US';
  // Existing data
  const { data: stats, error: statsError } = useFetch<Stats>('/api/stats');
  const { data: models } = useFetch<ModelRow[]>('/api/stats/models');
  const { data: kpi, loading, error: kpiError } = useFetch<KPI>('/api/timeline/kpi');

  // New data sources
  const { data: agentsResp } = useFetch<AgentsResponse>('/api/stats/agents', []);
  const agents = agentsResp?.agents ?? null;
  const { data: sessions } = useFetch<SessionRow[]>('/api/sessions');
  const { data: cronJobs } = useFetch<CronJob[]>('/api/cron/jobs', []);
  const { data: cronRuns } = useFetch<CronRun[]>('/api/cron/runs?limit=100', []);
  const { data: tokens7d } = useFetch<TokensSummary>('/api/tokens/summary?days=7', []);
  const { data: tokens1d } = useFetch<TokensSummary>('/api/tokens/summary?days=1', []);

  // Live sessions — poll every 5s to stay in sync with Live Monitor
  const LIVE_POLL_MS = 5_000;
  const [liveTick, setLiveTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setLiveTick(t => t + 1), LIVE_POLL_MS);
    return () => clearInterval(id);
  }, []);
  const { data: liveData } = useFetch<{ sessions: LiveSession[] }>('/api/stats/live-sessions', [liveTick]);
  const liveSessions = (liveData?.sessions ?? []).filter(s => s.status !== 'idle').slice(0, 5);

  // Activity timeline
  const { data: timeline } = useFetch<TimelineBucket[]>('/api/timeline?bucket=day&days=7');

  if (loading) {
    return <div><PageHeader title={t('common.overview')} /><Loading /></div>;
  }
  if (kpiError || statsError || !kpi || !stats) {
    return (
      <div>
        <PageHeader title={t('common.overview')} />
        <div style={{ padding: 'var(--space-5)' }}>
          <AlertBanner variant="error">{kpiError || statsError || t('overview.failedToLoad')}</AlertBanner>
        </div>
      </div>
    );
  }

  /* ── Derived values ──────────────────────────────────────────────── */

  // Use the backend-computed cache hit rate (correct formula excludes cache_write)
  const hitRate = kpi.cache_hit_rate ?? 0;

  const topModels = (models || []).filter(m => m.model !== 'delivery-mirror');

  // Error sessions (same logic as Sessions page: count sessions with error_count > 0)
  const d7 = Date.now() - 7 * 86_400_000;
  const todayMid = new Date(); todayMid.setHours(0, 0, 0, 0);
  const errorSessionsToday = sessions
    ? sessions.filter(s => s.error_count > 0 && s.started_at >= todayMid.getTime()).length
    : 0;
  const errorSessions7d = sessions
    ? sessions.filter(s => s.error_count > 0 && s.started_at >= d7).length
    : 0;
  const warningAgents = agents ? agents.filter(a => a.health.status === 'warning').length : 0;
  const errorAgents = agents ? agents.filter(a => a.health.status === 'error').length : 0;

  // Sort agents: errors first, then warnings, then healthy; exclude removed agents
  const sortedAgents = agents ? [...agents].filter(a => a.dir_exists !== false).sort((a, b) => {
    const order: Record<string, number> = { error: 0, warning: 1, healthy: 2 };
    return (order[a.health.status] ?? 3) - (order[b.health.status] ?? 3);
  }) : [];

  // Recent sessions — non-cron, sorted by last activity (newest first), limit 5
  const recentSessions = sessions
    ? [...sessions].filter(s => !s.is_cron)
        .sort((a, b) => (b.last_message_at ?? b.started_at) - (a.last_message_at ?? a.started_at))
        .slice(0, 5)
    : [];

  // Cron sessions (newest first, limit 5)
  const cronSessions = sessions
    ? [...sessions].filter(s => s.is_cron).sort((a, b) => b.started_at - a.started_at).slice(0, 5)
    : [];

  // Session summary (strip "System: [timestamp]" prefix)
  const sessionSummary = new Map<string, string>();
  if (sessions) sessions.forEach(s => {
    if (s.task_summary) {
      const clean = s.task_summary.replace(/^System:\s*\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+\w+\]\s*/, '');
      sessionSummary.set(s.id, clean);
    }
  });

  // Session/message counts (7d and today)
  const sessions7d = sessions ? sessions.filter(s => s.started_at >= d7).length : 0;
  const sessionsToday = sessions ? sessions.filter(s => s.started_at >= todayMid.getTime()).length : 0;
  const messages7d = sessions ? sessions.filter(s => s.started_at >= d7).reduce((sum, s) => sum + s.total_messages, 0) : 0;

  // Agent status counts
  const agentRunning = agents ? agents.filter(a => a.status === 'running' || a.status === 'stuck').length : 0;
  const agentIdle = agents ? agents.filter(a => a.status === 'idle').length : 0;
  const agentStale = agents ? agents.filter(a => a.status === 'stale').length : 0;

  // Cron job stats
  const cronEnabled = cronJobs?.filter(j => j.enabled) ?? [];
  const cronFailed = cronEnabled.filter(j => j.state?.consecutiveErrors && j.state.consecutiveErrors > 0);
  const nextCronRun = cronEnabled
    .map(j => j.state?.nextRunAtMs ?? 0)
    .filter(t => t > Date.now())
    .sort((a, b) => a - b)[0] ?? null;

  // Cron failures from run history
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const weekAgo = Date.now() - 7 * 86_400_000;
  const cronFailsToday = cronRuns ? cronRuns.filter(r => (r.status === 'error' || r.status === 'failed') && r.ts >= todayStart.getTime()).length : 0;
  const cronFails7d = cronRuns ? cronRuns.filter(r => (r.status === 'error' || r.status === 'failed') && r.ts >= weekAgo).length : 0;

  // Cron vs Manual
  const cvm = tokens7d?.cronVsManual;

  return (
    <div>
      <PageHeader title={t('common.overview')}>
        <DataRetentionNote />
      </PageHeader>

      {/* ── Row 1: KPI Strip ──────────────────────────────────────────── */}
      <KpiStrip cols={5}>
        {/* 1. Cost */}
        <Link to="/tokens" style={navLink} className="nav-kpi">
          <div className="kpi" style={{ cursor: 'pointer' }}>
            <div className="kv" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtCost(kpi.today)}</div>
            <div className="kl">{t('overview.costToday')} {arrow}</div>
            <div className="ks" style={{ fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ fontSize: 11 }}>7d: {fmtCost(tokens7d?.totals?.cost ?? 0)}</span>
              {kpi.last_week_cost > 0 && (
                <div style={{
                  fontSize: 11,
                  marginTop: 2,
                  color: kpi.week_change_pct > 0 ? 'var(--C-rose)' : 'var(--C-green)',
                }}>
                  {kpi.week_change_pct > 0 ? '↑' : '↓'}{fmtPct(Math.abs(kpi.week_change_pct) / 100, 0)} vs last week
                </div>
              )}
            </div>
          </div>
        </Link>

        {/* 2. Tokens */}
        {(() => {
          const todayTok = kpi.tokens?.today;
          const todayTotal = todayTok?.total ?? 0;
          const t7Total = tokens7d?.totals?.total ?? 0;
          return (
            <Link to="/tokens" style={navLink} className="nav-kpi">
              <div className="kpi" style={{ cursor: 'pointer' }}>
                <div className="kv" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtTokens(todayTotal)}</div>
                <div className="kl">{t('overview.tokensToday')} {arrow}</div>
                <div className="ks" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  <span style={{ fontSize: 11 }}>7d: {fmtTokens(t7Total)}</span>
                </div>
              </div>
            </Link>
          );
        })()}

        {/* 3. Sessions */}
        <Link to="/sessions" style={navLink} className="nav-kpi">
          <div className="kpi" style={{ cursor: 'pointer' }}>
            <div className="kv" style={{ fontVariantNumeric: 'tabular-nums' }}>{sessionsToday}</div>
            <div className="kl">{t('overview.sessionsToday')} {arrow}</div>
            <div className="ks" style={{ fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ fontSize: 11 }}>7d: {sessions7d} · {messages7d.toLocaleString()} {t('overview.msg')}</span>
            </div>
          </div>
        </Link>

        {/* 4. Errors */}
        <Link to="/sessions" style={navLink} className="nav-kpi">
          <div className="kpi" style={{ cursor: 'pointer' }}>
            <div className="kv" style={{
              fontVariantNumeric: 'tabular-nums',
              color: errorSessionsToday > 0 ? 'var(--C-rose)' : 'var(--C-green)',
            }}>
              {errorSessionsToday}
            </div>
            <div className="kl">{t('overview.sessionsWithErrorToday')} {arrow}</div>
            <div className="ks" style={{ fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ fontSize: 11 }}>7d: {errorSessions7d}</span>
            </div>
            {(errorAgents > 0 || warningAgents > 0) && (
              <div className="ks">
                {errorAgents > 0 && <span style={{ color: 'var(--C-rose)', fontSize: 11 }}>{errorAgents} {t('common.error')} agent{errorAgents > 1 ? 's' : ''}</span>}
                {errorAgents > 0 && warningAgents > 0 && <span style={{ fontSize: 11 }}> · </span>}
                {warningAgents > 0 && <span style={{ color: 'var(--C-amber)', fontSize: 11 }}>{warningAgents} {t('common.warning')}</span>}
              </div>
            )}
          </div>
        </Link>

        {/* 5. Cache Efficiency */}
        <div className="kpi">
          <div className="kv" style={{
            fontVariantNumeric: 'tabular-nums',
            color: hitRate > 0.8 ? 'var(--C-green)' : hitRate > 0.5 ? 'var(--C-amber)' : 'var(--C-rose)',
          }}>
            {fmtPct(hitRate, 1)}
          </div>
          <div className="kl">{t('overview.cacheEfficiency')}</div>
        </div>
      </KpiStrip>

      {/* ── Row 1: Agents (left) + Models (right) ─────────────────────── */}
      <div className="g21">
        {/* Agent Bars */}
        <div className="gc">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-2)' }}>
            <div className="ct" style={{ margin: 0 }}>{t('common.agents')}</div>
            <Link to="/agents" style={{ ...navLink, color: 'var(--C-blue)', fontSize: 12 }}>{t('common.viewAll')} {arrow}</Link>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 'var(--space-3)', fontVariantNumeric: 'tabular-nums' }}>
            {sortedAgents.length} {t('common.total')}
            {agentRunning > 0 && <span> · <span style={{ color: 'var(--C-green)' }}>{agentRunning} {t('common.running')}</span></span>}
            {agentIdle > 0 && <span> · <span style={{ color: 'var(--C-blue)' }}>{agentIdle} {t('common.idle')}</span></span>}
            {agentStale > 0 && <span> · <span style={{ color: 'var(--muted)' }}>{agentStale} {t('common.stale')}</span></span>}
            {errorAgents > 0 && <span> · <span style={{ color: 'var(--C-rose)' }}>{errorAgents} {t('common.error')}</span></span>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {sortedAgents.map(a => {
              const hs = a.health.status || 'healthy';
              const ctxPct = a.last_session?.context_pct ?? null;
              const borderLeft = hs === 'error' ? '3px solid var(--C-rose)'
                : hs === 'warning' ? '3px solid var(--C-amber)' : '3px solid transparent';
              return (
                <Link
                  key={a.agent_name}
                  to="/agents"
                  style={{
                    ...navLink,
                    display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
                    padding: 'var(--space-2) var(--space-3)',
                    borderLeft,
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--surface2)',
                    transition: 'background .1s',
                    fontSize: 13,
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface3)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'var(--surface2)')}
                >
                  <StatusDot color={HEALTH_COLOR[hs] ?? 'var(--muted)'} glow={hs === 'error'} size={7} />
                  <span style={{ fontWeight: 600, minWidth: 60 }}>{a.agent_name}</span>
                  <Badge variant={HEALTH_VARIANT[hs] ?? 'neutral'}>{t(`common.${hs}` as never, hs)}</Badge>
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {a.primary_model?.replace('claude-', '').replace('-latest', '') ?? '—'}
                  </span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 11, color: 'var(--C-blue)', fontVariantNumeric: 'tabular-nums' }}>
                    {fmtCost(a.today?.cost ?? 0)}
                  </span>
                  {ctxPct !== null && (
                    <ProgressBar
                      value={ctxPct} max={100} width={40} height={4}
                      color={ctxPct > 80 ? 'var(--C-rose)' : ctxPct > 50 ? 'var(--C-amber)' : 'var(--C-green)'}
                    />
                  )}
                  {(() => {
                    const sc = a.status === 'running' ? '#22c55e'
                      : a.status === 'stuck' ? '#eab308'
                      : a.status === 'idle' ? '#60a5fa'
                      : '#888';
                    return (
                      <span style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums', textAlign: 'right', flexShrink: 0, whiteSpace: 'nowrap' }}>
                        <span style={{ color: 'var(--muted)' }}>{relTime(a.last_activity_ts, t)}</span>
                        {' '}
                        <span style={{ color: sc, fontWeight: 500, fontSize: 10 }}>{t(`common.${a.status}` as never)}</span>
                      </span>
                    );
                  })()}
                </Link>
              );
            })}
          </div>
        </div>

        {/* Models — sorted by last active, with Active/Idle status */}
        {(() => {
          const ONE_HOUR = 3_600_000;
          const modelsWithStatus = topModels.map(m => {
            const mAgents = sortedAgents.filter(a => a.primary_model === m.model);
            const lastTs = mAgents.length > 0 ? Math.max(...mAgents.map(a => a.last_activity_ts || 0)) : 0;
            const isActive = lastTs > 0 && (Date.now() - lastTs) < ONE_HOUR;
            const todayCost = tokens1d?.byModel?.find(bm => bm.model === m.model)?.cost ?? 0;
            const weekCost = tokens7d?.byModel?.find(bm => bm.model === m.model)?.cost ?? 0;
            return { ...m, mAgents, lastTs, isActive, todayCost, weekCost };
          }).sort((a, b) => b.lastTs - a.lastTs);
          // Active models always shown; idle models only shown if they have 7d spending
          const visibleModels = modelsWithStatus.filter(m => m.isActive || m.weekCost > 0);

          return (
            <div className="gc">
              <div className="ct">{t('overview.models')}</div>
              {visibleModels.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center', padding: 'var(--space-6)' }}>{t('overview.noModelData')}</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                  {visibleModels.map((m) => {
                    const { todayCost, weekCost } = m;
                    return (
                      <div key={m.model} style={{
                        padding: 'var(--space-2) var(--space-3)',
                        borderRadius: 'var(--radius-sm)',
                        background: 'var(--surface2)',
                        fontSize: 13,
                      }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-2)' }}>
                          <StatusDot
                            color={m.isActive ? 'var(--C-green)' : 'var(--muted)'}
                            glow={m.isActive}
                            size={7}
                          />
                          <div style={{ flex: 1 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                              <span style={{ fontWeight: 600 }}>{m.model.replace('claude-', '').replace('-latest', '')}</span>
                              <Badge variant={m.isActive ? 'green' : 'amber'}>{m.isActive ? t('common.active') : t('common.idle')}</Badge>
                              {m.lastTs > 0 && <span style={{ fontSize: 10, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{relTime(m.lastTs, t)}</span>}
                            </div>
                            {m.mAgents.length > 0 && (
                              <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap', marginTop: 'var(--space-1)' }}>
                                {m.mAgents.map(a => (
                                  <span key={a.agent_name} style={{
                                    fontSize: 11, padding: '1px 7px',
                                    border: '1px solid var(--border2)',
                                    borderRadius: 'var(--radius-full)',
                                    color: 'var(--muted)',
                                    background: 'transparent',
                                  }}>{a.agent_name}</span>
                                ))}
                              </div>
                            )}
                          </div>
                          <div style={{
                            fontSize: 11, fontVariantNumeric: 'tabular-nums', textAlign: 'left', flexShrink: 0,
                          }}>
                            <div><span style={{ color: 'var(--C-blue)' }}>{fmtCost(todayCost)}</span><span style={{ color: 'var(--muted)' }}> (today)</span></div>
                            <div style={{ marginTop: 3 }}><span style={{ color: 'var(--text)' }}>{fmtCost(weekCost)}</span><span style={{ color: 'var(--muted)' }}> (7d)</span></div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* ── Row 2: Recent Sessions (left) + Cron Jobs (right) ─────────── */}
      <div className="g21">
        {/* Recent Sessions */}
        <div className="gc">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-2)' }}>
            <div className="ct" style={{ margin: 0 }}>{t('overview.recentSessions')}</div>
            <Link to="/sessions" style={{ ...navLink, color: 'var(--C-blue)', fontSize: 12 }}>{t('common.viewAll')} {arrow}</Link>
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 'var(--space-3)' }}>
            {t('overview.excludesCron')}
          </div>
          {recentSessions.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center', padding: 'var(--space-6)' }}>{t('overview.noSessionsFound')}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {recentSessions.map(s => (
                <Link
                  key={s.id}
                  to={`/sessions?q=${s.id}`}
                  style={{
                    ...navLink, display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
                    padding: 'var(--space-2) var(--space-2)',
                    borderBottom: '1px solid var(--border)', fontSize: 13, transition: 'background .1s',
                  }}
                  className="nav-kpi"
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface2)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, gap: 2 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                      <StatusDot color={s.error_count > 0 ? 'var(--C-rose)' : 'var(--C-green)'} size={6} />
                      <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>{s.agent_name}</span>
                      <span style={{ color: 'var(--muted)', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>{fmtTokens(s.total_tokens)}</span>
                      <span style={{ color: 'var(--C-blue)', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>{fmtCost(s.total_cost)}</span>
                      {s.error_count > 0 && <span style={{ color: 'var(--C-rose)', fontSize: 10 }}>{t('common.error')}</span>}
                      <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 11, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{relTime(s.last_message_at ?? s.started_at, t)}</span>
                    </div>
                    {sessionSummary.get(s.id) && (
                      <div style={{ color: 'var(--muted)', fontSize: 11, paddingLeft: 14, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                        …{sessionSummary.get(s.id)!.slice(0, 160)}
                      </div>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Cron Jobs */}
        <div className="gc">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-3)' }}>
            <div className="ct" style={{ margin: 0 }}>{t('overview.cronJobs')}</div>
            <Link to="/cron" style={{ ...navLink, color: 'var(--C-blue)', fontSize: 12 }}>{t('common.viewAll')} {arrow}</Link>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 'var(--space-3)', fontVariantNumeric: 'tabular-nums' }}>
            {cronEnabled.length} {cronEnabled.length !== 1 ? t('overview.jobs') : t('overview.job')} {t('common.enabled')}
            {cronFailed.length > 0 && <span style={{ color: 'var(--C-rose)', fontWeight: 500 }}> · {cronFailed.length} {t('overview.failing')}</span>}
            {nextCronRun && <span> · {t('overview.nextRun')} {relTime(nextCronRun, t)}</span>}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 'var(--space-3)', fontVariantNumeric: 'tabular-nums' }}>
            {t('overview.failures')} <span style={{ color: cronFailsToday > 0 ? 'var(--C-rose)' : 'var(--muted)', fontWeight: cronFailsToday > 0 ? 500 : 400 }}>{cronFailsToday} {t('common.today')}</span>
            {' · '}<span style={{ color: cronFails7d > 0 ? 'var(--C-amber)' : 'var(--muted)', fontWeight: cronFails7d > 0 ? 500 : 400 }}>{cronFails7d} {t('overview.last7d')}</span>
          </div>
          {cronEnabled.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center', padding: 'var(--space-4)' }}>{t('overview.noCronJobs')}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', marginBottom: 'var(--space-3)' }}>
              {cronEnabled.map(j => {
                const ok = j.state?.lastRunStatus === 'ok';
                const consErr = j.state?.consecutiveErrors ?? 0;
                return (
                  <div key={j.id} style={{
                    display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
                    padding: 'var(--space-1) var(--space-2)', fontSize: 12,
                    borderLeft: consErr > 0 ? '3px solid var(--C-rose)' : '3px solid transparent',
                    borderRadius: 'var(--radius-sm)', background: 'var(--surface2)',
                  }}>
                    <StatusDot color={ok ? 'var(--C-green)' : consErr > 0 ? 'var(--C-rose)' : 'var(--muted)'} size={6} />
                    <span style={{ fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.name}</span>
                    {j.schedule.expr && <span style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--font-m)' }}>{j.schedule.expr}</span>}
                    {j.state?.lastDurationMs != null && <span style={{ fontSize: 11, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{fmtMs(j.state.lastDurationMs)}</span>}
                    <span style={{ fontSize: 11, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{relTime(j.state?.lastRunAtMs, t)}</span>
                  </div>
                );
              })}
            </div>
          )}
          {cronSessions.length > 0 && (
            <>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 'var(--space-2)', paddingTop: 'var(--space-2)', borderTop: '1px solid var(--border)' }}>{t('overview.recentCronRuns')}</div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {cronSessions.map(s => {
                  const jobName = cronJobs?.find(j => j.agentId === s.agent_name)?.name ?? null;
                  return (
                    <Link key={s.id} to={`/sessions?q=${s.id}`} style={{
                      ...navLink, display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
                      padding: 'var(--space-1) var(--space-2)', borderBottom: '1px solid var(--border)', fontSize: 12, transition: 'background .1s',
                    }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface2)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <StatusDot color={s.error_count > 0 ? 'var(--C-rose)' : 'var(--C-green)'} size={5} />
                      <span style={{ fontWeight: 500, maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.agent_name}</span>
                      {jobName && <span style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>{jobName}</span>}
                      <span style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{fmtTokens(s.total_tokens)}</span>
                      <span style={{ color: 'var(--C-blue)', fontVariantNumeric: 'tabular-nums' }}>{fmtCost(s.total_cost)}</span>
                      <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{relTime(s.started_at, t)}</span>
                    </Link>
                  );
                })}
              </div>
            </>
          )}
          {cvm && (cvm.cron.tokens > 0 || cvm.manual.tokens > 0) && (() => {
            const total = cvm.cron.tokens + cvm.manual.tokens || 1;
            return (
              <div style={{ marginTop: 'var(--space-3)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--border)' }}>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 'var(--space-2)' }}>{t('overview.cronVsManual')}</div>
                <div className="sbar" style={{ marginBottom: 'var(--space-2)' }}>
                  <div className="ss" style={{ flex: cvm.cron.tokens / total, background: 'var(--C-violet)' }} />
                  <div className="ss" style={{ flex: cvm.manual.tokens / total, background: 'var(--C-blue)' }} />
                </div>
                <div style={{ display: 'flex', gap: 'var(--space-4)', fontSize: 11, color: 'var(--muted)' }}>
                  <span><span style={{ color: 'var(--C-violet)' }}>{'■'}</span> {t('overview.cronLabel')} {fmtPct(cvm.cron.tokens / total, 0)} · {fmtCost(cvm.cron.cost)}</span>
                  <span><span style={{ color: 'var(--C-blue)' }}>{'■'}</span> {t('overview.manualLabel')} {fmtPct(cvm.manual.tokens / total, 0)} · {fmtCost(cvm.manual.cost)}</span>
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      {/* ── Row 3: Live Monitor (left) + Activity Timeline (right) ── */}
      <div className="g11">

        {/* Live Monitor mini panel */}
        <div className="gc">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-3)' }}>
            <div className="ct" style={{ margin: 0 }}>{t('nav.live')}</div>
            <Link to="/live" style={{ ...navLink, color: 'var(--C-blue)', fontSize: 12 }}>{t('common.viewAll')} {arrow}</Link>
          </div>
          {liveSessions.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center', padding: 'var(--space-6)', flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {t('live.allQuiet')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              {liveSessions.map((s, si) => {
                const isRunning = s.status === 'running';
                const isStuck   = s.status === 'stuck';
                const dotColor  = isRunning ? 'var(--C-green)' : 'var(--C-amber)';
                const totalMin  = Math.round(s.idle_ms / 60_000);
                const h = Math.floor(totalMin / 60);
                const m = totalMin % 60;
                const timeStr   = totalMin < 60 ? t('common.minsAgo', { n: totalMin }) : t('common.hhmmAgo', { h, m });
                const isLast    = si === liveSessions.length - 1;
                return (
                  <Link
                    key={s.session_id}
                    to="/live"
                    style={{
                      ...navLink,
                      display: 'flex', flexDirection: 'column', gap: 3,
                      padding: '8px var(--space-2)',
                      borderBottom: isLast ? 'none' : '1px solid var(--border)',
                      transition: 'background .1s',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface2)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    {/* Row 1: dot + agent + status badge + time */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                      <StatusDot color={dotColor} glow={isRunning} size={7} />
                      <span style={{ fontWeight: 600 }}>{s.agent_name}</span>
                      <span style={{ fontFamily: 'var(--font-m)', fontSize: 10, color: 'var(--faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>{s.session_id}</span>
                      {isStuck ? (
                        <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: 'rgba(251,191,36,0.15)', color: 'var(--C-amber)', fontWeight: 600, letterSpacing: '0.02em', textTransform: 'uppercase' }}>{t('live.statusStuck')}</span>
                      ) : (
                        <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: 'rgba(16,185,129,0.12)', color: 'var(--C-green)', fontWeight: 600, letterSpacing: '0.02em', textTransform: 'uppercase' }}>{t('live.statusRunning')}</span>
                      )}
                      <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{timeStr}</span>
                    </div>
                    {/* Steps: one row per step, text for user/AI (max 2 lines) */}
                    {s.steps.length > 0 && (
                      <div style={{ paddingLeft: 15, display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 }}>
                        {s.steps.map((step, i) => {
                          if (step.type === 'user') return (
                            <div key={i} style={{ fontSize: 11 }}>
                              <span style={{ color: 'var(--C-violet)', fontFamily: 'var(--font-m)' }}>user:</span>
                              <div style={{ color: 'var(--muted)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', marginTop: 1 }}>{step.text}</div>
                            </div>
                          );
                          if (step.type === 'tool') return (
                            <div key={i} style={{ fontSize: 11, color: 'var(--C-teal)', fontFamily: 'var(--font-m)' }}>→ {step.name}</div>
                          );
                          if (step.type === 'ai') return (
                            <div key={i} style={{ fontSize: 11 }}>
                              <span style={{ color: '#ec4899', fontFamily: 'var(--font-m)' }}>AI:</span>
                              <div style={{ color: 'var(--muted)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', marginTop: 1 }}>{step.text}</div>
                            </div>
                          );
                          if (step.type === 'error') return (
                            <div key={i} style={{ fontSize: 11, color: 'var(--C-rose)' }}>✗ {step.text}</div>
                          );
                          if (step.type === 'waiting') return (
                            <div key={i} style={{ fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>{'⏳ ' + t('live.waitingForResponse')}</div>
                          );
                          if (step.type === 'done') return (
                            <div key={i} style={{ fontSize: 11, color: 'var(--C-green)' }}>{'✓ ' + t('live.statusDone')}</div>
                          );
                          return null;
                        })}
                      </div>
                    )}
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        {/* Activity Timeline */}
        <div className="gc">
          <div className="ct">{t('overview.activityTimeline')}</div>
          {timeline && timeline.length > 0 ? (() => {
            const tdata = timeline.map(b => ({
              date: new Date(b.bucket_ts).toLocaleDateString(dateLocale, { month: 'short', day: 'numeric' }),
              cost_total: b.cost_total,
              total_tokens: b.total_tokens,
              message_count: b.message_count,
              error_count: b.error_count,
            }));
            const msgLabel = t('common.messages');
            const costLabel = t('common.cost');
            const tokLabel = t('common.tokens');
            const errLabel = t('common.errors');
            return (<>
              {/* Chart 1: Messages + Errors */}
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 16 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--C-violet)', display: 'inline-block' }} /> {msgLabel}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--C-rose)', display: 'inline-block' }} /> {errLabel}
                </span>
              </div>
              <ResponsiveContainer width="100%" height={140}>
                <BarChart data={tdata} barCategoryGap="25%" barGap={2}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--muted)' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: 'var(--muted)' }} axisLine={false} tickLine={false} width={28} />
                  <Tooltip
                    cursor={{ fill: 'transparent' }}
                    contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: 11 }}
                    formatter={(v: any, name: any) => [v, name === 'message_count' ? msgLabel : errLabel]}
                  />
                  <Bar dataKey="message_count" fill="var(--C-violet)" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="error_count" fill="var(--C-rose)" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>

              {/* Chart 2: Cost + Tokens */}
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 10, marginBottom: 2, display: 'flex', alignItems: 'center', gap: 16 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--C-blue)', display: 'inline-block' }} /> {costLabel}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--C-amber)', display: 'inline-block' }} /> {tokLabel}
                </span>
              </div>
              <ResponsiveContainer width="100%" height={140}>
                <ComposedChart data={tdata} barCategoryGap="35%">
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--muted)' }} axisLine={false} tickLine={false} />
                  <YAxis yAxisId="cost" orientation="left" tick={{ fontSize: 10, fill: 'var(--muted)' }} axisLine={false} tickLine={false} width={36} tickFormatter={(v: number) => fmtCost(v)} />
                  <YAxis yAxisId="tok" orientation="right" tick={{ fontSize: 10, fill: 'var(--muted)' }} axisLine={false} tickLine={false} width={36} tickFormatter={(v: number) => fmtTokens(v)} />
                  <Tooltip
                    cursor={{ fill: 'transparent' }}
                    contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: 11 }}
                    formatter={(v: any, name: any) => name === 'cost_total' ? [fmtCost(v), costLabel] : [fmtTokens(v), tokLabel]}
                  />
                  <Bar yAxisId="cost" dataKey="cost_total" fill="var(--C-blue)" radius={[2, 2, 0, 0]} />
                  <Line yAxisId="tok" type="monotone" dataKey="total_tokens" stroke="var(--C-amber)" strokeWidth={2} dot={{ r: 3, fill: 'var(--C-amber)' }} activeDot={{ r: 4 }} />
                </ComposedChart>
              </ResponsiveContainer>
            </>);
          })() : (
            <div style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center', padding: 'var(--space-6)' }}>{t('overview.noTimelineData')}</div>
          )}
        </div>
      </div>{/* end g11 */}

    </div>
  );
}
