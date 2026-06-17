/**
 * Unit coverage for `bulkUpsertEntities`'s all-or-nothing behavior under a
 * transaction-bound executor (#3683).
 *
 * The pooled default path tolerates partial imports (a bad row is logged,
 * skipped, and counted as a failure) — wizard `/save` and the admin import rely
 * on one bad row not sinking the good ones. But when a caller threads its own
 * executor (the /use-demo seed, via `withDemoSeedLock`), the batch is part of
 * that caller's transaction: a row failure has already aborted the transaction
 * in Postgres, so it MUST propagate (rolling the whole seed back) instead of
 * being silently counted as a partial. That is the mechanism that stops the
 * "7-of-13 seed returns a clean 201" bug.
 *
 * No DB is touched: `hasInternalDB()` only reads `DATABASE_URL`, and a supplied
 * executor means the upsert helpers never reach the pool.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { bulkUpsertEntities } from "@atlas/api/lib/semantic/entities";

const rows = [
  { entityType: "entity" as const, name: "users", yamlContent: "table: users\n", connectionId: "__demo__" },
  { entityType: "entity" as const, name: "orders", yamlContent: "table: orders\n", connectionId: "__demo__" },
  { entityType: "entity" as const, name: "events", yamlContent: "table: events\n", connectionId: "__demo__" },
];

describe("bulkUpsertEntities — transactional atomicity (#3683)", () => {
  let savedDbUrl: string | undefined;

  beforeEach(() => {
    savedDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://fake:fake@localhost:5432/fake";
  });

  afterEach(() => {
    if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDbUrl;
  });

  it("re-throws on the first row failure under a transactional executor (no partial count)", async () => {
    let calls = 0;
    const exec = async <T extends Record<string, unknown>>(): Promise<T[]> => {
      calls += 1;
      if (calls === 2) throw new Error("upsert rejected — schema drift");
      return [] as T[];
    };

    await expect(bulkUpsertEntities("org-1", rows, exec)).rejects.toThrow("upsert rejected");
    // Stopped at the failing row — the third was never attempted, and no
    // partial count leaked out for the caller to mistake for success.
    expect(calls).toBe(2);
  });

  it("returns the full count when every row succeeds under a transactional executor", async () => {
    let calls = 0;
    const exec = async <T extends Record<string, unknown>>(): Promise<T[]> => {
      calls += 1;
      return [] as T[];
    };

    const n = await bulkUpsertEntities("org-1", rows, exec);
    expect(n).toBe(3);
    expect(calls).toBe(3);
  });
});
