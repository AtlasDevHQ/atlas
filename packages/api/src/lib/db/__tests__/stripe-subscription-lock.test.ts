/**
 * Unit coverage for the lock-acquisition mechanics of
 * `withStripeSubscriptionLock` (#3445) against an injected fake pool — no
 * real Postgres. Mirrors `workspace-admin-locks.test.ts`.
 *
 * Pinned mechanics:
 *   1. The transaction brackets the lock (BEGIN → pg_advisory_xact_lock in
 *      the #3445 namespace keyed on the subscription id → callback →
 *      COMMIT).
 *   2. A throwing callback ROLLBACKs + releases the client + re-throws —
 *      never a silent success, so `onEvent` still 400s and Stripe
 *      redelivers (record-last stays live).
 *   3. A DB error in the wrapper itself (failed connect/lock) propagates —
 *      no fail-open into an unserialized sync.
 *   4. No subscription id / no internal DB → straight passthrough, no pool
 *      checkout.
 *
 * Real cross-connection serialization is Postgres semantics
 * (`pg_advisory_xact_lock` blocks until the holder commits); the
 * webhook-level wiring is covered in `stripe-webhook-lifecycle.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  _resetPool,
  withStripeSubscriptionLock,
  type InternalPool,
  type InternalPoolClient,
} from "@atlas/api/lib/db/internal";

interface RecordedQuery {
  sql: string;
  params?: unknown[];
}

/** A fake pool that records every query its single client receives. */
function makeRecordingPool(opts: { failLock?: boolean } = {}): {
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

let savedDatabaseUrl: string | undefined;

describe("withStripeSubscriptionLock — lock mechanics (#3445)", () => {
  beforeEach(() => {
    // hasInternalDB() reads DATABASE_URL; the fake pool stands in for the
    // connection it implies.
    savedDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://fake:fake@localhost:5432/fake";
  });

  afterEach(() => {
    _resetPool(null, null);
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
  });

  it("brackets the callback with BEGIN → advisory lock keyed on the subscription id → COMMIT", async () => {
    const { pool, queries } = makeRecordingPool();
    _resetPool(pool as unknown as InternalPool, null);

    const ran: string[] = [];
    const result = await withStripeSubscriptionLock("sub_stripe_1", async () => {
      ran.push("callback");
      return 42;
    });

    expect(result).toBe(42);
    expect(ran).toEqual(["callback"]);
    expect(queries[0]?.sql).toBe("BEGIN");
    const locks = lockQueries(queries);
    expect(locks).toHaveLength(1);
    // Distinct two-arg namespace (the issue number) + the subscription id.
    expect(locks[0]?.params).toEqual([3445, "sub_stripe_1"]);
    expect(queries.at(-1)?.sql).toBe("COMMIT");
    expect(queries.some((q) => q.sql === "ROLLBACK")).toBe(false);
  });

  it("ROLLBACKs, releases the client, and re-throws when the callback throws (record-last stays live)", async () => {
    const { pool, queries, releases } = makeRecordingPool();
    _resetPool(pool as unknown as InternalPool, null);

    const boom = new Error("sync failed — plan tier write rejected");
    await expect(
      withStripeSubscriptionLock("sub_stripe_1", async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(queries.some((q) => q.sql === "ROLLBACK")).toBe(true);
    expect(queries.some((q) => q.sql === "COMMIT")).toBe(false);
    // Rollback succeeded, so the client is released cleanly (no destroy arg).
    expect(releases).toHaveLength(1);
    expect(releases[0]).toBeUndefined();
  });

  it("propagates a lock-acquisition failure — never fails open into an unserialized sync", async () => {
    const { pool, releases } = makeRecordingPool({ failLock: true });
    _resetPool(pool as unknown as InternalPool, null);

    let callbackRan = false;
    await expect(
      withStripeSubscriptionLock("sub_stripe_1", async () => {
        callbackRan = true;
      }),
    ).rejects.toThrow("simulated lock acquisition failure");

    expect(callbackRan).toBe(false);
    expect(releases).toHaveLength(1);
  });

  it("passes through without a pool checkout when the event has no subscription id", async () => {
    const { pool, connects } = makeRecordingPool();
    _resetPool(pool as unknown as InternalPool, null);

    const result = await withStripeSubscriptionLock(null, async () => "no-lock");

    expect(result).toBe("no-lock");
    expect(connects.count).toBe(0);
  });

  it("passes through without a pool checkout when there is no internal DB", async () => {
    const { pool, connects } = makeRecordingPool();
    _resetPool(pool as unknown as InternalPool, null);
    delete process.env.DATABASE_URL;

    const result = await withStripeSubscriptionLock("sub_stripe_1", async () => "no-db");

    expect(result).toBe("no-db");
    expect(connects.count).toBe(0);
  });
});
