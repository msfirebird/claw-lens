import { useState, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useFetch, fmtCost, fmtTs, fmtTokens, fmtPct, fmt$$ } from '../hooks';
import type { SessionSummary, SessionsData } from '../hooks';
import { PageHeader, UnavailableBanner, Loading, Badge } from '../components/ui';
import { TokenBar } from '../components/TokenBar';
import { DiffView } from '../components/DiffView';
import { estimateSections } from '../utils/estimateSections';

/* ── Types ── */
interface DebugStatus { cacheTraceAvailable: boolean; }


interface ReplayStageLine {
  stage: string;
  seq: number;
  messageCount: number | null;
  note: string;
  digestChanged: boolean;
}

interface ReplayContextEntry {
  seq: number;
  messageCount: number;
  newMsgCount: number;
  newFingerprintCount: number;
  contextWindow: number;
}

interface ReplayModelConfig {
  name: string;
  provider: string;
  api: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: string;
  toolExecution: string;
  transport: string;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
}

interface ReplayRoleDistribution {
  user: number;
  assistant: number;
  toolResult: number;
  other: number;
}

interface ReplayLastMessage {
  role: string;
  textPreview: string;
  toolName?: string;
  hasUsage: boolean;
}

interface ReplayTurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  callCount: number;
}

interface ReplayRun {
  runId: string;
  ts: string;
  model: string;
  sessionKey: string;
  mcLoaded:   number | null;
  mcLimited:  number | null;
  mcAfter:    number | null;
  sanitizeDelta: number;
  limitDelta:    number;
  loops:         number;
  contextGrowth: number;
  stages:   ReplayStageLine[];
  contexts: ReplayContextEntry[];
  systemDigest: string;
  noteStr: string;
  systemPrompt: string;
  userPrompt: string;
  roleDistribution: ReplayRoleDistribution;
  modelConfig: ReplayModelConfig | null;
  lastMessages: ReplayLastMessage[];
  turnUsage: ReplayTurnUsage | null;
}

interface ReplayData { available: boolean; runs: ReplayRun[]; }

/* ── Helpers ── */

function fmtStageLabel(stage: string, t: (key: string) => string): string {
  const map: Record<string, string> = {
    'session:loaded':    t('debugReplay.loaded'),
    'session:sanitized': t('debugReplay.sanitized'),
    'session:limited':   t('debugReplay.limited'),
    'prompt:before':     t('debugReplay.promptLabel'),
    'prompt:images':     t('debugReplay.images'),
    'stream:context':    t('debugReplay.contextLabel'),
    'session:after':     t('debugReplay.after'),
  };
  return map[stage] ?? stage;
}

/** Per-stage one-liner explaining what this pipeline step does */
function stageExplain(stage: string, t: (key: string) => string): string {
  const map: Record<string, string> = {
    'session:loaded':    t('debugReplay.loadedDesc'),
    'session:sanitized': t('debugReplay.sanitizedDesc'),
    'session:limited':   t('debugReplay.limitedDesc'),
    'prompt:before':     t('debugReplay.promptDesc'),
    'prompt:images':     t('debugReplay.imagesDesc'),
    'stream:context':    t('debugReplay.contextDesc'),
    'session:after':     t('debugReplay.afterDesc'),
  };
  return map[stage] ?? '';
}

function fmtStageColor(stage: string): string {
  const map: Record<string, string> = {
    'session:loaded':    'var(--C-blue)',
    'session:sanitized': '#7C3AED',
    'session:limited':   '#D97706',
    'prompt:before':     '#0891B2',
    'prompt:images':     '#0891B2',
    'stream:context':    '#10B981',
    'session:after':     'var(--C-blue)',
  };
  return map[stage] ?? 'var(--muted)';
}

function DeltaBadge({ delta }: { delta: number }) {
  if (delta === 0) return null;
  const positive = delta > 0;
  return (
    <span style={{
      fontSize: 14,
      color: positive ? '#10B981' : '#EF4444',
      background: positive ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)',
      padding: '1px 4px',
      borderRadius: 3,
      fontVariantNumeric: 'tabular-nums',
      marginLeft: 3,
    }}>
      {positive ? '+' : ''}{delta}
    </span>
  );
}

/* ── SessionPicker ── */
function SessionPicker({ sessions, value, onChange }: {
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
        setOpen(false); setQuery('');
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? sessions.filter(s => s.id.includes(q) || s.model.toLowerCase().includes(q) || s.agent_name.toLowerCase().includes(q))
    : sessions;

  function pick(id: string) { onChange(id); setQuery(''); setOpen(false); }
  function clear(e: React.MouseEvent) { e.stopPropagation(); onChange(''); setQuery(''); }

  return (
    <div ref={rootRef} style={{ position: 'relative', maxWidth: 680 }}>
      <div
        onClick={() => { setOpen(o => !o); setTimeout(() => inputRef.current?.focus(), 10); }}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          border: open ? '1px solid var(--C-blue)' : '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)', background: 'var(--surface)',
          padding: '6px 10px', cursor: 'text', transition: 'border-color .12s', minHeight: 38,
        }}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, opacity: 0.4 }}>
          <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.5"/>
          <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>

        {selected && !open ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <span style={{ fontFamily: 'var(--font-m)', fontSize: 13, color: 'var(--text)', flexShrink: 0 }}>
              {selected.id}
            </span>
            {selected.agent_name && <span style={{ fontSize: 13, color: 'var(--C-blue)', flexShrink: 0 }}>{selected.agent_name}</span>}
            <span style={{ fontSize: 13, color: 'var(--C-purple, #a78bfa)', flexShrink: 0 }}>{selected.model}</span>
            {selected.total_cost > 0 && (
              <span style={{ fontSize: 13, color: 'var(--C-green)', flexShrink: 0 }}>{fmtCost(selected.total_cost)}</span>
            )}
            <span style={{ fontSize: 13, color: 'var(--muted)', flexShrink: 0 }}>{fmtTs(selected.max_ts, { seconds: true })}</span>
          </div>
        ) : (
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            placeholder={selected ? selected.id : t('debugReplay.searchPlaceholder')}
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none', fontSize: 14, color: 'var(--text)', fontFamily: 'var(--font-m)', minWidth: 0 }}
            onClick={e => e.stopPropagation()}
          />
        )}

        {selected && (
          <button onClick={clear} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 15, lineHeight: 1, padding: '0 2px', flexShrink: 0 }}>×</button>
        )}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ flexShrink: 0, opacity: 0.4, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}>
          <path d="M1 3l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>

      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: '0 12px 32px rgba(0,0,0,.35)', maxHeight: 340, overflowY: 'auto', zIndex: 200 }}>
          {filtered.length === 0 ? (
            <div style={{ padding: 14, color: 'var(--muted)', fontSize: 12 }}>{t('debugReplay.noSessionsMatch')}</div>
          ) : filtered.map((s, i) => {
            const isActive = s.id === value;
            return (
              <div key={s.id} onClick={() => pick(s.id)}
                style={{ padding: '9px 14px', borderBottom: i < filtered.length - 1 ? '1px solid var(--border)' : 'none', cursor: 'pointer', background: isActive ? 'var(--surface3)' : 'transparent', transition: 'background .08s' }}
                onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'var(--surface2)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = isActive ? 'var(--surface3)' : 'transparent'; }}
              >
                <div style={{ fontFamily: 'var(--font-m)', fontSize: 13, color: 'var(--text)', marginBottom: 3 }}>
                  {s.id}
                  {isActive && <span style={{ marginLeft: 6, fontSize: 13, color: 'var(--C-blue)', background: 'rgba(59,130,246,.15)', padding: '1px 5px', borderRadius: 3 }}>{t('debugReplay.selected')}</span>}
                </div>
                <div style={{ display: 'flex', gap: 14, fontSize: 11 }}>
                  {s.agent_name && <span style={{ color: 'var(--C-blue)', fontWeight: 500 }}>{s.agent_name}</span>}
                  <span style={{ color: 'var(--C-purple, #a78bfa)' }}>{s.model}</span>
                  {s.total_cost > 0 && <span style={{ color: 'var(--C-green)' }}>{fmtCost(s.total_cost)}</span>}
                  <span style={{ color: 'var(--muted)' }}>{fmtTs(s.max_ts, { seconds: true })}</span>
                  <span style={{ color: 'var(--muted)' }}>{s.entry_count} {t('debugReplay.turns')}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Pipeline Flow ── */
function PipelineFlow({ run }: { run: ReplayRun }) {
  const { t } = useTranslation();
  const SHOW_STAGES = ['session:loaded', 'session:sanitized', 'session:limited'];
  const shownStages = run.stages.filter(s => SHOW_STAGES.includes(s.stage));

  return (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0, marginTop: 'var(--space-3)' }}>
      {shownStages.map((s, i) => {
        const prevMc = i > 0 ? (shownStages[i - 1].messageCount ?? 0) : null;
        const delta = prevMc !== null && s.messageCount !== null ? s.messageCount - prevMc : 0;
        return (
          <div key={s.seq} style={{ display: 'flex', alignItems: 'center' }}>
            {i > 0 && <span style={{ color: 'var(--muted)', fontSize: 13, margin: '0 4px' }}>→</span>}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
              <span style={{ fontSize: 13, color: fmtStageColor(s.stage), textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 }}>
                {fmtStageLabel(s.stage, t)}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <span style={{ fontFamily: 'var(--font-m)', fontSize: 12, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
                  {s.messageCount ?? '?'}
                </span>
                {delta !== 0 && <DeltaBadge delta={delta} />}
              </div>
            </div>
          </div>
        );
      })}

      {run.contexts.map((ctx, i) => (
        <div key={ctx.seq} style={{ display: 'flex', alignItems: 'center' }}>
          <span style={{ color: 'var(--muted)', fontSize: 13, margin: '0 4px' }}>→</span>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
            <span style={{ fontSize: 13, color: '#10B981', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 }}>
              {t('debugReplay.stepN', { n: i + 1 })}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <span style={{ fontFamily: 'var(--font-m)', fontSize: 12, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
                {ctx.messageCount}
              </span>
              {ctx.newMsgCount !== 0 && <DeltaBadge delta={ctx.newMsgCount} />}
            </div>
          </div>
        </div>
      ))}

      {run.mcAfter != null && (
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span style={{ color: 'var(--muted)', fontSize: 13, margin: '0 4px' }}>→</span>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
            <span style={{ fontSize: 13, color: 'var(--C-blue)', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 }}>{t('debugReplay.after')}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <span style={{ fontFamily: 'var(--font-m)', fontSize: 12, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
                {run.mcAfter}
              </span>
              {run.contextGrowth !== 0 && <DeltaBadge delta={run.contextGrowth} />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Copy Button ── */
function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <button
      onClick={handleCopy}
      style={{
        background: copied ? 'rgba(16,185,129,0.15)' : 'var(--surface3)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        color: copied ? '#10B981' : 'var(--text)',
        fontSize: 12, fontWeight: 500,
        padding: '4px 12px',
        cursor: 'pointer',
        transition: 'all .15s',
        flexShrink: 0,
      }}
    >
      {copied ? t('debugReplay.copied') : t('debugReplay.copyAll')}
    </button>
  );
}

/* ── Collapsible Detail Section ── */
function DetailSection({ title, subtitle, defaultOpen = true, copyText, children }: {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  copyText?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginBottom: 'var(--space-5)', maxWidth: 860 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: open ? 0 : 0 }}>
        <button
          onClick={() => setOpen(o => !o)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
            color: 'var(--text)', flex: 1, minWidth: 0,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0, opacity: 0.8, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>
            <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 600 }}>{title}</span>
          {subtitle && <span style={{ fontSize: 12, color: 'var(--muted)', opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle}</span>}
        </button>
        {open && copyText && <CopyButton text={copyText} />}
      </div>
      {open && (
        <div style={{
          marginTop: 'var(--space-2)',
          marginLeft: 22,
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          padding: 'var(--space-3)',
          background: 'var(--surface)',
        }}>
          {children}
        </div>
      )}
    </div>
  );
}

/* ── Role Distribution Bar ── */
function RoleBar({ dist, total }: { dist: ReplayRoleDistribution; total: number }) {
  const { t } = useTranslation();
  if (total <= 0) return null;
  const items = [
    { label: t('common.roleUser'), count: dist.user, color: 'var(--C-blue)' },
    { label: t('common.roleAssistant'), count: dist.assistant, color: '#10B981' },
    { label: t('common.roleToolResult'), count: dist.toolResult, color: '#D97706' },
    ...(dist.other > 0 ? [{ label: t('common.roleOther'), count: dist.other, color: 'var(--muted)' }] : []),
  ];
  return (
    <div>
      {/* Bar */}
      <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', marginBottom: 'var(--space-2)' }}>
        {items.map(({ label, count, color }) => count > 0 && (
          <div key={label} style={{ flex: count, background: color, opacity: 0.7 }} title={`${label}: ${count}`} />
        ))}
      </div>
      {/* Legend */}
      <div style={{ display: 'flex', gap: 'var(--space-4)', fontSize: 12, fontFamily: 'var(--font-m)' }}>
        {items.map(({ label, count, color }) => (
          <span key={label} style={{ color }}>
            {label} <span style={{ color: 'var(--text)' }}>{count}</span>
            <span style={{ color: 'var(--muted)', opacity: 0.6 }}> ({total > 0 ? fmtPct(count / total, 0) : '0%'})</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── System Prompt Section (with TokenBar + Diff) ── */
function SystemPromptSection({ run, prevRun }: { run: ReplayRun; prevRun?: ReplayRun }) {
  const { t } = useTranslation();
  const digestChanged = prevRun ? prevRun.systemDigest !== run.systemDigest : false;
  const isFirst = !prevRun;
  const hasDiff = digestChanged && prevRun?.systemPrompt;
  const statusLabel = isFirst ? t('debugReplay.statusInitial') : digestChanged ? t('debugReplay.statusChanged') : t('debugReplay.statusUnchanged');
  const statusColor = isFirst ? 'var(--C-blue)' : digestChanged ? '#EF4444' : '#10B981';

  const [activeTab, setActiveTab] = useState<'full' | 'diff'>(hasDiff ? 'diff' : 'full');
  const sections = useMemo(() => estimateSections(run.systemPrompt), [run.systemPrompt]);
  const totalTokens = sections.reduce((a, s) => a + s.tokens, 0);

  return (
    <DetailSection
      title={t('debugReplay.systemPrompt')}
      subtitle={`— ~${fmtTokens(totalTokens)} tokens · ${statusLabel}`}
      defaultOpen={false}
      copyText={run.systemPrompt}
    >
      {/* Status + Token Bar */}
      <div style={{ marginBottom: 'var(--space-3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>
          <span style={{ fontSize: 12, color: statusColor, fontWeight: 600 }}>
            {isFirst ? `● ${t('debugReplay.systemPromptInitial')}` : digestChanged ? `● ${t('debugReplay.systemPromptChanged')}` : `● ${t('debugReplay.systemPromptUnchanged')}`}
          </span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>{fmtTokens(run.systemPrompt.length)} chars</span>
        </div>
        <TokenBar sections={sections} />
      </div>

      {/* Tab switcher (only when diff is available) */}
      {hasDiff && (
        <div style={{ display: 'flex', gap: 2, marginBottom: 'var(--space-3)' }}>
          {(['diff', 'full'] as const).map(tabKey => (
            <button
              key={tabKey}
              onClick={() => setActiveTab(tabKey)}
              style={{
                padding: '3px 12px', fontSize: 12, fontWeight: 500,
                background: activeTab === tabKey ? 'var(--surface3)' : 'transparent',
                border: activeTab === tabKey ? '1px solid var(--border)' : '1px solid transparent',
                borderRadius: 'var(--radius-sm)',
                color: activeTab === tabKey ? 'var(--text)' : 'var(--muted)',
                cursor: 'pointer',
              }}
            >
              {tabKey === 'diff' ? t('debugReplay.diff') : t('debugReplay.fullText')}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      {activeTab === 'diff' && hasDiff ? (
        <div style={{ maxHeight: 400, overflowY: 'auto', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 'var(--radius-sm)' }}>
          <DiffView oldText={prevRun!.systemPrompt} newText={run.systemPrompt} />
        </div>
      ) : (
        <pre style={{
          fontFamily: 'var(--font-m)', fontSize: 12, color: 'var(--text)',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          maxHeight: 400, overflowY: 'auto', margin: 0,
        }}>
          {run.systemPrompt}
        </pre>
      )}
    </DetailSection>
  );
}

/* ── Context Growth Bar ── */
function ContextGrowthBar({ contexts, mcLimited, stages }: { contexts: ReplayContextEntry[]; mcLimited: number | null; stages: ReplayStageLine[] }) {
  if (contexts.length === 0) return null;
  const maxMc = Math.max(...contexts.map(c => c.messageCount), mcLimited ?? 0);
  if (maxMc === 0) return null;
  const baseline = mcLimited ?? 0;
  // Find the seq number of session:limited in stages
  const limitedStage = stages.find(s => s.stage === 'session:limited');
  const limitedSeq = limitedStage?.seq ?? 'L';
  const allBars = [
    { key: `l${limitedSeq}`, height: Math.max(6, (baseline / maxMc) * 32), bg: '#D97706', opacity: 0.5, label: `#${limitedSeq}`, title: `Limited (#${limitedSeq}): ${baseline} msgs` },
    ...contexts.map((ctx, i) => ({
      key: String(ctx.seq),
      height: Math.max(6, (maxMc > 0 ? ctx.messageCount / maxMc : 0) * 32),
      bg: '#10B981',
      opacity: 0.7 + (i / contexts.length) * 0.3,
      label: `#${ctx.seq}`,
      title: `Step ${i + 1} (#${ctx.seq}): ${ctx.messageCount} msgs`,
    })),
  ];
  return (
    <div style={{ marginTop: 6 }}>
      {/* bars row */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 32 }}>
        {allBars.map(b => (
          <div key={b.key} style={{ flex: 1, height: b.height, background: b.bg, opacity: b.opacity, borderRadius: 2 }} title={b.title} />
        ))}
      </div>
      {/* labels row */}
      <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
        {allBars.map(b => (
          <div key={b.key} style={{ flex: 1, textAlign: 'center', fontSize: 11, color: 'var(--muted)' }}>{b.label}</div>
        ))}
      </div>
    </div>
  );
}

/* ── Run Card ── */
function RunCard({ run, seqNum, prevRun }: { run: ReplayRun; seqNum: number; prevRun?: ReplayRun }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const hasLimitDrop = run.limitDelta < 0;
  const hasManyLoops = run.loops > 2;

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', marginBottom: 'var(--space-2)', overflow: 'hidden', background: 'var(--surface)' }}>
      <button
        onClick={() => setExpanded(e => !e)}
        style={{ width: '100%', display: 'flex', alignItems: 'flex-start', gap: 'var(--space-4)', padding: 'var(--space-3) var(--space-4)', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', color: 'var(--text)' }}
      >
        <span style={{ fontSize: 12, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', minWidth: 28, flexShrink: 0, paddingTop: 2 }}>
          #{seqNum}
        </span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
              {fmtTs(run.ts, { seconds: true })}
            </span>
            <span style={{ fontFamily: 'var(--font-m)', fontSize: 12, color: 'var(--C-blue)' }}>
              {run.model}
            </span>
            {run.loops > 1 && (
              <Badge variant={hasManyLoops ? 'amber' : 'blue'}>{run.loops} {t('debugReplay.steps')}</Badge>
            )}
            {hasLimitDrop && (
              <Badge variant="red">{t('debugReplay.droppedMsgs', { count: Math.abs(run.limitDelta) })}</Badge>
            )}
            {run.turnUsage && (
              <span style={{ fontSize: 12, color: 'var(--C-green)', fontVariantNumeric: 'tabular-nums' }}>
                {fmt$$(run.turnUsage.cost)}
              </span>
            )}
            {run.turnUsage && (
              <span style={{ fontSize: 12, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
                {fmtTokens(run.turnUsage.totalTokens)} tokens
              </span>
            )}
            {run.sessionKey && (
              <span style={{ fontFamily: 'var(--font-m)', fontSize: 13, color: 'var(--muted)' }}>
                {run.sessionKey}
              </span>
            )}
          </div>
          <PipelineFlow run={run} />
        </div>

        <span style={{ fontSize: 13, color: 'var(--muted)', flexShrink: 0, paddingTop: 2 }}>{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div style={{ borderTop: '1px solid var(--border)', background: 'rgba(25, 38, 65, 0.5)', padding: 'var(--space-4)' }}>

          {/* IDs */}
          <div style={{ display: 'flex', gap: 'var(--space-5)', fontSize: 12, color: 'var(--muted)', marginBottom: 'var(--space-4)', flexWrap: 'wrap' }}>
            <span>runId: <span style={{ fontFamily: 'var(--font-m)', color: 'var(--text)', fontSize: 12 }}>{run.runId}</span></span>
            {run.systemDigest && (
              <span title={t('debugReplay.systemPromptHashTooltip')}>
                {t('debugReplay.sysDigest')} <span style={{ opacity: 0.5 }}>{t('debugReplay.systemPromptHash')}</span>:{' '}
                <span style={{ fontFamily: 'var(--font-m)', color: 'var(--text)', fontSize: 12, wordBreak: 'break-all' }}>{run.systemDigest}</span>
              </span>
            )}
          </div>

          {/* ── Pipeline + Steps (unified) ── */}
          <div style={{ marginBottom: 'var(--space-6)' }}>
            <div style={{ marginBottom: 'var(--space-2)' }}>
              <span style={{ fontSize: 13, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
                {t('debugReplay.pipeline')}
              </span>
              <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 10, opacity: 0.7 }}>
                — {t('debugReplay.pipelineDesc')}
              </span>
            </div>
            {/* Column headers */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', padding: '2px 0 4px', borderBottom: '1px solid rgba(255,255,255,0.08)', marginBottom: 2 }}>
              <span style={{ color: 'var(--muted)', minWidth: 18, fontSize: 11, textAlign: 'right' }}>#</span>
              <span style={{ color: 'var(--muted)', minWidth: 140, fontSize: 11 }}>{t('debugReplay.colStage')}</span>
              <span style={{ color: 'var(--muted)', minWidth: 40, fontSize: 11 }}>{t('debugReplay.colMsgs')}</span>
              <span style={{ color: 'var(--muted)', fontSize: 11 }}></span>
            </div>
            <div style={{ fontFamily: 'var(--font-m)', fontSize: 14 }}>
              {run.stages.map((s, i) => {
                const prevMc = i > 0 ? (run.stages[i - 1].messageCount ?? 0) : null;
                const delta = prevMc !== null && s.messageCount !== null ? s.messageCount - prevMc : 0;
                // For stream:context, figure out which step number this is
                const ctxIndex = s.stage === 'stream:context'
                  ? run.stages.slice(0, i).filter(x => x.stage === 'stream:context').length
                  : -1;
                const stepLabel = ctxIndex >= 0 ? ` (${t('debugReplay.stepN', { n: ctxIndex + 1 })})` : '';
                const explain = stageExplain(s.stage, t);
                return (
                  <div key={s.seq} style={{ borderBottom: i < run.stages.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none', padding: '4px 0' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                      <span style={{ color: 'var(--muted)', minWidth: 18, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {s.seq}
                      </span>
                      <span style={{ color: fmtStageColor(s.stage), minWidth: 140 }}>
                        {s.stage}{stepLabel && <span style={{ color: '#10B981', fontWeight: 600 }}>{stepLabel}</span>}
                      </span>
                      <span style={{ color: 'var(--text)', minWidth: 40, fontVariantNumeric: 'tabular-nums' }}>
                        {s.messageCount ?? '—'}
                      </span>
                      {delta !== 0 && <DeltaBadge delta={delta} />}
                      {delta < 0 && s.stage === 'session:sanitized' && (
                        <span style={{ fontSize: 12, color: 'var(--muted)', opacity: 0.7 }}>
                          {t('debugReplay.invalidMsgsRemoved', { count: Math.abs(delta) })}
                        </span>
                      )}
                      {delta < 0 && s.stage === 'session:limited' && (
                        <span style={{ fontSize: 12, color: '#EF4444', opacity: 0.85 }}>
                          {t('debugReplay.droppedToFit', { count: Math.abs(delta) })}
                        </span>
                      )}
                      {delta > 0 && s.stage === 'session:after' && (
                        <span style={{ fontSize: 12, color: 'var(--muted)', opacity: 0.7 }}>
                          {t('debugReplay.modelReplyToolResults')}
                        </span>
                      )}
                      {s.digestChanged && (
                        <span style={{ fontSize: 12, color: '#D97706', background: 'rgba(217,119,6,0.12)', padding: '1px 6px', borderRadius: 3 }}
                          title={t('debugReplay.messagesHashTooltip')}>
                          {t('debugReplay.contentModified')}
                        </span>
                      )}
                      {s.note && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{s.note}</span>}
                    </div>
                    {explain && (
                      <div style={{ marginLeft: 30, marginTop: 1, fontSize: 12, color: 'var(--muted)', opacity: 0.65, lineHeight: 1.4 }}>
                        {explain}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {/* Context growth bar chart */}
            {run.contexts.length > 0 && (
              <div style={{ marginTop: 'var(--space-5)', maxWidth: 360 }}>
                <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 6 }}>{t('debugReplay.contextGrowth')}</div>
                <ContextGrowthBar contexts={run.contexts} mcLimited={run.mcLimited} stages={run.stages} />
              </div>
            )}
          </div>

          {/* ── Turn Usage ── */}
          {run.turnUsage && (
            <DetailSection title={t('debugReplay.turnUsage')} subtitle={`— ${t('debugReplay.turnUsageSubtitle', { count: run.turnUsage.callCount, plural: run.turnUsage.callCount > 1 ? 's' : '' })}`}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-3) var(--space-4)', fontFamily: 'var(--font-m)', fontSize: 13 }}>
                {[
                  { label: t('debugReplay.totalTokens'), value: fmtTokens(run.turnUsage.totalTokens) },
                  { label: t('common.input'), value: fmtTokens(run.turnUsage.input) },
                  { label: t('common.output'), value: fmtTokens(run.turnUsage.output) },
                  { label: t('common.cost'), value: fmt$$(run.turnUsage.cost), color: 'var(--C-green)' },
                  { label: t('debugReplay.cacheRead'), value: fmtTokens(run.turnUsage.cacheRead), color: 'var(--C-blue)' },
                  { label: t('debugReplay.cacheWrite'), value: fmtTokens(run.turnUsage.cacheWrite), color: '#7C3AED' },
                  { label: t('debugReplay.modelCalls'), value: run.turnUsage.callCount.toString() },
                ].map(({ label, value, color }) => (
                  <div key={label}>
                    <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 2 }}>{label}</div>
                    <div style={{ color: color ?? 'var(--text)' }}>{value}</div>
                  </div>
                ))}
              </div>
            </DetailSection>
          )}

          {/* ── Model Config ── */}
          {run.modelConfig && (
            <DetailSection title={t('debugReplay.modelConfig')} subtitle={`— ${t('debugReplay.modelConfigSubtitle')}`} defaultOpen={false}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-3) var(--space-4)', fontFamily: 'var(--font-m)', fontSize: 13 }}>
                {[
                  { label: t('common.model'), value: run.modelConfig.name },
                  { label: t('debugReplay.provider'), value: run.modelConfig.provider },
                  { label: t('debugReplay.contextWindow'), value: fmtTokens(run.modelConfig.contextWindow) },
                  { label: t('debugReplay.maxTokens'), value: fmtTokens(run.modelConfig.maxTokens) },
                  { label: t('debugReplay.api'), value: run.modelConfig.api },
                  ...(run.modelConfig.reasoning ? [{ label: t('debugReplay.reasoning'), value: run.modelConfig.reasoning }] : []),
                  ...(run.modelConfig.toolExecution ? [{ label: t('debugReplay.toolExec'), value: run.modelConfig.toolExecution }] : []),
                  ...(run.modelConfig.transport ? [{ label: t('debugReplay.transport'), value: run.modelConfig.transport }] : []),
                ].map(({ label, value }) => (
                  <div key={label}>
                    <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 2 }}>{label}</div>
                    <div style={{ color: 'var(--text)' }}>{value}</div>
                  </div>
                ))}
              </div>
              {run.modelConfig.cost && (
                <div style={{ marginTop: 'var(--space-3)', display: 'flex', gap: 'var(--space-4)', fontSize: 12 }}>
                  <span style={{ color: 'var(--muted)' }}>{t('debugReplay.pricing1M')}</span>
                  <span style={{ color: 'var(--C-green)' }}>{t('common.input')} ${run.modelConfig.cost.input}</span>
                  <span style={{ color: 'var(--C-amber)' }}>{t('common.output')} ${run.modelConfig.cost.output}</span>
                  <span style={{ color: 'var(--C-blue)' }}>{t('debugReplay.cacheRead')} ${run.modelConfig.cost.cacheRead}</span>
                  <span style={{ color: '#7C3AED' }}>{t('debugReplay.cacheWrite')} ${run.modelConfig.cost.cacheWrite}</span>
                </div>
              )}
            </DetailSection>
          )}

          {/* ── Role Distribution ── */}
          <DetailSection title={t('debugReplay.roleDistribution')} subtitle={`— ${t('debugReplay.roleDistributionSubtitle')}`}>
            <RoleBar dist={run.roleDistribution} total={run.roleDistribution.user + run.roleDistribution.assistant + run.roleDistribution.toolResult + run.roleDistribution.other} />
          </DetailSection>

          {/* ── User Prompt ── */}
          {run.userPrompt && (
            <DetailSection title={t('debugReplay.userPrompt')} subtitle={`— ~${fmtTokens(Math.ceil(run.userPrompt.length / 4))} tokens · ${t('debugReplay.userPromptSubtitle')}`} copyText={run.userPrompt}>
              <pre style={{
                fontFamily: 'var(--font-m)', fontSize: 13, color: 'var(--text)',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                maxHeight: 300, overflowY: 'auto', margin: 0,
              }}>
                {run.userPrompt}
              </pre>
            </DetailSection>
          )}

          {/* ── System Prompt ── */}
          {run.systemPrompt && (
            <SystemPromptSection run={run} prevRun={prevRun} />
          )}

          {/* ── Last Messages ── */}
          {run.lastMessages.length > 0 && (
            <DetailSection title={t('debugReplay.contextTail')} subtitle={`— ${t('debugReplay.contextTailSubtitle', { count: run.lastMessages.length })}`} defaultOpen={false}>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 'var(--space-2)', opacity: 0.7 }}>
                <span style={{ color: 'var(--C-green)' }}>{t('debugReplay.hasTokenUsage')}</span> {t('debugReplay.hasTokenUsageDesc')}
              </div>
              <div style={{ maxHeight: 480, overflowY: 'auto' }}>
              {run.lastMessages.map((msg, i) => (
                <div key={i} style={{
                  display: 'flex', gap: 'var(--space-3)', padding: '6px 0',
                  borderBottom: i < run.lastMessages.length - 1 ? '1px solid rgba(255,255,255,0.06)' : 'none',
                  alignItems: 'flex-start',
                }}>
                  <span style={{
                    fontFamily: 'var(--font-m)', fontSize: 12, minWidth: 72, flexShrink: 0, paddingTop: 1,
                    color: msg.role === 'user' ? 'var(--C-blue)' : msg.role === 'assistant' ? '#10B981' : '#D97706',
                  }}>
                    {t(`common.role${msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : msg.role === 'tool_result' ? 'ToolResult' : 'Other'}`)}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginBottom: 2 }}>
                      {msg.toolName && (
                        <span style={{ fontFamily: 'var(--font-m)', fontSize: 11, color: '#7C3AED', background: 'rgba(124,58,237,0.12)', padding: '1px 5px', borderRadius: 3 }}>
                          {msg.toolName}
                        </span>
                      )}
                      {msg.hasUsage && (
                        <span style={{ fontSize: 10, color: 'var(--C-green)', background: 'rgba(16,185,129,0.12)', padding: '1px 5px', borderRadius: 3 }}>
                          {t('debugReplay.hasTokenUsage')}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text)', opacity: 0.85, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}>
                      {msg.textPreview || t('debugReplay.noTextContent')}
                    </div>
                  </div>
                </div>
              ))}
              </div>
            </DetailSection>
          )}

        </div>
      )}
    </div>
  );
}

/* ── Summary Stats Bar ── */
function SummaryStats({ runs }: { runs: ReplayRun[] }) {
  const { t } = useTranslation();
  const totalLoops   = runs.reduce((a, r) => a + r.loops, 0);
  const avgLoops     = runs.length > 0 ? (totalLoops / runs.length).toFixed(1) : '—';
  const maxLoops     = runs.length > 0 ? Math.max(...runs.map(r => r.loops)) : 0;
  const droppedRuns  = runs.filter(r => r.limitDelta < 0).length;
  const totalDropped = runs.reduce((a, r) => a + (r.limitDelta < 0 ? Math.abs(r.limitDelta) : 0), 0);
  const maxMc        = runs.length > 0 ? Math.max(...runs.map(r => r.mcAfter ?? r.mcLimited ?? 0)) : 0;

  return (
    <div style={{ display: 'flex', gap: 'var(--space-5)', marginBottom: 'var(--space-5)', flexWrap: 'wrap' }}>
      {[
        { label: t('debugReplay.totalTurns'), value: runs.length.toString(), warn: false },
        { label: t('debugReplay.avgStepsPerTurn'), value: avgLoops, warn: false },
        { label: t('debugReplay.maxSteps'), value: maxLoops.toString(), warn: maxLoops > 5 },
        { label: t('debugReplay.turnsWithDrops'), value: droppedRuns > 0 ? `${droppedRuns} (${totalDropped} msgs)` : '0', warn: droppedRuns > 0 },
        { label: t('debugReplay.maxMsgCount'), value: fmtTokens(maxMc), warn: false },
      ].map(({ label, value, warn }) => (
        <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 13, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</span>
          <span style={{ fontSize: 18, fontWeight: 700, color: warn ? 'var(--C-amber)' : 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
        </div>
      ))}
    </div>
  );
}

/* ── Page ── */
export default function DebugReplay() {
  const { t } = useTranslation();
  const { data: status } = useFetch<DebugStatus>('/api/debug/status');
  const { data: sessionsData } = useFetch<SessionsData>('/api/debug/sessions');
  const [selectedSession, setSelectedSession] = useState('');
  const [showAll, setShowAll] = useState(false);

  const replayUrl = selectedSession ? `/api/debug/session/${selectedSession}/cache-replay` : '';
  const { data: replayData, loading } = useFetch<ReplayData>(replayUrl, [selectedSession]);

  function handleSessionChange(id: string) {
    setSelectedSession(id);
    setShowAll(false);
  }

  const available  = status?.cacheTraceAvailable ?? false;
  const sessions   = sessionsData?.sessions ?? [];
  const allRuns    = replayData?.runs ?? [];
  const LIMIT      = 30;
  const displayed  = showAll ? allRuns : allRuns.slice(0, LIMIT);

  return (
    <div>
      <PageHeader
        title={t('debugReplay.title')}
        subtitle={t('debugReplay.subtitle')}
      >
        <div style={{ flex: '0 0 100%', fontSize: 12, color: 'var(--muted)', lineHeight: 1.7, marginTop: 6 }}>
          {t('debugReplay.cacheTraceNote')}
          <span style={{ position: 'relative', display: 'inline-block' }} className="ct-howto-wrap">
            <span style={{
              color: 'var(--C-blue)', cursor: 'help',
              borderBottom: '1px dashed var(--C-blue)', paddingBottom: 1,
            }}>
              {t('debugReplay.howToEnable')}
            </span>
            <span className="ct-howto-box" style={{
              display: 'none', position: 'absolute', left: 0, top: '100%', marginTop: 8,
              background: '#1a1a1a', border: '1px solid #333', borderRadius: 8,
              padding: '14px 16px', zIndex: 200, width: 340,
              fontSize: 11, lineHeight: 1.7, color: 'var(--text)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
              whiteSpace: 'normal' as const, textAlign: 'left' as const,
            }}>
              <div style={{ fontWeight: 600, marginBottom: 10 }}>{t('debugReplay.twoWaysToEnable')}</div>
              <div style={{ marginBottom: 12 }}>
                <div style={{ color: 'var(--muted)', marginBottom: 4 }}>
                  {t('debugReplay.addToConfig')} <code style={{ fontFamily: 'var(--font-m)' }}>~/.openclaw/openclaw.json</code>
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
                  {t('debugReplay.letOpenClawEnable')}
                </div>
                <code style={{
                  display: 'block', padding: '6px 8px',
                  background: 'rgba(255,255,255,0.06)', borderRadius: 4,
                  color: 'var(--C-blue)', fontFamily: 'var(--font-m)',
                }}>
                  OPENCLAW_CACHE_TRACE
                </code>
                <div style={{ color: 'var(--muted)', fontSize: 10, marginTop: 4 }}>
                  {t('debugReplay.copyFlag')}
                </div>
              </div>
              <div style={{
                color: '#EF4444', borderTop: '1px solid rgba(239,68,68,0.25)',
                paddingTop: 10, fontSize: 11,
              }}>
                {t('debugReplay.fileGrowsWarning')}
              </div>
            </span>
            <style>{`.ct-howto-wrap:hover .ct-howto-box { display: block !important; }`}</style>
          </span>
        </div>
      </PageHeader>

      <div style={{ padding: '0 var(--space-5)', marginBottom: 'var(--space-5)' }}>
        <div style={{ fontSize: 14, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 'var(--space-4)', marginTop: 'var(--space-5)' }}>
          <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: available ? '#10B981' : '#6B7280', flexShrink: 0 }} />
          {available ? t('debugReplay.cacheTraceEnabled') : t('debugReplay.cacheTraceNotEnabled')}
        </div>

        {!available && status && <UnavailableBanner feature="Cache Trace (Session Replay)" />}

        {available && (
          <div>
            <label style={{ fontSize: 13, color: 'var(--muted)', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.08em' }}>
              {t('debugReplay.session')}
            </label>
            <SessionPicker sessions={sessions} value={selectedSession} onChange={handleSessionChange} />
          </div>
        )}
      </div>

      {loading && selectedSession && (
        <div style={{ padding: '0 var(--space-5)' }}><Loading /></div>
      )}

      {replayData?.available && allRuns.length > 0 && (
        <div style={{ padding: '0 var(--space-5)' }}>
          <SummaryStats runs={allRuns} />

          {displayed.map((run, i) => (
            <RunCard key={run.runId} run={run} seqNum={i + 1} prevRun={i > 0 ? displayed[i - 1] : undefined} />
          ))}

          {!showAll && allRuns.length > LIMIT && (
            <button
              onClick={() => setShowAll(true)}
              style={{ marginTop: 'var(--space-3)', padding: 'var(--space-2) var(--space-4)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--muted)', fontSize: 14, cursor: 'pointer' }}
            >
              {t('debugReplay.showAllRuns', { count: allRuns.length })}
            </button>
          )}
        </div>
      )}

      {replayData?.available === false && selectedSession && !loading && (
        <div style={{ padding: '0 var(--space-5)', color: 'var(--muted)', fontSize: 13 }}>
          {t('debugReplay.noCacheTraceData')}
        </div>
      )}
    </div>
  );
}
