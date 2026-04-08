import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { findSessionFiles, parseSessionFile } from './parser';
import { ingestAuditEvents } from './audit/audit-parser';
import { rebuildAllBaselines } from './audit/baseline';
import { calculateDailyRiskScore } from './audit/risk-scorer';

export function getDbPath(): string {
  const clawHome = process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
  return path.join(clawHome, 'claw-lens.db');
}

export function openDb(dbPath?: string): Database.Database {
  const p = dbPath || getDbPath();
  const db = new Database(p);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      agent_name  TEXT NOT NULL,
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER NOT NULL,
      total_messages INTEGER NOT NULL DEFAULT 0,
      total_cost  REAL NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      primary_model TEXT,
      error_count INTEGER NOT NULL DEFAULT 0,
      is_cron      INTEGER NOT NULL DEFAULT 0,
      cron_task    TEXT,
      task_summary TEXT,
      ingested_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL REFERENCES sessions(id),
      agent_name    TEXT NOT NULL,
      parent_id     TEXT,
      timestamp     INTEGER NOT NULL,
      model         TEXT,
      provider      TEXT DEFAULT '',
      role          TEXT NOT NULL,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read    INTEGER NOT NULL DEFAULT 0,
      cache_write   INTEGER NOT NULL DEFAULT 0,
      total_tokens  INTEGER NOT NULL DEFAULT 0,
      cost_total    REAL NOT NULL DEFAULT 0,
      cost_input    REAL NOT NULL DEFAULT 0,
      cost_output   REAL NOT NULL DEFAULT 0,
      cost_cache_read  REAL NOT NULL DEFAULT 0,
      cost_cache_write REAL NOT NULL DEFAULT 0,
      stop_reason      TEXT,
      error_message    TEXT,
      has_error         INTEGER NOT NULL DEFAULT 0,
      is_tool_result   INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tool_calls (
      id          TEXT NOT NULL,
      message_id  TEXT NOT NULL REFERENCES messages(id),
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      agent_name  TEXT NOT NULL,
      timestamp   INTEGER NOT NULL,
      tool_name   TEXT NOT NULL,
      duration_ms INTEGER,
      success     INTEGER NOT NULL DEFAULT 1,
      arguments   TEXT,
      PRIMARY KEY (id, message_id)
    );

    CREATE TABLE IF NOT EXISTS ingest_state (
      file_path   TEXT PRIMARY KEY,
      mtime_ms    INTEGER NOT NULL,
      size_bytes  INTEGER NOT NULL,
      ingested_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session   ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_model     ON messages(model);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_tool    ON tool_calls(tool_name);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_ts      ON tool_calls(timestamp);
    CREATE INDEX IF NOT EXISTS idx_sessions_agent     ON sessions(agent_name);
    CREATE INDEX IF NOT EXISTS idx_sessions_started   ON sessions(started_at);

    -- P1 Audit tables
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      target TEXT,
      extra_json TEXT,
      risk_flags TEXT,
      risk_score INTEGER DEFAULT 0,
      raw_input TEXT,
      raw_output TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_audit_agent   ON audit_events(agent_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_type    ON audit_events(event_type, timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_events(session_id);

    CREATE TABLE IF NOT EXISTS sensitive_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      audit_event_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      pattern_type TEXT NOT NULL,
      pattern_matched TEXT,
      context TEXT,
      followed_by_external_call INTEGER DEFAULT 0,
      severity TEXT DEFAULT 'medium',
      dismissed INTEGER DEFAULT 0,
      FOREIGN KEY (audit_event_id) REFERENCES audit_events(id)
    );

    CREATE TABLE IF NOT EXISTS agent_risk_scores (
      agent_id TEXT NOT NULL,
      date TEXT NOT NULL,
      risk_score INTEGER NOT NULL,
      sensitive_path_count INTEGER DEFAULT 0,
      external_call_count INTEGER DEFAULT 0,
      sensitive_finding_count INTEGER DEFAULT 0,
      anomaly_count INTEGER DEFAULT 0,
      PRIMARY KEY (agent_id, date)
    );

    CREATE TABLE IF NOT EXISTS agent_baselines (
      agent_id TEXT PRIMARY KEY,
      computed_at INTEGER,
      common_tools TEXT,
      typical_paths TEXT,
      typical_hours TEXT,
      avg_tool_calls_per_session REAL,
      known_domains TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_ingest_state (
      file_path TEXT PRIMARY KEY,
      mtime_ms INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      ingested_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    -- Settings table (used by settings API and migrations)
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

  `);

  // Migrations for existing DBs
  // Drop alert tables (removed feature)
  try { db.exec(`DROP TABLE IF EXISTS alert_history`); } catch { /* ignore */ }
  try { db.exec(`DROP TABLE IF EXISTS alert_routing_policies`); } catch { /* ignore */ }
  try { db.exec(`DROP TABLE IF EXISTS alert_contact_points`); } catch { /* ignore */ }
  try { db.exec(`DROP TABLE IF EXISTS alert_rules`); } catch { /* ignore */ }
  // Drop custom audit rule tables (removed feature)
  try { db.exec(`DROP TABLE IF EXISTS custom_sensitive_paths`); } catch { /* ignore */ }
  try { db.exec(`DROP TABLE IF EXISTS custom_sensitive_patterns`); } catch { /* ignore */ }
  // Drop annotations table (removed feature)
  try { db.exec(`DROP TABLE IF EXISTS annotations`); } catch { /* ignore */ }

  // Migration v6: fix context redaction — mask ALL sensitive values in context snippets
  try {
    const v = db.prepare("SELECT value FROM settings WHERE key = 'audit_scoring_version'").get() as { value: string } | undefined;
    if (!v || v.value !== '18') {
      db.exec(`DELETE FROM sensitive_findings`);
      db.exec(`DELETE FROM audit_events`);
      db.exec(`DELETE FROM ingest_state`);
      db.exec(`DELETE FROM audit_ingest_state`);
      db.exec(`DELETE FROM agent_risk_scores`);
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('audit_scoring_version', '18')").run();
    }
  } catch { /* ignore */ }

  try {
    db.exec(`ALTER TABLE messages ADD COLUMN provider TEXT DEFAULT ''`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN task_summary TEXT`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN is_tool_result INTEGER NOT NULL DEFAULT 0`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE tool_calls ADD COLUMN arguments TEXT`);
  } catch { /* column already exists */ }
  // Migration: add mtime_ms / size_bytes to ingest_state (added for change-detection optimisation)
  try {
    db.exec(`ALTER TABLE ingest_state ADD COLUMN mtime_ms INTEGER NOT NULL DEFAULT 0`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE ingest_state ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0`);
  } catch { /* column already exists */ }
  // Migration: add per-category cost columns to messages
  for (const col of ['cost_input', 'cost_output', 'cost_cache_read', 'cost_cache_write']) {
    try {
      db.exec(`ALTER TABLE messages ADD COLUMN ${col} REAL NOT NULL DEFAULT 0`);
    } catch { /* column already exists */ }
  }
}

interface IngestOptions {
  force?: boolean;
  clawHome?: string;
  onProgress?: (current: number, total: number, file: string) => void;
}

interface IngestResult {
  filesProcessed: number;
  filesSkipped: number;
  messagesInserted: number;
  toolCallsInserted: number;
  sessionsUpserted: number;
  auditEventsInserted: number;
  auditFindingsInserted: number;
  errors: string[];
}

export async function ingestAll(db: Database.Database, opts: IngestOptions = {}): Promise<IngestResult> {
  const files = await findSessionFiles(opts.clawHome);

  const result: IngestResult = {
    filesProcessed: 0,
    filesSkipped: 0,
    messagesInserted: 0,
    toolCallsInserted: 0,
    sessionsUpserted: 0,
    auditEventsInserted: 0,
    auditFindingsInserted: 0,
    errors: [],
  };

  // Full wipe on force re-ingest: delete all session data and rebuild from scratch.
  // Custom audit rules are stored separately and are NOT deleted.
  if (opts.force) {
    const wipeTx = db.transaction(() => {
      // Delete in FK-safe order: children before parents
      db.prepare('DELETE FROM sensitive_findings').run();
      db.prepare('DELETE FROM tool_calls').run();
      db.prepare('DELETE FROM audit_events').run();
      db.prepare('DELETE FROM messages').run();
      db.prepare('DELETE FROM sessions').run();
      db.prepare('DELETE FROM ingest_state').run();
      db.prepare('DELETE FROM audit_ingest_state').run();
    });
    wipeTx();
  }

  const getState = db.prepare('SELECT mtime_ms, size_bytes FROM ingest_state WHERE file_path = ?');
  const upsertState = db.prepare(`
    INSERT INTO ingest_state (file_path, mtime_ms, size_bytes, ingested_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      mtime_ms = excluded.mtime_ms,
      size_bytes = excluded.size_bytes,
      ingested_at = excluded.ingested_at
  `);

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    opts.onProgress?.(i + 1, files.length, f);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(f);
    } catch {
      result.errors.push(`stat failed: ${f}`);
      continue;
    }

    const mtimeMs = stat.mtimeMs;
    const sizeBytes = stat.size;

    if (!opts.force) {
      const existing = getState.get(f) as { mtime_ms: number; size_bytes: number } | undefined;
      if (existing && existing.mtime_ms === mtimeMs && existing.size_bytes === sizeBytes) {
        result.filesSkipped++;
        continue;
      }
    }

    try {
      const parsed = parseSessionFile(f);
      ingestSession(db, parsed.sessions, parsed.messages, parsed.toolCalls);
      result.messagesInserted += parsed.messages.length;
      result.toolCallsInserted += parsed.toolCalls.length;
      result.sessionsUpserted += parsed.sessions.length;

      // P1: Audit ingestion (per-session)
      for (const session of parsed.sessions) {
        try {
          const auditResult = ingestAuditEvents(db, f, session.id, session.agentName);
          result.auditEventsInserted += auditResult.eventsInserted;
          result.auditFindingsInserted += auditResult.findingsInserted;
        } catch (auditErr) {
          result.errors.push(`audit failed: ${f}: ${String(auditErr)}`);
        }
      }

      result.filesProcessed++;
      upsertState.run(f, mtimeMs, sizeBytes, Date.now());
    } catch (err) {
      result.errors.push(`parse/ingest failed: ${f}: ${String(err)}`);
    }
  }

  // Rebuild baselines and daily risk scores after ingestion
  if (result.filesProcessed > 0) {
    try {
      rebuildAllBaselines(db);
      // Recalculate risk scores for every (agent, date) present in audit_events
      const upsertScore = db.prepare(`
        INSERT INTO agent_risk_scores (agent_id, date, risk_score, sensitive_path_count, external_call_count, sensitive_finding_count, anomaly_count)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id, date) DO UPDATE SET
          risk_score = excluded.risk_score,
          sensitive_path_count = excluded.sensitive_path_count,
          external_call_count = excluded.external_call_count,
          sensitive_finding_count = excluded.sensitive_finding_count,
          anomaly_count = excluded.anomaly_count
      `);
      const agentDates = db.prepare(`
        SELECT DISTINCT agent_id, date(timestamp/1000, 'unixepoch', 'localtime') as date
        FROM audit_events ORDER BY agent_id, date
      `).all() as { agent_id: string; date: string }[];
      const scoreRun = db.transaction(() => {
        for (const { agent_id, date } of agentDates) {
          const r = calculateDailyRiskScore(db, agent_id, date);
          upsertScore.run(agent_id, date, r.score, r.sensitivePathCount, r.externalCallCount, r.sensitiveFindingCount, r.anomalyCount);
        }
      });
      scoreRun();
    } catch (e) {
      result.errors.push(`baseline/risk rebuild failed: ${String(e)}`);
    }
  }

  return result;
}

function ingestSession(
  db: Database.Database,
  sessions: ReturnType<typeof parseSessionFile>['sessions'],
  messages: ReturnType<typeof parseSessionFile>['messages'],
  toolCalls: ReturnType<typeof parseSessionFile>['toolCalls']
): void {
  const upsertSession = db.prepare(`
    INSERT INTO sessions (id, agent_name, started_at, ended_at, total_messages, total_cost, total_tokens, primary_model, error_count, is_cron, cron_task, task_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      ended_at = excluded.ended_at,
      total_messages = excluded.total_messages,
      total_cost = excluded.total_cost,
      total_tokens = excluded.total_tokens,
      primary_model = excluded.primary_model,
      error_count = excluded.error_count,
      is_cron = excluded.is_cron,
      cron_task = excluded.cron_task,
      task_summary = excluded.task_summary
  `);

  const upsertMessage = db.prepare(`
    INSERT INTO messages (id, session_id, agent_name, parent_id, timestamp, model, provider, role,
      input_tokens, output_tokens, cache_read, cache_write, total_tokens, cost_total,
      cost_input, cost_output, cost_cache_read, cost_cache_write,
      stop_reason, error_message, has_error, is_tool_result)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read = excluded.cache_read,
      cache_write = excluded.cache_write,
      total_tokens = excluded.total_tokens,
      cost_total = excluded.cost_total,
      cost_input = excluded.cost_input,
      cost_output = excluded.cost_output,
      cost_cache_read = excluded.cost_cache_read,
      cost_cache_write = excluded.cost_cache_write,
      provider = excluded.provider,
      stop_reason = excluded.stop_reason,
      error_message = excluded.error_message,
      has_error = excluded.has_error,
      is_tool_result = excluded.is_tool_result
  `);

  const upsertToolCall = db.prepare(`
    INSERT INTO tool_calls (id, message_id, session_id, agent_name, timestamp, tool_name, duration_ms, success, arguments)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id, message_id) DO UPDATE SET
      arguments = excluded.arguments,
      duration_ms = COALESCE(excluded.duration_ms, tool_calls.duration_ms),
      success = excluded.success
  `);

  const run = db.transaction(() => {
    for (const s of sessions) {
      upsertSession.run(s.id, s.agentName, s.startedAt, s.endedAt, s.totalMessages,
        s.totalCost, s.totalTokens, s.primaryModel, s.errorCount, s.isCron ? 1 : 0, s.cronTask, s.taskSummary ?? null);
    }
    for (const m of messages) {
      upsertMessage.run(m.id, m.sessionId, m.agentName, m.parentId, m.timestamp,
        m.model, m.provider, m.role, m.inputTokens, m.outputTokens, m.cacheRead, m.cacheWrite,
        m.totalTokens, m.costTotal, m.costInput, m.costOutput, m.costCacheRead, m.costCacheWrite,
        m.stopReason, m.errorMessage, m.hasError, m.isToolResult);
    }
    for (const tc of toolCalls) {
      upsertToolCall.run(tc.id, tc.messageId, tc.sessionId, tc.agentName,
        tc.timestamp, tc.toolName, tc.durationMs, tc.success, tc.arguments ?? null);
    }
  });

  run();
}

// CLI: run standalone ingestion
async function main() {
  const db = openDb();
  initSchema(db);

  console.log('Starting ingestion...');
  const start = Date.now();

  const result = await ingestAll(db, {
    onProgress: (cur, total, file) => {
      process.stdout.write(`\r[${cur}/${total}] ${path.basename(file)}    `);
    },
  });

  console.log(`\nDone in ${Date.now() - start}ms`);
  console.log(`  Files processed : ${result.filesProcessed}`);
  console.log(`  Files skipped   : ${result.filesSkipped}`);
  console.log(`  Messages        : ${result.messagesInserted}`);
  console.log(`  Tool calls      : ${result.toolCallsInserted}`);
  console.log(`  Sessions        : ${result.sessionsUpserted}`);
  if (result.errors.length) {
    console.error(`  Errors (${result.errors.length}):`, result.errors);
  }

  db.close();
}

if (require.main === module) {
  main().catch(console.error);
}
