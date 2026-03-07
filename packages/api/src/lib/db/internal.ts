/**
 * Atlas internal database connection.
 *
 * Read-write Postgres connection for Atlas's own state (auth, audit, settings).
 * Completely separate from the analytics datasource in connection.ts.
 * Configured via DATABASE_URL.
 */

import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("internal-db");

/** Typed interface for the internal pg.Pool — avoids importing pg at module level. */
export interface InternalPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
  on(event: "error", listener: (err: Error) => void): void;
}

let _pool: InternalPool | null = null;

/** Returns true if DATABASE_URL is configured. */
export function hasInternalDB(): boolean {
  return !!process.env.DATABASE_URL;
}

/** Returns the singleton pg.Pool for the internal database. Throws if DATABASE_URL is not set. */
export function getInternalDB(): InternalPool {
  if (!_pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "DATABASE_URL is not set. Atlas internal database requires a PostgreSQL connection string."
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Pool } = require("pg");
    // Normalize sslmode: pg v8 treats 'require' as 'verify-full' but warns.
    const connString = process.env.DATABASE_URL!.replace(
      /([?&])sslmode=require(?=&|$)/,
      "$1sslmode=verify-full",
    );
    _pool = new Pool({
      connectionString: connString,
      max: 5,
      idleTimeoutMillis: 30000,
    }) as InternalPool;
    _pool.on("error", (err: unknown) => {
      log.error(
        { err: err instanceof Error ? err : new Error(String(err)) },
        "Internal DB pool idle client error",
      );
    });
  }
  return _pool;
}

/** Gracefully close the internal DB pool. */
export async function closeInternalDB(): Promise<void> {
  if (_pool) {
    const pool = _pool;
    _pool = null;
    try {
      await pool.end();
    } catch (err: unknown) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Error closing internal DB pool",
      );
    }
  }
}

/** Reset singleton for testing. Optionally inject a mock pool. */
export function _resetPool(mockPool?: InternalPool | null): void {
  _pool = mockPool ?? null;
  _consecutiveFailures = 0;
  _circuitOpen = false;
  _droppedCount = 0;
}

/** Parameterized query that returns typed rows. */
export async function internalQuery<T extends Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const pool = getInternalDB();
  const result = await pool.query(sql, params);
  return result.rows as T[];
}

let _consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 5;
let _circuitOpen = false;
let _droppedCount = 0;

/** Fire-and-forget query — async errors are logged, never thrown.
 * After 5 consecutive failures, a circuit breaker trips and silently
 * drops all calls for 60s before retrying. Throws synchronously if
 * DATABASE_URL is not set (callers should check hasInternalDB() first). */
export function internalExecute(sql: string, params?: unknown[]): void {
  if (_circuitOpen) {
    _droppedCount++;
    return;
  }
  const pool = getInternalDB();
  void pool.query(sql, params)
    .then(() => { _consecutiveFailures = 0; })
    .catch((err: unknown) => {
      _consecutiveFailures++;
      if (_consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !_circuitOpen) {
        _circuitOpen = true;
        log.error("Internal DB circuit breaker open — fire-and-forget writes disabled until recovery");
        // Try to recover every 60s
        setTimeout(() => {
          const dropped = _droppedCount;
          _circuitOpen = false;
          _consecutiveFailures = 0;
          _droppedCount = 0;
          log.info({ droppedCount: dropped }, "Internal DB circuit breaker recovered — fire-and-forget writes resumed");
        }, 60_000).unref();
      }
      if (!_circuitOpen) {
        log.error(
          {
            err: err instanceof Error ? err.message : String(err),
            sql: sql.slice(0, 200),
            paramCount: params?.length ?? 0,
          },
          "Internal DB fire-and-forget write failed — row lost",
        );
      }
    });
}

/** Reset circuit breaker state. For testing only. */
export function _resetCircuitBreaker(): void {
  _consecutiveFailures = 0;
  _circuitOpen = false;
  _droppedCount = 0;
}

/** Idempotent migration: creates audit_log, conversations, and messages tables. */
export async function migrateInternalDB(): Promise<void> {
  const pool = getInternalDB();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
      user_id TEXT,
      user_label TEXT,
      auth_mode TEXT NOT NULL,
      sql TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      row_count INTEGER,
      success BOOLEAN NOT NULL,
      error TEXT
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT,
      title TEXT,
      surface TEXT DEFAULT 'web',
      connection_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);`);

  // Slack integration tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slack_installations (
      team_id TEXT PRIMARY KEY,
      bot_token TEXT NOT NULL,
      installed_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slack_threads (
      thread_ts TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      conversation_id UUID NOT NULL,
      PRIMARY KEY (thread_ts, channel_id)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_slack_threads_conversation ON slack_threads(conversation_id);`);

  // Action framework tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS action_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at  TIMESTAMPTZ,
      executed_at  TIMESTAMPTZ,
      requested_by TEXT,
      approved_by  TEXT,
      auth_mode    TEXT NOT NULL,
      action_type  TEXT NOT NULL,
      target       TEXT NOT NULL,
      summary      TEXT NOT NULL,
      payload      JSONB NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      result       JSONB,
      error        TEXT,
      rollback_info JSONB,
      conversation_id UUID,
      request_id   TEXT
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_action_log_requested_by ON action_log(requested_by);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_action_log_status ON action_log(status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_action_log_action_type ON action_log(action_type);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_action_log_conversation ON action_log(conversation_id);`);

  // Multi-database production hardening: add source tracking columns to audit_log
  await pool.query(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS source_id TEXT, ADD COLUMN IF NOT EXISTS source_type TEXT, ADD COLUMN IF NOT EXISTS target_host TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_source_id ON audit_log(source_id);`);

  // Saved/starred conversations
  await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS starred BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_conversations_starred ON conversations(user_id, starred) WHERE starred = true;`);

  // Scheduled tasks
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      question TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      delivery_channel TEXT NOT NULL DEFAULT 'webhook',
      recipients JSONB NOT NULL DEFAULT '[]',
      connection_id TEXT,
      approval_mode TEXT NOT NULL DEFAULT 'auto',
      enabled BOOLEAN NOT NULL DEFAULT true,
      last_run_at TIMESTAMPTZ,
      next_run_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_owner ON scheduled_tasks(owner_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled ON scheduled_tasks(enabled) WHERE enabled = true;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run ON scheduled_tasks(next_run_at) WHERE enabled = true;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_task_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id UUID NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'running',
      conversation_id UUID,
      action_id UUID,
      error TEXT,
      tokens_used INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_task ON scheduled_task_runs(task_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_status ON scheduled_task_runs(status);`);

  log.info("Internal DB migration complete (audit_log, conversations, messages, slack, action_log, scheduled_tasks)");
}
