/**
 * Admin-orgs workspace lifecycle × Stripe teardown wiring (#3459).
 *
 * The admin-orgs surface (`/api/v1/admin/organizations/...`) performs the
 * same suspend/activate/delete mutations as the platform-admin surface but
 * historically with NO Stripe interaction — the exact bug class #3425
 * fixed, still live on the surface the web UI actually calls. Mirrors
 * `platform-admin-stripe-teardown.test.ts`:
 *
 *   - PATCH :id/suspend  → pauseStripeCollectionForWorkspace
 *   - PATCH :id/activate → resumeStripeCollectionForWorkspace
 *   - DELETE :id         → cancelStripeSubscriptionsForWorkspace BEFORE
 *                          the DB cascade
 *   - teardown warnings  → `warnings` on the response + audit metadata
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

// #3427 — spies for the plan-override + trial-extension behavior.
const mockUpdatePlanTier = mock(async (_orgId: string, _tier: string, _override?: unknown) => true);
const mockSetTrialEndsAt = mock(async (_orgId: string, _date: Date) => true);

const mocks = createApiTestMocks({
  internal: {
    getWorkspaceDetails: mockGetWorkspaceDetails,
    updateWorkspaceStatus: mockUpdateWorkspaceStatus,
    cascadeWorkspaceDelete: mockCascade,
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

function adminRequest(method: string, path: string, body?: unknown): Request {
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
  teardownOutcome = { attempted: true, actions: ["paused collection on Stripe subscription sub_1"], warnings: [] };
  mockCancelSubs.mockClear();
  mockPurgeBilling.mockClear();
  mockPause.mockClear();
  mockResume.mockClear();
  mockCascade.mockClear();
  mockUpdateWorkspaceStatus.mockClear();
  mockUpdatePlanTier.mockClear();
  mockSetTrialEndsAt.mockClear();
});

// ── Suspend / activate ──────────────────────────────────────────────

describe("PATCH /api/v1/admin/organizations/:id/suspend|activate — pause/resume collection", () => {
  it("suspend pauses Stripe collection", async () => {
    const res = await app.fetch(adminRequest("PATCH", "/api/v1/admin/organizations/org-1/suspend"));

    expect(res.status).toBe(200);
    expect(mockPause).toHaveBeenCalledTimes(1);
    expect(mockPause.mock.calls[0][0]).toBe("org-1");
    expect(mockResume).not.toHaveBeenCalled();
    const suspendAudit = auditCalls.find((a) => a.actionType === "workspace.suspend");
    expect(suspendAudit?.metadata?.stripe).toEqual({
      actions: teardownOutcome.actions,
      warnings: [],
    });
  });

  it("activate resumes Stripe collection", async () => {
    workspaceStatus = "suspended";

    const res = await app.fetch(adminRequest("PATCH", "/api/v1/admin/organizations/org-1/activate"));

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

    const res = await app.fetch(adminRequest("PATCH", "/api/v1/admin/organizations/org-1/suspend"));
    const body = (await res.json()) as { warnings?: string[] };

    expect(res.status).toBe(200);
    expect(body.warnings).toHaveLength(1);
    expect(mockUpdateWorkspaceStatus).toHaveBeenCalledTimes(1);
  });

  it("omits warnings + stripe audit key when teardown is a no-op (self-hosted)", async () => {
    teardownOutcome = { attempted: false, actions: [], warnings: [] };

    const res = await app.fetch(adminRequest("PATCH", "/api/v1/admin/organizations/org-1/suspend"));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect("warnings" in body).toBe(false);
    const suspendAudit = auditCalls.find((a) => a.actionType === "workspace.suspend");
    expect(suspendAudit?.metadata && "stripe" in suspendAudit.metadata).toBe(false);
  });
});

// ── Delete ──────────────────────────────────────────────────────────

describe("DELETE /api/v1/admin/organizations/:id — Stripe teardown", () => {
  it("cancels Stripe subscriptions BEFORE the DB cascade", async () => {
    const res = await app.fetch(adminRequest("DELETE", "/api/v1/admin/organizations/org-1"));

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

    const res = await app.fetch(adminRequest("DELETE", "/api/v1/admin/organizations/org-1"));
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

  it("omits the stripe audit key when teardown is a no-op (self-hosted)", async () => {
    teardownOutcome = { attempted: false, actions: [], warnings: [] };

    const res = await app.fetch(adminRequest("DELETE", "/api/v1/admin/organizations/org-1"));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect("warnings" in body).toBe(false);
    const deleteAudit = auditCalls.find((a) => a.actionType === "workspace.delete");
    expect(deleteAudit?.metadata && "stripe" in deleteAudit.metadata).toBe(false);
  });
});

// ── Plan change: operator override + trial extension + free→cancel (#3427) ──

describe("PATCH /api/v1/admin/organizations/:id/plan — operator override precedence (#3427)", () => {
  it("stamps a plan-override window (default 90d) so the next webhook can't clobber the grant", async () => {
    const before = Date.now();
    const res = await app.fetch(
      adminRequest("PATCH", "/api/v1/admin/organizations/org-1/plan", { planTier: "pro" }),
    );

    expect(res.status).toBe(200);
    expect(mockUpdatePlanTier).toHaveBeenCalledTimes(1);
    const [orgId, tier, override] = mockUpdatePlanTier.mock.calls[0] as [string, string, { until: Date }];
    expect(orgId).toBe("org-1");
    expect(tier).toBe("pro");
    // A future override window was stamped (≈ 90 days out).
    expect(override).toHaveProperty("until");
    const ms = override.until.getTime() - before;
    expect(ms).toBeGreaterThan(89 * 86_400_000);
    expect(ms).toBeLessThan(91 * 86_400_000);
    const audit = auditCalls.find((a) => a.actionType === "workspace.change_plan");
    expect(audit?.metadata?.planOverrideUntil).toBe(override.until.toISOString());
  });

  it("clears the override (releases control to Stripe) when overrideDays is 0", async () => {
    const res = await app.fetch(
      adminRequest("PATCH", "/api/v1/admin/organizations/org-1/plan", { planTier: "starter", overrideDays: 0 }),
    );

    expect(res.status).toBe(200);
    const [, , override] = mockUpdatePlanTier.mock.calls[0] as [string, string, unknown];
    expect(override).toBe("clear");
    const audit = auditCalls.find((a) => a.actionType === "workspace.change_plan");
    expect(audit?.metadata?.planOverrideUntil).toBeNull();
  });

  it("rejects setting the 'trial' tier with no trialEndsAt (no stale reuse)", async () => {
    const res = await app.fetch(
      adminRequest("PATCH", "/api/v1/admin/organizations/org-1/plan", { planTier: "trial" }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("trialEndsAt");
    expect(mockUpdatePlanTier).not.toHaveBeenCalled();
  });

  it("rejects a trialEndsAt in the past", async () => {
    const res = await app.fetch(
      adminRequest("PATCH", "/api/v1/admin/organizations/org-1/plan", {
        planTier: "trial",
        trialEndsAt: new Date(Date.now() - 86_400_000).toISOString(),
      }),
    );

    expect(res.status).toBe(400);
    expect(mockUpdatePlanTier).not.toHaveBeenCalled();
  });

  it("extends a trial: wires setWorkspaceTrialEndsAt with an explicit future date", async () => {
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const res = await app.fetch(
      adminRequest("PATCH", "/api/v1/admin/organizations/org-1/plan", {
        planTier: "trial",
        trialEndsAt: future,
      }),
    );

    expect(res.status).toBe(200);
    // #3427 review: a trial grant must CLEAR the override (a trialing org has no
    // competing subscription; an override would only block the customer's own
    // paid conversion), not stamp a comp window.
    const [, tier, override] = mockUpdatePlanTier.mock.calls[0] as [string, string, unknown];
    expect(tier).toBe("trial");
    expect(override).toBe("clear");
    expect(mockSetTrialEndsAt).toHaveBeenCalledTimes(1);
    const [orgId, date] = mockSetTrialEndsAt.mock.calls[0] as [string, Date];
    expect(orgId).toBe("org-1");
    expect(date.toISOString()).toBe(future);
  });

  it("cancels Stripe subscriptions when downgrading a paying org to free", async () => {
    const res = await app.fetch(
      adminRequest("PATCH", "/api/v1/admin/organizations/org-1/plan", { planTier: "free" }),
    );

    expect(res.status).toBe(200);
    expect(mockCancelSubs).toHaveBeenCalledTimes(1);
    expect(mockCancelSubs.mock.calls[0][0]).toBe("org-1");
  });

  it("does NOT touch Stripe when moving to a paid tier", async () => {
    const res = await app.fetch(
      adminRequest("PATCH", "/api/v1/admin/organizations/org-1/plan", { planTier: "pro" }),
    );

    expect(res.status).toBe(200);
    expect(mockCancelSubs).not.toHaveBeenCalled();
  });
});
