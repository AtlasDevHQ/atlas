/**
 * Tests for the Atlas internal database module (src/lib/db/internal.ts).
 *
 * Uses _resetPool(mockPool) to inject a mock pool instance, avoiding
 * the need to mock the pg module (which is require()'d lazily).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  hasInternalDB,
  getInternalDB,
  closeInternalDB,
  internalQuery,
  internalExecute,
  migrateInternalDB,
  loadSavedConnections,
  _resetPool,
  _resetCircuitBreaker,
  encryptUrl,
  decryptUrl,
  getEncryptionKey,
  isPlaintextUrl,
  _resetEncryptionKeyCache,
} from "../internal";
import { connections } from "../connection";

/** Creates a mock pool that tracks query/end calls. */
function createMockPool() {
  const calls = {
    queries: [] as { sql: string; params?: unknown[] }[],
    endCount: 0,
    onEvents: [] as { event: "error"; listener: (err: Error) => void }[],
  };
  let queryResult: { rows: Record<string, unknown>[] } = { rows: [] };
  let queryError: Error | null = null;

  const pool = {
    async query(sql: string, params?: unknown[]) {
      calls.queries.push({ sql, params });
      if (queryError) throw queryError;
      return queryResult;
    },
    async end() {
      calls.endCount++;
    },
    on(event: "error", listener: (err: Error) => void) {
      calls.onEvents.push({ event, listener });
    },
    // Test helpers
    _setResult(result: { rows: Record<string, unknown>[] }) {
      queryResult = result;
    },
    _setError(err: Error | null) {
      queryError = err;
    },
  };

  return { pool, calls };
}

describe("internal DB module", () => {
  const origDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    delete process.env.DATABASE_URL;
    _resetPool();
  });

  afterEach(() => {
    if (origDatabaseUrl !== undefined) {
      process.env.DATABASE_URL = origDatabaseUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
    _resetPool();
  });

  describe("hasInternalDB()", () => {
    it("returns false when DATABASE_URL is not set", () => {
      delete process.env.DATABASE_URL;
      expect(hasInternalDB()).toBe(false);
    });

    it("returns true when DATABASE_URL is set", () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      expect(hasInternalDB()).toBe(true);
    });

    it("returns false for empty string DATABASE_URL", () => {
      process.env.DATABASE_URL = "";
      expect(hasInternalDB()).toBe(false);
    });
  });

  describe("getInternalDB()", () => {
    it("throws when DATABASE_URL is not set", () => {
      expect(() => getInternalDB()).toThrow("DATABASE_URL is not set");
    });

    it("returns injected mock pool", () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool } = createMockPool();
      _resetPool(pool);
      expect(getInternalDB()).toBe(pool);
    });

    it("returns the same pool instance on repeated calls (singleton)", () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool } = createMockPool();
      _resetPool(pool);
      const pool1 = getInternalDB();
      const pool2 = getInternalDB();
      expect(pool1).toBe(pool2);
    });
  });

  describe("internalQuery()", () => {
    it("executes parameterized query and returns typed rows", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool, calls } = createMockPool();
      pool._setResult({ rows: [{ id: "abc", count: 42 }] });
      _resetPool(pool);

      const rows = await internalQuery("SELECT * FROM audit_log WHERE user_id = $1", ["user-1"]);
      expect(rows).toEqual([{ id: "abc", count: 42 }]);
      expect(calls.queries[0]).toEqual({
        sql: "SELECT * FROM audit_log WHERE user_id = $1",
        params: ["user-1"],
      });
    });

    it("works without params", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool } = createMockPool();
      pool._setResult({ rows: [{ n: 1 }] });
      _resetPool(pool);

      const rows = await internalQuery("SELECT 1 AS n");
      expect(rows).toEqual([{ n: 1 }]);
    });

    it("propagates query errors", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool } = createMockPool();
      pool._setError(new Error("relation does not exist"));
      _resetPool(pool);

      await expect(internalQuery("SELECT * FROM missing")).rejects.toThrow(
        "relation does not exist",
      );
    });
  });

  describe("internalExecute()", () => {
    it("executes fire-and-forget query", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool, calls } = createMockPool();
      _resetPool(pool);

      internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      await new Promise((r) => setTimeout(r, 10));
      expect(calls.queries.length).toBe(1);
      expect(calls.queries[0].sql).toBe("INSERT INTO audit_log (auth_mode) VALUES ($1)");
    });

    it("does not throw on query error (logs instead)", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool } = createMockPool();
      pool._setError(new Error("connection lost"));
      _resetPool(pool);

      // Should not throw
      internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      await new Promise((r) => setTimeout(r, 10));
      // Error was swallowed — no exception propagated
    });

    it("handles non-Error thrown values without crashing", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool: mockPool } = createMockPool();
      // Override query to throw a string instead of an Error
      const pool = {
        ...mockPool,
        async query() {
          throw "string error";
        },
      };
      _resetPool(pool);

      // Should not throw
      internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      await new Promise((r) => setTimeout(r, 10));
      // String error was handled gracefully — no exception propagated
    });
  });

  describe("migrateInternalDB()", () => {
    it("executes CREATE TABLE and CREATE INDEX statements for all tables", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool, calls } = createMockPool();
      _resetPool(pool);

      await migrateInternalDB();
      // 101 base queries + 1 org table existence check (workspace ALTER TABLEs
      // are skipped because mock pool returns empty rows for the check)
      // Includes: SSO enforcement column ALTER TABLE (sso_enforced)
      expect(calls.queries.length).toBe(101);
      expect(calls.queries[0].sql).toContain("CREATE TABLE IF NOT EXISTS audit_log");
      expect(calls.queries[1].sql).toContain("idx_audit_log_timestamp");
      expect(calls.queries[2].sql).toContain("idx_audit_log_user_id");
      expect(calls.queries[3].sql).toContain("CREATE TABLE IF NOT EXISTS conversations");
      expect(calls.queries[4].sql).toContain("idx_conversations_user");
      expect(calls.queries[5].sql).toContain("CREATE TABLE IF NOT EXISTS messages");
      expect(calls.queries[6].sql).toContain("idx_messages_conversation");
      expect(calls.queries[7].sql).toContain("CREATE TABLE IF NOT EXISTS slack_installations");
      expect(calls.queries[8].sql).toContain("CREATE TABLE IF NOT EXISTS slack_threads");
      expect(calls.queries[9].sql).toContain("idx_slack_threads_conversation");
      expect(calls.queries[10].sql).toContain("CREATE TABLE IF NOT EXISTS action_log");
      expect(calls.queries[11].sql).toContain("idx_action_log_requested_by");
      expect(calls.queries[12].sql).toContain("idx_action_log_status");
      expect(calls.queries[13].sql).toContain("idx_action_log_action_type");
      expect(calls.queries[14].sql).toContain("idx_action_log_conversation");
      expect(calls.queries[15].sql).toContain("ADD COLUMN IF NOT EXISTS source_id");
      expect(calls.queries[16].sql).toContain("idx_audit_log_source_id");
      expect(calls.queries[17].sql).toContain("tables_accessed JSONB");
      expect(calls.queries[18].sql).toContain("idx_audit_log_tables_accessed");
      expect(calls.queries[19].sql).toContain("idx_audit_log_columns_accessed");
      expect(calls.queries[20].sql).toContain("starred BOOLEAN");
      expect(calls.queries[21].sql).toContain("idx_conversations_starred");
      expect(calls.queries[22].sql).toContain("share_token");
      expect(calls.queries[23].sql).toContain("idx_conversations_share_token");
      expect(calls.queries[24].sql).toContain("share_mode");
      expect(calls.queries[25].sql).toContain("chk_share_mode");
      expect(calls.queries[26].sql).toContain("CREATE TABLE IF NOT EXISTS scheduled_tasks");
      expect(calls.queries[27].sql).toContain("idx_scheduled_tasks_owner");
      expect(calls.queries[28].sql).toContain("idx_scheduled_tasks_enabled");
      expect(calls.queries[29].sql).toContain("idx_scheduled_tasks_next_run");
      expect(calls.queries[30].sql).toContain("CREATE TABLE IF NOT EXISTS scheduled_task_runs");
      expect(calls.queries[31].sql).toContain("idx_scheduled_task_runs_task");
      expect(calls.queries[32].sql).toContain("idx_scheduled_task_runs_status");
      expect(calls.queries[33].sql).toContain("delivery_status");
      expect(calls.queries[34].sql).toContain("CREATE TABLE IF NOT EXISTS connections");
      expect(calls.queries[35].sql).toContain("CREATE TABLE IF NOT EXISTS token_usage");
      expect(calls.queries[36].sql).toContain("idx_token_usage_user_id");
      expect(calls.queries[37].sql).toContain("idx_token_usage_created_at");
      expect(calls.queries[38].sql).toContain("CREATE TABLE IF NOT EXISTS invitations");
      expect(calls.queries[39].sql).toContain("idx_invitations_email");
      expect(calls.queries[40].sql).toContain("idx_invitations_token");
      expect(calls.queries[41].sql).toContain("idx_invitations_status");
      expect(calls.queries[42].sql).toContain("idx_invitations_pending_email");
    });

    it("propagates migration errors", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool } = createMockPool();
      pool._setError(new Error("permission denied"));
      _resetPool(pool);

      await expect(migrateInternalDB()).rejects.toThrow("permission denied");
    });
  });

  describe("closeInternalDB()", () => {
    it("calls pool.end()", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool, calls } = createMockPool();
      _resetPool(pool);
      await closeInternalDB();
      expect(calls.endCount).toBe(1);
    });

    it("is a no-op when no pool exists", async () => {
      await closeInternalDB(); // should not throw
    });

    it("nullifies the singleton (getInternalDB returns a new pool after close)", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool: pool1 } = createMockPool();
      _resetPool(pool1);
      expect(getInternalDB()).toBe(pool1);

      await closeInternalDB();

      // After close, injecting a new pool and calling getInternalDB should return the new one
      const { pool: pool2 } = createMockPool();
      _resetPool(pool2);
      expect(getInternalDB()).toBe(pool2);
      expect(pool2).not.toBe(pool1);
    });
  });

  describe("loadSavedConnections()", () => {
    afterEach(() => {
      connections._reset();
    });

    it("returns 0 when DATABASE_URL is not set", async () => {
      delete process.env.DATABASE_URL;
      expect(await loadSavedConnections()).toBe(0);
    });

    it("loads connections from the DB and registers them", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool } = createMockPool();
      pool._setResult({
        rows: [
          { id: "warehouse", url: "postgresql://host/wh", type: "postgres", description: "Warehouse", schema_name: "analytics" },
          { id: "reporting", url: "postgresql://host/rp", type: "postgres", description: null, schema_name: null },
        ],
      });
      _resetPool(pool);

      const count = await loadSavedConnections();
      expect(count).toBe(2);
      expect(connections.has("warehouse")).toBe(true);
      expect(connections.has("reporting")).toBe(true);
    });

    it("skips individual connection failures without aborting", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool } = createMockPool();
      // Second row has an invalid URL scheme which will throw in register
      pool._setResult({
        rows: [
          { id: "good", url: "postgresql://host/db", type: "postgres", description: null, schema_name: null },
          { id: "bad", url: "badscheme://host/db", type: "unknown", description: null, schema_name: null },
        ],
      });
      _resetPool(pool);

      const count = await loadSavedConnections();
      expect(count).toBe(1);
      expect(connections.has("good")).toBe(true);
      expect(connections.has("bad")).toBe(false);
    });

    it("returns 0 when query throws (table not exist)", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool } = createMockPool();
      pool._setError(new Error("relation \"connections\" does not exist"));
      _resetPool(pool);

      const count = await loadSavedConnections();
      expect(count).toBe(0);
    });
  });

  describe("circuit breaker", () => {
    beforeEach(() => {
      _resetCircuitBreaker();
    });

    it("opens after 5 consecutive failures", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool, calls } = createMockPool();
      pool._setError(new Error("connection refused"));
      _resetPool(pool);

      // Fire 5 failing queries to trip the circuit breaker
      for (let i = 0; i < 5; i++) {
        internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      }
      await new Promise((r) => setTimeout(r, 50));
      expect(calls.queries.length).toBe(5);

      // 6th call should be silently skipped (circuit open)
      internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      await new Promise((r) => setTimeout(r, 10));
      expect(calls.queries.length).toBe(5); // no new query issued
    });

    it("silently skips requests when circuit is open and increments dropped count", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool, calls } = createMockPool();
      pool._setError(new Error("connection refused"));
      _resetPool(pool);

      // Trip the circuit breaker
      for (let i = 0; i < 5; i++) {
        internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      }
      await new Promise((r) => setTimeout(r, 50));

      // Fire several more — all should be dropped
      for (let i = 0; i < 3; i++) {
        internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      }
      await new Promise((r) => setTimeout(r, 10));
      // Still only 5 queries were actually sent to the pool
      expect(calls.queries.length).toBe(5);
    });

    it("recovers after timeout", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool, calls } = createMockPool();
      pool._setError(new Error("connection refused"));
      _resetPool(pool);

      // Trip the circuit breaker
      for (let i = 0; i < 5; i++) {
        internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      }
      await new Promise((r) => setTimeout(r, 50));
      expect(calls.queries.length).toBe(5);

      // Verify circuit is open
      internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      await new Promise((r) => setTimeout(r, 10));
      expect(calls.queries.length).toBe(5);

      // Advance timer to trigger recovery (setTimeout 60s)
      // Use Bun's mock timer approach: we can't easily mock setTimeout here,
      // so we manually reset the circuit breaker to simulate recovery
      _resetCircuitBreaker();

      // Now the pool should accept queries again
      pool._setError(null);
      internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      await new Promise((r) => setTimeout(r, 10));
      expect(calls.queries.length).toBe(6);
    });

    it("_resetCircuitBreaker() clears all circuit state", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool, calls } = createMockPool();
      pool._setError(new Error("connection refused"));
      _resetPool(pool);

      // Trip the circuit breaker
      for (let i = 0; i < 5; i++) {
        internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      }
      await new Promise((r) => setTimeout(r, 50));

      // Circuit is open — queries are dropped
      internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      await new Promise((r) => setTimeout(r, 10));
      expect(calls.queries.length).toBe(5);

      // Reset circuit breaker
      _resetCircuitBreaker();

      // Queries should flow through again
      pool._setError(null);
      internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      await new Promise((r) => setTimeout(r, 10));
      expect(calls.queries.length).toBe(6);
    });

    it("_resetPool() also resets circuit breaker state", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const { pool } = createMockPool();
      pool._setError(new Error("connection refused"));
      _resetPool(pool);

      // Trip the circuit breaker
      for (let i = 0; i < 5; i++) {
        internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      }
      await new Promise((r) => setTimeout(r, 50));

      // Reset pool with a fresh mock — circuit breaker should also be reset
      const { pool: freshPool, calls: freshCalls } = createMockPool();
      _resetPool(freshPool);

      internalExecute("INSERT INTO audit_log (auth_mode) VALUES ($1)", ["none"]);
      await new Promise((r) => setTimeout(r, 10));
      expect(freshCalls.queries.length).toBe(1); // query went through
    });
  });
});

describe("connection URL encryption", () => {
  const origEncKey = process.env.ATLAS_ENCRYPTION_KEY;
  const origAuthSecret = process.env.BETTER_AUTH_SECRET;

  afterEach(() => {
    // Restore env vars and reset cached key
    if (origEncKey !== undefined) process.env.ATLAS_ENCRYPTION_KEY = origEncKey;
    else delete process.env.ATLAS_ENCRYPTION_KEY;
    if (origAuthSecret !== undefined) process.env.BETTER_AUTH_SECRET = origAuthSecret;
    else delete process.env.BETTER_AUTH_SECRET;
    _resetEncryptionKeyCache();
  });

  describe("getEncryptionKey()", () => {
    it("returns null when neither key is set", () => {
      delete process.env.ATLAS_ENCRYPTION_KEY;
      delete process.env.BETTER_AUTH_SECRET;
      expect(getEncryptionKey()).toBeNull();
    });

    it("derives key from ATLAS_ENCRYPTION_KEY", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "my-encryption-key-32-chars-long!";
      delete process.env.BETTER_AUTH_SECRET;
      const key = getEncryptionKey();
      expect(key).not.toBeNull();
      expect(key!.length).toBe(32);
    });

    it("falls back to BETTER_AUTH_SECRET", () => {
      delete process.env.ATLAS_ENCRYPTION_KEY;
      process.env.BETTER_AUTH_SECRET = "my-auth-secret-that-is-long-enough";
      const key = getEncryptionKey();
      expect(key).not.toBeNull();
      expect(key!.length).toBe(32);
    });

    it("ATLAS_ENCRYPTION_KEY takes precedence over BETTER_AUTH_SECRET", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "key-a";
      process.env.BETTER_AUTH_SECRET = "key-b";
      const keyA = getEncryptionKey();

      delete process.env.ATLAS_ENCRYPTION_KEY;
      process.env.BETTER_AUTH_SECRET = "key-a"; // same raw value as ATLAS_ENCRYPTION_KEY
      const keyB = getEncryptionKey();

      // Both derive from "key-a" so they should be identical
      expect(keyA).toEqual(keyB);
    });
  });

  describe("isPlaintextUrl()", () => {
    it("returns true for postgresql:// URLs", () => {
      expect(isPlaintextUrl("postgresql://user:pass@host:5432/db")).toBe(true);
    });

    it("returns true for mysql:// URLs", () => {
      expect(isPlaintextUrl("mysql://user:pass@host:3306/db")).toBe(true);
    });

    it("returns true for postgres:// URLs", () => {
      expect(isPlaintextUrl("postgres://user:pass@host:5432/db")).toBe(true);
    });

    it("returns false for base64 encrypted data", () => {
      expect(isPlaintextUrl("dGVzdA==:dGVzdA==:dGVzdA==")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isPlaintextUrl("")).toBe(false);
    });
  });

  describe("encryptUrl() / decryptUrl() round-trip", () => {
    it("encrypts and decrypts a PostgreSQL URL", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "test-key-for-round-trip-testing!";
      const url = "postgresql://admin:s3cret@db.example.com:5432/analytics";
      const encrypted = encryptUrl(url);

      // Encrypted value should not contain the original URL
      expect(encrypted).not.toBe(url);
      expect(encrypted).not.toContain("admin");
      expect(encrypted).not.toContain("s3cret");

      // Should have iv:authTag:ciphertext format
      const parts = encrypted.split(":");
      expect(parts.length).toBe(3);

      // Decrypt should return the original
      expect(decryptUrl(encrypted)).toBe(url);
    });

    it("encrypts and decrypts a MySQL URL", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "test-key-for-round-trip-testing!";
      const url = "mysql://root:password@127.0.0.1:3306/mydb";
      const encrypted = encryptUrl(url);
      expect(decryptUrl(encrypted)).toBe(url);
    });

    it("handles URLs with special characters in password", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "test-key-for-round-trip-testing!";
      const url = "postgresql://user:p%40ss+word/with=equals@host:5432/db?sslmode=require&options=-c%20search_path%3Dpublic";
      const encrypted = encryptUrl(url);
      expect(decryptUrl(encrypted)).toBe(url);
    });

    it("produces different ciphertexts for the same input (random IV)", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "test-key-for-round-trip-testing!";
      const url = "postgresql://user:pass@host/db";
      const enc1 = encryptUrl(url);
      const enc2 = encryptUrl(url);
      expect(enc1).not.toBe(enc2); // Different IVs
      expect(decryptUrl(enc1)).toBe(url);
      expect(decryptUrl(enc2)).toBe(url);
    });
  });

  describe("plaintext migration", () => {
    it("decryptUrl returns plaintext URLs as-is", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "test-key-for-plaintext-migration";
      const url = "postgresql://user:pass@host:5432/db";
      expect(decryptUrl(url)).toBe(url);
    });

    it("decryptUrl handles mysql:// plaintext", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "test-key-for-plaintext-migration";
      const url = "mysql://user:pass@host:3306/db";
      expect(decryptUrl(url)).toBe(url);
    });
  });

  describe("missing encryption key", () => {
    it("encryptUrl returns plaintext when no key is available", () => {
      delete process.env.ATLAS_ENCRYPTION_KEY;
      delete process.env.BETTER_AUTH_SECRET;
      const url = "postgresql://user:pass@host/db";
      expect(encryptUrl(url)).toBe(url);
    });

    it("decryptUrl returns plaintext URLs when no key is available", () => {
      delete process.env.ATLAS_ENCRYPTION_KEY;
      delete process.env.BETTER_AUTH_SECRET;
      const url = "postgresql://user:pass@host/db";
      expect(decryptUrl(url)).toBe(url);
    });

    it("decryptUrl throws when encountering encrypted data without a key", () => {
      // Encrypt with a key first
      process.env.ATLAS_ENCRYPTION_KEY = "temp-key-for-this-test!!!!!!!!!!!";
      const url = "postgresql://user:pass@host/db";
      const encrypted = encryptUrl(url);

      // Now remove the key — decryptUrl should throw, not return garbage
      delete process.env.ATLAS_ENCRYPTION_KEY;
      delete process.env.BETTER_AUTH_SECRET;
      _resetEncryptionKeyCache();
      expect(() => decryptUrl(encrypted)).toThrow("Cannot decrypt connection URL: no encryption key available");
    });
  });

  describe("corrupted data", () => {
    it("throws on tampered ciphertext", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "test-key-for-corruption-testing!";
      const url = "postgresql://user:pass@host/db";
      const encrypted = encryptUrl(url);
      const parts = encrypted.split(":");
      // Tamper with the ciphertext
      parts[2] = "AAAA" + parts[2].slice(4);
      const tampered = parts.join(":");
      expect(() => decryptUrl(tampered)).toThrow("Failed to decrypt connection URL");
    });

    it("throws on wrong encryption key", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "key-one-for-encryption-testing!!";
      const url = "postgresql://user:pass@host/db";
      const encrypted = encryptUrl(url);

      process.env.ATLAS_ENCRYPTION_KEY = "key-two-for-encryption-testing!!";
      expect(() => decryptUrl(encrypted)).toThrow("Failed to decrypt connection URL");
    });

    it("throws on non-base64 3-part string that is not a URL", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "test-key-for-corruption-testing!";
      // 3 colon-separated parts but not valid encrypted data
      expect(() => decryptUrl("foo:bar:baz")).toThrow("Failed to decrypt connection URL");
    });

    it("throws on tampered auth tag", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "test-key-for-corruption-testing!";
      const url = "postgresql://user:pass@host/db";
      const encrypted = encryptUrl(url);
      const parts = encrypted.split(":");
      // Tamper with the auth tag (part[1])
      parts[1] = "AAAA" + parts[1].slice(4);
      const tampered = parts.join(":");
      expect(() => decryptUrl(tampered)).toThrow("Failed to decrypt connection URL");
    });

    it("throws on non-3-part format when value is not a URL", () => {
      process.env.ATLAS_ENCRYPTION_KEY = "test-key-for-corruption-testing!";
      // 2 parts — not a URL, not 3-part encrypted format
      expect(() => decryptUrl("some:garbage")).toThrow("unrecognized format");
    });
  });

  describe("loadSavedConnections() with encryption", () => {
    const origDatabaseUrl = process.env.DATABASE_URL;

    beforeEach(() => {
      delete process.env.DATABASE_URL;
      _resetPool();
    });

    afterEach(() => {
      if (origDatabaseUrl !== undefined) process.env.DATABASE_URL = origDatabaseUrl;
      else delete process.env.DATABASE_URL;
      _resetPool();
      connections._reset();
    });

    it("decrypts encrypted URLs when loading connections", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      process.env.ATLAS_ENCRYPTION_KEY = "test-key-for-load-connections!!!";

      const realUrl = "postgresql://admin:secret@warehouse.example.com:5432/wh";
      const encryptedUrl = encryptUrl(realUrl);

      const { pool } = createMockPool();
      pool._setResult({
        rows: [
          { id: "warehouse", url: encryptedUrl, type: "postgres", description: "Warehouse", schema_name: null },
        ],
      });
      _resetPool(pool);

      const count = await loadSavedConnections();
      expect(count).toBe(1);
      expect(connections.has("warehouse")).toBe(true);
    });

    it("skips connections with undecryptable URLs without blocking others", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      process.env.ATLAS_ENCRYPTION_KEY = "test-key-for-load-connections!!!";

      const goodUrl = "postgresql://admin:secret@warehouse.example.com:5432/wh";
      const goodEncrypted = encryptUrl(goodUrl);

      // Encrypted with a different key — will fail to decrypt
      process.env.ATLAS_ENCRYPTION_KEY = "different-key-that-wont-work!!!!";
      _resetEncryptionKeyCache();
      const badEncrypted = encryptUrl("postgresql://host/bad");

      // Restore the original key
      process.env.ATLAS_ENCRYPTION_KEY = "test-key-for-load-connections!!!";
      _resetEncryptionKeyCache();

      const { pool } = createMockPool();
      pool._setResult({
        rows: [
          { id: "good-conn", url: goodEncrypted, type: "postgres", description: null, schema_name: null },
          { id: "bad-conn", url: badEncrypted, type: "postgres", description: null, schema_name: null },
        ],
      });
      _resetPool(pool);

      const count = await loadSavedConnections();
      expect(count).toBe(1);
      expect(connections.has("good-conn")).toBe(true);
      expect(connections.has("bad-conn")).toBe(false);
    });

    it("handles plaintext URLs (migration path) during load", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      process.env.ATLAS_ENCRYPTION_KEY = "test-key-for-load-connections!!!";

      const { pool } = createMockPool();
      pool._setResult({
        rows: [
          { id: "legacy", url: "postgresql://host/db", type: "postgres", description: null, schema_name: null },
        ],
      });
      _resetPool(pool);

      const count = await loadSavedConnections();
      expect(count).toBe(1);
      expect(connections.has("legacy")).toBe(true);
    });
  });
});
