/**
 * Unified API test mock factory.
 *
 * 40+ test files independently mock the same ~30 modules before importing
 * the Hono app.  This factory centralises all default mocks so that module
 * API changes only need updating here and per-test customisation is done
 * via overrides.
 *
 * Usage:
 *   import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";
 *
 *   const mocks = createApiTestMocks();          // sensible defaults
 *   const { app } = await import("../index");    // import app AFTER
 *
 *   // Override specific modules after the factory (later mock.module wins):
 *   mock.module("@atlas/api/lib/plugins/registry", () => ({ ... }));
 *
 * IMPORTANT: call at module level (top of file), NOT inside describe/beforeEach.
 * Bun's mock.module() must run before the mocked modules are first imported,
 * which happens when the app is imported at module scope.
 *
 * @module
 */

import { mock, type Mock } from "bun:test";
import { Context, Effect, Layer } from "effect";
import { asRatio } from "@useatlas/types";
import {
  createConnectionMock,
  type ConnectionMockOverrides,
} from "./connection";
import * as fs from "fs";
import * as path from "path";

/**
 * Matches the per-tier feature-entitlement lookup the `requireFeatureEntitlement`
 * guard (WS1 #3987) issues before every gated admin surface (SSO, SCIM, custom
 * roles, IP allowlist, approvals). The single SSOT for the SQL-shape coupling:
 * `getWorkspaceEntitlement` runs `SELECT plan_tier, is_operator_workspace FROM
 * organization WHERE id = $1` (see `lib/integrations/install/workspace-entitlement.ts`).
 *
 * Tests that drive a specific tier (`admin-sso.test.ts`,
 * `admin-access-governance-entitlement.test.ts`, `admin-approval.test.ts`,
 * `admin-roles.test.ts`) import this so the regex lives in exactly one place —
 * if that SELECT is ever reordered/aliased, only this predicate needs updating
 * rather than five drifting copies that would each silently revert to `[]`
 * (→ `free` → spurious 403) instead of failing loudly.
 */
export function isFeatureEntitlementQuery(sql: string): boolean {
  return /plan_tier[\s\S]*is_operator_workspace|is_operator_workspace[\s\S]*plan_tier/.test(
    sql,
  );
}

/**
 * A single-row `organization` result for the feature-entitlement lookup, shaped
 * exactly as `getWorkspaceEntitlement` reads it. Use in an `internalQuery` mock
 * branch gated on {@link isFeatureEntitlementQuery} to drive a workspace's tier.
 */
export function workspaceTierRows(
  tier: string | null,
  isOperator = false,
): Array<{ plan_tier: string | null; is_operator_workspace: boolean }> {
  return [{ plan_tier: tier, is_operator_workspace: isOperator }];
}

/**
 * Mock `InternalDB` Context.Tag — identity preserved for tests that load
 * modules (e.g. `ContentModeRegistry`) which `yield* InternalDB` from
 * Effect context. The tag is declared here so the factory can hand the
 * same class reference to both the mock and any test-local layer
 * provision; the real tag from `lib/db/internal.ts` is replaced wholesale
 * when `mock.module` runs.
 */
export class MockInternalDB extends Context.Tag("InternalDB")<
  MockInternalDB,
  {
    readonly sql: null;
    query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
    execute(sql: string, params?: unknown[]): void;
    readonly available: boolean;
    readonly pool: null;
  }
>() {}

/**
 * Build a test InternalDB shim layer that routes Effect-context `query`
 * calls through the caller's `internalQuery` mock. Exported for
 * standalone test mocks that don't use `createApiTestMocks` but still
 * need to satisfy the `InternalDB` tag (e.g. for routes that yield
 * `ContentModeRegistry`).
 */
export function makeMockInternalDBShimLayer(
  internalQueryMock: (sql: string, params?: unknown[]) => Promise<unknown[]>,
  options?: { available?: boolean },
) {
  return Layer.succeed(MockInternalDB, {
    sql: null,
    query: ((sql: string, params?: unknown[]) =>
      internalQueryMock(sql, params)) as <T extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) => Promise<T[]>,
    execute: () => {},
    available: options?.available ?? true,
    pool: null,
  });
}

/**
 * Wraps a Promise-returning `internalQuery` mock as an `Effect` so tests
 * that override `@atlas/api/lib/db/internal` via `mock.module()` can
 * supply a `queryEffect` export without repeating the tryPromise boilerplate.
 */
export function makeQueryEffectMock(
  internalQueryMock: (sql: string, params?: unknown[]) => Promise<unknown[]>,
) {
  return <T extends Record<string, unknown>>(sql: string, params?: unknown[]) =>
    Effect.tryPromise({
      try: () => internalQueryMock(sql, params) as Promise<T[]>,
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    });
}

/**
 * Complete mock surface for `@atlas/api/lib/db/internal` — every named
 * value export the module graph can import, satisfying the "Mock all
 * exports" rule (docs/development/testing.md): a transitive `import
 * { x }` of an unmocked name is a load-time SyntaxError under bun.
 *
 * `createApiTestMocks` spreads this into its own `mock.module`. Tests
 * that CANNOT use the factory — because it also mocks
 * `@atlas/api/lib/auth/server`, e.g. the Stripe webhook-lifecycle suite
 * whose unit under test IS server.ts — spread it directly and override
 * only the functions they assert on.
 */
export function buildInternalDbMockDefaults(deps: {
  internalQuery: (sql: string, params?: unknown[]) => Promise<unknown[]>;
  internalExecute?: AnyFn;
  hasInternalDB?: () => boolean;
}): Record<string, unknown> {
  const { internalQuery } = deps;
  const internalExecute = deps.internalExecute ?? mock(() => {});
  const hasInternalDB = deps.hasInternalDB ?? (() => true);
  return {
    // Context.Tag and shim-layer factory — see MockInternalDB above.
    // Tests that exercise routes using `ContentModeRegistry` (e.g.
    // `GET /api/v1/mode`) need both so `yield* InternalDB` inside
    // `countAllDrafts` resolves against the mocked module.
    InternalDB: MockInternalDB,
    makeInternalDBShimLayer: () =>
      Layer.succeed(MockInternalDB, {
        sql: null,
        query: internalQuery as <T extends Record<string, unknown>>(
          sql: string,
          params?: unknown[],
        ) => Promise<T[]>,
        execute: internalExecute,
        available: hasInternalDB(),
        pool: null,
      }),
    hasInternalDB,
    internalQuery: internalQuery,
    queryEffect: (sql: string, params?: unknown[]) =>
      Effect.tryPromise({
        try: () => internalQuery(sql, params),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }),
    // The real helper opens a transaction + advisory lock on a dedicated pool
    // connection (untestable with a mock pool). Here it just runs the callback
    // with a `tx.query` that delegates to `internalQuery`, so the SAME
    // SQL-string-matching mocks drive the guard's count/role-read/mutation
    // queries. Real serialization is covered by the real-Postgres test.
    withWorkspaceAdminLock: (
      _orgId: string,
      fn: (tx: {
        query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
      }) => Promise<unknown>,
    ) => fn({ query: (sql: string, params?: unknown[]) => internalQuery(sql, params) }),
    // Multi-workspace variant (#3166) — same passthrough: the callback runs with
    // a `tx.query` delegating to `internalQuery`, so SQL-string-matching
    // mocks drive the per-workspace count/role-read/delete queries. Real
    // multi-lock serialization is covered by the real-Postgres test.
    withWorkspaceAdminLocks: (
      _orgIds: readonly string[],
      fn: (tx: {
        query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
      }) => Promise<unknown>,
    ) => fn({ query: (sql: string, params?: unknown[]) => internalQuery(sql, params) }),
    // Per-subscription Stripe webhook lock (#3445) — passthrough: the real
    // helper holds a pg advisory lock on a dedicated pool connection
    // (untestable with a mock pool); here the callback just runs. Tests
    // that assert serialization (stripe-webhook-lifecycle) override this
    // with an in-process keyed mutex.
    withStripeSubscriptionLock: (
      _stripeSubscriptionId: string | null,
      fn: () => Promise<unknown>,
    ) => fn(),
    internalExecute: internalExecute,
    getInternalDB: mock(() => ({})),
    closeInternalDB: mock(async () => {}),
    migrateInternalDB: mock(async () => {}),
    loadSavedConnections: mock(async () => 0),
    // #3856 — post-publish datasource hot-register/deregister reconcile. Default
    // no-op (zero counts) so routes that call it on the success path don't trip
    // on an undefined export under partial mocks.
    reconcileWorkspaceDatasources: mock(async () => ({ registered: 0, deregistered: 0 })),
    _resetPool: mock(() => {}),
    _resetCircuitBreaker: mock(() => {}),
    isInternalCircuitOpen: () => false,
    _setInternalCircuitOpenForTests: mock(() => {}),
    encryptSecret: (url: string) => url,
    decryptSecret: (url: string) => url,
    getEncryptionKey: () => null,
    // F-47 keyset resolver — mocked as `null` so the passthrough contract
    // in both `encryptSecret` helpers (the URL-aware one in `db/internal.ts`
    // and the prefix-only one in `db/secret-encryption.ts`) still holds
    // under `mock.module("@atlas/api/lib/db/internal", ...)` partial mocks.
    getEncryptionKeyset: () => null,
    isPlaintextUrl: (value: string) =>
      /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value),
    _resetEncryptionKeyCache: mock(() => {}),
    findPatternBySQL: async () => null,
    insertLearnedPattern: () => {},
    incrementPatternCount: () => {},
    getApprovedPatterns: mock(async () => []),
    // #4573 — injection-attribution writer; org-knowledge-section (loaded
    // transitively via agent at app boot) imports it, so it must be in the
    // complete surface or a transitive named import SyntaxErrors under bun.
    recordPatternInjections: mock(() => {}),
    upsertSuggestion: mock(() => Promise.resolve("created")),
    getSuggestionsByTables: mock(() => Promise.resolve([])),
    getPopularSuggestions: mock(() => Promise.resolve([])),
    incrementSuggestionClick: mock(),
    deleteSuggestion: mock(() => Promise.resolve(false)),
    getAuditLogQueries: mock(() => Promise.resolve([])),
    getWorkspaceStatus: mock(async () => "active"),
    getWorkspaceDetails: mock(async () => null),
    getWorkspaceNamesByIds: mock(async (ids: string[]) => {
      const map = new Map<string, string | null>();
      for (const id of ids) map.set(id, null);
      return map;
    }),
    updateWorkspaceStatus: mock(async () => true),
    updateWorkspacePlanTier: mock(async () => true),
    cascadeWorkspaceDelete: mock(async () => ({
      conversations: 0,
      semanticEntities: 0,
      learnedPatterns: 0,
      suggestions: 0,
      scheduledTasks: 0,
      settings: 0,
    })),
    getWorkspaceHealthSummary: mock(async () => null),
    getWorkspaceRegion: mock(async () => null),
    setWorkspaceRegion: mock(async () => ({ assigned: true })),
    updateWorkspaceByot: mock(async () => true),
    setWorkspaceTrialEndsAt: mock(async () => true),
    // #3427 — pure predicate; default mock mirrors the real semantics
    // (active when plan_override_until is set and in the future) so callers
    // that don't override it still behave correctly.
    isPlanOverrideActive: mock((until?: string | null, now: Date = new Date()) => {
      if (!until) return false;
      const t = new Date(until);
      return !Number.isNaN(t.getTime()) && t.getTime() > now.getTime();
    }),
    getAutoApproveThreshold: mock(() => 2),
    getAutoApproveTypes: mock(() => new Set(["update_description", "add_dimension"])),
    insertSemanticAmendment: mock(async () => ({
      outcome: "inserted" as const,
      id: "mock-amendment-id",
      autoApprove: false,
    })),
    getPendingAmendmentCount: mock(async () => 0),
    getPendingAmendments: mock(async () => []),
    // Rejected view + Reconsider (#4512) — defaults model "no rejected rows".
    getRejectedAmendments: mock(async () => []),
    reconsiderRejectedAmendment: mock(async () => false),
    // Decide-seam claim helpers (#4506) — defaults model "no pending row".
    claimPendingAmendment: mock(async () => null),
    stampClaimedAmendmentApproved: mock(async () => false),
    releaseClaimedAmendment: mock(async () => false),
    rejectPendingAmendment: mock(async () => false),
    // Shared org-scope helper (#4510), adopted by the learned-patterns route in
    // #4580. Returns the SELF-HOSTED clause, matching this harness's pinned
    // `isSaasModeForGuard: () => false` (Settings mock below). The full
    // SaaS/self-hosted branch matrix — including the SaaS org-less withhold — is
    // pinned against the REAL helper in
    // db/__tests__/semantic-amendment-saas-scoping.test.ts, so route suites
    // don't need to re-drive deploy mode here. Present so a route's `import
    // { amendmentOrgScope }` never SyntaxErrors at load time under this mock.
    amendmentOrgScope: (orgId: string | null, placeholder: string) =>
      orgId
        ? { withhold: false, clause: `(org_id = ${placeholder} OR org_id IS NULL)` }
        : { withhold: false, clause: "org_id IS NULL" },
    AMENDMENT_CLAIM_STALE_MINUTES: 10,
    hardDeleteWorkspace: mock(async () => ({})),
  
    // Remaining named exports with no behavior worth faking — present so
    // a transitive `import { x }` never SyntaxErrors at load time.
    MANAGED_AUTH_MIGRATIONS: [],
    _hasRecoveryFiber: () => false,
    makeInternalDBLive: () => Layer.succeed(MockInternalDB, {
      sql: null,
      query: internalQuery as <T extends Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ) => Promise<T[]>,
      execute: internalExecute,
      available: hasInternalDB(),
      pool: null,
    }),
    createInternalDBTestLayer: () => Layer.succeed(MockInternalDB, {
      sql: null,
      query: internalQuery as <T extends Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ) => Promise<T[]>,
      execute: internalExecute,
      available: hasInternalDB(),
      pool: null,
    }),
  };
}

// ── Types ───────────────────────────────────────────────────────────

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- intentionally generic mock function type for test overrides
type AnyFn = (...args: any[]) => any;

/** Shape of the user object returned inside the authenticateRequest response. */
export interface AuthUser {
  id: string;
  mode: string;
  label: string;
  role: string;
  activeOrganizationId?: string;
  /**
   * Session-user claims. Mirrors `AtlasUser.claims` and is used by the F-MFA
   * gate (see admin-mfa-required.ts) to decide whether the caller has an
   * enrolled second factor. Tests that need to exercise the unenrolled path
   * pass `{ twoFactorEnabled: false }` here; otherwise the factory injects
   * `{ twoFactorEnabled: true }` for admin/platform_admin roles.
   */
  claims?: Record<string, unknown>;
}

export interface ApiTestMockOverrides {
  /** Auth user returned by authenticateRequest (default: simple-key admin). */
  authUser?: AuthUser;
  /** Auth mode returned by detectAuthMode (default: matches authUser.mode). */
  authMode?: string;
  /** Override connection mock (passed to createConnectionMock). */
  connection?: ConnectionMockOverrides;
  /** Override individual db/internal exports. */
  internal?: Record<string, unknown>;
  /** Override individual semantic exports. */
  semantic?: Record<string, unknown>;
  /** Override individual cache exports. Applies to both cache and cache/index. */
  cache?: Record<string, unknown>;
  /** Create a temp semantic dir with stub entity YAML (default: true). */
  semanticDir?: boolean;
}

export interface ApiTestMocks {
  /** The authenticateRequest mock — override per test via .mockImplementation(), .mockImplementationOnce(), or .mockResolvedValue(). */
  mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>>;
  /** The checkRateLimit mock. */
  mockCheckRateLimit: Mock<AnyFn>;
  /** The internalQuery mock — call .mockImplementation() per test. */
  mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>>;
  /** The internalExecute mock. */
  mockInternalExecute: Mock<AnyFn>;
  /**
   * Controls `hasInternalDB()` return value.
   * Note: if you override `hasInternalDB` via the `internal` option, the getter/setter
   * here will be disconnected from the mock module. Use this property instead.
   */
  hasInternalDB: boolean;
  /** Path to the temp semantic dir (undefined if semanticDir: false). */
  tmpRoot: string | undefined;

  // ── Role helpers ────────────────────────────────────────────────

  /** Set auth to a workspace admin with the given orgId. */
  setOrgAdmin(orgId: string): void;
  /** Set auth to a platform_admin with the given orgId (default: "org-test"). */
  setPlatformAdmin(orgId?: string): void;
  /** Set auth to a regular member with the given orgId. */
  setMember(orgId?: string): void;
  /** Cleanup temp semantic dir (call in afterAll). */
  cleanup(): void;
}

// ── Factory ─────────────────────────────────────────────────────────

export function createApiTestMocks(
  overrides?: ApiTestMockOverrides,
): ApiTestMocks {
  const authUser: AuthUser = overrides?.authUser ?? {
    id: "admin-1",
    mode: "simple-key",
    label: "Admin",
    role: "admin",
    activeOrganizationId: "org-1",
  };
  const authMode = overrides?.authMode ?? authUser.mode;

  // ── Temp semantic directory ────────────────────────────────────

  const wantSemanticDir = overrides?.semanticDir !== false;
  let tmpRoot: string | undefined;
  if (wantSemanticDir) {
    tmpRoot = path.join(
      process.env.TMPDIR ?? "/tmp",
      `atlas-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    fs.mkdirSync(path.join(tmpRoot, "entities"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "entities", "stub.yml"),
      "table: stub\ndescription: stub\ndimensions:\n  id:\n    type: integer\n",
    );
    fs.writeFileSync(path.join(tmpRoot, "catalog.yml"), "name: Test\n");
    process.env.ATLAS_SEMANTIC_ROOT = tmpRoot;
  }

  // ── Auth middleware ────────────────────────────────────────────

  // F-MFA — default admin/owner/platform_admin users to "MFA enrolled" so
  // existing admin route tests pass through the `mfaRequired` gate. Tests
  // that exercise the gate itself live in
  // src/api/routes/__tests__/admin-mfa-required.test.ts and build their own
  // auth result. Override per-test by passing a `claims` object on
  // `authUser`. Mirrors the role admit-list in `mfaRequired.ENFORCED_ROLES`.
  const defaultClaims =
    authUser.role === "admin"
    || authUser.role === "owner"
    || authUser.role === "platform_admin"
      ? { twoFactorEnabled: true }
      : undefined;

  const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> =
    mock(() =>
      Promise.resolve({
        authenticated: true,
        mode: authUser.mode,
        user: {
          ...authUser,
          ...(defaultClaims !== undefined
            ? { claims: { ...defaultClaims, ...(authUser.claims ?? {}) } }
            : {}),
        },
      }),
    );

  const mockCheckRateLimit: Mock<AnyFn> = mock(() => ({ allowed: true }));

  // fire-and-forget: bun's `mock.module()` registers the module override
  // synchronously for our purposes; the returned promise is intentionally not
  // awaited (each call below is `void`-prefixed for the same reason).
  void mock.module("@atlas/api/lib/auth/middleware", () => ({
    authenticateRequest: mockAuthenticateRequest,
    checkRateLimit: mockCheckRateLimit,
    getClientIP: mock(() => null),
    resetRateLimits: mock(() => {}),
    rateLimitCleanupTick: mock(() => {}),
    _setValidatorOverrides: mock(() => {}),
  }));

  // ── Auth detect ───────────────────────────────────────────────

  void mock.module("@atlas/api/lib/auth/detect", () => ({
    detectAuthMode: () => authMode,
    resetAuthModeCache: () => {},
  }));

  // ── Auth types ────────────────────────────────────────────────

  // Keep ATLAS_ROLES / ORG_ROLES / PLATFORM_ROLES aligned with the real tuples
  // in packages/types/src/auth.ts — drift masks role-escalation bugs like F-10
  // (#1752) in tests. The invariant is enforced by the tuple assertions in
  // packages/api/src/lib/auth/__tests__/organization.test.ts — do not trim
  // these arrays to make a test pass.
  void mock.module("@atlas/api/lib/auth/types", () => ({
    AUTH_MODES: ["none", "simple-key", "byot", "managed"],
    ATLAS_ROLES: ["member", "admin", "owner", "platform_admin"],
    ORG_ROLES: ["member", "admin", "owner"],
    PLATFORM_ROLES: ["platform_admin"],
    createAtlasUser: (
      id: string,
      mode: string,
      label: string,
      opts?: Record<string, unknown>,
    ) => Object.freeze({ id, mode, label, ...opts }),
  }));

  // ── Auth server ───────────────────────────────────────────────

  void mock.module("@atlas/api/lib/auth/server", () => ({
    getAuthInstance: () => null,
    // #4046 — managed.ts imports SESSION_ORIGIN_CLI from auth/server; export it
    // so harness consumers that transitively load managed.ts don't SyntaxError on
    // a missing named export (CLAUDE.md: mock ALL exports a consumer reads).
    SESSION_ORIGIN_CLI: "cli",
    listAllUsers: mock(() => Promise.resolve([])),
    setUserRole: mock(async () => {}),
    setBanStatus: mock(async () => {}),
    setPasswordChangeRequired: mock(async () => {}),
    deleteUser: mock(async () => {}),
  }));

  // ── Startup ───────────────────────────────────────────────────

  void mock.module("@atlas/api/lib/startup", () => ({
    validateEnvironment: mock(() => Promise.resolve([])),
    getStartupWarnings: mock(() => []),
  }));

  // ── DB connection ─────────────────────────────────────────────

  void mock.module("@atlas/api/lib/db/connection", () =>
    createConnectionMock({
      connections: {
        get: () => null,
        getDefault: () => null,
        describe: () => [{ id: "default", dbType: "postgres" }],
        healthCheck: mock(() =>
          Promise.resolve({ status: "healthy", latencyMs: 1, checkedAt: new Date() }),
        ),
        register: mock(() => {}),
        unregister: mock(() => {}),
        has: mock(() => false),
        getForOrg: () => null,
      },
      resolveDatasourceUrl: () => "postgresql://stub",
      ...overrides?.connection,
    }),
  );

  // ── DB internal ───────────────────────────────────────────────

  let _hasInternalDB = true;

  // Default `internalQuery`: empty result set, EXCEPT the per-tier
  // feature-entitlement lookup (WS1 #3987). The `requireFeatureEntitlement`
  // guard now resolves a workspace's `plan_tier` / `is_operator_workspace`
  // off the `organization` table before every gated admin surface (SSO, SCIM,
  // custom roles, IP allowlist, approvals). In SaaS deploy mode an empty result
  // collapses to `null` → `free` → a 403 `plan_upgrade_required` before the
  // route's own logic runs, which would spuriously fail every harness test that
  // exercises a gated route. Defaulting this one query to a `business` workspace
  // (the tier every gated feature unlocks at) keeps those tests green; a test
  // that wants to drive a specific tier overrides `mockInternalQuery` itself
  // (see admin-sso.test.ts / admin-access-governance-entitlement.test.ts). The
  // SQL-shape coupling lives in the exported `isFeatureEntitlementQuery` helper
  // above so the regex has exactly one definition.
  const mockInternalQuery: Mock<
    (sql: string, params?: unknown[]) => Promise<unknown[]>
  > = mock((sql: string) =>
    Promise.resolve(
      isFeatureEntitlementQuery(sql) ? workspaceTierRows("business") : [],
    ),
  );

  const mockInternalExecute: Mock<AnyFn> = mock(() => {});

  const internalDefaults: Record<string, unknown> = buildInternalDbMockDefaults({
    internalQuery: mockInternalQuery,
    internalExecute: mockInternalExecute,
    hasInternalDB: () => _hasInternalDB,
  });

  void mock.module("@atlas/api/lib/db/internal", () => ({
    ...internalDefaults,
    ...overrides?.internal,
  }));

  // ── Semantic ──────────────────────────────────────────────────

  void mock.module("@atlas/api/lib/semantic", () => ({
    getOrgWhitelistedTables: () => new Set(),
    loadOrgWhitelist: async () => new Map(),
    invalidateOrgWhitelist: () => {},
    getOrgSemanticIndex: async () => "",
    invalidateOrgSemanticIndex: () => {},
    _resetOrgWhitelists: () => {},
    _resetOrgSemanticIndexes: () => {},
    getWhitelistedTables: () => new Set(["stub"]),
    getCrossSourceJoins: () => [],
    _resetWhitelists: () => {},
    registerPluginEntities: () => {},
    _resetPluginEntities: () => {},
    ...overrides?.semantic,
  }));

  void mock.module("@atlas/api/lib/semantic/entities", () => ({
    listEntityRows: mock(() => Promise.resolve([])),
    listEntitiesWithOverlay: mock(() => Promise.resolve([])),
    listEntities: mock(() => Promise.resolve([])),
    getEntity: mock(() => Promise.resolve(null)),
    upsertEntity: mock(() => Promise.resolve()),
    upsertDraftEntity: mock(() => Promise.resolve()),
    upsertTombstone: mock(() => Promise.resolve()),
    deleteEntity: mock(() => Promise.resolve(false)),
    deleteDraftEntity: mock(() => Promise.resolve(false)),
    countEntities: mock(() => Promise.resolve(0)),
    bulkUpsertEntities: mock(() => Promise.resolve(0)),
    // Durable partial-profile marker helpers (#3682) — default no-ops / empty.
    upsertProfileStatus: mock(() => Promise.resolve()),
    listIncompleteProfileLayers: mock(() => Promise.resolve([])),
    createVersion: mock(() => Promise.resolve("v1")),
    listVersions: mock(() => Promise.resolve({ versions: [], total: 0 })),
    getVersion: mock(() => Promise.resolve(null)),
    generateChangeSummary: mock(() => Promise.resolve(null)),
    // Publish helpers (#1429) — default no-ops. Tests that exercise the
    // publish endpoint override `@atlas/api/lib/db/internal.getInternalDB`
    // to drive the transactional client directly.
    applyTombstones: mock(() => Promise.resolve(0)),
    promoteDraftEntities: mock(() => Promise.resolve(0)),
    // Archive/restore helpers (#1437) — default to not_found so the handler
    // returns 404 unless a test overrides this module.
    DEMO_CONNECTION_ID: "__demo__",
    archiveSingleConnection: mock(() =>
      Promise.resolve({ status: "not_found" as const }),
    ),
    restoreSingleConnection: mock(() =>
      Promise.resolve({ status: "not_found" as const }),
    ),
  }));

  void mock.module("@atlas/api/lib/semantic/diff", () => ({
    runDiff: mock(async () => ({
      connection: "default",
      newTables: [],
      removedTables: [],
      tableDiffs: [],
    })),
    // Slice 1 of #2458 added a `runDriftDiff` companion that also reports
    // the pre-whitelist introspection count. Admin route imports it
    // alongside `runDiff`; without it here the loader throws
    // "Export named 'runDriftDiff' not found" and the entire admin
    // router fails to mount (404s on every admin route).
    runDriftDiff: mock(async () => ({
      diff: { newTables: [], removedTables: [], tableDiffs: [], unchangedCount: 0 },
      introspectedTableCount: 0,
      warnings: [] as string[],
    })),
  }));

  // ── Cache ─────────────────────────────────────────────────────

  const cacheMock = () => ({
    getCache: mock(() => ({
      get: () => null,
      set: () => {},
      delete: () => false,
      flush: () => {},
      stats: () => ({}),
    })),
    cacheEnabled: mock(() => true),
    setCacheBackend: mock(() => {}),
    flushCache: mock(() => {}),
    getDefaultTtl: mock(() => 300000),
    _resetCache: mock(() => {}),
    buildCacheKey: mock(() => "mock-key"),
    ...overrides?.cache,
  });

  // Both paths needed: route handlers use dynamic import("@atlas/api/lib/cache/index")
  void mock.module("@atlas/api/lib/cache", cacheMock);
  void mock.module("@atlas/api/lib/cache/index", cacheMock);

  // ── Workspace ─────────────────────────────────────────────────

  void mock.module("@atlas/api/lib/workspace", () => ({
    checkWorkspaceStatus: mock(async () => ({ allowed: true })),
  }));

  // ── Pattern cache ─────────────────────────────────────────────

  void mock.module("@atlas/api/lib/learn/pattern-cache", () => ({
    buildLearnedPatternsSection: async () => "",
    getRelevantPatterns: async () => [],
    buildRetrievalQuery: () => "",
    getRetrievalTurns: () => 3,
    invalidatePatternCache: () => {},
    extractKeywords: () => new Set(),
    _resetPatternCache: () => {},
  }));

  // #3633 — agent.ts assembles the org-knowledge block (learned patterns +
  // favorites + approved suggestions) via this module. Stubbed here too so
  // shared-harness runAgent tests don't execute the real orchestrator's
  // resolvers; the dedicated org-knowledge-section.test.ts covers it directly.
  void mock.module("@atlas/api/lib/learn/org-knowledge-section", () => ({
    resolveOrgKnowledgeSection: async () => "",
  }));

  // ── Plugins ───────────────────────────────────────────────────

  void mock.module("@atlas/api/lib/plugins/registry", () => ({
    plugins: {
      describe: () => [],
      get: () => undefined,
      getStatus: () => undefined,
      enable: () => false,
      disable: () => false,
      isEnabled: () => false,
      getAllHealthy: () => [],
      getByType: () => [],
      size: 0,
    },
    PluginRegistry: class {},
  }));

  void mock.module("@atlas/api/lib/plugins/hooks", () => ({
    dispatchHook: mock(async () => {}),
  }));

  void mock.module("@atlas/api/lib/plugins/settings", () => ({
    loadPluginSettings: mock(async () => 0),
    savePluginEnabled: mock(async () => {}),
    savePluginConfig: mock(async () => {}),
    getPluginConfig: mock(async () => null),
    getAllPluginSettings: mock(async () => []),
  }));

  // ── Tools ─────────────────────────────────────────────────────

  void mock.module("@atlas/api/lib/tools/explore", () => ({
    getExploreBackendType: () => "just-bash",
    getActiveSandboxPluginId: () => null,
    explore: { type: "function" },
    invalidateExploreBackend: mock(() => {}),
    invalidateOrgExploreBackends: mock(() => {}),
    markNsjailFailed: mock(() => {}),
    markSidecarFailed: mock(() => {}),
  }));

  void mock.module("@atlas/api/lib/tools/actions", () => ({}));

  // ── Agent ─────────────────────────────────────────────────────

  void mock.module("@atlas/api/lib/agent", () => ({
    runAgent: mock(() =>
      Promise.resolve({
        toUIMessageStreamResponse: () =>
          new Response("stream", { status: 200 }),
        text: Promise.resolve("answer"),
      }),
    ),
  }));

  // ── Conversations ─────────────────────────────────────────────

  void mock.module("@atlas/api/lib/conversations", () => ({
    createConversation: mock(() => Promise.resolve(null)),
    addMessage: mock(() => {}),
    persistAssistantSteps: mock(() => {}),
    // F-77 step-cap helpers — chat.ts imports both via @atlas/api/lib/conversations.
    reserveConversationBudget: mock(() => Promise.resolve({ status: "ok" as const, totalStepsBefore: 0 })),
    settleConversationSteps: mock(() => {}),
    getConversation: mock(() => Promise.resolve(null)),
    generateTitle: mock((q: string) => q.slice(0, 80)),
    listConversations: mock(() =>
      Promise.resolve({ conversations: [], total: 0 }),
    ),
    deleteConversation: mock(() => Promise.resolve(false)),
    starConversation: mock(() => Promise.resolve(false)),
    shareConversation: mock(() =>
      Promise.resolve({ ok: false, reason: "not_found" }),
    ),
    unshareConversation: mock(() =>
      Promise.resolve({ ok: false, reason: "not_found" }),
    ),
    getShareStatus: mock(() =>
      Promise.resolve({ ok: false, reason: "not_found" }),
    ),
    cleanupExpiredShares: mock(() => Promise.resolve(0)),
    getSharedConversation: mock(() =>
      Promise.resolve({ ok: false, reason: "not_found" }),
    ),
    // #2345 — group-aware routing. Default to "no group" so chat-route
    // tests that don't exercise the multi-env flow continue to create
    // conversations with `connection_group_id = NULL`. Tests that
    // exercise the routing override this mock locally via mock.module.
    resolveGroupForConnection: mock(() => Promise.resolve(null)),
  verifyGroupBelongsToOrg: mock(() => Promise.resolve("ok")),
    // #2518 — three-state Auto/Pin/All picker write path. Default to a
    // no-op success — chat-route tests don't write the row unless they
    // exercise the picker toggle path, and they override locally when
    // they do.
    updateConversationRoutingMode: mock(() => Promise.resolve({ ok: true as const })),
    // #3066 — per-conversation REST exclude-set write path. Same no-op
    // success default as the routing-mode write: chat-route tests don't
    // persist the row unless they exercise the scope-picker toggle, and
    // they override locally when they do.
    updateConversationRestExcluded: mock(() => Promise.resolve({ ok: true as const })),
    updateConversationRestFocus: mock(() => Promise.resolve({ ok: true as const })),
    // #3895 — per-conversation Group reach write path. Same no-op success
    // default; chat.ts statically imports it, so the shared mock MUST export it
    // (a partial mock omitting it breaks every route test's module load with a
    // "Export named 'updateConversationGroupReach' not found" SyntaxError).
    updateConversationGroupReach: mock(() => Promise.resolve({ ok: true as const })),
    updateConversationAnswerStyle: mock(() => Promise.resolve({ ok: true as const })),
    // NULL → "pin" back-compat default helper used by the chat route to
    // resolve a conversation's persisted `routing_mode`. Mocked as a pure
    // pass-through so tests can simulate either an explicit mode or the
    // legacy NULL → "pin" coercion without further wiring.
    resolveRoutingMode: mock(
      (m: "auto" | "pin" | "all" | null | undefined = null) => m ?? "pin",
    ),
  }));

  // ── Security ──────────────────────────────────────────────────

  void mock.module("@atlas/api/lib/security", () => ({
    maskConnectionUrl: (url: string) => url.replace(/\/\/.*@/, "//***@"),
    SENSITIVE_PATTERNS: [],
  }));

  // ── Residency ─────────────────────────────────────────────────

  void mock.module("@atlas/api/lib/residency/misrouting", () => ({
    detectMisrouting: mock(async () => null),
    isStrictRoutingEnabled: mock(() => false),
    getMisroutedCount: mock(() => 0),
    _resetMisroutedCount: mock(() => {}),
    _resetRegionCache: mock(() => {}),
    getApiRegion: mock(() => null),
  }));

  void mock.module("@atlas/api/lib/residency/readonly", () => ({
    isWorkspaceMigrating: mock(async () => false),
  }));

  // ── Settings ──────────────────────────────────────────────────

  void mock.module("@atlas/api/lib/settings", () => ({
    getSettingsForAdmin: mock(() => []),
    getSettingsRegistry: mock(() => []),
    getSettingDefinition: mock(() => undefined),
    setSetting: mock(async () => {}),
    deleteSetting: mock(async () => {}),
    getSetting: mock(() => undefined),
    getSettingAuto: mock(() => undefined),
    getSettingLive: mock(async () => undefined),
    loadSettings: mock(async () => 0),
    getAllSettingOverrides: mock(async () => []),
    _resetSettingsCache: mock(() => {}),
    // #3389 — the settings route write gates probe deploy mode via this.
    // Default false (non-SaaS/permissive) to match the `getConfig: () =>
    // null` mock below ("unloaded" → self-hosted in the real probe).
    isSaasModeForGuard: mock(() => false),
  }));

  // ── Config ────────────────────────────────────────────────────

  void mock.module("@atlas/api/lib/config", () => ({
    getConfig: () => null,
    defineConfig: (c: unknown) => c,
  }));

  // ── Scheduled tasks / Scheduler ───────────────────────────────

  void mock.module("@atlas/api/lib/scheduled-tasks", () => ({
    listScheduledTasks: mock(async () => []),
    getScheduledTask: mock(async () => null),
    createScheduledTask: mock(async () => ({})),
    updateScheduledTask: mock(async () => null),
    deleteScheduledTask: mock(async () => false),
    listScheduledTaskRuns: mock(async () => []),
    getRecentRuns: mock(async () => []),
    scheduledTaskBelongsToUser: mock(async () => false),
    // The scheduled-tasks route now mounts unconditionally (#4623), so the
    // full set of exports it imports must be present even when a suite never
    // exercises the route (missing export → "not found" at module load).
    listTaskRuns: mock(async () => []),
    listAllRuns: mock(async () => ({ runs: [], total: 0 })),
    validateCronExpression: mock(() => ({ valid: true })),
  }));

  void mock.module("@atlas/api/lib/scheduler", () => ({
    getSchedulerEngine: mock(() => null),
  }));

  void mock.module("@atlas/api/lib/scheduler/preview", () => ({
    previewSchedule: () => [],
  }));

  // ── EE: roles (custom-role permission resolution) ──
  //
  // F-53 wires `checkPermission()` into every admin route. Post-#2571
  // (slice 9/11 of #2017) the route layer yields the `RolesPolicy` Tag.
  // The Tag's no-op default in `lib/effect/services.ts:NoopRolesPolicyLayer`
  // delegates to `lib/auth/permission-resolve.ts:checkPermission` — the
  // legacy admin/owner/platform_admin → all-flags + member → query
  // mapping — so admin routes resolve permissions cleanly without EE
  // being loaded. The legacy `@atlas/ee/auth/roles` module mock below
  // stays for any transitive resolver chain (slice 11 closeout #2573
  // will drop it entirely).

  void mock.module("@atlas/api/lib/auth/roles-errors", () => ({
    RoleError: class extends Error {
      public readonly _tag = "RoleError" as const;
      public readonly code: string;
      constructor(message: string, code: string) {
        super(message);
        this.name = "RoleError";
        this.code = code;
      }
    },
  }));

  void mock.module("@atlas/ee/auth/roles", () => ({
    PERMISSIONS: [
      "query",
      "query:raw_data",
      "admin:users",
      "admin:connections",
      "admin:settings",
      "admin:audit",
      "admin:roles",
      "admin:semantic",
    ] as const,
    isValidPermission: () => true,
    isValidRoleName: () => true,
    BUILTIN_ROLES: [],
    resolvePermissions: mock(() => Effect.succeed(new Set())),
    hasPermission: mock(() => Effect.succeed(true)),
    checkPermission: mock(() => Effect.succeed(null)),
    listRoles: mock(() => Effect.succeed([])),
    getRole: mock(() => Effect.succeed(null)),
    getRoleByName: mock(() => Effect.succeed(null)),
    createRole: mock(() => Effect.die(new Error("not configured"))),
    updateRole: mock(() => Effect.die(new Error("not configured"))),
    deleteRole: mock(() => Effect.succeed(true)),
    listRoleMembers: mock(() => Effect.succeed([])),
    assignRole: mock(() => Effect.die(new Error("not configured"))),
    seedBuiltinRoles: mock(() => Effect.succeed(undefined)),
    RoleError: class extends Error {
      public readonly _tag = "RoleError" as const;
      public readonly code: string;
      constructor(message: string, code: string) {
        super(message);
        this.name = "RoleError";
        this.code = code;
      }
    },
  }));

  // ── EE: IP allowlist (queries internal DB, which doesn't exist in tests) ──

  void mock.module("@atlas/ee/auth/ip-allowlist", () => ({
    checkIPAllowlist: mock(() => Effect.succeed({ allowed: true })),
    listIPAllowlistEntries: mock(async () => []),
    addIPAllowlistEntry: mock(async () => ({})),
    removeIPAllowlistEntry: mock(async () => false),
    IPAllowlistError: class extends Error {
      public readonly code: string;
      constructor(message: string, code: string) {
        super(message);
        this.name = "IPAllowlistError";
        this.code = code;
      }
    },
    invalidateCache: mock(() => {}),
    _clearCache: mock(() => {}),
    parseCIDR: mock(() => null),
    isIPInRange: mock(() => false),
    isIPAllowed: mock(() => true),
  }));

  // ── Security: abuse ───────────────────────────────────────────

  void mock.module("@atlas/api/lib/security/abuse", () => ({
    listFlaggedWorkspaces: mock(() => []),
    // F-33: returns the previous level on success so the route can emit
    // audit metadata without a second getter call, or `null` when the
    // workspace is not flagged. Default success fixture surfaces
    // "warning" — the most common delta.
    reinstateWorkspace: mock(() => "warning" as const),
    getAbuseEvents: mock(async () => ({ events: [], status: "ok" })),
    // `asRatio` brands the config value (#1685) — the real `getAbuseConfig`
    // does the same at its env-var boundary, so the mock shape matches.
    getAbuseConfig: mock(() => ({
      queryRateLimit: 200,
      queryRateWindowSeconds: 300,
      errorRateThreshold: asRatio(0.5),
      uniqueTablesLimit: 50,
      throttleDelayMs: 2000,
    })),
    getAbuseDetail: mock(async () => null),
    checkAbuseStatus: mock(() => ({ level: "none" })),
    recordQueryEvent: mock(() => {}),
    restoreAbuseState: mock(async () => {}),
    getAbuseRestoreStatus: mock(() => "ok" as const),
    ABUSE_RESTORE_STATUSES: ["pending", "ok", "db_unavailable", "load_failed"] as const,
    _resetAbuseState: mock(() => {}),
    abuseCleanupTick: mock(() => {}),
    ABUSE_CLEANUP_INTERVAL_MS: 300_000,
  }));

  // ── Role helper functions ─────────────────────────────────────

  function setOrgAdmin(orgId: string): void {
    // F-MFA — admin/owner/platform_admin users default to MFA-enrolled so
    // existing admin route tests pass through the `mfaRequired` gate.
    // NOTE: this helper REPLACES the entire mock implementation, including
    // any per-call configuration set earlier (e.g. by `createApiTestMocks`).
    // Tests that need a non-default `claims` shape must call
    // `mockAuthenticateRequest.mockImplementation(...)` directly instead of
    // combining `setOrgAdmin` + a `claims` override.
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: {
          id: "admin-1",
          mode: "managed",
          label: "admin@test.com",
          role: "admin",
          activeOrganizationId: orgId,
          claims: { twoFactorEnabled: true },
        },
      }),
    );
  }

  function setPlatformAdmin(orgId = "org-test"): void {
    // F-MFA — same override-everything semantic as `setOrgAdmin`.
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: {
          id: "platform-admin-1",
          mode: "managed",
          label: "platform@test.com",
          role: "platform_admin",
          activeOrganizationId: orgId,
          claims: { twoFactorEnabled: true },
        },
      }),
    );
  }

  function setMember(orgId = "org-1"): void {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: authMode,
        user: {
          id: "user-1",
          mode: authMode,
          label: "user@test.com",
          role: "member",
          activeOrganizationId: orgId,
        },
      }),
    );
  }

  function cleanup(): void {
    if (tmpRoot) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      delete process.env.ATLAS_SEMANTIC_ROOT;
    }
  }

  return {
    mockAuthenticateRequest,
    mockCheckRateLimit,
    mockInternalQuery,
    mockInternalExecute,
    get hasInternalDB() {
      return _hasInternalDB;
    },
    set hasInternalDB(v: boolean) {
      _hasInternalDB = v;
    },
    tmpRoot,
    setOrgAdmin,
    setPlatformAdmin,
    setMember,
    cleanup,
  };
}
