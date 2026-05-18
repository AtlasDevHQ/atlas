/**
 * Test helper for `mock.module("@atlas/api/lib/effect/enterprise-layer", ...)`.
 *
 * Across slices 5–9 of milestone 1.5.1, every test that exercised an
 * EE-Tag-bound route hand-rolled a Layer.mergeAll over `RolesPolicy`,
 * `IpAllowlistPolicy`, `SSOPolicy`, and `SCIMProvenance` (the four Tags
 * the auth middleware chain yields), plus its own `runEnterprise` /
 * `getEnterpriseRuntime` shim. The closeout cleanup (#2594) widened the
 * shim — and the per-test copies began drifting. This helper
 * centralises the pattern so:
 *
 *   1. Adding a new middleware-yielded Tag means one default here; every
 *      existing test picks it up automatically — no more "test passes
 *      locally because nobody else yields that Tag, then breaks the
 *      moment auth middleware does."
 *   2. The runtime exports surface (`EnterpriseLayer`, `runEnterprise`,
 *      `runEnterpriseExit`, `getEnterpriseRuntime`,
 *      `__resetEnterpriseRuntimeForTesting`) is built in one place — when
 *      the production module grows another export, this helper grows in
 *      lockstep.
 *   3. The defensive `try/catch` for "Service not found" in
 *      `api/routes/middleware.ts` can be deleted: every test that mocks
 *      the EnterpriseLayer now binds the full middleware Tag set.
 *
 * Tests that need to override a non-middleware Tag (e.g. `AuditRetention`,
 * `Branding`) pass a fully-built `Layer.succeed(Tag, shape)` in
 * `extraLayers` — these don't need helper-side defaults because the
 * route under test always provides its own.
 *
 * @example
 * ```ts
 * mock.module("@atlas/api/lib/effect/enterprise-layer", () =>
 *   makeTestEnterpriseLayer({
 *     RolesPolicy: {
 *       checkPermission: mockCheckPermission as never,
 *       listRoles: mockListRoles as never,
 *     },
 *   }),
 * );
 * ```
 */

import { Effect, Layer, ManagedRuntime } from "effect";
import {
  IpAllowlistPolicy,
  RolesPolicy,
  SCIMProvenance,
  SSOPolicy,
  type IpAllowlistPolicyShape,
  type RolesPolicyShape,
  type SCIMProvenanceShape,
  type SSOPolicyShape,
} from "@atlas/api/lib/effect/services";

// ── Test-friendly defaults for the four middleware Tags ─────────────
//
// "Test-friendly" means happy-path: EE-loaded, allow-all auth checks,
// empty CRUD reads. Destructive writes (`createRole`, `setSSOEnforcement`,
// etc.) intentionally `Effect.die` so a test that exercises a write path
// without overriding the method fails loudly — a silent success would
// mask the test gap.

const rolesDefaults: RolesPolicyShape = {
  customRolesActive: true,
  checkPermission: () => Effect.succeed(null),
  listRoles: () => Effect.succeed([]),
  getRole: () => Effect.succeed(null),
  getRoleByName: () => Effect.succeed(null),
  createRole: () => Effect.die(new Error("test: RolesPolicy.createRole not mocked")),
  updateRole: () => Effect.die(new Error("test: RolesPolicy.updateRole not mocked")),
  deleteRole: () => Effect.succeed(true),
  listRoleMembers: () => Effect.succeed([]),
  assignRole: () => Effect.die(new Error("test: RolesPolicy.assignRole not mocked")),
};

const ipAllowlistDefaults: IpAllowlistPolicyShape = {
  available: false,
  checkIPAllowlist: () => Effect.succeed({ allowed: true }),
  listIPAllowlistEntries: () => Effect.succeed([]),
  addIPAllowlistEntry: () =>
    Effect.die(new Error("test: IpAllowlistPolicy.addIPAllowlistEntry not mocked")),
  removeIPAllowlistEntry: () => Effect.succeed(true),
  invalidateCache: () => {},
};

const ssoDefaults: SSOPolicyShape = {
  available: false,
  // Mirror the production `extractEmailDomain` pure-helper exactly —
  // middleware compares the returned domain against the SSO provider
  // map, and a divergent stub silently misses the enforcement path.
  extractEmailDomain: (email: string) => {
    const at = email.lastIndexOf("@");
    return at > 0 ? email.slice(at + 1).toLowerCase() : null;
  },
  isSSOEnforcedForDomain: () => Effect.succeed({ enforced: false }),
  isSSOEnforced: () => Effect.succeed({ enforced: false }),
  setSSOEnforcement: () =>
    Effect.die(new Error("test: SSOPolicy.setSSOEnforcement not mocked")),
  listSSOProviders: () => Effect.succeed([]),
  getSSOProvider: () => Effect.succeed(null),
  createSSOProvider: () =>
    Effect.die(new Error("test: SSOPolicy.createSSOProvider not mocked")),
  updateSSOProvider: () =>
    Effect.die(new Error("test: SSOPolicy.updateSSOProvider not mocked")),
  deleteSSOProvider: () => Effect.succeed(true),
  verifyDomain: () =>
    Effect.die(new Error("test: SSOPolicy.verifyDomain not mocked")),
  checkDomainAvailability: () => Effect.succeed({ available: true }),
  testSSOProvider: () =>
    Effect.die(new Error("test: SSOPolicy.testSSOProvider not mocked")),
  findProviderByDomain: () => Effect.succeed(null),
  redactProvider: (provider) => provider,
  summarizeProvider: ({ config: _config, ...rest }) => rest,
};

const scimDefaults: SCIMProvenanceShape = {
  available: false,
  listConnections: () => Effect.succeed([]),
  deleteConnection: () => Effect.succeed(true),
  getSyncStatus: () =>
    Effect.die(new Error("test: SCIMProvenance.getSyncStatus not mocked")),
  listGroupMappings: () => Effect.succeed([]),
  createGroupMapping: () =>
    Effect.die(new Error("test: SCIMProvenance.createGroupMapping not mocked")),
  deleteGroupMapping: () => Effect.succeed(true),
  resolveGroupToRole: () => Effect.succeed(null),
};

export interface TestEnterpriseLayerOverrides {
  /** Override RolesPolicy methods. Defaults to EE-enabled (customRolesActive: true) + allow-all. */
  readonly RolesPolicy?: Partial<RolesPolicyShape>;
  /** Override IpAllowlistPolicy methods. Defaults to allow-all (available: false). */
  readonly IpAllowlistPolicy?: Partial<IpAllowlistPolicyShape>;
  /** Override SSOPolicy methods. Defaults to "no SSO enforced". */
  readonly SSOPolicy?: Partial<SSOPolicyShape>;
  /** Override SCIMProvenance methods. Defaults to "no SCIM connections". */
  readonly SCIMProvenance?: Partial<SCIMProvenanceShape>;
  /**
   * Layer bindings for non-middleware Tags (`AuditRetention`, `Branding`,
   * `Domains`, `MaskingPolicy`, `ModelRouter`, `ApprovalGate`, etc.).
   * Use `Layer.succeed(Tag, shape)` per Tag — the helper merges them
   * last-wins after the four middleware Tag defaults, so any Tag bound
   * here overrides whatever was inherited from middleware defaults.
   */
  readonly extraLayers?: ReadonlyArray<Layer.Layer<unknown>>;
}

/**
 * Build the runtime-export object that consumers of
 * `mock.module("@atlas/api/lib/effect/enterprise-layer", () => …)`
 * expect. Returns the same shape as the production module:
 *
 *   - `EnterpriseLayer` — the composed test Layer
 *   - `getEnterpriseRuntime` — returns a `ManagedRuntime` built on the test Layer
 *   - `runEnterprise(program)` — `runtime.runPromise(program)`
 *
 * The production module exports exactly these three. If a future export
 * lands there (e.g. a `runEnterpriseExit` for callsites that need the
 * cause), mirror it here in the same PR so the helper stays in lockstep
 * — drift in either direction is what this helper exists to prevent.
 */
export function makeTestEnterpriseLayer(
  overrides: TestEnterpriseLayerOverrides = {},
) {
  const testLayer = Layer.mergeAll(
    Layer.succeed(RolesPolicy, {
      ...rolesDefaults,
      ...overrides.RolesPolicy,
    } satisfies RolesPolicyShape),
    Layer.succeed(IpAllowlistPolicy, {
      ...ipAllowlistDefaults,
      ...overrides.IpAllowlistPolicy,
    } satisfies IpAllowlistPolicyShape),
    Layer.succeed(SSOPolicy, {
      ...ssoDefaults,
      ...overrides.SSOPolicy,
    } satisfies SSOPolicyShape),
    Layer.succeed(SCIMProvenance, {
      ...scimDefaults,
      ...overrides.SCIMProvenance,
    } satisfies SCIMProvenanceShape),
    // The `extraLayers` escape hatch is widened to `Layer<unknown>` so
    // callers can bind non-middleware Tags without re-stating each Tag's
    // shape interface — the `unknown` requirement (R) widens the merged
    // layer's RIn, so the final `ManagedRuntime.make` needs one cast to
    // collapse it back to `never`. This is the only cast in the helper.
    ...(overrides.extraLayers ?? []),
  );
  const testRuntime = ManagedRuntime.make(
    testLayer as Layer.Layer<never, never, never>,
  );
  return {
    EnterpriseLayer: testLayer,
    getEnterpriseRuntime: () => testRuntime,
    runEnterprise: <A, E>(program: Effect.Effect<A, E, unknown>) =>
      testRuntime.runPromise(program as Effect.Effect<A, E, never>),
  };
}
