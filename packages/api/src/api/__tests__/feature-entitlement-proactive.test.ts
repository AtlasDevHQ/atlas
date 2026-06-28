/**
 * Per-tier proactive entitlement gate (#4064 — AC1 of #3999).
 *
 * The `FeatureEntitlement` SSOT maps `proactive → "business"`, but until #4064
 * no route consulted it: on the hosted SaaS every tier could reach proactive
 * even though the pricing page sells it as Business-only. #4064 wired
 * `requireFeatureEntitlement(orgId, "proactive")` into the five proactive route
 * surfaces — the four Effect sub-routes (analytics / events / pause /
 * public-dataset) via `yield*`, and `admin-proactive.ts`'s `runHandler` path via
 * the promise adapter `requireFeatureEntitlementOrThrow`.
 *
 * This file asserts the gate's external behaviour at the API boundary for every
 * one of those five surfaces:
 *
 *   - a Starter / Pro SaaS workspace is DENIED with the 403 `plan_upgrade_required`
 *     upgrade envelope (covering both gate paths — the Effect `yield*` and the
 *     `runHandler` promise adapter map to the identical response);
 *   - a Business workspace is ADMITTED past the ladder (never the upgrade 403);
 *   - an operator workspace bypasses the ladder;
 *   - a transient tier-lookup fault fails CLOSED with 503 `billing_check_failed`
 *     — asserted on BOTH a `yield*` route and the `runHandler` adapter route so
 *     the promise adapter's fail-closed arm is proven, not assumed;
 *   - the deployment-level enterprise gate is UNCHANGED: with the EE proactive
 *     gate closed, even a Business workspace is denied `enterprise_required`, so
 *     the per-tier gate was added *alongside* the deployment gate, not in place
 *     of it (the free non-EE deployment exclusion is preserved). The literal
 *     self-hosted-disabled 403 is additionally covered by the existing
 *     `admin-proactive-analytics.test.ts` / `admin-proactive.test.ts`, which
 *     remain green (the per-tier guard is a no-op off-SaaS).
 *
 * ## Why mock `@atlas/ee/layers`
 *
 * The proactive routes gate on `ProactiveGate.requireEnabled()` (the
 * deployment-level enterprise gate) BEFORE the per-tier check. `@atlas/ee/layers`
 * does not load in this harness, so the real `ProactiveGate` falls back to its
 * fail-closed Noop and 403s `enterprise_required` before the ladder is reached.
 * The mock below binds only `ProactiveGate` to a toggleable gate (open by
 * default; closed for the deployment-gate-intact assertion) so the per-tier
 * denial is observable. `admin-proactive.ts` uses the synchronous
 * `isEnterpriseEnabled()` check instead of the Tag, so its enterprise gate is
 * driven by `ATLAS_ENTERPRISE_ENABLED` (pinned true at module top), independent
 * of this mock. Mirrors `admin-proactive-analytics.test.ts`.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  createApiTestMocks,
  isFeatureEntitlementQuery,
  workspaceTierRows,
} from "@atlas/api/testing/api-test-mocks";

// Module-top env setup — must be set before the dynamic app import below. The
// per-tier ladder only fires in SaaS deploy mode; pin it (and enterprise-enabled,
// which `admin-proactive.ts`'s sync gate reads) so the gate tests are
// deterministic regardless of the ambient ATLAS_DEPLOY_MODE / DATABASE_URL.
// `??=` keeps the assignment hoisted; cross-file leakage under bun's parallel
// runner is bounded (the first file to load wins).
process.env.ATLAS_ENTERPRISE_ENABLED ??= "true";
process.env.ATLAS_DEPLOY_MODE ??= "saas";

// Toggleable enterprise gate for the proactive Effect routes' `ProactiveGate`
// Tag. Open (true) for the per-tier deny/allow assertions; flipped closed by the
// deployment-gate-intact test. Reset in `beforeEach`.
let enterpriseGateOpen = true;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const effectMod = require("effect") as typeof import("effect");
mock.module("@atlas/ee/layers", () => {
  const { Layer } = effectMod;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const services = require("@atlas/api/lib/effect/services") as typeof import("@atlas/api/lib/effect/services");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EnterpriseError } = require("@atlas/api/lib/effect/errors") as typeof import("@atlas/api/lib/effect/errors");
  return {
    EELayer: Layer.succeed(services.ProactiveGate, {
      requireEnabled: () =>
        enterpriseGateOpen
          ? effectMod.Effect.void
          : effectMod.Effect.fail(
              new EnterpriseError(
                "Enterprise features (proactive-chat) are not enabled.",
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

describe("per-tier proactive entitlement gate (#4064)", () => {
  beforeEach(() => {
    mocks.setOrgAdmin("org-1");
    mocks.hasInternalDB = true;
    mocks.mockInternalQuery.mockReset();
    enterpriseGateOpen = true;
  });

  describe.each(PROACTIVE_ROUTES)("$label", ({ path }) => {
    it("denies a Pro workspace with 403 plan_upgrade_required", async () => {
      setWorkspaceTier("pro");
      const res = await app.fetch(adminGet(path));
      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        error: string;
        required_plan: string;
        current_plan: string;
      };
      expect(body.error).toBe("plan_upgrade_required");
      expect(body.required_plan).toBe("business");
      expect(body.current_plan).toBe("pro");
    });

    it("denies a Starter workspace with 403 plan_upgrade_required", async () => {
      setWorkspaceTier("starter");
      const res = await app.fetch(adminGet(path));
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toBe("plan_upgrade_required");
    });

    it("admits a Business workspace past the ladder", async () => {
      setWorkspaceTier("business");
      const res = await app.fetch(adminGet(path));
      // The per-tier gate passed: not the upgrade 403, nor the fail-closed 503.
      // Downstream the route may 200/500 against the mocked internal DB — that
      // is not the ladder's concern and is deliberately not pinned.
      const err = await errorOf(res);
      expect(err).not.toBe("plan_upgrade_required");
      expect(err).not.toBe("billing_check_failed");
    });

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
    it("denies a Pro workspace with 403 plan_upgrade_required before any side effect", async () => {
      setWorkspaceTier("pro");
      const res = await app.fetch(adminRequest(path, method, body));
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toBe("plan_upgrade_required");
    });

    it("admits a Business workspace past the ladder", async () => {
      setWorkspaceTier("business");
      const res = await app.fetch(adminRequest(path, method, body));
      const err = await errorOf(res);
      expect(err).not.toBe("plan_upgrade_required");
      expect(err).not.toBe("billing_check_failed");
    });
  });

  // Fail-closed is asserted on BOTH gate paths: the Effect `yield*` route and the
  // `runHandler` promise adapter (`requireFeatureEntitlementOrThrow`), so the
  // adapter's fail-closed arm is proven, not assumed — a transient internal-DB
  // fault must never silently widen access to a Business feature.
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

  // The per-tier gate was added ALONGSIDE the deployment-level enterprise gate,
  // not in place of it. With the EE proactive gate closed, even a Business-tier
  // workspace is denied with the deployment gate's `enterprise_required` 403 —
  // proving the free non-EE deployment exclusion is unchanged by #4064.
  describe("deployment-level enterprise gate is unchanged", () => {
    it("a Business workspace is still denied when the EE proactive gate is closed (Effect route)", async () => {
      enterpriseGateOpen = false;
      setWorkspaceTier("business");
      const res = await app.fetch(
        adminGet("/api/v1/admin/proactive/analytics"),
      );
      expect(res.status).toBe(403);
      // The enterprise gate (`ProactiveGate.requireEnabled`) fires before the
      // per-tier check, so the denial is the deployment gate's, not the ladder's.
      const err = await errorOf(res);
      expect(err).not.toBe("plan_upgrade_required");
    });
  });
});
