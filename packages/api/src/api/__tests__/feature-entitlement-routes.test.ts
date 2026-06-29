/**
 * Per-tier feature-entitlement route gates (WS1 of #3984 / #3988).
 *
 * #3986 wired `requireFeatureEntitlement` into the SSO routes and proved the
 * gate end-to-end. #3988 extends the same gate to the remaining compliance /
 * hosting tenant surfaces:
 *
 *   - audit-retention  (`audit_retention`, Business)
 *   - PII masking + compliance reports (`masking`, Business)
 *   - white-label branding (`white_label`, Business)
 *   - custom domain (`custom_domain`, Pro+)
 *   - data residency (`residency`, all paid tiers — trial floor)
 *
 * These assert the gate's external behavior at the API boundary: a below-tier
 * workspace is denied with the `plan_upgrade_required` upgrade envelope BEFORE
 * the route ever reaches the EE service; an at/above-tier workspace passes the
 * gate (so it never sees `plan_upgrade_required`); an operator workspace
 * bypasses the ladder; and a tier-lookup fault fails closed with 503. This is
 * the per-feature deny/allow proof the acceptance criteria require — modeled on
 * `admin-sso.test.ts`'s "per-tier entitlement gate" block.
 *
 * The gate fires before the EE Policy Tag is yielded, so the *deny* path is
 * fully observable without mocking each feature's EE service: a denied request
 * 403s with `plan_upgrade_required` regardless of the (Noop) EE layer. The
 * *allow* path is asserted as "not denied by the ladder" (status is not 403
 * `plan_upgrade_required`) — the downstream EE service is Noop here so it may
 * 404/403-enterprise, but crucially it is NOT the per-tier upgrade denial,
 * which proves the gate let the request through.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

const mocks = createApiTestMocks();

// Module-top env setup — must be set before the dynamic app import below.
// `??=` keeps the assignment hoisted; cross-file leakage under bun's parallel
// runner is bounded (the first file to load wins). The per-tier ladder only
// fires in SaaS deploy mode, so pin it so these gate tests are deterministic
// regardless of the ambient ATLAS_DEPLOY_MODE / DATABASE_URL.
process.env.ATLAS_ENTERPRISE_ENABLED ??= "true";
process.env.ATLAS_DEPLOY_MODE ??= "saas";

const { app } = await import("../index");

afterAll(() => mocks.cleanup());

function adminRequest(urlPath: string, method = "GET", body?: unknown): Request {
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  return new Request(`http://localhost${urlPath}`, opts);
}

/** Make the entitlement lookup read back a specific tier for the workspace. */
function setWorkspaceTier(tier: string, isOperator = false): void {
  mocks.mockInternalQuery.mockImplementation(async (sql: string) =>
    /plan_tier[\s\S]*is_operator_workspace|is_operator_workspace[\s\S]*plan_tier/.test(
      sql,
    )
      ? [{ plan_tier: tier, is_operator_workspace: isOperator }]
      : [],
  );
}

/** Make the tier lookup throw — the fail-closed (503) arm. */
function failWorkspaceLookup(): void {
  mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
    if (
      /plan_tier[\s\S]*is_operator_workspace|is_operator_workspace[\s\S]*plan_tier/.test(
        sql,
      )
    ) {
      throw new Error("db unavailable");
    }
    return [];
  });
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error?: string }).error ?? "";
}

/**
 * Each Business-gated tenant surface, with a side-effect-free GET probe and a
 * representative MUTATING route. The gate is wired identically across every
 * handler in the file (asserted structurally by the enforcement-parity guard);
 * probing both a read and a write per feature additionally pins that the gate
 * sits *before* the mutating handler's side effect — a below-tier write must be
 * denied (403) rather than mutating-then-403, which a GET-only probe + a
 * presence-only structural scan would both miss.
 */
const BUSINESS_FEATURES: Array<{
  feature: string;
  label: string;
  path: string;
  mutate: { method: string; path: string; body?: unknown };
}> = [
  {
    feature: "audit_retention",
    label: "audit-retention",
    path: "/api/v1/admin/audit/retention",
    mutate: { method: "POST", path: "/api/v1/admin/audit/retention/purge" },
  },
  {
    feature: "masking",
    label: "masking / compliance",
    path: "/api/v1/admin/compliance/classifications",
    mutate: {
      method: "DELETE",
      path: "/api/v1/admin/compliance/classifications/cls_1",
    },
  },
  {
    feature: "white_label",
    label: "white-label branding",
    path: "/api/v1/admin/branding",
    mutate: { method: "PUT", path: "/api/v1/admin/branding", body: { logoText: "Acme" } },
  },
  // NOTE: `residency` moved OUT of this Business-gated set — its SSOT minimum is
  // now `trial` (all paid tiers). It has its own all-paid block below.
];

describe("per-tier feature-entitlement route gates (#3988)", () => {
  beforeEach(() => {
    mocks.setOrgAdmin("org-1");
    mocks.hasInternalDB = true;
    mocks.mockInternalQuery.mockReset();
  });

  describe.each(BUSINESS_FEATURES)(
    "$label — Business-gated",
    ({ feature, path, mutate }) => {
      it(`denies a Pro workspace with 403 plan_upgrade_required (${feature})`, async () => {
        setWorkspaceTier("pro");
        const res = await app.fetch(adminRequest(path));
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

      it(`denies a Starter workspace (${feature})`, async () => {
        setWorkspaceTier("starter");
        const res = await app.fetch(adminRequest(path));
        expect(res.status).toBe(403);
        expect(await errorOf(res)).toBe("plan_upgrade_required");
      });

      it(`denies a below-tier workspace on the mutating ${mutate.method} route before any side effect (${feature})`, async () => {
        // The gate must sit ABOVE the mutating handler's side effect: a
        // below-tier write is denied with the ladder 403, never
        // mutate-then-403. A GET-only probe plus the presence-only
        // enforcement-parity scan would both miss a gate that ran after the
        // destructive call, so probe a real write per feature.
        setWorkspaceTier("pro");
        const res = await app.fetch(
          adminRequest(mutate.path, mutate.method, mutate.body),
        );
        expect(res.status).toBe(403);
        expect(await errorOf(res)).toBe("plan_upgrade_required");
      });

      it(`allows a Business workspace past the ladder (${feature})`, async () => {
        setWorkspaceTier("business");
        const res = await app.fetch(adminRequest(path));
        // The gate passed: the request is NOT denied with the per-tier upgrade
        // envelope. (Downstream the EE layer is Noop here, so the final status
        // may be a 404/enterprise response — but never the ladder's 403.)
        expect(await errorOf(res)).not.toBe("plan_upgrade_required");
      });

      it(`bypasses the ladder for an operator workspace (${feature})`, async () => {
        setWorkspaceTier("free", true);
        const res = await app.fetch(adminRequest(path));
        expect(await errorOf(res)).not.toBe("plan_upgrade_required");
      });

      it(`fails closed with 503 billing_check_failed when the tier lookup throws (${feature})`, async () => {
        // A transient internal-DB fault must NOT silently widen access to a
        // Business feature — the per-tier guard fails closed end-to-end.
        failWorkspaceLookup();
        const res = await app.fetch(adminRequest(path));
        expect(res.status).toBe(503);
        expect(await errorOf(res)).toBe("billing_check_failed");
      });
    },
  );

  // Custom domain is the one Pro+ override (#3988): denied below Pro, allowed at
  // Pro and Business. This proves the SSOT's non-Business minimum is enforced.
  describe("custom domain — Pro+ gated", () => {
    const path = "/api/v1/admin/domain";

    it("denies a Starter workspace with 403 plan_upgrade_required", async () => {
      setWorkspaceTier("starter");
      const res = await app.fetch(adminRequest(path));
      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        error: string;
        required_plan: string;
        current_plan: string;
      };
      expect(body.error).toBe("plan_upgrade_required");
      expect(body.required_plan).toBe("pro");
      expect(body.current_plan).toBe("starter");
    });

    it("denies a Free workspace", async () => {
      setWorkspaceTier("free");
      const res = await app.fetch(adminRequest(path));
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toBe("plan_upgrade_required");
    });

    it("allows a Pro workspace past the ladder (the override)", async () => {
      setWorkspaceTier("pro");
      const res = await app.fetch(adminRequest(path));
      expect(await errorOf(res)).not.toBe("plan_upgrade_required");
    });

    it("allows a Business workspace past the ladder", async () => {
      setWorkspaceTier("business");
      const res = await app.fetch(adminRequest(path));
      expect(await errorOf(res)).not.toBe("plan_upgrade_required");
    });

    it("fails closed with 503 when the tier lookup throws", async () => {
      failWorkspaceLookup();
      const res = await app.fetch(adminRequest(path));
      expect(res.status).toBe(503);
      expect(await errorOf(res)).toBe("billing_check_failed");
    });
  });

  // Data residency is the all-paid floor (residency = "trial"): region choice is
  // universal at signup, and the residency management surface is included at
  // every active paid tier. Denied only below trial (free / churned locked) —
  // mirrors proactive (#3999). Proves the SSOT's trial minimum is enforced.
  describe("data residency — all paid tiers", () => {
    const path = "/api/v1/admin/residency";

    it("denies a free-tier workspace with 403 plan_upgrade_required (the floor below trial)", async () => {
      setWorkspaceTier("free");
      const res = await app.fetch(adminRequest(path));
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
      const res = await app.fetch(adminRequest(path));
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toBe("plan_upgrade_required");
    });

    it.each(["trial", "starter", "pro", "business"])(
      "admits an active %s workspace past the ladder",
      async (tier) => {
        setWorkspaceTier(tier);
        const res = await app.fetch(adminRequest(path));
        const err = await errorOf(res);
        expect(err).not.toBe("plan_upgrade_required");
        expect(err).not.toBe("billing_check_failed");
      },
    );

    it("denies a free workspace on the mutating PUT before any side effect", async () => {
      setWorkspaceTier("free");
      const res = await app.fetch(
        adminRequest("/api/v1/admin/residency", "PUT", { region: "us-east" }),
      );
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toBe("plan_upgrade_required");
    });

    it("bypasses the ladder for an operator workspace", async () => {
      setWorkspaceTier("free", true);
      const res = await app.fetch(adminRequest(path));
      expect(await errorOf(res)).not.toBe("plan_upgrade_required");
    });

    it("fails closed with 503 billing_check_failed when the tier lookup throws", async () => {
      failWorkspaceLookup();
      const res = await app.fetch(adminRequest(path));
      expect(res.status).toBe(503);
      expect(await errorOf(res)).toBe("billing_check_failed");
    });

    // The residency router gates SIX endpoints on the same `residency`
    // entitlement, but the cases above only probe GET / and PUT /. The four
    // migration routes are the highest-stakes residency surface — opening region
    // migration to all paid tiers is this change's explicit design point — and
    // the enforcement-parity scan only proves the gate is consulted by AT LEAST
    // ONE call site, so a refactor dropping the `yield*` on a migration route
    // would slip past it. Probe each migration route at the boundary (mirrors the
    // proactive sibling's per-route describe.each). Bodies/params are valid so the
    // request reaches the in-handler gate rather than 400-ing on validation first.
    const MIGRATION_ROUTES: Array<{
      label: string;
      method: string;
      path: string;
      body?: unknown;
    }> = [
      { label: "GET /migration (status)", method: "GET", path: "/api/v1/admin/residency/migration" },
      {
        label: "POST /migrate (request migration)",
        method: "POST",
        path: "/api/v1/admin/residency/migrate",
        body: { targetRegion: "eu-west" },
      },
      { label: "POST /migrate/{id}/retry", method: "POST", path: "/api/v1/admin/residency/migrate/mig_1/retry" },
      { label: "POST /migrate/{id}/cancel", method: "POST", path: "/api/v1/admin/residency/migrate/mig_1/cancel" },
    ];

    it.each(MIGRATION_ROUTES)(
      "denies a free-tier workspace on $label before any side effect",
      async ({ method, path: routePath, body }) => {
        setWorkspaceTier("free");
        const res = await app.fetch(adminRequest(routePath, method, body));
        expect(res.status).toBe(403);
        expect(await errorOf(res)).toBe("plan_upgrade_required");
      },
    );

    it("admits an active starter workspace on POST /migrate — the all-tier migration trigger passes the ladder", async () => {
      setWorkspaceTier("starter");
      const res = await app.fetch(
        adminRequest("/api/v1/admin/residency/migrate", "POST", { targetRegion: "eu-west" }),
      );
      const err = await errorOf(res);
      expect(err).not.toBe("plan_upgrade_required");
      expect(err).not.toBe("billing_check_failed");
    });
  });
});
