import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { PageHeader, EmptyState } from '../components/ui';
import { useFetch } from '../hooks';

// ── Types ─────────────────────────────────────────────────────────────────────

type SessionStatus = 'running' | 'stuck' | 'idle';

interface LiveSession {
  session_id: string;
  agent_name: string;
  file_mtime_ms: number;
  idle_ms: number;
  status: SessionStatus;
  last_tool: string | null;
}

interface LiveSessionsData { sessions: LiveSession[] }

interface TraceToolCall {
  id: string;
  tool_name: string;
  args_preview: string | null;
  duration_ms: number | null;
  success: boolean;
  result_preview: string | null;
}

interface TraceTurn {
  index: number;
  thinking: string | null;
  assistant_text: string | null;
  tools: TraceToolCall[];
  stop_error: string | null;
}

interface TraceData {
  session_id: string;
  last_user_msg: string | null;
  is_open: boolean;
  total_turns: number;
  turns: TraceTurn[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtIdle(ms: number, t: TFunction): string {
  if (ms < 60_000) return t('common.secsAgo', { n: Math.round(ms / 1000) });
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return t('common.minsAgo', { n: totalMin });
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const hStr = h === 1 ? t('common.1hour') : t('common.nHours', { n: h });
  return m === 0 ? t('common.hoursAgo', { n: hStr }) : t('common.hhmmAgo', { h, m });
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return '';
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
  if (ms >= 1000)  return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

// ── ThinkingBlock ─────────────────────────────────────────────────────────────

function ThinkingBlock({ text }: { text: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{
      margin: '4px 0 6px',
      padding: '6px 10px',
      background: 'rgba(167,139,250,0.06)',
      borderLeft: '2px solid rgba(167,139,250,0.25)',
      borderRadius: '0 4px 4px 0',
    }}>
      <button
        onClick={() => setExpanded(e => !e)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 6 }}
      >
        <span style={{ fontSize: 10, color: 'rgba(167,139,250,0.6)' }}>{expanded ? '▾' : '▸'}</span>
        <span style={{ fontSize: 11, color: 'rgba(167,139,250,0.7)', fontStyle: 'italic', fontFamily: 'var(--font-b)' }}>
          {t('live.thinking')}
        </span>
        <span style={{ fontSize: 10, color: 'var(--faint)' }}>({text.length} {t('live.chars')})</span>
      </button>
      <div style={{
        marginTop: 6,
        fontSize: 12,
        color: 'rgba(167,139,250,0.75)',
        fontStyle: 'italic',
        lineHeight: 1.6,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: expanded ? 300 : 80,
        overflowY: 'auto',
      }}>
        {text}
      </div>
    </div>
  );
}

// ── SessionLiveTrace ──────────────────────────────────────────────────────────

function SessionLiveTrace({ sessionId, isStuck }: { sessionId: string; isStuck: boolean }) {
  const { t } = useTranslation();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const { data, error } = useFetch<TraceData>(`/api/sessions/${sessionId}/trace`, [sessionId, tick]);

  if (error && !data) return null;
  if (!data) return <div style={{ padding: '12px 16px', fontSize: 12, color: 'var(--faint)' }}>{t('live.loading')}</div>;

  const accentColor = isStuck ? 'var(--C-amber)' : 'var(--C-green)';
  const totalTools  = data.turns.reduce((sum, t) => sum + t.tools.length, 0);

  return (
    <div style={{ padding: '10px 16px 14px' }}>
      {/* Stats */}
      <div style={{ fontSize: 11, color: 'var(--faint)', marginBottom: 10, fontFamily: 'var(--font-m)' }}>
        {data.total_turns} {t('live.turns')} · {totalTools} {t('live.tools')}
      </div>

      {/* User message */}
      {data.last_user_msg && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 12, alignItems: 'flex-start' }}>
          <span style={{
            fontSize: 10, fontWeight: 700, color: 'var(--C-blue)',
            background: 'rgba(96,165,250,0.12)', padding: '2px 7px',
            borderRadius: 3, flexShrink: 0, marginTop: 2, letterSpacing: '.04em',
          }}>{t('live.labelYou')}</span>
          <span style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6 }}>
            {data.last_user_msg}
          </span>
        </div>
      )}

      {/* Turns */}
      {data.turns.map((turn) => (
        <div key={turn.index} style={{ marginBottom: 10 }}>

          {/* Thinking */}
          {turn.thinking && <ThinkingBlock text={turn.thinking} />}

          {/* AI text */}
          {turn.assistant_text && (
            <div style={{ display: 'flex', gap: 10, marginBottom: 6, alignItems: 'flex-start' }}>
              <span style={{
                fontSize: 10, fontWeight: 700, color: 'rgba(167,139,250,0.9)',
                background: 'rgba(167,139,250,0.1)', padding: '2px 7px',
                borderRadius: 3, flexShrink: 0, marginTop: 2, letterSpacing: '.04em',
              }}>{t('live.labelAI')}</span>
              <span style={{ fontSize: 13, color: 'var(--muted)', fontStyle: 'italic', lineHeight: 1.6, wordBreak: 'break-word' }}>
                {turn.assistant_text}
              </span>
            </div>
          )}

          {/* Error stop */}
          {turn.stop_error && (
            <div style={{
              display: 'flex', gap: 8, marginBottom: 6, alignItems: 'flex-start',
              padding: '7px 10px',
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.25)',
              borderLeft: '3px solid rgba(239,68,68,0.6)',
              borderRadius: '0 4px 4px 0',
            }}>
              <span style={{ fontSize: 11, color: 'var(--C-rose)', fontWeight: 700, flexShrink: 0 }}>{t('live.errorLabel')}</span>
              <span style={{ fontFamily: 'var(--font-m)', fontSize: 11, color: 'var(--C-rose)', lineHeight: 1.6, wordBreak: 'break-word' }}>
                {turn.stop_error}
              </span>
            </div>
          )}

          {/* Tool calls + results */}
          {turn.tools.map((tc) => (
            <div key={tc.id} style={{ marginBottom: 6 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <span style={{ fontSize: 11, color: tc.success ? 'var(--C-green)' : 'var(--C-rose)', width: 14, textAlign: 'center', flexShrink: 0 }}>
                  {tc.success ? '✓' : '✗'}
                </span>
                <span style={{ fontFamily: 'var(--font-m)', fontSize: 12, fontWeight: 600, color: tc.success ? 'var(--text)' : 'var(--C-rose)', flexShrink: 0 }}>
                  {tc.tool_name}
                </span>
                {tc.args_preview && (
                  <span style={{ fontFamily: 'var(--font-m)', fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                    {tc.args_preview}
                  </span>
                )}
                {tc.duration_ms != null && (
                  <span style={{ fontFamily: 'var(--font-m)', fontSize: 11, color: 'var(--faint)', flexShrink: 0 }}>
                    {fmtDuration(tc.duration_ms)}
                  </span>
                )}
              </div>
              {tc.result_preview && (
                <div style={{
                  marginLeft: 22, marginTop: 4,
                  padding: '8px 12px',
                  background: 'rgba(15,23,42,0.9)',
                  border: '1px solid rgba(59,130,246,0.2)',
                  borderLeft: '3px solid rgba(59,130,246,0.5)',
                  borderRadius: '0 4px 4px 0',
                  fontFamily: 'var(--font-m)', fontSize: 11,
                  color: tc.success ? '#93c5fd' : 'var(--C-rose)',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                  lineHeight: 1.6,
                  maxHeight: 140, overflowY: 'auto',
                }}>
                  {tc.result_preview}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}

      {/* Status tail */}
      {data.is_open && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
          <span style={{ fontSize: 11, color: accentColor, animation: 'pulse 1.5s ease-in-out infinite' }}>⟳</span>
          <span style={{ fontSize: 12, color: accentColor, fontStyle: 'italic', fontFamily: 'var(--font-m)' }}>
            {isStuck ? t('live.noNewActivity') : t('live.waitingForResponse')}
          </span>
        </div>
      )}
    </div>
  );
}

// ── LiveMonitor ───────────────────────────────────────────────────────────────

export default function LiveMonitor() {
  const { t } = useTranslation();
  const [tick, setTick] = useState(0);
  const [wsConnected, setWsConnected] = useState(false);

  useEffect(() => {
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (disposed) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${window.location.host}/ws/live`);
      ws.onopen  = () => { if (!disposed) setWsConnected(true); };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string) as { type?: string };
          if (msg.type === 'data_updated') setTick(t => t + 1);
        } catch { /* ignore */ }
      };
      ws.onclose = () => { if (!disposed) { setWsConnected(false); retryTimer = setTimeout(connect, 3000); } };
      ws.onerror = () => {};
    }

    connect();
    const POLL_INTERVAL_MS = 5_000;
    const pollId = setInterval(() => setTick(t => t + 1), POLL_INTERVAL_MS);

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      clearInterval(pollId);
    };
  }, []);

  const { data, error: fetchError } = useFetch<LiveSessionsData>('/api/stats/live-sessions', [tick]);
  const connected = wsConnected && !fetchError;
  const sessions = data?.sessions ?? [];

  return (
    <div>
      <PageHeader title={t('live.title')}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: connected ? 'var(--C-green)' : 'var(--C-rose)', flexShrink: 0 }} />
          <span style={{ fontSize: 13, color: connected ? 'var(--C-green)' : 'var(--C-rose)', fontFamily: 'var(--font-m)' }}>
            {connected ? t('live.connected') : t('live.notConnected')}
          </span>
        </span>
      </PageHeader>

      {/* Legend */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 20,
        padding: 'var(--space-3) var(--space-4) 0',
        fontSize: 11, fontFamily: 'var(--font-m)', color: 'var(--muted)',
        flexWrap: 'nowrap', overflow: 'hidden',
      }}>
        {[
          { color: 'var(--C-green)', label: t('live.legendRunning') },
          { color: 'var(--C-amber)', label: t('live.legendStuck')   },
          { color: 'var(--muted)',   label: t('live.legendIdle')     },
        ].map(({ color, label }) => (
          <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
            {label}
          </span>
        ))}
      </div>
      <div style={{
        padding: 'var(--space-2) var(--space-4) var(--space-6)',
        fontSize: 11, fontFamily: 'var(--font-m)', color: 'var(--faint)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {t('live.ingestDelay')}
      </div>

      {sessions.length === 0 ? (
        <EmptyState>
          <div style={{ fontSize: 14, color: 'var(--muted)' }}>{t('live.allQuiet')}</div>
          <div style={{ fontSize: 12, color: 'var(--faint)', marginTop: 8 }}>
            {t('live.autoUpdate')}
          </div>
        </EmptyState>
      ) : (
        <div style={{ padding: 'var(--space-4)', paddingTop: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' }}>
          {sessions.map(session => {
            const isStuck = session.status === 'stuck';
            const isIdle  = session.status === 'idle';
            const accentColor = isStuck ? 'var(--C-amber)' : isIdle ? 'rgba(255,255,255,0.3)' : 'var(--C-green)';

            return (
              <div key={session.session_id} style={{
                border: `1px solid ${isStuck ? 'rgba(251,191,36,0.45)' : isIdle ? 'rgba(255,255,255,0.1)' : 'rgba(34,197,94,0.4)'}`,
                borderRadius: 'var(--radius)',
                background: isStuck ? 'rgba(30,24,8,0.95)' : isIdle ? 'rgba(20,20,22,0.95)' : 'rgba(8,20,14,0.95)',
                boxShadow: isStuck
                  ? '0 0 0 1px rgba(251,191,36,0.12), 0 4px 24px rgba(251,191,36,0.06)'
                  : isIdle ? 'none'
                  : '0 0 0 1px rgba(34,197,94,0.1), 0 4px 24px rgba(34,197,94,0.07)',
                overflow: 'hidden',
                opacity: isIdle ? 0.82 : 1,
              }}>
                {/* Header */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '10px 16px',
                  borderBottom: `1px solid ${isStuck ? 'rgba(251,191,36,0.2)' : isIdle ? 'rgba(255,255,255,0.06)' : 'rgba(34,197,94,0.18)'}`,
                  background: isStuck ? 'rgba(251,191,36,0.05)' : isIdle ? 'rgba(255,255,255,0.02)' : 'rgba(34,197,94,0.05)',
                }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: accentColor, flexShrink: 0,
                    boxShadow: (!isStuck && !isIdle) ? `0 0 6px ${accentColor}` : 'none',
                    animation: (!isStuck && !isIdle) ? 'pulse 2s ease-in-out infinite' : 'none',
                  }} />
                  <span style={{ fontFamily: 'var(--font-b)', fontWeight: 700, fontSize: 14, color: isIdle ? 'var(--muted)' : 'var(--text)' }}>
                    {session.agent_name}
                  </span>
                  <span style={{ fontFamily: 'var(--font-m)', fontSize: 11, color: 'var(--faint)' }}>
                    {session.session_id.slice(0, 8)}
                  </span>
                  <span style={{
                    fontSize: 10, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase',
                    color: accentColor, background: `${accentColor}1a`, padding: '2px 7px', borderRadius: 3,
                  }}>
                    {isStuck ? t('live.statusStuck') : isIdle ? t('live.statusIdle') : t('live.statusRunning')}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--faint)' }}>{fmtIdle(session.idle_ms, t)}</span>
                  {session.last_tool && (
                    <span style={{ fontFamily: 'var(--font-m)', fontSize: 11, color: 'var(--muted)' }}>
                      · {t('live.lastTool')}: {session.last_tool}
                    </span>
                  )}
                </div>

                {/* Second row: session ID + nav links */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 16,
                  padding: '6px 16px',
                  borderBottom: `1px solid ${isStuck ? 'rgba(251,191,36,0.12)' : isIdle ? 'rgba(255,255,255,0.04)' : 'rgba(34,197,94,0.1)'}`,
                  background: 'rgba(0,0,0,0.15)',
                }}>
                  <span style={{ fontFamily: 'var(--font-m)', fontSize: 11, color: 'var(--faint)', letterSpacing: '.02em', flex: 1 }}>
                    {session.session_id}
                  </span>
                  <Link
                    to={`/sessions?q=${session.session_id}`}
                    style={{ fontSize: 11, color: 'var(--C-blue)', fontFamily: 'var(--font-m)', textDecoration: 'none', opacity: 0.8 }}
                  >
                    {t('live.viewInSessions')} →
                  </Link>
                  <Link
                    to={`/timeline?session=${session.session_id}`}
                    style={{ fontSize: 11, color: 'var(--C-blue)', fontFamily: 'var(--font-m)', textDecoration: 'none', opacity: 0.8 }}
                  >
                    {t('live.viewInTimeline')} →
                  </Link>
                </div>

                <SessionLiveTrace sessionId={session.session_id} isStuck={isStuck} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
