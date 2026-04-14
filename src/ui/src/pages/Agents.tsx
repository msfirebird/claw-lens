import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  AreaChart, Area, BarChart, Bar, ComposedChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { useFetch, fmtCost, fmtTokens, fmtPct } from '../hooks';
import {
  PageHeader, KpiStrip, Kpi, Loading, EmptyState,
  Card, InfoTooltip,
} from '../components/ui';

// ── Types ─────────────────────────────────────────────────────────────────────
type AgentStatus = 'running' | 'stuck' | 'idle' | 'stale';

interface AgentConfig {
  files: number;
  tools_profile: string;
  skills: string[];
  channels: string[];
  cron_tasks: string[];
}

interface HourlyCell { hour_slot: number; sessions: number; error_sessions: number }

interface Agent {
  agent_name: string;
  dir_exists: boolean;
  status: AgentStatus;
  last_activity_ts: number;
  idle_ms: number;
  first_seen: number;
  primary_model: string | null;
  avg_session_duration_ms: number | null;
  error_rate: number | null;
  cache_hit_rate: number | null;
  current_task: { text: string; source: 'slack' | 'direct' | null; session_id: string | null } | null;
  last_tool: string | null;
  health: { status: 'healthy' | 'warning' | 'error'; reasons: string[] };
  in_schedule: boolean;
  config: AgentConfig;
  today: { sessions: number; cost: number };
  last_session: { ok: boolean; context_pct: number | null };
  all_time: { sessions: number; cost: number; messages: number; errors: number };
  last_30d: { sessions: number; cost: number; errors: number };
  last_7d:  { sessions: number; cost: number };
  hourly: HourlyCell[];
}

interface AgentsData {
  agents: Agent[];
  summary: { total: number; running: number; idle: number; stale: number };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const HEALTH_META = {
  healthy: { labelKey: 'common.healthy', color: 'var(--C-green)' },
  warning: { labelKey: 'common.warning', color: 'var(--C-amber)' },
  error:   { labelKey: 'common.error',   color: 'var(--C-red)'   },
};

const STATUS_META: Record<AgentStatus, { labelKey: string; color: string }> = {
  running: { labelKey: 'common.running', color: 'var(--C-green)'  },
  stuck:   { labelKey: 'common.stuck',   color: 'var(--C-amber)'  },
  idle:    { labelKey: 'common.idle',    color: 'var(--C-blue)'   },
  stale:   { labelKey: 'common.stale',   color: 'var(--muted)'    },
};


function fmtIdle(ms: number, t: TFunction): string {
  if (ms < 60_000)           return t('common.secsAgo', { n: Math.round(ms / 1000) });
  if (ms < 3_600_000)        return t('common.minsAgo', { n: Math.round(ms / 60_000) });
  if (ms < 86_400_000)       return t('common.hoursAgo', { n: Math.round(ms / 3_600_000) });
  if (ms < 7 * 86_400_000)   return t('common.daysAgo', { n: Math.round(ms / 86_400_000) });
  return new Date(Date.now() - ms).toLocaleDateString();
}


function fmtModel(m: string | null): string {
  if (!m) return '—';
  // Provider/auto routing: show "provider · auto"
  if (m.endsWith('/auto')) return m.replace('/auto', '') + ' · auto';
  return m.replace('claude-', '').replace('-latest', '').replace('-20250219', '').replace('-20250514', '');
}



// ── Daily data type ───────────────────────────────────────────────────────────
interface DailyRow { day: string; sessions: number; messages: number; total_tokens: number; total_cost: number; worst_health: 0 | 1 | 2 | null; error_sessions: number; max_tokens_sessions: number; interrupted_sessions: number }

// ── Agent Detail Panel (full-width, below grid) ───────────────────────────────
type ChartRow = DailyRow & { day_label: string };

const CHART_TICK = { fontSize: 10, fill: 'var(--muted)', fontFamily: 'var(--font-b)' };
const CHART_GRID = 'rgba(255,255,255,0.06)';
const CHART_MARGIN = { top: 4, right: 16, left: 0, bottom: 0 };

function fmtDay(d: string) {
  const [, m, day] = d.split('-');
  return `${parseInt(m)}/${parseInt(day)}`;
}

function ChartLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 'var(--space-2)', marginTop: 'calc(var(--space-5) + 10px)' }}>
      <span style={{ fontSize: 11, fontFamily: 'var(--font-b)', color: 'var(--text)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>{children}</span>
    </div>
  );
}

function TokenChart({ data, days }: { data: ChartRow[]; days: number }) {
  const { t } = useTranslation();
  return (
    <ResponsiveContainer width="100%" height={180}>
      <AreaChart data={data} margin={CHART_MARGIN}>
        <defs>
          <linearGradient id="tokenGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#7aa3f5" stopOpacity={0.5} />
            <stop offset="95%" stopColor="#7aa3f5" stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
        <XAxis dataKey="day_label" tick={CHART_TICK} tickLine={false} axisLine={false}
          interval={days <= 7 ? 0 : days <= 14 ? 1 : 2} />
        <YAxis orientation="left" tick={CHART_TICK} tickLine={false} axisLine={false}
          tickFormatter={fmtTokens} width={44} />
        <Tooltip content={({ active, label, payload }) => {
          if (!active || !payload?.length) return null;
          const row = payload[0]?.payload as ChartRow | undefined;
          if (!row) return null;
          return (
            <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', fontSize: 12, fontFamily: 'var(--font-b)' }}>
              <div style={{ color: 'var(--muted)', marginBottom: 4 }}>{label}</div>
              <div style={{ color: '#7aa3f5' }}>{t('agents.tokensLabel')}: {fmtTokens(row.total_tokens)} <span style={{ color: 'var(--muted)', fontSize: 10 }}>({row.total_tokens.toLocaleString()})</span></div>
              <div style={{ color: '#f0c040', marginTop: 2 }}>{t('agents.costLabel')}: {fmtCost(row.total_cost)}</div>
            </div>
          );
        }} />
        <Area type="monotone" dataKey="total_tokens" stroke="#7aa3f5" strokeWidth={3}
          fill="url(#tokenGrad)" dot={{ r: 3.5, fill: '#7aa3f5', strokeWidth: 0 }}
          activeDot={{ r: 6, fill: '#7aa3f5' }} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function SessionMessageChart({ data, days }: { data: ChartRow[]; days: number }) {
  const { t } = useTranslation();
  return (
    <ResponsiveContainer width="100%" height={180}>
      <ComposedChart data={data} margin={CHART_MARGIN}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
        <XAxis dataKey="day_label" tick={CHART_TICK} tickLine={false} axisLine={false}
          interval={days <= 7 ? 0 : days <= 14 ? 1 : 2} />
        <YAxis yAxisId="sessions" orientation="left" tick={CHART_TICK} tickLine={false} axisLine={false}
          allowDecimals={false} width={32} />
        <YAxis yAxisId="messages" orientation="right" tick={CHART_TICK} tickLine={false} axisLine={false}
          allowDecimals={false} width={32} />
        <Tooltip cursor={false} content={({ active, label, payload }) => {
          if (!active || !payload?.length) return null;
          const row = payload[0]?.payload as ChartRow | undefined;
          if (!row) return null;
          return (
            <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', fontSize: 12, fontFamily: 'var(--font-b)' }}>
              <div style={{ color: 'var(--muted)', marginBottom: 4 }}>{label}</div>
              <div style={{ color: '#34d399' }}>{t('agents.sessionsLabel')}: {row.sessions}</div>
              <div style={{ color: 'var(--C-blue)', marginTop: 2 }}>{t('agents.messagesLabel')}: {row.messages}</div>
            </div>
          );
        }} />
        <Bar yAxisId="sessions" dataKey="sessions" fill="#34d399" radius={[2, 2, 0, 0]} maxBarSize={28} isAnimationActive={false} />
        <Line yAxisId="messages" type="monotone" dataKey="messages" stroke="var(--C-blue)" strokeWidth={2}
          dot={{ r: 3, fill: 'var(--C-blue)', strokeWidth: 0 }} activeDot={{ r: 5 }} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function ErrorTrendChart({ data, days }: { data: ChartRow[]; days: number }) {
  const { t } = useTranslation();
  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={data} margin={CHART_MARGIN}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
        <XAxis dataKey="day_label" tick={CHART_TICK} tickLine={false} axisLine={false}
          interval={days <= 7 ? 0 : days <= 14 ? 1 : 2} />
        <YAxis orientation="left" tick={CHART_TICK} tickLine={false} axisLine={false}
          allowDecimals={false} width={32} />
        <Tooltip cursor={false} content={({ active, label, payload }) => {
          if (!active || !payload?.length) return null;
          const row = payload[0]?.payload as ChartRow | undefined;
          if (!row) return null;
          return (
            <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', fontSize: 12, fontFamily: 'var(--font-b)' }}>
              <div style={{ color: 'var(--muted)', marginBottom: 4 }}>{label}</div>
              <div style={{ color: 'var(--C-rose)' }}>{t('agents.errorSessionsLabel')}: {row.error_sessions}</div>
              <div style={{ color: '#34d399', marginTop: 2 }}>{t('agents.sessionsLabel')}: {row.sessions}</div>
            </div>
          );
        }} />
        <Bar dataKey="error_sessions" fill="var(--C-rose)" radius={[2, 2, 0, 0]} maxBarSize={28} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}


interface HeatmapCell { date: string; hod: number; call_count: number }

function fmtHour(h: number): string {
  if (h === 0) return '12 AM';
  if (h < 12) return `${h} AM`;
  if (h === 12) return '12 PM';
  return `${h - 12} PM`;
}

function ActivityHeatmap({ agentName }: { agentName: string }) {
  const { t } = useTranslation();
  const { data: hmData } = useFetch<HeatmapCell[]>(
    `/api/tools/heatmap?agent=${agentName}&days=7`,
    [agentName],
  );
  if (!hmData || hmData.length === 0) return null;

  // Build the last 7 days in order (oldest → newest)
  const today = new Date();
  const dates: string[] = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() - 6 + i);
    return d.toISOString().slice(0, 10); // 'YYYY-MM-DD'
  });

  // date label: MM/DD
  const dateLabel = (iso: string) => iso.slice(5).replace('-', '/');

  // Build grid: date × hour
  const grid: Record<string, number[]> = {};
  dates.forEach(d => { grid[d] = Array(24).fill(0); });
  hmData.forEach(c => {
    if (grid[c.date] && c.hod >= 0 && c.hod < 24) grid[c.date][c.hod] = c.call_count;
  });
  const maxCount = Math.max(...hmData.map(c => c.call_count), 1);

  const LABEL_W = 44;  // px for date labels column
  // Show labels every 3 hours: 0, 3, 6, 9, 12, 15, 18, 21
  const HOD_LABELS = Array.from({ length: 24 }, (_, h) => h % 3 === 0 ? fmtHour(h) : '');

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 'var(--space-3)' }}>
      {/* Hour labels row */}
      <div style={{ display: 'flex', marginLeft: LABEL_W, marginBottom: 4 }}>
        {HOD_LABELS.map((label, h) => (
          <div key={h} style={{
            flex: 1, textAlign: 'center',
            fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--font-b)',
            visibility: label ? 'visible' : 'hidden',
            whiteSpace: 'nowrap', overflow: 'visible',
          }}>
            {label}
          </div>
        ))}
      </div>
      {/* Date rows */}
      {dates.map(date => (
        <div key={date} style={{ display: 'flex', alignItems: 'center', gap: 2, marginBottom: 2 }}>
          <div style={{
            width: LABEL_W, flexShrink: 0,
            fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--font-b)',
          }}>{dateLabel(date)}</div>
          {Array.from({ length: 24 }, (_, h) => {
            const count = grid[date][h];
            const opacity = count === 0 ? 0.05 : 0.15 + 0.85 * (count / maxCount);
            return (
              <div key={h} title={t('agents.messagesHeatmap', { date, hour: fmtHour(h), count })}
                style={{
                  flex: 1, height: 16,
                  background: `rgba(34,197,94,${opacity})`,
                  borderRadius: 2,
                }} />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function AgentDetailPanel({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { t } = useTranslation();
  const { data, loading } = useFetch<DailyRow[]>(
    `/api/stats/agents/${agent.agent_name}/daily?days=7`,
    [agent.agent_name],
  );
  const chartData: ChartRow[] = (data ?? []).map(r => ({ ...r, day_label: fmtDay(r.day) }));

  return (
    <div style={{
      marginTop: 'var(--space-4)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      background: 'var(--surface)',
      overflow: 'hidden',
    }}>
      {/* Panel header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: 'var(--space-3) var(--space-4)',
        borderBottom: '1px solid var(--border)',
      }}>
        <span style={{ fontFamily: 'var(--font-b)', fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
          {agent.agent_name}
        </span>
        <button onClick={onClose} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--muted)', fontSize: 18, lineHeight: 1, padding: '2px 6px',
        }}>✕</button>
      </div>

      {/* Charts */}
      <div style={{ padding: 'var(--space-4)', paddingBottom: 'calc(var(--space-4) + 10px)' }}>
        {loading ? (
          <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--font-b)' }}>{t('common.loading')}</span>
          </div>
        ) : (<>
          <div style={{ display: 'flex', gap: 'var(--space-4)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <ChartLabel>{t('agents.tokenUsageChart')}</ChartLabel>
              <TokenChart data={chartData} days={7} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <ChartLabel>{t('agents.activityHeatmap')}</ChartLabel>
              <ActivityHeatmap agentName={agent.agent_name} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-4)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <ChartLabel>{t('agents.sessionAndMessages')}</ChartLabel>
              <SessionMessageChart data={chartData} days={7} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <ChartLabel>{t('agents.errorTrend')}</ChartLabel>
              <ErrorTrendChart data={chartData} days={7} />
            </div>
          </div>
        </>)}
      </div>
    </div>
  );
}


// ── Agent Card ────────────────────────────────────────────────────────────────
function AgentCard({ agent, isSelected, onSelect }: {
  agent: Agent;
  isSelected: boolean;
  onSelect: (a: Agent) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const meta = STATUS_META[agent.status];
  const isNew = agent.all_time.sessions === 0;
  const isActive = agent.status === 'running';
  const isRemoved = !agent.dir_exists;

  const healthMeta = HEALTH_META[agent.health.status];

  const rows: Array<{ label: string; value: string; muted?: boolean; color?: string; badge?: boolean; dotColor?: string }> = [
    {
      label: t('agents.health'),
      value: t(healthMeta.labelKey),
      color: healthMeta.color,
      badge: true,
    },
    {
      label: t('agents.lastActive'),
      value: isNew ? t('agents.never') : `${fmtIdle(agent.idle_ms, t)} · ${t(meta.labelKey)}`,
      muted: true,
      dotColor: meta.color,
    },
    ...(agent.last_tool && (agent.status === 'running' || agent.status === 'stuck') ? [{
      label: t('agents.lastTool'),
      value: agent.last_tool,
      color: agent.status === 'stuck' ? 'var(--C-amber)' : 'var(--C-green)',
    }] : []),
  ];

  return (
    <Card style={{
      transition: 'border-color .15s, box-shadow .15s',
      borderColor: isSelected ? 'var(--C-blue)' : 'var(--border2)',
      background: 'var(--surface)',
      boxShadow: isSelected ? '0 0 0 1px var(--C-blue), 0 2px 8px rgba(59,130,246,0.15)' : '0 1px 3px rgba(0,0,0,0.3)',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Header: name + model */}
      <div style={{ marginBottom: 'var(--space-3)', opacity: isRemoved ? 0.45 : 1 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 'var(--space-2)' }}>
          <div style={{
            fontFamily: 'var(--font-b)', fontSize: 20, fontWeight: 700,
            color: 'var(--text)', lineHeight: 1.2, letterSpacing: '-0.01em',
          }}>
            {agent.agent_name}
          </div>
          {isRemoved && (
            <span style={{
              fontSize: 10, fontFamily: 'var(--font-m)', padding: '2px 6px',
              borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
              color: 'var(--muted)', background: 'var(--surface2)', flexShrink: 0,
            }}>{t('agents.removed')}</span>
          )}
        </div>
        <div style={{
          display: 'inline-block', marginTop: 'var(--space-1)',
          fontFamily: 'var(--font-m)', fontSize: 11,
          color: isNew ? 'var(--muted)' : '#7aa3f5',
          background: isNew ? 'var(--surface2)' : 'rgba(122,163,245,0.08)',
          padding: '2px 8px',
          borderRadius: 'var(--radius-sm)',
          border: isNew ? '1px solid var(--border)' : '1px solid rgba(122,163,245,0.25)',
        }}>
          {isNew ? t('agents.noSessionsYet') : fmtModel(agent.primary_model)}
        </div>
      </div>

      {/* Detail rows */}
      <div style={{
        borderTop: '1px solid rgba(255,255,255,0.09)',
        paddingTop: 'var(--space-3)',
        display: 'flex', flexDirection: 'column', gap: 'var(--space-2)',
      }}>
        {rows.map(({ label, value, muted, color, badge, dotColor }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)', fontSize: 13, lineHeight: 1.5 }}>
            <span style={{
              width: 88, flexShrink: 0,
              color: 'var(--muted)', fontFamily: 'var(--font-b)', paddingTop: 2,
            }}>
              {label}
            </span>
            {badge && color ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                <div style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  border: `1px solid ${color}`,
                  borderRadius: 'var(--radius-full)',
                  padding: '2px 8px',
                  opacity: 0.9,
                  alignSelf: 'flex-start',
                }}>
                  <span style={{
                    width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
                    background: color,
                    boxShadow: isActive ? `0 0 4px ${color}` : 'none',
                    animation: isActive ? 'pulse 2s ease-in-out infinite' : 'none',
                  }} />
                  <span style={{ fontSize: 11, fontFamily: 'var(--font-b)', fontWeight: 500, color }}>
                    {value}
                  </span>
                </div>
                {agent.health.reasons.length > 0 && (
                  <span style={{ fontSize: 11, color: healthMeta.color, fontFamily: 'var(--font-b)', lineHeight: 1.4, opacity: 0.85 }}>
                    {agent.health.reasons.join(' · ')}
                  </span>
                )}
              </div>
            ) : (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                {dotColor && (
                  <span style={{
                    width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                    background: dotColor,
                    boxShadow: isActive ? `0 0 4px ${dotColor}` : 'none',
                    animation: isActive ? 'pulse 2s ease-in-out infinite' : 'none',
                  }} />
                )}
                <span style={{
                  color: color ?? (muted ? 'var(--muted)' : 'var(--text)'),
                  fontFamily: 'var(--font-b)',
                  fontWeight: 400,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {value}
                </span>
              </span>
            )}
          </div>
        ))}

        {/* Working on — custom row with source badge */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)', fontSize: 13, lineHeight: 1.5 }}>
          <span style={{ width: 88, flexShrink: 0, color: 'var(--muted)', fontFamily: 'var(--font-b)', paddingTop: 1 }}>
            {t('agents.workingOn')}
          </span>
          {agent.current_task ? (
            <div style={{ overflow: 'hidden', minWidth: 0 }}>
              <div style={{
                color: 'var(--text)', fontFamily: 'var(--font-b)', fontWeight: 400,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {agent.current_task.source === 'slack' && (
                  <span style={{ color: 'var(--muted)', marginRight: 2 }}>slack::</span>
                )}
                {agent.current_task.text}
              </div>
            </div>
          ) : (
            <span style={{ color: 'var(--muted)', fontFamily: 'var(--font-b)' }}>—</span>
          )}
        </div>

        {/* Active Session ID row */}
        {agent.current_task?.session_id && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', fontSize: 13, lineHeight: 1.5 }}>
            <span style={{ width: 88, flexShrink: 0, color: 'var(--muted)', fontFamily: 'var(--font-b)' }}>
              {t('agents.activeSessionId')}
            </span>
            <span style={{ fontFamily: 'var(--font-m)', fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1, minWidth: 0 }}>
              {agent.current_task.session_id}
            </span>
            <button
              title={t('agents.viewInSessions')}
              onClick={e => {
                e.stopPropagation();
                navigate(`/sessions?q=${agent.current_task!.session_id!}`);
              }}
              style={{
                background: 'rgba(59,130,246,0.15)',
                border: '1px solid rgba(59,130,246,0.5)',
                borderRadius: 3,
                color: 'var(--C-blue)',
                cursor: 'pointer',
                fontSize: 11,
                padding: '1px 6px',
                lineHeight: 1,
                flexShrink: 0,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
              }}
            >{t('agents.viewArrow')}</button>
          </div>
        )}
      </div>

      {/* Config section */}
      <div style={{
        paddingTop: 'var(--space-3)',
      }}>
        {/* 4-col mini-stat grid */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 6,
          padding: '6px 4px',
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.07)',
          borderRadius: 6,
        }}>
          {[
            { label: t('agents.files'),    value: String(agent.config.files) },
            { label: t('common.tools'),    value: agent.config.tools_profile || '—' },
            { label: t('agents.skills'),   value: String(agent.config.skills.length) },
            { label: t('agents.channels'), value: String(agent.config.channels.length) || '—' },
          ].map(({ label, value }) => (
            <div key={label} style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              gap: 3, padding: '4px 2px',
            }}>
              <span style={{
                fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase',
                letterSpacing: '.06em', fontFamily: 'var(--font-b)',
              }}>{label}</span>
              <span style={{
                fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-b)',
                fontVariantNumeric: 'tabular-nums', color: 'var(--text)',
                lineHeight: 1.2,
              }}>{value}</span>
            </div>
          ))}
        </div>

        {/* Cronjobs row — inside same box, separated by top border */}
        <div style={{
          marginTop: 8, paddingTop: 8,
          borderTop: '1px solid rgba(255,255,255,0.07)',
          display: 'flex', alignItems: 'flex-start', gap: 8,
        }}>
          <span style={{
            fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase',
            letterSpacing: '.06em', fontFamily: 'var(--font-b)', flexShrink: 0,
          }}>{t('nav.cron')}</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, flex: 1 }}>
            {agent.config.cron_tasks.length === 0 ? (
              <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--font-b)' }}>—</span>
            ) : agent.config.cron_tasks.map(task => (
              <span key={task} style={{
                fontFamily: 'var(--font-m)', fontSize: 10,
                background: 'rgba(176,141,87,0.12)',
                border: '1px solid rgba(176,141,87,0.3)',
                borderRadius: 'var(--radius-sm)', padding: '2px 7px',
                color: '#c8a96e',
              }}>
                {task}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Footer stats — row format matching Health / Last active rows */}
      {!isNew && (
        <div style={{
          borderTop: '1px solid rgba(255,255,255,0.09)',
          marginTop: 'var(--space-3)', paddingTop: 'var(--space-3)',
          display: 'flex', flexDirection: 'column', gap: 'var(--space-2)',
        }}>
          {/* Cost today — value only, no sub-text */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)', fontSize: 13, lineHeight: 1.5 }}>
            <span style={{ width: 88, flexShrink: 0, color: 'var(--muted)', fontFamily: 'var(--font-b)' }}>{t('agents.costToday')}</span>
            <span style={{ fontFamily: 'var(--font-b)', fontVariantNumeric: 'tabular-nums' }}>
              {agent.today.cost > 0 ? fmtCost(agent.today.cost) : '—'}
            </span>
          </div>

          {/* Sessions — today X, 7d X, 30d X */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)', fontSize: 13, lineHeight: 1.5 }}>
            <span style={{ width: 88, flexShrink: 0, color: 'var(--muted)', fontFamily: 'var(--font-b)' }}>{t('common.sessions')}</span>
            <span style={{ fontFamily: 'var(--font-b)', fontVariantNumeric: 'tabular-nums', display: 'inline-flex', alignItems: 'baseline', gap: 8 }}>
              <span>{agent.today.sessions} <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 11 }}>(today)</span></span>
              <span>{agent.last_7d.sessions} <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 11 }}>(7d)</span></span>
              <span>{agent.last_30d.sessions} <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 11 }}>(30d)</span></span>
            </span>
          </div>

          {/* Context */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)', fontSize: 13, lineHeight: 1.5 }}>
            <span style={{ width: 88, flexShrink: 0, color: 'var(--muted)', fontFamily: 'var(--font-b)' }}>{t('agents.context')}</span>
            {agent.last_session.context_pct !== null ? (
              <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
                <span style={{
                  fontFamily: 'var(--font-b)', fontVariantNumeric: 'tabular-nums',
                  color: agent.last_session.context_pct >= 100 ? 'var(--error)'
                       : agent.last_session.context_pct >= 80  ? '#c8a96e'
                       : agent.last_session.context_pct >= 60  ? '#f0c040'
                       : undefined,
                }}>
                  {agent.last_session.context_pct}%
                  {agent.last_session.context_pct >= 80 && <span style={{ marginLeft: 3, fontSize: 11 }}>↑</span>}
                </span>
                <span style={{ color: 'var(--muted)', fontSize: 11 }}>{t('agents.lastSession')}</span>
              </span>
            ) : <span style={{ fontFamily: 'var(--font-b)' }}>—</span>}
          </div>

          {/* Error rate */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)', fontSize: 13, lineHeight: 1.5 }}>
            <span style={{ width: 88, flexShrink: 0, color: 'var(--muted)', fontFamily: 'var(--font-b)' }}>{t('agents.errorRate')}</span>
            {agent.error_rate !== null ? (
              <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
                <span style={{
                  fontFamily: 'var(--font-b)', fontVariantNumeric: 'tabular-nums',
                  color: agent.error_rate >= 0.5 ? '#ef4444'
                       : agent.error_rate >= 0.25 ? '#f97316'
                       : agent.error_rate > 0    ? '#fb923c'
                       : '#4ade80',
                }}>
                  {agent.error_rate === 0 ? '0%' : `${Math.round(agent.error_rate * 100)}%`}
                </span>
                <span style={{ color: 'var(--muted)', fontSize: 11 }}>{t('agents.ofSessions7d')}</span>
              </span>
            ) : <span style={{ fontFamily: 'var(--font-b)' }}>—</span>}
          </div>

          {/* Cache hit rate */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)', fontSize: 13, lineHeight: 1.5 }}>
            <span style={{ width: 88, flexShrink: 0, color: 'var(--muted)', fontFamily: 'var(--font-b)' }}>{t('agents.cacheHit')}</span>
            {agent.cache_hit_rate !== null ? (
              <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
                <span style={{
                  fontFamily: 'var(--font-b)', fontVariantNumeric: 'tabular-nums',
                  color: agent.cache_hit_rate >= 0.6 ? '#4ade80'
                       : agent.cache_hit_rate >= 0.3 ? '#f0c040'
                       : 'var(--muted)',
                }}>
                  {fmtPct(agent.cache_hit_rate, 4)}
                </span>
                <span style={{ color: 'var(--muted)', fontSize: 11 }}>{t('agents.ofInputTokens7d')}</span>
              </span>
            ) : <span style={{ fontFamily: 'var(--font-b)', color: 'var(--muted)' }}>—</span>}
          </div>
        </div>
      )}

      {/* Click to see more — pinned to bottom */}
      <div style={{
        marginTop: 'auto', paddingTop: 'var(--space-3)',
        display: 'flex', justifyContent: 'flex-end',
      }}>
        <button
          onClick={() => onSelect(agent)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            fontSize: 11, fontFamily: 'var(--font-b)',
            color: isSelected ? 'var(--C-blue)' : 'var(--muted)',
            letterSpacing: '.02em',
            transition: 'color .15s',
          }}
        >
          {isSelected ? t('agents.closeUp') : t('agents.clickToSeeMore')}
        </button>
      </div>
    </Card>
  );
}


// ── Page ──────────────────────────────────────────────────────────────────────
export default function Agents() {
  const { t } = useTranslation();
  const fromTs = useMemo(() => Date.now() - 30 * 24 * 3_600_000, []);
  const { data, loading } = useFetch<AgentsData>(`/api/stats/agents?from=${fromTs}`, [fromTs]);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);

  const summary = data?.summary;
  const agents = useMemo(() => {
    const list = data?.agents ?? [];
    return [...list]
      .filter(a => a.dir_exists !== false)
      .sort((a, b) => b.last_activity_ts - a.last_activity_ts);
  }, [data?.agents]);

  function selectAgent(agent: Agent) {
    setSelectedAgent(prev => prev?.agent_name === agent.agent_name ? null : agent);
  }

  return (
    <div>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: .4; }
        }
      `}</style>

      <PageHeader title={t('common.agents')} />

      {/* KPI strip */}
      {(() => {
        const errorCount = agents.filter(a => a.health.status === 'error').length;
        return (
          <KpiStrip cols={5}>
            <Kpi value={summary?.total ?? '—'} label={t('agents.totalAgents')} />
            <Kpi
              value={summary?.running ?? 0} label={t('common.active')} color="var(--C-green)"
              tooltip={t('agents.activeDesc')}
            />
            <Kpi
              value={summary?.idle ?? 0} label={t('common.idle')} color="var(--C-blue)"
              tooltip={t('agents.idleDesc')}
            />
            <Kpi
              value={summary?.stale ?? 0} label={t('common.still')}
              tooltip={t('agents.stillDesc')}
            />
            <Kpi
              value={errorCount} label={t('agents.errorAgents')}
              color="var(--C-rose)"
              tooltip={t('agents.errorAgentsDesc')}
            />
          </KpiStrip>
        );
      })()}

      <div style={{ padding: 'var(--space-6) var(--space-8) 80px', display: 'flex', flexDirection: 'column', gap: 'var(--space-10)' }}>

        {/* ── Section: Agent Status ── */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 'var(--space-5)' }}>
            <div style={{ fontSize: 20, fontWeight: 600, color: 'var(--text)' }}>{t('agents.agentStatus')}</div>
            <InfoTooltip label={t('agents.healthCalcTitle')} placement="bottom" width={360}>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>{t('agents.healthCalcTitle')}</div>
                <div style={{ borderBottom: '1px dashed rgba(255,255,255,0.15)', marginBottom: 10 }} />
                {[
                  { labelKey: 'common.healthy', color: '#22c55e', key: 'healthyDesc' },
                  { labelKey: 'common.warning', color: '#eab308', key: 'warningDesc' },
                  { labelKey: 'common.error',   color: '#ef4444', key: 'errorDesc' },
                ].map(({ labelKey, color, key }) => (
                  <div key={key} style={{ marginBottom: 8, display: 'flex', gap: 7, alignItems: 'flex-start' }}>
                    <span style={{ color, fontWeight: 700, flexShrink: 0, minWidth: 52 }}>{t(labelKey)}</span>
                    <span>{t(`agents.${key}`)}</span>
                  </div>
                ))}
                <div style={{ color: 'var(--muted)', marginTop: 6, fontSize: 11 }}>{t('agents.healthScanNote')}</div>
              </div>
            </InfoTooltip>
          </div>
          {loading && <Loading />}
          {!loading && agents.length === 0 && <EmptyState>{t('agents.noAgentsFound')}</EmptyState>}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
            gap: 'var(--space-4)',
          }}>
            {agents.map(agent => (
              <React.Fragment key={agent.agent_name}>
                <AgentCard
                  agent={agent}
                  isSelected={selectedAgent?.agent_name === agent.agent_name}
                  onSelect={selectAgent}
                />
                {selectedAgent?.agent_name === agent.agent_name && (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <AgentDetailPanel
                      agent={selectedAgent}
                      onClose={() => setSelectedAgent(null)}
                    />
                  </div>
                )}
              </React.Fragment>
            ))}
          </div>
        </div>


      </div>
    </div>
  );
}
