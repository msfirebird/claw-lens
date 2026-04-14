import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { getClawHome, cleanSlackText } from './paths';

/** stop_reason / stopReason values that mean a session turn is fully closed.
 *  Values match the pi-ai upstream library that OpenClaw normalizes to:
 *  'stop' (model finished naturally), 'error' (api/network/provider error),
 *  'aborted' (user cancelled), 'length' (max_tokens hit). NOT raw Anthropic
 *  values like 'end_turn' / 'max_tokens' which OpenClaw never emits. */
export const CLOSED_STOP_REASONS = new Set(['stop', 'error', 'aborted', 'length']);

export interface RawRecord {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string; // ISO string at top level
  toolUseResult?: unknown;  // present on tool-result user messages
  message?: {
    role: string;
    model?: string;
    api?: string;
    provider?: string;
    usage?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
      };
    };
    stopReason?: string;
    errorMessage?: string;
    content?: ContentItem[] | string;
    timestamp?: number; // unix ms inside message
    toolCallId?: string;   // for toolResult messages
    toolName?: string;     // for toolResult messages
    isError?: boolean;     // for toolResult messages
    details?: { durationMs?: number; status?: string; exitCode?: number };
  };
}

export interface ContentItem {
  type: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  text?: string;
  tool_use_id?: string;  // for tool_result content items
  is_error?: boolean;    // for tool_result content items
}

export interface ParsedMessage {
  id: string;
  sessionId: string;
  agentName: string;
  parentId: string | null;
  timestamp: number; // unix ms
  model: string;
  provider: string;
  role: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costTotal: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  stopReason: string;
  errorMessage: string | null;
  hasError: number; // 0 or 1
  isToolResult: number; // 0 or 1 — true for user messages that carry tool results
  toolCalls: ParsedToolCall[];
}

export interface ParsedToolCall {
  id: string;
  messageId: string;
  sessionId: string;
  agentName: string;
  timestamp: number;
  toolName: string;
  durationMs: number | null; // null until we can infer it
  success: number; // 0 or 1
  arguments: string | null;  // JSON-serialised tool input arguments
}

export interface ParsedSession {
  id: string;
  agentName: string;
  startedAt: number;
  endedAt: number;
  totalMessages: number;
  totalCost: number;
  totalTokens: number;
  primaryModel: string;
  errorCount: number;
  isCron: boolean;
  cronTask: string | null;
  taskSummary: string | null;
}

export interface ParseResult {
  messages: ParsedMessage[];
  toolCalls: ParsedToolCall[];
  sessions: ParsedSession[];
}


export async function findSessionFiles(clawHome?: string): Promise<string[]> {
  const base = clawHome || getClawHome();
  // Match *.jsonl and also *.jsonl.deleted.* / *.jsonl.reset.* (archived sessions)
  const patterns = [
    path.join(base, 'agents', '**', 'sessions', '*.jsonl'),
    path.join(base, 'agents', '**', 'sessions', '*.jsonl.deleted.*'),
    path.join(base, 'agents', '**', 'sessions', '*.jsonl.reset.*'),
  ];
  const results = await Promise.all(patterns.map(p => glob(p, { nodir: true })));
  // Deduplicate by session ID (prefer active .jsonl over archived)
  const byId = new Map<string, string>();
  for (const files of results) {
    for (const f of files) {
      const basename = path.basename(f);
      // Extract session ID: everything before .jsonl
      const match = basename.match(/^([0-9a-f-]+)\.jsonl/);
      if (!match) continue;
      const sessionId = match[1];
      // Prefer active file over archived
      if (!byId.has(sessionId) || basename.endsWith('.jsonl')) {
        byId.set(sessionId, f);
      }
    }
  }
  return Array.from(byId.values());
}

function extractAgentName(filePath: string): string {
  // ~/.openclaw/agents/{agentName}/sessions/xxx.jsonl
  const parts = filePath.split(path.sep);
  const agentsIdx = parts.lastIndexOf('agents');
  if (agentsIdx !== -1 && agentsIdx + 1 < parts.length) {
    return parts[agentsIdx + 1];
  }
  return 'unknown';
}

function extractSessionId(filePath: string): string {
  // Handle: xxx.jsonl, xxx.jsonl.deleted.2026-..., xxx.jsonl.reset.2026-...
  const basename = path.basename(filePath);
  const match = basename.match(/^([0-9a-f-]+)\.jsonl/);
  return match ? match[1] : path.basename(filePath, '.jsonl');
}

export function parseSessionFile(filePath: string): ParseResult {
  const agentName = extractAgentName(filePath);
  const sessionId = extractSessionId(filePath);

  const rawLines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
  const records: RawRecord[] = [];

  for (const line of rawLines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }

  const messageRecords = records.filter(r => r.type === 'message');

  const messages: ParsedMessage[] = [];
  const toolCalls: ParsedToolCall[] = [];

  // Build a map of message index for timing inference
  const msgTimestamps: number[] = messageRecords.map(r => {
    return r.message?.timestamp || new Date(r.timestamp).getTime();
  });

  // ── Build toolResult lookup: toolCallId → { timestamp, durationMs, failed, aborted, dispatchTs } ──
  // Tool results appear either as legacy `role: 'toolResult'` records (OpenClaw format)
  // or as `role: 'user'` messages with `tool_result` content items (Anthropic-style modern format).
  //
  // Two important real-data findings drive how we derive status here:
  //
  //  1. `msg.isError` is unreliable. It's `false` for ~99.9% of records even when the tool
  //     actually errored, failed, timed out, or had its approval denied. The authoritative
  //     signal is `details.status`. We classify it manually.
  //
  //  2. `details.durationMs` is missing for ~38% of tool calls. The previous fallback
  //     (toolResult.timestamp - assistant.message.timestamp) overestimated by 30-500x
  //     because assistant.message.timestamp is the LLM CALL START, not the LLM finish /
  //     dispatch time. The top-level `r.timestamp` of the assistant record is when the
  //     response was logged (≈ dispatch time), so we capture it separately.
  const FAILED_STATUSES = new Set(['error', 'failed', 'timeout', 'approval-unavailable']);
  const toolResultMap = new Map<string, { timestamp: number; durationMs: number | null; failed: boolean; aborted: boolean }>();

  for (const r of messageRecords) {
    const msg = r.message;
    if (!msg) continue;

    const trTs = msg.timestamp || new Date(r.timestamp).getTime();

    // Legacy format: msg.role === 'toolResult' with toolCallId
    if (msg.role === 'toolResult' && msg.toolCallId) {
      const detailDur = msg.details?.durationMs ?? null;
      const status = msg.details?.status;
      // status === 'running' means the tool was still running when aborted
      const aborted = status === 'running';
      // Real failure signal is status, not isError. isError is almost always false.
      const failed = typeof status === 'string' && FAILED_STATUSES.has(status)
        || (status === undefined && Boolean(msg.isError));
      toolResultMap.set(msg.toolCallId, {
        timestamp: trTs,
        durationMs: typeof detailDur === 'number' && detailDur > 0 ? detailDur : null,
        failed,
        aborted,
      });
      continue;
    }

    // Modern format: role='user', content contains tool_result items.
    // (Currently unused by OpenClaw — kept for forward compat with Anthropic-style logs.)
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const recordDur = (r.toolUseResult as Record<string, unknown>)?.durationMs;
      const durMs = typeof recordDur === 'number' && recordDur > 0 ? recordDur : null;

      for (const item of msg.content as ContentItem[]) {
        if (item.type === 'tool_result' && item.tool_use_id) {
          toolResultMap.set(item.tool_use_id, {
            timestamp: trTs,
            durationMs: durMs,
            failed: Boolean(item.is_error),
            aborted: false,
          });
        }
      }
    }
  }

  for (let i = 0; i < messageRecords.length; i++) {
    const r = messageRecords[i];
    const msg = r.message;
    if (!msg) continue;

    const ts = msg.timestamp || new Date(r.timestamp).getTime();
    const usage = msg.usage;

    // Store both user and assistant messages; only assistant has usage data
    if (msg.role !== 'assistant' && msg.role !== 'user') continue;

    const stopReason = msg.role === 'assistant' ? (msg.stopReason || 'unknown') : null;
    const hasError = stopReason === 'error' ? 1 : 0;
    const errorMsg = msg.errorMessage || null;

    // Detect non-real-user messages: tool results, runtime-injected context, etc.
    // These should not be treated as "real user input" for latency profiling.
    let isToolResult = 0;
    if (msg.role === 'user') {
      if ('toolUseResult' in r) {
        isToolResult = 1;
      } else if (Array.isArray(msg.content) && msg.content.some((c: ContentItem) => c.type === 'tool_result')) {
        isToolResult = 1;
      } else {
        // OpenClaw runtime context messages (subagent completion events, system notifications)
        // have role='user' but are auto-generated, not real user input.
        const textContent = Array.isArray(msg.content)
          ? msg.content.filter((c: ContentItem) => c.type === 'text').map((c: ContentItem) => c.text || '').join('')
          : typeof msg.content === 'string' ? msg.content : '';
        if (textContent.includes('runtime-generated, not user-authored') || textContent.includes('[Internal task completion event]')) {
          isToolResult = 1;
        }
      }
    }

    const parsed: ParsedMessage = {
      id: r.id,
      sessionId,
      agentName,
      parentId: r.parentId,
      timestamp: ts,
      model: msg.model || (msg.role === 'user' ? '' : 'unknown'),
      provider: msg.provider || '',
      role: msg.role,
      inputTokens: usage?.input ?? 0,
      outputTokens: usage?.output ?? 0,
      cacheRead: usage?.cacheRead ?? 0,
      cacheWrite: usage?.cacheWrite ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
      costTotal: Math.max(0, usage?.cost?.total ?? 0),
      costInput: Math.max(0, usage?.cost?.input ?? 0),
      costOutput: Math.max(0, usage?.cost?.output ?? 0),
      costCacheRead: Math.max(0, usage?.cost?.cacheRead ?? 0),
      costCacheWrite: Math.max(0, usage?.cost?.cacheWrite ?? 0),
      stopReason: stopReason || 'unknown',
      errorMessage: errorMsg,
      hasError,
      isToolResult,
      toolCalls: [],
    };

    // Extract tool calls from content
    const rawContent = msg.content || [];
    const contentArr: ContentItem[] = Array.isArray(rawContent) ? rawContent : [];
    // Top-level r.timestamp ≈ when the assistant response was logged ≈ tool dispatch start.
    // Used as the baseline for duration fallback (NOT msg.timestamp which is LLM call start).
    const dispatchTs = new Date(r.timestamp).getTime();
    const msgToolCalls: ParsedToolCall[] = contentArr
      .filter((item: ContentItem) => (item.type === 'toolCall' || item.type === 'tool_use') && item.id && item.name)
      .map(item => {
        // Use individual toolResult data when available (accurate per-tool timing)
        const trData = toolResultMap.get(item.id!);
        let durationMs: number | null = null;
        let success = 1;

        if (trData && !trData.aborted) {
          if (trData.durationMs) {
            // Exact runtime measurement from the tool itself
            durationMs = trData.durationMs;
          } else {
            // Fallback: toolResult timestamp - dispatch time (LLM finish, not LLM start).
            // Real-data validation: this is accurate to ~25 ms (vs 9 sec error using
            // assistant.msg.timestamp as the baseline).
            const raw = trData.timestamp - dispatchTs;
            durationMs = raw > 0 ? raw : null;
          }
          // Real failure signal is status (captured into trData.failed), not isError.
          success = trData.failed ? 0 : 1;
        }
        // Aborted tools (status='running') have no reliable duration → leave null,
        // and mark as not-success since they didn't complete.
        if (trData?.aborted) success = 0;

        const tc: ParsedToolCall = {
          id: item.id!,
          messageId: r.id,
          sessionId,
          agentName,
          timestamp: trData?.timestamp ?? ts,  // use toolResult timestamp if available
          toolName: item.name!,
          durationMs,
          success,
          arguments: item.arguments ? JSON.stringify(item.arguments) : null,
        };
        return tc;
      });

    parsed.toolCalls = msgToolCalls;
    messages.push(parsed);
    toolCalls.push(...msgToolCalls);
  }

  // Build session summary
  const session = buildSession(sessionId, agentName, messages, records);

  return { messages, toolCalls, sessions: session ? [session] : [] };
}

function buildSession(
  sessionId: string,
  agentName: string,
  messages: ParsedMessage[],
  records: RawRecord[],
): ParsedSession | null {
  if (messages.length === 0) return null;

  const timestamps = messages.map(m => m.timestamp).filter(Boolean);
  const startedAt = Math.min(...timestamps);
  const endedAt = Math.max(...timestamps);

  // Exclude synthetic models (delivery-mirror, gateway-injected) from aggregates
  const SYNTHETIC_MODELS = new Set(['delivery-mirror', 'gateway-injected']);
  const realMessages = messages.filter(m => !SYNTHETIC_MODELS.has(m.model));
  const totalCost = realMessages.reduce((sum, m) => sum + m.costTotal, 0);
  const totalTokens = realMessages.reduce((sum, m) => sum + m.totalTokens, 0);
  const errorCount = realMessages.filter(m => m.hasError).length;
  // Canonical "message count" = assistant messages from real (billable) models.
  // All API endpoints already aggregate with role='assistant' AND model NOT IN synthetic,
  // so sessions.total_messages must use the same definition to stay consistent.
  const assistantMessageCount = realMessages.filter(m => m.role === 'assistant').length;

  // Primary model: last assistant message's model
  const lastAssistantModel = [...messages]
    .reverse()
    .find(m => m.role === 'assistant' && m.model && !SYNTHETIC_MODELS.has(m.model))
    ?.model;
  const primaryModel = lastAssistantModel || 'unknown';

  // Detect cron sessions: first user message contains [cron:UUID task-name]
  let isCron = false;
  let cronTask: string | null = null;
  let taskSummary: string | null = null;
  for (const r of records) {
    if (r.type === 'message' && r.message?.role === 'user') {
      const content = r.message.content;
      let text = '';
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content) && content.length > 0) {
        const first = content[0];
        text = typeof first === 'string' ? first : (first as { text?: string })?.text ?? '';
      }
      const cronMatch = text.match(/\[cron:[^\s]+ ([^\]]+)\]/);
      if (cronMatch) {
        isCron = true;
        cronTask = cronMatch[1];
      }
      // cron detection only on first user message; task summary = last user message
      const stripped = cleanSlackText(text);
      if (stripped) taskSummary = stripped.slice(0, 150);
    }
  }

  return {
    id: sessionId,
    agentName,
    startedAt,
    endedAt,
    totalMessages: assistantMessageCount,
    totalCost,
    totalTokens,
    primaryModel,
    errorCount,
    isCron,
    cronTask,
    taskSummary,
  };
}

// --- CLI summary when run directly ---
async function main() {
  const clawHome = getClawHome();
  console.log(`Scanning: ${clawHome}`);

  const files = await findSessionFiles(clawHome);
  console.log(`Found ${files.length} session file(s)\n`);

  if (files.length === 0) {
    console.error(`No .jsonl files found at ${clawHome}/agents/*/sessions/`);
    process.exit(1);
  }

  let totalMessages = 0;
  let totalCost = 0;
  let minTs = Infinity;
  let maxTs = 0;
  const modelsCount: Record<string, number> = {};
  const toolsCount: Record<string, number> = {};

  for (const f of files) {
    const result = parseSessionFile(f);
    totalMessages += result.messages.length;
    for (const m of result.messages) {
      totalCost += m.costTotal;
      if (m.timestamp < minTs) minTs = m.timestamp;
      if (m.timestamp > maxTs) maxTs = m.timestamp;
      if (m.model && m.model !== 'delivery-mirror' && m.model !== 'gateway-injected') {
        modelsCount[m.model] = (modelsCount[m.model] || 0) + 1;
      }
    }
    for (const tc of result.toolCalls) {
      toolsCount[tc.toolName] = (toolsCount[tc.toolName] || 0) + 1;
    }
  }

  const dateFrom = minTs === Infinity ? 'n/a' : new Date(minTs).toISOString().split('T')[0];
  const dateTo = maxTs === 0 ? 'n/a' : new Date(maxTs).toISOString().split('T')[0];

  console.log(`Total records found : ${totalMessages}`);
  console.log(`Date range          : ${dateFrom} to ${dateTo}`);
  console.log(`Total cost          : $${totalCost.toFixed(4)}`);
  console.log(
    `Models seen         : ${Object.entries(modelsCount)
      .sort((a, b) => b[1] - a[1])
      .map(([m, c]) => `${m} (${c})`)
      .join(', ')}`
  );
  console.log(
    `Top tools           : ${Object.entries(toolsCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([t, c]) => `${t}(${c})`)
      .join(', ')}`
  );
}

if (require.main === module) {
  main().catch(console.error);
}
