/**
 * Per-tier proactive entitlement gate (#4064 → re-tiered in #3999).
 *
 * Proactive is a **hosted-SaaS feature available to every paying plan**, not a
 * Business-tier differentiator (#3999). Two gates apply, in order, on every
 * proactive route:
 *
 *   1. the deployment-level availability gate (`ProactiveGate.requireEnabled` /
 *      `admin-proactive.ts`'s sync `gateProactiveAvailable`), which admits only
 *      `deployMode === "saas"` — proactive is denied on every self-hosted
 *      deployment, including self-hosted enterprise; and
 *   2. the per-tier ladder (`requireFeatureEntitlement(orgId, "proactive")`,
 *      SSOT minimum `trial`), which on SaaS admits every active paid plan and
 *      denies only the `free` floor and the churn (`locked`) tier.
 *
 * This file asserts gate (2)'s external behaviour at the API boundary for the
 * five proactive route surfaces — the four Effect `yield*` sub-routes
 * (analytics / events / pause / public-dataset) and `admin-proactive.ts`'s
 * `runHandler` path via the promise adapter `requireFeatureEntitlementOrThrow`:
 *
 *   - a `free` (the floor below `trial`) SaaS workspace is DENIED with the 403
 *     `plan_upgrade_required` upgrade envelope carrying `required_plan: "trial"`
 *     (covering both gate paths — the Effect `yield*` and the `runHandler`
 *     promise adapter map to the identical response);
 *   - a churned (`locked`) workspace is DENIED;
 *   - every active paid plan (`trial`/`starter`/`pro`/`business`) is ADMITTED
 *     past the ladder (never the upgrade 403);
 *   - an operator workspace bypasses the ladder;
 *   - a transient tier-lookup fault fails CLOSED with 503 `billing_check_failed`
 *     — asserted on BOTH a `yield*` route and the `runHandler` adapter route so
 *     the promise adapter's fail-closed arm is proven, not assumed;
 *   - the deployment-level availability gate is INDEPENDENT: with it closed,
 *     even an entitled paid workspace is denied (`enterprise_required`), proving
 *     the per-tier gate was added *alongside* the availability gate, not in
 *     place of it. The literal self-hosted-denied 403 is additionally covered by
 *     `admin-proactive-analytics.test.ts` / `admin-proactive.test.ts`.
 *
 * ## Why mock `@atlas/ee/layers`
 *
 * The proactive routes gate on `ProactiveGate.requireEnabled()` (the
 * deployment-level availability gate) BEFORE the per-tier check. `@atlas/ee/layers`
 * does not load in this harness, so the real `ProactiveGate` falls back to its
 * fail-closed Noop and 403s `enterprise_required` before the ladder is reached.
 * The mock below binds only `ProactiveGate` to a toggleable gate (open by
 * default — standing in for SaaS deploy mode; closed for the availability-gate
 * assertion) so the per-tier denial is observable. `admin-proactive.ts`'s sync
 * `gateProactiveAvailable` reads `resolveDeployMode()` instead of the Tag, so its
 * availability gate is driven by `ATLAS_DEPLOY_MODE` (pinned `saas` at module
 * top), independent of this mock. Mirrors `admin-proactive-analytics.test.ts`.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  createApiTestMocks,
  isFeatureEntitlementQuery,
  workspaceTierRows,
} from "@atlas/api/testing/api-test-mocks";

// Module-top env setup — must be set before the dynamic app import below. The
// per-tier ladder only fires in SaaS deploy mode; pin it (and enterprise-enabled,
// which `resolveDeployMode` requires for `saas`) so the gate tests are
// deterministic regardless of the ambient ATLAS_DEPLOY_MODE / DATABASE_URL.
// `??=` keeps the assignment hoisted; cross-file leakage under bun's parallel
// runner is bounded (the first file to load wins).
process.env.ATLAS_ENTERPRISE_ENABLED ??= "true";
process.env.ATLAS_DEPLOY_MODE ??= "saas";

// Toggleable availability gate for the proactive Effect routes' `ProactiveGate`
// Tag. Open (true) for the per-tier deny/allow assertions — standing in for SaaS
// deploy mode; flipped closed by the availability-gate-intact test. Reset in
// `beforeEach`.
let availabilityGateOpen = true;

// oxlint-disable-next-line @typescript-eslint/no-require-imports
const effectMod = require("effect") as typeof import("effect");
void mock.module("@atlas/ee/layers", () => {
  const { Layer } = effectMod;
  // oxlint-disable-next-line @typescript-eslint/no-require-imports
  const services = require("@atlas/api/lib/effect/services") as typeof import("@atlas/api/lib/effect/services");
  // oxlint-disable-next-line @typescript-eslint/no-require-imports
  const { EnterpriseError } = require("@atlas/api/lib/effect/errors") as typeof import("@atlas/api/lib/effect/errors");
  return {
    EELayer: Layer.succeed(services.ProactiveGate, {
      requireEnabled: () =>
        availabilityGateOpen
          ? effectMod.Effect.void
          : effectMod.Effect.fail(
              new EnterpriseError(
                "Proactive monitoring is available only on Atlas Cloud (the hosted SaaS).",
              ),
            ),
    }),
  };
});

const mocks = createApiTestMocks();

const { app } = await import("../index");

afterAll(() => mocks.cleanup());

// ── Request / mock helpers ──────────────────────────────────────────

function adminRequest(path: string, method = "GET", body?: unknown): Request {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, init);
}

function adminGet(path: string): Request {
  return adminRequest(path);
}

/** Make the entitlement lookup read back a specific tier / operator flag. */
function setWorkspaceTier(tier: string | null, isOperator = false): void {
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

// The five proactive route surfaces. `analytics`/`events`/`pause`/
// `public-dataset` gate via the Effect `yield* requireFeatureEntitlement`; the
// `workspace` route is the `runHandler` (sync) path gating via the promise
// adapter `requireFeatureEntitlementOrThrow`. All are side-effect-free GETs that
// reach the gate; the gate sits before any read so a denied tier 403s without
// touching the feature's data.
const PROACTIVE_ROUTES: Array<{ label: string; path: string }> = [
  { label: "analytics (Effect yield*)", path: "/api/v1/admin/proactive/analytics" },
  { label: "events (Effect yield*)", path: "/api/v1/admin/proactive/events" },
  { label: "pause status (Effect yield*)", path: "/api/v1/admin/proactive/pause" },
  {
    label: "public dataset (Effect yield*)",
    path: "/api/v1/admin/proactive/public-dataset",
  },
  {
    label: "workspace config (runHandler adapter)",
    path: "/api/v1/admin/proactive/workspace",
  },
];

// Every active paid/trial plan must reach proactive (#3999). Trial is the SSOT
// minimum (starter-equivalent, the lowest active SaaS tier). Mutable `string[]`
// so `it.each` accepts it (its overload rejects a `readonly` tuple).
const ADMITTED_TIERS: string[] = ["trial", "starter", "pro", "business"];

describe("per-tier proactive entitlement gate (#4064 / #3999 — all paid plans)", () => {
  beforeEach(() => {
    mocks.setOrgAdmin("org-1");
    mocks.hasInternalDB = true;
    mocks.mockInternalQuery.mockReset();
    availabilityGateOpen = true;
  });

  describe.each(PROACTIVE_ROUTES)("$label", ({ path }) => {
    it("denies a free-tier workspace with 403 plan_upgrade_required (the floor below trial)", async () => {
      setWorkspaceTier("free");
      const res = await app.fetch(adminGet(path));
      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        error: string;
        required_plan: string;
        current_plan: string;
      };
      expect(body.error).toBe("plan_upgrade_required");
      expect(body.required_plan).toBe("trial");
      expect(body.current_plan).toBe("free");
    });

    it("denies a churned (locked) workspace with 403 plan_upgrade_required", async () => {
      setWorkspaceTier("locked");
      const res = await app.fetch(adminGet(path));
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toBe("plan_upgrade_required");
    });

    it.each(ADMITTED_TIERS)(
      "admits an active %s workspace past the ladder",
      async (tier) => {
        setWorkspaceTier(tier);
        const res = await app.fetch(adminGet(path));
        // The per-tier gate passed: not the upgrade 403, nor the fail-closed 503.
        // Downstream the route may 200/500 against the mocked internal DB — that
        // is not the ladder's concern and is deliberately not pinned.
        const err = await errorOf(res);
        expect(err).not.toBe("plan_upgrade_required");
        expect(err).not.toBe("billing_check_failed");
      },
    );

    it("bypasses the ladder for an operator workspace", async () => {
      setWorkspaceTier("free", true);
      const res = await app.fetch(adminGet(path));
      const err = await errorOf(res);
      expect(err).not.toBe("plan_upgrade_required");
      expect(err).not.toBe("billing_check_failed");
    });
  });

  // A below-tier workspace must be denied on the MUTATING routes too — the gate
  // sits above each handler's side effect, so a denied write 403s rather than
  // mutating-then-403. This matters most for `admin-proactive.ts`'s `runHandler`
  // routes: the enforcement-parity scan's regex matches only
  // `requireFeatureEntitlement(...)`, NOT the `requireFeatureEntitlementOrThrow(...)`
  // adapter, so those gates are invisible to the drift guard — a test is their
  // ONLY safety net. Probe a mutating route on each of the two `runHandler`
  // surfaces plus a mutating Effect route, so dropping a gate is caught here.
  describe.each([
    {
      label: "pause kill-switch (Effect POST)",
      method: "POST",
      path: "/api/v1/admin/proactive/pause",
      body: undefined as unknown,
    },
    {
      label: "workspace update (runHandler PUT)",
      method: "PUT",
      path: "/api/v1/admin/proactive/workspace",
      body: { enabled: true } as unknown,
    },
    {
      label: "channel upsert (runHandler POST)",
      method: "POST",
      path: "/api/v1/admin/proactive/channels",
      body: { channelId: "C-test" } as unknown,
    },
  ])("mutating route — $label", ({ method, path, body }) => {
    it("denies a free-tier workspace with 403 plan_upgrade_required before any side effect", async () => {
      setWorkspaceTier("free");
      const res = await app.fetch(adminRequest(path, method, body));
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toBe("plan_upgrade_required");
    });

    it("admits an active paid (starter) workspace past the ladder", async () => {
      setWorkspaceTier("starter");
      const res = await app.fetch(adminRequest(path, method, body));
      const err = await errorOf(res);
      expect(err).not.toBe("plan_upgrade_required");
      expect(err).not.toBe("billing_check_failed");
    });
  });

  // Fail-closed is asserted on BOTH gate paths: the Effect `yield*` route and the
  // `runHandler` promise adapter (`requireFeatureEntitlementOrThrow`), so the
  // adapter's fail-closed arm is proven, not assumed — a transient internal-DB
  // fault must never silently widen access to a paid feature.
  describe.each([
    { label: "Effect yield* route", path: "/api/v1/admin/proactive/analytics" },
    {
      label: "runHandler adapter route",
      path: "/api/v1/admin/proactive/workspace",
    },
  ])("fail-closed on tier-lookup fault — $label", ({ path }) => {
    it("returns 503 billing_check_failed", async () => {
      failWorkspaceLookup();
      const res = await app.fetch(adminGet(path));
      expect(res.status).toBe(503);
      expect(await errorOf(res)).toBe("billing_check_failed");
    });
  });

  // The per-tier ladder was added ALONGSIDE the deployment-level availability
  // gate, not in place of it. With the availability gate closed (standing in for
  // a non-SaaS deployment), even an entitled paid workspace is denied with the
  // availability gate's `enterprise_required` 403 — proving the self-hosted
  // exclusion (#3999) is independent of the per-tier check.
  describe("deployment-level availability gate is independent of the ladder", () => {
    it("an entitled paid workspace is still denied when the availability gate is closed (Effect route)", async () => {
      availabilityGateOpen = false;
      setWorkspaceTier("business");
      const res = await app.fetch(
        adminGet("/api/v1/admin/proactive/analytics"),
      );
      expect(res.status).toBe(403);
      // The availability gate (`ProactiveGate.requireEnabled`) fires before the
      // per-tier check, so the denial is the availability gate's, not the ladder's.
      const err = await errorOf(res);
      expect(err).not.toBe("plan_upgrade_required");
    });
  });
});
