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
// The REAL class — `createApiTestMocks` re-exports it from the mocked `internal`
// module for exactly this reason, so the route's `instanceof` check in
// `classifyError` matches what a test throws (#5265).
import { PurgeAbortedError } from "@atlas/api/lib/db/internal";

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
let hardDeleteSkipped: string[] = [];
/**
 * Purge result. Deliberately carries the three field SHAPES the route has to
 * tell apart (#5160): plain deleted counts, the anonymized count (rows that
 * SURVIVED, so it must not enter `totalRows`), and `skippedTables` (not a count
 * at all). The anonymized count is 7 — a value no other field carries and one
 * no subset of the others sums to — so a total that wrongly includes it lands
 * on a number the correct arithmetic cannot produce.
 *
 * Since #5176 the third shape sits OUTSIDE `counts`, which is the container
 * split; the first two still share it, because both are numbers and only their
 * meaning differs.
 */
const mockHardDelete = mock(async () => {
  callOrder.push("hardDelete");
  return {
    counts: {
      conversations: 3,
      brainFacts: 5,
      subscriptions: 1,
      organization: 1,
      adminActionLogAnonymized: 7,
    },
    skippedTables: hardDeleteSkipped,
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

void mock.module("@atlas/api/lib/billing/workspace-teardown", () => ({
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

void mock.module("@atlas/api/lib/audit", () => ({
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

  // ── #5160: the response must not overstate what was destroyed ──
  // Nothing asserted the 200 body before this, so reverting `totalRows` to
  // `Object.values(purged).reduce(...)` — restoring the exact overstatement
  // #5160 was filed about, one metric layer down — passed every gate.

  it("EXCLUDES the anonymized count from totalRows", async () => {
    const res = await app.fetch(platformRequest("POST", "/api/v1/platform/workspaces/org-1/purge"));
    const body = (await res.json()) as {
      totalRows: number;
      adminActionLogAnonymized: number;
      purged: Record<string, number>;
      complete: boolean;
      skippedTables: string[];
    };

    expect(res.status).toBe(200);
    // 3 + 5 + 1 + 1 = 10 deleted. The 7 anonymized rows SURVIVED, so summing
    // them in would give 17 — that difference is the whole assertion.
    expect(body.totalRows).toBe(10);
    expect(body.adminActionLogAnonymized).toBe(7);
    expect(body.complete).toBe(true);
    expect(body.skippedTables).toEqual([]);

    // `purged` carries DELETION counts only. Both non-deletion fields are kept
    // out of it, so the obvious client-side sum agrees with `totalRows` instead
    // of over-reporting destruction — and so the published
    // `Record<string, number>` contract is not shipping a string array.
    expect(body.purged.adminActionLogAnonymized).toBeUndefined();
    expect(body.purged.skippedTables).toBeUndefined();
    expect(Object.values(body.purged).every((v) => typeof v === "number")).toBe(true);
    expect(Object.values(body.purged).reduce((a, b) => a + b, 0)).toBe(body.totalRows);
  });

  it("names both retained exceptions in the success message", async () => {
    // The message is a representation to an operator recording a GDPR erasure.
    // If it goes back to claiming everything was removed, that is the defect.
    const res = await app.fetch(platformRequest("POST", "/api/v1/platform/workspaces/org-1/purge"));
    const body = (await res.json()) as { message: string };

    expect(body.message).toContain("admin action log");
    expect(body.message).toContain("Stripe");
    expect(body.message).not.toContain("All data has been irreversibly removed");
  });

  it("reports INCOMPLETE when a relation was absent from this region", async () => {
    // A skipped table reports 0 rows, which reads exactly like "there were
    // none". The response has to distinguish them, because it is the artefact
    // an operator attaches to an erasure record.
    hardDeleteSkipped = ["scim_group_mappings", "subscription"];
    try {
      const res = await app.fetch(platformRequest("POST", "/api/v1/platform/workspaces/org-1/purge"));
      const body = (await res.json()) as {
        message: string;
        complete: boolean;
        skippedTables: string[];
      };

      expect(res.status).toBe(200);
      expect(body.complete).toBe(false);
      expect(body.skippedTables).toEqual(["scim_group_mappings", "subscription"]);
      expect(body.message).toContain("INCOMPLETE");
      expect(body.message).toContain("scim_group_mappings");
    } finally {
      hardDeleteSkipped = [];
    }
  });

  it("splits the #3468 tombstone WRITE from the skipped DELETEs", async () => {
    // ⚠️ THE FIXTURE IS THE POINT. `internal.ts` is the only producer of this
    // field, and its `subscription` probe records THREE names at once —
    // `tableExists("subscription", ["stripe_webhook_events",
    // PURGE_TOMBSTONE_RELATION])` — so the tombstone never arrives alone, and
    // the sibling test above uses a combination the producer cannot emit.
    //
    // The inversion this pins: calling an unwritten tombstone "data that was NOT
    // deleted" is backwards. The tombstone is a WRITE that did not happen, and
    // its absence means late `customer.subscription.deleted` webhooks can REGROW
    // ledger rows the purge did clear. An operator reading the old wording goes
    // hunting for surviving rows; the actual follow-up is the opposite.
    //
    // Measured before this test existed: reverting the whole split to the
    // pre-#5176 single sentence left this suite at 18/18 and platform-admin at
    // 17/17 — a correct compliance-receipt change that reverted for free.
    hardDeleteSkipped = ["subscription", "stripe_webhook_events", "stripe_purged_subscriptions"];
    try {
      const res = await app.fetch(platformRequest("POST", "/api/v1/platform/workspaces/org-1/purge"));
      const body = (await res.json()) as { message: string; complete: boolean };

      expect(res.status).toBe(200);
      expect(body.complete).toBe(false);
      // Two deletes, not three — the tombstone is not one of them.
      expect(body.message).toContain("2 delete(s) did not run");
      expect(body.message).toContain("(subscription, stripe_webhook_events)");
      // …and the write is reported with its own, different consequence.
      expect(body.message).toContain("tombstone was NOT written");
      expect(body.message).toContain("may regrow stripe_webhook_events rows");
      // The inversion itself, asserted negatively so a revert cannot pass: the
      // tombstone must never be counted among, or described as, deleted data.
      expect(body.message).not.toContain("3 delete(s)");
      expect(body.message).not.toMatch(/stripe_purged_subscriptions[^.]*NOT deleted/);
    } finally {
      hardDeleteSkipped = [];
    }
  });

  // ── #5265: an abort must reach the operator, not an opaque reference ──
  //
  // The half of #5265 no unit test can see: `PurgeAbortedError` only helps if the
  // ROUTE maps its code, and an unmapped code defaults to 500 — where
  // `classifyError` replaces the message with `Service error (ref: …)`, which is
  // the exact body the error class exists to escape. The mapping is compile-time
  // exhaustive over `PurgeAbortCode`, so what is left to check at runtime is that
  // 409 is the status and the message survives the bridge.

  it("answers 409 with the abort MESSAGE (not an opaque reference) and a requestId", async () => {
    const abortMessage =
      "Purge aborted on an unexpected database error (SQLSTATE 23502). The transaction rolled back, " +
      "so nothing was deleted and the organization row still exists — this endpoint can be re-run.";
    mockHardDelete.mockImplementationOnce(async () => {
      throw new PurgeAbortedError("purge_rolled_back", abortMessage);
    });

    const res = await app.fetch(platformRequest("POST", "/api/v1/platform/workspaces/org-1/purge"));
    const body = (await res.json()) as { error: string; message: string; requestId: string };

    expect(res.status).toBe(409);
    expect(body.error).toBe("purge_rolled_back");
    // The whole message, verbatim. `toContain` on a fragment would still pass if
    // the bridge swapped in the 5xx sanitizer's text around it.
    expect(body.message).toBe(abortMessage);
    expect(body.message).not.toContain("Service error (ref:");
    // Required on every error body — it is the only handle the operator has on
    // the pg error the message deliberately withholds.
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId.length).toBeGreaterThan(0);
  });

  it("keeps the region-drift and racing-admin codes on 409 too", async () => {
    // All three `PurgeAbortCode` members share the status, and each is checked
    // rather than inferred from the map: a wrong entry for one is invisible from
    // the others, and `region_schema_behind` is the one whose message names a
    // relation the operator has to go and migrate.
    for (const code of ["region_schema_behind", "not_soft_deleted"] as const) {
      mockHardDelete.mockImplementationOnce(async () => {
        throw new PurgeAbortedError(code, `abort:${code}`);
      });
      const res = await app.fetch(platformRequest("POST", "/api/v1/platform/workspaces/org-1/purge"));
      const body = (await res.json()) as { error: string; message: string };
      expect(res.status, `${code} must be a 409`).toBe(409);
      expect(body.error).toBe(code);
      expect(body.message).toBe(`abort:${code}`);
    }
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
    // #3427 review: a trial grant must CLEAR the override, never stamp a comp
    // window. A trialing org has no competing subscription, so an override would
    // only block the customer's own paid conversion (charged by Stripe, stranded
    // on trial). Pin that the directive is "clear", not a future `until`.
    const [, tier, override] = mockUpdatePlanTier.mock.calls[0] as [string, string, unknown];
    expect(tier).toBe("trial");
    expect(override).toBe("clear");
    expect(mockSetTrialEndsAt).toHaveBeenCalledTimes(1);
    const [orgId, date] = mockSetTrialEndsAt.mock.calls[0] as [string, Date];
    expect(orgId).toBe("org-1");
    expect(date.toISOString()).toBe(future);
  });

  it("clears the override even when overrideDays is explicitly passed for a trial", async () => {
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const res = await app.fetch(
      platformRequest("PATCH", "/api/v1/platform/workspaces/org-1/plan", {
        planTier: "trial",
        trialEndsAt: future,
        overrideDays: 90,
      }),
    );

    expect(res.status).toBe(200);
    const [, , override] = mockUpdatePlanTier.mock.calls[0] as [string, string, unknown];
    expect(override).toBe("clear");
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
