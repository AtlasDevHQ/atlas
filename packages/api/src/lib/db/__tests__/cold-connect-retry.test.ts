/**
 * Tests for the cold-connect retry on core PostgreSQL / MySQL pools (#3867).
 *
 * The first analytical query after the API (re)deploys can transiently fail
 * while the pool is cold: the first `pool.connect()` / `pool.getConnection()`
 * rejects with a connection-establishment error, which previously surfaced as a
 * bare "Query failed." even though an immediate retry succeeded. The acquire
 * step now retries exactly ONCE on a transient connect failure — but never on a
 * query-execution error, and a persistent connect failure still throws.
 *
 * These tests exercise the two policy primitives directly:
 *   - `isTransientConnectError` — which acquire failures are retryable.
 *   - `acquireWithColdConnectRetry` — the at-most-one-retry wrapper that
 *     `createPostgresDB.query()` / `createMySQLDB.query()` apply to the acquire
 *     step only.
 *
 * Testing the primitives (rather than mocking `pg`/`mysql2`) is deliberate: the
 * cache-busting `import(...?t=)` needed to bypass the global
 * `@atlas/api/lib/db/connection` mock registered by `sql.test.ts` also bypasses
 * `mock.module("pg")`, so a real pg Pool would back any config-registered
 * connection — the same cache-bust pattern as `tenant-pool.test.ts`, used here
 * for a different end (its note explains the same mock-bypass). The primitives
 * are pure/injectable, so they pin the actual retry semantics without that
 * mock-interaction fragility.
 */
import { describe, it, expect } from "bun:test";
import { resolve } from "path";

// Cache-busting import bypasses sql.test.ts's global connection mock.
const connModPath = resolve(__dirname, "../connection.ts");
const connMod = await import(`${connModPath}?t=${Date.now()}`);
const isTransientConnectError = connMod.isTransientConnectError as (err: unknown) => boolean;
const acquireWithColdConnectRetry = connMod.acquireWithColdConnectRetry as <T>(
  acquire: () => Promise<T>,
  context: { dbType: string; targetHost?: string },
) => Promise<T>;

function makeError(message: string, code?: string): Error {
  const err = new Error(message) as Error & { code?: string };
  if (code) err.code = code;
  return err;
}

const PG_CTX = { dbType: "postgres", targetHost: "db.example.com" };

describe("isTransientConnectError (#3867)", () => {
  it("matches transient Node socket error codes", () => {
    for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "EAI_AGAIN"]) {
      expect(isTransientConnectError(makeError("boom", code))).toBe(true);
    }
  });

  it("matches transient mysql2 driver codes", () => {
    expect(isTransientConnectError(makeError("Connection lost", "PROTOCOL_CONNECTION_LOST"))).toBe(true);
    expect(isTransientConnectError(makeError("Too many connections", "ER_CON_COUNT_ERROR"))).toBe(true);
  });

  it("matches connect-timeout messages that carry no stable code", () => {
    expect(isTransientConnectError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isTransientConnectError(new Error("Connection terminated due to connection timeout"))).toBe(true);
    expect(isTransientConnectError(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(isTransientConnectError(new Error("connect ETIMEDOUT"))).toBe(true);
    expect(isTransientConnectError(new Error("The server closed the connection"))).toBe(true);
  });

  it("does NOT match query-execution / auth / permission errors", () => {
    expect(isTransientConnectError(makeError("password authentication failed for user", "28P01"))).toBe(false);
    expect(isTransientConnectError(makeError('relation "x" does not exist', "42P01"))).toBe(false);
    expect(isTransientConnectError(makeError("Access denied for user", "ER_ACCESS_DENIED_ERROR"))).toBe(false);
    expect(isTransientConnectError(makeError("canceling statement due to statement timeout", "57014"))).toBe(false);
  });

  it("does NOT match non-error / unknown shapes", () => {
    expect(isTransientConnectError(undefined)).toBe(false);
    expect(isTransientConnectError(null)).toBe(false);
    expect(isTransientConnectError("ECONNREFUSED")).toBe(false); // a bare string has no .code and isn't an Error
    expect(isTransientConnectError({ foo: "bar" })).toBe(false);
  });
});

describe("acquireWithColdConnectRetry (#3867)", () => {
  it("returns immediately when the first acquire succeeds (no retry)", async () => {
    let calls = 0;
    const result = await acquireWithColdConnectRetry(async () => {
      calls++;
      return "client";
    }, PG_CTX);
    expect(result).toBe("client");
    expect(calls).toBe(1);
  });

  it("retries once and succeeds after a transient cold-connect failure", async () => {
    let calls = 0;
    const result = await acquireWithColdConnectRetry(async () => {
      calls++;
      if (calls === 1) throw makeError("connect ECONNREFUSED 10.0.0.1:5432", "ECONNREFUSED");
      return "client";
    }, PG_CTX);
    expect(result).toBe("client");
    expect(calls).toBe(2); // exactly one retry
  });

  it("retries on a connect-timeout message that has no code", async () => {
    let calls = 0;
    const result = await acquireWithColdConnectRetry(async () => {
      calls++;
      if (calls === 1) throw new Error("Connection terminated due to connection timeout");
      return "client";
    }, { dbType: "mysql" });
    expect(result).toBe("client");
    expect(calls).toBe(2);
  });

  it("does NOT retry a non-transient acquire failure — re-throws as-is", async () => {
    let calls = 0;
    await expect(
      acquireWithColdConnectRetry(async () => {
        calls++;
        throw makeError("password authentication failed for user", "28P01");
      }, PG_CTX),
    ).rejects.toThrow("password authentication failed");
    expect(calls).toBe(1); // no retry
  });

  it("re-throws when both attempts fail transiently (persistent outage)", async () => {
    let calls = 0;
    await expect(
      acquireWithColdConnectRetry(async () => {
        calls++;
        throw makeError("connect ECONNREFUSED", "ECONNREFUSED");
      }, PG_CTX),
    ).rejects.toThrow("ECONNREFUSED");
    expect(calls).toBe(2); // first + single retry, then give up
  });

  it("surfaces the SECOND failure when the retry fails with a different error", async () => {
    let calls = 0;
    await expect(
      acquireWithColdConnectRetry(async () => {
        calls++;
        if (calls === 1) throw makeError("connect ETIMEDOUT", "ETIMEDOUT");
        throw makeError("password authentication failed", "28P01");
      }, PG_CTX),
    ).rejects.toThrow("password authentication failed");
    expect(calls).toBe(2);
  });
});
