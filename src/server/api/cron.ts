import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function getCronDir(): string {
  return path.join(
    process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw'),
    'cron'
  );
}

interface CronSchedule {
  kind: string;
  expr?: string;
  tz?: string;
  staggerMs?: number;
}

interface CronJobRaw {
  id: string;
  agentId: string;
  name: string;
  enabled: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: CronSchedule;
  sessionTarget?: string;
  wakeMode?: string;
  payload?: { kind: string; message?: string; timeoutSeconds?: number };
  delivery?: { mode: string };
  state?: {
    nextRunAtMs?: number;
    lastRunAtMs?: number;
    lastRunStatus?: string;
    lastStatus?: string;
    lastDurationMs?: number;
    lastDeliveryStatus?: string;
    consecutiveErrors?: number;
    lastDelivered?: boolean;
  };
}

interface CronRunRaw {
  ts: number;
  jobId: string;
  action: string;
  status: string;
  summary?: string;
  delivered?: boolean;
  deliveryStatus?: string;
  sessionId?: string;
  runAtMs?: number;
  durationMs?: number;
  nextRunAtMs?: number;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  error?: string;
}

function readJobs(): CronJobRaw[] {
  try {
    const p = path.join(getCronDir(), 'jobs.json');
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return Array.isArray(data.jobs) ? data.jobs : [];
  } catch {
    return [];
  }
}

function writeJobs(jobs: CronJobRaw[]): void {
  const p = path.join(getCronDir(), 'jobs.json');
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    // File missing or malformed — start fresh
  }
  fs.writeFileSync(p, JSON.stringify({ ...existing, jobs }, null, 2), 'utf-8');
}

function readRunsForJob(jobId: string, limit: number): CronRunRaw[] {
  try {
    const p = path.join(getCronDir(), 'runs', `${jobId}.jsonl`);
    const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .map(l => { try { return JSON.parse(l) as CronRunRaw; } catch { return null; } })
      .filter((r): r is CronRunRaw => r !== null)
      .reverse();
  } catch {
    return [];
  }
}

function readAllRuns(limit: number): CronRunRaw[] {
  try {
    const runsDir = path.join(getCronDir(), 'runs');
    if (!fs.existsSync(runsDir)) return [];
    const files = fs.readdirSync(runsDir).filter(f => f.endsWith('.jsonl'));
    const all: CronRunRaw[] = [];
    for (const file of files) {
      try {
        const lines = fs.readFileSync(path.join(runsDir, file), 'utf-8').split('\n').filter(Boolean);
        for (const line of lines) {
          try { all.push(JSON.parse(line)); } catch { /* skip bad line */ }
        }
      } catch { /* skip bad file */ }
    }
    return all.sort((a, b) => b.ts - a.ts).slice(0, limit);
  } catch {
    return [];
  }
}

export function cronRouter(db?: import('better-sqlite3').Database): Router {
  const r = Router();

  /** Check which sessionIds exist in the DB */
  function resolveSessionExists(runs: CronRunRaw[]): (CronRunRaw & { sessionExists?: boolean })[] {
    if (!db) return runs;
    const sessionIds = runs.map(r => r.sessionId).filter(Boolean) as string[];
    if (sessionIds.length === 0) return runs;
    const placeholders = sessionIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id FROM sessions WHERE id IN (${placeholders})`
    ).all(...sessionIds) as { id: string }[];
    const existing = new Set(rows.map(r => r.id));
    return runs.map(r => ({ ...r, sessionExists: r.sessionId ? existing.has(r.sessionId) : false }));
  }

  // GET /api/cron/jobs
  r.get('/jobs', (_req: Request, res: Response) => {
    res.json(readJobs());
  });

  // PATCH /api/cron/jobs/:id  { enabled: boolean }
  r.patch('/jobs/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== 'boolean') { res.status(400).json({ error: 'enabled must be boolean' }); return; }
    try {
      const jobs = readJobs();
      const job = jobs.find(j => j.id === id);
      if (!job) { res.status(404).json({ error: 'job not found' }); return; }
      job.enabled = enabled;
      job.updatedAtMs = Date.now();
      writeJobs(jobs);
      res.json({ ok: true });
    } catch (err) {
      console.error('cron job update failed:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/cron/runs?jobId=<id>&limit=20
  r.get('/runs', (req: Request, res: Response) => {
    const jobId = req.query.jobId as string | undefined;
    const limit = Math.min(Number(req.query.limit) || 20, 200);
    const runs = jobId ? readRunsForJob(jobId, limit) : readAllRuns(limit);
    res.json(resolveSessionExists(runs));
  });

  return r;
}
