/**
 * Per-tier feature-entitlement gating for the access/governance admin
 * surfaces — SCIM, custom roles, and IP allowlist (WS1 #3987).
 *
 * #3986 established the keystone pattern and proved it end-to-end on the SSO
 * surface (`admin-sso.test.ts`). #3987 applies the same `requireFeatureEntitlement`
 * guard to the remaining access/governance routes; this suite proves the wiring
 * at the route/handler layer (not UI-only) for each feature:
 *
 *   - A below-Business workspace is DENIED with 403 `plan_upgrade_required`
 *     even though the deployment is enterprise-enabled (the EE policy Tag is
 *     live — SCIM/IP-allowlist with `available: true`, roles with a permissive
 *     `checkPermission`) — the per-tier ladder, not the license, produces the
 *     denial.
 *   - A Business workspace is ADMITTED and the request reaches the EE service.
 *   - An operator workspace bypasses the tier check regardless of plan.
 *   - A transient tier-lookup fault fails CLOSED with 503 — access is never
 *     silently widened to a Business feature.
 *
 * Each gated feature (`scim`, `custom_roles`, `ip_allowlist`) defaults to
 * Business in the `FEATURE_ENTITLEMENTS` SSOT, so the same matrix applies to
 * all three. The full tier×feature predicate matrix is unit-tested in
 * `lib/billing/__tests__/feature-entitlement-guard.test.ts`; this suite is the
 * route-level proof that the guard is actually consulted before each surface.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  mock,
} from "bun:test";
import { Effect } from "effect";
import {
  createApiTestMocks,
  isFeatureEntitlementQuery,
  workspaceTierRows,
} from "@atlas/api/testing/api-test-mocks";

// --- Unified mocks ---

const mocks = createApiTestMocks();

// --- Core error stubs — `EnterpriseLayer`'s no-op defaults lazy-require these. ---

mock.module("@atlas/api/lib/auth/auth-errors", () => ({
  IPAllowlistError: class extends Error { public readonly _tag = "IPAllowlistError" as const; },
  SSOError: class extends Error { public readonly _tag = "SSOError" as const; },
  SSOEnforcementError: class extends Error { public readonly _tag = "SSOEnforcementError" as const; },
  SCIMError: class extends Error { public readonly _tag = "SCIMError" as const; },
}));
mock.module("@atlas/api/lib/auth/roles-errors", () => ({
  RoleError: class extends Error { public readonly _tag = "RoleError" as const; },
}));
mock.module("@atlas/api/lib/residency/errors", () => ({
  ResidencyError: class extends Error { public readonly _tag = "ResidencyError" as const; },
}));
mock.module("@atlas/api/lib/compliance/errors", () => ({
  ComplianceError: class extends Error { public readonly _tag = "ComplianceError" as const; },
  ReportError: class extends Error { public readonly _tag = "ReportError" as const; },
}));
mock.module("@atlas/api/lib/model-routing/errors", () => ({
  ModelConfigError: class extends Error { public readonly _tag = "ModelConfigError" as const; },
  ModelConfigDecryptError: class extends Error { public readonly _tag = "ModelConfigDecryptError" as const; },
}));
mock.module("@atlas/api/lib/governance/errors", () => ({
  ApprovalError: class extends Error { public readonly _tag = "ApprovalError" as const; },
}));
mock.module("@atlas/api/lib/audit/retention-errors", () => ({
  RetentionError: class extends Error { public readonly _tag = "RetentionError" as const; },
}));

// --- Provide the three EE policies live via the EELayer Tag (SCIM + IP
// allowlist as `available: true`; roles via a permissive `checkPermission`). ---
// Mirrors admin-sso.test.ts: only the per-tier ladder changes the outcome — the
// enterprise-license Tag is live, so a denial here is purely the plan gate.
mock.module("@atlas/ee/layers", () => {
  // oxlint-disable-next-line @typescript-eslint/no-require-imports
  const { Layer, Effect: E } = require("effect") as typeof import("effect");
  return {
    EELayer: Layer.unwrapEffect(
      E.sync(() => {
        // oxlint-disable-next-line @typescript-eslint/no-require-imports
        const services = require("@atlas/api/lib/effect/services") as typeof import("@atlas/api/lib/effect/services");

        const scim = Layer.succeed(services.SCIMProvenance, {
          available: true,
          listConnections: () => Effect.succeed([]),
          deleteConnection: () => Effect.succeed(true),
          getSyncStatus: () =>
            Effect.succeed({ connections: 0, provisionedUsers: 0, lastSyncAt: null }),
          listGroupMappings: () => Effect.succeed([]),
          createGroupMapping: () => Effect.succeed({} as never),
          deleteGroupMapping: () => Effect.succeed(true),
          resolveGroupToRole: () => Effect.succeed(null),
        } as never);

        const roles = Layer.succeed(services.RolesPolicy, {
          // The `requirePermission("admin:roles")` middleware consults this —
          // return `null` (permitted) so the per-tier entitlement guard inside
          // the handler is what decides the outcome under test.
          checkPermission: () => Effect.succeed(null),
          listRoles: () => Effect.succeed([]),
          getRole: () => Effect.succeed(null),
          getRoleByName: () => Effect.succeed(null),
          createRole: () => Effect.succeed({} as never),
          updateRole: () => Effect.succeed({} as never),
          deleteRole: () => Effect.succeed(true),
          listRoleMembers: () => Effect.succeed([]),
          assignRole: () => Effect.succeed({} as never),
        } as never);

        const ipAllowlist = Layer.succeed(services.IpAllowlistPolicy, {
          available: true,
          checkIPAllowlist: () => Effect.succeed({ allowed: true }),
          listIPAllowlistEntries: () => Effect.succeed([]),
          addIPAllowlistEntry: () => Effect.succeed({} as never),
          removeIPAllowlistEntry: () => Effect.succeed(true),
          invalidateCache: () => {},
        } as never);

        return Layer.mergeAll(scim, roles, ipAllowlist);
      }),
    ),
  };
});

// The per-tier entitlement guard only fires in SaaS deploy mode. Pin it so the
// gate tests are deterministic regardless of ambient ATLAS_DEPLOY_MODE.
process.env.ATLAS_ENTERPRISE_ENABLED ??= "true";
process.env.ATLAS_DEPLOY_MODE ??= "saas";

// --- Import app after mocks ---

const { app } = await import("../index");

// --- Helpers ---

function adminRequest(urlPath: string, method = "GET", body?: unknown): Request {
  const opts: RequestInit = {
    method,
    headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  return new Request(`http://localhost${urlPath}`, opts);
}

/** Make the entitlement lookup read back a specific tier / operator flag. */
function setWorkspaceTier(tier: string | null, isOperator = false): void {
  mocks.mockInternalQuery.mockImplementation(async (sql: string) =>
    isFeatureEntitlementQuery(sql) ? workspaceTierRows(tier, isOperator) : [],
  );
}

afterAll(() => mocks.cleanup());

// Each feature: [label, a representative route+method, the GatedFeature key].
const FEATURES: Array<{ label: string; path: string; method: string }> = [
  { label: "SCIM provisioning", path: "/api/v1/admin/scim", method: "GET" },
  { label: "custom roles", path: "/api/v1/admin/roles", method: "GET" },
  { label: "IP allowlist", path: "/api/v1/admin/ip-allowlist", method: "GET" },
];

describe.each(FEATURES)(
  "$label — per-tier entitlement gate (#3987)",
  ({ path, method }) => {
    beforeEach(() => {
      mocks.setOrgAdmin("org-1");
      mocks.hasInternalDB = true;
      mocks.mockInternalQuery.mockReset();
    });

    it("denies a below-tier (Pro) workspace with 403 plan_upgrade_required", async () => {
      setWorkspaceTier("pro");
      const res = await app.fetch(adminRequest(path, method));
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

    it("denies a Starter workspace", async () => {
      setWorkspaceTier("starter");
      const res = await app.fetch(adminRequest(path, method));
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe(
        "plan_upgrade_required",
      );
    });

    it("collapses a null tier (row not found / legacy) to `free` and denies", async () => {
      setWorkspaceTier(null);
      const res = await app.fetch(adminRequest(path, method));
      expect(res.status).toBe(403);
      expect(((await res.json()) as { current_plan: string }).current_plan).toBe(
        "free",
      );
    });

    it("allows a Business workspace (gate passes through to the EE service)", async () => {
      setWorkspaceTier("business");
      const res = await app.fetch(adminRequest(path, method));
      expect(res.status).toBe(200);
    });

    it("allows an operator workspace regardless of tier", async () => {
      setWorkspaceTier("free", true);
      const res = await app.fetch(adminRequest(path, method));
      expect(res.status).toBe(200);
    });

    it("fails closed with 503 billing_check_failed when the tier lookup throws", async () => {
      // A transient internal-DB fault must NOT silently widen access to a
      // Business feature — the per-tier guard fails closed end-to-end.
      mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
        if (isFeatureEntitlementQuery(sql)) {
          throw new Error("db unavailable");
        }
        return [];
      });
      const res = await app.fetch(adminRequest(path, method));
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe(
        "billing_check_failed",
      );
    });
  },
);
