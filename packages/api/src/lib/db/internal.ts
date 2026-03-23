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
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error(
        "DATABASE_URL is not set. Atlas internal database requires a PostgreSQL connection string."
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Pool } = require("pg");
    // Normalize sslmode: pg v8 treats 'require' as 'verify-full' but warns.
    const connString = databaseUrl.replace(
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

  // Data classification tags: store table/column references for compliance filtering
  await pool.query(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS tables_accessed JSONB, ADD COLUMN IF NOT EXISTS columns_accessed JSONB;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_tables_accessed ON audit_log USING GIN (tables_accessed);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_columns_accessed ON audit_log USING GIN (columns_accessed);`);

  // Saved/starred conversations
  await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS starred BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_conversations_starred ON conversations(user_id, starred) WHERE starred = true;`);

  // Conversation sharing (partial unique index is the real constraint — no column-level UNIQUE needed)
  await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS share_token VARCHAR(64), ADD COLUMN IF NOT EXISTS share_expires_at TIMESTAMPTZ;`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_share_token ON conversations(share_token) WHERE share_token IS NOT NULL;`);
  await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS share_mode VARCHAR(10) NOT NULL DEFAULT 'public';`);
  await pool.query(`DO $$ BEGIN ALTER TABLE conversations ADD CONSTRAINT chk_share_mode CHECK (share_mode IN ('public', 'org')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);

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
      role TEXT NOT NULL DEFAULT 'member',
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

  // Application settings (admin overrides for env var config)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT
    );
  `);

  // Organization scoping — add org_id to all tenant-scoped tables
  await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS org_id TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_conversations_org ON conversations(org_id);`);
  await pool.query(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS org_id TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_org ON audit_log(org_id);`);
  await pool.query(`ALTER TABLE action_log ADD COLUMN IF NOT EXISTS org_id TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_action_log_org ON action_log(org_id);`);
  await pool.query(`ALTER TABLE connections ADD COLUMN IF NOT EXISTS org_id TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_connections_org ON connections(org_id);`);
  await pool.query(`ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS org_id TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_token_usage_org ON token_usage(org_id);`);
  await pool.query(`ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS org_id TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_org ON scheduled_tasks(org_id);`);
  await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS org_id TEXT;`);
  await pool.query(`ALTER TABLE plugin_settings ADD COLUMN IF NOT EXISTS org_id TEXT;`);

  // Org-scoped semantic entities (DB-backed semantic layer)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS semantic_entities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      name TEXT NOT NULL,
      yaml_content TEXT NOT NULL,
      connection_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_semantic_entities_org_type_name ON semantic_entities(org_id, entity_type, name);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_semantic_entities_org ON semantic_entities(org_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_semantic_entities_org_type ON semantic_entities(org_id, entity_type);`);

  // Learned query patterns (0.8.0 dynamic learning layer)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS learned_patterns (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT,
      pattern_sql TEXT NOT NULL,
      description TEXT,
      source_entity TEXT,
      source_queries JSONB,
      confidence REAL NOT NULL DEFAULT 0.1,
      repetition_count INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      proposed_by TEXT,
      reviewed_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_at TIMESTAMPTZ
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_learned_patterns_org_status ON learned_patterns(org_id, status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_learned_patterns_org_entity ON learned_patterns(org_id, source_entity);`);

  // Prompt library (0.8.0)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prompt_collections (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT,
      name TEXT NOT NULL,
      industry TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      is_builtin BOOLEAN NOT NULL DEFAULT false,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_prompt_collections_org ON prompt_collections(org_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_prompt_collections_builtin ON prompt_collections(is_builtin) WHERE is_builtin = true;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS prompt_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      collection_id UUID NOT NULL REFERENCES prompt_collections(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      description TEXT,
      category TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_prompt_items_collection ON prompt_items(collection_id);`);

  // Seed built-in prompt collections
  await seedPromptLibrary(pool);

  // Notebook state persistence (0.8.1 Phase 2 — fork/reorder/server persistence)
  await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS notebook_state JSONB;`);

  // Workspace lifecycle (0.9.0 — SaaS infrastructure)
  // Extends the Better Auth `organization` table with workspace management columns.
  // The organization table is created by Better Auth migrations (which run after this).
  // On first boot, this block is skipped; columns are added on subsequent restarts.
  const orgTableExists = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'organization' LIMIT 1`,
  );
  if (orgTableExists.rows.length > 0) {
    await pool.query(`ALTER TABLE organization ADD COLUMN IF NOT EXISTS workspace_status TEXT NOT NULL DEFAULT 'active';`);
    await pool.query(`DO $$ BEGIN ALTER TABLE organization ADD CONSTRAINT chk_workspace_status CHECK (workspace_status IN ('active', 'suspended', 'deleted')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await pool.query(`ALTER TABLE organization ADD COLUMN IF NOT EXISTS plan_tier TEXT NOT NULL DEFAULT 'free';`);
    // Drop and re-create plan_tier CHECK to include 'trial' (added in 0.9.0 billing)
    await pool.query(`ALTER TABLE organization DROP CONSTRAINT IF EXISTS chk_plan_tier;`);
    await pool.query(`DO $$ BEGIN ALTER TABLE organization ADD CONSTRAINT chk_plan_tier CHECK (plan_tier IN ('free', 'trial', 'team', 'enterprise')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await pool.query(`ALTER TABLE organization ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;`);
    await pool.query(`ALTER TABLE organization ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_organization_workspace_status ON organization(workspace_status);`);

    // Billing columns (0.9.0 — Stripe billing integration)
    await pool.query(`ALTER TABLE organization ADD COLUMN IF NOT EXISTS byot BOOLEAN NOT NULL DEFAULT false;`);
    await pool.query(`ALTER TABLE organization ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;`);
    await pool.query(`ALTER TABLE organization ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;`);
  }

  // Soft-delete support for conversations (needed by workspace cascade delete)
  await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;`);

  // Usage metering (0.9.0 — per-workspace usage tracking)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id TEXT,
      user_id TEXT,
      event_type TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_usage_events_workspace ON usage_events(workspace_id, created_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_usage_events_type ON usage_events(event_type, created_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_usage_events_user ON usage_events(user_id, created_at);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_summaries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id TEXT NOT NULL,
      period TEXT NOT NULL,
      period_start TIMESTAMPTZ NOT NULL,
      query_count INTEGER NOT NULL DEFAULT 0,
      token_count INTEGER NOT NULL DEFAULT 0,
      active_users INTEGER NOT NULL DEFAULT 0,
      storage_bytes BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_summaries_ws_period ON usage_summaries(workspace_id, period, period_start);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_usage_summaries_workspace ON usage_summaries(workspace_id, period_start);`);

  // Enterprise SSO providers (0.9.0 — per-org SAML/OIDC identity provider registration)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sso_providers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT NOT NULL,
      type TEXT NOT NULL,
      issuer TEXT NOT NULL,
      domain TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT false,
      config JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`DO $$ BEGIN ALTER TABLE sso_providers ADD CONSTRAINT chk_sso_type CHECK (type IN ('saml', 'oidc')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sso_providers_org ON sso_providers(org_id);`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sso_providers_domain ON sso_providers(domain);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sso_providers_enabled ON sso_providers(org_id, enabled) WHERE enabled = true;`);

  // SSO enforcement column — when true, password auth is blocked for the org's domain (0.9.0 #659)
  await pool.query(`DO $$ BEGIN ALTER TABLE sso_providers ADD COLUMN sso_enforced BOOLEAN NOT NULL DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END $$;`);

  // Demo leads — email-gated demo mode lead capture
  await pool.query(`
    CREATE TABLE IF NOT EXISTS demo_leads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL UNIQUE,
      ip_address TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      session_count INTEGER NOT NULL DEFAULT 1
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_demo_leads_created ON demo_leads(created_at);`);

  // Enterprise IP allowlist (0.9.0 — per-workspace IP allowlisting)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ip_allowlist (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT NOT NULL,
      cidr TEXT NOT NULL,
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by TEXT,
      UNIQUE(org_id, cidr)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ip_allowlist_org ON ip_allowlist(org_id);`);

  // Enterprise custom roles (0.9.0 — granular permission-based RBAC)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS custom_roles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      permissions JSONB NOT NULL DEFAULT '[]',
      is_builtin BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_roles_org_name ON custom_roles(org_id, name);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_custom_roles_org ON custom_roles(org_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_custom_roles_builtin ON custom_roles(is_builtin) WHERE is_builtin = true;`);

  // User onboarding state (0.9.0 — guided tour completion tracking)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_onboarding (
      user_id TEXT PRIMARY KEY,
      tour_completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  log.info("Internal DB migration complete");
}

/** Seed built-in prompt collections. Idempotent — checks each collection by name. */
async function seedPromptLibrary(pool: InternalPool): Promise<void> {
  const collections = [
    {
      name: "SaaS Metrics",
      industry: "saas",
      description: "Key metrics for SaaS businesses including revenue, churn, and growth indicators.",
      items: [
        { question: "What is our current MRR and how has it trended over the last 12 months?", description: "Monthly recurring revenue trend", category: "Revenue" },
        { question: "What is our monthly churn rate by plan type?", description: "Customer churn segmented by subscription tier", category: "Churn" },
        { question: "What is the average customer lifetime value (LTV) by acquisition channel?", description: "LTV breakdown by how customers were acquired", category: "Revenue" },
        { question: "What is our customer acquisition cost (CAC) by channel?", description: "Cost to acquire customers across marketing channels", category: "Growth" },
        { question: "What is the LTV to CAC ratio by plan type?", description: "Unit economics health check", category: "Revenue" },
        { question: "What is our net revenue retention rate?", description: "Expansion revenue minus churn and contraction", category: "Retention" },
        { question: "What is the average revenue per user (ARPU) trend?", description: "Revenue per user over time", category: "Revenue" },
        { question: "How many trials converted to paid subscriptions this month?", description: "Trial-to-paid conversion rate", category: "Growth" },
        { question: "What is the expansion revenue from upsells and cross-sells?", description: "Revenue growth from existing customers", category: "Revenue" },
        { question: "What are the top reasons for customer cancellation?", description: "Churn reason analysis", category: "Churn" },
        { question: "What is our monthly active user (MAU) trend?", description: "Product engagement over time", category: "Engagement" },
        { question: "What is the average time to first value for new customers?", description: "Onboarding speed metric", category: "Engagement" },
      ],
    },
    {
      name: "E-commerce KPIs",
      industry: "ecommerce",
      description: "Essential KPIs for e-commerce businesses covering sales, conversion, and inventory.",
      items: [
        { question: "What is our gross merchandise volume (GMV) this month vs last month?", description: "Total sales volume comparison", category: "Sales" },
        { question: "What is our average order value (AOV) by product category?", description: "AOV segmented by category", category: "Sales" },
        { question: "What is our cart abandonment rate and at which step do most users drop off?", description: "Checkout funnel analysis", category: "Conversion" },
        { question: "What are the top 10 products by revenue this quarter?", description: "Best-selling products ranked by revenue", category: "Products" },
        { question: "What is our conversion rate from visit to purchase by traffic source?", description: "Conversion funnel by acquisition channel", category: "Conversion" },
        { question: "What is the return rate by product category?", description: "Product return analysis", category: "Operations" },
        { question: "What is the average delivery time by region?", description: "Fulfillment speed by geography", category: "Operations" },
        { question: "What is the customer repeat purchase rate?", description: "Percentage of customers who buy again", category: "Retention" },
        { question: "Which product categories have the highest profit margins?", description: "Margin analysis by category", category: "Profitability" },
        { question: "What is the inventory turnover rate by product?", description: "How quickly inventory sells", category: "Inventory" },
        { question: "What is the customer satisfaction score (CSAT) trend?", description: "Customer satisfaction over time", category: "Experience" },
        { question: "What are the peak sales hours and days of the week?", description: "Sales timing patterns", category: "Sales" },
      ],
    },
    {
      name: "Cybersecurity Compliance",
      industry: "cybersecurity",
      description: "Security and compliance metrics for cybersecurity monitoring and reporting.",
      items: [
        { question: "How many open vulnerabilities do we have by severity level?", description: "Vulnerability count by critical/high/medium/low", category: "Vulnerabilities" },
        { question: "What is our average time to patch critical vulnerabilities?", description: "Mean time to remediate critical findings", category: "Vulnerabilities" },
        { question: "What is the compliance score across our security frameworks?", description: "Overall compliance posture", category: "Compliance" },
        { question: "How many security incidents occurred this month by type?", description: "Incident count segmented by category", category: "Incidents" },
        { question: "What is our mean time to detect (MTTD) and mean time to respond (MTTR)?", description: "Incident response speed metrics", category: "Incidents" },
        { question: "What percentage of endpoints have up-to-date security agents?", description: "Endpoint protection coverage", category: "Assets" },
        { question: "What is the phishing simulation click rate trend?", description: "Security awareness training effectiveness", category: "Training" },
        { question: "How many failed login attempts occurred by user and region?", description: "Brute force and credential stuffing detection", category: "Access" },
        { question: "What is the status of our third-party vendor risk assessments?", description: "Vendor security review completion", category: "Compliance" },
        { question: "What percentage of systems are compliant with our patching policy?", description: "Patch compliance rate", category: "Vulnerabilities" },
        { question: "What are the top firewall-blocked threats this week?", description: "Network threat intelligence summary", category: "Network" },
        { question: "What is the data classification breakdown across our storage systems?", description: "Sensitive data inventory", category: "Data" },
      ],
    },
  ];

  for (let ci = 0; ci < collections.length; ci++) {
    const collection = collections[ci];
    // Check if this collection already exists
    const existing = await pool.query(
      `SELECT id FROM prompt_collections WHERE name = $1 AND is_builtin = true`,
      [collection.name],
    );
    if (existing.rows.length > 0) continue;

    // Insert collection
    const result = await pool.query(
      `INSERT INTO prompt_collections (name, industry, description, is_builtin, sort_order)
       VALUES ($1, $2, $3, true, $4) RETURNING id`,
      [collection.name, collection.industry, collection.description, ci],
    );
    if (!result.rows[0]) {
      log.warn({ collection: collection.name }, "INSERT INTO prompt_collections returned no rows — skipping item seeding");
      continue;
    }
    const collectionId = (result.rows[0] as Record<string, unknown>).id as string;

    // Insert items
    for (let i = 0; i < collection.items.length; i++) {
      const item = collection.items[i];
      await pool.query(
        `INSERT INTO prompt_items (collection_id, question, description, category, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [collectionId, item.question, item.description, item.category, i],
      );
    }
  }

  // Query suggestions (0.8.0)
await pool.query(`
    CREATE TABLE IF NOT EXISTS query_suggestions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT,
      description TEXT NOT NULL,
      pattern_sql TEXT NOT NULL,
      normalized_hash TEXT NOT NULL,
      tables_involved JSONB NOT NULL DEFAULT '[]',
      primary_table TEXT,
      frequency INTEGER NOT NULL DEFAULT 1,
      clicked_count INTEGER NOT NULL DEFAULT 0,
      score REAL NOT NULL DEFAULT 0,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // UNIQUE NULLS NOT DISTINCT treats NULL = NULL, so (NULL, hash) deduplicates correctly.
  // Requires PostgreSQL 15+. Uses DO NOTHING on duplicate constraint to be idempotent.
  await pool.query(`DO $$ BEGIN
    ALTER TABLE query_suggestions ADD CONSTRAINT uq_query_suggestions_org_hash UNIQUE NULLS NOT DISTINCT (org_id, normalized_hash);
  EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_query_suggestions_org_table ON query_suggestions(org_id, primary_table);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_query_suggestions_org_score ON query_suggestions(org_id, score DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_query_suggestions_tables ON query_suggestions USING GIN(tables_involved);`);
  await pool.query(`ALTER TABLE query_suggestions ADD CONSTRAINT uq_query_suggestions_org_hash UNIQUE NULLS NOT DISTINCT (org_id, normalized_hash);`).catch(() => { /* constraint already exists */ });
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

// ── Learned pattern helpers ─────────────────────────────────────────

/**
 * Find a learned pattern by exact normalized SQL match for the given org.
 * Returns the pattern's id, confidence, and repetition count, or null if not found.
 */
export async function findPatternBySQL(
  orgId: string | null | undefined,
  patternSql: string,
): Promise<{ id: string; confidence: number; repetitionCount: number } | null> {
  const pool = getInternalDB();
  const params: unknown[] = [patternSql];
  let orgClause: string;
  if (orgId) {
    params.push(orgId);
    orgClause = `org_id = $2`;
  } else {
    orgClause = `org_id IS NULL`;
  }

  const result = await pool.query(
    `SELECT id, confidence, repetition_count FROM learned_patterns WHERE pattern_sql = $1 AND ${orgClause} LIMIT 1`,
    params,
  );

  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id as string,
    confidence: row.confidence as number,
    repetitionCount: row.repetition_count as number,
  };
}

/**
 * Insert a new learned pattern. Fire-and-forget — errors are logged, never thrown.
 */
export function insertLearnedPattern(pattern: {
  orgId: string | null | undefined;
  patternSql: string;
  description: string;
  sourceEntity: string;
  sourceQueries: string[];
  proposedBy: string;
}): void {
  internalExecute(
    `INSERT INTO learned_patterns (org_id, pattern_sql, description, source_entity, source_queries, confidence, repetition_count, status, proposed_by)
     VALUES ($1, $2, $3, $4, $5, 0.1, 1, 'pending', $6)`,
    [
      pattern.orgId ?? null,
      pattern.patternSql,
      pattern.description,
      pattern.sourceEntity,
      JSON.stringify(pattern.sourceQueries),
      pattern.proposedBy,
    ],
  );
}

/**
 * Increment repetition_count by 1 and increase confidence by 0.1 (capped at 1.0).
 * When sourceFingerprint is provided, appends it to source_queries (capped at 100 entries).
 * Fire-and-forget — errors are logged, never thrown.
 */
export function incrementPatternCount(id: string, sourceFingerprint?: string): void {
  if (sourceFingerprint) {
    const newEntry = JSON.stringify([sourceFingerprint]);
    internalExecute(
      `UPDATE learned_patterns SET
        repetition_count = repetition_count + 1,
        confidence = LEAST(1.0, confidence + 0.1),
        source_queries = CASE
          WHEN source_queries IS NULL THEN $2::jsonb
          WHEN jsonb_array_length(source_queries) >= 100 THEN source_queries
          ELSE source_queries || $2::jsonb
        END,
        updated_at = now()
      WHERE id = $1`,
      [id, newEntry],
    );
  } else {
    internalExecute(
      `UPDATE learned_patterns SET
        repetition_count = repetition_count + 1,
        confidence = LEAST(1.0, confidence + 0.1),
        updated_at = now()
      WHERE id = $1`,
      [id],
    );
  }
}

/** Row shape returned by getApprovedPatterns. */
export interface ApprovedPatternRow {
  id: string;
  org_id: string | null;
  pattern_sql: string;
  description: string | null;
  source_entity: string | null;
  /** Confidence score between 0.0 and 1.0. */
  confidence: number;
  [key: string]: unknown;
}

/** Row shape for query_suggestions table. */
export interface QuerySuggestionRow {
  id: string;
  org_id: string | null;
  description: string;
  pattern_sql: string;
  normalized_hash: string;
  tables_involved: string; // JSONB string, parse to string[]
  primary_table: string | null;
  frequency: number;
  clicked_count: number;
  score: number;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

/**
 * Fetch approved learned patterns, scoped to an org (or global when orgId is null).
 * Ordered by confidence DESC, capped at 100 rows.
 */
export async function getApprovedPatterns(orgId: string | null): Promise<ApprovedPatternRow[]> {
  if (!hasInternalDB()) return [];

  return internalQuery<ApprovedPatternRow>(
    orgId
      ? `SELECT id, org_id, pattern_sql, description, source_entity, confidence
         FROM learned_patterns
         WHERE status = 'approved' AND (org_id = $1 OR org_id IS NULL)
         ORDER BY confidence DESC
         LIMIT 100`
      : `SELECT id, org_id, pattern_sql, description, source_entity, confidence
         FROM learned_patterns
         WHERE status = 'approved' AND org_id IS NULL
         ORDER BY confidence DESC
         LIMIT 100`,
    orgId ? [orgId] : [],
  );
}

export async function upsertSuggestion(suggestion: {
  orgId: string | null;
  description: string;
  patternSql: string;
  normalizedHash: string;
  tablesInvolved: string[];
  primaryTable: string | null;
  frequency: number;
  score: number;
  lastSeenAt: Date;
}): Promise<"created" | "updated" | "skipped"> {
  if (!hasInternalDB()) return "skipped";
  try {
    const rows = await internalQuery<{ id: string; created: boolean }>(
      `INSERT INTO query_suggestions (org_id, description, pattern_sql, normalized_hash, tables_involved, primary_table, frequency, score, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT ON CONSTRAINT uq_query_suggestions_org_hash DO UPDATE SET
         frequency = EXCLUDED.frequency,
         score = EXCLUDED.score,
         last_seen_at = EXCLUDED.last_seen_at,
         updated_at = NOW()
       RETURNING id, (xmax = 0) AS created`,
      [
        suggestion.orgId,
        suggestion.description,
        suggestion.patternSql,
        suggestion.normalizedHash,
        JSON.stringify(suggestion.tablesInvolved),
        suggestion.primaryTable,
        suggestion.frequency,
        suggestion.score,
        suggestion.lastSeenAt.toISOString(),
      ]
    );
    return rows[0]?.created ? "created" : "updated";
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to upsert suggestion");
    return "skipped";
  }
}

export async function getSuggestionsByTables(
  orgId: string | null,
  tables: string[],
  limit: number = 10
): Promise<QuerySuggestionRow[]> {
  if (!hasInternalDB()) return [];
  try {
    const orgClause = orgId != null ? "org_id = $1" : "org_id IS NULL";
    const params: unknown[] = orgId != null ? [orgId] : [];
    const nextIdx = params.length + 1;

    let tableClause: string;
    if (tables.length === 1) {
      tableClause = `primary_table = $${nextIdx}`;
      params.push(tables[0]);
    } else {
      tableClause = `tables_involved ?| $${nextIdx}::text[]`;
      params.push(tables);
    }

    params.push(limit);
    const limitIdx = params.length;

    return await internalQuery<QuerySuggestionRow>(
      `SELECT * FROM query_suggestions WHERE ${orgClause} AND ${tableClause} ORDER BY score DESC LIMIT $${limitIdx}`,
      params
    );
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to get suggestions by tables");
    return [];
  }
}

export async function getPopularSuggestions(
  orgId: string | null,
  limit: number = 10
): Promise<QuerySuggestionRow[]> {
  if (!hasInternalDB()) return [];
  try {
    const orgClause = orgId != null ? "org_id = $1" : "org_id IS NULL";
    const params: unknown[] = orgId != null ? [orgId, limit] : [limit];
    const limitIdx = params.length;

    return await internalQuery<QuerySuggestionRow>(
      `SELECT * FROM query_suggestions WHERE ${orgClause} ORDER BY score DESC LIMIT $${limitIdx}`,
      params
    );
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to get popular suggestions");
    return [];
  }
}

export function incrementSuggestionClick(
  id: string,
  orgId: string | null
): void {
  if (!hasInternalDB()) return;
  const orgClause = orgId != null ? "org_id = $1" : "org_id IS NULL";
  const params: unknown[] = orgId != null ? [orgId, id] : [id];
  const idIdx = params.length;

  internalExecute(
    `UPDATE query_suggestions SET clicked_count = clicked_count + 1 WHERE ${orgClause} AND id = $${idIdx}`,
    params
  );
}

export async function deleteSuggestion(
  id: string,
  orgId: string | null
): Promise<boolean> {
  if (!hasInternalDB()) return false;
  const orgClause = orgId != null ? "org_id = $1" : "org_id IS NULL";
  const params: unknown[] = orgId != null ? [orgId, id] : [id];
  const idIdx = params.length;

  const rows = await internalQuery<{ id: string }>(
    `DELETE FROM query_suggestions WHERE ${orgClause} AND id = $${idIdx} RETURNING id`,
    params
  );
  return rows.length > 0;
}

export async function getAuditLogQueries(
  orgId: string | null,
  limit: number = 5000
): Promise<Array<{ sql: string; tables_accessed: string | null; timestamp: string }>> {
  if (!hasInternalDB()) return [];
  try {
    const orgClause = orgId != null ? "org_id = $1" : "org_id IS NULL";
    const params: unknown[] = orgId != null ? [orgId, limit] : [limit];
    const limitIdx = params.length;

    return await internalQuery<{ sql: string; tables_accessed: string | null; timestamp: string }>(
      `SELECT sql, tables_accessed, timestamp FROM audit_log WHERE ${orgClause} AND success = true AND sql IS NOT NULL ORDER BY timestamp DESC LIMIT $${limitIdx}`,
      params
    );
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to get audit log queries");
    return [];
  }
}

// ── Workspace lifecycle helpers (0.9.0) ─────────────────────────────

export type WorkspaceStatus = "active" | "suspended" | "deleted";
export type PlanTier = "free" | "trial" | "team" | "enterprise";

export interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  workspace_status: WorkspaceStatus;
  plan_tier: PlanTier;
  byot: boolean;
  stripe_customer_id: string | null;
  trial_ends_at: string | null;
  suspended_at: string | null;
  deleted_at: string | null;
  createdAt: string;
  [key: string]: unknown;
}

/**
 * Get the workspace status for an organization.
 * Returns null if the org doesn't exist or internal DB is unavailable.
 * Throws on database errors — callers must handle failures explicitly.
 */
export async function getWorkspaceStatus(orgId: string): Promise<WorkspaceStatus | null> {
  if (!hasInternalDB()) return null;
  const rows = await internalQuery<{ workspace_status: WorkspaceStatus }>(
    `SELECT workspace_status FROM organization WHERE id = $1`,
    [orgId],
  );
  return rows[0]?.workspace_status ?? null;
}

/**
 * Get full workspace details for an organization.
 */
export async function getWorkspaceDetails(orgId: string): Promise<WorkspaceRow | null> {
  if (!hasInternalDB()) return null;
  const rows = await internalQuery<WorkspaceRow>(
    `SELECT id, name, slug, workspace_status, plan_tier, byot, stripe_customer_id, trial_ends_at, suspended_at, deleted_at, "createdAt"
     FROM organization WHERE id = $1`,
    [orgId],
  );
  return rows[0] ?? null;
}

/**
 * Update workspace status. Returns true if the org was found and updated,
 * false if no row matched the given orgId.
 */
export async function updateWorkspaceStatus(
  orgId: string,
  status: WorkspaceStatus,
): Promise<boolean> {
  const pool = getInternalDB();
  const timestampCol = status === "suspended" ? "suspended_at" : status === "deleted" ? "deleted_at" : null;

  let sql: string;
  if (timestampCol) {
    sql = `UPDATE organization SET workspace_status = $1, ${timestampCol} = now() WHERE id = $2 RETURNING id`;
  } else {
    // Activating: clear both timestamps
    sql = `UPDATE organization SET workspace_status = $1, suspended_at = NULL, deleted_at = NULL WHERE id = $2 RETURNING id`;
  }

  const result = await pool.query(sql, [status, orgId]);
  return result.rows.length > 0;
}

/**
 * Update workspace plan tier. Returns true if the org was found and updated,
 * false if no row matched the given orgId.
 */
export async function updateWorkspacePlanTier(
  orgId: string,
  planTier: PlanTier,
): Promise<boolean> {
  const pool = getInternalDB();
  const result = await pool.query(
    `UPDATE organization SET plan_tier = $1 WHERE id = $2 RETURNING id`,
    [planTier, orgId],
  );
  return result.rows.length > 0;
}

/**
 * Cascading soft-delete cleanup for a workspace:
 * - Soft-deletes conversations (sets deleted_at)
 * - Hard-deletes org-scoped semantic entities, learned patterns, and query suggestions
 * - Disables scheduled tasks
 */
export async function cascadeWorkspaceDelete(orgId: string): Promise<{
  conversations: number;
  semanticEntities: number;
  learnedPatterns: number;
  suggestions: number;
  scheduledTasks: number;
}> {
  const pool = getInternalDB();

  const [convResult, seResult, lpResult, qsResult, stResult] = await Promise.all([
    pool.query(
      `UPDATE conversations SET deleted_at = now(), updated_at = now() WHERE org_id = $1 AND deleted_at IS NULL RETURNING id`,
      [orgId],
    ),
    pool.query(
      `DELETE FROM semantic_entities WHERE org_id = $1 RETURNING id`,
      [orgId],
    ),
    pool.query(
      `DELETE FROM learned_patterns WHERE org_id = $1 RETURNING id`,
      [orgId],
    ),
    pool.query(
      `DELETE FROM query_suggestions WHERE org_id = $1 RETURNING id`,
      [orgId],
    ),
    pool.query(
      `UPDATE scheduled_tasks SET enabled = false, updated_at = now() WHERE org_id = $1 RETURNING id`,
      [orgId],
    ),
  ]);

  return {
    conversations: convResult.rows.length,
    semanticEntities: seResult.rows.length,
    learnedPatterns: lpResult.rows.length,
    suggestions: qsResult.rows.length,
    scheduledTasks: stResult.rows.length,
  };
}

/**
 * Get a workspace health summary: member count, conversation count,
 * query count (last 24h), connection count, and scheduled task count.
 */
export async function getWorkspaceHealthSummary(orgId: string): Promise<{
  workspace: WorkspaceRow;
  members: number;
  conversations: number;
  queriesLast24h: number;
  connections: number;
  scheduledTasks: number;
} | null> {
  if (!hasInternalDB()) return null;

  const workspace = await getWorkspaceDetails(orgId);
  if (!workspace) return null;

  const [memberRows, convRows, queryRows, connRows, taskRows] = await Promise.all([
    internalQuery<{ count: number }>(
      `SELECT COUNT(*)::int as count FROM member WHERE "organizationId" = $1`,
      [orgId],
    ),
    internalQuery<{ count: number }>(
      `SELECT COUNT(*)::int as count FROM conversations WHERE org_id = $1`,
      [orgId],
    ),
    internalQuery<{ count: number }>(
      `SELECT COUNT(*)::int as count FROM audit_log WHERE org_id = $1 AND timestamp > now() - interval '24 hours'`,
      [orgId],
    ),
    internalQuery<{ count: number }>(
      `SELECT COUNT(*)::int as count FROM connections WHERE org_id = $1`,
      [orgId],
    ),
    internalQuery<{ count: number }>(
      `SELECT COUNT(*)::int as count FROM scheduled_tasks WHERE org_id = $1 AND enabled = true`,
      [orgId],
    ),
  ]);

  return {
    workspace,
    members: memberRows[0]?.count ?? 0,
    conversations: convRows[0]?.count ?? 0,
    queriesLast24h: queryRows[0]?.count ?? 0,
    connections: connRows[0]?.count ?? 0,
    scheduledTasks: taskRows[0]?.count ?? 0,
  };
}

// ── Billing helpers (0.9.0 — Stripe billing) ────────────────────────

/**
 * Update the BYOT (Bring Your Own Token) flag for a workspace.
 * Returns true if the org was found and updated.
 */
export async function updateWorkspaceByot(
  orgId: string,
  byot: boolean,
): Promise<boolean> {
  const pool = getInternalDB();
  const result = await pool.query(
    `UPDATE organization SET byot = $1 WHERE id = $2 RETURNING id`,
    [byot, orgId],
  );
  return result.rows.length > 0;
}

/**
 * Set the Stripe customer ID for a workspace.
 */
export async function setWorkspaceStripeCustomerId(
  orgId: string,
  stripeCustomerId: string,
): Promise<boolean> {
  const pool = getInternalDB();
  const result = await pool.query(
    `UPDATE organization SET stripe_customer_id = $1 WHERE id = $2 RETURNING id`,
    [stripeCustomerId, orgId],
  );
  return result.rows.length > 0;
}

/**
 * Set the trial end date for a workspace.
 */
export async function setWorkspaceTrialEndsAt(
  orgId: string,
  trialEndsAt: Date,
): Promise<boolean> {
  const pool = getInternalDB();
  const result = await pool.query(
    `UPDATE organization SET trial_ends_at = $1 WHERE id = $2 RETURNING id`,
    [trialEndsAt.toISOString(), orgId],
  );
  return result.rows.length > 0;
}
