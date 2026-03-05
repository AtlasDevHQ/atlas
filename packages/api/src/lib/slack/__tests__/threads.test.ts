/**
 * Tests for Slack thread → Atlas conversation ID mapping (threads.ts).
 *
 * Mocks the internal DB layer to test lookup and persistence paths.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";

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
const { getConversationId, setConversationId } = await import("../threads");

describe("threads", () => {
  beforeEach(() => {
    mockHasInternalDB.mockClear();
    mockInternalQuery.mockClear();
    mockPoolQuery.mockClear();
    mockGetInternalDB.mockClear();
  });

  describe("getConversationId", () => {
    it("returns null when hasInternalDB() is false", async () => {
      mockHasInternalDB.mockReturnValue(false);

      const result = await getConversationId("C123", "1234567890.000001");
      expect(result).toBeNull();
      expect(mockInternalQuery).not.toHaveBeenCalled();
    });

    it("returns conversation ID when mapping exists", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockInternalQuery.mockResolvedValue([{ conversation_id: "conv-abc-123" }]);

      const result = await getConversationId("C123", "1234567890.000001");
      expect(result).toBe("conv-abc-123");
      expect(mockInternalQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockInternalQuery.mock.calls[0];
      expect(sql).toContain("SELECT conversation_id FROM slack_threads");
      expect(params).toEqual(["C123", "1234567890.000001"]);
    });

    it("returns null when no mapping exists", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockInternalQuery.mockResolvedValue([]);

      const result = await getConversationId("C123", "1234567890.000001");
      expect(result).toBeNull();
    });

    it("returns null on DB error (logs error)", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockInternalQuery.mockRejectedValue(new Error("table does not exist"));

      // Should catch the error and return null, not throw
      const result = await getConversationId("C123", "1234567890.000001");
      expect(result).toBeNull();
    });
  });

  describe("setConversationId", () => {
    it("writes correct UPSERT to DB", async () => {
      mockHasInternalDB.mockReturnValue(true);
      mockPoolQuery.mockResolvedValue(undefined as never);

      await setConversationId("C123", "1234567890.000001", "conv-xyz-789");

      expect(mockGetInternalDB).toHaveBeenCalledTimes(1);
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toContain("INSERT INTO slack_threads");
      expect(sql).toContain("ON CONFLICT");
      expect(params).toEqual(["C123", "1234567890.000001", "conv-xyz-789"]);
    });

    it("is silent no-op when no internal DB", async () => {
      mockHasInternalDB.mockReturnValue(false);

      // Should return without error and without calling DB
      await expect(setConversationId("C123", "1234567890.000001", "conv-abc")).resolves.toBeUndefined();
      expect(mockGetInternalDB).not.toHaveBeenCalled();
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });
  });
});
