/**
 * WS1 per-tier feature-ladder regression net (WS3 of #3984 / #4002).
 *
 * #3986/#3987/#3988 wired `requireFeatureEntitlement` into each premium surface
 * and proved every gate end-to-end in its own slice's test file. This file is
 * the **consolidated, SSOT-driven regression net** the parent PRD asks for: a
 * single place that proves the *whole* per-tier ladder and — crucially — stays
 * exhaustive by construction, so the ladder can never silently drift open as the
 * SSOT grows.
 *
 * For every gated capability that has a per-tenant route gate today (the
 * deferred set is enumerated below) it asserts, at the API/route layer (not
 * UI-only, per PRD WS1 user story 29):
 *
 *   - a below-minimum-tier workspace is DENIED with 403 `plan_upgrade_required`
 *     carrying the correct `required_plan` / `current_plan` (proven for a real
 *     paying tier just under the minimum, for the `free` floor, and for a
 *     missing/legacy `null` tier that collapses to `free`);
 *   - an at/above-minimum-tier workspace is ADMITTED past the ladder (never sees
 *     `plan_upgrade_required`);
 *   - an operator workspace bypasses the ladder regardless of tier;
 *   - a transient tier-lookup fault fails CLOSED with 503 `billing_check_failed`,
 *     never silently widening access.
 *
 * ## Why the allow path asserts "not the ladder's 403" rather than 200
 *
 * The per-tier gate fires *before* the feature's EE Policy Tag is yielded, so the
 * DENY path is fully observable without standing up each feature's EE service.
 * The ALLOW path is asserted as "the per-tier ladder did not deny it" — the
 * status is NOT 403 `plan_upgrade_required` — nor the gate's *other* failure
 * mode, a 503 `billing_check_failed` fail-closed (a vacuity guard so an entitled
 * tier wrongly failing closed can't pass as "admitted"). Downstream the EE
 * service is the real or Noop layer (depending on whether `@atlas/ee/layers`
 * loads in the test env), so the final response may be a 200, a 404, the
 * deployment-level `enterprise_required` 403, or a Noop-fallback 5xx — none of
 * which is the gate's concern and all of which are env-dependent, so they are
 * deliberately not pinned. What matters is neither *ladder* denial fired: tier
 * admits the request; the enterprise license (a separate axis) gates what
 * happens next. This mirrors the documented pattern in
 * `feature-entitlement-routes.test.ts`.
 *
 * ## Drift-proofing (the "net" part)
 *
 * {@link LADDER_ROUTES} is typed `Record<GatedFeature, RouteProbe | null>`, so
 * adding a member to the SSOT's `GatedFeature` union is a COMPILE error until it
 * is given either a route probe (gated → exercised here) or an explicit `null`
 * (deferred). The completeness suite then enforces at runtime that every `null`
 * is recorded in {@link ENFORCEMENT_PENDING} and every probed feature is NOT —
 * so a new premium feature cannot land without either a deny/allow proof in this
 * net or a tracked deferral. The ladder can't drift open silently.
 *
 * ## Deferred (not regressions — tracked in ENFORCEMENT_PENDING)
 *
 *   - `backups`: its only route surface is operator/platform-scoped
 *     (`platform-backups.ts`, no per-tenant `orgId`), so a per-tier
 *     `requireFeatureEntitlement` gate is structurally inapplicable today. Gated
 *     by the enterprise-license Tag (`backups.available`) instead.
 *
 * `proactive` was deferred here while #3999/#4064 was open; #4064 wired its
 * per-tier gate, so it is now a probed feature below (no longer in
 * ENFORCEMENT_PENDING). Its proactive routes gate on
 * `ProactiveGate.requireEnabled()` (the deployment-level enterprise gate)
 * *before* the per-tier check, and `@atlas/ee/layers` doesn't load in this
 * harness — so the real ProactiveGate falls back to its fail-closed Noop and
 * 403s `enterprise_required` before the ladder is reached. The mock below binds
 * only ProactiveGate to an always-enabled gate (every other enterprise Tag
 * keeps its Noop default, leaving the other probed features unchanged) so the
 * per-tier denial is observable, mirroring `admin-proactive-analytics.test.ts`.
 */

import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";
import type { PlanTier, PlanUpgradeRequiredBody } from "@useatlas/types";
import {
  createApiTestMocks,
  isFeatureEntitlementQuery,
  workspaceTierRows,
} from "@atlas/api/testing/api-test-mocks";
import {
  FEATURE_ENTITLEMENTS,
  type GatedFeature,
} from "@atlas/api/lib/billing/feature-entitlement";
import { ENFORCEMENT_PENDING } from "@atlas/api/lib/billing/enforcement-parity";
import { PLAN_RANK } from "@atlas/api/lib/integrations/install/plan-rank";

const mocks = createApiTestMocks();

// Module-top env setup — must be set before the dynamic app import below.
// The per-tier ladder only fires in SaaS deploy mode, which `resolveDeployMode`
// resolves to only when enterprise is enabled; pin both so the gate tests are
// deterministic regardless of the ambient ATLAS_DEPLOY_MODE / DATABASE_URL.
// `??=` keeps the assignment hoisted; cross-file leakage under bun's parallel
// runner is bounded (the first file to load wins).
process.env.ATLAS_ENTERPRISE_ENABLED ??= "true";
process.env.ATLAS_DEPLOY_MODE ??= "saas";

// Bind only ProactiveGate to an always-enabled gate so the proactive probe's
// per-tier denial (which sits *after* `ProactiveGate.requireEnabled()`) is
// observable; every other enterprise Tag falls through to its Noop default, so
// the other probed features behave exactly as they did with no EE layer loaded.
// `mock.module` factories must be sync (CLAUDE.md). See the file docstring.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const effectMod = require("effect") as typeof import("effect");
mock.module("@atlas/ee/layers", () => {
  const { Layer } = effectMod;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const services = require("@atlas/api/lib/effect/services") as typeof import("@atlas/api/lib/effect/services");
  return {
    EELayer: Layer.succeed(services.ProactiveGate, {
      requireEnabled: () => effectMod.Effect.void,
    }),
  };
});

const { app } = await import("../index");

afterAll(() => mocks.cleanup());

// ── The ladder map ──────────────────────────────────────────────────

interface RouteProbe {
  /** Human label for test names. */
  readonly label: string;
  /** A side-effect-free GET that triggers the feature's entitlement gate. */
  readonly path: string;
}

/**
 * Every {@link GatedFeature} → a route probe (gated, exercised below) or `null`
 * (deferred; must be recorded in {@link ENFORCEMENT_PENDING}). The
 * `Record<GatedFeature, …>` annotation makes a newly-added SSOT feature a
 * compile error here until it is classified — the net cannot silently omit it.
 */
const LADDER_ROUTES: Readonly<Record<GatedFeature, RouteProbe | null>> = {
  sso: { label: "SSO", path: "/api/v1/admin/sso/providers" },
  scim: { label: "SCIM provisioning", path: "/api/v1/admin/scim" },
  custom_roles: { label: "custom roles", path: "/api/v1/admin/roles" },
  ip_allowlist: { label: "IP allowlist", path: "/api/v1/admin/ip-allowlist" },
  approvals: {
    label: "approval workflows",
    path: "/api/v1/admin/approval/queue",
  },
  audit_retention: {
    label: "audit retention",
    path: "/api/v1/admin/audit/retention",
  },
  masking: {
    label: "PII masking / compliance",
    path: "/api/v1/admin/compliance/classifications",
  },
  white_label: { label: "white-label branding", path: "/api/v1/admin/branding" },
  residency: { label: "data residency", path: "/api/v1/admin/residency" },
  custom_domain: { label: "custom domain", path: "/api/v1/admin/domain" },
  proactive: {
    label: "proactive monitoring",
    // Read-only analytics GET — triggers the per-tier gate (after the
    // enterprise-gate, which the EELayer mock above forces open). #4064.
    path: "/api/v1/admin/proactive/analytics",
  },
  // ── Deferred — no per-tenant route gate yet (see ENFORCEMENT_PENDING) ──
  backups: null, // platform-scoped surface only (#3984)
};

// ── Tier helpers (derived from the SSOT ordering) ───────────────────

/** Recognized non-`locked` tiers ranked strictly below `min`, highest first. */
function belowTiersFor(min: PlanTier): PlanTier[] {
  return (Object.keys(PLAN_RANK) as PlanTier[])
    .filter((t) => t !== "locked" && PLAN_RANK[t] < PLAN_RANK[min])
    .sort((a, b) => PLAN_RANK[b] - PLAN_RANK[a]);
}

/** Recognized tiers ranked at or above `min`, lowest first. */
function atOrAboveTiersFor(min: PlanTier): PlanTier[] {
  return (Object.keys(PLAN_RANK) as PlanTier[])
    .filter((t) => t !== "locked" && PLAN_RANK[t] >= PLAN_RANK[min])
    .sort((a, b) => PLAN_RANK[a] - PLAN_RANK[b]);
}

/** The gated (non-deferred) features, each with its SSOT minimum tier. */
const PROBED = (
  Object.entries(LADDER_ROUTES) as Array<[GatedFeature, RouteProbe | null]>
)
  .filter((entry): entry is [GatedFeature, RouteProbe] => entry[1] !== null)
  .map(([feature, probe]) => ({
    feature,
    ...probe,
    min: FEATURE_ENTITLEMENTS[feature],
  }));

// ── Request / mock helpers ──────────────────────────────────────────

function adminGet(path: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: {
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    },
  });
}

/** Make the entitlement lookup read back a specific tier / operator flag. */
function setWorkspaceTier(tier: PlanTier | null, isOperator = false): void {
  mocks.mockInternalQuery.mockImplementation(async (sql: string) =>
    isFeatureEntitlementQuery(sql) ? workspaceTierRows(tier, isOperator) : [],
  );
}

/** Make the tier lookup throw — the fail-closed (503) arm. */
function failWorkspaceLookup(): void {
  mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
    if (isFeatureEntitlementQuery(sql)) throw new Error("db unavailable");
    return [];
  });
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error?: string }).error ?? "";
}

// ── Per-feature deny / allow proof ──────────────────────────────────

describe.each(PROBED)(
  "$label — per-tier ladder gate ($feature)",
  ({ path, min }) => {
    const belowTiers = belowTiersFor(min);
    const allowTiers = atOrAboveTiersFor(min);
    // The highest paying tier still below the minimum. Always present — every
    // gated minimum is `pro`/`business`, asserted in the completeness suite.
    const closestBelow = belowTiers[0];

    beforeEach(() => {
      mocks.setOrgAdmin("org-1");
      mocks.hasInternalDB = true;
      mocks.mockInternalQuery.mockReset();
    });

    it(`denies the closest below-tier (${closestBelow}) with 403 plan_upgrade_required`, async () => {
      setWorkspaceTier(closestBelow);
      const res = await app.fetch(adminGet(path));
      expect(res.status).toBe(403);
      const body = (await res.json()) as PlanUpgradeRequiredBody;
      expect(body.error).toBe("plan_upgrade_required");
      expect(body.required_plan).toBe(min);
      expect(body.current_plan).toBe(closestBelow);
    });

    it("denies a free-tier workspace (the floor)", async () => {
      setWorkspaceTier("free");
      const res = await app.fetch(adminGet(path));
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toBe("plan_upgrade_required");
    });

    it("denies a missing/legacy null tier, collapsing current_plan to free", async () => {
      setWorkspaceTier(null);
      const res = await app.fetch(adminGet(path));
      expect(res.status).toBe(403);
      const body = (await res.json()) as PlanUpgradeRequiredBody;
      expect(body.error).toBe("plan_upgrade_required");
      expect(body.current_plan).toBe("free");
    });

    it.each(allowTiers)(
      "admits an at/above-tier (%s) workspace past the ladder",
      async (tier) => {
        setWorkspaceTier(tier);
        const res = await app.fetch(adminGet(path));
        // The gate admitted the request: neither of its two denial envelopes
        // fired. Asserting "not `billing_check_failed`" (the fail-closed arm)
        // alongside "not `plan_upgrade_required`" stops an erroneous fail-closed
        // on an entitled tier from passing vacuously. The downstream EE response
        // (real or Noop) is env-dependent and deliberately not pinned.
        const err = await errorOf(res);
        expect(err).not.toBe("plan_upgrade_required");
        expect(err).not.toBe("billing_check_failed");
      },
    );

    it("bypasses the ladder for an operator workspace regardless of tier", async () => {
      setWorkspaceTier("free", true);
      const res = await app.fetch(adminGet(path));
      const err = await errorOf(res);
      expect(err).not.toBe("plan_upgrade_required");
      expect(err).not.toBe("billing_check_failed");
    });

    it("fails closed with 503 billing_check_failed when the tier lookup throws", async () => {
      // A transient internal-DB fault must NOT silently widen access to a paid
      // feature — the per-tier guard fails closed end-to-end.
      failWorkspaceLookup();
      const res = await app.fetch(adminGet(path));
      expect(res.status).toBe(503);
      expect(await errorOf(res)).toBe("billing_check_failed");
    });
  },
);

// ── Completeness: the net cannot drift open ─────────────────────────

describe("feature-ladder regression net — completeness", () => {
  const ssotFeatures = Object.keys(FEATURE_ENTITLEMENTS) as GatedFeature[];
  const deferred = ssotFeatures.filter((f) => LADDER_ROUTES[f] === null);
  const probed = PROBED.map((p) => p.feature);

  it("partitions every SSOT feature into exactly one of {gated-probe, deferred}", () => {
    // No SSOT feature is unclassified; none is both probed and deferred.
    for (const f of ssotFeatures) {
      const isProbed = probed.includes(f);
      const isDeferred = deferred.includes(f);
      expect(isProbed !== isDeferred).toBe(true); // exclusive-or
    }
    expect(probed.length + deferred.length).toBe(ssotFeatures.length);
    expect(probed.length).toBeGreaterThan(0);
  });

  it("records every deferred feature in ENFORCEMENT_PENDING (deferral is tracked, not forgotten)", () => {
    for (const f of deferred) {
      expect(
        Object.prototype.hasOwnProperty.call(ENFORCEMENT_PENDING, f),
      ).toBe(true);
    }
  });

  it("does not list any gated (probed) feature in ENFORCEMENT_PENDING (stale-pending guard)", () => {
    for (const f of probed) {
      expect(
        Object.prototype.hasOwnProperty.call(ENFORCEMENT_PENDING, f),
      ).toBe(false);
    }
  });

  it("gates proactive per-tier (#4064) — probed, not deferred, not pending", () => {
    // #4064 wired `requireFeatureEntitlement(orgId, "proactive")`, so proactive
    // is now a probed feature exercised by the matrix above and must NOT linger
    // in ENFORCEMENT_PENDING (the stale-pending guard would otherwise fire).
    expect(LADDER_ROUTES.proactive).not.toBeNull();
    expect(ENFORCEMENT_PENDING.proactive).toBeUndefined();
  });

  it("keeps each probe's below/allow tiers consistent with the SSOT minimum", () => {
    for (const { feature, min } of PROBED) {
      expect(FEATURE_ENTITLEMENTS[feature]).toBe(min);
      expect(belowTiersFor(min).length).toBeGreaterThan(0); // a deny is provable
      expect(atOrAboveTiersFor(min)).toContain(min); // an allow is provable
    }
  });
});
