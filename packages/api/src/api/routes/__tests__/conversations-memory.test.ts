/**
 * Tests for the in-conversation durable working-memory routes (#3758):
 * GET/DELETE /api/v1/conversations/{id}/memory. Exercises the owner-scoped
 * wiring (the caller's id threaded into the durable-state helpers), UUID
 * validation, and the Noop contract (empty read / no-op reset, never an error).
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import * as realDurable from "@atlas/api/lib/durable-state";

const VALID_ID = "550e8400-e29b-41d4-a716-446655440000";

const mockReadSlots: Mock<(args: Record<string, unknown>) => Promise<unknown[]>> = mock(async () => []);
const mockResetMemory: Mock<(args: Record<string, unknown>) => Promise<number>> = mock(async () => 0);

mock.module("@atlas/api/lib/durable-state", () => ({
  ...realDurable,
  readSessionMemorySlots: mockReadSlots,
  resetSessionMemory: mockResetMemory,
}));

const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> = mock(() =>
  Promise.resolve({
    authenticated: true,
    mode: "simple-key",
    user: { id: "user-1", label: "analyst@test.dev", mode: "simple-key", activeOrganizationId: "org-1" },
  }),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
}));

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    createLogger: () => logger,
    getLogger: () => logger,
    withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
    getRequestContext: () => undefined,
    redactPaths: [],
    hashShareToken: (t: string) => t,
  };
});

const { conversations } = await import("../conversations");

const headers = { Authorization: "Bearer test-key" };

beforeEach(() => {
  mockReadSlots.mockReset();
  mockReadSlots.mockImplementation(async () => []);
  mockResetMemory.mockReset();
  mockResetMemory.mockImplementation(async () => 0);
  mockAuthenticateRequest.mockClear();
});

describe("GET /:id/memory — read the conversation's working memory", () => {
  it("returns the caller's slots, scoped to their user id", async () => {
    mockReadSlots.mockImplementation(async () => [
      { namespace: "region", value: "EU", updatedAt: "2026-06-20T10:00:00.000Z" },
    ]);
    const res = await conversations.request(`/${VALID_ID}/memory`, { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      slots: [{ namespace: "region", value: "EU", updatedAt: "2026-06-20T10:00:00.000Z" }],
    });
    expect(mockReadSlots).toHaveBeenCalledTimes(1);
    expect(mockReadSlots.mock.calls[0]![0]).toMatchObject({ conversationId: VALID_ID, userId: "user-1", orgId: "org-1" });
  });

  it("rejects an invalid conversation id with 400", async () => {
    const res = await conversations.request(`/not-a-uuid/memory`, { headers });
    expect(res.status).toBe(400);
    expect(mockReadSlots).not.toHaveBeenCalled();
  });

  it("Noop: an empty read view is 200 { slots: [] }, never an error", async () => {
    mockReadSlots.mockImplementation(async () => []); // helper short-circuits with no internal DB
    const res = await conversations.request(`/${VALID_ID}/memory`, { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slots: [] });
  });
});

describe("DELETE /:id/memory — reset the conversation's working memory", () => {
  it("clears the caller's slots and returns the cleared count", async () => {
    mockResetMemory.mockImplementation(async () => 2);
    const res = await conversations.request(`/${VALID_ID}/memory`, { method: "DELETE", headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cleared: 2 });
    expect(mockResetMemory.mock.calls[0]![0]).toMatchObject({ conversationId: VALID_ID, userId: "user-1", orgId: "org-1" });
  });

  it("rejects an invalid conversation id with 400", async () => {
    const res = await conversations.request(`/not-a-uuid/memory`, { method: "DELETE", headers });
    expect(res.status).toBe(400);
    expect(mockResetMemory).not.toHaveBeenCalled();
  });

  it("Noop: a reset with no internal DB is 200 { cleared: 0 }, never an error", async () => {
    mockResetMemory.mockImplementation(async () => 0);
    const res = await conversations.request(`/${VALID_ID}/memory`, { method: "DELETE", headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cleared: 0 });
  });
});
