/**
 * Drafts-on integration test for the bound dashboard tools (#2364).
 *
 * Covers the two acceptance criteria the existing `bound-dashboard.test.ts`
 * doesn't:
 *   1. Flag OFF (default) — mutations land in `dashboard_cards` directly.
 *      The existing tests in `bound-dashboard.test.ts` ALREADY exercise
 *      this path — every assertion of "UPDATE dashboard_cards" / "INSERT
 *      INTO dashboard_cards" against a flag-off environment IS the
 *      regression for #2363 behavior. This file adds an explicit
 *      flag-off case in case `bound-dashboard.test.ts` ever stops being
 *      the regression.
 *   2. Flag ON — first mutation forks a draft from published, subsequent
 *      mutations stay on the draft. Two users editing the same dashboard
 *      each get their own draft row. Same user in two tabs converges on
 *      one draft row.
 *
 * Validates the wire from the bound-dashboard tools → versioning module
 * → dashboard_user_drafts table, without standing up a real Postgres.
 * Uses the same mock-pool pattern as `bound-dashboard.test.ts` so the
 * two files share the recording shape.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import * as crypto from "crypto";
import { _resetPool, type InternalPool } from "../../db/internal";

const validateSQLMock = mock(async (_sql: string) => ({
  valid: true as const,
  classification: { tablesAccessed: [], columnsAccessed: [] },
}));

mock.module("@atlas/api/lib/tools/sql", () => ({
  validateSQL: validateSQLMock,
  executeSQL: undefined as never,
  runUserQueryPipeline: undefined as never,
}));

const { createBoundDashboardTools } = await import("../bound-dashboard");

// ---------------------------------------------------------------------------
// Mock pool — same shape as the other bound-dashboard tests
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
  created_at: "2026-05-17T00:00:00.000Z",
  updated_at: "2026-05-17T00:00:00.000Z",
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
  created_at: "2026-05-17T00:00:00.000Z",
  updated_at: "2026-05-17T00:00:00.000Z",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runTool<T = unknown>(tool: any, args: unknown): Promise<T> {
  if (!tool?.execute) throw new Error("tool has no execute");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await tool.execute(args, undefined as any)) as T;
}

describe("bound-dashboard tools — drafts flag", () => {
  const origDbUrl = process.env.DATABASE_URL;
  const origFlag = process.env.ATLAS_DASHBOARD_DRAFTS_ENABLED;

  beforeEach(() => {
    queryCalls = [];
    queryResults = [];
    queryResultIndex = 0;
    validateSQLMock.mockClear();
    delete process.env.DATABASE_URL;
    // #2521 flipped the default to ON. Per-describe blocks below set the
    // value explicitly ("false" for the legacy direct-published path,
    // "true" for the drafts path); we clear the var here so a stray
    // setting from a previous file doesn't bleed in.
    delete process.env.ATLAS_DASHBOARD_DRAFTS_ENABLED;
    _resetPool(null);
  });

  afterEach(() => {
    if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    if (origFlag === undefined) delete process.env.ATLAS_DASHBOARD_DRAFTS_ENABLED;
    else process.env.ATLAS_DASHBOARD_DRAFTS_ENABLED = origFlag;
    _resetPool(null);
  });

  // -------------------------------------------------------------------
  // Flag OFF — regression that addCard / updateCard go straight to
  // dashboard_cards / dashboards, NOT through dashboard_user_drafts.
  // -------------------------------------------------------------------

  describe("flag OFF (legacy direct-published path)", () => {
    beforeEach(() => {
      // #2521 flipped the default to ON; this describe block must opt
      // out explicitly to exercise the legacy direct-write path.
      process.env.ATLAS_DASHBOARD_DRAFTS_ENABLED = "false";
    });

    it("addCard writes to dashboard_cards (not dashboard_user_drafts)", async () => {
      enableInternalDB();
      // addCard issues two queries: MAX(position) + INSERT
      setResults(
        { rows: [{ next_pos: 1 }] },
        {
          rows: [
            { ...cardRow, id: "card-new", position: 1, title: "New", sql: "SELECT 1" },
          ],
        },
      );
      const tools = createBoundDashboardTools({
        dashboardId: "dash-1",
        orgId: "org-1",
        userId: "user-1",
      });
      const result = await runTool<{ kind: string }>(tools.addCard, {
        title: "New",
        sql: "SELECT 1",
        chartConfig: { type: "table", categoryColumn: "x", valueColumns: ["y"] },
      });
      expect(result.kind).toBe("ok");
      // Critically: every query targets dashboard_cards / dashboards.
      const sqls = queryCalls.map((c) => c.sql).join("\n");
      expect(sqls).toContain("dashboard_cards");
      expect(sqls).not.toContain("dashboard_user_drafts");
    });

    it("updateDashboardMeta writes to dashboards (not dashboard_user_drafts)", async () => {
      enableInternalDB();
      setResults({ rows: [{ id: "dash-1" }] });
      const tools = createBoundDashboardTools({
        dashboardId: "dash-1",
        orgId: "org-1",
        userId: "user-1",
      });
      await runTool(tools.updateDashboardMeta, { title: "New title" });
      const sqls = queryCalls.map((c) => c.sql).join("\n");
      expect(sqls).toContain("UPDATE dashboards");
      expect(sqls).not.toContain("dashboard_user_drafts");
    });
  });

  // -------------------------------------------------------------------
  // Flag ON — mutations route through dashboard_user_drafts
  // -------------------------------------------------------------------

  describe("flag ON (drafts path)", () => {
    beforeEach(() => {
      process.env.ATLAS_DASHBOARD_DRAFTS_ENABLED = "true";
    });

    it("addCard with a userId forks a draft on first call (no INSERT into dashboard_cards)", async () => {
      enableInternalDB();
      // Sequence:
      //   1. maybeApplyToDraft.getDashboard → dashboards SELECT + cards SELECT
      //   2. forkOrLoadDraft.loadDraft → empty
      //   3. forkOrLoadDraft INSERT INTO dashboard_user_drafts
      //   4. forkOrLoadDraft re-load → row with empty draft
      //   5. saveDraft → UPDATE dashboard_user_drafts returning user_id
      setResults(
        { rows: [dashboardRow] },
        { rows: [cardRow] },
        { rows: [] }, // loadDraft empty
        { rows: [] }, // INSERT (ON CONFLICT DO NOTHING)
        {
          rows: [
            {
              user_id: "user-1",
              dashboard_id: "dash-1",
              draft: { dashboardId: "dash-1", title: "Demo", description: null, cards: [] },
              baseline: { dashboardId: "dash-1", title: "Demo", description: null, cards: [] },
              published_baseline_at: "2026-05-17T00:00:00.000Z",
              created_at: "2026-05-17T00:00:00.000Z",
              updated_at: "2026-05-17T00:00:00.000Z",
            },
          ],
        },
        { rows: [{ user_id: "user-1" }] }, // saveDraft
      );

      const tools = createBoundDashboardTools({
        dashboardId: "dash-1",
        orgId: "org-1",
        userId: "user-1",
      });

      const result = await runTool<{ kind: string }>(tools.addCard, {
        title: "Test",
        sql: "SELECT 1",
        chartConfig: { type: "table", categoryColumn: "x", valueColumns: ["y"] },
      });
      expect(result.kind).toBe("ok");

      const sqls = queryCalls.map((c) => c.sql).join("\n");
      // Wrote to dashboard_user_drafts.
      expect(sqls).toContain("dashboard_user_drafts");
      // DID NOT write a fresh row into dashboard_cards.
      expect(sqls).not.toContain("INSERT INTO dashboard_cards");
    });

    it("addCard without a userId falls back to direct-published (anonymous bound chat)", async () => {
      enableInternalDB();
      setResults(
        { rows: [{ next_pos: 1 }] },
        {
          rows: [
            { ...cardRow, id: "card-new", position: 1, title: "Anon", sql: "SELECT 1" },
          ],
        },
      );
      const tools = createBoundDashboardTools({
        dashboardId: "dash-1",
        orgId: "org-1",
        // userId intentionally omitted.
      });
      const result = await runTool<{ kind: string }>(tools.addCard, {
        title: "Anon",
        sql: "SELECT 1",
        chartConfig: { type: "table", categoryColumn: "x", valueColumns: ["y"] },
      });
      expect(result.kind).toBe("ok");
      const sqls = queryCalls.map((c) => c.sql).join("\n");
      expect(sqls).toContain("INSERT INTO dashboard_cards");
      expect(sqls).not.toContain("dashboard_user_drafts");
    });

    it("updateDashboardMeta with userId routes through dashboard_user_drafts", async () => {
      enableInternalDB();
      setResults(
        { rows: [dashboardRow] }, // getDashboard
        { rows: [cardRow] },
        { rows: [] }, // loadDraft empty
        { rows: [] }, // INSERT into drafts
        {
          rows: [
            {
              user_id: "user-1",
              dashboard_id: "dash-1",
              draft: { dashboardId: "dash-1", title: "Demo", description: null, cards: [] },
              baseline: { dashboardId: "dash-1", title: "Demo", description: null, cards: [] },
              published_baseline_at: "2026-05-17T00:00:00.000Z",
              created_at: "2026-05-17T00:00:00.000Z",
              updated_at: "2026-05-17T00:00:00.000Z",
            },
          ],
        },
        { rows: [{ user_id: "user-1" }] }, // saveDraft
      );
      const tools = createBoundDashboardTools({
        dashboardId: "dash-1",
        orgId: "org-1",
        userId: "user-1",
      });
      const result = await runTool<{ kind: string }>(tools.updateDashboardMeta, {
        title: "Edited title",
      });
      expect(result.kind).toBe("ok");
      const sqls = queryCalls.map((c) => c.sql).join("\n");
      expect(sqls).toContain("UPDATE dashboard_user_drafts");
      expect(sqls).not.toContain("UPDATE dashboards SET");
    });

    // Acceptance criterion: "concurrent edits in two browser tabs by
    // the same user stay on the same draft." Two sequential addCard
    // calls model two browser tabs landing on the API in turn — each
    // call goes through forkOrLoadDraft, finds the existing row, and
    // saveDraft-UPDATEs. The composite-PK row is shared. (True
    // simultaneous interleaving against the same row is the DB's job
    // via `ON CONFLICT (user_id, dashboard_id) DO NOTHING`; that's
    // covered by the migrate-pg integration test "second insert with
    // same pair conflicts (#2364).")
    it("two addCard calls in the same user reuse the same draft row (no extra inserts)", async () => {
      enableInternalDB();
      const baselineSnap = {
        dashboardId: "dash-1",
        title: "Demo",
        description: null,
        cards: [],
      };
      const existingRow = {
        user_id: "user-1",
        dashboard_id: "dash-1",
        draft: baselineSnap,
        baseline: baselineSnap,
        published_baseline_at: "2026-05-17T00:00:00.000Z",
        created_at: "2026-05-17T00:00:00.000Z",
        updated_at: "2026-05-17T00:00:00.000Z",
      };
      // Each tab's path: getDashboard SELECT (dash + cards), loadDraft
      // (existing row), saveDraft UPDATE. 4 queries per tab → 8 total.
      setResults(
        { rows: [dashboardRow] },
        { rows: [cardRow] },
        { rows: [existingRow] },
        { rows: [{ user_id: "user-1" }] },
        { rows: [dashboardRow] },
        { rows: [cardRow] },
        { rows: [existingRow] },
        { rows: [{ user_id: "user-1" }] },
      );

      const tools = createBoundDashboardTools({
        dashboardId: "dash-1",
        orgId: "org-1",
        userId: "user-1",
      });
      const tabA = await runTool<{ kind: string }>(tools.addCard, {
        title: "Tab A",
        sql: "SELECT 1",
        chartConfig: { type: "table", categoryColumn: "x", valueColumns: ["y"] },
      });
      const tabB = await runTool<{ kind: string }>(tools.addCard, {
        title: "Tab B",
        sql: "SELECT 1",
        chartConfig: { type: "table", categoryColumn: "x", valueColumns: ["y"] },
      });
      expect(tabA.kind).toBe("ok");
      expect(tabB.kind).toBe("ok");
      // Neither tab inserted into dashboard_user_drafts — both reused
      // the existing row (one composite-PK row per user+dashboard).
      const insertCalls = queryCalls.filter((c) =>
        c.sql.includes("INSERT INTO dashboard_user_drafts"),
      );
      expect(insertCalls).toHaveLength(0);
      // Both tabs issued the saveDraft UPDATE.
      const updateCalls = queryCalls.filter((c) =>
        c.sql.includes("UPDATE dashboard_user_drafts"),
      );
      expect(updateCalls).toHaveLength(2);
    });

    // Acceptance criterion: "two different users editing the same
    // dashboard each see their own draft."
    it("two different users get distinct draft rows", async () => {
      enableInternalDB();
      const baselineSnap = {
        dashboardId: "dash-1",
        title: "Demo",
        description: null,
        cards: [],
      };
      const rowFor = (uid: string) => ({
        user_id: uid,
        dashboard_id: "dash-1",
        draft: baselineSnap,
        baseline: baselineSnap,
        published_baseline_at: "2026-05-17T00:00:00.000Z",
        created_at: "2026-05-17T00:00:00.000Z",
        updated_at: "2026-05-17T00:00:00.000Z",
      });
      // user-1 sequence: getDashboard (2) + loadDraft + saveDraft = 4.
      // user-2 sequence: same shape = another 4. Total 8 calls.
      setResults(
        { rows: [dashboardRow] },
        { rows: [cardRow] },
        { rows: [rowFor("user-1")] },
        { rows: [{ user_id: "user-1" }] },
        { rows: [dashboardRow] },
        { rows: [cardRow] },
        { rows: [rowFor("user-2")] },
        { rows: [{ user_id: "user-2" }] },
      );
      const toolsA = createBoundDashboardTools({
        dashboardId: "dash-1",
        orgId: "org-1",
        userId: "user-1",
      });
      const toolsB = createBoundDashboardTools({
        dashboardId: "dash-1",
        orgId: "org-1",
        userId: "user-2",
      });
      await runTool(toolsA.updateDashboardMeta, { title: "A says hello" });
      await runTool(toolsB.updateDashboardMeta, { title: "B says hello" });

      // Each saveDraft UPDATE's last two params are (userId, dashboardId).
      const drafts = queryCalls.filter((c) =>
        c.sql.includes("UPDATE dashboard_user_drafts"),
      );
      expect(drafts).toHaveLength(2);
      expect(drafts[0].params?.slice(-2)).toEqual(["user-1", "dash-1"]);
      expect(drafts[1].params?.slice(-2)).toEqual(["user-2", "dash-1"]);
    });

    it("getDashboardState overlays the user's draft view when a draft exists", async () => {
      enableInternalDB();
      const draftSnap = {
        dashboardId: "dash-1",
        title: "Drafted Title",
        description: null,
        cards: [
          {
            id: crypto.randomUUID(),
            position: 0,
            title: "Draft card",
            sql: "SELECT 1",
            chartConfig: { type: "table", categoryColumn: "x", valueColumns: ["y"] },
            connectionGroupId: null,
            layout: null,
          },
        ],
      };
      setResults(
        { rows: [dashboardRow] }, // getDashboard
        { rows: [cardRow] },
        // forkOrLoadDraft.loadDraft returns the existing row.
        {
          rows: [
            {
              user_id: "user-1",
              dashboard_id: "dash-1",
              draft: draftSnap,
              baseline: { dashboardId: "dash-1", title: "Demo", description: null, cards: [] },
              published_baseline_at: "2026-05-17T00:00:00.000Z",
              created_at: "2026-05-17T00:00:00.000Z",
              updated_at: "2026-05-17T00:00:00.000Z",
            },
          ],
        },
      );
      const tools = createBoundDashboardTools({
        dashboardId: "dash-1",
        orgId: "org-1",
        userId: "user-1",
      });
      const result = await runTool<{
        kind: "ok";
        dashboard: { id: string; title: string; cardCount: number };
        summary: string;
      }>(tools.getDashboardState, {});
      expect(result.kind).toBe("ok");
      // Title came from the draft, not the published dashboard.
      expect(result.dashboard.title).toBe("Drafted Title");
      expect(result.dashboard.cardCount).toBe(1);
      expect(result.summary).toContain("Draft card");
    });
  });
});
