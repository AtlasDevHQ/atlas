/**
 * Tests for the create-connection plan-limit gate's error-arm mapping (#3433).
 *
 * `POST /api/v1/admin/connections` runs `checkResourceLimit(orgId,
 * "connections", count)` before installing. The `ResourceLimitResult`
 * contract keeps its two `allowed: false` arms deliberately distinct:
 *
 *   - `cap_reached`  — genuine plan cap → 429 `plan_limit_exceeded` "upgrade"
 *   - `check_failed` — infra fault (workspace lookup failed) → 503
 *     `billing_check_failed` "try again"
 *
 * Both arms stay fail-closed (the connection is never created); only the
 * status/code/message differs. Collapsing `check_failed` into the 429 arm
 * shows an admin "plan limit exceeded — upgrade" during an internal-DB
 * blip for a connection they're entitled to.
 */

import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";
import type { ResourceLimitResult } from "@atlas/api/lib/billing/enforcement";

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "managed",
    label: "admin@test.com",
    role: "admin",
    activeOrganizationId: "org-alpha",
  },
  authMode: "managed",
});

// Billing enforcement — per-test arm selection via mockCheckResourceLimit.
const mockCheckResourceLimit = mock<
  (orgId: string | undefined, resource: string, count: number) => Promise<ResourceLimitResult>
>(async () => ({ allowed: true }));

void mock.module("@atlas/api/lib/billing/enforcement", () => ({
  checkResourceLimit: mockCheckResourceLimit,
  getCachedWorkspace: mock(async () => null),
  invalidatePlanCache: mock(() => {}),
  checkPlanLimits: mock(async () => ({ allowed: true, status: "ok" })),
  buildMetricStatus: mock(() => "ok"),
  severityOf: mock(() => 0),
  CHAT_INTEGRATION_COUNT_SQL: "SELECT 1",
  checkChatIntegrationLimit: mock(async () => ({ allowed: true })),
  checkChatIntegrationLimitAndInstall: mock(async () => ({ outcome: "installed" })),
  KNOWLEDGE_COLLECTION_COUNT_SQL: "SELECT 1",
  checkKnowledgeCollectionLimit: mock(async () => ({ allowed: true })),
  checkKnowledgeCollectionLimitAndInstall: mock(async () => ({ allowed: true, rows: [] })),
}));

const { app } = await import("../index");

afterAll(() => mocks.cleanup());

beforeEach(() => {
  mocks.hasInternalDB = true;
  mocks.mockInternalQuery.mockClear();
  // The route's plan-limit COUNT against workspace_plugins.
  mocks.mockInternalQuery.mockImplementation(async () => [{ count: 3 }]);
  mockCheckResourceLimit.mockClear();
  mockCheckResourceLimit.mockImplementation(async () => ({ allowed: true }));
});

function createRequest(): Request {
  return new Request("http://localhost/api/v1/admin/connections", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: "warehouse", url: "postgresql://example/db" }),
  });
}

describe("POST /api/v1/admin/connections resource-limit arms (#3433)", () => {
  it("cap_reached → 429 plan_limit_exceeded with upgrade guidance", async () => {
    mockCheckResourceLimit.mockImplementation(async () => ({
      allowed: false,
      reason: "cap_reached",
      errorMessage: "Your starter plan allows up to 3 connections. Upgrade to add more.",
      limit: 3,
    }));

    const res = await app.fetch(createRequest());
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; message: string; requestId?: string };
    expect(body.error).toBe("plan_limit_exceeded");
    expect(body.message).toContain("Upgrade");
    expect(mockCheckResourceLimit).toHaveBeenCalledWith("org-alpha", "connections", 3);
  });

  it("check_failed → 503 billing_check_failed with retry guidance, NOT a plan-limit error", async () => {
    mockCheckResourceLimit.mockImplementation(async () => ({
      allowed: false,
      reason: "check_failed",
      errorMessage: "Unable to verify plan limits. Please try again.",
    }));

    const res = await app.fetch(createRequest());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string; requestId?: string };
    expect(body.error).toBe("billing_check_failed");
    expect(body.message).toMatch(/try again/i);
    // The infra-failure arm must never masquerade as a plan-limit hit.
    expect(body.error).not.toBe("plan_limit_exceeded");
    expect(body.message).not.toMatch(/upgrade/i);
    expect(typeof body.requestId).toBe("string");
  });

  it("stays fail-closed on check_failed — no install write reaches the DB", async () => {
    const writes: string[] = [];
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (/INSERT|UPDATE|DELETE/i.test(sql)) writes.push(sql);
      return [{ count: 3 }];
    });
    mockCheckResourceLimit.mockImplementation(async () => ({
      allowed: false,
      reason: "check_failed",
      errorMessage: "Unable to verify plan limits. Please try again.",
    }));

    const res = await app.fetch(createRequest());
    expect(res.status).toBe(503);
    expect(writes).toEqual([]);
  });
});
