/**
 * Unit tests for the bound chat context module (#2363).
 *
 * Uses the `_resetPool(mockPool)` injection pattern (same as
 * conversations.test.ts) — `mock.module()` deadlocks under bun's
 * full suite (see feedback_bun_test_async_mock_module.md).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { _resetPool, type InternalPool } from "../db/internal";
import {
  bindConversationToDashboard,
  resolveBoundDashboard,
  listSessionsForDashboard,
  getSessionTranscript,
  buildCardSummary,
  BOUND_AGENT_PROMPT_GUIDANCE,
} from "../bound-chat-context";
import type { DashboardCard } from "../dashboard-types";

// ---------------------------------------------------------------------------
// Mock pool
// ---------------------------------------------------------------------------

interface QueryRecording {
  sql: string;
  params?: unknown[];
}

interface QueryResult {
  rows: Record<string, unknown>[];
}

let queryCalls: QueryRecording[] = [];
let queryResults: QueryResult[] = [];
let queryResultIndex = 0;
let queryThrow: Error | null = null;

const mockPool: InternalPool = {
  query: async (sql: string, params?: unknown[]) => {
    if (queryThrow) throw queryThrow;
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe("bound-chat-context module", () => {
  const origDbUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    queryCalls = [];
    queryResults = [];
    queryResultIndex = 0;
    queryThrow = null;
    delete process.env.DATABASE_URL;
    _resetPool(null);
  });

  afterEach(() => {
    if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    _resetPool(null);
  });

  // -------------------------------------------------------------------
  // buildCardSummary (pure)
  // -------------------------------------------------------------------

  describe("buildCardSummary", () => {
    it("returns a no-cards hint when the list is empty", () => {
      const summary = buildCardSummary([]);
      expect(summary).toContain("no cards yet");
      expect(summary).toContain("addCard");
    });

    it("lists each card with id, title, chart type, position, and layout", () => {
      const cards: DashboardCard[] = [
        {
          id: "card-1",
          dashboardId: "dash-1",
          position: 0,
          title: "Weekly signups",
          sql: "SELECT 1",
          chartConfig: { type: "line", categoryColumn: "week", valueColumns: ["count"] },
          cachedColumns: null,
          cachedRows: null,
          cachedAt: null,
          connectionGroupId: null,
          layout: { x: 0, y: 0, w: 12, h: 8 },
          createdAt: "2026-05-17",
          updatedAt: "2026-05-17",
        },
        {
          id: "card-2",
          dashboardId: "dash-1",
          position: 1,
          title: "Active users",
          sql: "SELECT 2",
          chartConfig: null,
          cachedColumns: null,
          cachedRows: null,
          cachedAt: null,
          connectionGroupId: null,
          layout: null,
          createdAt: "2026-05-17",
          updatedAt: "2026-05-17",
        },
      ];
      const summary = buildCardSummary(cards);
      expect(summary).toContain("[card-1] \"Weekly signups\" — line — pos=0 — x=0,y=0,w=12,h=8");
      // Card without chartConfig falls back to "table"; without layout to "auto-laid"
      expect(summary).toContain("[card-2] \"Active users\" — table — pos=1 — auto-laid");
      expect(summary).toContain("2 cards");
    });
  });

  // -------------------------------------------------------------------
  // bindConversationToDashboard
  // -------------------------------------------------------------------

  describe("bindConversationToDashboard", () => {
    it("returns no_db when internal DB is unavailable", async () => {
      const result = await bindConversationToDashboard("conv-1", "dash-1", { orgId: "org-1" });
      expect(result).toEqual({ ok: false, reason: "no_db" });
    });

    it("returns dashboard_not_found when org-scoped dashboard lookup misses", async () => {
      enableInternalDB();
      // getDashboard issues two queries (dashboard row, then cards). When the
      // first returns zero rows the function short-circuits to not_found
      // before the cards query runs, so a single empty result is enough.
      setResults({ rows: [] });
      const result = await bindConversationToDashboard("conv-1", "dash-1", { orgId: "org-1" });
      expect(result).toEqual({ ok: false, reason: "dashboard_not_found" });
    });

    it("writes bound_dashboard_id when the org check passes", async () => {
      enableInternalDB();
      // Result 1: dashboard row (org-scoped). Result 2: cards. Result 3: UPDATE returning id.
      setResults(
        {
          rows: [
            {
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
              card_count: 0,
              created_at: "2026-05-17",
              updated_at: "2026-05-17",
            },
          ],
        },
        { rows: [] },
        { rows: [{ id: "conv-1" }] },
      );
      const result = await bindConversationToDashboard("conv-1", "dash-1", { orgId: "org-1" });
      expect(result).toEqual({ ok: true });
      // Last query is the UPDATE writing bound_dashboard_id
      const updateCall = queryCalls[queryCalls.length - 1];
      expect(updateCall.sql).toMatch(/UPDATE conversations/i);
      expect(updateCall.sql).toMatch(/bound_dashboard_id/i);
      expect(updateCall.params).toEqual(["dash-1", "conv-1"]);
    });

    it("returns conversation_not_found when the UPDATE matches zero rows", async () => {
      enableInternalDB();
      setResults(
        {
          rows: [
            {
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
              card_count: 0,
              created_at: "2026-05-17",
              updated_at: "2026-05-17",
            },
          ],
        },
        { rows: [] }, // cards
        { rows: [] }, // UPDATE returned nothing — conversation row missing
      );
      const result = await bindConversationToDashboard("ghost-conv", "dash-1", { orgId: "org-1" });
      expect(result).toEqual({ ok: false, reason: "conversation_not_found" });
    });
  });

  // -------------------------------------------------------------------
  // resolveBoundDashboard
  // -------------------------------------------------------------------

  describe("resolveBoundDashboard", () => {
    it("returns not_bound when the conversation has no bound_dashboard_id", async () => {
      enableInternalDB();
      setResults({ rows: [{ bound_dashboard_id: null }] });
      const r = await resolveBoundDashboard("conv-1", { orgId: "org-1" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("not_bound");
    });

    it("returns not_bound when the conversation row is missing", async () => {
      enableInternalDB();
      setResults({ rows: [] });
      const r = await resolveBoundDashboard("ghost", { orgId: "org-1" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("not_bound");
    });

    it("returns dashboard_not_found when the bound dashboard is gone / cross-org", async () => {
      enableInternalDB();
      setResults(
        { rows: [{ bound_dashboard_id: "dash-X" }] }, // conversation lookup
        { rows: [] }, // dashboard lookup misses
      );
      const r = await resolveBoundDashboard("conv-1", { orgId: "org-1" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("dashboard_not_found");
    });

    it("returns the dashboard + cards on success", async () => {
      enableInternalDB();
      setResults(
        { rows: [{ bound_dashboard_id: "dash-1" }] },
        {
          rows: [
            {
              id: "dash-1",
              org_id: "org-1",
              owner_id: "user-1",
              title: "Demo",
              description: "Test",
              share_token: null,
              share_expires_at: null,
              share_mode: "public",
              refresh_schedule: null,
              last_refresh_at: null,
              next_refresh_at: null,
              card_count: 1,
              created_at: "2026-05-17",
              updated_at: "2026-05-17",
            },
          ],
        },
        {
          rows: [
            {
              id: "card-1",
              dashboard_id: "dash-1",
              position: 0,
              title: "KPI",
              sql: "SELECT 1",
              chart_config: null,
              cached_columns: null,
              cached_rows: null,
              cached_at: null,
              connection_group_id: null,
              layout: null,
              created_at: "2026-05-17",
              updated_at: "2026-05-17",
            },
          ],
        },
      );
      const r = await resolveBoundDashboard("conv-1", { orgId: "org-1" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.dashboard.id).toBe("dash-1");
        expect(r.dashboard.cards).toHaveLength(1);
        expect(r.dashboard.cards[0].id).toBe("card-1");
      }
    });
  });

  // -------------------------------------------------------------------
  // listSessionsForDashboard
  // -------------------------------------------------------------------

  describe("listSessionsForDashboard", () => {
    it("returns [] when internal DB is unavailable", async () => {
      const rows = await listSessionsForDashboard("dash-1", "org-1");
      expect(rows).toEqual([]);
    });

    it("scopes to (dashboardId, orgId-or-NULL) and maps row shape", async () => {
      enableInternalDB();
      setResults({
        rows: [
          {
            id: "conv-1",
            user_id: "user-1",
            title: "First session",
            created_at: "2026-05-17T10:00:00Z",
            updated_at: "2026-05-17T10:30:00Z",
            message_count: 4,
          },
          {
            id: "conv-2",
            user_id: null,
            title: null,
            created_at: "2026-05-17T11:00:00Z",
            updated_at: "2026-05-17T11:00:00Z",
            message_count: "0", // PG returns COALESCE(COUNT(*), 0) as text in some configs
          },
        ],
      });
      const rows = await listSessionsForDashboard("dash-1", "org-1");
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        conversationId: "conv-1",
        userId: "user-1",
        title: "First session",
        messageCount: 4,
      });
      expect(rows[1].messageCount).toBe(0); // string "0" coerced
      // Predicate threads dashboardId + orgId + org-IS-NULL fallback
      const sentSql = queryCalls[0].sql;
      expect(sentSql).toMatch(/bound_dashboard_id = \$1/);
      expect(sentSql).toMatch(/c\.org_id = \$2 OR c\.org_id IS NULL/);
      expect(queryCalls[0].params).toEqual(["dash-1", "org-1"]);
    });

    it("omits the org clause when no orgId is supplied", async () => {
      enableInternalDB();
      setResults({ rows: [] });
      await listSessionsForDashboard("dash-1", null);
      const sentSql = queryCalls[0].sql;
      expect(sentSql).not.toMatch(/c\.org_id/);
      expect(queryCalls[0].params).toEqual(["dash-1"]);
    });
  });

  // -------------------------------------------------------------------
  // getSessionTranscript (#2368) — workspace-wide read, no user-ownership
  // gate; dashboard binding + org scope are the only filters.
  // -------------------------------------------------------------------

  describe("getSessionTranscript", () => {
    it("returns no_db when internal DB is unavailable", async () => {
      const r = await getSessionTranscript("dash-1", "conv-1", "org-1");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("no_db");
    });

    it("threads dashboardId + conversationId + org-IS-NULL fallback into the predicate", async () => {
      enableInternalDB();
      setResults({
        rows: [
          {
            id: "conv-1",
            user_id: "user-1",
            title: "Sess",
            created_at: "2026-05-17T10:00:00Z",
            updated_at: "2026-05-17T10:30:00Z",
          },
        ],
      }, { rows: [] });
      await getSessionTranscript("dash-1", "conv-1", "org-1");
      const convSql = queryCalls[0]!.sql;
      expect(convSql).toMatch(/bound_dashboard_id = \$1/);
      expect(convSql).toMatch(/id = \$2/);
      expect(convSql).toMatch(/org_id = \$3 OR org_id IS NULL/);
      expect(queryCalls[0]!.params).toEqual(["dash-1", "conv-1", "org-1"]);
    });

    it("returns not_found when the conversation isn't bound to this dashboard (org_id mismatch suppressed too)", async () => {
      enableInternalDB();
      setResults({ rows: [] });
      const r = await getSessionTranscript("dash-1", "ghost", "org-1");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("not_found");
    });

    it("omits the org clause when no orgId is supplied (self-hosted single-tenant)", async () => {
      enableInternalDB();
      setResults({ rows: [{
        id: "conv-1", user_id: null, title: null,
        created_at: "2026-05-17", updated_at: "2026-05-17",
      }] }, { rows: [] });
      await getSessionTranscript("dash-1", "conv-1", null);
      const convSql = queryCalls[0]!.sql;
      expect(convSql).not.toMatch(/org_id/);
      expect(queryCalls[0]!.params).toEqual(["dash-1", "conv-1"]);
    });

    it("returns the transcript with messages in created_at order", async () => {
      enableInternalDB();
      setResults(
        {
          rows: [
            {
              id: "conv-1",
              user_id: "user-A",
              title: "Edited the trend",
              created_at: "2026-05-17T10:00:00Z",
              updated_at: "2026-05-17T10:30:00Z",
            },
          ],
        },
        {
          rows: [
            {
              id: "msg-1",
              conversation_id: "conv-1",
              role: "user",
              content: [{ type: "text", text: "add a churn card" }],
              created_at: "2026-05-17T10:00:01Z",
            },
            {
              id: "msg-2",
              conversation_id: "conv-1",
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              created_at: "2026-05-17T10:00:05Z",
            },
          ],
        },
      );
      const r = await getSessionTranscript("dash-1", "conv-1", "org-1");
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.conversationId).toBe("conv-1");
        expect(r.data.dashboardId).toBe("dash-1");
        expect(r.data.userId).toBe("user-A");
        expect(r.data.title).toBe("Edited the trend");
        expect(r.data.messages).toHaveLength(2);
        expect(r.data.messages[0]!.role).toBe("user");
        expect(r.data.messages[1]!.role).toBe("assistant");
      }
      // Second query is the messages fetch, scoped to conversation
      // only, plus a defensive LIMIT to bound the response (DoS guard
      // — a runaway bound chat with 10k turns would otherwise serialize
      // every message in one shot).
      const msgSql = queryCalls[1]!.sql;
      expect(msgSql).toMatch(/conversation_id = \$1/);
      expect(msgSql).toMatch(/LIMIT \$2/);
      expect(queryCalls[1]!.params).toEqual(["conv-1", 1000]);
    });

    it("reads workspace-wide — does NOT add a user-ownership predicate", async () => {
      // Regression guard: the workspace-visibility ACL is the entire
      // point of this slice. If a future refactor adds `user_id = $N`
      // to the gate, the History tab silently goes per-user.
      enableInternalDB();
      setResults({ rows: [{
        id: "conv-1", user_id: "someone-else", title: null,
        created_at: "2026-05-17", updated_at: "2026-05-17",
      }] }, { rows: [] });
      await getSessionTranscript("dash-1", "conv-1", "org-1");
      const convSql = queryCalls[0]!.sql;
      expect(convSql).not.toMatch(/user_id\s*=/);
    });
  });

  // -------------------------------------------------------------------
  // BOUND_AGENT_PROMPT_GUIDANCE — sanity check that the export carries
  // the composition rules so the agent.ts swap is meaningful.
  // -------------------------------------------------------------------

  describe("BOUND_AGENT_PROMPT_GUIDANCE", () => {
    it("contains the dashboard-composition rules", () => {
      expect(BOUND_AGENT_PROMPT_GUIDANCE).toContain("24 columns wide");
      expect(BOUND_AGENT_PROMPT_GUIDANCE).toContain("addCard");
      expect(BOUND_AGENT_PROMPT_GUIDANCE).toContain("updateCard");
      expect(BOUND_AGENT_PROMPT_GUIDANCE).toContain("Suggested Follow-ups");
    });

    it("mentions vision is available for spatial questions (#2367)", () => {
      // The agent must know `screenshotDashboard` exists when answering
      // "what's on the bottom-right?" — otherwise it'll only ever reach
      // for the textual card summary.
      expect(BOUND_AGENT_PROMPT_GUIDANCE).toContain("screenshotDashboard");
      expect(BOUND_AGENT_PROMPT_GUIDANCE.toLowerCase()).toContain("spatial");
    });
  });
});
