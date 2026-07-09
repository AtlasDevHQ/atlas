/**
 * Tests for the admin durable session-memory routes (#3758) — exercises the
 * org-scoped list + reset wiring end-to-end through the real `lib/durable-state`
 * helpers (with `internalQuery` mocked), plus the requireOrgContext gate and the
 * audit emission on reset.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import * as realInternal from "@atlas/api/lib/db/internal";

let mockHasInternalDB = true;
const queryCalls: Array<{ sql: string; params?: unknown[] }> = [];
let queryImpl: (sql: string, params?: unknown[]) => Promise<unknown[]> = async () => [];

void mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: (sql: string, params?: unknown[]) => {
    queryCalls.push({ sql, params });
    return queryImpl(sql, params);
  },
  internalExecute: () => {},
}));

const defaultAuthResponse = () =>
  Promise.resolve({
    authenticated: true,
    mode: "managed",
    user: {
      id: "admin-1",
      mode: "managed",
      label: "admin@test.dev",
      role: "admin",
      activeOrganizationId: "org-test",
      claims: { twoFactorEnabled: true },
    },
  });

const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> = mock(() => defaultAuthResponse());

void mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
  resetRateLimits: () => {},
  rateLimitCleanupTick: () => {},
}));

void mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    createLogger: () => logger,
    getLogger: () => logger,
    withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
    getRequestContext: () => undefined,
    redactPaths: [],
  };
});

const mockLogAdminAction: Mock<(entry: Record<string, unknown>) => void> = mock(() => {});

void mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: mockLogAdminAction,
  logAdminActionAwait: async () => {},
  // Keep in sync with `ADMIN_ACTIONS.conversation` in lib/audit/actions.ts.
  ADMIN_ACTIONS: {
    conversation: {
      budgetExceeded: "conversation.budget_exceeded",
      memoryReset: "conversation.memory_reset",
    },
  },
}));

const { adminSessionMemory } = await import("../admin-session-memory");

const authHeaders = { Authorization: "Bearer test-key" };

beforeEach(() => {
  mockHasInternalDB = true;
  queryCalls.length = 0;
  queryImpl = async () => [];
  mockAuthenticateRequest.mockReset();
  mockAuthenticateRequest.mockImplementation(defaultAuthResponse);
  mockLogAdminAction.mockReset();
});

describe("GET / — list sessions with memory", () => {
  it("returns the org's sessions, grouped, scoped to the caller's org", async () => {
    queryImpl = async () => [
      { conversationId: "conv-a", title: "Q2", namespace: "region", value: "EU", updatedAt: "2026-06-20T10:00:00.000Z" },
      { conversationId: "conv-a", title: "Q2", namespace: "table", value: "orders", updatedAt: "2026-06-20T11:00:00.000Z" },
      { conversationId: "conv-b", title: null, namespace: "x", value: 1, updatedAt: "2026-06-19T09:00:00.000Z" },
    ];
    const res = await adminSessionMemory.request("/", { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ conversationId: string; slots: unknown[] }> };
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions[0]!.conversationId).toBe("conv-a");
    expect(body.sessions[0]!.slots).toHaveLength(2);
    // The list query was scoped strictly to the caller's org.
    expect(queryCalls[0]!.params).toEqual(["org-test"]);
    expect(queryCalls[0]!.sql).toContain("c.org_id = $1");
  });

  it("returns 404 when no internal DB is configured (requireOrgContext gate)", async () => {
    mockHasInternalDB = false;
    const res = await adminSessionMemory.request("/", { headers: authHeaders });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /{conversationId} — reset a session's memory", () => {
  it("clears all slots and returns the cleared count, scoped to the org", async () => {
    queryImpl = async () => [{ namespace: "region" }, { namespace: "table" }];
    const res = await adminSessionMemory.request("/conv-a", { method: "DELETE", headers: authHeaders });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cleared: 2 });
    const del = queryCalls[0]!;
    expect(del.sql).toContain("DELETE FROM agent_session_memory");
    expect(del.sql).toContain("c.org_id = $2");
    expect(del.params).toEqual(["conv-a", "org-test"]);
  });

  it("clears a single namespace when ?namespace= is given", async () => {
    queryImpl = async () => [{ namespace: "region" }];
    const res = await adminSessionMemory.request("/conv-a?namespace=region", {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cleared: 1 });
    expect(queryCalls[0]!.params).toEqual(["conv-a", "org-test", "region"]);
  });

  it("audits the reset with the count + namespace", async () => {
    queryImpl = async () => [{ namespace: "region" }];
    await adminSessionMemory.request("/conv-a?namespace=region", { method: "DELETE", headers: authHeaders });
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0]!;
    expect(entry.actionType).toBe("conversation.memory_reset");
    expect(entry.targetId).toBe("conv-a");
    expect(entry.metadata).toEqual({ cleared: 1, namespace: "region" });
  });

  it("is idempotent: a reset that matches no rows returns cleared: 0", async () => {
    queryImpl = async () => [];
    const res = await adminSessionMemory.request("/conv-zzz", { method: "DELETE", headers: authHeaders });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cleared: 0 });
  });
});
