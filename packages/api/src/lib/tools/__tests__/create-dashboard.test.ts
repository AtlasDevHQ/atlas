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

// #4558 — createDashboard now seeds each staged card via runUserQueryPipeline
// (through the shared dashboard-seeding module). Give the test a controllable
// pipeline keyed by SQL so seeding outcomes can be asserted, plus a stub for
// the draft-cache write so seeding never touches the mock transaction pool.
type PipeOutcome =
  | { kind: "ok"; columns: string[]; rows: Record<string, unknown>[]; rowCount: number; executionMs: number; truncated: boolean; maskingApplied: boolean }
  | { kind: "query_failed"; message: string };

const pipelineBySql = new Map<string, PipeOutcome>();
function pipelineOk(rows: Record<string, unknown>[]): PipeOutcome {
  return {
    kind: "ok",
    columns: rows.length > 0 ? Object.keys(rows[0]) : ["n"],
    rows,
    rowCount: rows.length,
    executionMs: 1,
    truncated: false,
    maskingApplied: false,
  };
}
const runUserQueryPipelineMock = mock((opts: { sql: string }) =>
  Promise.resolve(pipelineBySql.get(opts.sql) ?? pipelineOk([{ n: 1 }])),
);

void mock.module("@atlas/api/lib/tools/sql", () => ({
  validateSQL: validateSQLMock,
  executeSQL: undefined as never,
  runUserQueryPipeline: runUserQueryPipelineMock,
}));

const saveDraftCardCacheMock = mock(() =>
  Promise.resolve({ ok: true as const, cachedAt: "2026-07-17T00:00:00.000Z" }),
);
void mock.module("@atlas/api/lib/dashboard-draft-cache", () => ({
  saveDraftCardCache: saveDraftCardCacheMock,
}));

const { createDashboard, deriveTextCardTitle } = await import("@atlas/api/lib/tools/create-dashboard");

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
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (await fn(args, undefined as any)) as
      | {
          kind: "ok";
          dashboardId: string;
          title: string;
          description: string | null;
          cardCount: number;
          draft: boolean;
          cardOutcomes: {
            cardId: string;
            title: string;
            status: "rows" | "empty" | "error" | "unseeded";
            rowCount?: number;
            message?: string;
          }[];
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
    runUserQueryPipelineMock.mockClear();
    saveDraftCardCacheMock.mockClear();
    pipelineBySql.clear();
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
    // No parameters declared → INSERT persists an empty array (#2267).
    expect(JSON.parse(dashParams[4] as string)).toEqual([]);
  });

  // -------------------------------------------------------------------
  // Tool-side seeding (#4558, ADR-0034 Decision 1)
  // -------------------------------------------------------------------

  it("seeds each chart card and reports per-card outcomes (rows / empty)", async () => {
    enableInternalDB();
    setClientResults(
      { rows: [] }, // BEGIN
      { rows: [{ id: "dash-seed", title: "Board", description: null, updated_at: "2026-07-17" }] },
      { rows: [] }, // INSERT drafts
      { rows: [] }, // COMMIT
    );
    pipelineBySql.set("SELECT a", pipelineOk([{ a: 1 }, { a: 2 }, { a: 3 }]));
    pipelineBySql.set("SELECT b", pipelineOk([])); // empty

    const result = await run({
      title: "Board",
      cards: [
        { title: "A", sql: "SELECT a", chartConfig: { type: "table", categoryColumn: "a", valueColumns: ["a"] } },
        { title: "B", sql: "SELECT b", chartConfig: { type: "table", categoryColumn: "b", valueColumns: ["b"] } },
      ],
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.cardOutcomes).toEqual([
      { cardId: expect.any(String), title: "A", status: "rows", rowCount: 3 },
      { cardId: expect.any(String), title: "B", status: "empty" },
    ]);
    // Each card ran through the pipeline and was cached.
    expect(runUserQueryPipelineMock).toHaveBeenCalledTimes(2);
    expect(saveDraftCardCacheMock).toHaveBeenCalledTimes(2);
  });

  it("is fail-soft: a card whose seed execution fails is still staged and the build succeeds", async () => {
    enableInternalDB();
    setClientResults(
      { rows: [] },
      { rows: [{ id: "dash-fs", title: "Board", description: null, updated_at: "2026-07-17" }] },
      { rows: [] },
      { rows: [] },
    );
    pipelineBySql.set("SELECT ok", pipelineOk([{ a: 1 }]));
    pipelineBySql.set("SELECT boom", { kind: "query_failed", message: 'column "x" does not exist' });

    const result = await run({
      title: "Board",
      cards: [
        { title: "Good", sql: "SELECT ok", chartConfig: { type: "table", categoryColumn: "a", valueColumns: ["a"] } },
        { title: "Bad", sql: "SELECT boom", chartConfig: { type: "table", categoryColumn: "a", valueColumns: ["a"] } },
      ],
    });

    // The build committed (transaction ran, COMMIT fired) despite the bad card.
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.cardCount).toBe(2);
    expect(clientQueryCalls.at(-1)?.sql).toBe("COMMIT");
    expect(result.cardOutcomes[0]).toEqual({ cardId: expect.any(String), title: "Good", status: "rows", rowCount: 1 });
    expect(result.cardOutcomes[1]).toEqual({
      cardId: expect.any(String),
      title: "Bad",
      status: "error",
      message: 'column "x" does not exist',
    });
    // The failing card was never cached.
    expect(saveDraftCardCacheMock).toHaveBeenCalledTimes(1);
  });

  it("does not seed text / section cards (no data to fetch)", async () => {
    enableInternalDB();
    setClientResults(
      { rows: [] },
      { rows: [{ id: "dash-mix", title: "Board", description: null, updated_at: "2026-07-17" }] },
      { rows: [] },
      { rows: [] },
    );
    pipelineBySql.set("SELECT a", pipelineOk([{ a: 1 }]));

    const result = await run({
      title: "Board",
      cards: [
        { kind: "text", content: "## Section" },
        { title: "A", sql: "SELECT a", chartConfig: { type: "table", categoryColumn: "a", valueColumns: ["a"] } },
      ],
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    // Two cards staged, but only the chart card is seeded / reported.
    expect(result.cardCount).toBe(2);
    expect(result.cardOutcomes).toEqual([
      { cardId: expect.any(String), title: "A", status: "rows", rowCount: 1 },
    ]);
    expect(runUserQueryPipelineMock).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------
  // Parameters (#2267)
  // -------------------------------------------------------------------

  it("persists declared parameters and accepts cards that reference them", async () => {
    enableInternalDB();
    setClientResults(
      { rows: [] }, // BEGIN
      {
        rows: [
          { id: "dash-p", title: "Signups", description: null, updated_at: "2026-05-17T12:00:00Z" },
        ],
      }, // INSERT dashboards RETURNING
      { rows: [] }, // INSERT dashboard_user_drafts
      { rows: [] }, // COMMIT
    );

    const result = await run({
      title: "Signups",
      parameters: [
        { key: "date_from", type: "date", default: "now - 30 days", label: "From" },
        { key: "date_to", type: "date", default: "now", label: "To" },
      ],
      cards: [
        {
          title: "Weekly signups",
          sql: "SELECT day, COUNT(*) AS n FROM signups WHERE created_at >= :date_from AND created_at < :date_to GROUP BY day",
          chartConfig: { type: "line", categoryColumn: "day", valueColumns: ["n"] },
        },
      ],
    });

    expect(result.kind).toBe("ok");
    // The dashboard INSERT carries the parameter definitions.
    const dashParams = clientQueryCalls[1].params!;
    const persisted = JSON.parse(dashParams[4] as string);
    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toMatchObject({ key: "date_from", type: "date" });
    expect(persisted[1]).toMatchObject({ key: "date_to", type: "date" });
  });

  it("rejects a card that references an undeclared parameter (no transaction)", async () => {
    enableInternalDB();

    const result = await run({
      title: "Signups",
      // No `date_from` declared.
      cards: [
        {
          title: "Weekly signups",
          sql: "SELECT day, COUNT(*) AS n FROM signups WHERE created_at >= :date_from GROUP BY day",
          chartConfig: { type: "line", categoryColumn: "day", valueColumns: ["n"] },
        },
      ],
    });

    expect(result.kind).toBe("err");
    if (result.kind === "err") {
      expect(result.error).toMatch(/:date_from/);
      expect(result.validationErrors?.[0]?.cardTitle).toBe("Weekly signups");
    }
    // Rejected before opening a transaction — no client checked out.
    expect(connectCalls).toBe(0);
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
  // Text / section cards (#3138)
  // -------------------------------------------------------------------

  it("stages a text card with no SQL — content set, sql empty, chartConfig null, no validation", async () => {
    enableInternalDB();
    setClientResults(
      { rows: [] }, // BEGIN
      { rows: [{ id: "dash-tx", title: "Funnel", description: null, updated_at: "2026-06-03" }] },
      { rows: [] }, // draft
      { rows: [] }, // COMMIT
    );

    const result = await run({
      title: "Funnel",
      cards: [
        { kind: "text", content: "## Top of funnel" },
        {
          title: "Signups by week",
          sql: "SELECT week, COUNT(*) AS n FROM signups GROUP BY week",
          chartConfig: { type: "line", categoryColumn: "week", valueColumns: ["n"] },
        },
      ],
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.cardCount).toBe(2);

    // Only the chart card was SQL-validated — the text card skipped validation.
    expect(validateSQLMock).toHaveBeenCalledTimes(1);
    expect(validateSQLMock.mock.calls[0][0]).toBe(
      "SELECT week, COUNT(*) AS n FROM signups GROUP BY week",
    );

    const draftParams = clientQueryCalls[2].params!;
    const snapshot = JSON.parse(draftParams[2] as string);
    expect(snapshot.cards).toHaveLength(2);

    const textCard = snapshot.cards[0];
    expect(textCard.content).toBe("## Top of funnel");
    expect(textCard.sql).toBe("");
    expect(textCard.chartConfig).toBeNull();
    // Title derived from the markdown heading (the agent omitted `title`).
    expect(textCard.title).toBe("Top of funnel");
    expect(textCard.connectionGroupId).toBeNull();
    expect(textCard.position).toBe(0);

    const chartCard = snapshot.cards[1];
    expect(chartCard.content).toBeNull();
    expect(chartCard.sql).toBe("SELECT week, COUNT(*) AS n FROM signups GROUP BY week");
    expect(chartCard.position).toBe(1);
  });

  it("carries a card's goal-line thresholds through into the draft snapshot (#3208)", async () => {
    enableInternalDB();
    setClientResults(
      { rows: [] }, // BEGIN
      { rows: [{ id: "dash-goal", title: "Revenue", description: null, updated_at: "2026-06-05" }] },
      { rows: [] }, // draft
      { rows: [] }, // COMMIT
    );

    const thresholds = [
      { value: 1_000_000, color: "#f59e0b", label: "Target" },
      { value: 500_000 },
    ];
    const result = await run({
      title: "Revenue",
      cards: [
        {
          title: "Revenue by month",
          sql: "SELECT month, SUM(amount) AS revenue FROM orders GROUP BY month",
          chartConfig: { type: "bar", categoryColumn: "month", valueColumns: ["revenue"], thresholds },
        },
      ],
    });

    expect(result.kind).toBe("ok");
    const draftParams = clientQueryCalls[2].params!;
    const snapshot = JSON.parse(draftParams[2] as string);
    // Thresholds survive the strict schema + draft persistence unchanged.
    expect(snapshot.cards[0].chartConfig.thresholds).toEqual(thresholds);
  });

  it("carries a card's event annotations through into the draft snapshot (#3209)", async () => {
    enableInternalDB();
    setClientResults(
      { rows: [] }, // BEGIN
      { rows: [{ id: "dash-anno", title: "Signups", description: null, updated_at: "2026-06-05" }] },
      { rows: [] }, // draft
      { rows: [] }, // COMMIT
    );

    const annotations = [
      { x: "2026-01-15", label: "Launch", color: "#10b981" },
      { x: "2026-03-01", label: "Campaign" },
    ];
    const result = await run({
      title: "Signups",
      cards: [
        {
          title: "Weekly signups",
          sql: "SELECT week, COUNT(*) AS signups FROM users GROUP BY week",
          chartConfig: { type: "line", categoryColumn: "week", valueColumns: ["signups"] },
          annotations,
        },
      ],
    });

    expect(result.kind).toBe("ok");
    const draftParams = clientQueryCalls[2].params!;
    const snapshot = JSON.parse(draftParams[2] as string);
    // Annotations survive the strict schema + draft persistence unchanged.
    expect(snapshot.cards[0].annotations).toEqual(annotations);
  });

  it("a text card never triggers SQL validation or the undeclared-parameter check", async () => {
    enableInternalDB();
    setClientResults(
      { rows: [] },
      { rows: [{ id: "d-only-text", title: "Notes", description: null, updated_at: "2026-06-03" }] },
      { rows: [] },
      { rows: [] },
    );
    // A ':token' inside markdown must NOT be treated as a SQL placeholder.
    const result = await run({
      title: "Notes",
      cards: [{ kind: "text", content: "See cohort :not_a_param notes" }],
    });
    expect(result.kind).toBe("ok");
    expect(validateSQLMock).toHaveBeenCalledTimes(0);
  });

  it("rejects a mixed payload — a text card carrying sql/chartConfig fails the input schema", () => {
    // Strict schemas: a text card must not smuggle chart fields past the
    // SQL validation it skips. The agent boundary validates against inputSchema
    // (a Zod schema at runtime; the AI SDK types it as FlexibleSchema, so cast).
    const schema = createDashboard.inputSchema as unknown as {
      safeParse: (v: unknown) => { success: boolean };
    };
    const mixed = schema.safeParse({
      title: "Bad",
      cards: [{ kind: "text", content: "## Hi", sql: "SELECT 1", chartConfig: { type: "bar", categoryColumn: "x", valueColumns: ["y"] } }],
    });
    expect(mixed.success).toBe(false);
    // A clean text card and a clean chart card both still parse.
    expect(
      schema.safeParse({ title: "Ok", cards: [{ kind: "text", content: "## Hi" }] }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        title: "Ok",
        cards: [{ title: "C", sql: "SELECT 1", chartConfig: { type: "bar", categoryColumn: "x", valueColumns: ["y"] } }],
      }).success,
    ).toBe(true);
  });

  describe("deriveTextCardTitle", () => {
    it("strips a leading markdown heading marker", () => {
      expect(deriveTextCardTitle("## Top of funnel")).toBe("Top of funnel");
    });
    it("uses the first non-empty line", () => {
      expect(deriveTextCardTitle("\n\n- A bullet\nmore")).toBe("A bullet");
    });
    it("falls back to 'Section' for blank content", () => {
      expect(deriveTextCardTitle("   \n  ")).toBe("Section");
    });
  });

  // -------------------------------------------------------------------
  // KPI / scorecard cards (#3137)
  // -------------------------------------------------------------------

  it("accepts a kpi card and persists its kpi config; validates BOTH queries", async () => {
    enableInternalDB();
    setClientResults(
      { rows: [] }, // BEGIN
      { rows: [{ id: "dash-kpi", title: "KPIs", description: null, updated_at: "2026-06-03" }] },
      { rows: [] }, // draft
      { rows: [] }, // COMMIT
    );

    const result = await run({
      title: "KPIs",
      parameters: [{ key: "date_from", type: "date", default: "now - 30 days", label: "From" }],
      cards: [
        {
          title: "Revenue",
          sql: "SELECT 'Revenue' AS label, SUM(amount) AS total FROM orders WHERE created_at >= :date_from",
          chartConfig: {
            type: "kpi",
            categoryColumn: "label",
            valueColumns: ["total"],
            kpi: {
              valueFormat: "currency",
              comparisonSql: "SELECT SUM(amount) AS total FROM orders WHERE created_at < :date_from",
              comparisonLabel: "vs. prior period",
            },
          },
        },
      ],
    });

    expect(result.kind).toBe("ok");
    // BOTH the primary query and the comparison query were validated.
    expect(validateSQLMock).toHaveBeenCalledTimes(2);

    const snapshot = JSON.parse(clientQueryCalls[2].params![2] as string);
    expect(snapshot.cards[0].chartConfig).toEqual({
      type: "kpi",
      categoryColumn: "label",
      valueColumns: ["total"],
      kpi: {
        valueFormat: "currency",
        comparisonSql: "SELECT SUM(amount) AS total FROM orders WHERE created_at < :date_from",
        comparisonLabel: "vs. prior period",
      },
    });
  });

  it("rejects a kpi card whose comparisonSql fails SQL validation (no transaction)", async () => {
    enableInternalDB();

    const result = await run({
      title: "KPIs",
      cards: [
        {
          title: "Revenue",
          sql: "SELECT SUM(amount) AS total FROM orders",
          chartConfig: {
            type: "kpi",
            categoryColumn: "total",
            valueColumns: ["total"],
            // A mutation — the comparison query must hit the same SELECT-only guard.
            kpi: { comparisonSql: "DROP TABLE orders" },
          },
        },
      ],
    });

    expect(result.kind).toBe("err");
    if (result.kind === "err") {
      expect(result.validationErrors?.[0].error).toMatch(/comparison/i);
    }
    // Rejected before any transaction opened.
    expect(connectCalls).toBe(0);
  });

  it("rejects a kpi card whose comparisonSql references an undeclared parameter", async () => {
    enableInternalDB();

    const result = await run({
      title: "KPIs",
      // No parameters declared, but comparisonSql references :date_from.
      cards: [
        {
          title: "Revenue",
          sql: "SELECT SUM(amount) AS total FROM orders",
          chartConfig: {
            type: "kpi",
            categoryColumn: "total",
            valueColumns: ["total"],
            kpi: { comparisonSql: "SELECT SUM(amount) AS total FROM orders WHERE created_at < :date_from" },
          },
        },
      ],
    });

    expect(result.kind).toBe("err");
    if (result.kind === "err") {
      expect(result.validationErrors?.[0].error).toContain(":date_from");
    }
    expect(connectCalls).toBe(0);
  });

  // #3207 — autoComparison: prior-period inference without a hand-written query.
  it("accepts a kpi card with autoComparison that filters by the declared window", async () => {
    enableInternalDB();
    setClientResults(
      { rows: [] }, // BEGIN
      { rows: [{ id: "dash-auto", title: "KPIs", description: null, updated_at: "2026-06-04" }] },
      { rows: [] }, // draft
      { rows: [] }, // COMMIT
    );

    const result = await run({
      title: "KPIs",
      parameters: [
        { key: "date_from", type: "date", default: "now - 30 days", label: "From" },
        { key: "date_to", type: "date", default: "now", label: "To" },
      ],
      cards: [
        {
          title: "Revenue",
          sql: "SELECT SUM(amount) AS total FROM orders WHERE created_at >= :date_from AND created_at < :date_to",
          chartConfig: {
            type: "kpi",
            categoryColumn: "total",
            valueColumns: ["total"],
            kpi: { valueFormat: "currency", autoComparison: true, comparisonLabel: "vs. prior period" },
          },
        },
      ],
    });

    expect(result.kind).toBe("ok");
    // autoComparison adds NO second query to validate — only the primary runs
    // through the guard.
    expect(validateSQLMock).toHaveBeenCalledTimes(1);
    const snapshot = JSON.parse(clientQueryCalls[2].params![2] as string);
    expect(snapshot.cards[0].chartConfig.kpi).toMatchObject({ autoComparison: true });
  });

  it("rejects autoComparison when the card SQL does not reference the date window", async () => {
    enableInternalDB();

    const result = await run({
      title: "KPIs",
      parameters: [
        { key: "date_from", type: "date", default: "now - 30 days", label: "From" },
        { key: "date_to", type: "date", default: "now", label: "To" },
      ],
      cards: [
        {
          title: "Revenue",
          // No :date_from / :date_to — shifting the window would be a no-op.
          sql: "SELECT SUM(amount) AS total FROM orders",
          chartConfig: {
            type: "kpi",
            categoryColumn: "total",
            valueColumns: ["total"],
            kpi: { autoComparison: true },
          },
        },
      ],
    });

    expect(result.kind).toBe("err");
    if (result.kind === "err") {
      expect(result.validationErrors?.[0].error).toMatch(/autoComparison/i);
      expect(result.validationErrors?.[0].error).toContain(":date_from");
    }
    expect(connectCalls).toBe(0);
  });

  it("rejects autoComparison when a window param is not declared as a date", async () => {
    enableInternalDB();

    const result = await run({
      title: "KPIs",
      parameters: [
        // date_from is a NUMBER — derivePriorPeriodValues can't shift it.
        { key: "date_from", type: "number", default: 0, label: "From" },
        { key: "date_to", type: "date", default: "now", label: "To" },
      ],
      cards: [
        {
          title: "Revenue",
          sql: "SELECT SUM(amount) AS total FROM orders WHERE rank >= :date_from AND created_at < :date_to",
          chartConfig: {
            type: "kpi",
            categoryColumn: "total",
            valueColumns: ["total"],
            kpi: { autoComparison: true },
          },
        },
      ],
    });

    expect(result.kind).toBe("err");
    if (result.kind === "err") {
      expect(result.validationErrors?.[0].error).toMatch(/date parameter/i);
      expect(result.validationErrors?.[0].error).toContain(":date_from");
    }
    expect(connectCalls).toBe(0);
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
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any
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
