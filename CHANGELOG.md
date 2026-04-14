# Changelog

## v0.1.0

Initial release. claw-lens combines observability, analytics, and developer tooling for OpenClaw agents — cost tracking, session inspection, profiler, cache trace, and security audit in one local dashboard at `http://localhost:4242`.

**Pages**

- **Overview** — KPI strip (cost today, tokens, sessions, errors, cache efficiency), 7-day trend, week-over-week delta, model cost breakdown, active agent list
- **Token Usage** — 4-dimension cost breakdown (input, output, cache read, cache write) by agent, model, and time period; cache hit rate; cron vs. manual comparison
- **Agents** — per-agent statistics, cost, session count, and memory file viewer
- **Sessions** — session table with filters by agent, model, date, cost; context health indicator; full tool call trace per session
- **Session Timeline** — turn-by-turn message trace with token counts, stop reasons, and tool call details
- **Context Breakdown** — per-turn context window fill visualization with system/history/tool-result token splits and model-accurate capacity gauge
- **Profiler** — session rankings by token consumption and tool timing analysis
- **Deep Turns** — detects deep turn sequences with repetitive tool patterns, unique-ratio scoring, and per-agent breakdown
- **Cache Trace** — step-through replay of OpenClaw's cache trace logs, showing stage progression, digest changes, and model config
- **Cron** — scheduled task list, run history, status, and cost tracking
- **Memory** — agent workspace and memory file viewer across all agents
- **Live Monitor** — real-time agent activity feed via WebSocket proxy to OpenClaw Gateway
- **Audit** — security event timeline with rule-based risk scoring (high/medium/low) for file access, shell commands, external HTTP calls, sensitive data exposure (34 regex patterns), prompt injection detection (9 patterns), and per-agent behavioral anomaly detection over 30-day baselines

**Other**

- CLI flags: `--port`, `--no-open`
- English and Chinese interface (i18n)
- All data stays local — no telemetry, no external calls

🦞 Easter egg: meet your new pet. Go to Settings to adopt a claw.
