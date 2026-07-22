/**
 * Unit tests for the conversations CRUD module.
 *
 * Uses _resetPool(mockPool) injection pattern from audit.test.ts to
 * avoid mock.module (unreliable in bun's full test suite).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { _resetPool, type InternalPool } from "../db/internal";
import {
  generateTitle,
  createConversation,
  addMessage,
  getConversation,
  listConversations,
  deleteConversation,
  starConversation,
  shareConversation,
  unshareConversation,
  getShareStatus,
  getSharedConversation,
  cleanupExpiredShares,
  updateConversationScope,
} from "../conversations";
import type { ConversationScopePatch } from "../conversation-scope";

// ---------------------------------------------------------------------------
// Mock pool
// ---------------------------------------------------------------------------

let queryCalls: Array<{ sql: string; params?: unknown[] }> = [];
let queryResults: Array<{ rows: Record<string, unknown>[] }> = [];
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

function setResults(...results: Array<{ rows: Record<string, unknown>[] }>) {
  queryResults = results;
  queryResultIndex = 0;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

describe("conversations module", () => {
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

  // -------------------------------------------------------------------------
  // generateTitle
  // -------------------------------------------------------------------------

  describe("generateTitle()", () => {
    it("returns the question when <= 80 chars", () => {
      expect(generateTitle("How many users?")).toBe("How many users?");
    });

    it("truncates to 80 chars with ellipsis", () => {
      const long = "a".repeat(100);
      const title = generateTitle(long);
      expect(title.length).toBe(80);
      expect(title.endsWith("...")).toBe(true);
    });

    it("strips newlines", () => {
      expect(generateTitle("line1\nline2\r\nline3")).toBe("line1 line2 line3");
    });

    it("returns default for empty input", () => {
      expect(generateTitle("")).toBe("New conversation");
      expect(generateTitle("   ")).toBe("New conversation");
    });

    it("handles long input with ellipsis", () => {
      const long = "How many users signed up in the last quarter and what was their average revenue contribution " + "x".repeat(50);
      const title = generateTitle(long);
      expect(title.length).toBe(80);
      expect(title.endsWith("...")).toBe(true);
    });

    it("returns the exact string at the 80-char boundary", () => {
      const exactly80 = "a".repeat(80);
      expect(generateTitle(exactly80)).toBe(exactly80);
    });
  });

  // -------------------------------------------------------------------------
  // createConversation
  // -------------------------------------------------------------------------

  describe("createConversation()", () => {
    it("returns { id } on success", async () => {
      enableInternalDB();
      setResults({ rows: [{ id: "conv-123" }] });

      const result = await createConversation({ userId: "u1", title: "Test" });
      expect(result).toEqual({ id: "conv-123" });
      expect(queryCalls[0].sql).toContain("INSERT INTO conversations");
      // [user_id, title, surface, connection_id, connection_group_id, routing_mode, rest_excluded_datasource_ids, rest_focus_datasource_id, group_reach, answer_style, org_id]
      expect(queryCalls[0].params).toEqual(["u1", "Test", "web", null, null, null, [], null, null, null, null]);
    });

    it("returns null when no DB", async () => {
      const result = await createConversation({ userId: "u1" });
      expect(result).toBeNull();
    });

    it("returns null on DB error", async () => {
      enableInternalDB();
      queryThrow = new Error("connection refused");

      const result = await createConversation({ userId: "u1" });
      expect(result).toBeNull();
    });

    it("uses default surface 'web'", async () => {
      enableInternalDB();
      setResults({ rows: [{ id: "conv-456" }] });

      await createConversation({});
      expect(queryCalls[0].params).toEqual([null, null, "web", null, null, null, [], null, null, null, null]);
    });

    it("accepts custom surface and connectionId", async () => {
      enableInternalDB();
      setResults({ rows: [{ id: "conv-789" }] });

      await createConversation({ surface: "api", connectionId: "wh" });
      expect(queryCalls[0].params).toEqual([null, null, "api", "wh", null, null, [], null, null, null, null]);
    });

    it("includes orgId when provided", async () => {
      enableInternalDB();
      setResults({ rows: [{ id: "conv-org" }] });

      const result = await createConversation({ userId: "u1", orgId: "org-123" });
      expect(result).toEqual({ id: "conv-org" });
      expect(queryCalls[0].params).toEqual(["u1", null, "web", null, null, null, [], null, null, null, "org-123"]);
    });

    // #2345 — group-aware routing. Both columns are independent;
    // the helper must persist whichever subset the caller supplies.
    it("persists connectionGroupId additively alongside connectionId", async () => {
      enableInternalDB();
      setResults({ rows: [{ id: "conv-2345" }] });

      await createConversation({
        userId: "u1",
        connectionId: "us-int",
        connectionGroupId: "g_prod",
        orgId: "org-1",
      });
      expect(queryCalls[0].sql).toContain("connection_group_id");
      expect(queryCalls[0].params).toEqual([
        "u1",
        null,
        "web",
        "us-int",
        "g_prod",
        null,
        [],
        null,
        null,
        null,
        "org-1",
      ]);
    });

    it("accepts a group-only conversation (connectionId omitted)", async () => {
      // A workspace primary group with no member yet — still
      // persists the content-scope column so downstream entity reads
      // resolve through the group even before an execution target
      // is chosen.
      enableInternalDB();
      setResults({ rows: [{ id: "conv-group-only" }] });

      await createConversation({
        userId: "u1",
        connectionGroupId: "g_prod",
        orgId: "org-1",
      });
      expect(queryCalls[0].params).toEqual([
        "u1",
        null,
        "web",
        null,
        "g_prod",
        null,
        [],
        null,
        null,
        null,
        "org-1",
      ]);
    });

    // #3067 — persist a REST-only focus at creation (the rest_focus_datasource_id
    // param sits between the exclude-set and org_id).
    it("persists restFocusDatasourceId when the conversation is created focused", async () => {
      enableInternalDB();
      setResults({ rows: [{ id: "conv-focus" }] });

      await createConversation({
        userId: "u1",
        restFocusDatasourceId: "ds-stripe",
        orgId: "org-1",
      });
      expect(queryCalls[0].sql).toContain("rest_focus_datasource_id");
      expect(queryCalls[0].params).toEqual([
        "u1",
        null,
        "web",
        null,
        null,
        null,
        [],
        "ds-stripe",
        null,
        null,
        "org-1",
      ]);
    });

    // #4302 — persist an answer style at creation (the answer_style param
    // sits between group_reach and org_id).
    it("persists answerStyle when the conversation is created with a picked style", async () => {
      enableInternalDB();
      setResults({ rows: [{ id: "conv-style" }] });

      await createConversation({
        userId: "u1",
        answerStyle: "executive",
        orgId: "org-1",
      });
      expect(queryCalls[0].sql).toContain("answer_style");
      expect(queryCalls[0].params).toEqual([
        "u1",
        null,
        "web",
        null,
        null,
        null,
        [],
        null,
        null,
        "executive",
        "org-1",
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // addMessage
  // -------------------------------------------------------------------------

  describe("addMessage()", () => {
    it("fires two queries (INSERT + UPDATE)", () => {
      enableInternalDB();

      addMessage({ conversationId: "c1", role: "user", content: [{ type: "text", text: "hi" }] });

      // internalExecute is fire-and-forget — queries are dispatched synchronously
      expect(queryCalls.length).toBe(2);
      expect(queryCalls[0].sql).toContain("INSERT INTO messages");
      expect(queryCalls[1].sql).toContain("UPDATE conversations");
    });

    it("is a no-op when no DB", () => {
      addMessage({ conversationId: "c1", role: "user", content: "hi" });
      expect(queryCalls.length).toBe(0);
    });

    it("does not throw on error", () => {
      enableInternalDB();
      queryThrow = new Error("connection lost");

      // internalExecute catches async errors; the try-catch in addMessage
      // catches the sync throw from getInternalDB if pool is null.
      // Here pool is set, so the throw happens inside the promise.
      expect(() => {
        addMessage({ conversationId: "c1", role: "user", content: "hi" });
      }).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // getConversation
  // -------------------------------------------------------------------------

  describe("getConversation()", () => {
    it("returns { ok: true, data } with conversation and messages", async () => {
      enableInternalDB();
      setResults(
        {
          rows: [{
            id: "c1",
            user_id: "u1",
            title: "Test",
            surface: "web",
            connection_id: null,
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-01T00:00:00Z",
          }],
        },
        {
          rows: [{
            id: "m1",
            conversation_id: "c1",
            role: "user",
            content: { type: "text", text: "hello" },
            created_at: "2024-01-01T00:00:00Z",
          }],
        },
      );

      const result = await getConversation("c1", "u1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.id).toBe("c1");
        expect(result.data.messages).toHaveLength(1);
        expect(result.data.messages[0].role).toBe("user");
      }
    });

    // #4302 — the read side of answer-style persistence: a stored style comes
    // back typed; NULL and out-of-vocabulary strings (a style retired from the
    // registry, a manual DB edit) both read as null = "track the default",
    // never a junk string leaking into the typed union.
    it("maps answer_style through the registry guard (stored value | NULL | junk)", async () => {
      enableInternalDB();
      const baseRow = {
        id: "c1",
        user_id: "u1",
        title: "Test",
        surface: "web",
        connection_id: null,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
      };
      const emptyMessages = { rows: [] as Record<string, unknown>[] };

      setResults({ rows: [{ ...baseRow, answer_style: "executive" }] }, emptyMessages);
      let result = await getConversation("c1", "u1");
      // Pin the column into the SELECT list too — dropping it there would
      // silently read every restore-on-reopen as null while this mapping
      // test (which feeds rows directly) stayed green.
      expect(queryCalls[0].sql).toContain("answer_style");
      expect(result.ok && result.data.answerStyle).toBe("executive");

      setResults({ rows: [{ ...baseRow, answer_style: null }] }, emptyMessages);
      result = await getConversation("c1", "u1");
      expect(result.ok && result.data.answerStyle).toBeNull();

      setResults({ rows: [{ ...baseRow, answer_style: "sarcastic" }] }, emptyMessages);
      result = await getConversation("c1", "u1");
      expect(result.ok && result.data.answerStyle).toBeNull();
    });

    it("returns { ok: false, reason: 'not_found' } when not found", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      const result = await getConversation("missing");
      expect(result).toEqual({ ok: false, reason: "not_found" });
    });

    it("returns { ok: false, reason: 'not_found' } when wrong user", async () => {
      enableInternalDB();
      // Query returns empty because user_id doesn't match
      setResults({ rows: [] });

      const result = await getConversation("c1", "wrong-user");
      expect(result).toEqual({ ok: false, reason: "not_found" });
    });

    it("returns { ok: false, reason: 'no_db' } when no DB", async () => {
      const result = await getConversation("c1");
      expect(result).toEqual({ ok: false, reason: "no_db" });
    });

    it("returns { ok: false, reason: 'error' } on DB error", async () => {
      enableInternalDB();
      queryThrow = new Error("connection lost");
      const result = await getConversation("c1", "u1");
      expect(result).toEqual({ ok: false, reason: "error" });
    });

    it("queries without user filter when userId is undefined", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      await getConversation("c1");
      expect(queryCalls[0].sql).not.toContain("AND user_id");
      expect(queryCalls[0].params).toEqual(["c1"]);
    });

    it("queries with user filter when userId is provided", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      await getConversation("c1", "u1");
      expect(queryCalls[0].sql).toContain("AND user_id");
      expect(queryCalls[0].params).toEqual(["c1", "u1"]);
    });
  });

  // -------------------------------------------------------------------------
  // listConversations
  // -------------------------------------------------------------------------

  describe("listConversations()", () => {
    it("returns conversations and total", async () => {
      enableInternalDB();
      setResults(
        { rows: [{ total: 1 }] },
        {
          rows: [{
            id: "c1",
            user_id: "u1",
            title: "Test",
            surface: "web",
            connection_id: null,
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-01T00:00:00Z",
          }],
        },
      );

      const result = await listConversations({ userId: "u1" });
      expect(result.total).toBe(1);
      expect(result.conversations).toHaveLength(1);
      expect(result.conversations[0].id).toBe("c1");
      // #4302 — pin the column into the list SELECT (same rationale as the
      // getConversation mapping test: dropping it from the SQL would read
      // every row's style as null while row-fed mapping tests stayed green).
      expect(queryCalls[1].sql).toContain("answer_style");
    });

    it("returns empty when no DB", async () => {
      const result = await listConversations();
      expect(result).toEqual({ conversations: [], total: 0 });
    });

    it("respects limit and offset", async () => {
      enableInternalDB();
      setResults({ rows: [{ total: 50 }] }, { rows: [] });

      await listConversations({ limit: 5, offset: 10 });
      expect(queryCalls[1].params).toEqual([5, 10]);
    });

    it("scopes by userId when provided", async () => {
      enableInternalDB();
      setResults({ rows: [{ total: 3 }] }, { rows: [] });

      await listConversations({ userId: "u1", limit: 20, offset: 0 });
      expect(queryCalls[0].sql).toContain("user_id");
      expect(queryCalls[0].params).toEqual(["u1"]);
    });

    it("does not scope by userId when not provided", async () => {
      enableInternalDB();
      setResults({ rows: [{ total: 3 }] }, { rows: [] });

      await listConversations();
      expect(queryCalls[0].sql).not.toContain("user_id = $1");
    });

    it("scopes by orgId when provided", async () => {
      enableInternalDB();
      setResults({ rows: [{ total: 2 }] }, { rows: [] });

      await listConversations({ orgId: "org-123" });
      expect(queryCalls[0].sql).toContain("org_id");
      expect(queryCalls[0].params).toEqual(["org-123"]);
    });

    it("scopes by both userId and orgId", async () => {
      enableInternalDB();
      setResults({ rows: [{ total: 1 }] }, { rows: [] });

      await listConversations({ userId: "u1", orgId: "org-456" });
      expect(queryCalls[0].sql).toContain("user_id");
      expect(queryCalls[0].sql).toContain("org_id");
      expect(queryCalls[0].params).toEqual(["u1", "org-456"]);
    });

    it("uses default limit=20, offset=0", async () => {
      enableInternalDB();
      setResults({ rows: [{ total: 0 }] }, { rows: [] });

      await listConversations();
      expect(queryCalls[1].params).toEqual([20, 0]);
    });

    it("returns empty on DB error", async () => {
      enableInternalDB();
      queryThrow = new Error("connection lost");
      const result = await listConversations({ userId: "u1" });
      expect(result).toEqual({ conversations: [], total: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // starConversation
  // -------------------------------------------------------------------------

  describe("starConversation()", () => {
    it("returns { ok: true } when conversation exists", async () => {
      enableInternalDB();
      setResults({ rows: [{ id: "c1" }] });

      const result = await starConversation("c1", true);
      expect(result).toEqual({ ok: true });
      expect(queryCalls[0].sql).toContain("UPDATE conversations SET starred");
      expect(queryCalls[0].params).toEqual([true, "c1"]);
    });

    it("returns { ok: false, reason: 'not_found' } when conversation not found", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      const result = await starConversation("missing", true);
      expect(result).toEqual({ ok: false, reason: "not_found" });
    });

    it("returns { ok: false, reason: 'no_db' } when no DB", async () => {
      const result = await starConversation("c1", true);
      expect(result).toEqual({ ok: false, reason: "no_db" });
    });

    it("returns { ok: false, reason: 'error' } on DB error", async () => {
      enableInternalDB();
      queryThrow = new Error("connection lost");
      const result = await starConversation("c1", true);
      expect(result).toEqual({ ok: false, reason: "error" });
    });

    it("scopes by userId when provided", async () => {
      enableInternalDB();
      setResults({ rows: [{ id: "c1" }] });

      await starConversation("c1", true, "u1");
      expect(queryCalls[0].sql).toContain("user_id");
      expect(queryCalls[0].params).toEqual([true, "c1", "u1"]);
    });

    it("can unstar a conversation", async () => {
      enableInternalDB();
      setResults({ rows: [{ id: "c1" }] });

      const result = await starConversation("c1", false, "u1");
      expect(result).toEqual({ ok: true });
      expect(queryCalls[0].params).toEqual([false, "c1", "u1"]);
    });
  });

  // -------------------------------------------------------------------------
  // listConversations with starred filter
  // -------------------------------------------------------------------------

  describe("listConversations() with starred filter", () => {
    it("filters by starred=true", async () => {
      enableInternalDB();
      setResults({ rows: [{ total: 1 }] }, {
        rows: [{
          id: "c1",
          user_id: "u1",
          title: "Starred conv",
          surface: "web",
          connection_id: null,
          starred: true,
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
        }],
      });

      const result = await listConversations({ userId: "u1", starred: true });
      expect(result.total).toBe(1);
      expect(result.conversations[0].starred).toBe(true);
      // Both count and data queries should contain starred filter
      expect(queryCalls[0].sql).toContain("starred");
      expect(queryCalls[0].params).toEqual(["u1", true]);
      expect(queryCalls[1].sql).toContain("starred");
      expect(queryCalls[1].params).toEqual(["u1", true, 20, 0]);
    });

    it("filters by starred=false", async () => {
      enableInternalDB();
      setResults({ rows: [{ total: 2 }] }, { rows: [] });

      await listConversations({ starred: false });
      expect(queryCalls[0].sql).toContain("starred");
      expect(queryCalls[0].params).toEqual([false]);
    });

    it("does not filter when starred is undefined", async () => {
      enableInternalDB();
      setResults({ rows: [{ total: 0 }] }, { rows: [] });

      await listConversations({ userId: "u1" });
      expect(queryCalls[0].sql).not.toContain("starred");
    });
  });

  // -------------------------------------------------------------------------
  // starred field in responses
  // -------------------------------------------------------------------------

  describe("starred field in conversation responses", () => {
    it("getConversation includes starred=true", async () => {
      enableInternalDB();
      setResults(
        {
          rows: [{
            id: "c1",
            user_id: "u1",
            title: "Test",
            surface: "web",
            connection_id: null,
            starred: true,
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-01T00:00:00Z",
          }],
        },
        { rows: [] },
      );

      const result = await getConversation("c1", "u1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.starred).toBe(true);
      }
    });

    it("getConversation defaults starred to false for missing column", async () => {
      enableInternalDB();
      setResults(
        {
          rows: [{
            id: "c1",
            user_id: "u1",
            title: "Test",
            surface: "web",
            connection_id: null,
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-01T00:00:00Z",
          }],
        },
        { rows: [] },
      );

      const result = await getConversation("c1", "u1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.starred).toBe(false);
      }
    });

    it("listConversations includes starred field", async () => {
      enableInternalDB();
      setResults(
        { rows: [{ total: 1 }] },
        {
          rows: [{
            id: "c1",
            user_id: "u1",
            title: "Test",
            surface: "web",
            connection_id: null,
            starred: false,
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-01T00:00:00Z",
          }],
        },
      );

      const result = await listConversations({ userId: "u1" });
      expect(result.conversations[0].starred).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // deleteConversation
  // -------------------------------------------------------------------------

  describe("deleteConversation()", () => {
    it("returns { ok: true } on success", async () => {
      enableInternalDB();
      setResults({ rows: [{ id: "c1" }] });

      const result = await deleteConversation("c1");
      expect(result).toEqual({ ok: true });
      expect(queryCalls[0].sql).toContain("DELETE FROM conversations");
    });

    it("returns { ok: false, reason: 'not_found' } when not found", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      const result = await deleteConversation("missing");
      expect(result).toEqual({ ok: false, reason: "not_found" });
    });

    it("returns { ok: false, reason: 'not_found' } when wrong user", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      const result = await deleteConversation("c1", "wrong-user");
      expect(result).toEqual({ ok: false, reason: "not_found" });
    });

    it("returns { ok: false, reason: 'no_db' } when no DB", async () => {
      const result = await deleteConversation("c1");
      expect(result).toEqual({ ok: false, reason: "no_db" });
    });

    it("scopes by userId when provided", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      await deleteConversation("c1", "u1");
      expect(queryCalls[0].sql).toContain("user_id");
      expect(queryCalls[0].params).toEqual(["c1", "u1"]);
    });

    it("does not scope by userId when not provided", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      await deleteConversation("c1");
      expect(queryCalls[0].sql).not.toContain("user_id");
      expect(queryCalls[0].params).toEqual(["c1"]);
    });

    it("returns { ok: false, reason: 'error' } on DB error", async () => {
      enableInternalDB();
      queryThrow = new Error("connection lost");
      const result = await deleteConversation("c1");
      expect(result).toEqual({ ok: false, reason: "error" });
    });
  });

  // -------------------------------------------------------------------------
  // shareConversation
  // -------------------------------------------------------------------------

  describe("shareConversation()", () => {
    it("returns { ok: true, data: { token, expiresAt, shareMode } } on success", async () => {
      enableInternalDB();
      setResults({ rows: [{ share_token: "test-token-abc" }] });

      const result = await shareConversation("c1", "u1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.token).toBe("test-token-abc");
        expect(result.data.expiresAt).toBeNull();
        expect(result.data.shareMode).toBe("public");
      }
      expect(queryCalls[0].sql).toContain("UPDATE conversations SET share_token");
      expect(queryCalls[0].sql).toContain("share_expires_at");
      expect(queryCalls[0].sql).toContain("share_mode");
      expect(queryCalls[0].sql).toContain("user_id");
    });

    it("generates a cryptographic token in the UPDATE", async () => {
      enableInternalDB();
      setResults({ rows: [{ share_token: "anything" }] });

      await shareConversation("c1");
      // The token param (first param) should be a non-empty string
      const tokenParam = queryCalls[0].params?.[0] as string;
      expect(typeof tokenParam).toBe("string");
      expect(tokenParam.length).toBeGreaterThanOrEqual(20);
    });

    it("sets expiresAt for non-never durations", async () => {
      enableInternalDB();
      setResults({ rows: [{ share_token: "tok" }] });

      const result = await shareConversation("c1", null, { expiresIn: "1h" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.expiresAt).not.toBeNull();
        const expiry = new Date(result.data.expiresAt!);
        const diff = expiry.getTime() - Date.now();
        // Should be roughly 1 hour (3600s ± some tolerance)
        expect(diff).toBeGreaterThan(3500 * 1000);
        expect(diff).toBeLessThan(3700 * 1000);
      }
    });

    it("sets shareMode to org when specified (conversation has org_id)", async () => {
      enableInternalDB();
      // First query: preflight org_id lookup (#1737 invariant).
      // Second query: the UPDATE that writes the share token.
      setResults(
        { rows: [{ org_id: "org-A" }] },
        { rows: [{ share_token: "tok" }] },
      );

      const result = await shareConversation("c1", null, { shareMode: "org" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.shareMode).toBe("org");
      }
      // First call is the preflight SELECT, second is the UPDATE.
      expect(queryCalls[0].sql).toContain("SELECT org_id FROM conversations");
      expect(queryCalls[1].sql).toContain("UPDATE conversations");
      expect(queryCalls[1].params?.[2]).toBe("org");
    });

    // Regression guard for #1737. share_mode='org' on a conversation with
    // org_id=NULL is the F-01 bug-class — the DB CHECK constraint
    // (chk_org_scoped_share, 0034) enforces this at the schema level; this
    // test pins the same rejection at the application layer so the route
    // can surface a structured 400 instead of relying on a Postgres error.
    it("rejects shareMode='org' with invalid_org_scope when conversation has no org_id (#1737)", async () => {
      enableInternalDB();
      setResults({ rows: [{ org_id: null }] });

      const result = await shareConversation("c1", "u1", { shareMode: "org" });
      expect(result).toEqual({ ok: false, reason: "invalid_org_scope" });
      // Ensure the UPDATE never ran — we short-circuited on the preflight.
      expect(queryCalls).toHaveLength(1);
      expect(queryCalls[0].sql).toContain("SELECT org_id FROM conversations");
    });

    it("returns not_found for shareMode='org' preflight when conversation does not exist (#1737)", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      const result = await shareConversation("missing", "u1", { shareMode: "org" });
      expect(result).toEqual({ ok: false, reason: "not_found" });
      // Preflight ran but no UPDATE.
      expect(queryCalls).toHaveLength(1);
    });

    it("returns null expiresAt for 'never'", async () => {
      enableInternalDB();
      setResults({ rows: [{ share_token: "tok" }] });

      const result = await shareConversation("c1", null, { expiresIn: "never" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.expiresAt).toBeNull();
      }
    });

    it("returns { ok: false, reason: 'not_found' } when conversation not found", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      const result = await shareConversation("missing", "u1");
      expect(result).toEqual({ ok: false, reason: "not_found" });
    });

    it("returns { ok: false, reason: 'no_db' } when no DB", async () => {
      const result = await shareConversation("c1");
      expect(result).toEqual({ ok: false, reason: "no_db" });
    });

    it("returns { ok: false, reason: 'error' } on DB error", async () => {
      enableInternalDB();
      queryThrow = new Error("connection lost");
      const result = await shareConversation("c1");
      expect(result).toEqual({ ok: false, reason: "error" });
    });

    it("does not scope by userId when not provided", async () => {
      enableInternalDB();
      setResults({ rows: [{ share_token: "tok" }] });

      await shareConversation("c1");
      expect(queryCalls[0].sql).not.toContain("user_id");
    });
  });

  // -------------------------------------------------------------------------
  // unshareConversation
  // -------------------------------------------------------------------------

  describe("unshareConversation()", () => {
    it("returns { ok: true } on success", async () => {
      enableInternalDB();
      setResults({ rows: [{ id: "c1" }] });

      const result = await unshareConversation("c1", "u1");
      expect(result).toEqual({ ok: true });
      expect(queryCalls[0].sql).toContain("share_token = NULL");
      expect(queryCalls[0].sql).toContain("share_expires_at = NULL");
      expect(queryCalls[0].sql).toContain("share_mode = 'public'");
    });

    it("returns { ok: false, reason: 'not_found' } when not found", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      const result = await unshareConversation("missing");
      expect(result).toEqual({ ok: false, reason: "not_found" });
    });

    it("returns { ok: false, reason: 'no_db' } when no DB", async () => {
      const result = await unshareConversation("c1");
      expect(result).toEqual({ ok: false, reason: "no_db" });
    });

    it("returns { ok: false, reason: 'error' } on DB error", async () => {
      enableInternalDB();
      queryThrow = new Error("connection lost");
      const result = await unshareConversation("c1");
      expect(result).toEqual({ ok: false, reason: "error" });
    });

    it("scopes by userId when provided", async () => {
      enableInternalDB();
      setResults({ rows: [{ id: "c1" }] });

      await unshareConversation("c1", "u1");
      expect(queryCalls[0].sql).toContain("user_id");
      expect(queryCalls[0].params).toEqual(["c1", "u1"]);
    });
  });

  // -------------------------------------------------------------------------
  // getShareStatus
  // -------------------------------------------------------------------------

  describe("getShareStatus()", () => {
    it("returns shared=true with token and shareMode when conversation has a share_token", async () => {
      enableInternalDB();
      setResults({ rows: [{ share_token: "abc123", share_expires_at: null, share_mode: "public" }] });

      const result = await getShareStatus("c1", "u1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.shared).toBe(true);
        expect(result.data.token).toBe("abc123");
        expect(result.data.expiresAt).toBeNull();
        expect(result.data.shareMode).toBe("public");
      }
    });

    it("returns shared=false when conversation has no share_token", async () => {
      enableInternalDB();
      setResults({ rows: [{ share_token: null, share_expires_at: null, share_mode: "public" }] });

      const result = await getShareStatus("c1", "u1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.shared).toBe(false);
        expect(result.data.token).toBeNull();
        expect(result.data.expiresAt).toBeNull();
        expect(result.data.shareMode).toBeNull();
      }
    });

    it("returns expiresAt and shareMode when set and not expired", async () => {
      enableInternalDB();
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      setResults({ rows: [{ share_token: "tok", share_expires_at: futureDate, share_mode: "org" }] });

      const result = await getShareStatus("c1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.shared).toBe(true);
        expect(result.data.expiresAt).toBe(futureDate);
        expect(result.data.shareMode).toBe("org");
      }
    });

    it("returns shared=false when token has expired", async () => {
      enableInternalDB();
      setResults({ rows: [{ share_token: "tok", share_expires_at: "2020-01-01T00:00:00Z", share_mode: "public" }] });

      const result = await getShareStatus("c1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.shared).toBe(false);
        expect(result.data.token).toBeNull();
        expect(result.data.expiresAt).toBeNull();
        expect(result.data.shareMode).toBeNull();
      }
    });

    it("returns { ok: false, reason: 'not_found' } when conversation not found", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      const result = await getShareStatus("missing", "u1");
      expect(result).toEqual({ ok: false, reason: "not_found" });
    });

    it("returns { ok: false, reason: 'no_db' } when no DB", async () => {
      const result = await getShareStatus("c1");
      expect(result).toEqual({ ok: false, reason: "no_db" });
    });

    it("returns { ok: false, reason: 'error' } on DB error", async () => {
      enableInternalDB();
      queryThrow = new Error("connection lost");
      const result = await getShareStatus("c1", "u1");
      expect(result).toEqual({ ok: false, reason: "error" });
    });

    it("scopes by userId when provided", async () => {
      enableInternalDB();
      setResults({ rows: [{ share_token: null, share_expires_at: null, share_mode: "public" }] });

      await getShareStatus("c1", "u1");
      expect(queryCalls[0].sql).toContain("share_mode");
      expect(queryCalls[0].sql).toContain("AND user_id");
      expect(queryCalls[0].params).toEqual(["c1", "u1"]);
    });

    it("does not scope by userId when not provided", async () => {
      enableInternalDB();
      setResults({ rows: [{ share_token: null, share_expires_at: null, share_mode: "public" }] });

      await getShareStatus("c1");
      expect(queryCalls[0].sql).not.toContain("AND user_id");
      expect(queryCalls[0].params).toEqual(["c1"]);
    });
  });

  // -------------------------------------------------------------------------
  // getSharedConversation
  // -------------------------------------------------------------------------

  describe("getSharedConversation()", () => {
    it("returns conversation with messages and shareMode for valid token", async () => {
      enableInternalDB();
      setResults(
        {
          rows: [{
            id: "c1",
            user_id: "u1",
            title: "Shared conv",
            surface: "web",
            connection_id: null,
            starred: false,
            share_expires_at: null,
            share_mode: "public",
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-01T00:00:00Z",
          }],
        },
        {
          rows: [{
            id: "m1",
            conversation_id: "c1",
            role: "user",
            content: { type: "text", text: "hello" },
            created_at: "2024-01-01T00:00:00Z",
          }],
        },
      );

      const result = await getSharedConversation("valid-token");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.title).toBe("Shared conv");
        expect(result.data.messages).toHaveLength(1);
        expect(result.data.shareMode).toBe("public");
      }
    });

    it("returns org shareMode and orgId when set", async () => {
      enableInternalDB();
      setResults(
        {
          rows: [{
            id: "c1",
            user_id: "u1",
            org_id: "org-A",
            title: "Org conv",
            surface: "web",
            connection_id: null,
            starred: false,
            share_expires_at: null,
            share_mode: "org",
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-01T00:00:00Z",
          }],
        },
        { rows: [] },
      );

      const result = await getSharedConversation("org-token");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.shareMode).toBe("org");
        // orgId is required for the route layer's membership check (#1727)
        expect(result.data.orgId).toBe("org-A");
      }
    });

    it("returns orgId=null when org_id column is null (public / legacy conversations)", async () => {
      enableInternalDB();
      setResults(
        {
          rows: [{
            id: "c1",
            user_id: "u1",
            org_id: null,
            title: "Public conv",
            surface: "web",
            connection_id: null,
            starred: false,
            share_expires_at: null,
            share_mode: "public",
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-01T00:00:00Z",
          }],
        },
        { rows: [] },
      );

      const result = await getSharedConversation("public-token");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.orgId).toBeNull();
      }
    });

    it("returns expired for token with past expiry", async () => {
      enableInternalDB();
      setResults({
        rows: [{
          id: "c1",
          user_id: "u1",
          title: "Expired conv",
          surface: "web",
          connection_id: null,
          starred: false,
          share_expires_at: "2020-01-01T00:00:00Z",
          share_mode: "public",
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
        }],
      });

      const result = await getSharedConversation("expired-token");
      expect(result).toEqual({ ok: false, reason: "expired" });
    });

    it("returns not_found for missing token", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      const result = await getSharedConversation("nonexistent");
      expect(result).toEqual({ ok: false, reason: "not_found" });
    });

    it("returns { ok: false, reason: 'no_db' } when no DB", async () => {
      const result = await getSharedConversation("token");
      expect(result).toEqual({ ok: false, reason: "no_db" });
    });

    it("returns { ok: false, reason: 'error' } on DB error", async () => {
      enableInternalDB();
      queryThrow = new Error("connection lost");
      const result = await getSharedConversation("token");
      expect(result).toEqual({ ok: false, reason: "error" });
    });
  });

  // -------------------------------------------------------------------------
  // Share/unshare lifecycle
  // -------------------------------------------------------------------------

  describe("share/unshare lifecycle", () => {
    it("share then unshare clears the token", async () => {
      enableInternalDB();
      // Share
      setResults({ rows: [{ share_token: "abc123" }] });
      const shareResult = await shareConversation("c1", "u1");
      expect(shareResult.ok).toBe(true);

      // Unshare
      queryCalls = [];
      queryResultIndex = 0;
      setResults({ rows: [{ id: "c1" }] });
      const unshareResult = await unshareConversation("c1", "u1");
      expect(unshareResult).toEqual({ ok: true });
      expect(queryCalls[0].sql).toContain("share_token = NULL");
    });
  });

  // -------------------------------------------------------------------------
  // cleanupExpiredShares
  // -------------------------------------------------------------------------

  describe("cleanupExpiredShares()", () => {
    it("returns 0 when no internal DB", async () => {
      const count = await cleanupExpiredShares();
      expect(count).toBe(0);
      expect(queryCalls.length).toBe(0);
    });

    it("runs the correct UPDATE ... RETURNING SQL", async () => {
      enableInternalDB();
      setResults({ rows: [{ id: "c1" }, { id: "c2" }] });

      const count = await cleanupExpiredShares();
      expect(count).toBe(2);
      expect(queryCalls.length).toBe(1);
      expect(queryCalls[0].sql).toContain("UPDATE conversations");
      expect(queryCalls[0].sql).toContain("SET share_token = NULL, share_expires_at = NULL, share_mode = 'public'");
      expect(queryCalls[0].sql).toContain("share_expires_at IS NOT NULL");
      expect(queryCalls[0].sql).toContain("share_expires_at < NOW()");
      expect(queryCalls[0].sql).toContain("RETURNING id");
    });

    it("returns 0 when no rows match", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      const count = await cleanupExpiredShares();
      expect(count).toBe(0);
    });

    it("returns -1 on DB error", async () => {
      enableInternalDB();
      queryThrow = new Error("connection lost");

      const count = await cleanupExpiredShares();
      expect(count).toBe(-1);
    });
  });

  // -------------------------------------------------------------------------
  // Cross-org scoping (F-11 security invariant, 1.2.3 phase 2)
  // -------------------------------------------------------------------------
  //
  // Every helper that accepts a conversation id must filter on the caller's
  // active org_id. Without this, a user who switches workspaces retains
  // access to conversations they created in a previous org. The NULL-safe
  // form `(org_id = $N OR org_id IS NULL)` preserves access to legacy rows
  // written before the column was stamped.
  //
  // Each test sets up an empty result set (the DB would reject the row for
  // org mismatch) and asserts two things:
  //   1. the SQL contains the org_id filter,
  //   2. the orgId param is forwarded to the query.

  describe("cross-org scoping (F-11)", () => {
    it("getConversation scopes by orgId when provided", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      const result = await getConversation("c1", "u1", "org-B");
      expect(result).toEqual({ ok: false, reason: "not_found" });
      expect(queryCalls[0].sql).toContain("user_id = $2");
      expect(queryCalls[0].sql).toContain("(org_id = $3 OR org_id IS NULL)");
      expect(queryCalls[0].params).toEqual(["c1", "u1", "org-B"]);
    });

    it("getConversation does not add org_id filter when orgId is undefined", async () => {
      enableInternalDB();
      setResults({ rows: [] }, { rows: [] });

      await getConversation("c1", "u1");
      expect(queryCalls[0].sql).not.toContain("org_id");
    });

    it("deleteConversation scopes by orgId when provided", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      const result = await deleteConversation("c1", "u1", "org-B");
      expect(result).toEqual({ ok: false, reason: "not_found" });
      expect(queryCalls[0].sql).toContain("(org_id = $3 OR org_id IS NULL)");
      expect(queryCalls[0].params).toEqual(["c1", "u1", "org-B"]);
    });

    it("starConversation scopes by orgId when provided", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      const result = await starConversation("c1", true, "u1", "org-B");
      expect(result).toEqual({ ok: false, reason: "not_found" });
      expect(queryCalls[0].sql).toContain("(org_id = $4 OR org_id IS NULL)");
      expect(queryCalls[0].params).toEqual([true, "c1", "u1", "org-B"]);
    });

    // #4351 — the ONE conversation-scope writer, table-driven. Replaces the
    // five parallel per-axis writer suites: the axis ↔ column mapping, the
    // parameter order, and the auth-scope offset are all derived from one
    // list, so a new axis is one row here rather than a new copied suite.
    const scopeWriteCases: ReadonlyArray<{
      readonly label: string;
      readonly patch: ConversationScopePatch;
      readonly assignments: string;
      readonly values: readonly unknown[];
    }> = [
      {
        label: "routing mode (#2518)",
        patch: { routingMode: "all" },
        assignments: "routing_mode = $1",
        values: ["all"],
      },
      {
        label: "REST exclude-set (#3066) — pg binds the JS array to text[]",
        patch: { restExcludedDatasourceIds: ["ds-1", "ds-2"] },
        assignments: "rest_excluded_datasource_ids = $1",
        values: [["ds-1", "ds-2"]],
      },
      {
        label: "REST exclude-set re-include — an explicit [] clears the set",
        patch: { restExcludedDatasourceIds: [] },
        assignments: "rest_excluded_datasource_ids = $1",
        values: [[]],
      },
      {
        label: "REST focus (#3067)",
        patch: { restFocusDatasourceId: "ds-stripe" },
        assignments: "rest_focus_datasource_id = $1",
        values: ["ds-stripe"],
      },
      {
        label: "REST focus clear — an explicit null returns to default scope",
        patch: { restFocusDatasourceId: null },
        assignments: "rest_focus_datasource_id = $1",
        values: [null],
      },
      {
        label: "group reach (#3895) — Focus a group",
        patch: { groupReach: "g_prod" },
        assignments: "group_reach = $1",
        values: ["g_prod"],
      },
      {
        label: "group reach widen — an explicit null returns to All sources",
        patch: { groupReach: null },
        assignments: "group_reach = $1",
        values: [null],
      },
      {
        label: "answer style (#4302)",
        patch: { answerStyle: "executive" },
        assignments: "answer_style = $1",
        values: ["executive"],
      },
      {
        label: "MULTI-AXIS — one atomic UPDATE, columns in persisted order",
        patch: {
          routingMode: "pin",
          restFocusDatasourceId: null,
          groupReach: "g_eu",
          answerStyle: "plain-english",
        },
        assignments:
          "routing_mode = $1, rest_focus_datasource_id = $2, group_reach = $3, answer_style = $4",
        values: ["pin", null, "g_eu", "plain-english"],
      },
    ];

    for (const testCase of scopeWriteCases) {
      it(`updateConversationScope writes ${testCase.label}, scoped + parameterized`, async () => {
        enableInternalDB();
        setResults({ rows: [{ id: "c1" }] });

        const result = await updateConversationScope("c1", testCase.patch, "u1", "org-B");
        expect(result).toEqual({ ok: true });
        // Exactly ONE statement, whatever the patch width — a multi-axis
        // change must never fan out into several fire-and-forget writes.
        expect(queryCalls).toHaveLength(1);
        expect(queryCalls[0].sql).toContain(`SET ${testCase.assignments}, updated_at = now()`);
        // The id placeholder follows the SET params; the auth scope follows it.
        const idIdx = testCase.values.length + 1;
        expect(queryCalls[0].sql).toContain(`WHERE id = $${idIdx}`);
        expect(queryCalls[0].sql).toContain(`user_id = $${idIdx + 1}`);
        expect(queryCalls[0].sql).toContain(`(org_id = $${idIdx + 2} OR org_id IS NULL)`);
        expect(queryCalls[0].params).toEqual([...testCase.values, "c1", "u1", "org-B"]);
      });
    }

    it("updateConversationScope returns not_found when no row matches (cross-org)", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      const result = await updateConversationScope("c1", { groupReach: "g_prod" }, "u1", "org-B");
      expect(result).toEqual({ ok: false, reason: "not_found" });
    });

    it("updateConversationScope short-circuits to no_db when the internal DB is off", async () => {
      const result = await updateConversationScope("c1", { answerStyle: "executive" });
      expect(result).toEqual({ ok: false, reason: "no_db" });
      expect(queryCalls).toHaveLength(0);
    });

    // An empty patch is a no-op SUCCESS — the caller diffed first and nothing
    // changed. It must not issue a statement (that would bump `updated_at` and
    // reshuffle the conversation list on every turn) and must not even consult
    // the DB availability check.
    it("updateConversationScope no-ops (ok) on an empty patch without querying", async () => {
      enableInternalDB();
      setResults({ rows: [{ id: "c1" }] });

      const result = await updateConversationScope("c1", {}, "u1", "org-B");
      expect(result).toEqual({ ok: true });
      expect(queryCalls).toHaveLength(0);
    });

    it("updateConversationScope returns error and logs when the query throws", async () => {
      enableInternalDB();
      queryThrow = new Error("connection reset");

      const result = await updateConversationScope("c1", { groupReach: "g_prod" }, "u1", "org-B");
      expect(result).toEqual({ ok: false, reason: "error" });
    });

    it("shareConversation scopes the preflight SELECT by orgId (shareMode='org')", async () => {
      enableInternalDB();
      // Preflight sees no matching row because of cross-org filter.
      setResults({ rows: [] });

      const result = await shareConversation("c1", "u1", {
        orgId: "org-B",
        shareMode: "org",
      });
      expect(result).toEqual({ ok: false, reason: "not_found" });
      expect(queryCalls[0].sql).toContain("SELECT org_id FROM conversations");
      expect(queryCalls[0].sql).toContain("(org_id = $3 OR org_id IS NULL)");
      expect(queryCalls[0].params).toEqual(["c1", "u1", "org-B"]);
    });

    it("shareConversation scopes the UPDATE by orgId (public shareMode)", async () => {
      enableInternalDB();
      // No preflight for public shares — UPDATE runs directly.
      setResults({ rows: [] });

      const result = await shareConversation("c1", "u1", { orgId: "org-B" });
      expect(result).toEqual({ ok: false, reason: "not_found" });
      expect(queryCalls[0].sql).toContain("UPDATE conversations");
      expect(queryCalls[0].sql).toContain("(org_id = $6 OR org_id IS NULL)");
      // params = [token, expiresAt, shareMode, id, userId, orgId]
      expect(queryCalls[0].params?.[3]).toBe("c1");
      expect(queryCalls[0].params?.[4]).toBe("u1");
      expect(queryCalls[0].params?.[5]).toBe("org-B");
    });

    it("unshareConversation scopes by orgId when provided", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      const result = await unshareConversation("c1", "u1", "org-B");
      expect(result).toEqual({ ok: false, reason: "not_found" });
      expect(queryCalls[0].sql).toContain("(org_id = $3 OR org_id IS NULL)");
      expect(queryCalls[0].params).toEqual(["c1", "u1", "org-B"]);
    });

    it("getShareStatus scopes by orgId when provided", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      const result = await getShareStatus("c1", "u1", "org-B");
      expect(result).toEqual({ ok: false, reason: "not_found" });
      expect(queryCalls[0].sql).toContain("(org_id = $3 OR org_id IS NULL)");
      expect(queryCalls[0].params).toEqual(["c1", "u1", "org-B"]);
    });

    it("org_id IS NULL branch allows access to legacy rows (self-hosted back-compat)", async () => {
      enableInternalDB();
      // Row has NULL org_id (pre-1.2.0 legacy) but matches on user_id.
      setResults(
        {
          rows: [{
            id: "legacy-c1",
            user_id: "u1",
            title: "Legacy",
            surface: "web",
            connection_id: null,
            starred: false,
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-01T00:00:00Z",
          }],
        },
        { rows: [] },
      );

      const result = await getConversation("legacy-c1", "u1", "org-B");
      // Legacy row has NULL org_id — the OR clause allows the match.
      expect(result.ok).toBe(true);
    });

    it("legacy-row back-compat covers mutation path (deleteConversation)", async () => {
      // Regression guard: a helper that inlined scopeClause but dropped
      // `OR org_id IS NULL` would leave self-hosted / pre-1.2.0 users
      // unable to delete their legacy conversations. This test pins the
      // NULL-safe branch for a representative mutation helper.
      enableInternalDB();
      setResults({ rows: [{ id: "legacy-c1" }] });

      const result = await deleteConversation("legacy-c1", "u1", "org-B");
      expect(result).toEqual({ ok: true });
      expect(queryCalls[0].sql).toContain("(org_id = $3 OR org_id IS NULL)");
    });
  });
});
