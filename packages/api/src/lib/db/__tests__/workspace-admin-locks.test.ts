/**
 * Unit coverage for the lock-acquisition mechanics of `withWorkspaceAdminLocks`
 * (#3166) against an injected fake pool — no real Postgres.
 *
 * The real-Postgres suite (`admin-last-admin-pg.test.ts`) proves the invariant
 * holds under genuine concurrency. This suite pins the two mechanics that make
 * that concurrency safe but which a passing race test can't pin deterministically:
 *   1. Locks are acquired in DEDUPED + SORTED order — the deadlock-avoidance
 *      invariant. A dropped `.sort()` (or `Set` dedupe) would still pass every
 *      real-PG race that happens to enumerate ids in a consistent order, so it
 *      is asserted directly here by capturing the `pg_advisory_xact_lock` params.
 *   2. The transaction brackets the locks (BEGIN → locks → callback → COMMIT),
 *      and a throwing callback ROLLBACKs + destroys the client + re-throws
 *      (never a silent success).
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  _resetPool,
  withWorkspaceAdminLock,
  withWorkspaceAdminLocks,
  type InternalPool,
  type InternalPoolClient,
} from "@atlas/api/lib/db/internal";

interface RecordedQuery {
  sql: string;
  params?: unknown[];
}

/** A fake pool that records every query its single client receives. */
function makeRecordingPool(): {
  pool: InternalPool;
  queries: RecordedQuery[];
  releases: Array<Error | undefined>;
} {
  const queries: RecordedQuery[] = [];
  const releases: Array<Error | undefined> = [];
  const client: InternalPoolClient = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return { rows: [] as Record<string, unknown>[] };
    },
    release: (err?: Error) => {
      releases.push(err);
    },
  };
  const pool: InternalPool = {
    query: async () => ({ rows: [] as Record<string, unknown>[] }),
    connect: async () => client,
    end: async () => {},
    on: () => {},
  };
  return { pool, queries, releases };
}

/** The org-id arg of every `pg_advisory_xact_lock(namespace, hashtext($2))`. */
function lockedOrgIds(queries: RecordedQuery[]): string[] {
  return queries
    .filter((q) => q.sql.includes("pg_advisory_xact_lock"))
    .map((q) => (q.params?.[1] as string) ?? "");
}

describe("withWorkspaceAdminLocks — lock-acquisition mechanics (#3166)", () => {
  afterEach(() => {
    _resetPool(null, null);
  });

  it("acquires locks in deduped + sorted order (deadlock-avoidance invariant)", async () => {
    const { pool, queries } = makeRecordingPool();
    _resetPool(pool as unknown as InternalPool, null);

    // Deliberately unsorted, with a duplicate, so a missing `.sort()` or dedupe
    // would change the captured acquisition order.
    await withWorkspaceAdminLocks(["org-c", "org-a", "org-b", "org-a"], async () => "done");

    expect(lockedOrgIds(queries)).toEqual(["org-a", "org-b", "org-c"]);
    // Bracketed by a single transaction.
    expect(queries[0]?.sql).toBe("BEGIN");
    expect(queries.at(-1)?.sql).toBe("COMMIT");
    expect(queries.some((q) => q.sql === "ROLLBACK")).toBe(false);
  });

  it("runs the callback on the locked connection, after all locks are held", async () => {
    const { pool, queries } = makeRecordingPool();
    _resetPool(pool as unknown as InternalPool, null);

    const result = await withWorkspaceAdminLocks(["org-b", "org-a"], async (tx) => {
      await tx.query("SELECT 1 AS sentinel");
      return 42;
    });

    expect(result).toBe(42);
    const sentinelIdx = queries.findIndex((q) => q.sql === "SELECT 1 AS sentinel");
    const lastLockIdx = queries.map((q) => q.sql).lastIndexOf(
      queries.filter((q) => q.sql.includes("pg_advisory_xact_lock")).at(-1)?.sql ?? "",
    );
    expect(sentinelIdx).toBeGreaterThan(lastLockIdx); // callback runs after locks
    expect(queries.at(-1)?.sql).toBe("COMMIT");
  });

  it("the single-workspace wrapper takes exactly one lock", async () => {
    const { pool, queries } = makeRecordingPool();
    _resetPool(pool as unknown as InternalPool, null);

    await withWorkspaceAdminLock("org-solo", async () => "ok");

    expect(lockedOrgIds(queries)).toEqual(["org-solo"]);
  });

  it("opens the transaction but takes no lock for an empty id set", async () => {
    const { pool, queries } = makeRecordingPool();
    _resetPool(pool as unknown as InternalPool, null);

    const result = await withWorkspaceAdminLocks([], async () => "empty-ok");

    expect(result).toBe("empty-ok");
    expect(lockedOrgIds(queries)).toEqual([]);
    expect(queries[0]?.sql).toBe("BEGIN");
    expect(queries.at(-1)?.sql).toBe("COMMIT");
  });

  it("ROLLBACKs, releases the client, and re-throws when the callback throws (no silent success)", async () => {
    const { pool, queries, releases } = makeRecordingPool();
    _resetPool(pool as unknown as InternalPool, null);

    const boom = new Error("guard decided to abort");
    await expect(
      withWorkspaceAdminLocks(["org-a"], async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(queries.some((q) => q.sql === "ROLLBACK")).toBe(true);
    expect(queries.some((q) => q.sql === "COMMIT")).toBe(false);
    // Rollback succeeded here, so the client is released cleanly (no destroy arg).
    expect(releases).toHaveLength(1);
    expect(releases[0]).toBeUndefined();
  });
});
