/**
 * Atlas internal database connection.
 *
 * Read-write Postgres connection for Atlas's own state (auth, audit, settings).
 * Completely separate from the analytics datasource in connection.ts.
 * Configured via DATABASE_URL.
 */

import * as crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("internal-db");

// ---------------------------------------------------------------------------
// Connection URL encryption (AES-256-GCM)
// ---------------------------------------------------------------------------

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const AUTH_TAG_LENGTH = 16;

let _cachedKey: { raw: string; key: Buffer } | null = null;

/**
 * Returns the 32-byte encryption key derived via SHA-256 from
 * ATLAS_ENCRYPTION_KEY (takes precedence) or BETTER_AUTH_SECRET.
 * Returns null if neither is set. Result is cached.
 */
export function getEncryptionKey(): Buffer | null {
  const raw = process.env.ATLAS_ENCRYPTION_KEY ?? process.env.BETTER_AUTH_SECRET;
  if (!raw) return null;
  if (_cachedKey && _cachedKey.raw === raw) return _cachedKey.key;
  // Derive a fixed 32-byte key via SHA-256 so any-length secret works
  const key = crypto.createHash("sha256").update(raw).digest();
  _cachedKey = { raw, key };
  return key;
}

/** @internal Reset cached encryption key — for testing only. */
export function _resetEncryptionKeyCache(): void {
  _cachedKey = null;
}

/**
 * Encrypts a connection URL using AES-256-GCM.
 * Returns `iv:authTag:ciphertext` (all base64). Returns the plaintext
 * unchanged if no encryption key is available.
 */
export function encryptUrl(plaintext: string): string {
  const key = getEncryptionKey();
  if (!key) return plaintext;

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // `:` is safe as delimiter — base64 alphabet is A-Za-z0-9+/= (no colon)
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

/**
 * Decrypts a connection URL encrypted by `encryptUrl()`.
 * Plaintext detection (two checks):
 *   1. Starts with a URL scheme (`postgresql://`, `mysql://`, etc.) → plaintext
 *   2. Not exactly 3 colon-separated parts (`iv:authTag:ciphertext`) → plaintext
 * Returns plaintext values as-is for backward compatibility with pre-encryption data.
 */
export function decryptUrl(stored: string): string {
  if (isPlaintextUrl(stored)) return stored;

  const key = getEncryptionKey();
  if (!key) {
    log.error("Encrypted connection URL found but no encryption key is available — set ATLAS_ENCRYPTION_KEY or BETTER_AUTH_SECRET");
    throw new Error("Cannot decrypt connection URL: no encryption key available");
  }

  const parts = stored.split(":");
  if (parts.length !== 3) {
    log.error({ partCount: parts.length }, "Stored connection URL is not plaintext and does not match encrypted format (expected 3 colon-separated parts)");
    throw new Error("Failed to decrypt connection URL: unrecognized format");
  }

  try {
    const iv = Buffer.from(parts[0], "base64");
    const authTag = Buffer.from(parts[1], "base64");
    const ciphertext = Buffer.from(parts[2], "base64");

    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to decrypt connection URL — data may be corrupted or key may have changed",
    );
    throw new Error("Failed to decrypt connection URL", { cause: err });
  }
}

/** Returns true if the stored value looks like a plaintext URL (any URI scheme, not just database schemes). */
export function isPlaintextUrl(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
}

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

/** Idempotent migration: creates all Atlas internal tables and indexes. */
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

  // Delivery status tracking for scheduled task runs
  await pool.query(`ALTER TABLE scheduled_task_runs ADD COLUMN IF NOT EXISTS delivery_status TEXT, ADD COLUMN IF NOT EXISTS delivery_error TEXT;`);

  // Admin-managed connections (url column stores AES-256-GCM encrypted ciphertext; see encryptUrl/decryptUrl)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      schema_name TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Token usage tracking
  await pool.query(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT,
      conversation_id TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      provider TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_token_usage_user_id ON token_usage(user_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_token_usage_created_at ON token_usage(created_at);`);

  // User invitations
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invitations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'analyst',
      token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      invited_by TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      accepted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_invitations_status ON invitations(status);`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_pending_email ON invitations(email) WHERE status = 'pending';`);

  // Plugin settings (admin-managed enable/disable + config overrides)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS plugin_settings (
      plugin_id TEXT PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT true,
      config JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  log.info("Internal DB migration complete (audit_log, conversations, messages, slack, action_log, scheduled_tasks, connections, token_usage, invitations, plugin_settings)");
}

/**
 * Load admin-managed connections from the internal DB and register them
 * in the ConnectionRegistry. Idempotent — safe to call at startup.
 * Silently skips if no internal DB or the connections table doesn't exist yet.
 */
export async function loadSavedConnections(): Promise<number> {
  if (!hasInternalDB()) return 0;

  // Lazy-import to avoid circular dependency at module level
  const { connections } = await import("@atlas/api/lib/db/connection");

  try {
    const rows = await internalQuery<{
      id: string;
      url: string;
      type: string;
      description: string | null;
      schema_name: string | null;
    }>("SELECT id, url, type, description, schema_name FROM connections");

    let registered = 0;
    for (const row of rows) {
      try {
        const url = decryptUrl(row.url);
        connections.register(row.id, {
          url,
          description: row.description ?? undefined,
          schema: row.schema_name ?? undefined,
        });
        registered++;
      } catch (err) {
        log.warn(
          { connectionId: row.id, err: err instanceof Error ? err.message : String(err) },
          "Failed to register saved connection — skipping",
        );
      }
    }

    if (registered > 0) {
      log.info({ count: registered }, "Loaded saved connections from internal DB");
    }
    return registered;
  } catch (err) {
    // Table may not exist yet (pre-migration) — that's expected on first boot
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Could not load saved connections (table may not exist yet)",
    );
    return 0;
  }
}
