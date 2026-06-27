/**
 * Tests for the shared agent billing gate (#3419 / #3420).
 *
 * `checkAgentBillingGate` is the single enforcement seam consulted by
 * `executeAgentQuery` before any LLM spend. It composes the three
 * existing checks — `checkWorkspaceStatus`, `checkAbuseStatus`,
 * `checkPlanLimits` — in that order, short-circuiting on the first
 * block. These tests pin the composition contract (which check wins,
 * what envelope fields each block carries), not the internals of the
 * underlying checks — those have their own suites
 * (`workspace.test.ts`, `abuse.test.ts`, `enforcement.test.ts`).
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";

// --- Controllable verdicts for the three underlying checks ---

type WorkspaceVerdict = {
  allowed: boolean;
  status?: string;
  errorCode?: string;
  errorMessage?: string;
  httpStatus?: 403 | 404 | 503;
};
let workspaceVerdict: WorkspaceVerdict = { allowed: true };
const mockCheckWorkspaceStatus = mock(async (_orgId: string | undefined) => workspaceVerdict);

let abuseVerdict: { level: string; throttleDelayMs?: number } = { level: "none" };
const mockCheckAbuseStatus = mock((_workspaceId: string) => abuseVerdict);

type PlanVerdict =
  | { allowed: true; warning?: { code: "plan_limit_warning"; message: string; metrics: unknown[] } }
  | { allowed: false; errorCode: string; errorMessage: string; httpStatus: 403 | 429 | 503; usage?: { currentUsage: number; limit: number; metric: string } };
let planVerdict: PlanVerdict = { allowed: true };
const mockCheckPlanLimits = mock(async (_orgId: string | undefined) => planVerdict);

mock.module("@atlas/api/lib/workspace", () => ({
  checkWorkspaceStatus: mockCheckWorkspaceStatus,
}));

mock.module("@atlas/api/lib/security/abuse", () => ({
  checkAbuseStatus: mockCheckAbuseStatus,
  // Unused by the gate but mock.module replaces the whole module —
  // stub every value export so unrelated importers in the graph load.
  ABUSE_RESTORE_STATUSES: ["pending", "complete", "failed", "skipped"],
  getAbuseConfig: mock(() => ({ throttleDelayMs: 5000 })),
  getAbuseRestoreStatus: mock(() => "complete"),
  _resetAbuseState: mock(() => {}),
  recordQueryEvent: mock(() => {}),
  listFlaggedWorkspaces: mock(() => []),
  getAbuseDetail: mock(async () => null),
  reinstateWorkspace: mock(() => false),
  getAbuseEvents: mock(async () => ({ events: [], status: "ok" })),
  restoreAbuseState: mock(async () => {}),
  ABUSE_CLEANUP_INTERVAL_MS: 300_000,
  abuseCleanupTick: mock(() => {}),
}));

mock.module("@atlas/api/lib/billing/enforcement", () => ({
  checkPlanLimits: mockCheckPlanLimits,
  // Unused by the gate — stubbed for module-graph completeness.
  getCachedWorkspace: mock(async () => null),
  invalidatePlanCache: mock(() => {}),
  buildMetricStatus: mock(() => ({ metric: "usd", currentUsage: 0, limit: 1, usagePercent: 0, status: "ok" })),
  severityOf: mock(() => 0),
  checkResourceLimit: mock(async () => ({ allowed: true })),
  CHAT_INTEGRATION_COUNT_SQL: "",
  checkChatIntegrationLimit: mock(async () => ({ allowed: true })),
  checkChatIntegrationLimitAndInstall: mock(async () => ({ allowed: true, rows: [] })),
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { checkAgentBillingGate } = await import("@atlas/api/lib/billing/agent-gate");

describe("checkAgentBillingGate", () => {
  beforeEach(() => {
    workspaceVerdict = { allowed: true };
    abuseVerdict = { level: "none" };
    planVerdict = { allowed: true };
    mockCheckWorkspaceStatus.mockClear();
    mockCheckAbuseStatus.mockClear();
    mockCheckPlanLimits.mockClear();
  });

  it("blocks a suspended workspace with 403 workspace_suspended", async () => {
    workspaceVerdict = {
      allowed: false,
      status: "suspended",
      errorCode: "workspace_suspended",
      errorMessage: "This workspace has been suspended. Please update your payment method or contact support.",
      httpStatus: 403,
    };
    const result = await checkAgentBillingGate("org-1");
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("expected block");
    expect(result.errorCode).toBe("workspace_suspended");
    expect(result.httpStatus).toBe(403);
    expect(result.retryable).toBe(false);
    expect(result.errorMessage).toContain("suspended");
  });

  it("blocks a deleted workspace with 404 workspace_deleted", async () => {
    workspaceVerdict = {
      allowed: false,
      status: "deleted",
      errorCode: "workspace_deleted",
      errorMessage: "This workspace has been deleted.",
      httpStatus: 404,
    };
    const result = await checkAgentBillingGate("org-1");
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("expected block");
    expect(result.errorCode).toBe("workspace_deleted");
    expect(result.httpStatus).toBe(404);
    expect(result.retryable).toBe(false);
  });

  it("fails closed (503, retryable) when the workspace lookup fails", async () => {
    workspaceVerdict = {
      allowed: false,
      errorCode: "workspace_check_failed",
      errorMessage: "Unable to verify workspace status. Please try again.",
      httpStatus: 503,
    };
    const result = await checkAgentBillingGate("org-1");
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("expected block");
    expect(result.errorCode).toBe("workspace_check_failed");
    expect(result.httpStatus).toBe(503);
    expect(result.retryable).toBe(true);
  });

  it("short-circuits on a workspace block — abuse and plan checks never run", async () => {
    workspaceVerdict = {
      allowed: false,
      errorCode: "workspace_suspended",
      errorMessage: "suspended",
      httpStatus: 403,
    };
    await checkAgentBillingGate("org-1");
    expect(mockCheckAbuseStatus).not.toHaveBeenCalled();
    expect(mockCheckPlanLimits).not.toHaveBeenCalled();
  });

  it("blocks an abuse-suspended workspace with 403 (plan check never runs)", async () => {
    abuseVerdict = { level: "suspended" };
    const result = await checkAgentBillingGate("org-1");
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("expected block");
    expect(result.errorCode).toBe("workspace_suspended");
    expect(result.httpStatus).toBe(403);
    expect(result.retryable).toBe(false);
    expect(result.errorMessage).toContain("unusual activity");
    expect(mockCheckPlanLimits).not.toHaveBeenCalled();
  });

  it("blocks an abuse-throttled workspace with 429 + retryAfterSeconds", async () => {
    abuseVerdict = { level: "throttled", throttleDelayMs: 5000 };
    const result = await checkAgentBillingGate("org-1");
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("expected block");
    expect(result.errorCode).toBe("workspace_throttled");
    expect(result.httpStatus).toBe(429);
    expect(result.retryable).toBe(true);
    expect(result.retryAfterSeconds).toBe(5);
  });

  it("blocks a throttled workspace even when throttleDelayMs is missing (fail-closed, 1s floor)", async () => {
    abuseVerdict = { level: "throttled" };
    const result = await checkAgentBillingGate("org-1");
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("expected block");
    expect(result.errorCode).toBe("workspace_throttled");
    expect(result.retryAfterSeconds).toBe(1);
  });

  it("blocks a trial-expired workspace with 403 trial_expired", async () => {
    planVerdict = {
      allowed: false,
      errorCode: "trial_expired",
      errorMessage: "Your free trial has expired. Upgrade to a paid plan to continue using Atlas.",
      httpStatus: 403,
    };
    const result = await checkAgentBillingGate("org-1");
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("expected block");
    expect(result.errorCode).toBe("trial_expired");
    expect(result.httpStatus).toBe(403);
    expect(result.retryable).toBe(false);
    expect(result.errorMessage).toContain("trial has expired");
  });

  it("blocks a hard-capped workspace with 429 plan_limit_exceeded + usage", async () => {
    planVerdict = {
      allowed: false,
      errorCode: "plan_limit_exceeded",
      errorMessage: "You have reached your workspace's spend ceiling.",
      httpStatus: 429,
      usage: { currentUsage: 100, limit: 20, metric: "usd" },
    };
    const result = await checkAgentBillingGate("org-1");
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("expected block");
    expect(result.errorCode).toBe("plan_limit_exceeded");
    expect(result.httpStatus).toBe(429);
    expect(result.usage).toEqual({ currentUsage: 100, limit: 20, metric: "usd" });
  });

  it("blocks a churned (locked) workspace with 403 subscription_required", async () => {
    planVerdict = {
      allowed: false,
      errorCode: "subscription_required",
      errorMessage: "Your subscription has ended. Resubscribe from the billing page to continue using Atlas.",
      httpStatus: 403,
    };
    const result = await checkAgentBillingGate("org-1");
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("expected block");
    expect(result.errorCode).toBe("subscription_required");
    expect(result.retryable).toBe(false);
  });

  it("fails closed (503, retryable) when the plan check itself fails", async () => {
    planVerdict = {
      allowed: false,
      errorCode: "billing_check_failed",
      errorMessage: "Unable to verify billing status. Please try again.",
      httpStatus: 503,
    };
    const result = await checkAgentBillingGate("org-1");
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("expected block");
    expect(result.errorCode).toBe("billing_check_failed");
    expect(result.retryable).toBe(true);
  });

  it("allows and passes the approaching-credit warning band through without blocking", async () => {
    planVerdict = {
      allowed: true,
      warning: { code: "plan_limit_warning", message: "You are approaching your included usage credit", metrics: [] },
    };
    const result = await checkAgentBillingGate("org-1");
    expect(result.allowed).toBe(true);
    if (!result.allowed) throw new Error("expected allow");
    expect(result.warning?.code).toBe("plan_limit_warning");
  });

  it("allows a healthy workspace, consulting all three checks", async () => {
    const result = await checkAgentBillingGate("org-1");
    expect(result.allowed).toBe(true);
    expect(mockCheckWorkspaceStatus).toHaveBeenCalledWith("org-1");
    expect(mockCheckAbuseStatus).toHaveBeenCalledWith("org-1");
    expect(mockCheckPlanLimits).toHaveBeenCalledWith("org-1");
  });

  it("allows with no orgId without consulting abuse or plan checks", async () => {
    const result = await checkAgentBillingGate(undefined);
    expect(result.allowed).toBe(true);
    expect(mockCheckAbuseStatus).not.toHaveBeenCalled();
    expect(mockCheckPlanLimits).not.toHaveBeenCalled();
  });
});
