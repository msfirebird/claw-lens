import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import {
  CACHE_TRACE_PATH,
  readCacheTrace,
  readCacheTraceAllStages,
} from './cache-trace-reader';

/**
 * Estimate token count from a string. Uses char/4 for ASCII-heavy text
 * but char/2 for CJK-heavy text (Chinese, Japanese, Korean use ~2 chars/token).
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  // Count CJK characters (common ranges)
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const ratio = text.length > 0 && cjkCount / text.length > 0.3 ? 2 : 4;
  return Math.ceil(text.length / ratio);
}

export default function debugRouter(db: Database): Router {
  const r = Router();

  // ── GET /api/debug/status ────────────────────────────────────────────────────
  r.get('/status', (_req, res) => {
    // Cache-trace availability (used by Context Breakdown)
    const cacheTraceAvailable = fs.existsSync(CACHE_TRACE_PATH);
    let cacheTraceSize = 0;
    let cacheTraceEntryCount = 0;
    if (cacheTraceAvailable) {
      try {
        cacheTraceSize = fs.statSync(CACHE_TRACE_PATH).size;
        cacheTraceEntryCount = fs.readFileSync(CACHE_TRACE_PATH, 'utf8').split('\n').filter(l => l.trim()).length;
      } catch { /* ignore */ }
    }

    res.json({
      cacheTraceAvailable,
      cacheTracePath: CACHE_TRACE_PATH,
      cacheTraceSize,
      cacheTraceEntryCount,
      memoryEmbeddingsAvailable: false,
    });
  });

  // ── GET /api/debug/sessions ──────────────────────────────────────────────────
  r.get('/sessions', (_req, res) => {
    const { available, turns } = readCacheTrace();
    if (!available) { res.json({ available: false, sessions: [] }); return; }

    const sessionMap = new Map<string, { count: number; minTs: string; maxTs: string; models: Map<string, number> }>();
    for (const t of turns) {
      const sid = t.sessionId;
      if (!sid) continue;
      const existing = sessionMap.get(sid);
      if (!existing) {
        sessionMap.set(sid, { count: 1, minTs: t.ts, maxTs: t.ts, models: new Map([[t.modelId, 1]]) });
      } else {
        existing.count++;
        if (t.ts < existing.minTs) existing.minTs = t.ts;
        if (t.ts > existing.maxTs) existing.maxTs = t.ts;
        existing.models.set(t.modelId, (existing.models.get(t.modelId) || 0) + 1);
      }
    }

    const sessions = Array.from(sessionMap.entries()).map(([id, v]) => {
      let topModel = '';
      let topCount = 0;
      for (const [m, c] of v.models) { if (c > topCount) { topModel = m; topCount = c; } }
      const costRow = db.prepare(
        `SELECT COALESCE(SUM(cost_total), 0) as total_cost FROM messages WHERE session_id = ? AND role = 'assistant' AND model NOT IN ('delivery-mirror', 'gateway-injected')`
      ).get(id) as { total_cost: number };
      const agentRow = db.prepare(
        `SELECT agent_name FROM sessions WHERE id = ?`
      ).get(id) as { agent_name: string } | undefined;
      return {
        id,
        agent_name: agentRow?.agent_name ?? '',
        entry_count: v.count,
        min_ts: v.minTs,
        max_ts: v.maxTs,
        model: topModel,
        total_cost: parseFloat((costRow?.total_cost ?? 0).toFixed(4)),
      };
    }).sort((a, b) => b.max_ts.localeCompare(a.max_ts));

    res.json({ available: true, sessions });
  });

  // ── GET /api/debug/session/:id/cache-replay ──────────────────────────────────
  r.get('/session/:id/cache-replay', (req, res) => {
    const sid = req.params.id;
    const result = readCacheTraceAllStages(sid);
    res.json(result);
  });

  // ── GET /api/debug/session/:id/context-window ─────────────────────────────────
  r.get('/session/:id/context-window', (req, res) => {
    const { available, turns: allTurns } = readCacheTrace();
    if (!available) { res.json({ available: false, turns: [] }); return; }

    const sid = req.params.id;
    const sessionTurns = allTurns.filter(t => t.sessionId === sid);
    // Already sorted by ts from readCacheTrace()

    // Fetch DB assistant messages for actual token/cost data, matched by timestamp
    interface DbMsg {
      timestamp: number;
      input_tokens: number;
      output_tokens: number;
      cache_read: number;
      cache_write: number;
      cost_total: number;
    }
    const dbMessages = db.prepare(`
      SELECT timestamp, input_tokens, output_tokens, cache_read, cache_write, cost_total
      FROM messages WHERE session_id = ? AND role = 'assistant'
      ORDER BY timestamp ASC
    `).all(sid) as DbMsg[];

    const turns = sessionTurns.map((t, idx) => {
      // System tokens from session:loaded
      const sysText = t.loaded.system ?? '';
      const system_tokens = estimateTokens(sysText);

      // History + tool tokens from the first stream:context messages
      let history_tokens = 0;
      let tool_result_tokens = 0;
      const msgs = t.firstCtx?.messages ?? t.loaded.messages ?? [];
      for (const msg of msgs) {
        const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        const est = estimateTokens(contentStr);
        if (msg.role === 'toolResult') tool_result_tokens += est;
        else history_tokens += est;
      }

      // Context window size from model options; fall back to 200K
      const total_capacity = t.firstCtx?.options?.model?.contextWindow ?? 200_000;

      // Match DB message by timestamp: find the assistant message closest to this turn's ts.
      // Cache-trace ts is ISO string; DB timestamp is ms epoch.
      const turnTsMs = new Date(t.ts).getTime();
      let dbMsg: DbMsg | null = null;
      let bestDiff = Infinity;
      for (const m of dbMessages) {
        const diff = Math.abs(m.timestamp - turnTsMs);
        if (diff < bestDiff) { bestDiff = diff; dbMsg = m; }
      }

      // Total context = input (non-cached) + cache_read + cache_write — all tokens in the prompt
      const ctx_input  = dbMsg?.input_tokens  ?? 0;
      const ctx_cr     = dbMsg?.cache_read    ?? 0;
      const ctx_cw     = dbMsg?.cache_write   ?? 0;
      const total_used = dbMsg
        ? ctx_input + ctx_cr + ctx_cw
        : system_tokens + history_tokens + tool_result_tokens;

      return {
        seq: idx + 1,
        ts: t.ts,
        system_tokens,
        history_tokens,
        tool_result_tokens,
        total_used,
        total_capacity,
        fill_pct: parseFloat((total_used / total_capacity).toFixed(5)),
        input_tokens:       ctx_input,
        output_tokens:      dbMsg?.output_tokens ?? null,
        cache_read_tokens:  ctx_cr,
        cache_write_tokens: ctx_cw,
        cost_input:       null as number | null,
        cost_output:      null as number | null,
        cost_cache_read:  null as number | null,
        cost_cache_write: null as number | null,
        cost:             dbMsg?.cost_total ?? null,
      };
    });

    res.json({ available: true, turns });
  });

  // ── GET /api/debug/session/:id/timeline ──────────────────────────────────────
  r.get('/session/:id/timeline', (req, res) => {
    const sid = req.params.id;

    // Idle gaps > this threshold are compressed down to IDLE_DISPLAY_MS.
    // This prevents a 22-hour session with 36min of real work from making
    // every tool bar invisible.
    const IDLE_THRESHOLD_MS = 300_000; // 5 min — gaps longer than this are compressed
    const IDLE_DISPLAY_MS   = 1_000;   // display each gap as 1 s
    const MAX_TOOL_DUR_MS   = 600_000;  // cap individual tool duration at 10 min (display safety only)

    interface MsgRow {
      id: string;
      timestamp: number;
      role: string;
      input_tokens: number;
      output_tokens: number;
      cache_read: number;
      cache_write: number;
      cost_total: number;
      stop_reason: string | null;
      error_message: string | null;
    }
    interface TcRow {
      id: string;
      message_id: string;
      timestamp: number;
      tool_name: string;
      duration_ms: number | null;
      success: number;
      arguments: string | null;
      raw_input: string | null;
      raw_output: string | null;
      extra_json: string | null;
      risk_flags: string | null;
      risk_score: number | null;
      target: string | null;
      event_type: string | null;
    }

    const allMsgs = db.prepare(`
      SELECT id, timestamp, role, input_tokens, output_tokens, cache_read, cache_write, cost_total, stop_reason, error_message
      FROM messages WHERE session_id = ? ORDER BY timestamp ASC
    `).all(sid) as MsgRow[];

    // Query tool_calls and audit_events separately, then merge by closest timestamp
    // (timestamps between the two tables can differ by several seconds)
    interface TcRaw {
      id: string; message_id: string; timestamp: number; tool_name: string;
      duration_ms: number | null; success: number; arguments: string | null;
    }
    interface AeRow {
      tool_name: string; timestamp: number;
      raw_input: string | null; raw_output: string | null;
      extra_json: string | null; risk_flags: string | null;
      risk_score: number | null; target: string | null; event_type: string | null;
    }

    const rawTcs = db.prepare(`
      SELECT id, message_id, timestamp, tool_name, duration_ms, success, arguments
      FROM tool_calls WHERE session_id = ? ORDER BY timestamp ASC
    `).all(sid) as TcRaw[];

    const auditEvents = db.prepare(`
      SELECT tool_name, timestamp, raw_input, raw_output, extra_json, risk_flags, risk_score, target, event_type
      FROM audit_events WHERE session_id = ? ORDER BY timestamp ASC
    `).all(sid) as AeRow[];

    // Build a map: for each tool_name, list of audit events sorted by timestamp
    const aeByTool = new Map<string, AeRow[]>();
    for (const ae of auditEvents) {
      if (!aeByTool.has(ae.tool_name)) aeByTool.set(ae.tool_name, []);
      aeByTool.get(ae.tool_name)!.push(ae);
    }

    // Match each tool_call to the closest audit_event (same tool_name, within 30s)
    const usedAe = new Set<AeRow>();
    const allTcs: TcRow[] = rawTcs.map(tc => {
      const candidates = aeByTool.get(tc.tool_name) ?? [];
      let best: AeRow | null = null;
      let bestDiff = Infinity;
      for (const ae of candidates) {
        if (usedAe.has(ae)) continue;
        const diff = Math.abs(ae.timestamp - tc.timestamp);
        const TIMESTAMP_MATCH_THRESHOLD_MS = 30_000;
        if (diff < bestDiff && diff < TIMESTAMP_MATCH_THRESHOLD_MS) { best = ae; bestDiff = diff; }
      }
      if (best) usedAe.add(best);
      return {
        ...tc,
        raw_input:  best?.raw_input  ?? null,
        raw_output: best?.raw_output ?? null,
        extra_json: best?.extra_json ?? null,
        risk_flags: best?.risk_flags ?? null,
        risk_score: best?.risk_score ?? null,
        target:     best?.target     ?? null,
        event_type: best?.event_type ?? null,
      };
    });

    if (allMsgs.length === 0) {
      res.json({ available: false, turns: [], tool_names: [], duration_ms: 0,
                 wall_duration_ms: 0, idle_gaps_compressed: 0, session_start: 0 });
      return;
    }

    const sessionStart = allMsgs[0].timestamp;

    // ── Build idle-gap compression map ────────────────────────────────────────
    // For each wall-clock timestamp, cTs() returns the compressed equivalent.
    // We use BOTH message timestamps and tool call timestamps to distinguish
    // real tool execution time from idle gaps (user paused, session resumed).
    const allTimestamps = [
      ...allMsgs.map(m => m.timestamp),
      ...allTcs.map(tc => tc.timestamp),
      ...allTcs.filter(tc => tc.duration_ms).map(tc => tc.timestamp + (tc.duration_ms ?? 0)),
    ].sort((a, b) => a - b);
    // Deduplicate nearby timestamps (within 10ms)
    const dedupedTs: number[] = [];
    for (const ts of allTimestamps) {
      if (dedupedTs.length === 0 || ts - dedupedTs[dedupedTs.length - 1] > 10) {
        dedupedTs.push(ts);
      }
    }
    interface GapInfo { after_ts: number; savings_ms: number }
    const gaps: GapInfo[] = [];
    for (let i = 0; i < dedupedTs.length - 1; i++) {
      const gap = dedupedTs[i + 1] - dedupedTs[i];
      if (gap > IDLE_THRESHOLD_MS) {
        gaps.push({ after_ts: dedupedTs[i], savings_ms: gap - IDLE_DISPLAY_MS });
      }
    }

    function cTs(ts: number): number {
      let savings = 0;
      for (const g of gaps) { if (ts > g.after_ts) savings += g.savings_ms; }
      return (ts - sessionStart) - savings;
    }

    // ── Group tool calls by message_id ─────────────────────────────────────────
    const tcByMsg = new Map<string, TcRow[]>();
    for (const tc of allTcs) {
      if (!tcByMsg.has(tc.message_id)) tcByMsg.set(tc.message_id, []);
      tcByMsg.get(tc.message_id)!.push(tc);
    }

    // ── Build turns (one per assistant message) ────────────────────────────────
    const assistantMsgs = allMsgs.filter(m => m.role === 'assistant');
    const turns = assistantMsgs.map((msg, i) => {
      const msgIdx = allMsgs.findIndex(m => m.id === msg.id);
      const prevMsg = msgIdx > 0 ? allMsgs[msgIdx - 1] : null;

      const llmStartTs  = prevMsg ? prevMsg.timestamp : sessionStart;
      const llmMs       = Math.max(0, Math.min(msg.timestamp - llmStartTs, IDLE_THRESHOLD_MS));

      const tools = tcByMsg.get(msg.id) ?? [];

      // ── Per-tool duration with parallel detection ──
      // Each tool now has its own wall timestamp and individual duration_ms from the parser.
      // Detect parallel: if tool wall timestamps are within 200ms of each other, they ran in parallel.
      const cMsgStart = cTs(msg.timestamp); // compressed start of tool block

      // Sort tools by wall timestamp to detect parallelism
      const sortedTools = [...tools].sort((a, b) => a.timestamp - b.timestamp);

      // Group into parallel "lanes": tools that overlap in time run in parallel
      interface ToolLane { tc: TcRow; wallStart: number; wallEnd: number; lane: number }
      const lanes: ToolLane[] = [];
      for (const tc of sortedTools) {
        const dur = Math.min(tc.duration_ms ?? 0, MAX_TOOL_DUR_MS);
        const wallStart = tc.timestamp;
        const wallEnd = wallStart + dur;

        // Find the first lane where this tool doesn't overlap
        let lane = 0;
        while (lanes.some(l => l.lane === lane && wallStart < l.wallEnd && wallEnd > l.wallStart)) {
          lane++;
        }
        lanes.push({ tc, wallStart, wallEnd, lane });
      }

      // Compute compressed start for each tool relative to the tool block start
      const toolBlockWallStart = sortedTools.length > 0 ? sortedTools[0].timestamp : msg.timestamp;
      const totalLanes = lanes.length > 0 ? Math.max(...lanes.map(l => l.lane)) + 1 : 0;

      const toolSlices = lanes.map(({ tc, wallStart, lane }) => {
        const durMs = Math.min(tc.duration_ms ?? 0, MAX_TOOL_DUR_MS);
        const offsetFromBlockStart = Math.max(0, wallStart - toolBlockWallStart);
        // Compress the offset (cap at idle threshold)
        const compressedOffset = Math.min(offsetFromBlockStart, IDLE_THRESHOLD_MS);

        return {
          id: tc.id,
          tool_name: tc.tool_name,
          start_ms: cMsgStart + compressedOffset,      // compressed coordinates
          wall_start_ms: tc.timestamp - sessionStart,
          duration_ms: Math.max(durMs, 100),             // min 100 ms so bar is visible
          success: Boolean(tc.success),
          lane,                                           // for vertical stacking in Gantt
          total_lanes: totalLanes,
          arguments:  tc.arguments  ?? null,
          raw_input:  tc.raw_input  ?? null,
          raw_output: tc.raw_output ?? null,
          extra_json: tc.extra_json ?? null,
          risk_flags: tc.risk_flags ?? null,
          risk_score: tc.risk_score ?? null,
          target:     tc.target     ?? null,
          event_type: tc.event_type ?? null,
        };
      });

      const cStart  = cTs(llmStartTs);
      const toolsEnd = toolSlices.length > 0
        ? Math.max(...toolSlices.map(t => t.start_ms + t.duration_ms))
        : cMsgStart;
      const nextAssistant = assistantMsgs[i + 1];
      const cEnd = nextAssistant
        ? Math.max(toolsEnd, cTs(nextAssistant.timestamp))
        : Math.max(toolsEnd, cMsgStart + Math.max(llmMs, 500));

      // Parallel-aware tool time: max(end) - min(start), not sum(duration)
      let toolTimeMs = 0;
      if (sortedTools.length > 0) {
        const wallMin = Math.min(...lanes.map(l => l.wallStart));
        const wallMax = Math.max(...lanes.map(l => l.wallEnd));
        toolTimeMs = Math.min(wallMax - wallMin, MAX_TOOL_DUR_MS);
      }

      // Find the preceding user message for context
      const userMsg = prevMsg && prevMsg.role === 'user' ? prevMsg : null;

      return {
        seq: i + 1,
        message_id:    msg.id,        // assistant message ID — for content lookup
        user_message_id: userMsg?.id ?? null,  // preceding user message ID
        start_ms:      cStart,       // compressed — used by Gantt
        end_ms:        cEnd,
        wall_start_ms: llmStartTs - sessionStart,   // wall-clock — used by table
        llm_ms:        Math.max(0, cTs(msg.timestamp) - cStart),
        tool_time_ms:  toolTimeMs,    // parallel-aware: wall-clock span of tool execution
        input_tokens:  msg.input_tokens,
        output_tokens: msg.output_tokens,
        cache_read:    msg.cache_read,
        cache_write:   msg.cache_write,
        cost:          msg.cost_total,
        stop_reason:   msg.stop_reason,
        error_message: msg.error_message,
        tool_calls:    toolSlices,
      };
    });

    const wallDurationMs = allMsgs[allMsgs.length - 1].timestamp - sessionStart;
    const activeDurationMs = turns.length > 0 ? Math.max(...turns.map(t => t.end_ms)) : 0;
    const tool_names = [...new Set(allTcs.map(tc => tc.tool_name))].sort();

    res.json({
      available:             true,
      session_id:            sid,
      session_start:         sessionStart,
      duration_ms:           activeDurationMs,   // compressed — Gantt uses this
      wall_duration_ms:      wallDurationMs,      // real wall clock
      idle_gaps_compressed:  gaps.length,
      turn_count:            turns.length,
      tool_count:            allTcs.length,
      turns,
      tool_names,
    });
  });

  return r;
}
