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

const mocks = createApiTestMocks({
  internal: {
    getWorkspaceDetails: mockGetWorkspaceDetails,
    updateWorkspaceStatus: mockUpdateWorkspaceStatus,
    cascadeWorkspaceDelete: mockCascade,
    hardDeleteWorkspace: mockHardDelete,
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

function platformRequest(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
  });
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
