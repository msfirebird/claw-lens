# claw-lens

Observability devtool for [OpenClaw](https://openclaw.ai) agents. Trace what your AI is doing, debug why it costs that much.

```bash
npx claw-lens
```

Opens a local dashboard at `http://localhost:4242` for cost monitoring, behavior tracing, and security audit.

## Install & Use

```bash
# Run directly (no install needed)
npx claw-lens

# Or install globally
npm install -g claw-lens
claw-lens

# Options
claw-lens --port 3000      # custom port (default: 4242)
claw-lens --no-open        # don't auto-open browser
```

Requires Node.js 18+.

## Development

```bash
# 1. Clone the repo
git clone https://github.com/msfirebird/claw-lens.git
cd claw-lens

# 2. Install dependencies (backend + frontend)
npm install
cd src/ui && npm install && cd ../..

# 3. Start dev server (with hot reload)
npm run dev

# Custom port
PORT=3000 npm run dev
```

This runs the backend (Express + ts-node-dev) and frontend (React + Vite) concurrently. Code changes auto-restart/refresh.

## Production Build (from source)

```bash
# Build
npm run build

# Start
npm start

# Custom port
npm start -- --port 3000
npm start -- --no-open
```

Compiles TypeScript to `dist/`, then runs the compiled server.

## License

[MIT](./LICENSE)
