import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useFetch, fmtDatetime, fmtTokens, fmtMs } from '../hooks';
import { PageHeader, KpiStrip, Kpi, Loading, EmptyState } from '../components/ui';
import { ChevronDown, ChevronRight, CheckCircle2, XCircle, Clock, Minus, Info } from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell, ReferenceLine,
} from 'recharts';

/* ── Types ─────────────────────────────────────────────────────────── */

interface CronSchedule { kind: string; expr?: string; tz?: string; staggerMs?: number; }
interface CronState {
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: string;
  lastStatus?: string;
  lastDurationMs?: number;
  lastDeliveryStatus?: string;
  consecutiveErrors?: number;
}

interface CronJob {
  id: string;
  agentId: string;
  name: string;
  enabled: boolean;
  schedule: CronSchedule;
  payload?: { kind: string; message?: string; timeoutSeconds?: number };
  delivery?: { mode: string };
  state?: CronState;
}

interface CronRun {
  ts: number;
  jobId: string;
  status: string;
  summary?: string;
  delivered?: boolean;
  deliveryStatus?: string;
  sessionId?: string;
  sessionExists?: boolean;
  runAtMs?: number;
  durationMs?: number;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read?: number; cache_write?: number; total_tokens?: number };
  error?: string;
}

/* ── Helpers ────────────────────────────────────────────────────────── */

function statusColor(s: string): string {
  if (s === 'ok' || s === 'success') return 'var(--C-green)';
  if (s === 'error' || s === 'failed') return 'var(--C-rose)';
  if (s === 'running') return 'var(--C-blue)';
  return 'var(--muted)';
}

function StatusIcon({ s, size = 14 }: { s: string; size?: number }) {
  if (s === 'ok' || s === 'success') return <CheckCircle2 size={size} color="var(--C-green)" />;
  if (s === 'error' || s === 'failed') return <XCircle size={size} color="var(--C-rose)" />;
  if (s === 'running') return <Clock size={size} color="var(--C-blue)" />;
  return <Minus size={size} color="var(--muted)" />;
}

function countdown(ms: number, t: TFunction): string {
  const diff = ms - Date.now();
  if (diff <= 0) return t('cron.overdue');
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}


function cronToHuman(expr: string | undefined, t: TFunction): string {
  if (!expr) return '';
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, month, dow] = parts;
  const days = [t('cron.day_0'), t('cron.day_1'), t('cron.day_2'), t('cron.day_3'), t('cron.day_4'), t('cron.day_5'), t('cron.day_6')];
  if (min === '*' && hour === '*' && dom === '*' && month === '*' && dow === '*') return t('cron.everyMinute');
  if (min.startsWith('*/') && hour === '*' && dom === '*' && month === '*' && dow === '*') return t('cron.everyNMin', { n: min.slice(2) });
  if (hour.startsWith('*/') && min === '0' && dom === '*' && month === '*' && dow === '*') return t('cron.everyNh', { n: hour.slice(2) });
  if (hour.startsWith('*/') && dom === '*' && month === '*' && dow === '*') return t('cron.everyNhAtM', { n: hour.slice(2), m: min.padStart(2, '0') });
  if (!hour.includes('*') && !hour.includes('/') && dom === '*' && month === '*' && dow === '*')
    return t('cron.dailyAt', { time: `${hour.padStart(2, '0')}:${min.padStart(2, '0')}` });
  if (!hour.includes('*') && dom === '*' && month === '*' && !dow.includes('*') && !dow.includes(',') && !dow.includes('/')) {
    const d = parseInt(dow);
    if (!isNaN(d) && d >= 0 && d <= 6) return t('cron.weeklyAt', { day: days[d], time: `${hour.padStart(2, '0')}:${min.padStart(2, '0')}` });
  }
  if (dom !== '*' && month === '*' && dow === '*' && !hour.includes('*') && !hour.includes('/'))
    return t('cron.monthlyOnDay', { day: dom, time: `${hour.padStart(2,'0')}:${min.padStart(2,'0')}` });
  return expr;
}


/* ── RunTrendChart ──────────────────────────────────────────────────── */

function RunTrendChart({ runs }: { runs: CronRun[] }) {
  const { t } = useTranslation();
  if (runs.length === 0) return null;

  const data = [...runs].reverse().map((r) => {
    const isErr = r.status === 'error' || r.status === 'failed';
    const runTime = r.runAtMs || r.ts;
    const d = new Date(runTime);
    const label = `${(d.getMonth() + 1)}/${d.getDate()}`;
    return {
      label,
      durationSec: Math.round((r.durationMs ?? 0) / 1000),
      isErr,
    };
  });

  // Average duration of successful runs for reference line
  const okRuns = data.filter(d => !d.isErr && d.durationSec > 0);
  const avgSec = okRuns.length > 0 ? Math.round(okRuns.reduce((s, d) => s + d.durationSec, 0) / okRuns.length) : 0;

  return (
    <div style={{
      padding: 'var(--space-3) var(--space-5)',
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>
        <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted)' }}>
          {t('cron.runTrend')}
        </span>
        {avgSec > 0 && <span style={{ fontSize: 10, color: 'var(--faint)' }}>{t('cron.avgDuration')}: {avgSec}s</span>}
      </div>
      <div style={{ maxWidth: 600 }}>
        <ResponsiveContainer width="100%" height={100}>
          <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <XAxis dataKey="label" tick={{ fontSize: 9, fill: 'var(--faint)' }} axisLine={false} tickLine={false} interval={0} />
            <YAxis hide />
            <Tooltip
              cursor={false}
              contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11, fontFamily: 'var(--font-b)' }}
              labelStyle={{ color: 'var(--muted)' }}
              itemStyle={{ color: 'var(--text)' }}
              formatter={(v) => [`${v}s`, t('common.duration')]}
              labelFormatter={(_, payload) => {
                const d = payload?.[0]?.payload;
                return d ? `${d.label} — ${d.isErr ? t('common.error') : t('common.ok')}` : '';
              }}
            />
            {avgSec > 0 && (
              <ReferenceLine y={avgSec} stroke="var(--muted)" strokeDasharray="4 3" strokeWidth={1} />
            )}
            <Bar dataKey="durationSec" radius={[2, 2, 0, 0]} maxBarSize={20} isAnimationActive={false}>
              {data.map((d, i) => (
                <Cell key={i} fill={d.isErr ? 'var(--C-rose)' : 'rgba(34,197,94,0.6)'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/* ── RunCard ─────────────────────────────────────────────────────────── */

function MetaItem({ label, value, mono, color }: { label: string; value: string; mono?: boolean; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--faint)' }}>
        {label}
      </span>
      <span style={{
        fontSize: 13, color: color || 'var(--text)', fontVariantNumeric: 'tabular-nums',
        fontFamily: mono ? 'var(--font-m)' : undefined,
      }}>
        {value}
      </span>
    </div>
  );
}

function RunCard({ run, period }: { run: CronRun; period?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isErr = run.status === 'error' || run.status === 'failed';
  const isOk = run.status === 'ok' || run.status === 'success';
  const runTime = run.runAtMs || run.ts;
  const modelShort = run.model ? run.model.replace(/^(claude-|anthropic\/)/, '') : null;

  return (
    <div style={{
      border: `1px solid ${isErr ? 'rgba(239,68,68,0.28)' : 'var(--border)'}`,
      borderLeft: `3px solid ${isErr ? 'var(--C-rose)' : isOk ? 'rgba(34,197,94,0.35)' : 'var(--border)'}`,
      borderRadius: 'var(--radius)',
      background: isErr ? 'rgba(239,68,68,0.03)' : 'var(--surface)',
      padding: '14px 18px',
      marginBottom: 10,
    }}>

      {/* Row 1: status + labeled meta */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 28, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--faint)' }}>
            {t('common.status')}
          </span>
          <span style={{ fontSize: 14, fontWeight: 700, color: statusColor(run.status), display: 'flex', alignItems: 'center', gap: 5 }}>
            <StatusIcon s={run.status} size={15} /> {run.status === 'error' || run.status === 'failed' ? t('common.error') : run.status === 'ok' || run.status === 'success' ? t('common.ok') : run.status}
          </span>
        </div>

        <MetaItem label={t('cron.lastRunTime')} value={fmtDatetime(runTime)} />
        {run.durationMs != null && (
          <MetaItem label={t('cron.tickTime')} value={fmtMs(run.durationMs)} />
        )}
        {period && (
          <MetaItem label={t('cron.tickPeriod')} value={period} />
        )}
        {run.usage?.total_tokens ? (
          <MetaItem
            label={t('cron.tokenCost')}
            value={`${fmtTokens(run.usage.total_tokens)} (${t('cron.in')} ${fmtTokens(run.usage.input_tokens ?? 0)} · ${t('cron.out')} ${fmtTokens(run.usage.output_tokens ?? 0)}${run.usage.cache_read != null ? ` · ${t('cron.cr')} ${fmtTokens(run.usage.cache_read)}` : ''}${run.usage.cache_write != null ? ` · ${t('cron.cw')} ${fmtTokens(run.usage.cache_write)}` : ''})`}
          />
        ) : null}
        {modelShort && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--faint)' }}>
              {t('common.model')}
            </span>
            <span style={{
              fontSize: 13, color: 'var(--muted)', fontFamily: 'var(--font-m)',
              background: 'var(--surface2)', borderRadius: 4, padding: '2px 8px', display: 'inline-block',
            }}>{modelShort}</span>
          </div>
        )}
      </div>

      {/* Row 2: summary or error */}
      {(run.summary || run.error) && (
        <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
          {isErr && run.error ? (
            <span style={{ fontSize: 12, color: 'var(--C-rose)', lineHeight: 1.6, display: 'block', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{run.error}</span>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.6 }}>{run.summary}</span>
          )}
        </div>
      )}

      {/* Row 3: session link — only when session still exists in DB */}
      {run.sessionExists && run.sessionId && (
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--faint)' }}>{t('cron.sessionLabel')}</span>
          <code style={{ fontFamily: 'var(--font-m)', fontSize: 11, color: 'var(--muted)' }}>
            {run.sessionId}
          </code>
          <button
            onClick={() => navigate(`/sessions?q=${run.sessionId}`)}
            style={{
              fontSize: 11, color: 'var(--C-blue)', background: 'none', border: 'none',
              cursor: 'pointer', padding: 0, textDecoration: 'underline', textUnderlineOffset: 2,
            }}
          >
            {t('cron.seeInSessions')}
          </button>
        </div>
      )}
    </div>
  );
}

/* ── JobRow ─────────────────────────────────────────────────────────── */

function JobRow({ job, onToggle }: { job: CronJob; onToggle: (id: string, enabled: boolean) => void }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState('');

  const { data: runs } = useFetch<CronRun[]>(
    expanded ? `/api/cron/runs?jobId=${encodeURIComponent(job.id)}&limit=20` : ''
  );

  const lastStatus = job.state?.lastStatus || job.state?.lastRunStatus || '';
  const isFailed = lastStatus === 'error' || lastStatus === 'failed';
  const isOk = lastStatus === 'ok' || lastStatus === 'success';
  const human = cronToHuman(job.schedule.expr, t);
  const tz = job.schedule.tz || '';

  async function toggleRunEnabled(e: React.MouseEvent) {
    e.stopPropagation();
    if (toggling) return;
    setToggling(true);
    setToggleError('');
    const next = !job.enabled;
    try {
      const res = await fetch(`/api/cron/jobs/${encodeURIComponent(job.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setToggleError((err as { error?: string }).error || t('cron.toggleFailed'));
      } else {
        onToggle(job.id, next);
      }
    } catch {
      setToggleError(t('cron.toggleNetworkError'));
    } finally {
      setToggling(false);
    }
  }

  return (
    <div style={{
      border: `1px solid ${isFailed ? 'rgba(239,68,68,0.35)' : 'var(--border)'}`,
      borderRadius: 'var(--radius)',
      background: 'var(--surface)',
      marginBottom: 'var(--space-2)',
      overflow: 'hidden',
    }}>
      {/* Header row */}
      <div
        onClick={() => setExpanded(e => !e)}
        style={{
          display: 'grid',
          gridTemplateColumns: '20px 1fr 190px 130px 180px 120px 100px',
          alignItems: 'center',
          gap: 'var(--space-4)',
          padding: '16px var(--space-5)',
          cursor: 'pointer',
          borderLeft: isFailed ? '3px solid var(--C-rose)' : isOk ? '3px solid rgba(34,197,94,0.25)' : '3px solid transparent',
          background: expanded ? 'var(--surface2)' : undefined,
          transition: 'background .12s',
        }}
      >
        {/* Expand chevron */}
        <span style={{ color: 'var(--muted)', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </span>

        {/* Name + agent */}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {job.name}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
            {job.agentId}
          </div>
        </div>

        {/* Schedule */}
        <div>
          <div style={{ fontFamily: 'var(--font-m)', fontSize: 13, color: 'var(--muted)' }}>
            {job.schedule.expr || job.schedule.kind}
          </div>
          <div style={{ fontSize: 12, color: 'var(--faint)', marginTop: 3 }}>
            {human}{tz ? ` · ${tz}` : ''}
          </div>
        </div>

        {/* Next run */}
        <div style={{ fontSize: 14, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
          {job.state?.nextRunAtMs ? countdown(job.state.nextRunAtMs, t) : <span style={{ color: 'var(--faint)' }}>—</span>}
        </div>

        {/* Last run + status */}
        <div>
          {job.state?.lastRunAtMs ? (
            <>
              <div style={{ fontSize: 13, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
                {fmtDatetime(job.state.lastRunAtMs)}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 3 }}>
                <StatusIcon s={lastStatus} size={13} />
                <span style={{ fontSize: 12, color: 'var(--faint)' }}>{fmtMs(job.state.lastDurationMs)}</span>
                {(job.state.consecutiveErrors ?? 0) > 0 && (
                  <span style={{ fontSize: 12, color: 'var(--C-rose)' }}>×{job.state.consecutiveErrors}</span>
                )}
              </div>
            </>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--faint)' }}>{t('cron.neverRun')}</span>
          )}
        </div>

        {/* Status badge */}
        <div>
          {lastStatus ? (
            <span style={{
              fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em',
              color: statusColor(lastStatus),
              background: isFailed ? 'rgba(239,68,68,0.10)' : 'rgba(34,197,94,0.10)',
              padding: '3px 10px', borderRadius: 'var(--radius-sm)',
            }}>
              {lastStatus === 'error' || lastStatus === 'failed' ? t('common.error') : lastStatus === 'ok' || lastStatus === 'success' ? t('common.ok') : lastStatus}
            </span>
          ) : <span style={{ color: 'var(--faint)', fontSize: 13 }}>—</span>}
        </div>

        {/* Toggle */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
          <div
            onClick={toggleRunEnabled}
            title={job.enabled ? t('cron.clickToDisable') : t('cron.clickToEnable')}
            style={{
              width: 40, height: 22,
              borderRadius: 11,
              background: job.enabled ? 'var(--C-green)' : '#4a4a52',
              border: `1px solid ${job.enabled ? 'var(--C-green)' : '#5a5a64'}`,
              position: 'relative',
              cursor: toggling ? 'not-allowed' : 'pointer',
              opacity: toggling ? 0.5 : 1,
              transition: 'background .2s, border-color .2s',
              flexShrink: 0,
            }}
          >
            <div style={{
              position: 'absolute',
              top: 3, left: job.enabled ? 21 : 3,
              width: 16, height: 16,
              borderRadius: '50%',
              background: '#fff',
              boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
              transition: 'left .2s',
            }} />
          </div>
          {toggleError && <span style={{ fontSize: 11, color: 'var(--C-rose)' }}>{toggleError}</span>}
        </div>
      </div>

      {/* Expanded section */}
      {expanded && (
        <div style={{ borderTop: '1px solid var(--border)', background: 'var(--bg)' }}>
          {/* Prompt preview */}
          {job.payload?.message && (
            <div style={{
              padding: 'var(--space-3) var(--space-5)',
              borderBottom: '1px solid var(--border)',
              background: 'var(--surface2)',
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted)', marginBottom: 6 }}>
                {t('cron.prompt')}
              </div>
              <pre style={{
                fontSize: 12, color: 'rgba(255,255,255,0.85)', fontFamily: 'var(--font-m)',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0,
                maxHeight: 200, overflowY: 'auto',
                background: '#000',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                padding: '10px 12px',
              }}>
                {job.payload.message}
              </pre>
            </div>
          )}

          {/* Run trend chart */}
          {runs && runs.length > 1 && <RunTrendChart runs={runs} />}

          {/* Run history */}
          <div style={{ padding: 'var(--space-3) var(--space-5)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 'var(--space-3)' }}>
              <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted)' }}>
                {t('cron.last20Runs')}
              </span>
              <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }} className="runs-tip-wrap">
                <Info size={12} style={{ color: 'var(--faint)', cursor: 'default' }} />
                <span className="runs-tip-box" style={{
                  display: 'none', position: 'absolute', top: '1.6rem', left: 0,
                  width: 390, maxHeight: '80vh', overflowY: 'auto',
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  borderRadius: 8,
                  boxShadow: '0 8px 32px rgba(0,0,0,.5)', zIndex: 200,
                }}>
                  {/* ── 1. 数据来源 ── */}
                  <div style={{ padding: '12px 14px 10px', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--C-blue)', flexShrink: 0, display: 'inline-block' }} />
                      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.04em', color: 'var(--C-blue)', textTransform: 'uppercase' }}>{t('cron.runsTooltipDataSource')}</span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 7, lineHeight: 1.55 }}>{t('cron.runsTooltipDataSourceBody')}</div>
                    <code style={{ display: 'block', background: 'rgba(99,179,237,0.08)', border: '1px solid rgba(99,179,237,0.2)', borderRadius: 4, padding: '5px 9px', fontSize: 11, color: 'var(--C-blue)', wordBreak: 'break-all', fontFamily: 'var(--font-m)' }}>
                      ~/.openclaw/cron/runs/{'<jobId>'}.jsonl
                    </code>
                  </div>

                  {/* ── 2. Session 引用 ── */}
                  <div style={{ padding: '12px 14px 10px', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--C-green)', flexShrink: 0, display: 'inline-block' }} />
                      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.04em', color: 'var(--C-green)', textTransform: 'uppercase' }}>{t('cron.runsTooltipSessionRef')}</span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8, lineHeight: 1.55 }}>{t('cron.runsTooltipSessionRefBody')}</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div>
                        <code style={{ display: 'block', background: 'rgba(72,187,120,0.08)', border: '1px solid rgba(72,187,120,0.2)', borderRadius: 4, padding: '5px 9px', fontSize: 11, color: 'var(--C-green)', wordBreak: 'break-all', fontFamily: 'var(--font-m)' }}>
                          ~/.openclaw/agents/{'<agentId>'}/sessions/{'<sessionId>'}.jsonl
                        </code>
                        <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2, paddingLeft: 4 }}>↳ {t('cron.runsTooltipSessionFile')}</div>
                      </div>
                      <div>
                        <code style={{ display: 'block', background: 'rgba(99,179,237,0.08)', border: '1px solid rgba(99,179,237,0.2)', borderRadius: 4, padding: '5px 9px', fontSize: 11, color: 'var(--C-blue)', wordBreak: 'break-all', fontFamily: 'var(--font-m)' }}>
                          ~/.openclaw/cron/runs/{'<jobId>'}.jsonl
                        </code>
                        <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2, paddingLeft: 4 }}>↳ {t('cron.runsTooltipRunFile')}</div>
                      </div>
                    </div>
                  </div>

                  {/* ── 3. 清理机制 ── */}
                  <div style={{ padding: '12px 14px 10px', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--C-amber)', flexShrink: 0, display: 'inline-block' }} />
                      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.04em', color: 'var(--C-amber)', textTransform: 'uppercase' }}>{t('cron.runsTooltipPrune')}</span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>{t('cron.runsTooltipPruneBody')}</div>
                  </div>

                  {/* ── 修改方式 ── */}
                  <div style={{ padding: '12px 14px', background: 'var(--bg-1)' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.04em', textTransform: 'uppercase', marginBottom: 7 }}>{t('cron.runsTooltipChangeTitle')}</div>
                    <pre style={{ margin: '0 0 8px', padding: '8px 10px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 11, overflowX: 'auto', color: 'var(--text)', fontFamily: 'var(--font-m)', lineHeight: 1.6 }}>{`{
  "cron": {
    "sessionRetention": "48h"
  }
}`}</pre>
                    <div style={{ fontSize: 12, color: 'var(--faint)', lineHeight: 1.55 }}>
                      {t('cron.runsTooltipChangeAccepted')}{' '}
                      <code style={{ background: 'var(--surface)', borderRadius: 3, padding: '1px 5px', fontSize: 11, color: 'var(--text)' }}>"24h"</code>,{' '}
                      <code style={{ background: 'var(--surface)', borderRadius: 3, padding: '1px 5px', fontSize: 11, color: 'var(--text)' }}>"7d"</code>,{' '}
                      <code style={{ background: 'var(--surface)', borderRadius: 3, padding: '1px 5px', fontSize: 11, color: 'var(--text)' }}>false</code>{' '}
                      {t('cron.runsTooltipChangeNever')}<br />
                      {t('cron.runsTooltipChangeRestart')}
                    </div>
                  </div>
                </span>
                <style>{`.runs-tip-wrap:hover .runs-tip-box { display: block !important; }`}</style>
              </span>
            </div>
            {!runs && <div style={{ color: 'var(--muted)', fontSize: 13 }}>{t('common.loading')}</div>}
            {runs && runs.length === 0 && <div style={{ color: 'var(--faint)', fontSize: 13 }}>{t('cron.noRunsYet')}</div>}
            {runs && runs.length > 0 && runs.map((run, i) => (
              <RunCard key={run.sessionId || i} run={run} period={human || undefined} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Page ───────────────────────────────────────────────────────────── */

export default function Cron() {
  const { t } = useTranslation();
  const { data: rawJobs, loading } = useFetch<CronJob[]>('/api/cron/jobs');
  const { data: allRuns } = useFetch<CronRun[]>('/api/cron/runs?limit=200');

  const [localJobs, setLocalJobs] = useState<CronJob[] | null>(null);
  const jobs = localJobs ?? (Array.isArray(rawJobs) ? rawJobs : []);
  const runList = Array.isArray(allRuns) ? allRuns : [];

  // Sync localJobs when rawJobs first arrives
  if (rawJobs && !localJobs) setLocalJobs(Array.isArray(rawJobs) ? rawJobs : []);

  function toggleJobEnabled(id: string, enabled: boolean) {
    setLocalJobs(prev => (prev ?? []).map(j => j.id === id ? { ...j, enabled } : j));
  }

  const enabledCount = jobs.filter(j => j.enabled).length;
  const failedCount = jobs.filter(j => {
    const s = j.state?.lastStatus || j.state?.lastRunStatus;
    return s === 'error' || s === 'failed';
  }).length;

  const todayStart = useMemo(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime();
  }, []);
  const todayRuns = runList.filter(r => (r.runAtMs || r.ts) >= todayStart).length;
  const failedToday = runList.filter(r =>
    (r.runAtMs || r.ts) >= todayStart && (r.status === 'error' || r.status === 'failed')
  ).length;

  const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const failedRecent = runList.filter(r =>
    (r.runAtMs || r.ts) >= sevenDaysAgo && (r.status === 'error' || r.status === 'failed')
  ).length;

  const nextJob = [...jobs]
    .filter(j => j.enabled && j.state?.nextRunAtMs)
    .sort((a, b) => (a.state?.nextRunAtMs ?? 0) - (b.state?.nextRunAtMs ?? 0))[0];

  return (
    <div style={{ padding: '0 var(--space-5) var(--space-8)' }}>
      <PageHeader title={t('cron.title')} subtitle={t('cron.subtitle', { total: jobs.length, enabled: enabledCount })} />


      <KpiStrip cols={5} style={{ marginBottom: 'var(--space-3)' }}>
        <Kpi label={t('cron.jobsEnabled')} value={loading ? '—' : `${jobs.length} / ${enabledCount}`} />
        <Kpi label={t('cron.runsToday')} value={loading ? '—' : todayRuns} sub={t('cron.since0000')} />
        <Kpi
          label={t('cron.failuresToday')}
          value={loading ? '—' : failedToday}
          color={failedToday > 0 ? 'var(--C-rose)' : undefined}
          highlight={failedToday > 0}
        />
        <Kpi
          label={t('cron.failures7d')}
          value={loading ? '—' : failedRecent}
          color={failedRecent > 0 ? 'var(--C-rose)' : undefined}
          highlight={failedRecent > 0}
        />
        <Kpi
          label={t('cron.nextRun')}
          value={nextJob?.state?.nextRunAtMs ? countdown(nextJob.state.nextRunAtMs, t) : '—'}
          sub={nextJob?.name}
        />
      </KpiStrip>

      {loading && <Loading />}

      {!loading && jobs.length === 0 && (
        <EmptyState>
          {t('cron.noJobs')}{' '}
          <code style={{ fontFamily: 'var(--font-m)', fontSize: 12 }}>~/.openclaw/cron/jobs.json</code>
        </EmptyState>
      )}

      {!loading && jobs.length > 0 && (
        <>
          {failedCount > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 var(--space-4)', marginTop: 4, marginBottom: 14 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--C-rose)', flexShrink: 0, display: 'inline-block' }} />
              <span style={{ fontSize: 12, color: 'var(--C-rose)' }}>
                {t('cron.failedJobCount', { count: failedCount })} {t('cron.failedOnLast')}
              </span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>— {t('cron.clickToExpand')}</span>
            </div>
          )}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '20px 1fr 190px 130px 180px 120px 100px',
            gap: 'var(--space-3)',
            padding: '0 var(--space-4) var(--space-2)',
            fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted)',
          }}>
            <span /><span>{t('cron.job')}</span><span>{t('cron.schedule')}</span><span>{t('cron.nextRun')}</span><span>{t('cron.lastRun')}</span><span>{t('common.status')}</span><span>{t('common.enabled')}</span>
          </div>

          {jobs.map(job => (
            <JobRow key={job.id} job={job} onToggle={toggleJobEnabled} />
          ))}
        </>
      )}
    </div>
  );
}
