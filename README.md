[English](./README.md) | [中文](./README.zh.md)

# claw-lens

[![npm version](https://img.shields.io/npm/v/claw-lens)](https://www.npmjs.com/package/claw-lens)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org)

**Local observability dashboard for [OpenClaw](https://openclaw.ai) agents.** See what your AI agents actually cost, what they do, and what they touch — in one place, on your machine.

---

## Philosophy

Traditional observability tools assume that the person writing the code, reading the logs, and fixing the bug are the same person. AI agents broke that assumption. The people deploying agents today — founders, analysts, operators — are not the people who built Datadog or Honeycomb, and those tools were never designed to serve them.

claw-lens is built for this new reality. Cost, not latency, is the dominant signal. The atomic unit is a session, not a request. And the errors that matter most — an agent reading files it shouldn't, leaking a credential, executing injected instructions — never throw exceptions. You need a tool that shows the real shape of these systems, built for people who are learning to read it.

→ [claw-lens.com/engineering/agent-observability](https://claw-lens.com/engineering/agent-observability)

---

## Screenshot

![Overview KPI](./assets/screenshots/overview-kpi.png)
![Agent](./assets/screenshots/agent.png)
![Model](./assets/screenshots/model.png)
![Sessions](./assets/screenshots/sessions.png)
![Cron Call](./assets/screenshots/cron-call.png)
![Live](./assets/screenshots/live.png)
![Activities](./assets/screenshots/activities.png)

---

## Features

- **Overview** — KPI strip (cost today, tokens, sessions, errors, cache efficiency), 7-day trend, week-over-week delta, model cost breakdown, active agent list
- **Token Usage** — 4-dimension cost breakdown (input, output, cache read, cache write) by agent, model, and time period; cache hit rate; cron vs. manual comparison
- **Agents** — per-agent statistics, cost, session count, and agent memory files
- **Live Monitor** — real-time agent activity feed via WebSocket proxy to the OpenClaw Gateway
- **Sessions** — session table with filters by agent, model, date, cost; context health indicator; full tool call trace per session
- **Cron** — scheduled task list, run history, status, and cost tracking
- **Memory** — agent workspace and memory file viewer across all agents
- **Audit** — security event timeline with rule-based risk scoring (high/medium/low) for file access, shell commands, external HTTP calls, sensitive data exposure (34 regex patterns), prompt injection detection (9 patterns), and per-agent behavioral anomaly detection over 30-day baselines
- **Session Timeline** — turn-by-turn message trace with token counts, stop reasons, and tool call details
- **Profiler** — session rankings by token consumption and tool timing analysis
- **Deep Turns** — detects deep turn sequences with repetitive tool patterns, unique-ratio scoring, and per-agent breakdown
- **Context Breakdown** — per-turn context window fill visualization with system/history/tool-result token splits and model-accurate capacity gauge
- **Cache Trace** — step-through replay of OpenClaw's cache trace logs, showing stage progression, digest changes, and model config
- **Share Snapshot** — capture any page as a watermarked PNG image for sharing in chat threads or docs
- **i18n** — English and Chinese interface
- **All data stays local** — reads from OpenClaw's JSONL logs on disk, no data sent to any external server

For detailed per-page, per-tab documentation: **[claw-lens.com/monitoring/overview](https://claw-lens.com/monitoring/overview)**

---

## Quick Start

```bash
npx claw-lens
```

Opens `http://localhost:4242`. No account, no config, no data upload.

```bash
npm install -g claw-lens   # or install globally
claw-lens --port 3000      # custom port (default: 4242)
claw-lens --no-open        # suppress auto-open browser
```

Requires Node.js 18+. `OPENCLAW_HOME` env var overrides the default `~/.openclaw` data directory.

For more CLI options, see [claw-lens.com/reference/cli](https://claw-lens.com/reference/cli).

### For Developers

```bash
git clone https://github.com/msfirebird/claw-lens.git
cd claw-lens
npm install
cd src/ui && npm install && cd ../..
npm run dev
```

Runs backend (Express + ts-node-dev, port 4242) and frontend (React + Vite, port 6060) concurrently with hot reload. Changes to `src/server/` or `src/ui/` apply instantly.

```bash
npm run build && npm start   # production build
```

→ [claw-lens.com/development](https://claw-lens.com/development)

---

## Architecture

claw-lens runs entirely on your machine. It reads the files OpenClaw already writes to disk — session JSONL, cache traces, cron configs, agent memory — parses session logs into SQLite, and serves everything through an Express API to a React frontend. No external services, no deployment, no configuration files.

Four principles shape the architecture:

- **Zero configuration** — `npx claw-lens` auto-creates the schema, ingests all session data, and opens the browser. The only prerequisite is Node.js.
- **Cost first** — USD cost is the primary signal, visible per-session, per-model, and per-agent. Token breakdowns are one layer deeper for when users need them.
- **Local and read-only** — the server binds to `127.0.0.1`, makes no outbound calls, and never modifies agent files. The only file claw-lens writes is its own SQLite database.
- **Rule-based security audit** — every tool call is risk-scored at ingestion time with deterministic rules, not ML. Per-agent behavioral baselines detect anomalies. The rules are transparent — read the code and know exactly why something was flagged.

Full design doc with data model, technical choices, and trade-offs: **[claw-lens.com/engineering/design-doc](https://claw-lens.com/engineering/design-doc)**

---

## Data Sources

claw-lens reads directly from the local OpenClaw data directory (`~/.openclaw/` by default):

| Path | Content |
|------|---------|
| `agents/*/sessions/*.jsonl` | Session logs (including `.deleted` and `.reset` suffixed files) |
| `logs/cache-trace.jsonl` | Cache trace for replay and context breakdown *(note: cache trace requires to be enabled in OpenClaw — [how to enable](https://claw-lens.com/reference/data-retention#cache-trace-retention))* |
| `cron/` | Cron job definitions and state |
| `workspace-*/`, `agents/*/workspace/` | Agent memory and workspace files |
| `openclaw.json` | Gateway auth token for live WebSocket connection |

claw-lens writes only one file: `~/.openclaw/claw-lens.db` (SQLite).

---

> **All data stays local.** claw-lens binds to `127.0.0.1`, restricts CORS to localhost, makes no outbound HTTP calls, and sends no telemetry. The only network connection is the WebSocket to your local OpenClaw Gateway. Nothing leaves your machine.

---

## License

[MIT](./LICENSE)
