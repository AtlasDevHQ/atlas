/**
 * Purge × SCIM decommission composition (#5515).
 *
 * Route-level tests that the GDPR purge handler composes with the 1.7
 * decommission LIFECYCLE instead of raw-SQL-ing past it: each of the
 * workspace's active SCIM connections is decommissioned through
 * `SCIMProvenance.deleteConnection` — which reconciles the users the
 * connection provisioned — BEFORE `hardDeleteWorkspace` runs its domain-keyed
 * scim* deletes (those are the completeness guarantee, exercised against a
 * real Postgres in `lib/db/__tests__/scim-purge-pg.test.ts`).
 *
 * The failure contract is the load-bearing half, and it is deliberately NOT
 * Stripe's: a Stripe teardown warning flips `complete` to false because data
 * SURVIVES remotely, while a decommission failure leaves nothing behind — the
 * purge transaction deletes every scim* row for the domain regardless. So a
 * decommission failure must surface as a `warnings` entry AND leave
 * `complete: true`, and above all must never abort the erasure.
 *
 * Harness: `createApiTestMocks` for the internal-DB surface, the EELayer
 * module mock for `SCIMProvenance` (the admin-scim.test.ts pattern), and a
 * shared `callOrder` to prove decommission-before-cascade the same way the
 * Stripe teardown suite proves its ordering.
 */

import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";
import { Effect } from "effect";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";
import type { StripeTeardownOutcome } from "@atlas/api/lib/billing/workspace-teardown";

// ── Mockable state ──────────────────────────────────────────────────

/** Cross-module call order — proves SCIM decommission runs before the cascade. */
let callOrder: string[] = [];

let workspaceStatus = "deleted";

const mockGetWorkspaceDetails = mock(async () => ({
  id: "org-1",
  name: "Acme",
  slug: "acme",
  workspace_status: workspaceStatus,
  plan_tier: "pro",
  byot: false,
  stripe_customer_id: "cus_acme",
  trial_ends_at: null,
  suspended_at: null,
  deleted_at: null,
  region: null,
  region_assigned_at: null,
  createdAt: "2026-01-01T00:00:00.000Z",
}));

const mockHardDelete = mock(async () => {
  callOrder.push("hardDelete");
  return {
    counts: {
      conversations: 3,
      scimUser: 2,
      scimManagedConnection: 1,
      organization: 1,
      adminActionLogAnonymized: 0,
    },
    skippedTables: [] as string[],
  };
});

const mocks = createApiTestMocks({
  internal: {
    getWorkspaceDetails: mockGetWorkspaceDetails,
    hardDeleteWorkspace: mockHardDelete,
  },
});

// ── SCIMProvenance via the EELayer mock (admin-scim.test.ts pattern) ─

/** Set per test: the connections the workspace owns, and failure switches. */
let scimConnections: Array<{ id: string; providerId: string; organizationId: string }> = [];
let listShouldFail = false;
let decommissionShouldFailFor: string | null = null;

const mockListConnections = mock((orgId: string) => {
  callOrder.push(`scim:list:${orgId}`);
  if (listShouldFail) return Effect.fail(new Error("catalog unreachable"));
  return Effect.succeed(scimConnections);
});
const mockDeleteConnection = mock((orgId: string, connectionId: string) => {
  callOrder.push(`scim:decommission:${connectionId}`);
  if (decommissionShouldFailFor === connectionId) {
    // The live implementation surfaces plugin failures as DEFECTS
    // (Effect.promise), so the failure mode under test is a defect, not a
    // typed error — the route's recovery must catch the whole Cause.
    return Effect.die(new Error(`decommission blew up for ${connectionId} in ${orgId}`));
  }
  return Effect.succeed(true);
});

void mock.module("@atlas/ee/layers", () => {
  // oxlint-disable-next-line @typescript-eslint/no-require-imports
  const { Layer, Effect: E } = require("effect") as typeof import("effect");
  return {
    EELayer: Layer.unwrapEffect(
      E.sync(() => {
        // oxlint-disable-next-line @typescript-eslint/no-require-imports
        const services = require("@atlas/api/lib/effect/services") as typeof import("@atlas/api/lib/effect/services");
        return Layer.succeed(services.SCIMProvenance, {
          available: true,
          listConnections: mockListConnections as never,
          deleteConnection: mockDeleteConnection as never,
          getSyncStatus: () => Effect.succeed({ connections: 0, provisionedUsers: 0, lastSyncAt: null }),
          createConnection: () => Effect.die(new Error("not under test")),
          rotateCredential: () => Effect.die(new Error("not under test")),
          listGroupMappings: () => Effect.succeed([]),
          createGroupMapping: () => Effect.die(new Error("not under test")),
          deleteGroupMapping: () => Effect.succeed(false),
          resolveGroupToRole: () => Effect.succeed(null),
        } as never);
      }),
    ),
  };
});

// ── Stripe teardown: quiet success, so warnings observed here are SCIM's ──

const teardownOutcome: StripeTeardownOutcome = { attempted: true, actions: [], warnings: [] };
// All exports mocked (testing.md's mock.module rule) — the extra two are
// inert pass-throughs no code path here reaches.
void mock.module("@atlas/api/lib/billing/workspace-teardown", () => ({
  cancelStripeSubscriptionsForWorkspace: mock(async () => teardownOutcome),
  purgeStripeBillingForWorkspace: mock(async () => {
    callOrder.push("stripe:purge");
    return teardownOutcome;
  }),
  pauseStripeCollectionForWorkspace: mock(async () => teardownOutcome),
  resumeStripeCollectionForWorkspace: mock(async () => teardownOutcome),
  enqueueStripeTeardownOps: mock(async () => 0),
  isStripeResourceMissing: () => false,
  stripeAuditMetadata: () => ({}),
  withWarnings: () => ({}),
}));

// The route imports errorMessage/causeToError from lib/audit/error-scrub
// DIRECTLY (not via this index), so the real scrub runs in these tests — the
// re-exports are mirrored here only to keep the module mock complete.
void mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: mock(() => {}),
  logAdminActionAwait: mock(async () => {}),
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  causeToError: (cause: unknown) => cause,
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

// Enterprise on, so the EELayer mock (rather than the Noop layer) provides
// SCIMProvenance. Module-load contract, same as admin-scim.test.ts.
process.env.ATLAS_ENTERPRISE_ENABLED ??= "true";

const { app } = await import("../index");

afterAll(() => mocks.cleanup());

function purgeRequest(): Request {
  return new Request("http://localhost/api/v1/platform/workspaces/org-1/purge", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
  });
}

beforeEach(() => {
  mocks.setPlatformAdmin();
  callOrder = [];
  workspaceStatus = "deleted";
  scimConnections = [
    { id: "mc-1", providerId: "ba_scim_connection_one", organizationId: "org-1" },
    { id: "mc-2", providerId: "ba_scim_connection_two", organizationId: "org-1" },
  ];
  listShouldFail = false;
  decommissionShouldFailFor = null;
  mockListConnections.mockClear();
  mockDeleteConnection.mockClear();
  mockHardDelete.mockClear();
});

describe("purge × SCIM decommission composition (#5515)", () => {
  it("decommissions every connection through the plugin lifecycle BEFORE the cascade", async () => {
    const res = await app.fetch(purgeRequest());
    expect(res.status).toBe(200);

    // Every connection, each through deleteConnection, all before hardDelete.
    expect(callOrder).toContain("scim:list:org-1");
    expect(callOrder).toContain("scim:decommission:mc-1");
    expect(callOrder).toContain("scim:decommission:mc-2");
    const hardDeleteAt = callOrder.indexOf("hardDelete");
    expect(hardDeleteAt).toBeGreaterThan(-1);
    for (const step of ["scim:list:org-1", "scim:decommission:mc-1", "scim:decommission:mc-2"]) {
      expect(
        callOrder.indexOf(step),
        `${step} must run BEFORE the purge cascade — the cascade deletes the rows the lifecycle reads`,
      ).toBeLessThan(hardDeleteAt);
    }

    const body = (await res.json()) as { complete: boolean; warnings?: string[] };
    expect(body.complete).toBe(true);
    expect(body.warnings).toBeUndefined();
  });

  it("a decommission DEFECT becomes a warning, the purge proceeds, and complete stays TRUE", async () => {
    // NOT Stripe's contract, on purpose: a billing warning means data survives
    // remotely, a decommission failure leaves nothing behind (the transaction
    // deletes every scim* row regardless) — so it must neither abort the
    // erasure nor un-finish it on the receipt.
    decommissionShouldFailFor = "mc-1";
    const res = await app.fetch(purgeRequest());
    expect(res.status).toBe(200);

    // The failing connection did not stop the second one, or the cascade.
    expect(callOrder).toContain("scim:decommission:mc-2");
    expect(callOrder).toContain("hardDelete");

    const body = (await res.json()) as { complete: boolean; warnings?: string[] };
    expect(body.complete).toBe(true);
    expect(body.warnings?.some((w) => w.includes("mc-1"))).toBe(true);
    expect(
      body.warnings?.some((w) => w.includes("still deleted by the purge transaction")),
      "the warning must say the rows were deleted anyway — it is operational, not an erasure qualifier",
    ).toBe(true);
  });

  it("a listConnections failure becomes a warning and the purge still runs", async () => {
    listShouldFail = true;
    const res = await app.fetch(purgeRequest());
    expect(res.status).toBe(200);
    expect(mockDeleteConnection.mock.calls.length).toBe(0);
    expect(callOrder).toContain("hardDelete");
    const body = (await res.json()) as { complete: boolean; warnings?: string[] };
    expect(body.complete).toBe(true);
    expect(body.warnings?.some((w) => w.includes("Could not list SCIM connections"))).toBe(true);
  });

  it("still refuses to purge a workspace that is not soft-deleted — SCIM is never consulted", async () => {
    // The composition must sit BEHIND the soft-delete gate: decommissioning a
    // live workspace's IdP connection on a refused purge would be real damage
    // from a request that reports 409.
    workspaceStatus = "active";
    const res = await app.fetch(purgeRequest());
    expect(res.status).toBe(409);
    expect(mockListConnections.mock.calls.length).toBe(0);
    expect(mockDeleteConnection.mock.calls.length).toBe(0);
    expect(mockHardDelete.mock.calls.length).toBe(0);
  });
});
