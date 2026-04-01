/**
 * Tests for Slack installation storage (store.ts).
 *
 * Mocks the internal DB layer to test DB-backed and env-var fallback paths.
 */

import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from "bun:test";

// --- Mocks ---

const mockHasInternalDB: Mock<() => boolean> = mock(() => true);
const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>> = mock(() =>
  Promise.resolve([]),
);

const mockPoolQuery: Mock<(sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>> = mock(() =>
  Promise.resolve({ rows: [] }),
);
const mockGetInternalDB: Mock<() => { query: typeof mockPoolQuery }> = mock(() => ({
  query: mockPoolQuery,
}));

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: mockHasInternalDB,
  internalQuery: mockInternalQuery,
  getInternalDB: mockGetInternalDB,
  getApprovedPatterns: async () => [],
  upsertSuggestion: mock(() => Promise.resolve("created")),
  getSuggestionsByTables: mock(() => Promise.resolve([])),
  getPopularSuggestions: mock(() => Promise.resolve([])),
  incrementSuggestionClick: mock(),
  deleteSuggestion: mock(() => Promise.resolve(false)),
  getAuditLogQueries: mock(() => Promise.resolve([])),
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// Import after mocks are registered
const {
  getInstallation,
  getInstallationByOrg,
  saveInstallation,
  deleteInstallation,
  deleteInstallationByOrg,
  getBotToken,
} = await import("../store");

describe("store", () => {
  const savedBotToken = process.env.SLACK_BOT_TOKEN;

  beforeEach(() => {
    mockHasInternalDB.mockClear();
    mockInternalQuery.mockClear();
    mockPoolQuery.mockClear();
    mockGetInternalDB.mockClear();
    delete process.env.SLACK_BOT_TOKEN;
  });

  afterEach(() => {
    if (savedBotToken !== undefined) process.env.SLACK_BOT_TOKEN = savedBotToken;
    else delete process.env.SLACK_BOT_TOKEN;
  });

  describe("getInstallation", () => {
    it("returns installation from DB when hasInternalDB() is true and row exists", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockInternalQuery.mockResolvedValue([
        { team_id: "T123", bot_token: "xoxb-abc", installed_at: "2025-01-01T00:00:00Z" },
      ]);

      const result = await getInstallation("T123");
      expect(result).toEqual({
        team_id: "T123",
        bot_token: "xoxb-abc",
        org_id: null,
        workspace_name: null,
        installed_at: "2025-01-01T00:00:00Z",
      });
      expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    });

    it("returns null when DB has no matching row", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockInternalQuery.mockResolvedValue([]);

      const result = await getInstallation("T999");
      expect(result).toBeNull();
    });

    it("throws when DB query fails (does NOT fall through to env var)", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockInternalQuery.mockRejectedValue(new Error("connection refused"));
      process.env.SLACK_BOT_TOKEN = "xoxb-env-fallback";

      await expect(getInstallation("T123")).rejects.toThrow("connection refused");
    });

    it("returns env var token when hasInternalDB() is false and SLACK_BOT_TOKEN is set", async () => {
      mockHasInternalDB.mockReturnValue(false);
      process.env.SLACK_BOT_TOKEN = "xoxb-env-token";

      const result = await getInstallation("T123");
      expect(result).not.toBeNull();
      expect(result!.bot_token).toBe("xoxb-env-token");
      expect(result!.team_id).toBe("T123");
      expect(mockInternalQuery).not.toHaveBeenCalled();
    });

    it("returns null when hasInternalDB() is false and no env var", async () => {
      mockHasInternalDB.mockReturnValue(false);
      delete process.env.SLACK_BOT_TOKEN;

      const result = await getInstallation("T123");
      expect(result).toBeNull();
    });

    it("returns null for invalid DB record (non-string bot_token)", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockInternalQuery.mockResolvedValue([
        { team_id: "T123", bot_token: 12345, installed_at: "2025-01-01T00:00:00Z" },
      ]);

      const result = await getInstallation("T123");
      expect(result).toBeNull();
    });
  });

  describe("getInstallationByOrg", () => {
    it("returns installation from DB when row exists for org", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockInternalQuery.mockResolvedValue([
        { team_id: "T123", bot_token: "xoxb-abc", org_id: "org-1", workspace_name: "My Team", installed_at: "2025-01-01T00:00:00Z" },
      ]);

      const result = await getInstallationByOrg("org-1");
      // Secret fields are stripped at runtime — only public fields returned
      expect(result).toEqual({
        team_id: "T123",
        org_id: "org-1",
        workspace_name: "My Team",
        installed_at: "2025-01-01T00:00:00Z",
      });
      expect((result as unknown as Record<string, unknown>).bot_token).toBeUndefined();
      expect(mockInternalQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockInternalQuery.mock.calls[0];
      expect(sql).toContain("WHERE org_id = $1");
      expect(params).toEqual(["org-1"]);
    });

    it("returns null when DB has no matching row", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockInternalQuery.mockResolvedValue([]);

      const result = await getInstallationByOrg("org-999");
      expect(result).toBeNull();
    });

    it("returns null when no internal DB (org-scoped requires DB)", async () => {
      mockHasInternalDB.mockReturnValue(false);
      process.env.SLACK_BOT_TOKEN = "xoxb-env-token";

      const result = await getInstallationByOrg("org-1");
      expect(result).toBeNull();
      expect(mockInternalQuery).not.toHaveBeenCalled();
    });

    it("returns null when no internal DB and no env var", async () => {
      mockHasInternalDB.mockReturnValue(false);
      delete process.env.SLACK_BOT_TOKEN;

      const result = await getInstallationByOrg("org-1");
      expect(result).toBeNull();
    });

    it("throws when DB query fails", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockInternalQuery.mockRejectedValue(new Error("timeout"));

      await expect(getInstallationByOrg("org-1")).rejects.toThrow("timeout");
    });

    it("returns null for invalid DB record (non-string bot_token)", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockInternalQuery.mockResolvedValue([
        { team_id: "T123", bot_token: null, org_id: "org-1", installed_at: "2025-01-01T00:00:00Z" },
      ]);

      const result = await getInstallationByOrg("org-1");
      expect(result).toBeNull();
    });
  });

  describe("saveInstallation", () => {
    it("resolves when DB write succeeds", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockPoolQuery.mockResolvedValue({ rows: [{ team_id: "T123" }] });

      await expect(saveInstallation("T123", "xoxb-new")).resolves.toBeUndefined();
      expect(mockPoolQuery).toHaveBeenCalledTimes(1); // Single atomic upsert
      const [insertSql, insertParams] = mockPoolQuery.mock.calls[0];
      expect(insertSql).toContain("INSERT INTO slack_installations");
      expect(insertSql).toContain("RETURNING team_id");
      expect(insertParams).toEqual(["T123", "xoxb-new", null, null]);
    });

    it("passes orgId and workspaceName when provided", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockPoolQuery.mockResolvedValue({ rows: [{ team_id: "T123" }] });

      await saveInstallation("T123", "xoxb-new", { orgId: "org-1", workspaceName: "My Team" });
      const [, insertParams] = mockPoolQuery.mock.calls[0];
      expect(insertParams).toEqual(["T123", "xoxb-new", "org-1", "My Team"]);
    });

    it("rejects when team is bound to a different org", async () => {
      mockHasInternalDB.mockReturnValue(true);
      // Atomic upsert returns 0 rows when org_id doesn't match (hijack protection)
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      await expect(
        saveInstallation("T123", "xoxb-new", { orgId: "org-mine" }),
      ).rejects.toThrow("already bound to a different organization");
    });

    it("throws when no internal DB", async () => {
      mockHasInternalDB.mockReturnValue(false);

      await expect(saveInstallation("T123", "xoxb-token")).rejects.toThrow(
        "no internal database configured",
      );
    });

    it("throws when DB write fails", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockPoolQuery.mockRejectedValue(new Error("disk full"));

      await expect(saveInstallation("T123", "xoxb-token")).rejects.toThrow("disk full");
    });
  });

  describe("deleteInstallation", () => {
    it("resolves when DB delete succeeds", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockPoolQuery.mockResolvedValue({ rows: [] });

      await expect(deleteInstallation("T123")).resolves.toBeUndefined();
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toContain("DELETE FROM slack_installations");
      expect(params).toEqual(["T123"]);
    });

    it("resolves (with warning) when no internal DB", async () => {
      mockHasInternalDB.mockReturnValue(false);

      // Should not throw — just logs a warning and returns
      await expect(deleteInstallation("T123")).resolves.toBeUndefined();
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });
  });

  describe("deleteInstallationByOrg", () => {
    it("returns true when a row was deleted", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockPoolQuery.mockResolvedValue({ rows: [{ team_id: "T123" }] });

      const result = await deleteInstallationByOrg("org-1");
      expect(result).toBe(true);
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toContain("DELETE FROM slack_installations");
      expect(sql).toContain("WHERE org_id = $1");
      expect(params).toEqual(["org-1"]);
    });

    it("returns false when no matching row", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockPoolQuery.mockResolvedValue({ rows: [] });

      const result = await deleteInstallationByOrg("org-999");
      expect(result).toBe(false);
    });

    it("throws when no internal DB", async () => {
      mockHasInternalDB.mockReturnValue(false);

      await expect(deleteInstallationByOrg("org-1")).rejects.toThrow(
        "no internal database configured",
      );
    });

    it("throws when DB query fails", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockPoolQuery.mockRejectedValue(new Error("connection lost"));

      await expect(deleteInstallationByOrg("org-1")).rejects.toThrow("connection lost");
    });
  });

  describe("getBotToken", () => {
    it("returns the token string from getInstallation", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockInternalQuery.mockResolvedValue([
        { team_id: "T123", bot_token: "xoxb-from-db", installed_at: "2025-01-01T00:00:00Z" },
      ]);

      const token = await getBotToken("T123");
      expect(token).toBe("xoxb-from-db");
    });

    it("returns null when no installation exists", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockInternalQuery.mockResolvedValue([]);

      const token = await getBotToken("T999");
      expect(token).toBeNull();
    });
  });
});
