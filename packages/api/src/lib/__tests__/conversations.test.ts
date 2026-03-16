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
} from "../conversations";

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
      expect(queryCalls[0].params).toEqual(["u1", "Test", "web", null, null]);
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
      expect(queryCalls[0].params).toEqual([null, null, "web", null, null]);
    });

    it("accepts custom surface and connectionId", async () => {
      enableInternalDB();
      setResults({ rows: [{ id: "conv-789" }] });

      await createConversation({ surface: "api", connectionId: "wh" });
      expect(queryCalls[0].params).toEqual([null, null, "api", "wh", null]);
    });

    it("includes orgId when provided", async () => {
      enableInternalDB();
      setResults({ rows: [{ id: "conv-org" }] });

      const result = await createConversation({ userId: "u1", orgId: "org-123" });
      expect(result).toEqual({ id: "conv-org" });
      expect(queryCalls[0].params).toEqual(["u1", null, "web", null, "org-123"]);
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

    it("sets shareMode to org when specified", async () => {
      enableInternalDB();
      setResults({ rows: [{ share_token: "tok" }] });

      const result = await shareConversation("c1", null, { shareMode: "org" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.shareMode).toBe("org");
      }
      // Verify the SQL includes share_mode param
      expect(queryCalls[0].params?.[2]).toBe("org");
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

    it("returns org shareMode when set", async () => {
      enableInternalDB();
      setResults(
        {
          rows: [{
            id: "c1",
            user_id: "u1",
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
});
