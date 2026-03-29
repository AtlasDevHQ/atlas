/**
 * PostgreSQL state adapter for Chat SDK.
 *
 * Persists thread subscriptions, distributed locks, and key-value/list cache
 * to Atlas's internal PostgreSQL database. Tables are created idempotently
 * on first connect() with CREATE TABLE IF NOT EXISTS statements.
 *
 * Uses the plugin DB context (AtlasPluginContext["db"]) — never imports
 * from @atlas/api directly.
 */

import { randomUUID } from "crypto";
import type { StateAdapter, Lock, QueueEntry } from "chat";
import type { PluginDB } from "./types";

const DEFAULT_PREFIX = "chat_";

/** Only letters, numbers, and underscores — must start with letter or underscore. */
const SAFE_PREFIX_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export interface PgAdapterOptions {
  /** Table name prefix. Default: "chat_" */
  tablePrefix?: string;
}

export class PgStateAdapter implements StateAdapter {
  private readonly prefix: string;
  private readonly db: PluginDB;
  private connected = false;

  constructor(db: PluginDB, options?: PgAdapterOptions) {
    this.db = db;
    const prefix = options?.tablePrefix ?? DEFAULT_PREFIX;
    if (!SAFE_PREFIX_RE.test(prefix)) {
      throw new Error(
        `Invalid tablePrefix "${prefix}" — must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`,
      );
    }
    this.prefix = prefix;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.ensureTables();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  // ---------------------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------------------

  async subscribe(threadId: string): Promise<void> {
    this.assertConnected();
    await this.db.query(
      `INSERT INTO ${this.t("subscriptions")} (thread_id)
       VALUES ($1) ON CONFLICT (thread_id) DO NOTHING`,
      [threadId],
    );
  }

  async unsubscribe(threadId: string): Promise<void> {
    this.assertConnected();
    await this.db.query(
      `DELETE FROM ${this.t("subscriptions")} WHERE thread_id = $1`,
      [threadId],
    );
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    this.assertConnected();
    const { rows } = await this.db.query(
      `SELECT 1 FROM ${this.t("subscriptions")} WHERE thread_id = $1`,
      [threadId],
    );
    return rows.length > 0;
  }

  // ---------------------------------------------------------------------------
  // Locks
  // ---------------------------------------------------------------------------

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    this.assertConnected();
    const token = randomUUID();

    // Atomic upsert: inserts new lock, or replaces an expired one.
    // Returns a row only if the lock was acquired.
    const { rows } = await this.db.query(
      `INSERT INTO ${this.t("locks")} (thread_id, token, expires_at)
       VALUES ($1, $2, NOW() + make_interval(secs => $3::double precision / 1000))
       ON CONFLICT (thread_id) DO UPDATE
         SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at
         WHERE ${this.t("locks")}.expires_at <= NOW()
       RETURNING thread_id, token, expires_at`,
      [threadId, token, ttlMs],
    );

    if (rows.length === 0) return null;

    return {
      threadId: String(rows[0].thread_id),
      token: String(rows[0].token),
      expiresAt: new Date(String(rows[0].expires_at)).getTime(),
    };
  }

  async releaseLock(lock: Lock): Promise<void> {
    this.assertConnected();
    await this.db.query(
      `DELETE FROM ${this.t("locks")} WHERE thread_id = $1 AND token = $2`,
      [lock.threadId, lock.token],
    );
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    this.assertConnected();
    const { rows } = await this.db.query(
      `UPDATE ${this.t("locks")}
       SET expires_at = NOW() + make_interval(secs => $3::double precision / 1000)
       WHERE thread_id = $1 AND token = $2 AND expires_at > NOW()
       RETURNING thread_id`,
      [lock.threadId, lock.token, ttlMs],
    );
    if (rows.length > 0) {
      lock.expiresAt = Date.now() + ttlMs;
      return true;
    }
    return false;
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    this.assertConnected();
    await this.db.query(
      `DELETE FROM ${this.t("locks")} WHERE thread_id = $1`,
      [threadId],
    );
  }

  // ---------------------------------------------------------------------------
  // Key-value cache
  // ---------------------------------------------------------------------------

  async get<T = unknown>(key: string): Promise<T | null> {
    this.assertConnected();
    const { rows } = await this.db.query(
      `SELECT value FROM ${this.t("cache")}
       WHERE key = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
      [key],
    );
    if (rows.length === 0) return null;
    return rows[0].value as T;
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.assertConnected();
    const expiresExpr = ttlMs != null
      ? "NOW() + make_interval(secs => $3::double precision / 1000)"
      : "NULL";

    const params: unknown[] = [key, JSON.stringify(value)];
    if (ttlMs != null) params.push(ttlMs);

    await this.db.query(
      `INSERT INTO ${this.t("cache")} (key, value, expires_at)
       VALUES ($1, $2::jsonb, ${expiresExpr})
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
      params,
    );
  }

  async setIfNotExists(
    key: string,
    value: unknown,
    ttlMs?: number,
  ): Promise<boolean> {
    this.assertConnected();
    const expiresExpr = ttlMs != null
      ? "NOW() + make_interval(secs => $3::double precision / 1000)"
      : "NULL";

    const params: unknown[] = [key, JSON.stringify(value)];
    if (ttlMs != null) params.push(ttlMs);

    // Atomic: clean expired entry + insert in a single statement via CTE
    const { rows } = await this.db.query(
      `WITH cleanup AS (
         DELETE FROM ${this.t("cache")}
         WHERE key = $1 AND expires_at IS NOT NULL AND expires_at <= NOW()
       )
       INSERT INTO ${this.t("cache")} (key, value, expires_at)
       VALUES ($1, $2::jsonb, ${expiresExpr})
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
      params,
    );

    return rows.length > 0;
  }

  async delete(key: string): Promise<void> {
    this.assertConnected();
    await this.db.query(
      `DELETE FROM ${this.t("cache")} WHERE key = $1`,
      [key],
    );
  }

  // ---------------------------------------------------------------------------
  // List operations
  // ---------------------------------------------------------------------------

  async appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number },
  ): Promise<void> {
    this.assertConnected();
    const expiresExpr = options?.ttlMs != null
      ? "NOW() + make_interval(secs => $3::double precision / 1000)"
      : "NULL";

    const jsonValue = JSON.stringify(value);
    const params: unknown[] = [key, jsonValue];
    if (options?.ttlMs != null) params.push(options.ttlMs);

    // Upsert: create new single-element array or append to existing
    const conflictExpires = options?.ttlMs != null
      ? "EXCLUDED.expires_at"
      : `${this.t("cache")}.expires_at`;

    await this.db.query(
      `INSERT INTO ${this.t("cache")} (key, value, expires_at)
       VALUES ($1, jsonb_build_array($2::jsonb), ${expiresExpr})
       ON CONFLICT (key) DO UPDATE
         SET value = ${this.t("cache")}.value || jsonb_build_array($2::jsonb),
             expires_at = ${conflictExpires}`,
      params,
    );

    // Trim to maxLength if needed (keeps newest entries)
    if (options?.maxLength != null) {
      const trimParam = options.ttlMs != null ? "$4" : "$3";
      const trimParams = [...params, options.maxLength];

      await this.db.query(
        `UPDATE ${this.t("cache")}
         SET value = (
           SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb) FROM (
             SELECT elem, ord
             FROM jsonb_array_elements(value) WITH ORDINALITY AS t(elem, ord)
             ORDER BY ord DESC
             LIMIT ${trimParam}::int
           ) sub
         )
         WHERE key = $1
           AND jsonb_array_length(value) > ${trimParam}::int`,
        trimParams,
      );
    }
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    this.assertConnected();
    const { rows } = await this.db.query(
      `SELECT value FROM ${this.t("cache")}
       WHERE key = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
      [key],
    );
    if (rows.length === 0) return [];
    const arr = rows[0].value;
    if (!Array.isArray(arr)) {
      console.debug(
        `[chat-state] getList: stored value for key "${key}" is not an array — returning empty`,
      );
      return [];
    }
    return arr as T[];
  }

  // ---------------------------------------------------------------------------
  // Queue operations
  // ---------------------------------------------------------------------------

  async enqueue(
    threadId: string,
    entry: QueueEntry,
    maxSize: number,
  ): Promise<number> {
    this.assertConnected();
    const key = `__queue:${threadId}`;
    const json = JSON.stringify(entry);

    // Append entry to the queue array, then trim to maxSize (keep newest)
    await this.db.query(
      `INSERT INTO ${this.t("cache")} (key, value)
       VALUES ($1, jsonb_build_array($2::jsonb))
       ON CONFLICT (key) DO UPDATE
         SET value = ${this.t("cache")}.value || jsonb_build_array($2::jsonb)`,
      [key, json],
    );

    // Trim to maxSize if exceeded
    await this.db.query(
      `UPDATE ${this.t("cache")}
       SET value = (
         SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb) FROM (
           SELECT elem, ord
           FROM jsonb_array_elements(value) WITH ORDINALITY AS t(elem, ord)
           ORDER BY ord DESC
           LIMIT $2::int
         ) sub
       )
       WHERE key = $1 AND jsonb_array_length(value) > $2::int`,
      [key, maxSize],
    );

    const { rows } = await this.db.query(
      `SELECT jsonb_array_length(value) AS depth FROM ${this.t("cache")} WHERE key = $1`,
      [key],
    );
    return rows.length > 0 ? Number(rows[0].depth) : 0;
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    this.assertConnected();
    const key = `__queue:${threadId}`;

    // Read the first element, then remove it
    const { rows: peekRows } = await this.db.query(
      `SELECT value->0 AS entry FROM ${this.t("cache")}
       WHERE key = $1 AND jsonb_array_length(value) > 0`,
      [key],
    );

    if (peekRows.length === 0) return null;

    // Remove the first element
    await this.db.query(
      `UPDATE ${this.t("cache")}
       SET value = CASE
         WHEN jsonb_array_length(value) <= 1 THEN '[]'::jsonb
         ELSE value - 0
       END
       WHERE key = $1`,
      [key],
    );

    const entry = peekRows[0].entry as QueueEntry | null;
    if (!entry) return null;

    // Skip expired entries
    if (entry.expiresAt < Date.now()) {
      return this.dequeue(threadId);
    }

    return entry;
  }

  async queueDepth(threadId: string): Promise<number> {
    this.assertConnected();
    const key = `__queue:${threadId}`;
    const { rows } = await this.db.query(
      `SELECT jsonb_array_length(value) AS depth FROM ${this.t("cache")}
       WHERE key = $1`,
      [key],
    );
    return rows.length > 0 ? Number(rows[0].depth) : 0;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Prefixed table name. */
  private t(name: string): string {
    return `${this.prefix}${name}`;
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new Error("PG state adapter not connected — call connect() first");
    }
  }

  /** Create tables idempotently on first connection. */
  private async ensureTables(): Promise<void> {
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${this.t("subscriptions")} (
        thread_id TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${this.t("locks")} (
        thread_id TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      )
    `);

    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_${this.prefix}locks_expires
       ON ${this.t("locks")} (expires_at)`,
    );

    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${this.t("cache")} (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        expires_at TIMESTAMPTZ
      )
    `);

    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_${this.prefix}cache_expires
       ON ${this.t("cache")} (expires_at) WHERE expires_at IS NOT NULL`,
    );
  }
}

/** Create a PG-backed state adapter using the plugin DB context. */
export function createPgAdapter(
  db: PluginDB,
  options?: PgAdapterOptions,
): PgStateAdapter {
  return new PgStateAdapter(db, options);
}
