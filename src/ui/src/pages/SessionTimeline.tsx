import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { useFetch, fmtMs, fmtTokens, fmtCost } from '../hooks';
import { PageHeader, Loading, KpiStrip, Kpi, InfoTooltip } from '../components/ui';

/* ── types ── */
interface SessionRow {
  id: string;
  agent_name: string;
  primary_model: string;
  started_at: number;
  ended_at: number;
  total_messages: number;
  total_cost: number;
}
interface ToolSlice {
  id: string;
  tool_name: string;
  start_ms: number;       // compressed — for Gantt positioning
  wall_start_ms: number;  // wall clock — for table display
  duration_ms: number;
  success: boolean;
  lane: number;            // vertical lane index (0-based) for parallel tools
  total_lanes: number;     // how many parallel lanes in this turn
  arguments: string | null;
  raw_input: string | null;
  raw_output: string | null;
  extra_json: string | null;
  risk_flags: string | null;
  risk_score: number | null;
  target: string | null;
  event_type: string | null;
}
interface TurnSlice {
  seq: number;
  message_id: string;           // assistant message ID — for content lookup
  user_message_id: string | null; // preceding user message ID
  start_ms: number;       // compressed — for Gantt
  end_ms: number;
  wall_start_ms: number;  // wall clock — for table
  llm_ms: number;
  tool_time_ms: number;   // parallel-aware wall-clock span of tool execution
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  cost: number;
  stop_reason: string | null;
  error_message: string | null;
  tool_calls: ToolSlice[];
}
interface TimelineData {
  available: boolean;
  session_id: string;
  session_start: number;
  duration_ms: number;           // compressed active time — Gantt axis
  wall_duration_ms: number;      // real wall-clock span
  idle_gaps_compressed: number;  // how many gaps were compressed
  turn_count: number;
  tool_count: number;
  turns: TurnSlice[];
  tool_names: string[];
}

/* ── color palette ── */
const TOOL_COLORS: Record<string, string> = {
  // lowercase keys (as returned by OpenClaw JSONL)
  exec:           '#fbbf24',
  read:           '#34d399',
  write:          '#a78bfa',
  edit:           '#22d3ee',
  glob:           '#a3e635',
  grep:           '#bef264',
  process:        '#2dd4bf',
  sessions_spawn: '#f472b6',
  sessions_send:  '#f9a8d4',
  sessions_list:  '#f472b6',
  sessions_yield: '#e879f9',
  session_status: '#c4b5fd',
  web_fetch:      '#fb923c',
  web_search:     '#fdba74',
  subagents:      '#c4b5fd',
  image:          '#fda4af',
  cron:           '#818cf8',
  memory_search:  '#67e8f9',
  // PascalCase keys (Claude Code style)
  Bash:           '#fbbf24',
  Read:           '#34d399',
  Write:          '#a78bfa',
  Edit:           '#22d3ee',
  Glob:           '#a3e635',
  Grep:           '#bef264',
  Agent:          '#f472b6',
  Task:           '#818cf8',
  WebFetch:       '#fb923c',
  WebSearch:      '#fdba74',
  TodoWrite:      '#c4b5fd',
  NotebookEdit:   '#fda4af',
};
const LLM_COLOR   = '#6b7280';
const LLM_COLOR_L = 'rgba(107,114,128,0.35)';

function toolColor(name: string): string {
  return TOOL_COLORS[name] ?? '#6b7280';
}

/* ── stop-reason pill ──
 * pi-ai (mariozechner/pi-ai) StopReason: "stop" | "length" | "toolUse" | "error" | "aborted"
 * "stop"    = model finished naturally (≡ Anthropic end_turn / OpenAI stop)
 * "toolUse" = model requested a tool call
 * "length"  = max_tokens limit hit (≡ Anthropic max_tokens)
 * "error"   = API / network / provider error
 * "aborted" = user aborted via AbortSignal
 */
type StopMeta = { label: string; fg: string; bg: string };
function stopMeta(raw: string | null): StopMeta {
  switch (raw) {
    case 'stop':    return { label: 'stop',    fg: '#6b7280', bg: 'rgba(107,114,128,0.15)' };
    case 'toolUse': return { label: 'toolUse', fg: '#3b82f6', bg: 'rgba(59,130,246,0.15)'  };
    case 'length':  return { label: 'length',  fg: '#f97316', bg: 'rgba(249,115,22,0.15)'  };
    case 'error':   return { label: 'error',   fg: '#ef4444', bg: 'rgba(239,68,68,0.15)'   };
    case 'aborted': return { label: 'aborted', fg: '#ef4444', bg: 'rgba(239,68,68,0.15)'   };
    default:        return { label: raw ?? '?', fg: '#f59e0b', bg: 'rgba(245,158,11,0.15)' };
  }
}
function StopPill({ reason }: { reason: string | null }) {
  if (!reason) return null;
  const { t } = useTranslation();
  const { label, fg, bg } = stopMeta(reason);
  const displayLabel = t('sessionTimeline.stopLabel' + reason.charAt(0).toUpperCase() + reason.slice(1), { defaultValue: label });
  return (
    <span style={{
      marginLeft: 5, fontSize: 9, fontWeight: 700, letterSpacing: '.04em',
      color: fg, background: bg, padding: '1px 5px', borderRadius: 3,
      fontFamily: 'var(--font-m)', lineHeight: 1.5,
    }}>
      {displayLabel}
    </span>
  );
}

/* ── helpers ── */

function fmtDurationSub(ms: number): string | undefined {
  if (ms < 60_000) return undefined;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
/** Natural-language summary for a tool call, or null if tool is unknown / input missing */
function toolSummary(toolName: string, rawInput: string | null, t: (k: string) => string): string | null {
  if (!rawInput) return null;
  let a: Record<string, unknown> = {};
  try { a = JSON.parse(rawInput); } catch { return null; }
  const s = (v: unknown, max = 72): string => {
    if (v == null) return '';
    const str = String(v).replace(/\s+/g, ' ').trim();
    return str.length > max ? str.slice(0, max) + '…' : str;
  };
  switch (toolName) {
    case 'exec':    return a.command   ? `${t('sessionTimeline.toolSummaryRun')}: ${s(a.command, 80)}`      : null;
    case 'read':    return a.path      ? `${t('sessionTimeline.toolSummaryRead')}: ${s(a.path)}`            : null;
    case 'write':   return a.file_path ? `${t('sessionTimeline.toolSummaryWrite')}: ${s(a.file_path)}`      : null;
    case 'edit':    return a.path      ? `${t('sessionTimeline.toolSummaryEdit')}: ${s(a.path)}`            : null;
    case 'web_search': return a.query  ? `${t('sessionTimeline.toolSummarySearch')}: "${s(a.query, 70)}"` : null;
    case 'web_fetch':  return a.url    ? `${t('sessionTimeline.toolSummaryFetch')}: ${s(a.url, 80)}`        : null;
    default: return null;
  }
}

/** Parse raw error_message: JSON envelope or plain string → human-readable label */
function parseErrorMsg(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    // Anthropic envelope: { "error": { "type": "overloaded_error", "message": "Overloaded" } }
    if (parsed?.error?.message) return parsed.error.message;
    if (parsed?.message) return parsed.message;
  } catch { /* not JSON */ }
  return raw;
}

function pct(ms: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.max(0, (ms / total) * 100).toFixed(4)}%`;
}
function wPct(ms: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.max(0.08, (ms / total) * 100).toFixed(4)}%`;
}

/* ── sub-components ── */
function TimeAxis({ duration, labelW }: { duration: number; labelW: number }) {
  const TICKS = 8;
  const ticks = Array.from({ length: TICKS + 1 }, (_, i) => Math.round((i / TICKS) * duration));
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', height: 22, marginBottom: 4 }}>
      <div style={{ width: labelW, flexShrink: 0 }} />
      <div style={{ flex: 1, position: 'relative' }}>
        {ticks.map(t => (
          <span
            key={t}
            style={{
              position: 'absolute',
              left: pct(t, duration),
              transform: 'translateX(-50%)',
              fontSize: 10,
              color: 'var(--muted)',
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            }}
          >
            {fmtMs(t)}
          </span>
        ))}
        {/* baseline rule */}
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          height: 1, background: 'var(--border)',
        }} />
        {ticks.map(t => (
          <div key={`tick-${t}`} style={{
            position: 'absolute',
            left: pct(t, duration),
            bottom: 0,
            width: 1,
            height: 5,
            background: 'var(--border)',
          }} />
        ))}
      </div>
    </div>
  );
}

interface MessageContent {
  content: Array<{ type: string; text?: string; name?: string; id?: string; input?: unknown }> | null;
}

interface TurnRowProps {
  turn: TurnSlice;
  duration: number;
  sessionId: string;
  sessionStart: number;
  isExpanded: boolean;
  isHighlighted: boolean;
  hideUserPrompt?: boolean;
  onToggle: () => void;
}

function TurnRow({ turn, duration, sessionId, sessionStart, isExpanded, isHighlighted, hideUserPrompt, onToggle }: TurnRowProps) {
  const { t } = useTranslation();
  const rowRef = useRef<HTMLDivElement>(null);


  // Fetch message content when expanded (skip user content if hideUserPrompt — already shown in UserRunHeader)
  const { data: userContent } = useFetch<MessageContent>(
    isExpanded && turn.user_message_id && !hideUserPrompt
      ? `/api/sessions/${sessionId}/messages/${turn.user_message_id}/content`
      : '',
    [isExpanded, turn.user_message_id, hideUserPrompt],
  );
  const { data: assistantContent } = useFetch<MessageContent>(
    isExpanded && turn.message_id
      ? `/api/sessions/${sessionId}/messages/${turn.message_id}/content`
      : '',
    [isExpanded, turn.message_id],
  );
  const maxLanes = turn.tool_calls.length > 0 ? Math.max(...turn.tool_calls.map(tc => tc.total_lanes), 1) : 1;
  const LANE_H = 16;
  const BAR_H = LANE_H;
  const ROW_H = Math.max(40, 20 + maxLanes * (LANE_H + 2));
  const LABEL_W = 120;

  return (
    <div ref={rowRef} style={{ marginBottom: 2 }}>
      {/* ── Clickable row ── */}
      <div
        onClick={onToggle}
        title={t('sessionTimeline.clickToExpandCollapse')}
        style={{
          display: 'flex',
          alignItems: 'center',
          height: ROW_H,
          cursor: 'pointer',
          outline: isHighlighted ? '2px solid var(--C-blue)' : 'none',
          outlineOffset: -1,
          borderRadius: isExpanded ? '4px 4px 0 0' : 4,
          background: isExpanded ? 'rgba(30,58,138,0.10)' : 'transparent',
          transition: 'background .1s',
          userSelect: 'none',
        }}
        onMouseEnter={e => {
          if (!isExpanded) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.03)';
        }}
        onMouseLeave={e => {
          if (!isExpanded) (e.currentTarget as HTMLElement).style.background = 'transparent';
        }}
      >
        {/* label */}
        <div style={{
          width: LABEL_W, flexShrink: 0,
          paddingLeft: 4, paddingRight: 8,
          display: 'flex', flexDirection: 'column', gap: 1,
        }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
            S{turn.seq}
            <StopPill reason={turn.stop_reason} />
          </span>
          <span style={{ fontSize: 9, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
            {fmtTokens(turn.input_tokens + turn.output_tokens)} {t('sessionTimeline.tok')} · {fmtCost(turn.cost)}
          </span>
        </div>

        {/* bar area */}
        <div style={{ flex: 1, position: 'relative', height: ROW_H, display: 'flex', alignItems: 'center' }}>
          {/* turn background span */}
          <div style={{
            position: 'absolute',
            left: pct(turn.start_ms, duration),
            width: wPct(turn.end_ms - turn.start_ms, duration),
            height: BAR_H,
            background: 'var(--surface2)',
            borderRadius: 3,
          }} />

          {/* LLM segment */}
          {turn.llm_ms > 0 && (
            <div
              title={`LLM: ${fmtMs(turn.llm_ms)} · ${fmtTokens(turn.input_tokens)} in`}
              style={{
                position: 'absolute',
                left: pct(turn.start_ms, duration),
                width: wPct(turn.llm_ms, duration),
                height: BAR_H,
                top: maxLanes > 1 ? 0 : undefined,
                background: turn.tool_calls.length > 0 ? LLM_COLOR : LLM_COLOR_L,
                borderRadius: 3,
                zIndex: 1,
              }}
            />
          )}

          {/* tool segments — stacked vertically by lane for parallel execution */}
          {turn.tool_calls.map(tc => (
            <div
              key={tc.id}
              title={`${tc.tool_name}: ${fmtMs(tc.duration_ms)} · ${tc.success ? '✓' : '✗'}`}
              style={{
                position: 'absolute',
                left: pct(tc.start_ms, duration),
                width: wPct(Math.max(tc.duration_ms, 50), duration),
                height: LANE_H,
                top: maxLanes > 1 ? tc.lane * (LANE_H + 2) : undefined,
                background: !tc.success ? '#ef4444' : toolColor(tc.tool_name),
                borderRadius: 3,
                zIndex: 2,
                boxShadow: !tc.success ? '0 0 0 1px #ef4444' : 'none',
              }}
            />
          ))}

          {/* duration label */}
          <span style={{
            position: 'absolute',
            left: `calc(${pct(turn.end_ms, duration)} + 4px)`,
            fontSize: 9,
            color: 'var(--muted)',
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          }}>
            {fmtMs(turn.end_ms - turn.start_ms)}
          </span>
        </div>
      </div>

      {/* ── Inline expansion ── */}
      {isExpanded && (
        <div style={{
          background: 'rgba(30,58,138,0.15)',
          border: '1px solid rgba(59,130,246,0.25)',
          borderTop: 'none',
          borderRadius: '0 0 4px 4px',
          padding: '10px 12px 12px 12px',
          marginBottom: 4,
        }}>
          {/* LLM summary row */}
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: turn.tool_calls.length > 0 ? 10 : 0 }}>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>
              {t('sessionTimeline.start')}: <strong style={{ color: 'var(--text)', fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-m)' }}>+{fmtMs(turn.wall_start_ms)}</strong>
              <span style={{ color: 'var(--muted)', marginLeft: 4, fontSize: 10 }}>({fmtActiveTime(sessionStart + turn.wall_start_ms)})</span>
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{ width: 7, height: 7, borderRadius: 2, background: LLM_COLOR, flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>{t('sessionTimeline.llmTime')}</span>
              <span style={{ fontSize: 11, color: 'var(--text)', fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-m)' }}>{fmtMs(turn.llm_ms)}</span>
            </div>
            {turn.tool_calls.length > 0 && (
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                {t('sessionTimeline.tools')}: <strong style={{ color: 'var(--text)', fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-m)' }}>
                  {turn.tool_calls.length}x ({fmtMs(turn.tool_time_ms)})
                </strong>
                {turn.tool_calls.length > 1 && turn.tool_calls[0]?.total_lanes > 1 && (
                  <span style={{ fontSize: 9, color: 'var(--C-blue)', marginLeft: 4 }}>{t('sessionTimeline.parallel')}</span>
                )}
              </span>
            )}
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>
              {t('sessionTimeline.total')}: <strong style={{ color: 'var(--text)', fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-m)' }}>{fmtMs(turn.end_ms - turn.start_ms)}</strong>
            </span>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>
              {t('sessionTimeline.tokenIn')}: <strong style={{ color: 'var(--text)' }}>{fmtTokens(turn.input_tokens)}</strong>
            </span>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>
              {t('sessionTimeline.tokenOut')}: <strong style={{ color: 'var(--text)' }}>{fmtTokens(turn.output_tokens)}</strong>
            </span>
            {turn.cache_read > 0 && (
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                {t('sessionTimeline.cacheRead')}: <strong style={{ color: 'var(--C-blue)' }}>{fmtTokens(turn.cache_read)}</strong>
              </span>
            )}
            {turn.cache_write > 0 && (
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                {t('sessionTimeline.cacheWrite')}: <strong style={{ color: 'var(--C-amber)' }}>{fmtTokens(turn.cache_write)}</strong>
              </span>
            )}
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>
              {t('sessionTimeline.cost')}: <strong style={{ color: 'var(--text)' }}>{fmtCost(turn.cost)}</strong>
            </span>
            {turn.stop_reason && (
              <span style={{ fontSize: 11, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                {t('sessionTimeline.stopReason')} <StopPill reason={turn.stop_reason} />
              </span>
            )}
            {turn.stop_reason === 'error' && parseErrorMsg(turn.error_message) && (
              <span style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{
                  background: 'rgba(239,68,68,0.12)',
                  border: '1px solid rgba(239,68,68,0.3)',
                  borderRadius: 4,
                  padding: '1px 7px',
                  color: '#ef4444',
                  fontFamily: 'var(--font-m)',
                  letterSpacing: '0.01em',
                }}>
                  {parseErrorMsg(turn.error_message)}
                </span>
              </span>
            )}
          </div>

          {/* Tool calls */}
          {/* Message context */}
          <div style={{ marginBottom: turn.tool_calls.length > 0 ? 10 : 0 }}>
            {/* User prompt */}
            {userContent?.content && (() => {
              const textItems = (userContent.content ?? []).filter(c => c.type === 'text' && c.text);
              if (textItems.length === 0) return null;
              const text = textItems.map(c => c.text).join('\n');
              return (
                <div style={{ marginBottom: 8 }}>
                  <div style={{
                    fontSize: 9, fontWeight: 600, color: '#93c5fd',
                    textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 3,
                  }}>{t('sessionTimeline.userPrompt')}</div>
                  <div style={{
                    fontSize: 12, color: 'var(--text)', lineHeight: 1.5,
                    background: 'rgba(0,0,0,0.18)', borderRadius: 4, padding: '8px 10px',
                    borderLeft: '3px solid rgba(147,197,253,0.4)',
                    maxHeight: 180, overflowY: 'auto',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  }}>
                    {text}
                  </div>
                </div>
              );
            })()}

            {/* Assistant response */}
            {assistantContent?.content && (() => {
              const items = assistantContent.content ?? [];
              const textItems = items.filter(c => c.type === 'text' && c.text);
              if (textItems.length === 0) return null;
              const text = textItems.map(c => c.text).join('\n');
              return (
                <div style={{ marginTop: 12, marginBottom: 8 }}>
                  <div style={{
                    fontSize: 9, fontWeight: 600, color: '#86efac',
                    textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 5,
                  }}>{t('sessionTimeline.assistantResponse')}</div>
                  <div style={{
                    fontSize: 12, color: 'var(--text)', lineHeight: 1.5,
                    background: 'rgba(0,0,0,0.18)', borderRadius: 4, padding: '8px 10px',
                    borderLeft: '3px solid rgba(134,239,172,0.4)',
                    maxHeight: 180, overflowY: 'auto',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  }}>
                    {text}
                  </div>
                </div>
              );
            })()}

            {/* No content available */}
            {isExpanded && !userContent?.content && !assistantContent?.content && turn.user_message_id && (
              <div style={{ fontSize: 11, color: 'var(--muted)', fontStyle: 'italic', marginBottom: 8 }}>
                {t('sessionTimeline.contentNotAvailable')}
              </div>
            )}
          </div>

          {turn.tool_calls.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {turn.tool_calls.map((tc, idx) => (
                <div key={tc.id} style={{
                  background: 'rgba(0,0,0,0.22)',
                  border: `1px solid ${tc.success ? 'rgba(255,255,255,0.07)' : 'rgba(239,68,68,0.35)'}`,
                  borderLeft: `3px solid ${tc.success ? toolColor(tc.tool_name) : '#ef4444'}`,
                  borderRadius: 4,
                  padding: '8px 10px',
                }}>
                  {/* Tool header */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 0, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--font-m)', letterSpacing: '.01em' }}>
                      {tc.tool_name}
                    </span>
                    {tc.target && (
                      <span style={{ fontSize: 10, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
                        {tc.target}
                      </span>
                    )}
                    <span style={{ fontSize: 10, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{fmtMs(tc.duration_ms)}</span>
                    <span style={{ fontSize: 10, color: tc.success ? '#4ade80' : '#f87171', fontWeight: 600 }}>
                      {tc.success ? t('sessionTimeline.ok') : t('sessionTimeline.err')}
                    </span>
                    <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)', marginLeft: 'auto' }}>#{idx + 1}</span>
                  </div>
                  {/* Natural-language summary — only for known tools */}
                  {toolSummary(tc.tool_name, tc.raw_input, t) && (
                    <div style={{
                      fontSize: 11, color: 'var(--muted)', marginTop: 4,
                      marginBottom: (tc.raw_input || tc.raw_output) ? 8 : 0,
                      fontStyle: 'italic', lineHeight: 1.4,
                      wordBreak: 'break-all',
                    }}>
                      {toolSummary(tc.tool_name, tc.raw_input, t)}
                    </div>
                  )}
                  {/* spacer when no summary but has input/output/arguments */}
                  {!toolSummary(tc.tool_name, tc.raw_input, t) && (tc.arguments || tc.raw_input || tc.raw_output) && (
                    <div style={{ marginBottom: 8 }} />
                  )}

                  {/* Arguments */}
                  {tc.arguments && (
                    <div style={{ marginBottom: tc.raw_input || tc.raw_output ? 6 : 0 }}>
                      <div style={{
                        fontSize: 9, fontWeight: 600, color: '#c4b5fd',
                        textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 4,
                      }}>{t('sessionTimeline.arguments')}</div>
                      <JsonView raw={tc.arguments} maxHeight={160} />
                    </div>
                  )}

                  {/* Input / Output */}
                  {(tc.raw_input || tc.raw_output) && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {tc.raw_input && (
                        <div>
                          <div style={{
                            fontSize: 9, fontWeight: 600, color: '#93c5fd',
                            textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 4,
                          }}>{t('sessionTimeline.input')}</div>
                          <JsonView raw={tc.raw_input} maxHeight={160} />
                        </div>
                      )}
                      {tc.raw_output && (
                        <div>
                          <div style={{
                            fontSize: 9, fontWeight: 600, color: '#86efac',
                            textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 4,
                          }}>{t('sessionTimeline.output')}</div>
                          <JsonView raw={tc.raw_output} maxHeight={200} />
                        </div>
                      )}
                    </div>
                  )}

                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── JsonView: pretty-print JSON with syntax highlighting ── */
function JsonView({ raw, maxHeight = 180 }: { raw: string; maxHeight?: number }) {
  let display = raw.trim();
  let isJson = false;
  try {
    const parsed = JSON.parse(display);
    display = JSON.stringify(parsed, null, 2);
    isJson = true;
  } catch { /* plain text — keep as-is */ }

  // Escape HTML entities so raw content can't inject markup
  const escaped = display
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const highlighted = isJson
    ? escaped.replace(
        /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
        (match) => {
          if (match === 'true' || match === 'false')
            return `<span style="color:#f472b6">${match}</span>`;
          if (match === 'null')
            return `<span style="color:#94a3b8">${match}</span>`;
          if (/^-?\d/.test(match))
            return `<span style="color:#fb923c">${match}</span>`;
          // string: key vs value
          if (/:$/.test(match))
            return `<span style="color:#93c5fd">${match}</span>`;  // key → blue
          return `<span style="color:#86efac">${match}</span>`;    // value → green
        }
      )
    : escaped;

  return (
    <pre
      style={{
        fontFamily: 'var(--font-m)',
        fontSize: 10.5,
        lineHeight: 1.65,
        color: '#d1d5db',
        background: 'rgba(0,0,0,0.38)',
        border: '1px solid rgba(255,255,255,0.07)',
        borderRadius: 4,
        padding: '7px 10px',
        margin: 0,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight,
        overflowY: 'auto',
      }}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: highlighted }}
    />
  );
}

/* ── helpers ── */
function fmtActiveTime(ts: number): string {
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

/* ── SessionPicker ── */
function SessionPicker({
  sessions,
  value,
  onChange,
}: {
  sessions: SessionRow[];
  value: string;
  onChange: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery]   = useState('');
  const [open, setOpen]     = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef  = useRef<HTMLDivElement>(null);

  const selected = sessions.find(s => s.id === value) ?? null;

  // Close on outside click
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

  // Filter: match id substring or agent name
  const q = query.trim().toLowerCase();
  const filtered = q
    ? sessions.filter(s => s.id.includes(q) || s.agent_name.toLowerCase().includes(q))
    : sessions;

  function updateSearchQuery(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    setQuery(v);
    setOpen(true);
    // Auto-select when a full UUID is pasted
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

      {/* ── Trigger / input row ── */}
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

        {/* selected chip (when closed and something is selected) */}
        {selected && !open ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <span style={{ fontFamily: 'var(--font-m)', fontSize: 11, color: 'var(--text)', flexShrink: 0 }}>
              {selected.id}
            </span>
            <span style={{ fontSize: 11, color: 'var(--C-blue)', flexShrink: 0 }}>{selected.agent_name}</span>
            {selected.primary_model && <span style={{ fontSize: 11, color: 'var(--C-purple, #a78bfa)', flexShrink: 0 }}>{selected.primary_model}</span>}
            <span style={{ fontSize: 11, color: 'var(--C-green)', flexShrink: 0 }}>{fmtCost(selected.total_cost)}</span>
            <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>{fmtActiveTime(selected.ended_at)}</span>
          </div>
        ) : (
          <input
            ref={inputRef}
            value={query}
            onChange={updateSearchQuery}
            onFocus={() => setOpen(true)}
            placeholder={selected ? selected.id : t('sessionTimeline.searchPlaceholder')}
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

      {/* ── Dropdown panel ── */}
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
            <div style={{ padding: '14px 14px', color: 'var(--muted)', fontSize: 12 }}>{t('sessionTimeline.noSessionsMatch')}</div>
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
                  {/* row 1: full ID */}
                  <div style={{ fontFamily: 'var(--font-m)', fontSize: 11, color: 'var(--text)', marginBottom: 3, letterSpacing: '.01em' }}>
                    {s.id}
                    {isActive && (
                      <span style={{ marginLeft: 6, fontSize: 9, color: 'var(--C-blue)', background: 'rgba(59,130,246,.15)', padding: '1px 5px', borderRadius: 3 }}>{t('sessionTimeline.selected')}</span>
                    )}
                  </div>
                  {/* row 2: meta */}
                  <div style={{ display: 'flex', gap: 14, fontSize: 11 }}>
                    <span style={{ color: 'var(--C-blue)', fontWeight: 500 }}>{s.agent_name}</span>
                    {s.primary_model && <span style={{ color: 'var(--C-purple, #a78bfa)' }}>{s.primary_model}</span>}
                    <span style={{ color: 'var(--C-green)' }}>{fmtCost(s.total_cost)}</span>
                    <span style={{ color: 'var(--muted)' }}>{fmtActiveTime(s.ended_at)}</span>
                    <span style={{ color: 'var(--muted)' }}>{s.total_messages} {t('sessionTimeline.msg')}</span>
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

/* ── UserRunHeader: clickable header showing user message ── */
function UserRunHeader({
  sessionId,
  userMessageId,
  stepCount,
  color,
}: {
  sessionId: string;
  userMessageId: string | null;
  stepCount: number;
  color: string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { data: content } = useFetch<MessageContent>(
    expanded && userMessageId
      ? `/api/sessions/${sessionId}/messages/${userMessageId}/content`
      : '',
    [expanded, userMessageId],
  );

  const textItems = (content?.content ?? []).filter(c => c.type === 'text' && c.text);
  const text = textItems.map(c => c.text).join('\n');

  return (
    <div>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          fontSize: 12, color: 'var(--muted)', padding: '5px 8px',
          display: 'flex', alignItems: 'center', gap: 6,
          cursor: 'pointer', borderRadius: 3,
          transition: 'background .1s',
        }}
        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      >
        <span style={{
          width: 7, height: 7, borderRadius: '50%',
          background: color, flexShrink: 0,
        }} />
        <span style={{ fontWeight: 600, color: 'var(--text)' }}>
          {t('sessionTimeline.userTurn')}
        </span>
        <span>— {stepCount} {stepCount > 1 ? t('sessionTimeline.steps') : t('sessionTimeline.step')}</span>
      </div>

      {expanded && (
        <div style={{
          margin: '2px 8px 6px 22px',
          padding: '8px 10px',
          background: 'rgba(0,0,0,0.18)',
          borderRadius: 4,
          borderLeft: `3px solid ${color}`,
        }}>
          <div style={{
            fontSize: 9, fontWeight: 600, color: color.replace('0.25', '0.8'),
            textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 4,
          }}>{t('sessionTimeline.userMessage')}</div>
          {text ? (
            <div style={{
              fontSize: 12, color: 'var(--text)', lineHeight: 1.5,
              maxHeight: 200, overflowY: 'auto',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {text}
            </div>
          ) : content ? (
            <div style={{ fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>
              {t('sessionTimeline.noTextContent')}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>
              {t('common.loading')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Legend({ toolNames }: { toolNames: string[] }) {
  const { t } = useTranslation();
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
      {/* LLM */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <div style={{ width: 10, height: 10, borderRadius: 2, background: LLM_COLOR, flexShrink: 0 }} />
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>{t('sessionTimeline.legendLLM')}</span>
      </div>
      {toolNames.map(name => (
        <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{ width: 10, height: 10, borderRadius: 2, background: toolColor(name), flexShrink: 0 }} />
          <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--font-m)' }}>{name}</span>
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <div style={{ width: 10, height: 10, borderRadius: 2, background: '#ef4444', flexShrink: 0 }} />
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>{t('sessionTimeline.legendError')}</span>
      </div>
    </div>
  );
}

/* ── main page ── */
export default function SessionTimeline() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: sessionsData } = useFetch<SessionRow[]>('/api/sessions?limit=50');
  const [selectedSession, setSelectedSession] = useState(() => searchParams.get('session') ?? '');
  const [expandedTurn, setExpandedTurn] = useState<number | null>(null);
  const [highlightedTurn, setHighlightedTurn] = useState<number | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const groupRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Read turn param from URL and auto-expand/highlight
  const turnParam = searchParams.get('turn');
  useEffect(() => {
    if (turnParam) {
      const turnNum = parseInt(turnParam, 10);
      if (!isNaN(turnNum)) {
        setExpandedTurn(turnNum);
        setHighlightedTurn(turnNum);
        const HIGHLIGHT_FADE_MS = 5_000;
        const timer = setTimeout(() => setHighlightedTurn(null), HIGHLIGHT_FADE_MS);
        return () => clearTimeout(timer);
      }
    }
  }, [turnParam, selectedSession]);

  // Keep URL in sync when session changes
  useEffect(() => {
    if (selectedSession) setSearchParams({ session: selectedSession }, { replace: true });
    else setSearchParams({}, { replace: true });
  }, [selectedSession]);

  const url = selectedSession ? `/api/debug/session/${selectedSession}/timeline` : '';
  const { data: timeline, loading } = useFetch<TimelineData>(url, [selectedSession]);

  // Scroll to the User Turn group container when navigating from Deep Turns
  useEffect(() => {
    if (highlightedTurn === null || !timeline?.turns) return;
    // Rebuild groups to find which group contains the highlighted turn
    let cSeqs: number[] = [];
    let gIdx = 0;
    const groupOfTurn = new Map<number, number>(); // seq -> userTurnIdx
    for (const turn of timeline.turns) {
      if (turn.user_message_id && cSeqs.length > 0) {
        cSeqs.forEach(s => groupOfTurn.set(s, gIdx));
        cSeqs = [];
        gIdx++;
      }
      cSeqs.push(turn.seq);
    }
    cSeqs.forEach(s => groupOfTurn.set(s, gIdx));

    const targetGroup = groupOfTurn.get(highlightedTurn);
    if (targetGroup !== undefined) {
      const el = groupRefs.current.get(targetGroup);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [highlightedTurn, timeline]);

  const sessions = sessionsData ?? [];

  // Total LLM ms (sum of all llm_ms)
  const totalLlmMs = timeline?.turns.reduce((s, t) => s + t.llm_ms, 0) ?? 0;
  // Total tool ms: parallel-aware (wall-clock span per turn, not sum of individual durations)
  const totalToolMs = timeline?.turns.reduce((s, t) => s + t.tool_time_ms, 0) ?? 0;

  return (
    <div>
      <PageHeader title={t('sessionTimeline.pageTitle')} subtitle={t('sessionTimeline.pageSubtitle')} />

      {/* ── outer wrapper: NO overflow:hidden so dropdown can escape ── */}
      <div style={{ margin: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>

        {/* Session picker — its own stacking layer */}
        <div style={{ position: 'relative', zIndex: 20 }}>
          <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.08em' }}>
            {t('sessionTimeline.sessionLabel')}
          </label>
          <SessionPicker
            sessions={sessions}
            value={selectedSession}
            onChange={id => { setSelectedSession(id); setExpandedTurn(null); }}
          />
        </div>

        {loading && selectedSession && <Loading />}

        {timeline?.available && (
          <>
            {/* Compressed-timeline notice */}
            {timeline.idle_gaps_compressed > 0 && (
              <div style={{
                fontSize: 12, color: 'var(--muted)', marginBottom: 'var(--space-3)',
                padding: '6px 10px', background: 'rgba(255,255,255,0.03)',
                borderRadius: 'var(--radius-sm)', border: '1px solid rgba(255,255,255,0.07)',
                display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              }}>
                ⚡ {t('sessionTimeline.collapsed')} <strong style={{ color: 'var(--text)' }}>{timeline.idle_gaps_compressed}</strong> {t('sessionTimeline.idleGaps')}
                <InfoTooltip width={360} label={t('sessionTimeline.idleGapsTooltipLabel')} placement="bottom">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, lineHeight: 1.7, fontSize: 12 }}>
                    <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: 13 }}>{t('sessionTimeline.idleGapsTitle')}</div>
                    <div>
                      {t('sessionTimeline.idleGapsDesc')}
                    </div>
                    <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 10 }}>
                      <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>{t('sessionTimeline.howItWorksTitle')}</div>
                      <div>
                        {t('sessionTimeline.howItWorksDesc')}
                      </div>
                    </div>
                    <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 10 }}>
                      <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>{t('sessionTimeline.notCompressedTitle')}</div>
                      <div>
                        {t('sessionTimeline.notCompressedDesc')}
                      </div>
                    </div>
                  </div>
                </InfoTooltip>
              </div>
            )}

            {/* KPIs */}
            <KpiStrip cols={6} style={{ marginBottom: 'var(--space-5)' }}>
              <Kpi
                value={fmtMs(timeline.wall_duration_ms)}
                sub={fmtDurationSub(timeline.wall_duration_ms) && (
                  <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--muted)', letterSpacing: '0em' }}>
                    {fmtDurationSub(timeline.wall_duration_ms)}
                  </span>
                )}
                label={t('sessionTimeline.wallDuration')}
                tooltip={t('sessionTimeline.wallDurationTooltip')}
                color="#ffffff"
                valueFontSize={22}
              />
              <Kpi
                value={fmtMs(timeline.duration_ms)}
                sub={fmtDurationSub(timeline.duration_ms) && (
                  <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--muted)', letterSpacing: '0em' }}>
                    {fmtDurationSub(timeline.duration_ms)}
                  </span>
                )}
                label={t('sessionTimeline.activeTime')}
                tooltip={t('sessionTimeline.activeTimeTooltip')}
                color="#ffffff"
                valueFontSize={22}
              />
              <Kpi
                value={timeline.turn_count}
                label={t('sessionTimeline.llmApiCalls')}
                tooltip={t('sessionTimeline.llmApiCallsTooltip')}
              />
              <Kpi
                value={timeline.tool_count}
                label={t('sessionTimeline.toolCalls')}
                tooltip={t('sessionTimeline.toolCallsTooltip')}
              />
              <Kpi
                value={fmtMs(totalLlmMs)}
                sub={fmtDurationSub(totalLlmMs)}
                label={t('sessionTimeline.llmTimeLabel')}
                color="var(--C-blue)"
                tooltip={t('sessionTimeline.llmTimeTooltip')}
              />
              <Kpi
                value={fmtMs(totalToolMs)}
                sub={fmtDurationSub(totalToolMs)}
                label={t('sessionTimeline.toolTime')}
                color="var(--C-amber)"
                tooltip={t('sessionTimeline.toolTimeTooltip')}
              />
            </KpiStrip>

            {/* Section heading — no line, white, larger */}
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)', marginBottom: 'var(--space-3)', marginTop: 'var(--space-2)' }}>
              {t('sessionTimeline.executionGantt')}
            </div>

            {/* Legend then stop reason — stacked left */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6, marginBottom: 'var(--space-3)' }}>
              <Legend toolNames={timeline.tool_names} />
              <InfoTooltip width={340} label={t('sessionTimeline.stopReasonTooltipLabel')} placement="bottom">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>
                    {t('sessionTimeline.stopReasonTooltipTitle')}
                  </div>
                  {([
                    ['stop',    t('sessionTimeline.stopReasonStop')],
                    ['toolUse', t('sessionTimeline.stopReasonToolUse')],
                    ['length',  t('sessionTimeline.stopReasonLength')],
                    ['error',   t('sessionTimeline.stopReasonError')],
                    ['aborted', t('sessionTimeline.stopReasonAborted')],
                  ] as [string, string][]).map(([label, desc]) => (
                    <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontFamily: 'var(--font-m)', fontSize: 11, color: 'var(--C-blue)', fontWeight: 700 }}>{label}</span>
                      <span style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{desc}</span>
                    </div>
                  ))}
                </div>
              </InfoTooltip>
            </div>

            {/* Gantt chart */}
            <div
              ref={chartRef}
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                padding: 'var(--space-4) var(--space-4) var(--space-3)',
                overflowX: 'auto',
                minWidth: 0,
              }}
            >
              {timeline.duration_ms === 0 ? (
                <div style={{ color: 'var(--muted)', fontSize: 13 }}>
                  {t('sessionTimeline.noTimingData')}
                </div>
              ) : (
                <div style={{ minWidth: 600 }}>
                  <TimeAxis duration={timeline.duration_ms} labelW={120} />
                  {(() => {
                    // Group turns by user turn (a user turn = one user message → N assistant steps)
                    const groups: Array<{ userTurnIdx: number; turns: typeof timeline.turns }> = [];
                    let currentGroup: typeof timeline.turns = [];
                    let userTurnIdx = 0;

                    for (const turn of timeline.turns) {
                      if (turn.user_message_id && currentGroup.length > 0) {
                        // New user turn — flush previous group
                        groups.push({ userTurnIdx, turns: currentGroup });
                        currentGroup = [];
                        userTurnIdx++;
                      } else if (turn.user_message_id && currentGroup.length === 0) {
                        // First turn with user message — start group
                      }
                      currentGroup.push(turn);
                    }
                    if (currentGroup.length > 0) {
                      groups.push({ userTurnIdx, turns: currentGroup });
                    }

                    const USER_TURN_COLORS = ['rgba(59,130,246,0.25)', 'rgba(139,92,246,0.25)', 'rgba(16,185,129,0.25)', 'rgba(245,158,11,0.25)', 'rgba(236,72,153,0.25)'];

                    return groups.map((group) => {
                      const color = USER_TURN_COLORS[group.userTurnIdx % USER_TURN_COLORS.length];
                      const firstTurn = group.turns[0];

                      return (
                        <div
                          key={group.userTurnIdx}
                          ref={el => { if (el) groupRefs.current.set(group.userTurnIdx, el); }}
                          style={{
                            borderLeft: `3px solid ${color}`,
                            marginBottom: 8,
                          }}
                        >
                          <UserRunHeader
                            sessionId={selectedSession}
                            userMessageId={firstTurn.user_message_id}
                            stepCount={group.turns.length}
                            color={color}
                          />
                          <div style={{ paddingLeft: 8 }}>
                            {group.turns.map((turn, turnIdx) => (
                              <TurnRow
                                key={turn.seq}
                                turn={turn}
                                duration={timeline.duration_ms}
                                sessionId={selectedSession}
                                sessionStart={timeline.session_start}
                                isExpanded={expandedTurn === turn.seq}
                                isHighlighted={highlightedTurn === turn.seq}
                                hideUserPrompt={turnIdx === 0}
                                onToggle={() => setExpandedTurn(prev => prev === turn.seq ? null : turn.seq)}
                              />
                            ))}
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
            </div>


          </>
        )}

        {timeline && !timeline.available && selectedSession && (
          <div style={{ color: 'var(--muted)', fontSize: 13, padding: 'var(--space-2)' }}>
            {t('sessionTimeline.noDataForSession')}
          </div>
        )}

      </div>{/* end outer wrapper */}
    </div>
  );
}
