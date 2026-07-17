/**
 * Bound-editor seeding test (#4558, ADR-0034 Decision 1).
 *
 * The bound `addCard` executes the card it just staged once through the full
 * SQL pipeline and reports the outcome as `seed` on its result, so the agent
 * self-corrects instead of claiming a card works when its query returned
 * nothing. This is the single-card twin of `createDashboard`'s batch seeding.
 *
 * Unlike the other bound-dashboard suites (which keep `runUserQueryPipeline`
 * unreachable), this file gives it a controllable mock and lets the REAL
 * draft-cache write land in the stub pool — so the addCard → seed wire is
 * exercised end to end against a recorded query sequence.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { _resetPool, type InternalPool } from "../../db/internal";
import type { UserQueryOutcome } from "@atlas/api/lib/tools/sql";

const validateSQLMock = mock(async (_sql: string) => ({
  valid: true as const,
  classification: { tablesAccessed: [], columnsAccessed: [] },
}));

let pipelineOutcome: UserQueryOutcome = {
  kind: "ok",
  columns: ["a"],
  rows: [{ a: 1 }, { a: 2 }],
  rowCount: 2,
  executionMs: 1,
  truncated: false,
  maskingApplied: false,
};
const runUserQueryPipelineMock = mock(() => Promise.resolve(pipelineOutcome));

void mock.module("@atlas/api/lib/tools/sql", () => ({
  validateSQL: validateSQLMock,
  executeSQL: undefined as never,
  runUserQueryPipeline: runUserQueryPipelineMock,
}));

const invalidateScreenshotMock = mock((_dashboardId: string) => {});
void mock.module("@atlas/api/lib/dashboard-screenshot", () => ({
  screenshotDashboard: async () => ({ ok: false as const, message: "not used" }),
  invalidateDashboardScreenshot: invalidateScreenshotMock,
  closeScreenshotBrowser: async () => {},
  _resetScreenshotCache: () => {},
  _screenshotCacheSize: () => 0,
  _setRenderFn: () => {},
}));

const { createBoundDashboardTools } = await import("../bound-dashboard");

// ---- stub pool (records pool.query in order) ----------------------------
interface QueryResult {
  rows: Record<string, unknown>[];
}
let queryCalls: { sql: string; params?: unknown[] }[] = [];
let queryResults: QueryResult[] = [];
let queryResultIndex = 0;

const mockPool: InternalPool = {
  query: async (sql: string, params?: unknown[]) => {
    queryCalls.push({ sql, params });
    const result = queryResults[queryResultIndex] ?? { rows: [] };
    queryResultIndex++;
    return result;
  },
  async connect() {
    return { query: async () => ({ rows: [] }), release() {} };
  },
  end: async () => {},
  on: () => {},
};

function enableInternalDB() {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  _resetPool(mockPool);
}
function setResults(...results: QueryResult[]) {
  queryResults = results;
  queryResultIndex = 0;
}

const dashboardRow = {
  id: "dash-1",
  org_id: "org-1",
  owner_id: "user-1",
  title: "Demo",
  description: null,
  parameters: [],
  share_token: null,
  share_expires_at: null,
  share_mode: "public",
  refresh_schedule: null,
  last_refresh_at: null,
  next_refresh_at: null,
  card_count: 0,
  created_at: "2026-05-17T00:00:00.000Z",
  updated_at: "2026-05-17T00:00:00.000Z",
};

const baselineSnap = { dashboardId: "dash-1", title: "Demo", description: null, cards: [] };
const existingDraftRow = {
  user_id: "user-1",
  dashboard_id: "dash-1",
  draft: baselineSnap,
  baseline: baselineSnap,
  published_baseline_at: "2026-05-17T00:00:00.000Z",
  created_at: "2026-05-17T00:00:00.000Z",
  updated_at: "2026-05-17T00:00:00.000Z",
};

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
async function runTool<T = unknown>(tool: any, args: unknown): Promise<T> {
  if (!tool?.execute) throw new Error("tool has no execute");
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  return (await tool.execute(args, undefined as any)) as T;
}

interface AddCardResult {
  kind: string;
  error?: string;
  card?: { id: string; title: string };
  seed?: { cardId: string; title: string; status: string; rowCount?: number; message?: string };
}

describe("bound addCard — tool-side seeding (#4558)", () => {
  const origDbUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    queryCalls = [];
    queryResults = [];
    queryResultIndex = 0;
    validateSQLMock.mockClear();
    runUserQueryPipelineMock.mockClear();
    pipelineOutcome = {
      kind: "ok",
      columns: ["a"],
      rows: [{ a: 1 }, { a: 2 }],
      rowCount: 2,
      executionMs: 1,
      truncated: false,
      maskingApplied: false,
    };
    delete process.env.DATABASE_URL;
    _resetPool(null);
  });
  afterEach(() => {
    if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    _resetPool(null);
  });

  it("seeds the new card and reports rows on the result", async () => {
    enableInternalDB();
    // getDashboard (dash + cards), loadDraft (existing), saveDraft UPDATE,
    // saveDraftCardCache INSERT…RETURNING.
    setResults(
      { rows: [dashboardRow] },
      { rows: [] }, // cards
      { rows: [existingDraftRow] },
      { rows: [{ user_id: "user-1" }] },
      { rows: [{ card_id: "seeded" }] },
    );

    const tools = createBoundDashboardTools({ dashboardId: "dash-1", orgId: "org-1", userId: "user-1" });
    const result = await runTool<AddCardResult>(tools.addCard, {
      title: "New",
      sql: "SELECT a",
      chartConfig: { type: "table", categoryColumn: "a", valueColumns: ["a"] },
    });

    expect(result.kind).toBe("ok");
    expect(result.seed).toEqual({
      cardId: result.card!.id,
      title: "New",
      status: "rows",
      rowCount: 2,
    });
    // The seed ran through the full pipeline and wrote the draft cache.
    expect(runUserQueryPipelineMock).toHaveBeenCalledTimes(1);
    expect(queryCalls.some((q) => /INSERT INTO dashboard_draft_card_cache/.test(q.sql))).toBe(true);
  });

  it("is fail-soft: a failed seed still adds the card and reports error", async () => {
    enableInternalDB();
    pipelineOutcome = { kind: "query_failed", message: 'relation "nope" does not exist' };
    setResults(
      { rows: [dashboardRow] },
      { rows: [] },
      { rows: [existingDraftRow] },
      { rows: [{ user_id: "user-1" }] },
    );

    const tools = createBoundDashboardTools({ dashboardId: "dash-1", orgId: "org-1", userId: "user-1" });
    const result = await runTool<AddCardResult>(tools.addCard, {
      title: "Broken",
      sql: "SELECT a",
      chartConfig: { type: "table", categoryColumn: "a", valueColumns: ["a"] },
    });

    // The card was still added (kind ok); only the seed reports the failure.
    expect(result.kind).toBe("ok");
    expect(result.card?.title).toBe("Broken");
    expect(result.seed?.status).toBe("error");
    expect(result.seed?.message).toBe('relation "nope" does not exist');
    // A failed seed never writes the draft cache.
    expect(queryCalls.some((q) => /INSERT INTO dashboard_draft_card_cache/.test(q.sql))).toBe(false);
  });

  it("degrades to unseeded (never fails the add) when the card's connection group has no members", async () => {
    enableInternalDB();
    // getDashboard (dash + cards), loadDraft, saveDraft, then the group snapshot
    // read for connection resolution returns NO members → NoGroupMembersError.
    setResults(
      { rows: [dashboardRow] },
      { rows: [] },
      { rows: [existingDraftRow] },
      { rows: [{ user_id: "user-1" }] },
      { rows: [] }, // workspace_plugins group-member lookup → empty
    );

    const tools = createBoundDashboardTools({
      dashboardId: "dash-1",
      orgId: "org-1",
      userId: "user-1",
      connectionGroupId: "grp-empty",
    });
    const result = await runTool<AddCardResult>(tools.addCard, {
      title: "Orphan",
      sql: "SELECT a",
      chartConfig: { type: "table", categoryColumn: "a", valueColumns: ["a"] },
    });

    // The card is added; seeding degrades to unseeded (canvas-mount render fills
    // it), and the pipeline is never reached because the connection can't resolve.
    expect(result.kind).toBe("ok");
    expect(result.seed?.status).toBe("unseeded");
    expect(runUserQueryPipelineMock).toHaveBeenCalledTimes(0);
    expect(queryCalls.some((q) => /INSERT INTO dashboard_draft_card_cache/.test(q.sql))).toBe(false);
  });
});
