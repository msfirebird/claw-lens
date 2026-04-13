import React, { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Plays a two-tone chime when the connected agent goes idle —
 * i.e. when no `data_updated` WebSocket event has been received for
 * IDLE_THRESHOLD_MS after a period of activity.
 *
 * This covers two "human in the loop" scenarios:
 *   1. Agent paused waiting for tool approval (writes stop → chime)
 *   2. Agent finished its task (writes stop → chime)
 */
const IDLE_THRESHOLD_MS = 8_000;
const MIN_CHIME_INTERVAL_MS = 4_000;

export function useHumanInLoopNotifier() {
  useEffect(() => {

    let stopped = false;
    let hadActivity = false;
    let lastChimeAt = 0;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let audioCtx: AudioContext | null = null;

    function getCtx(): AudioContext | null {
      try {
        if (!audioCtx) {
          const Ctor =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext;
          if (!Ctor) return null;
          audioCtx = new Ctor();
        }
        // Resume in case browser suspended it before first interaction
        if (audioCtx.state === 'suspended') audioCtx.resume();
        return audioCtx;
      } catch {
        return null;
      }
    }

    function tone(
      ctx: AudioContext,
      freq: number,
      offsetSec: number,
      durSec: number,
      vol = 0.22,
    ) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = ctx.currentTime + offsetSec;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(vol, t + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.001, t + durSec);
      osc.start(t);
      osc.stop(t + durSec + 0.02);
    }

    function playChime() {
      const ctx = getCtx();
      if (!ctx) return;
      // Ascending two-note: C5 → G5
      tone(ctx, 523.25, 0,    0.22);
      tone(ctx, 783.99, 0.20, 0.28, 0.18);
    }

    function onActivity() {
      hadActivity = true;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (stopped || !hadActivity) return;
        const now = Date.now();
        // Guard: don't double-chime within 4 s
        if (now - lastChimeAt > MIN_CHIME_INTERVAL_MS) {
          playChime();
          lastChimeAt = now;
        }
        hadActivity = false;
      }, IDLE_THRESHOLD_MS);
    }

    function connect() {
      if (stopped) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${window.location.host}/ws/live`);

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string) as { type?: string };
          if (msg.type === 'data_updated') onActivity();
        } catch { /* ignore */ }
      };

      ws.onclose = () => { if (!stopped) setTimeout(connect, 3_000); };
      ws.onerror = () => {};
    }

    connect();

    return () => {
      stopped = true;
      if (idleTimer) clearTimeout(idleTimer);
      audioCtx?.close().catch(() => {});
    };
  }, []);
}

const AUTO_REFRESH_MS = 30_000; // auto-refresh every 30s

export function useFetch<T>(url: string, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const prevUrlRef = useRef<string>(url);

  const refresh = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    const urlChanged = url !== prevUrlRef.current;
    prevUrlRef.current = url;

    if (!url) { setLoading(false); if (urlChanged) setData(null); return; }
    let cancelled = false;
    // Clear stale data immediately on URL change so the old session doesn't bleed through
    if (urlChanged) { setData(null); setLoading(true); setError(null); }
    else { setLoading(data === null); }
    fetch(url)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(d => { if (!cancelled) { setData(d); setError(null); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, tick, ...deps]);

  // Auto-refresh
  useEffect(() => {
    if (!url) return;
    const id = setInterval(() => setTick(t => t + 1), AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [url]);

  return { data, loading, error, refresh };
}

/** Precise 4dp for per-message / per-turn detail */
export function fmtCost(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n === 0) return '$0.0000';
  return `$${n.toFixed(4)}`;
}

/** Compact 2dp for KPI cards & summaries */
export function fmtCostKpi(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** Precise 4dp for tables */
export function fmt$$(n: number | null | undefined): string {
  if (n == null) return '—';
  return `$${n.toFixed(4)}`;
}

export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function fmtMs(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 3_600_000) return `${(n / 3_600_000).toFixed(1)}h`;
  if (n >= 60000) return `${(n / 60000).toFixed(1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.round(n)}ms`;
}



export function fmtDatetime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

/* ── Shared types ── */

export interface SessionSummary {
  id: string;
  agent_name: string;
  entry_count: number;
  min_ts: string;
  max_ts: string;
  model: string;
  total_cost: number;
}

export interface SessionsData {
  available: boolean;
  sessions: SessionSummary[];
}

/* ── Shared formatting ── */

export function fmtPct(n: number | null | undefined, decimals = 1): string {
  if (n == null || isNaN(n)) return '—';
  return `${(n * 100).toFixed(decimals)}%`;
}

export function fmtTs(input: number | string, opts?: { seconds?: boolean }): string {
  const d = new Date(input);
  const now = new Date();
  const isMs = typeof input === 'number';

  if (isMs) {
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  const sameYear = d.getFullYear() === now.getFullYear();
  const dateStr = sameYear
    ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const timeOpts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
  if (opts?.seconds) timeOpts.second = '2-digit';
  return `${dateStr} ${d.toLocaleTimeString('en-US', timeOpts)}`;
}

/* ── Shared styles ── */


export const tipBadge: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  marginLeft: 3, width: 13, height: 13, borderRadius: '50%',
  background: 'rgba(255,255,255,0.1)', fontSize: 9, color: '#aaa', fontWeight: 400, verticalAlign: 'middle',
};

export const tipBox: React.CSSProperties = {
  display: 'none', position: 'absolute', left: 0, top: '100%', marginTop: 6,
  padding: '10px 12px', borderRadius: 8, background: '#1a1a1a', border: '1px solid #333',
  fontSize: 11, lineHeight: 1.5, color: '#ccc', fontWeight: 400, textAlign: 'left',
  zIndex: 100, whiteSpace: 'pre-line', boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
  textTransform: 'none' as const, letterSpacing: 'normal',
};

export const TABLE_STYLE: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 13,
  fontVariantNumeric: 'tabular-nums',
};

export const TH_STYLE: React.CSSProperties = {
  textAlign: 'left',
  padding: 'var(--space-2) var(--space-3)',
  borderBottom: '1px solid var(--border)',
  color: 'var(--muted)',
  fontSize: 12,
  fontWeight: 500,
};

export const TD_STYLE: React.CSSProperties = {
  padding: 'var(--space-2) var(--space-3)',
  borderBottom: '1px solid var(--border)',
  color: 'var(--text)',
};

export const MONO_STYLE: React.CSSProperties = { fontFamily: 'var(--font-m)', fontSize: 12 };

// Design-spec data palette — blue leads
export const COLORS = [
  '#60a5fa',  // blue   — primary
  '#22d3ee',  // cyan   — secondary
  '#34d399',  // emerald
  '#a78bfa',  // violet
  '#fbbf24',  // amber
  '#f472b6',  // pink
  '#fb923c',  // orange
  '#f87171',  // red    — anomaly/error only
];
