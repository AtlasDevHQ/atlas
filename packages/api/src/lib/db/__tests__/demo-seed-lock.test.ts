/**
 * Unit coverage for the lock-acquisition + transaction mechanics of
 * `withDemoSeedLock` (#3683) against an injected fake pool — no real Postgres.
 * Mirrors `workspace-admin-locks.test.ts` / `stripe-subscription-lock.test.ts`.
 *
 * Pinned mechanics — the two properties the /use-demo seed depends on:
 *   1. Mutual exclusion — phases 2+3 run inside ONE transaction holding a
 *      per-workspace advisory lock in the #3683 namespace keyed on the org id
 *      (BEGIN → pg_advisory_xact_lock → callback on the locked connection →
 *      COMMIT). Two concurrent same-org seeds serialize on this lock instead of
 *      interleaving `ON CONFLICT DO UPDATE` upserts (which deadlock).
 *   2. Atomicity — a throwing callback ROLLBACKs + releases the client +
 *      re-throws, so a blip between the entity import and the published flip
 *      can never leave half-committed seed state.
 *
 * Real cross-connection serialization is Postgres semantics
 * (`pg_advisory_xact_lock` blocks until the holder commits) and is proved by the
 * route-level wiring in `onboarding.test.ts`.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  _resetPool,
  withDemoSeedLock,
  type InternalPool,
  type InternalPoolClient,
} from "@atlas/api/lib/db/internal";

interface RecordedQuery {
  sql: string;
  params?: unknown[];
}

/** A fake pool that records every query its single client receives. */
function makeRecordingPool(opts: { failLock?: boolean; failRollback?: boolean } = {}): {
  pool: InternalPool;
  queries: RecordedQuery[];
  releases: Array<Error | undefined>;
  connects: { count: number };
} {
  const queries: RecordedQuery[] = [];
  const releases: Array<Error | undefined> = [];
  const connects = { count: 0 };
  const client: InternalPoolClient = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (opts.failLock && sql.includes("pg_advisory_xact_lock")) {
        throw new Error("simulated lock acquisition failure");
      }
      if (opts.failRollback && sql === "ROLLBACK") {
        throw new Error("simulated ROLLBACK failure — dirty socket");
      }
      return { rows: [] as Record<string, unknown>[] };
    },
    release: (err?: Error) => {
      releases.push(err);
    },
  };
  const pool: InternalPool = {
    query: async () => ({ rows: [] as Record<string, unknown>[] }),
    connect: async () => {
      connects.count += 1;
      return client;
    },
    end: async () => {},
    on: () => {},
  };
  return { pool, queries, releases, connects };
}

function lockQueries(queries: RecordedQuery[]): RecordedQuery[] {
  return queries.filter((q) => q.sql.includes("pg_advisory_xact_lock"));
}

describe("withDemoSeedLock — lock + transaction mechanics (#3683)", () => {
  afterEach(() => {
    _resetPool(null, null);
  });

  it("brackets the callback with BEGIN → advisory lock keyed on the org id → COMMIT", async () => {
    const { pool, queries } = makeRecordingPool();
    _resetPool(pool as unknown as InternalPool, null);

    const ran: string[] = [];
    const result = await withDemoSeedLock("org-1", async () => {
      ran.push("callback");
      return 42;
    });

    expect(result).toBe(42);
    expect(ran).toEqual(["callback"]);
    expect(queries[0]?.sql).toBe("BEGIN");
    const locks = lockQueries(queries);
    expect(locks).toHaveLength(1);
    // Distinct two-arg namespace (the issue number) + the org id.
    expect(locks[0]?.params).toEqual([3683, "org-1"]);
    expect(queries.at(-1)?.sql).toBe("COMMIT");
    expect(queries.some((q) => q.sql === "ROLLBACK")).toBe(false);
  });

  it("runs the callback's writes on the locked connection, after the lock is held", async () => {
    const { pool, queries } = makeRecordingPool();
    _resetPool(pool as unknown as InternalPool, null);

    const result = await withDemoSeedLock("org-1", async (tx) => {
      await tx.query("INSERT INTO semantic_entities");
      await tx.query("INSERT INTO workspace_plugins");
      return "seeded";
    });

    expect(result).toBe("seeded");
    const lastLockIdx = queries.findLastIndex((q) => q.sql.includes("pg_advisory_xact_lock"));
    const entityIdx = queries.findIndex((q) => q.sql === "INSERT INTO semantic_entities");
    const flipIdx = queries.findIndex((q) => q.sql === "INSERT INTO workspace_plugins");
    // Both phases run after the lock and before COMMIT, in order.
    expect(entityIdx).toBeGreaterThan(lastLockIdx);
    expect(flipIdx).toBeGreaterThan(entityIdx);
    expect(queries.at(-1)?.sql).toBe("COMMIT");
  });

  it("ROLLBACKs, releases the client, and re-throws when the callback throws (no partial commit)", async () => {
    const { pool, queries, releases } = makeRecordingPool();
    _resetPool(pool as unknown as InternalPool, null);

    const boom = new Error("phase-3 published flip failed");
    await expect(
      withDemoSeedLock("org-1", async (tx) => {
        await tx.query("INSERT INTO semantic_entities");
        throw boom;
      }),
    ).rejects.toBe(boom);

    // The entity write happened on the connection, but the transaction rolled
    // back — nothing is committed, so no orphaned draft entities survive.
    expect(queries.some((q) => q.sql === "ROLLBACK")).toBe(true);
    expect(queries.some((q) => q.sql === "COMMIT")).toBe(false);
    // Rollback succeeded, so the client is released cleanly (no destroy arg).
    expect(releases).toHaveLength(1);
    expect(releases[0]).toBeUndefined();
  });

  it("destroys the client (passes the rollback error to release) when ROLLBACK itself fails — and still re-throws the original error", async () => {
    // The poison-the-client safety path: if ROLLBACK rejects, the connection's
    // socket is dirty and must NOT return to the pool. `withDemoSeedLock` passes
    // the rollback error to `client.release(err)` (node-pg destroys rather than
    // recycles), while still re-throwing the ORIGINAL callback error — the
    // rollback failure is logged, never masks what actually went wrong.
    const { pool, queries, releases } = makeRecordingPool({ failRollback: true });
    _resetPool(pool as unknown as InternalPool, null);

    const boom = new Error("phase-3 published flip failed");
    await expect(
      withDemoSeedLock("org-1", async (tx) => {
        await tx.query("INSERT INTO semantic_entities");
        throw boom;
      }),
    ).rejects.toBe(boom); // original error propagates, not the ROLLBACK failure

    expect(queries.some((q) => q.sql === "ROLLBACK")).toBe(true);
    expect(queries.some((q) => q.sql === "COMMIT")).toBe(false);
    // Client destroyed: release got the rollback error, not undefined.
    expect(releases).toHaveLength(1);
    expect(releases[0]).toBeInstanceOf(Error);
    expect(releases[0]?.message).toContain("simulated ROLLBACK failure");
  });

  it("propagates a lock-acquisition failure — never runs the seed unserialized", async () => {
    const { pool, releases } = makeRecordingPool({ failLock: true });
    _resetPool(pool as unknown as InternalPool, null);

    let callbackRan = false;
    await expect(
      withDemoSeedLock("org-1", async () => {
        callbackRan = true;
      }),
    ).rejects.toThrow("simulated lock acquisition failure");

    expect(callbackRan).toBe(false);
    expect(releases).toHaveLength(1);
  });
});
