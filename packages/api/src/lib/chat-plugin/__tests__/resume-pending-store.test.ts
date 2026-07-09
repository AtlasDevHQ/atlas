/**
 * #3750 — chat resume-pending coordinate store.
 *
 * Pins the read/write/delete of the `chat:resume-pending:<conversationId>`
 * `chat_cache` row: round-trips coordinates (incl. the optional
 * `externalUserId`), the no-DB / malformed-row / expired-row null paths, and
 * the fail-soft posture (a DB error logs + returns false/null, never throws).
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";

const mockHasInternalDB: Mock<() => boolean> = mock(() => true);
const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>> =
  mock(() => Promise.resolve([]));

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: mockHasInternalDB,
  internalQuery: mockInternalQuery,
  getInternalDB: mock(() => ({ query: mock(() => Promise.resolve({ rows: [] })) })),
}));

void mock.module("@atlas/api/lib/durable-session", () => ({
  getMaxParkMinutes: () => 1440,
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { saveResumePending, loadResumePending, clearResumePending } = await import(
  "../resume-pending-store"
);

beforeEach(() => {
  mockHasInternalDB.mockReset();
  mockHasInternalDB.mockReturnValue(true);
  mockInternalQuery.mockReset();
  mockInternalQuery.mockResolvedValue([]);
});

describe("saveResumePending (#3750)", () => {
  it("writes the keyed row with coordinates + TTL and returns true", async () => {
    const ok = await saveResumePending("conv_1", {
      platform: "slack",
      threadId: "C123:1700000000.0001",
      orgId: "org_1",
      externalId: "T0123",
      externalUserId: "U999",
    });
    expect(ok).toBe(true);
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockInternalQuery.mock.calls[0]!;
    expect(String(sql)).toContain("INSERT INTO");
    expect(String(sql)).toContain("ON CONFLICT");
    expect((params as unknown[])[0]).toBe("chat:resume-pending:conv_1");
    const value = JSON.parse(String((params as unknown[])[1]));
    expect(value).toEqual({
      platform: "slack",
      threadId: "C123:1700000000.0001",
      orgId: "org_1",
      externalId: "T0123",
      externalUserId: "U999",
    });
    expect((params as unknown[])[2]).toBe("1440");
  });

  it("omits externalUserId from the stored value when absent", async () => {
    await saveResumePending("conv_2", {
      platform: "telegram",
      threadId: "chat_42",
      orgId: "org_1",
      externalId: "42",
    });
    const value = JSON.parse(String((mockInternalQuery.mock.calls[0]![1] as unknown[])[1]));
    expect(value).not.toHaveProperty("externalUserId");
    expect(value.platform).toBe("telegram");
  });

  it("returns false (fail-soft) when there is no internal DB", async () => {
    mockHasInternalDB.mockReturnValue(false);
    const ok = await saveResumePending("conv_3", {
      platform: "slack",
      threadId: "t",
      orgId: "org_1",
      externalId: "T1",
    });
    expect(ok).toBe(false);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("returns false (fail-soft) and does not throw on a DB error", async () => {
    mockInternalQuery.mockRejectedValueOnce(new Error("write failed"));
    const ok = await saveResumePending("conv_4", {
      platform: "slack",
      threadId: "t",
      orgId: "org_1",
      externalId: "T1",
    });
    expect(ok).toBe(false);
  });
});

describe("loadResumePending (#3750)", () => {
  it("round-trips stored coordinates", async () => {
    mockInternalQuery.mockResolvedValueOnce([
      {
        value: {
          platform: "slack",
          threadId: "C1:1.1",
          orgId: "org_1",
          externalId: "T0123",
          externalUserId: "U999",
        },
      },
    ]);
    const coords = await loadResumePending("conv_1");
    expect(coords).toEqual({
      platform: "slack",
      threadId: "C1:1.1",
      orgId: "org_1",
      externalId: "T0123",
      externalUserId: "U999",
    });
    // The query guards on expiry.
    expect(String(mockInternalQuery.mock.calls[0]![0])).toContain("expires_at");
  });

  it("returns null when no row is found", async () => {
    mockInternalQuery.mockResolvedValueOnce([]);
    expect(await loadResumePending("missing")).toBeNull();
  });

  it("returns null and warns on a malformed row (missing externalId)", async () => {
    mockInternalQuery.mockResolvedValueOnce([
      { value: { platform: "slack", threadId: "t", orgId: "org_1" } },
    ]);
    expect(await loadResumePending("conv_bad")).toBeNull();
  });

  it("returns null (fail-soft) on a DB error", async () => {
    mockInternalQuery.mockRejectedValueOnce(new Error("read failed"));
    expect(await loadResumePending("conv_err")).toBeNull();
  });

  it("returns null when there is no internal DB", async () => {
    mockHasInternalDB.mockReturnValue(false);
    expect(await loadResumePending("conv_x")).toBeNull();
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });
});

describe("clearResumePending (#3750)", () => {
  it("deletes the keyed row", async () => {
    await clearResumePending("conv_1");
    const [sql, params] = mockInternalQuery.mock.calls[0]!;
    expect(String(sql)).toContain("DELETE FROM");
    expect((params as unknown[])[0]).toBe("chat:resume-pending:conv_1");
  });

  it("is a no-op without an internal DB and never throws on a DB error", async () => {
    mockHasInternalDB.mockReturnValue(false);
    await clearResumePending("conv_1");
    expect(mockInternalQuery).not.toHaveBeenCalled();

    mockHasInternalDB.mockReturnValue(true);
    mockInternalQuery.mockRejectedValueOnce(new Error("delete failed"));
    await expect(clearResumePending("conv_1")).resolves.toBeUndefined();
  });
});
