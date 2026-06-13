/**
 * Platform-admin workspace lifecycle × Stripe teardown wiring (#3425).
 *
 * Route-level tests that the suspend/unsuspend/delete/purge handlers call
 * into `lib/billing/workspace-teardown` (mocked here) with the right
 * arguments and ordering, and that Stripe failures surface to the operator
 * as a `warnings` field on the 200 response instead of stranding silently:
 *
 *   - DELETE  → cancelStripeSubscriptionsForWorkspace BEFORE the DB cascade
 *   - purge   → purgeStripeBillingForWorkspace(orgId, stripeCustomerId)
 *               BEFORE hardDeleteWorkspace (the cascade destroys the row
 *               carrying the customer id)
 *   - suspend → pauseStripeCollectionForWorkspace
 *   - unsuspend → resumeStripeCollectionForWorkspace
 *   - teardown warnings → `warnings` on the response + audit metadata
 *   - no-op teardown (self-hosted) → no `warnings` key, no `stripe` audit key
 */

import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";
import type { StripeTeardownOutcome } from "@atlas/api/lib/billing/workspace-teardown";

// ── Mockable state ──────────────────────────────────────────────────

/** Cross-module call order — proves Stripe teardown runs before the cascade. */
let callOrder: string[] = [];

function wsRow(status: string): Record<string, unknown> {
  return {
    id: "org-1",
    name: "Acme",
    slug: "acme",
    workspace_status: status,
    plan_tier: "pro",
    byot: false,
    stripe_customer_id: "cus_acme",
    trial_ends_at: null,
    suspended_at: null,
    deleted_at: null,
    region: null,
    region_assigned_at: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

let workspaceStatus = "active";

const mockGetWorkspaceDetails = mock(async () => wsRow(workspaceStatus));
const mockUpdateWorkspaceStatus = mock(async () => {
  callOrder.push("updateStatus");
  return true;
});
const mockCascade = mock(async () => {
  callOrder.push("cascade");
  return {
    conversations: 1,
    semanticEntities: 0,
    learnedPatterns: 0,
    suggestions: 0,
    scheduledTasks: 0,
    settings: 0,
  };
});
const mockHardDelete = mock(async () => {
  callOrder.push("hardDelete");
  return { conversations: 3, subscriptions: 1, organization: 1 };
});

// #3427 — spies for the plan-override + trial-extension behavior.
const mockUpdatePlanTier = mock(async (_orgId: string, _tier: string, _override?: unknown) => true);
const mockSetTrialEndsAt = mock(async (_orgId: string, _date: Date) => true);

const mocks = createApiTestMocks({
  internal: {
    getWorkspaceDetails: mockGetWorkspaceDetails,
    updateWorkspaceStatus: mockUpdateWorkspaceStatus,
    cascadeWorkspaceDelete: mockCascade,
    hardDeleteWorkspace: mockHardDelete,
    updateWorkspacePlanTier: mockUpdatePlanTier,
    setWorkspaceTrialEndsAt: mockSetTrialEndsAt,
  },
});

// ── Stripe teardown module mock (all exports) ───────────────────────

let teardownOutcome: StripeTeardownOutcome = { attempted: true, actions: [], warnings: [] };

const mockCancelSubs = mock(async (_orgId: string) => {
  callOrder.push("stripe:cancel");
  return teardownOutcome;
});
const mockPurgeBilling = mock(async (_orgId: string, _customerId: string | null) => {
  callOrder.push("stripe:purge");
  return teardownOutcome;
});
const mockPause = mock(async (_orgId: string) => {
  callOrder.push("stripe:pause");
  return teardownOutcome;
});
const mockResume = mock(async (_orgId: string) => {
  callOrder.push("stripe:resume");
  return teardownOutcome;
});

mock.module("@atlas/api/lib/billing/workspace-teardown", () => ({
  cancelStripeSubscriptionsForWorkspace: mockCancelSubs,
  purgeStripeBillingForWorkspace: mockPurgeBilling,
  pauseStripeCollectionForWorkspace: mockPause,
  resumeStripeCollectionForWorkspace: mockResume,
  // Shared response/audit helpers (#3459) — mirror the real implementations
  // so the warnings/audit assertions below exercise the same shapes.
  stripeAuditMetadata: (billing: StripeTeardownOutcome) =>
    billing.attempted
      ? { stripe: { actions: billing.actions, warnings: billing.warnings } }
      : {},
  withWarnings: (billing: StripeTeardownOutcome) =>
    billing.warnings.length > 0 ? { warnings: billing.warnings } : {},
}));

// ── Audit capture ───────────────────────────────────────────────────

interface CapturedAudit {
  actionType: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}
let auditCalls: CapturedAudit[] = [];

mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: mock((entry: CapturedAudit) => {
    auditCalls.push(entry);
  }),
  logAdminActionAwait: mock(async (entry: CapturedAudit) => {
    auditCalls.push(entry);
  }),
  ADMIN_ACTIONS: {
    workspace: {
      suspend: "workspace.suspend",
      unsuspend: "workspace.unsuspend",
      delete: "workspace.delete",
      purge: "workspace.purge",
      changePlan: "workspace.change_plan",
    },
  },
}));

const { app } = await import("../index");

afterAll(() => mocks.cleanup());

function platformRequest(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, init);
}

beforeEach(() => {
  mocks.setPlatformAdmin();
  callOrder = [];
  auditCalls = [];
  workspaceStatus = "active";
  teardownOutcome = { attempted: true, actions: ["canceled Stripe subscription sub_1"], warnings: [] };
  mockCancelSubs.mockClear();
  mockPurgeBilling.mockClear();
  mockPause.mockClear();
  mockResume.mockClear();
  mockCascade.mockClear();
  mockHardDelete.mockClear();
  mockUpdateWorkspaceStatus.mockClear();
  mockUpdatePlanTier.mockClear();
  mockSetTrialEndsAt.mockClear();
});

// ── Delete ──────────────────────────────────────────────────────────

describe("DELETE /api/v1/platform/workspaces/:id — Stripe teardown", () => {
  it("cancels Stripe subscriptions BEFORE the DB cascade", async () => {
    const res = await app.fetch(platformRequest("DELETE", "/api/v1/platform/workspaces/org-1"));

    expect(res.status).toBe(200);
    expect(mockCancelSubs).toHaveBeenCalledTimes(1);
    expect(mockCancelSubs.mock.calls[0][0]).toBe("org-1");
    expect(callOrder.indexOf("stripe:cancel")).toBeLessThan(callOrder.indexOf("cascade"));
  });

  it("surfaces Stripe failures as warnings on the response and in audit metadata — delete proceeds", async () => {
    teardownOutcome = {
      attempted: true,
      actions: [],
      warnings: ["Failed to cancel Stripe subscription sub_1: stripe is down. Cancel it manually in the Stripe dashboard."],
    };

    const res = await app.fetch(platformRequest("DELETE", "/api/v1/platform/workspaces/org-1"));
    const body = (await res.json()) as { warnings?: string[] };

    expect(res.status).toBe(200);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings?.[0]).toContain("sub_1");
    // Delete still completed.
    expect(mockCascade).toHaveBeenCalledTimes(1);
    expect(mockUpdateWorkspaceStatus).toHaveBeenCalledTimes(1);
    // Audit metadata records the Stripe outcome.
    const deleteAudit = auditCalls.find((a) => a.actionType === "workspace.delete");
    expect(deleteAudit?.metadata?.stripe).toEqual({
      actions: [],
      warnings: teardownOutcome.warnings,
    });
  });

  it("omits warnings + stripe audit key when teardown is a no-op (self-hosted)", async () => {
    teardownOutcome = { attempted: false, actions: [], warnings: [] };

    const res = await app.fetch(platformRequest("DELETE", "/api/v1/platform/workspaces/org-1"));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect("warnings" in body).toBe(false);
    const deleteAudit = auditCalls.find((a) => a.actionType === "workspace.delete");
    expect(deleteAudit?.metadata && "stripe" in deleteAudit.metadata).toBe(false);
  });
});

// ── Purge ───────────────────────────────────────────────────────────

describe("POST /api/v1/platform/workspaces/:id/purge — Stripe teardown", () => {
  beforeEach(() => {
    workspaceStatus = "deleted"; // purge requires a soft-deleted workspace
  });

  it("tears down Stripe billing (with the org's customer id) BEFORE the hard-delete cascade", async () => {
    const res = await app.fetch(platformRequest("POST", "/api/v1/platform/workspaces/org-1/purge"));

    expect(res.status).toBe(200);
    expect(mockPurgeBilling).toHaveBeenCalledTimes(1);
    expect(mockPurgeBilling.mock.calls[0][0]).toBe("org-1");
    expect(mockPurgeBilling.mock.calls[0][1]).toBe("cus_acme");
    expect(callOrder.indexOf("stripe:purge")).toBeLessThan(callOrder.indexOf("hardDelete"));
  });

  it("surfaces Stripe failures as warnings — purge proceeds", async () => {
    teardownOutcome = {
      attempted: true,
      actions: [],
      warnings: ["Failed to delete Stripe customer cus_acme: api_error. Delete it manually in the Stripe dashboard — a GDPR purge must not leave a billable customer record."],
    };

    const res = await app.fetch(platformRequest("POST", "/api/v1/platform/workspaces/org-1/purge"));
    const body = (await res.json()) as { warnings?: string[] };

    expect(res.status).toBe(200);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings?.[0]).toContain("cus_acme");
    expect(mockHardDelete).toHaveBeenCalledTimes(1);
  });
});

// ── Suspend / unsuspend ─────────────────────────────────────────────

describe("POST /api/v1/platform/workspaces/:id/suspend|unsuspend — pause/resume collection", () => {
  it("suspend pauses Stripe collection", async () => {
    const res = await app.fetch(platformRequest("POST", "/api/v1/platform/workspaces/org-1/suspend"));

    expect(res.status).toBe(200);
    expect(mockPause).toHaveBeenCalledTimes(1);
    expect(mockPause.mock.calls[0][0]).toBe("org-1");
    expect(mockResume).not.toHaveBeenCalled();
  });

  it("unsuspend resumes Stripe collection", async () => {
    workspaceStatus = "suspended";

    const res = await app.fetch(platformRequest("POST", "/api/v1/platform/workspaces/org-1/unsuspend"));

    expect(res.status).toBe(200);
    expect(mockResume).toHaveBeenCalledTimes(1);
    expect(mockResume.mock.calls[0][0]).toBe("org-1");
    expect(mockPause).not.toHaveBeenCalled();
  });

  it("suspend surfaces pause failures as warnings — suspend stands", async () => {
    teardownOutcome = {
      attempted: true,
      actions: [],
      warnings: ["Failed to pause collection on Stripe subscription sub_1: rate_limited. Pause it manually in the Stripe dashboard so the suspended workspace isn't invoiced."],
    };

    const res = await app.fetch(platformRequest("POST", "/api/v1/platform/workspaces/org-1/suspend"));
    const body = (await res.json()) as { warnings?: string[] };

    expect(res.status).toBe(200);
    expect(body.warnings).toHaveLength(1);
    expect(mockUpdateWorkspaceStatus).toHaveBeenCalledTimes(1);
  });
});

// ── Plan change: operator override + trial extension + free→cancel (#3427) ──

describe("PATCH /api/v1/platform/workspaces/:id/plan — operator override precedence (#3427)", () => {
  it("stamps a plan-override window (default 90d) so the next webhook can't clobber the grant", async () => {
    const before = Date.now();
    const res = await app.fetch(
      platformRequest("PATCH", "/api/v1/platform/workspaces/org-1/plan", { planTier: "pro" }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { planOverrideUntil: string | null };
    expect(mockUpdatePlanTier).toHaveBeenCalledTimes(1);
    const [orgId, tier, override] = mockUpdatePlanTier.mock.calls[0] as [string, string, { until: Date }];
    expect(orgId).toBe("org-1");
    expect(tier).toBe("pro");
    expect(override).toHaveProperty("until");
    const ms = override.until.getTime() - before;
    expect(ms).toBeGreaterThan(89 * 86_400_000);
    expect(ms).toBeLessThan(91 * 86_400_000);
    expect(body.planOverrideUntil).toBe(override.until.toISOString());
  });

  it("clears the override (releases control to Stripe) when overrideDays is 0", async () => {
    const res = await app.fetch(
      platformRequest("PATCH", "/api/v1/platform/workspaces/org-1/plan", { planTier: "starter", overrideDays: 0 }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { planOverrideUntil: string | null };
    const [, , override] = mockUpdatePlanTier.mock.calls[0] as [string, string, unknown];
    expect(override).toBe("clear");
    expect(body.planOverrideUntil).toBeNull();
  });

  it("rejects setting the 'trial' tier with no trialEndsAt (no stale reuse)", async () => {
    const res = await app.fetch(
      platformRequest("PATCH", "/api/v1/platform/workspaces/org-1/plan", { planTier: "trial" }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("trialEndsAt");
    expect(mockUpdatePlanTier).not.toHaveBeenCalled();
  });

  it("extends a trial: wires setWorkspaceTrialEndsAt with an explicit future date", async () => {
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const res = await app.fetch(
      platformRequest("PATCH", "/api/v1/platform/workspaces/org-1/plan", {
        planTier: "trial",
        trialEndsAt: future,
      }),
    );

    expect(res.status).toBe(200);
    expect(mockUpdatePlanTier).toHaveBeenCalledWith("org-1", "trial", expect.anything());
    expect(mockSetTrialEndsAt).toHaveBeenCalledTimes(1);
    const [orgId, date] = mockSetTrialEndsAt.mock.calls[0] as [string, Date];
    expect(orgId).toBe("org-1");
    expect(date.toISOString()).toBe(future);
  });

  it("cancels Stripe subscriptions when downgrading a paying org to free", async () => {
    const res = await app.fetch(
      platformRequest("PATCH", "/api/v1/platform/workspaces/org-1/plan", { planTier: "free" }),
    );

    expect(res.status).toBe(200);
    expect(mockCancelSubs).toHaveBeenCalledTimes(1);
    expect(mockCancelSubs.mock.calls[0][0]).toBe("org-1");
  });

  it("does NOT touch Stripe when moving to a paid tier", async () => {
    const res = await app.fetch(
      platformRequest("PATCH", "/api/v1/platform/workspaces/org-1/plan", { planTier: "pro" }),
    );

    expect(res.status).toBe(200);
    expect(mockCancelSubs).not.toHaveBeenCalled();
  });
});
