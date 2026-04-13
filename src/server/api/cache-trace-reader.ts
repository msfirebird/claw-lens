import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const CACHE_TRACE_PATH = path.join(os.homedir(), '.openclaw', 'logs', 'cache-trace.jsonl');
const MAX_LINES = 100_000;

export interface CacheMessage {
  role: string;
  content: unknown;
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export interface CacheModelOptions {
  id?: string;
  name?: string;
  api?: string;
  provider?: string;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface CacheTraceEntry {
  runId: string;
  sessionId: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string;
  workspaceDir?: string;
  ts: string;
  seq: number;
  stage: string;
  // session:loaded
  system?: string;
  systemDigest?: string;
  // all message stages
  messages?: CacheMessage[];
  messageCount?: number;
  messageRoles?: string[];
  // stream:context
  options?: { model?: CacheModelOptions };
  model?: { id?: string; provider?: string; api?: string };
  // prompt:before / prompt:images
  prompt?: string;
  note?: string;
}

export interface CacheTraceTurn {
  runId: string;
  sessionId: string;
  modelId: string;
  ts: string;
  loaded: CacheTraceEntry;         // seq=1 session:loaded
  firstCtx: CacheTraceEntry | null; // stream:context with lowest seq
}

// ── Extended interface for full-pipeline cache-trace entries ──────────────────
export interface CacheTraceEntryFull extends CacheTraceEntry {
  messageFingerprints?: string[];
  messagesDigest?: string;
}

export interface ReplayStageLine {
  stage: string;
  seq: number;
  messageCount: number | null;
  note: string;
  digestChanged: boolean;
}

export interface ReplayContextEntry {
  seq: number;
  messageCount: number;
  newMsgCount: number;
  newFingerprintCount: number;
  contextWindow: number;
}

export interface ReplayModelConfig {
  name: string;
  provider: string;
  api: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: string;        // from options.reasoning (e.g. "medium")
  toolExecution: string;    // from options.toolExecution (e.g. "parallel")
  transport: string;        // from options.transport (e.g. "sse")
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
}

export interface ReplayRoleDistribution {
  user: number;
  assistant: number;
  toolResult: number;
  other: number;
}

export interface ReplayLastMessage {
  role: string;
  textPreview: string;      // first ~200 chars of text content
  toolName?: string;
  hasUsage: boolean;
}

export interface ReplayTurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  callCount: number;        // number of model calls with usage data
}

export interface ReplayRun {
  runId: string;
  ts: string;
  model: string;
  sessionKey: string;
  // Quick summary
  mcLoaded:   number | null;
  mcLimited:  number | null;
  mcAfter:    number | null;
  sanitizeDelta: number;
  limitDelta:    number;
  loops:         number;
  contextGrowth: number;
  // Detail
  stages:   ReplayStageLine[];
  contexts: ReplayContextEntry[];
  systemDigest: string;
  noteStr: string;
  // ── New data ──
  systemPrompt: string;             // full system prompt from session:loaded (truncated to 50K)
  userPrompt: string;               // assembled prompt from prompt:before
  roleDistribution: ReplayRoleDistribution;  // from session:loaded messageRoles
  modelConfig: ReplayModelConfig | null;     // from first stream:context options
  lastMessages: ReplayLastMessage[];         // last 10 messages from stream:context (first step)
  turnUsage: ReplayTurnUsage | null;         // aggregated token usage for this turn
}

export function readCacheTraceAllStages(sessionId: string): {
  available: boolean;
  runs: ReplayRun[];
} {
  if (!fs.existsSync(CACHE_TRACE_PATH)) return { available: false, runs: [] };
  try {
    const raw = fs.readFileSync(CACHE_TRACE_PATH, 'utf8');
    // Keep the TAIL (most recent) of the file. `.slice(0, N)` would keep the
    // head, dropping newly-appended entries once the file exceeds MAX_LINES.
    const lines = raw.split('\n').filter(l => l.trim()).slice(-MAX_LINES);

    // Collect all entries for this session, grouped by runId
    const byRun = new Map<string, CacheTraceEntryFull[]>();
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as CacheTraceEntryFull;
        if (e.sessionId !== sessionId) continue;
        if (!byRun.has(e.runId)) byRun.set(e.runId, []);
        byRun.get(e.runId)!.push(e);
      } catch { /* skip */ }
    }

    const STAGE_ORDER = [
      'session:loaded', 'session:sanitized', 'session:limited',
      'prompt:before', 'prompt:images', 'stream:context', 'session:after',
    ];

    const runs: ReplayRun[] = [];
    for (const [runId, entries] of byRun) {
      entries.sort((a, b) => a.seq - b.seq);

      const loaded    = entries.find(e => e.stage === 'session:loaded');
      const sanitized = entries.find(e => e.stage === 'session:sanitized');
      const limited   = entries.find(e => e.stage === 'session:limited');
      const after     = entries.find(e => e.stage === 'session:after');
      const ctxEntries = entries.filter(e => e.stage === 'stream:context')
        .sort((a, b) => a.seq - b.seq);
      const promptBefore = entries.find(e => e.stage === 'prompt:before');

      if (!loaded) continue;

      // Build stage pipeline lines
      const stages: ReplayStageLine[] = [];
      let prevDigest = '';
      for (const e of entries) {
        const digest = e.messagesDigest ?? '';
        stages.push({
          stage: e.stage,
          seq: e.seq,
          messageCount: e.messageCount ?? null,
          note: e.note ?? '',
          digestChanged: digest !== prevDigest && prevDigest !== '',
        });
        if (digest) prevDigest = digest;
      }

      // Build context loop entries with fingerprint diffs
      const contexts: ReplayContextEntry[] = [];
      let prevFps = new Set<string>(limited?.messageFingerprints ?? loaded.messageFingerprints ?? []);
      for (const ctx of ctxEntries) {
        const fps = new Set<string>(ctx.messageFingerprints ?? []);
        const newFps = [...fps].filter(f => !prevFps.has(f));
        const prevMc = ctxEntries[contexts.length - 1]?.messageCount ?? limited?.messageCount ?? loaded.messageCount ?? 0;
        contexts.push({
          seq: ctx.seq,
          messageCount: ctx.messageCount ?? 0,
          newMsgCount: (ctx.messageCount ?? 0) - (prevMc as number),
          newFingerprintCount: newFps.length,
          contextWindow: ctx.options?.model?.contextWindow ?? 1_000_000,
        });
        prevFps = fps;
      }

      const mcLoaded   = loaded.messageCount ?? null;
      const mcSan      = sanitized?.messageCount ?? null;
      const mcLimited  = limited?.messageCount ?? mcSan ?? mcLoaded;
      const mcAfter    = after?.messageCount ?? null;

      // ── New: system prompt ──
      const systemPrompt = (loaded.system ?? '').slice(0, 50_000);

      // ── New: user prompt from prompt:before ──
      const userPrompt = (promptBefore?.prompt ?? '').slice(0, 10_000);

      // ── New: role distribution — prefer first stream:context (what model actually sees) over session:loaded ──
      const roles = ctxEntries[0]?.messageRoles ?? loaded.messageRoles ?? [];
      const roleDistribution: ReplayRoleDistribution = { user: 0, assistant: 0, toolResult: 0, other: 0 };
      for (const r of roles) {
        if (r === 'user') roleDistribution.user++;
        else if (r === 'assistant') roleDistribution.assistant++;
        else if (r === 'toolResult') roleDistribution.toolResult++;
        else roleDistribution.other++;
      }

      // ── New: model config from first stream:context ──
      let modelConfig: ReplayModelConfig | null = null;
      const firstCtx = ctxEntries[0];
      if (firstCtx?.options) {
        const m = firstCtx.options.model ?? {} as any;
        const opts = firstCtx.options as any;
        modelConfig = {
          name: m.name ?? m.id ?? '',
          provider: m.provider ?? loaded.provider ?? '',
          api: m.api ?? loaded.modelApi ?? '',
          contextWindow: m.contextWindow ?? 0,
          maxTokens: m.maxTokens ?? 0,
          reasoning: opts.reasoning ?? '',
          toolExecution: opts.toolExecution ?? '',
          transport: opts.transport ?? '',
          cost: m.cost ?? null,
        };
      }

      // ── New: last messages preview from first stream:context ──
      const lastMessages: ReplayLastMessage[] = [];
      const srcMsgs = (firstCtx?.messages ?? loaded.messages ?? []) as any[];
      const tail = srcMsgs.slice(-10);
      for (const msg of tail) {
        let textPreview = '';
        if (typeof msg.content === 'string') {
          textPreview = msg.content.slice(0, 1000);
        } else if (Array.isArray(msg.content)) {
          const textBlock = msg.content.find((b: any) => b.type === 'text');
          textPreview = (textBlock?.text ?? '').slice(0, 1000);
        }
        lastMessages.push({
          role: msg.role ?? '',
          textPreview,
          toolName: msg.toolName ?? (Array.isArray(msg.content) ? msg.content.find((b: any) => b.type === 'toolCall')?.name : undefined),
          hasUsage: !!msg.usage,
        });
      }

      // ── New: aggregate token usage for this turn ──
      // New messages in session:after (beyond what was in session:limited) carry per-call usage
      let turnUsage: ReplayTurnUsage | null = null;
      if (after) {
        const afterMsgs = (after.messages ?? []) as any[];
        const limitedCount = limited?.messageCount ?? loaded.messageCount ?? 0;
        const newMsgs = afterMsgs.slice(limitedCount);
        let tInput = 0, tOutput = 0, tCacheRead = 0, tCacheWrite = 0, tCost = 0, callCount = 0;
        for (const m of newMsgs) {
          const u = m?.usage;
          if (!u) continue;
          callCount++;
          tInput += u.input ?? 0;
          tOutput += u.output ?? 0;
          tCacheRead += u.cacheRead ?? 0;
          tCacheWrite += u.cacheWrite ?? 0;
          const c = u.cost;
          // Clamp negative sentinel costs (OpenRouter emits -token_count when price is unknown)
          if (c && typeof c === 'object') tCost += Math.max(0, c.total ?? 0);
        }
        if (callCount > 0) {
          turnUsage = {
            input: tInput,
            output: tOutput,
            cacheRead: tCacheRead,
            cacheWrite: tCacheWrite,
            totalTokens: tInput + tOutput + tCacheRead + tCacheWrite,
            cost: tCost,
            callCount,
          };
        }
      }

      runs.push({
        runId,
        ts: loaded.ts,
        model: loaded.modelId ?? ctxEntries[0]?.options?.model?.id ?? '',
        sessionKey: loaded.sessionKey ?? '',
        mcLoaded,
        mcLimited: mcLimited ?? null,
        mcAfter,
        sanitizeDelta: mcSan != null && mcLoaded != null ? mcSan - mcLoaded : 0,
        limitDelta:    mcLimited != null && mcSan != null ? mcLimited - mcSan : 0,
        loops: ctxEntries.length,
        contextGrowth: mcAfter != null && mcLimited != null ? mcAfter - mcLimited : 0,
        stages,
        contexts,
        systemDigest: loaded.systemDigest ?? '',
        noteStr: promptBefore?.note ?? '',
        systemPrompt,
        userPrompt,
        roleDistribution,
        modelConfig,
        lastMessages,
        turnUsage,
      });
    }

    runs.sort((a, b) => a.ts.localeCompare(b.ts));
    return { available: true, runs };
  } catch {
    return { available: false, runs: [] };
  }
}

export function readCacheTrace(): {
  available: boolean;
  fileSize: number;
  turns: CacheTraceTurn[];
} {
  if (!fs.existsSync(CACHE_TRACE_PATH)) {
    return { available: false, fileSize: 0, turns: [] };
  }
  try {
    const stat = fs.statSync(CACHE_TRACE_PATH);
    const raw = fs.readFileSync(CACHE_TRACE_PATH, 'utf8');
    // Keep the TAIL (most recent) of the file. `.slice(0, N)` would keep the
    // head, dropping newly-appended entries once the file exceeds MAX_LINES.
    const lines = raw.split('\n').filter(l => l.trim()).slice(-MAX_LINES);

    // Group by runId, collecting session:loaded (seq=1) and first stream:context (min seq)
    const byRun = new Map<string, {
      loaded: CacheTraceEntry | null;
      firstCtx: CacheTraceEntry | null;
    }>();

    for (const line of lines) {
      try {
        const e = JSON.parse(line) as CacheTraceEntry;
        if (e.stage !== 'session:loaded' && e.stage !== 'stream:context') continue;
        if (!byRun.has(e.runId)) byRun.set(e.runId, { loaded: null, firstCtx: null });
        const run = byRun.get(e.runId)!;
        if (e.stage === 'session:loaded') {
          run.loaded = e;
        } else if (e.stage === 'stream:context') {
          // Keep the one with the lowest seq (initial API call, before any tool call loops)
          if (!run.firstCtx || e.seq < run.firstCtx.seq) run.firstCtx = e;
        }
      } catch { /* skip malformed */ }
    }

    // Build turns — require session:loaded to be present
    const turns: CacheTraceTurn[] = [];
    for (const [runId, run] of byRun) {
      if (!run.loaded) continue;
      const e = run.loaded;
      turns.push({
        runId,
        sessionId: e.sessionId,
        modelId:   e.modelId ?? run.firstCtx?.options?.model?.id ?? '',
        ts:        e.ts,
        loaded:    e,
        firstCtx:  run.firstCtx,
      });
    }

    // Sort chronologically by ts
    turns.sort((a, b) => a.ts.localeCompare(b.ts));

    return { available: true, fileSize: stat.size, turns };
  } catch {
    return { available: false, fileSize: 0, turns: [] };
  }
}
