/**
 * Integration-shaped tests for the bound dashboard editor tool set (#2363).
 *
 * Mocks the SQL validator (sync — bun's mock.module deadlocks on async
 * factories per feedback_bun_test_async_mock_module.md) and injects a
 * stub Postgres pool so `lib/dashboards` calls land in our recorder
 * instead of touching a real DB. The tools' execute() functions are
 * exercised directly.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { _resetPool, type InternalPool } from "../../db/internal";

// validateSQL is the only sync-mockable boundary into the SQL path;
// the tools call it before persisting. Mock it before the tools import.
const validateSQLMock = mock(async (sql: string, _connectionId?: string) => {
  if (/drop|insert|update|delete/i.test(sql)) {
    return { valid: false as const, error: "SQL must be SELECT-only." };
  }
  if (/forbidden_table/i.test(sql)) {
    return { valid: false as const, error: 'Table "forbidden_table" not in semantic layer.' };
  }
  return { valid: true as const, classification: { tablesAccessed: [], columnsAccessed: [] } };
});

mock.module("@atlas/api/lib/tools/sql", () => ({
  validateSQL: validateSQLMock,
  // The bound-dashboard tools only import `validateSQL` — but other
  // modules transitively imported by the dashboards lib pull in this
  // module too. Re-export the rest as best-effort no-ops; if any
  // codepath under test reaches them the test will fail loudly.
  executeSQL: undefined as never,
  runUserQueryPipeline: undefined as never,
}));

// #2367 — screenshot module is mocked to avoid pulling Playwright into
// the unit-test graph. Tests assert the tool wires through correctly and
// that mutating tools call `invalidateDashboardScreenshot`.
type ScreenshotResult = import("@atlas/api/lib/dashboard-screenshot").ScreenshotResult;
const screenshotMock = mock(
  async (
    _opts: {
      dashboardId: string;
      userId: string;
      orgId: string | null | undefined;
      cookieHeader?: string | null;
    },
  ): Promise<ScreenshotResult> => ({
    ok: true,
    png: Buffer.from("FAKE-PNG"),
    cached: false,
    durationMs: 5,
  }),
);
const invalidateScreenshotMock = mock((_dashboardId: string) => {});

mock.module("@atlas/api/lib/dashboard-screenshot", () => ({
  screenshotDashboard: screenshotMock,
  invalidateDashboardScreenshot: invalidateScreenshotMock,
  closeScreenshotBrowser: async () => {},
  _resetScreenshotCache: () => {},
  _screenshotCacheSize: () => 0,
  _setRenderFn: () => {},
}));

const { createBoundDashboardTools } = await import("../bound-dashboard");

// ---------------------------------------------------------------------------
// Mock pool — same shape as conversations.test.ts
// ---------------------------------------------------------------------------

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

const ctx = { dashboardId: "dash-1", orgId: "org-1" as string | null | undefined };

const dashboardRow = {
  id: "dash-1",
  org_id: "org-1",
  owner_id: "user-1",
  title: "Demo",
  description: null,
  share_token: null,
  share_expires_at: null,
  share_mode: "public",
  refresh_schedule: null,
  last_refresh_at: null,
  next_refresh_at: null,
  card_count: 1,
  created_at: "2026-05-17",
  updated_at: "2026-05-17",
};

const cardRow = {
  id: "card-1",
  dashboard_id: "dash-1",
  position: 0,
  title: "Signups",
  sql: "SELECT 1",
  chart_config: null,
  cached_columns: null,
  cached_rows: null,
  cached_at: null,
  connection_group_id: null,
  layout: null,
  created_at: "2026-05-17",
  updated_at: "2026-05-17",
};

// AI SDK's `Tool` type has a structural `execute` signature parameterized
// over the inputSchema; calling it generically in tests requires escaping
// the per-tool type. We `any`-cast at the boundary, then narrow via the
// caller's generic. Same trade as create-dashboard.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runTool<T = unknown>(tool: any, args: unknown): Promise<T> {
  if (!tool?.execute) throw new Error("tool has no execute");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await tool.execute(args, undefined as any)) as T;
}

describe("createBoundDashboardTools", () => {
  const origDbUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    queryCalls = [];
    queryResults = [];
    queryResultIndex = 0;
    validateSQLMock.mockClear();
    screenshotMock.mockClear();
    invalidateScreenshotMock.mockClear();
    delete process.env.DATABASE_URL;
    _resetPool(null);
  });

  afterEach(() => {
    if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    _resetPool(null);
  });

  // -------------------------------------------------------------------
  // Factory shape
  // -------------------------------------------------------------------

  it("returns the safe-op editor tools (six edit tools + screenshotDashboard) and nothing else", () => {
    const tools = createBoundDashboardTools(ctx);
    const names = Object.keys(tools).sort();
    expect(names).toEqual([
      "addCard",
      "getCardDetail",
      "getDashboardState",
      "screenshotDashboard",
      "updateCard",
      "updateDashboardMeta",
      "updateLayout",
    ]);
    // Critically: no removeCard / updateCardSql / executePython / actions.
    expect(names).not.toContain("removeCard");
    expect(names).not.toContain("updateCardSql");
    expect(names).not.toContain("executePython");
  });

  // -------------------------------------------------------------------
  // getDashboardState
  // -------------------------------------------------------------------

  it("getDashboardState returns dashboard meta + compact card summary", async () => {
    enableInternalDB();
    setResults({ rows: [dashboardRow] }, { rows: [cardRow] });
    const tools = createBoundDashboardTools(ctx);
    const result = await runTool<{
      kind: "ok";
      dashboard: { id: string; title: string; cardCount: number };
      summary: string;
    }>(tools.getDashboardState, {});
    expect(result.kind).toBe("ok");
    expect(result.dashboard).toMatchObject({ id: "dash-1", title: "Demo", cardCount: 1 });
    expect(result.summary).toContain("[card-1]");
    expect(result.summary).toContain("Signups");
  });

  // -------------------------------------------------------------------
  // getCardDetail
  // -------------------------------------------------------------------

  it("getCardDetail returns the full card row including SQL", async () => {
    enableInternalDB();
    setResults({ rows: [cardRow] });
    const tools = createBoundDashboardTools(ctx);
    const result = await runTool<{ kind: "ok"; card: { id: string; sql: string } }>(
      tools.getCardDetail,
      { cardId: "card-1" },
    );
    expect(result.kind).toBe("ok");
    expect(result.card.id).toBe("card-1");
    expect(result.card.sql).toBe("SELECT 1");
  });

  // -------------------------------------------------------------------
  // addCard
  // -------------------------------------------------------------------

  it("addCard validates SQL then inserts via lib/dashboards.addCard", async () => {
    enableInternalDB();
    // addCard issues two queries: MAX(position) + INSERT RETURNING *
    setResults(
      { rows: [{ next_pos: 1 }] },
      {
        rows: [
          {
            ...cardRow,
            id: "card-2",
            position: 1,
            title: "Weekly signups",
            sql: "SELECT COUNT(*) FROM users",
            chart_config: { type: "line", categoryColumn: "week", valueColumns: ["count"] },
          },
        ],
      },
    );
    const tools = createBoundDashboardTools(ctx);
    const result = await runTool<{
      kind: "ok";
      card: { id: string; title: string; chartType: string; position: number };
    }>(tools.addCard, {
      title: "Weekly signups",
      sql: "SELECT COUNT(*) FROM users",
      chartConfig: { type: "line", categoryColumn: "week", valueColumns: ["count"] },
    });
    expect(validateSQLMock).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("ok");
    expect(result.card).toMatchObject({
      id: "card-2",
      title: "Weekly signups",
      chartType: "line",
      position: 1,
    });
  });

  it("addCard refuses invalid SQL without persisting", async () => {
    enableInternalDB();
    const tools = createBoundDashboardTools(ctx);
    const result = await runTool<{ kind: "err"; error: string }>(tools.addCard, {
      title: "Bad",
      sql: "DROP TABLE users",
      chartConfig: { type: "table", categoryColumn: "x", valueColumns: ["x"] },
    });
    expect(result.kind).toBe("err");
    expect(result.error).toMatch(/validation failed/i);
    expect(queryCalls).toHaveLength(0); // no DB queries fired
  });

  // -------------------------------------------------------------------
  // updateCard
  // -------------------------------------------------------------------

  it("updateCard refuses when no fields supplied", async () => {
    enableInternalDB();
    const tools = createBoundDashboardTools(ctx);
    const result = await runTool<{ kind: "err"; error: string }>(tools.updateCard, {
      cardId: "card-1",
    });
    expect(result.kind).toBe("err");
    expect(result.error).toMatch(/No fields supplied/i);
    expect(queryCalls).toHaveLength(0);
  });

  it("updateCard persists supplied fields", async () => {
    enableInternalDB();
    setResults({ rows: [{ id: "card-1" }] });
    const tools = createBoundDashboardTools(ctx);
    const result = await runTool<{ kind: "ok"; cardId: string; updated: string[] }>(
      tools.updateCard,
      { cardId: "card-1", title: "Renamed" },
    );
    expect(result.kind).toBe("ok");
    expect(result.updated).toEqual(["title"]);
    expect(queryCalls[0].sql).toMatch(/UPDATE dashboard_cards/);
  });

  // -------------------------------------------------------------------
  // updateLayout
  // -------------------------------------------------------------------

  it("updateLayout applies per-card placements and reports partial failures", async () => {
    enableInternalDB();
    // Two updateCard calls — first succeeds, second card "card-9" misses
    setResults(
      { rows: [{ id: "card-1" }] }, // first updateCard succeeds
      { rows: [] }, // second updateCard misses (not_found)
    );
    const tools = createBoundDashboardTools(ctx);
    const result = await runTool<{
      kind: "ok" | "partial";
      results: { cardId: string; ok: boolean }[];
      failedCount?: number;
    }>(tools.updateLayout, {
      layouts: [
        { cardId: "card-1", x: 0, y: 0, w: 12, h: 8 },
        { cardId: "card-9", x: 12, y: 0, w: 12, h: 8 },
      ],
    });
    expect(result.kind).toBe("partial");
    expect(result.results[0]).toEqual({ cardId: "card-1", ok: true });
    expect(result.results[1].ok).toBe(false);
    expect(result.failedCount).toBe(1);
  });

  it("updateLayout rejects out-of-bounds placements without hitting the DB", async () => {
    enableInternalDB();
    const tools = createBoundDashboardTools(ctx);
    const result = await runTool<{
      kind: "ok" | "partial";
      results: { cardId: string; ok: boolean; reason?: string }[];
    }>(tools.updateLayout, {
      layouts: [
        // x+w = 30, exceeds 24-col grid → rejected by CardLayoutSchema.refine
        { cardId: "card-1", x: 12, y: 0, w: 18, h: 8 },
      ],
    });
    expect(result.kind).toBe("partial");
    expect(result.results[0].ok).toBe(false);
    expect(queryCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // updateDashboardMeta
  // -------------------------------------------------------------------

  it("updateDashboardMeta persists supplied fields", async () => {
    enableInternalDB();
    setResults({ rows: [{ id: "dash-1" }] }); // UPDATE dashboards
    const tools = createBoundDashboardTools(ctx);
    const result = await runTool<{ kind: "ok"; updated: string[] }>(
      tools.updateDashboardMeta,
      { title: "New title" },
    );
    expect(result.kind).toBe("ok");
    expect(result.updated).toEqual(["title"]);
    expect(queryCalls[0].sql).toMatch(/UPDATE dashboards/);
  });

  it("updateDashboardMeta refuses when no fields supplied", async () => {
    enableInternalDB();
    const tools = createBoundDashboardTools(ctx);
    const result = await runTool<{ kind: "err"; error: string }>(
      tools.updateDashboardMeta,
      {},
    );
    expect(result.kind).toBe("err");
    expect(queryCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // screenshotDashboard (#2367)
  // -------------------------------------------------------------------

  describe("screenshotDashboard", () => {
    const ctxWithUser = {
      dashboardId: "dash-1",
      orgId: "org-1" as string | null | undefined,
      userId: "user-1" as string | null,
      cookieHeader: "atlas-session=abc" as string | null,
    };

    it("forwards dashboardId / userId / cookie to the render pipeline", async () => {
      const tools = createBoundDashboardTools(ctxWithUser);
      const result = await runTool<{
        kind: "ok";
        mediaType: string;
        sizeBytes: number;
        cached: boolean;
      }>(tools.screenshotDashboard, {});
      expect(result.kind).toBe("ok");
      expect(result.mediaType).toBe("image/png");
      expect(result.sizeBytes).toBeGreaterThan(0);
      expect(screenshotMock).toHaveBeenCalledTimes(1);
      const call = screenshotMock.mock.calls[0][0];
      expect(call).toMatchObject({
        dashboardId: "dash-1",
        userId: "user-1",
        orgId: "org-1",
        cookieHeader: "atlas-session=abc",
      });
    });

    it("refuses to render without a userId (defence-in-depth for the per-user cache key)", async () => {
      const tools = createBoundDashboardTools({ ...ctxWithUser, userId: null });
      const result = await runTool<{ kind: "err"; error: string }>(
        tools.screenshotDashboard,
        {},
      );
      expect(result.kind).toBe("err");
      expect(result.error).toMatch(/authenticated user/i);
      expect(screenshotMock).not.toHaveBeenCalled();
    });

    it("surfaces render_failed as a tool error so the LLM can recover", async () => {
      screenshotMock.mockImplementationOnce(async () => ({
        ok: false as const,
        reason: "render_failed" as const,
        message: "Could not render dashboard screenshot. Try again or simplify the dashboard.",
      }));
      const tools = createBoundDashboardTools(ctxWithUser);
      const result = await runTool<{ kind: "err"; error: string }>(
        tools.screenshotDashboard,
        {},
      );
      expect(result.kind).toBe("err");
      expect(result.error).toMatch(/render dashboard screenshot/i);
    });

    it("addCard invalidates the screenshot cache on success", async () => {
      enableInternalDB();
      setResults(
        { rows: [{ next_pos: 1 }] },
        {
          rows: [
            {
              ...cardRow,
              id: "card-99",
              position: 1,
              title: "From-tool card",
            },
          ],
        },
      );
      const tools = createBoundDashboardTools(ctxWithUser);
      const result = await runTool<{ kind: "ok" }>(tools.addCard, {
        title: "From-tool card",
        sql: "SELECT 1",
        chartConfig: { type: "table", categoryColumn: "x", valueColumns: ["x"] },
      });
      expect(result.kind).toBe("ok");
      expect(invalidateScreenshotMock).toHaveBeenCalledWith("dash-1");
    });

    it("updateCard invalidates the screenshot cache on success", async () => {
      enableInternalDB();
      setResults({ rows: [{ id: "card-1" }] });
      const tools = createBoundDashboardTools(ctxWithUser);
      await runTool(tools.updateCard, { cardId: "card-1", title: "Renamed" });
      expect(invalidateScreenshotMock).toHaveBeenCalledWith("dash-1");
    });

    it("updateLayout invalidates the screenshot cache when any placement succeeds", async () => {
      enableInternalDB();
      setResults({ rows: [{ id: "card-1" }] });
      const tools = createBoundDashboardTools(ctxWithUser);
      await runTool(tools.updateLayout, {
        layouts: [{ cardId: "card-1", x: 0, y: 0, w: 12, h: 8 }],
      });
      expect(invalidateScreenshotMock).toHaveBeenCalledWith("dash-1");
    });

    it("updateDashboardMeta invalidates the screenshot cache on success", async () => {
      enableInternalDB();
      setResults({ rows: [{ id: "dash-1" }] });
      const tools = createBoundDashboardTools(ctxWithUser);
      await runTool(tools.updateDashboardMeta, { title: "New title" });
      expect(invalidateScreenshotMock).toHaveBeenCalledWith("dash-1");
    });

    it("emits a multimodal image-data part via toModelOutput", async () => {
      const tools = createBoundDashboardTools(ctxWithUser);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tool = tools.screenshotDashboard as any;
      const result = await runTool<{ kind: "ok"; _base64: string; mediaType: string }>(
        tool,
        {},
      );
      expect(result.kind).toBe("ok");
      expect(typeof result._base64).toBe("string");
      expect(result._base64.length).toBeGreaterThan(0);
      // toModelOutput is what the AI SDK calls to assemble the multimodal turn.
      // We assert the shape so a future SDK bump that changes the contract
      // breaks this test loudly rather than silently degrading to text-only.
      const modelOutput = tool.toModelOutput({
        toolCallId: "call-1",
        input: {},
        output: result,
      });
      expect(modelOutput.type).toBe("content");
      expect(Array.isArray(modelOutput.value)).toBe(true);
      const imagePart = modelOutput.value[0];
      expect(imagePart.type).toBe("image-data");
      expect(imagePart.mediaType).toBe("image/png");
      expect(imagePart.data).toBe(result._base64);
    });
  });
});
