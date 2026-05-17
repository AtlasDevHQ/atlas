/**
 * Tests for the `createDashboard` agent tool (#2369).
 *
 * Carries over the spike's validation-pattern coverage (per-card validation,
 * error envelopes, secret redaction in unexpected throws) AND adds the
 * transactional-rollback / draft-persistence assertions the reframe
 * introduced:
 *
 *  - Per-card SQL validation runs before any transaction opens.
 *  - Any invalid card rejects the whole call (no half-built dashboard).
 *  - Successful calls run BEGIN → INSERT dashboards → INSERT
 *    dashboard_user_drafts → COMMIT in order.
 *  - If the draft INSERT fails the dashboard INSERT is rolled back
 *    (ROLLBACK fires; no dangling dashboard row).
 *  - `owner_id` / `org_id` come from the request context's user — the
 *    agent has NO way to spoof them.
 *  - Unexpected throws return a sanitized error (never leak the raw
 *    message into the tool envelope).
 *  - Anonymous (no user) chats refuse to create.
 *  - No internal DB also refuses to create.
 */

import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { _resetPool, type InternalPool, type InternalPoolClient } from "../../db/internal";
import { withRequestContext } from "../../logger";
import { createAtlasUser } from "../../auth/types";

// Mock SQL validator BEFORE importing the tool (sync factory — bun's
// mock.module deadlocks on async; see feedback_bun_test_async_mock_module.md).
const validateSQLMock = mock(async (sql: string, _connectionId?: string) => {
  if (/drop|insert|update|delete/i.test(sql)) {
    return { valid: false as const, error: "SQL must be SELECT-only." };
  }
  if (/forbidden_table/i.test(sql)) {
    return { valid: false as const, error: 'Table "forbidden_table" is not in the semantic layer.' };
  }
  return { valid: true as const, classification: { tablesAccessed: [], columnsAccessed: [] } };
});

mock.module("@atlas/api/lib/tools/sql", () => ({
  validateSQL: validateSQLMock,
  executeSQL: undefined as never,
  runUserQueryPipeline: undefined as never,
}));

const { createDashboard } = await import("@atlas/api/lib/tools/create-dashboard");

// ---------------------------------------------------------------------------
// Mock Postgres pool — distinguishes pool.query() from client.query() so the
// test can assert the transaction sequence ran on a single dedicated client.
// ---------------------------------------------------------------------------

interface QueryRow {
  rows: Record<string, unknown>[];
}

let poolQueryCalls: { sql: string; params?: unknown[] }[] = [];
let clientQueryCalls: { sql: string; params?: unknown[] }[] = [];
let clientQueryResults: QueryRow[] = [];
let clientQueryResultIndex = 0;
let connectCalls = 0;
let clientReleased = false;
let clientReleaseErr: Error | undefined;
/**
 * When set, the client's nth `query()` call throws the corresponding error
 * (1-indexed). Lets us simulate "INSERT dashboards succeeded, INSERT draft
 * blew up" and assert ROLLBACK fires.
 */
let clientThrowOnCall: Map<number, Error> = new Map();
let clientQueryCount = 0;

const mockPool: InternalPool = {
  async query(sql: string, params?: unknown[]) {
    poolQueryCalls.push({ sql, params });
    return { rows: [] };
  },
  async connect(): Promise<InternalPoolClient> {
    connectCalls++;
    return {
      async query(sql: string, params?: unknown[]) {
        clientQueryCount++;
        clientQueryCalls.push({ sql, params });
        const errToThrow = clientThrowOnCall.get(clientQueryCount);
        if (errToThrow) throw errToThrow;
        const result = clientQueryResults[clientQueryResultIndex] ?? { rows: [] };
        clientQueryResultIndex++;
        return result;
      },
      release(err?: Error) {
        clientReleased = true;
        clientReleaseErr = err;
      },
    };
  },
  async end() {},
  on() {},
};

function enableInternalDB() {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  _resetPool(mockPool);
}

function setClientResults(...results: QueryRow[]) {
  clientQueryResults = results;
  clientQueryResultIndex = 0;
}

// Test user — what `getRequestContext().user` returns. Active org is set so
// the tool emits a non-null `org_id`.
const TEST_USER = createAtlasUser("user-1", "managed", "Test", {
  activeOrganizationId: "org-1",
});

// Wrap an execute call inside a withRequestContext so the tool's
// getRequestContext() sees the test user.
async function runInCtx<T>(fn: () => Promise<T>): Promise<T> {
  return withRequestContext(
    { requestId: "test-req", user: TEST_USER },
    fn,
  );
}

type ExecuteFn = NonNullable<typeof createDashboard.execute>;
type ExecuteParams = Parameters<ExecuteFn>[0];

async function run(args: ExecuteParams) {
  const fn = createDashboard.execute as ExecuteFn;
  return runInCtx(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (await fn(args, undefined as any)) as
      | {
          kind: "ok";
          dashboardId: string;
          title: string;
          description: string | null;
          cardCount: number;
          draft: boolean;
        }
      | {
          kind: "err";
          error: string;
          validationErrors?: { cardIndex: number; cardTitle: string; error: string }[];
        };
    return out;
  });
}

// ---------------------------------------------------------------------------

describe("createDashboard tool", () => {
  const origDbUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    poolQueryCalls = [];
    clientQueryCalls = [];
    clientQueryResults = [];
    clientQueryResultIndex = 0;
    connectCalls = 0;
    clientReleased = false;
    clientReleaseErr = undefined;
    clientThrowOnCall = new Map();
    clientQueryCount = 0;
    validateSQLMock.mockClear();
    delete process.env.DATABASE_URL;
    _resetPool(null);
  });

  afterEach(() => {
    if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    _resetPool(null);
  });

  // -------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------

  it("commits dashboard + draft inside a single transaction", async () => {
    enableInternalDB();
    setClientResults(
      { rows: [] }, // BEGIN
      {
        rows: [
          {
            id: "dash-new",
            title: "Revenue",
            description: null,
            updated_at: "2026-05-17T12:00:00Z",
          },
        ],
      }, // INSERT dashboards RETURNING
      { rows: [] }, // INSERT dashboard_user_drafts
      { rows: [] }, // COMMIT
    );

    const result = await run({
      title: "Revenue",
      cards: [
        {
          title: "Total revenue",
          sql: "SELECT SUM(amount) AS total FROM orders",
          chartConfig: { type: "table", categoryColumn: "total", valueColumns: ["total"] },
        },
        {
          title: "Revenue by day",
          sql: "SELECT day, SUM(amount) AS total FROM orders GROUP BY day",
          chartConfig: { type: "line", categoryColumn: "day", valueColumns: ["total"] },
        },
      ],
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.dashboardId).toBe("dash-new");
      expect(result.title).toBe("Revenue");
      expect(result.cardCount).toBe(2);
      expect(result.draft).toBe(true);
    }

    // Validation ran per card.
    expect(validateSQLMock).toHaveBeenCalledTimes(2);

    // Pool.query was NOT used — the transactional client.query is.
    expect(poolQueryCalls).toHaveLength(0);

    // Exactly one client checked out, and released.
    expect(connectCalls).toBe(1);
    expect(clientReleased).toBe(true);
    expect(clientReleaseErr).toBeUndefined();

    // Sequence: BEGIN → INSERT dashboards → INSERT dashboard_user_drafts → COMMIT.
    expect(clientQueryCalls).toHaveLength(4);
    expect(clientQueryCalls[0].sql).toBe("BEGIN");
    expect(clientQueryCalls[1].sql).toMatch(/INSERT INTO dashboards/);
    expect(clientQueryCalls[2].sql).toMatch(/INSERT INTO dashboard_user_drafts/);
    expect(clientQueryCalls[3].sql).toBe("COMMIT");

    // Owner + org come from request context (NOT from the tool args).
    const dashParams = clientQueryCalls[1].params!;
    expect(dashParams[0]).toBe("user-1"); // owner_id
    expect(dashParams[1]).toBe("org-1"); // org_id
    expect(dashParams[2]).toBe("Revenue"); // title
    expect(dashParams[3]).toBeNull(); // description

    // Draft snapshot embeds both cards with the agent's intended order.
    const draftParams = clientQueryCalls[2].params!;
    expect(draftParams[0]).toBe("user-1"); // user_id
    expect(draftParams[1]).toBe("dash-new"); // dashboard_id
    const snapshot = JSON.parse(draftParams[2] as string);
    expect(snapshot.cards).toHaveLength(2);
    expect(snapshot.cards[0].title).toBe("Total revenue");
    expect(snapshot.cards[0].position).toBe(0);
    expect(snapshot.cards[1].title).toBe("Revenue by day");
    expect(snapshot.cards[1].position).toBe(1);
    // Baseline is empty (no published cards yet).
    const baseline = JSON.parse(draftParams[3] as string);
    expect(baseline.cards).toEqual([]);
  });

  it("passes connectionId to validateSQL for each card", async () => {
    enableInternalDB();
    setClientResults(
      { rows: [] }, // BEGIN
      { rows: [{ id: "d1", title: "T", description: null, updated_at: "2026-05-17" }] },
      { rows: [] }, // draft
      { rows: [] }, // COMMIT
    );
    await run({
      title: "Multi-source",
      cards: [
        {
          title: "Default",
          sql: "SELECT 1",
          chartConfig: { type: "table", categoryColumn: "x", valueColumns: ["x"] },
        },
        {
          title: "Replica",
          sql: "SELECT 2",
          chartConfig: { type: "table", categoryColumn: "y", valueColumns: ["y"] },
          connectionId: "analytics-replica",
        },
      ],
    });
    expect(validateSQLMock).toHaveBeenCalledTimes(2);
    expect(validateSQLMock.mock.calls[0]).toEqual(["SELECT 1", undefined]);
    expect(validateSQLMock.mock.calls[1]).toEqual(["SELECT 2", "analytics-replica"]);
  });

  // -------------------------------------------------------------------
  // Validation-fail rejects the whole call (no transaction)
  // -------------------------------------------------------------------

  it("rejects the whole call when any card has invalid SQL — no dashboard row left behind", async () => {
    enableInternalDB();
    // NOTE: no client query results set — if the test reaches the
    // transaction the missing results would surface as ok=true with
    // bogus ids; instead we assert connect() was never called.

    const result = await run({
      title: "Mixed",
      cards: [
        {
          title: "Ok card",
          sql: "SELECT 1",
          chartConfig: { type: "table", categoryColumn: "x", valueColumns: ["x"] },
        },
        {
          title: "Mutation",
          sql: "DROP TABLE orders",
          chartConfig: { type: "table", categoryColumn: "x", valueColumns: ["x"] },
        },
        {
          title: "Bad whitelist",
          sql: "SELECT * FROM forbidden_table",
          chartConfig: { type: "table", categoryColumn: "x", valueColumns: ["x"] },
        },
      ],
    });

    expect(result.kind).toBe("err");
    if (result.kind === "err") {
      expect(result.validationErrors).toHaveLength(2);
      expect(result.validationErrors![0]).toMatchObject({ cardIndex: 1, cardTitle: "Mutation" });
      expect(result.validationErrors![1]).toMatchObject({ cardIndex: 2, cardTitle: "Bad whitelist" });
      expect(result.error).toMatch(/failed SQL validation/i);
    }
    // No transaction opened — assert connect() was never called.
    expect(connectCalls).toBe(0);
    // No queries went via the pool either.
    expect(poolQueryCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // Rollback on intra-transaction failure
  // -------------------------------------------------------------------

  it("rolls back when the draft INSERT fails — no orphaned dashboard row", async () => {
    enableInternalDB();
    setClientResults(
      { rows: [] }, // BEGIN
      {
        rows: [
          {
            id: "dash-stale",
            title: "Doomed",
            description: null,
            updated_at: "2026-05-17",
          },
        ],
      }, // dashboards INSERT succeeds
      // NEXT client.query call is the draft INSERT — throw instead.
    );
    // Throw on the 3rd client.query (1=BEGIN, 2=INSERT dashboards, 3=INSERT draft).
    clientThrowOnCall.set(3, new Error("dashboard_user_drafts insert failed: simulated"));

    const result = await run({
      title: "Doomed",
      cards: [
        {
          title: "X",
          sql: "SELECT 1",
          chartConfig: { type: "table", categoryColumn: "x", valueColumns: ["x"] },
        },
      ],
    });

    expect(result.kind).toBe("err");
    if (result.kind === "err") {
      // Sanitized message — raw error not leaked into the tool envelope.
      expect(result.error).not.toContain("simulated");
      expect(result.error).toMatch(/dashboard tool failed/i);
    }

    // Sequence: BEGIN, INSERT dashboards, INSERT draft (throws), ROLLBACK.
    expect(clientQueryCalls[0].sql).toBe("BEGIN");
    expect(clientQueryCalls[1].sql).toMatch(/INSERT INTO dashboards/);
    expect(clientQueryCalls[2].sql).toMatch(/INSERT INTO dashboard_user_drafts/);
    expect(clientQueryCalls[3].sql).toBe("ROLLBACK");
    // No COMMIT.
    expect(clientQueryCalls.some((c) => c.sql === "COMMIT")).toBe(false);
    // Client still released.
    expect(clientReleased).toBe(true);
  });

  // -------------------------------------------------------------------
  // Owner / org scoping
  // -------------------------------------------------------------------

  it("rejects when no authenticated user is in the request context", async () => {
    enableInternalDB();
    // Bypass runInCtx — call outside any withRequestContext.
    const fn = createDashboard.execute as ExecuteFn;
    const result = (await fn(
      {
        title: "Anonymous",
        cards: [
          {
            title: "X",
            sql: "SELECT 1",
            chartConfig: { type: "table", categoryColumn: "x", valueColumns: ["x"] },
          },
        ],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      undefined as any,
    )) as { kind: "err"; error: string } | { kind: "ok" };

    expect(result.kind).toBe("err");
    if (result.kind === "err") {
      expect(result.error).toMatch(/sign in/i);
    }
    expect(connectCalls).toBe(0);
  });

  it("rejects when the internal DB is unavailable", async () => {
    // Don't enableInternalDB() — pool stays unset.
    const result = await run({
      title: "X",
      cards: [
        {
          title: "X",
          sql: "SELECT 1",
          chartConfig: { type: "table", categoryColumn: "x", valueColumns: ["x"] },
        },
      ],
    });
    expect(result.kind).toBe("err");
    if (result.kind === "err") {
      expect(result.error).toMatch(/dashboard tool failed/i);
    }
    // No validation needed when the DB isn't there — fail fast.
    expect(validateSQLMock).toHaveBeenCalledTimes(0);
  });

  // -------------------------------------------------------------------
  // Secret redaction on unexpected throw
  // -------------------------------------------------------------------

  it("returns a sanitized error envelope when validateSQL throws — no secrets leaked", async () => {
    enableInternalDB();
    validateSQLMock.mockImplementationOnce(() => {
      throw new Error("postgresql://atlas:supersecret@db.example/atlas — pool exhausted");
    });
    const result = await run({
      title: "Boom",
      cards: [
        {
          title: "Will throw",
          sql: "SELECT 1",
          chartConfig: { type: "table", categoryColumn: "x", valueColumns: ["x"] },
        },
      ],
    });
    expect(result.kind).toBe("err");
    if (result.kind === "err") {
      expect(result.error).not.toContain("supersecret");
      expect(result.error).not.toContain("postgresql://");
      expect(result.error).toMatch(/dashboard tool failed/i);
    }
  });
});
