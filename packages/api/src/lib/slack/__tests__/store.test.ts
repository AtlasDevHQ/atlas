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

const mockPoolQuery: Mock<(sql: string, params?: unknown[]) => Promise<void>> = mock(() =>
  Promise.resolve(),
);
const mockGetInternalDB: Mock<() => { query: typeof mockPoolQuery }> = mock(() => ({
  query: mockPoolQuery,
}));

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: mockHasInternalDB,
  internalQuery: mockInternalQuery,
  getInternalDB: mockGetInternalDB,
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
const { getInstallation, saveInstallation, deleteInstallation, getBotToken } = await import("../store");

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

  describe("saveInstallation", () => {
    it("resolves when DB write succeeds", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockPoolQuery.mockResolvedValue(undefined as never);

      await expect(saveInstallation("T123", "xoxb-new")).resolves.toBeUndefined();
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
      // Verify the SQL contains INSERT and the params
      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toContain("INSERT INTO slack_installations");
      expect(params).toEqual(["T123", "xoxb-new"]);
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
      mockPoolQuery.mockResolvedValue(undefined as never);

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
