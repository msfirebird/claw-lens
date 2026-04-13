# claw-lens

[![npm version](https://img.shields.io/npm/v/claw-lens)](https://www.npmjs.com/package/claw-lens)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org)

Observability devtool for [OpenClaw](https://openclaw.ai) agents. See what your AI is actually doing — cost, behavior, and security in one local dashboard.

---

## Why Agent Observability Matters

AI agents are no longer just an engineer's tool. But the moment you put real autonomy in a system — real tool calls, real cost, real decisions — you need to see inside it. Not metaphors for it. The actual sessions, tokens, tool calls, and context windows. The real numbers, because users will learn from them.

Lens is built on one bet: the people worth building for will grow into tools that are worth using. We show the real shape of the system, not a simplified version of it.

→ Full philosophy: [clawlens.dev/docs/observability](https://clawlens.dev/docs/observability)

---

## Quick Start

```bash
npx claw-lens
```

Opens a local dashboard at `http://localhost:4242`. No account, no upload, no config needed.

```bash
npm install -g claw-lens   # or install globally
claw-lens --port 3000      # custom port (default: 4242)
claw-lens --no-open        # don't auto-open browser
```

Requires Node.js 18+.

---

## Pages

| Page | What it does |
|------|-------------|
| **Overview** | KPI summary — cost, tokens, sessions, active agents |
| **Sessions** | Full session list with cost, model, duration, tool call count |
| **Session Timeline** | Per-session turn-by-turn trace |
| **Token Usage** | Cost breakdown by agent, model, and time |
| **Live Monitor** | Real-time agent activity feed |
| **Audit** | Data access trail, external calls, sensitive data flags |
| **Agent Loops** | Detect runaway or repetitive agent behavior |
| **Cron** | Scheduled task history and status |
| **Memory** | Memory read/write trace per session |
| **Profiler** | Latency and performance breakdown |
| **Debug / Replay** | Step through a past session turn by turn |
| **Settings** | Configure data paths and display options |

For detailed per-page, per-tab, and per-feature documentation: **[clawlens.dev/docs](https://clawlens.dev/docs)**

---

## Features

- Cost monitoring with 4-dimension breakdown: input, output, cache read, cache write
- Session browser with full tool call trace
- Live real-time agent activity monitor
- Security audit: external HTTP calls, sensitive data detection, risk scoring
- Agent loop detection (runaway / repetitive behavior)
- Cron job history and status tracking
- Memory trace per session
- Session replay for debugging
- 40+ model context-limit catalog for accurate context window gauges
- All data stays local — reads directly from OpenClaw's JSONL logs

---

## Design Doc

Architecture, data model, engineering decisions, and the reasoning behind them:
**[clawlens.dev/design-doc](https://clawlens.dev/design-doc)**

---

## Data Sources

Lens reads directly from OpenClaw's local log files — no server, no sync:

- `~/.openclaw/logs/*.jsonl` — session and event logs
- `~/.openclaw/config.yml` — agent and cron configuration

---

> **All data stays local.** Nothing leaves your machine.

---

## Development

```bash
git clone https://github.com/youruyi/claw-lens.git
cd claw-lens
npm install
cd src/ui && npm install && cd ../..
npm run dev
```

Runs backend (Express + ts-node-dev) and frontend (React + Vite) concurrently with hot reload.

```bash
PORT=3000 npm run dev   # custom port
```

**Production build:**

```bash
npm run build
npm start
```

---

## License

[MIT](./LICENSE)
