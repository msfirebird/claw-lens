import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { glob } from 'glob';
import Database from 'better-sqlite3';
import { ingestAll } from '../db';
import { listRegisteredAgents } from '../paths';

const DEFAULT_GATEWAY_PORT = 18789;
const MAX_RECONNECT_BACKOFF_MS = 30_000;
const INGEST_DEBOUNCE_MS = 500;

function getGatewayToken(): string | null {
  try {
    const cfgPath = path.join(
      process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw'),
      'openclaw.json'
    );
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    return cfg?.gateway?.auth?.token ?? null;
  } catch {
    return null;
  }
}

function getGatewayPort(): number {
  try {
    const cfgPath = path.join(
      process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw'),
      'openclaw.json'
    );
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    return cfg?.gateway?.port ?? DEFAULT_GATEWAY_PORT;
  } catch {
    return DEFAULT_GATEWAY_PORT;
  }
}

export interface MemoryFileEntry {
  name: string;
  relPath: string;
  absPath: string;
  content: string;
  mtime: number;
  source: 'user-defined' | 'agent-generated';
}

const USER_DEFINED_FILES = new Set(['SOUL.md', 'USER.md', 'AGENTS.md', 'TOOLS.md', 'IDENTITY.md', 'HEARTBEAT.md']);

function fileSource(relPath: string): 'user-defined' | 'agent-generated' {
  const name = path.basename(relPath);
  if (relPath.startsWith('memory/') || relPath.startsWith('memory\\')) return 'agent-generated';
  if (USER_DEFINED_FILES.has(name)) return 'user-defined';
  if (name === 'MEMORY.md') return 'agent-generated';
  return 'user-defined';
}

function readFilesFromDir(wsDir: string, agentName: string, result: Record<string, MemoryFileEntry[]>) {
  result[agentName] = result[agentName] || [];
  const existing = new Set(result[agentName].map(f => f.relPath));

  // Root-level known files
  const rootFiles = ['MEMORY.md', 'SOUL.md', 'USER.md', 'AGENTS.md', 'TOOLS.md', 'IDENTITY.md', 'HEARTBEAT.md'];
  for (const fname of rootFiles) {
    if (existing.has(fname)) continue;
    try {
      const absPath = path.join(wsDir, fname);
      const stat = fs.statSync(absPath);
      const content = fs.readFileSync(absPath, 'utf-8');
      result[agentName].push({ name: fname, relPath: fname, absPath, content, mtime: stat.mtimeMs, source: fileSource(fname) });
      existing.add(fname);
    } catch { /* skip */ }
  }

  // memory/ subdirectory
  try {
    const memDir = path.join(wsDir, 'memory');
    const memFiles = fs.readdirSync(memDir).filter(f => f.endsWith('.md'));
    for (const fname of memFiles) {
      const relPath = `memory/${fname}`;
      if (existing.has(relPath)) continue;
      try {
        const absPath = path.join(memDir, fname);
        const stat = fs.statSync(absPath);
        const content = fs.readFileSync(absPath, 'utf-8');
        result[agentName].push({ name: fname, relPath, absPath, content, mtime: stat.mtimeMs, source: 'agent-generated' });
        existing.add(relPath);
      } catch { /* skip */ }
    }
  } catch { /* no memory/ dir */ }
}

// Read memory/soul/heartbeat files for Memory Viewer
export function readAgentFiles(clawHome?: string): Record<string, MemoryFileEntry[]> {
  const base = clawHome || process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
  const result: Record<string, MemoryFileEntry[]> = {};
  const registered = new Set(listRegisteredAgents());

  // Strategy 1: ~/.openclaw/workspace-<agent>/ and ~/.openclaw/workspace/ (main)
  try {
    const entries = fs.readdirSync(base).filter(f => {
      try { return fs.statSync(path.join(base, f)).isDirectory() && f.startsWith('workspace'); } catch { return false; }
    });
    for (const dir of entries) {
      const agentName = dir === 'workspace' ? 'main' : dir.replace('workspace-', '');
      if (!registered.has(agentName)) continue;
      readFilesFromDir(path.join(base, dir), agentName, result);
    }
  } catch { /* skip */ }

  // Strategy 2: ~/.openclaw/agents/<agent>/workspace/ (legacy)
  try {
    const agentsDir = path.join(base, 'agents');
    const agents = fs.readdirSync(agentsDir).filter(f => {
      try { return fs.statSync(path.join(agentsDir, f)).isDirectory(); } catch { return false; }
    });
    for (const agent of agents) {
      if (!registered.has(agent)) continue;
      readFilesFromDir(path.join(agentsDir, agent, 'workspace'), agent, result);
    }
  } catch { /* skip */ }

  return result;
}


// WebSocket live proxy to Gateway
export function setupLiveWs(
  server: http.Server,
  db: Database.Database,
  clawHome?: string
): () => void {
  const browserClients = new Set<WebSocket>();

  const wss = new WebSocketServer({ server, path: '/ws/live' });

  let gatewayWs: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = 1000;
  let stopped = false;

  function broadcast(msg: string) {
    for (const client of browserClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  function connectGateway() {
    if (stopped) return;
    const token = getGatewayToken();
    const port = getGatewayPort();
    const url = `ws://127.0.0.1:${port}`;

    broadcast(JSON.stringify({ type: 'gateway_status', status: 'connecting', url }));

    try {
      gatewayWs = new WebSocket(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch {
      scheduleReconnect();
      return;
    }

    gatewayWs.on('open', () => {
      backoffMs = 1000;
      broadcast(JSON.stringify({ type: 'gateway_status', status: 'connected', url }));
    });

    gatewayWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as { type?: string };
        if (msg.type === 'gateway_status' || msg.type === 'data_updated') {
          broadcast(data.toString());
        }
      } catch { /* drop malformed messages */ }
    });

    gatewayWs.on('close', () => {
      broadcast(JSON.stringify({ type: 'gateway_status', status: 'disconnected' }));
      scheduleReconnect();
    });

    gatewayWs.on('error', () => {
      broadcast(JSON.stringify({ type: 'gateway_status', status: 'error' }));
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (stopped) return;
    reconnectTimer = setTimeout(() => {
      backoffMs = Math.min(backoffMs * 2, MAX_RECONNECT_BACKOFF_MS);
      connectGateway();
    }, backoffMs);
  }

  wss.on('connection', (ws, req) => {
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      ws.close(1008, 'Origin not allowed');
      return;
    }
    browserClients.add(ws);
    // Send current gateway status
    const isConnected = gatewayWs?.readyState === WebSocket.OPEN;
    ws.send(JSON.stringify({
      type: 'gateway_status',
      status: isConnected ? 'connected' : 'disconnected',
    }));
    ws.on('close', () => browserClients.delete(ws));
  });

  connectGateway();

  // File watcher: re-ingest when .jsonl files change
  const base = clawHome || process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
  const sessionsPattern = path.join(base, 'agents', '**', 'sessions');
  let ingestDebounce: ReturnType<typeof setTimeout> | null = null;

  glob(sessionsPattern, { nodir: false }).then(dirs => {
    for (const dir of dirs) {
      try {
        fs.watch(dir, (_event, filename) => {
          if (!filename?.endsWith('.jsonl')) return;
          if (ingestDebounce) clearTimeout(ingestDebounce);
          ingestDebounce = setTimeout(async () => {
            await ingestAll(db, { clawHome });
            broadcast(JSON.stringify({ type: 'data_updated', ts: Date.now() }));
          }, INGEST_DEBOUNCE_MS);
        });
      } catch {
        // directory may not exist yet
      }
    }
  }).catch(() => {});

  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ingestDebounce) clearTimeout(ingestDebounce);
    gatewayWs?.close();
    wss.close();
  };
}
