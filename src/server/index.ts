import express from 'express';
import cors from 'cors';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { openDb, initSchema, ingestAll } from './db';
import { sessionsRouter } from './api/sessions';
import { timelineRouter } from './api/timeline';
import { toolsRouter } from './api/tools';
import { statsRouter } from './api/stats';
import { setupLiveWs, readAgentFiles } from './api/live';
import { cronRouter } from './api/cron';
import { auditRouter } from './api/audit';
import debugRouter from './api/debug';
import { tokensRouter } from './api/tokens';
import { profilerRouter } from './api/profiler';
import { loadOpenClawModelDefinitions } from './model-meta';

export interface ServerOptions {
  port?: number;
  clawHome?: string;
  dbPath?: string;
  open?: boolean;
}

export async function startServer(opts: ServerOptions = {}): Promise<void> {
  const port = opts.port || 4242;

  // Init DB
  const db = openDb(opts.dbPath);
  initSchema(db);

  // Initial ingestion
  const result = await ingestAll(db, { clawHome: opts.clawHome });
  if (result.errors.length) {
    console.error('Ingestion errors:', result.errors);
  }

  // Enrich model context window data from locally installed OpenClaw
  loadOpenClawModelDefinitions();

  const app = express();
  app.use(cors({
    origin: (origin, callback) => {
      // Allow no-origin requests (curl, same-origin) and any localhost/127.0.0.1 port
      if (!origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        callback(null, true);
      } else {
        callback(new Error('CORS: origin not allowed'));
      }
    },
  }));
  app.use(express.json());

  // API routes
  app.use('/api/sessions', sessionsRouter(db));
  app.use('/api/timeline', timelineRouter(db));
  app.use('/api/tools', toolsRouter(db));
  app.use('/api/stats', statsRouter(db));
  app.use('/api/cron', cronRouter(db));
  app.use('/api/audit', auditRouter(db));
  app.use('/api/debug', debugRouter(db));
  app.use('/api/tokens', tokensRouter(db));
  app.use('/api/profiler', profilerRouter(db));

  // Memory Viewer API
  app.get('/api/memory', (_req, res) => {
    try {
      res.json(readAgentFiles(opts.clawHome));
    } catch (err) {
      console.error('[/api/memory] error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Re-ingest on demand
  app.post('/api/refresh', async (_req, res) => {
    try {
      const r = await ingestAll(db, { clawHome: opts.clawHome, force: true });
      res.json(r);
    } catch (err) {
      console.error('[/api/refresh] error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Serve built UI if available
  // Compiled: __dirname = <project>/dist/src/server → ../../../src/ui/dist = <project>/src/ui/dist
  // ts-node-dev: __dirname = <project>/src/server → use process.cwd() fallback
  const uiDist = fs.existsSync(path.join(__dirname, '../../../src/ui/dist'))
    ? path.join(__dirname, '../../../src/ui/dist')
    : path.join(process.cwd(), 'src/ui/dist');
  if (fs.existsSync(uiDist)) {
    app.use(express.static(uiDist));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(uiDist, 'index.html'));
    });
  }

  const server = http.createServer(app);

  // WebSocket: live gateway proxy + file watcher
  setupLiveWs(server, db, opts.clawHome);

  server.listen(port, '127.0.0.1', () => {
    console.log(`\nclaw-lens running at http://localhost:${port}\n`);
    if (opts.open) {
      import('child_process').then(({ exec }) => {
        const url = `http://localhost:${port}`;
        const cmd = process.platform === 'win32' ? `start ${url}`
          : process.platform === 'darwin' ? `open ${url}`
          : `xdg-open ${url}`;
        exec(cmd);
      });
    }
  });
}

// Run directly (e.g. via ts-node-dev in dev mode)
if (require.main === module) {
  const port = parseInt(process.env.PORT || '4242', 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid PORT: ${process.env.PORT}. Must be 1-65535.`);
    process.exit(1);
  }
  startServer({ port, open: true }).catch(console.error);
}
