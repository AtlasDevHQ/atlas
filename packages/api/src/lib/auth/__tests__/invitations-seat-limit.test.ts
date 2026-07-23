/**
 * Tests for `enforceInvitationSeatLimit`'s error-arm mapping (#3433).
 *
 * The `ResourceLimitResult` contract (`lib/billing/enforcement.ts`) keeps
 * its two `allowed: false` arms deliberately distinct:
 *
 *   - `cap_reached`  — genuine plan cap → 429 "upgrade your plan"
 *   - `check_failed` — infra fault (count unreadable) → 503 "try again"
 *
 * Both arms must stay fail-closed (the invitation is blocked either way);
 * only the thrown `APIError` status/message differs. Collapsing
 * `check_failed` into `TOO_MANY_REQUESTS` shows an admin "seat limit
 * reached — upgrade" during an internal-DB blip for seats they're
 * entitled to.
 */

import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";
import type { ResourceLimitResult } from "@atlas/api/lib/billing/enforcement";

const mocks = createApiTestMocks();

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
}));

const { enforceInvitationSeatLimit } = await import("@atlas/api/lib/auth/invitations");
const { APIError } = await import("better-auth/api");

afterAll(() => mocks.cleanup());

beforeEach(() => {
  mocks.hasInternalDB = true;
  mocks.mockInternalQuery.mockClear();
  mocks.mockInternalQuery.mockImplementation(async () => [{ count: 5 }]);
  mockCheckResourceLimit.mockClear();
  mockCheckResourceLimit.mockImplementation(async () => ({ allowed: true }));
});

/** Run the gate and return the thrown APIError, failing if it resolves. */
async function expectAPIError(): Promise<InstanceType<typeof APIError>> {
  try {
    await enforceInvitationSeatLimit("org-1");
  } catch (err) {
    expect(err).toBeInstanceOf(APIError);
    return err as InstanceType<typeof APIError>;
  }
  throw new Error("expected enforceInvitationSeatLimit to throw, but it resolved");
}

describe("enforceInvitationSeatLimit error-arm mapping (#3433)", () => {
  it("resolves when the seat check allows", async () => {
    await expect(enforceInvitationSeatLimit("org-1")).resolves.toBeUndefined();
    expect(mockCheckResourceLimit).toHaveBeenCalledWith("org-1", "seats", 5);
  });

  it("cap_reached → 429 TOO_MANY_REQUESTS with upgrade guidance", async () => {
    mockCheckResourceLimit.mockImplementation(async () => ({
      allowed: false,
      reason: "cap_reached",
      errorMessage: "Your starter plan allows up to 5 seats. Upgrade to add more.",
      limit: 5,
    tier: "starter" as const,
    }));

    const err = await expectAPIError();
    expect(err.status).toBe("TOO_MANY_REQUESTS");
    expect(err.statusCode).toBe(429);
    expect(err.body?.message).toContain("Upgrade");
  });

  it("check_failed → 503 SERVICE_UNAVAILABLE with retry guidance, NOT a plan-limit error", async () => {
    mockCheckResourceLimit.mockImplementation(async () => ({
      allowed: false,
      reason: "check_failed",
      errorMessage: "Unable to verify plan limits. Please try again.",
    }));

    const err = await expectAPIError();
    expect(err.status).toBe("SERVICE_UNAVAILABLE");
    expect(err.statusCode).toBe(503);
    expect(err.body?.message).toMatch(/try again/i);
    // The infra-failure arm must never masquerade as a seat-limit hit.
    expect(err.body?.message ?? "").not.toMatch(/upgrade|seat limit/i);
  });
});
