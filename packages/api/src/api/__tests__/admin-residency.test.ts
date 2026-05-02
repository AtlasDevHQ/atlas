/**
 * Tests for admin residency API endpoints.
 *
 * Tests the adminResidency sub-router directly (not through the parent admin
 * router) to avoid needing to mock every sub-router dependency.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";

// Real ADMIN_ACTIONS values so assertions pin to the canonical strings.
import { ADMIN_ACTIONS as REAL_ADMIN_ACTIONS } from "@atlas/api/lib/audit/actions";

// --- Effect mock ---
// Mock the Effect bridge so the route file can load and execute without
// the full Effect runtime. Effect.gen + runEffect are shimmed to execute
// the generator directly, resolving yield* calls to mocked services.

let mockEffectUser: Record<string, unknown> = {
  id: "admin-1",
  mode: "simple-key",
  label: "Admin",
  role: "admin",
  activeOrganizationId: "org-1",
  orgId: "org-1",
};

const fakeAuthContext = {
  [Symbol.iterator]: function* (): Generator<unknown, Record<string, unknown>> {
    return yield mockEffectUser;
  },
};

// Minimal Effect shim — supports gen, promise, tryPromise, succeed, fail.
// Also handles `.pipe(Effect.tapErrorCause(fn))` so admin-residency.ts can
// emit failure audits (F-32). `tapErrorCause` (vs `tapError`) also fires on
// defects — the route uses the Cause variant so a rejected `Effect.promise`
// (DB pool exhaustion, network drops) still lands a failure-audit row.
interface TapErrorCauseMarker {
  readonly _tag: "TapErrorCause";
  readonly fn: (cause: MockCause) => unknown;
}

// Minimal `Cause` shape the route's `causeToError` can walk via the
// shimmed `Cause.isInterruptedOnly` / `Cause.failureOption` / `Cause.defects`
// helpers. `_mockKind` distinguishes a typed failure from a defect so tests
// can exercise either branch by flipping `mockAssignCauseKind` before the
// throw.
interface MockCause {
  readonly _mockKind: "fail" | "defect";
  readonly error: unknown;
}

function isTapErrorCause(v: unknown): v is TapErrorCauseMarker {
  return typeof v === "object" && v !== null && (v as { _tag?: unknown })._tag === "TapErrorCause";
}

// Controls whether the synthesized Cause in withPipe's catch is a typed
// failure or a defect. `"fail"` matches `mod.assignWorkspaceRegion` returning
// `Effect.fail(ResidencyError)`; `"defect"` simulates a rejected
// `Effect.promise` (the exact infrastructure-failure path `tapError` would
// miss and `tapErrorCause` + `causeToError` closes).
let mockAssignCauseKind: "fail" | "defect" = "fail";

interface PipedIterable {
  [Symbol.iterator]: () => Iterator<unknown, unknown>;
  pipe: (...ops: unknown[]) => PipedIterable;
}

function withPipe(iter: { [Symbol.iterator]: () => Iterator<unknown, unknown> }): PipedIterable {
  const piped = iter as PipedIterable;
  piped.pipe = (...ops: unknown[]) => {
    const hooks = ops.filter(isTapErrorCause);
    return withPipe({
      [Symbol.iterator]() {
        const inner = iter[Symbol.iterator]();
        let firstCall = true;
        function fireHooks(err: unknown): never {
          const cause: MockCause = { _mockKind: mockAssignCauseKind, error: err };
          for (const h of hooks) {
            // Each hook invokes `Effect.sync(() => logAdminAction(...))`; in
            // the mock `Effect.sync` executes its callback on invocation, so
            // the audit emission lands before we re-throw. Swallow hook
            // errors so the original failure still surfaces.
            try { h.fn(cause); } catch { /* intentionally ignored */ }
          }
          throw err;
        }
        return {
          next(value?: unknown): IteratorResult<unknown, unknown> {
            try {
              return firstCall ? (firstCall = false, inner.next()) : inner.next(value);
            } catch (err) {
              return fireHooks(err);
            }
          },
          // Generator delegation forwards `gen.throw(err)` to the inner
          // iterator's `throw` method when the outer generator is suspended
          // inside a `yield*`. Without this, async-rejection paths (the
          // runEffect mock awaits an Effect.promise sentinel and calls
          // `gen.throw` on rejection) would bypass the tapErrorCause hooks.
          throw(err: unknown): IteratorResult<unknown, unknown> {
            return fireHooks(err);
          },
        };
      },
    });
  };
  return piped;
}

function mockEffectIterable(value: unknown) {
  return withPipe({ [Symbol.iterator]: () => ({ next: () => ({ done: true, value }) }) });
}

// Shim `Cause` + `Option` namespaces so `causeToError` in the route file
// can walk the synthesized MockCause. Real Effect's `Cause` helpers return
// richer types; the mock returns what `causeToError` actually reads.
const mockCause = {
  isInterruptedOnly: (_c: unknown) => false,
  failureOption: (c: MockCause) =>
    c._mockKind === "fail" ? { _tag: "Some" as const, value: c.error } : { _tag: "None" as const },
  defects: (c: MockCause): Iterable<unknown> =>
    c._mockKind === "defect" ? [c.error] : [],
};

const mockOption = {
  isSome: (opt: { _tag: "Some" | "None" }): opt is { _tag: "Some"; value: unknown } =>
    opt._tag === "Some",
};

mock.module("effect", () => {
  const Effect = {
    gen: (genFn: () => Generator) => {
      return { _tag: "EffectGen", genFn };
    },
    promise: (fn: () => Promise<unknown>) => withPipe({
      [Symbol.iterator]: function* (): Generator<unknown, unknown> {
        return yield { _tag: "EffectPromise", fn };
      },
    }),
    tryPromise: (opts: { try: () => Promise<unknown>; catch: (err: unknown) => unknown }) => withPipe({
      [Symbol.iterator]: function* (): Generator<unknown, unknown> {
        return yield { _tag: "EffectPromise", fn: opts.try };
      },
    }),
    succeed: (value: unknown) => mockEffectIterable(value),
    fail: (error: unknown) => withPipe({ [Symbol.iterator]: () => ({ next: () => { throw error; } }) }),
    void: mockEffectIterable(undefined),
    // `Effect.sync(fn)` runs `fn` on invocation so the audit emission lands
    // before the throw unwinds. Returns an iterable that resolves to undefined.
    sync: (fn: () => unknown) => { fn(); return mockEffectIterable(undefined); },
    tapErrorCause: (fn: (cause: MockCause) => unknown): TapErrorCauseMarker => ({
      _tag: "TapErrorCause",
      fn,
    }),
    runPromise: (value: unknown) => Promise.resolve(value),
  };
  return { Effect, Cause: mockCause, Option: mockOption };
});

mock.module("@atlas/api/lib/effect/services", () => ({
  AuthContext: fakeAuthContext,
  RequestContext: { [Symbol.iterator]: function* (): Generator<unknown, unknown> { return yield { requestId: "test-req-1", startTime: Date.now() }; } },
  makeRequestContextLayer: () => ({}),
  makeAuthContextLayer: () => ({}),
}));

// #1986 — Mirror the production tagged-error → HTTP mapping so route tests
// can assert the 409 surfaced by the unsafe-reset guard. Keeping this map
// keyed off `_tag` (the Data.TaggedError discriminant) avoids importing the
// real classes here — tests pass any object with the matching `_tag` and
// `message` and get the realistic Response shape back.
const TAGGED_ERROR_HTTP_MAP: Record<string, { status: number; code: string }> = {
  UnsafeRegionMigrationResetError: { status: 409, code: "conflict" },
};

mock.module("@atlas/api/lib/effect/hono", () => ({
  runEffect: async (_c: unknown, effect: { _tag: string; genFn: () => Generator }, opts?: { domainErrors?: [unknown, Record<string, number>][] }) => {
    try {
      const gen = effect.genFn();
      let result = gen.next();
      while (!result.done) {
        let value = result.value;
        // Resolve Effect.promise sentinels
        if (value && typeof value === "object" && "_tag" in value && value._tag === "EffectPromise") {
          try {
            value = await (value as unknown as { fn: () => Promise<unknown> }).fn();
            result = gen.next(value);
          } catch (err) {
            result = gen.throw(err);
          }
        } else {
          result = gen.next(value);
        }
      }
      return result.value;
    } catch (err) {
      // Classify domain errors (mirrors real classifyError behavior)
      if (opts?.domainErrors && err instanceof Error && "code" in err) {
        for (const [errorClass, statusMap] of opts.domainErrors) {
          if (err instanceof (errorClass as { new (...a: unknown[]): Error })) {
            const code = (err as Error & { code: string }).code;
            const status = statusMap[code] ?? 500;
            return new Response(JSON.stringify({ error: code, message: err.message, requestId: "test-req-1" }), { status });
          }
        }
      }
      // Classify Atlas tagged errors (mirrors mapTaggedError dispatch)
      if (err && typeof err === "object" && "_tag" in err && typeof (err as { _tag?: unknown })._tag === "string") {
        const tag = (err as { _tag: string })._tag;
        const mapping = TAGGED_ERROR_HTTP_MAP[tag];
        if (mapping) {
          const message = (err as { message?: unknown }).message;
          return new Response(
            JSON.stringify({ error: mapping.code, message: typeof message === "string" ? message : tag, requestId: "test-req-1" }),
            { status: mapping.status },
          );
        }
      }
      // Unknown / defect errors land as 500 in production. Return the same
      // shape so tests exercising the defect audit path see the realistic
      // 500 response rather than a raw throw.
      return new Response(
        JSON.stringify({ error: "internal_error", message: "Internal server error", requestId: "test-req-1" }),
        { status: 500 },
      );
    }
  },
  DomainErrorMapping: Array,
  domainError: (cls: unknown, map: unknown) => [cls, map],
}));

// --- Auth mock ---

const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> = mock(
  () =>
    Promise.resolve({
      authenticated: true,
      mode: "simple-key",
      user: {
        id: "admin-1",
        mode: "simple-key",
        label: "Admin",
        role: "admin",
        activeOrganizationId: "org-1",
      },
    }),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mock(() => ({ allowed: true })),
  getClientIP: mock(() => null),
  resetRateLimits: mock(() => {}),
  rateLimitCleanupTick: mock(() => {}),
  _setValidatorOverrides: mock(() => {}),
}));

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "simple-key",
  resetAuthModeCache: () => {},
}));

// --- Internal DB mock ---

let mockHasInternalDB = true;
// Either a data array (resolves) or an Error (rejects) — shared between the
// internalQuery and queryEffect mocks so tests can exercise DB rejection paths.
let mockInternalQueryResult: unknown[] | Error = [];

function invokeInternalQueryMock(): Promise<unknown[]> {
  return mockInternalQueryResult instanceof Error
    ? Promise.reject(mockInternalQueryResult)
    : Promise.resolve(mockInternalQueryResult);
}

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  getInternalDB: () => ({
    query: () => Promise.resolve({ rows: [] }),
    end: async () => {},
    on: () => {},
  }),
  internalQuery: invokeInternalQueryMock,
  queryEffect: () => ({
    [Symbol.iterator]: function* (): Generator<unknown, unknown> {
      return yield { _tag: "EffectPromise", fn: invokeInternalQueryMock };
    },
  }),
  internalExecute: () => {},
  getWorkspaceRegion: () => Promise.resolve(null),
  setWorkspaceRegion: () => Promise.resolve({ assigned: true }),
  insertSemanticAmendment: mock(async () => "mock-amendment-id"),
  getPendingAmendmentCount: mock(async () => 0),
}));

// --- EE residency mock ---

let mockAssignment: { workspaceId: string; region: string; assignedAt: string } | null =
  null;
let mockAssignResult: { workspaceId: string; region: string; assignedAt: string } | null =
  null;
let mockAssignError: Error | null = null;
let mockResidencyConfigured = true;
let mockDefaultRegion = "us-east";
let mockRegions: Record<string, { label: string; databaseUrl: string }> = {
  "us-east": { label: "US East", databaseUrl: "postgresql://us" },
  "eu-west": { label: "EU West", databaseUrl: "postgresql://eu" },
  "ap-southeast": { label: "Asia Pacific", databaseUrl: "postgresql://ap" },
};

class MockResidencyError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ResidencyError";
  }
}

mock.module("@atlas/ee/platform/residency", () => ({
  getDefaultRegion: () => {
    if (!mockResidencyConfigured)
      throw new MockResidencyError("not configured", "not_configured");
    return mockDefaultRegion;
  },
  getConfiguredRegions: () => {
    if (!mockResidencyConfigured)
      throw new MockResidencyError("not configured", "not_configured");
    return mockRegions;
  },
  getWorkspaceRegionAssignment: () => mockEffectIterable(mockAssignment),
  assignWorkspaceRegion: () => {
    if (mockAssignError) {
      return withPipe({
        [Symbol.iterator]: () => ({ next: () => { throw mockAssignError; } }),
      });
    }
    return mockEffectIterable(mockAssignResult);
  },
  ResidencyError: MockResidencyError,
  listRegions: () => mockEffectIterable([]),
  listWorkspaceRegions: () => mockEffectIterable([]),
  resolveRegionDatabaseUrl: () => mockEffectIterable(null),
  isConfiguredRegion: () => true,
}));

mock.module("@atlas/ee/auth/ip-allowlist", () => ({
  checkIPAllowlist: mock(() => ({ allowed: true })),
  listIPAllowlistEntries: mock(async () => []),
  addIPAllowlistEntry: mock(async () => ({})),
  removeIPAllowlistEntry: mock(async () => false),
  IPAllowlistError: class extends Error { constructor(message: string, public readonly code: string) { super(message); this.name = "IPAllowlistError"; } },
}));

// F-53 — admin routes now refine `adminAuth` with `requirePermission()` from
// `@atlas/ee/auth/roles`. Default-allow. Returning bare values (not real
// Effects) matches the test-local `Effect.runPromise` shim above, which
// passes the value through unchanged — a real `Effect.succeed(null)`
// would resolve to the wrapper object and the truthy check inside
// `requirePermission` would 403. ALL named exports admin-roles.ts imports
// must be stubbed: a partial mock surfaces as "Export named 'X' not
// found" at module load time and the admin tree fails to register.
mock.module("@atlas/ee/auth/roles", () => ({
  PERMISSIONS: [
    "query", "query:raw_data", "admin:users", "admin:connections",
    "admin:settings", "admin:audit", "admin:roles", "admin:semantic",
  ] as const,
  isValidPermission: () => true,
  isValidRoleName: () => true,
  BUILTIN_ROLES: [],
  resolvePermissions: () => new Set(),
  hasPermission: () => true,
  checkPermission: () => null,
  listRoles: () => [],
  getRole: () => null,
  getRoleByName: () => null,
  createRole: () => null,
  updateRole: () => null,
  deleteRole: () => true,
  listRoleMembers: () => [],
  assignRole: () => null,
  seedBuiltinRoles: () => undefined,
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

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getRequestContext: () => null,
}));

// --- Audit mock — capture every logAdminAction emission ---

interface CapturedAuditEntry {
  actionType: string;
  targetType: string;
  targetId: string;
  status?: "success" | "failure";
  metadata?: Record<string, unknown>;
  scope?: "platform" | "workspace";
  ipAddress?: string | null;
}

const mockLogAdminAction: Mock<(entry: CapturedAuditEntry) => void> = mock(() => {});

mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: mockLogAdminAction,
  logAdminActionAwait: mock(async () => {}),
  ADMIN_ACTIONS: REAL_ADMIN_ACTIONS,
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  causeToError: () => undefined,
}));

// --- Migration executor mock ---

let mockResetResult: { ok: true } | { ok: false; reason: string; error: string } = { ok: true };
let mockCancelResult: { ok: true } | { ok: false; reason: string; error: string } = { ok: true };
// #1986 — optional throw to exercise the 409 mapping for the unsafe-reset guard
// without dragging in the real migrate module's DB plumbing.
let mockResetThrow: Error | null = null;

mock.module("@atlas/api/lib/residency/migrate", () => ({
  triggerMigrationExecution: () => {},
  failStaleMigrations: () => Promise.resolve(0),
  resetMigrationForRetry: () => {
    if (mockResetThrow) return Promise.reject(mockResetThrow);
    return Promise.resolve(mockResetResult);
  },
  cancelMigration: () => Promise.resolve(mockCancelResult),
}));

mock.module("@atlas/api/lib/cache/index", () => ({
  flushCache: () => {},
  getCache: () => null,
  cacheEnabled: () => false,
  buildCacheKey: () => "",
}));

// --- Import sub-router directly ---

const { adminResidency } = await import("../routes/admin-residency");

// --- Helpers ---

function resetMocks() {
  mockHasInternalDB = true;
  mockAssignment = null;
  mockAssignResult = null;
  mockAssignError = null;
  mockResidencyConfigured = true;
  mockDefaultRegion = "us-east";
  mockRegions = {
    "us-east": { label: "US East", databaseUrl: "postgresql://us" },
    "eu-west": { label: "EU West", databaseUrl: "postgresql://eu" },
    "ap-southeast": { label: "Asia Pacific", databaseUrl: "postgresql://ap" },
  };
  mockInternalQueryResult = [];
  mockResetResult = { ok: true };
  mockResetThrow = null;
  mockCancelResult = { ok: true };
  mockAssignCauseKind = "fail";
  mockEffectUser = {
    id: "admin-1",
    mode: "simple-key",
    label: "Admin",
    role: "admin",
    activeOrganizationId: "org-1",
    orgId: "org-1",
  };
  mockLogAdminAction.mockClear();
  mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "simple-key",
      user: {
        id: "admin-1",
        mode: "simple-key",
        label: "Admin",
        role: "admin",
        activeOrganizationId: "org-1",
      },
    }),
  );
}

async function request(method: string, path = "/", body?: unknown) {
  const init: RequestInit = { method, headers: {} };
  if (body) {
    (init.headers as Record<string, string>)["Content-Type"] =
      "application/json";
    init.body = JSON.stringify(body);
  }
  return adminResidency.request(`http://localhost${path}`, init);
}

// --- Tests ---

describe("GET /api/v1/admin/residency", () => {
  beforeEach(resetMocks);

  it("returns status with no region assigned", async () => {
    const res = await request("GET");
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResidencyStatusResponse;
    expect(json.configured).toBe(true);
    expect(json.region).toBeNull();
    expect(json.availableRegions).toHaveLength(3);
    expect(json.defaultRegion).toBe("us-east");
  });

  it("returns status with region assigned", async () => {
    mockAssignment = {
      workspaceId: "org-1",
      region: "eu-west",
      assignedAt: "2026-03-01T00:00:00Z",
    };
    const res = await request("GET");
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResidencyStatusResponse;
    expect(json.region).toBe("eu-west");
    expect(json.regionLabel).toBe("EU West");
    expect(json.assignedAt).toBe("2026-03-01T00:00:00Z");
  });

  it("returns configured=false when residency not configured", async () => {
    mockResidencyConfigured = false;
    const res = await request("GET");
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResidencyStatusResponse;
    expect(json.configured).toBe(false);
    expect(json.availableRegions).toHaveLength(0);
  });

  it("returns 400 when no active org", async () => {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "simple-key",
        user: {
          id: "admin-1",
          mode: "simple-key",
          label: "Admin",
          role: "admin",
          activeOrganizationId: undefined,
        },
      }),
    );
    const res = await request("GET");
    expect(res.status).toBe(400);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: false,
        status: 401,
        error: "Not authenticated",
      }),
    );
    const res = await request("GET");
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin user", async () => {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: {
          id: "user-1",
          mode: "managed",
          label: "User",
          role: "member",
          activeOrganizationId: "org-1",
        },
      }),
    );
    const res = await request("GET");
    expect(res.status).toBe(403);
  });
});

describe("PUT /api/v1/admin/residency", () => {
  beforeEach(resetMocks);

  it("assigns region successfully", async () => {
    mockAssignResult = {
      workspaceId: "org-1",
      region: "eu-west",
      assignedAt: "2026-03-28T00:00:00Z",
    };
    const res = await request("PUT", "/", { region: "eu-west" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { region: string; workspaceId: string };
    expect(json.region).toBe("eu-west");
    expect(json.workspaceId).toBe("org-1");
  });

  it("returns 409 when region already assigned", async () => {
    mockAssignError = new MockResidencyError(
      'Workspace is already assigned to region "us-east".',
      "already_assigned",
    );
    const res = await request("PUT", "/", { region: "eu-west" });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string; message: string };
    expect(json.message).toContain("already assigned");
  });

  it("returns 400 for invalid region", async () => {
    mockAssignError = new MockResidencyError(
      'Invalid region "mars-1".',
      "invalid_region",
    );
    const res = await request("PUT", "/", { region: "mars-1" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; message: string };
    expect(json.message).toContain("Invalid region");
  });

  it("returns 404 when workspace not found", async () => {
    mockAssignError = new MockResidencyError(
      'Workspace "org-1" not found.',
      "workspace_not_found",
    );
    const res = await request("PUT", "/", { region: "eu-west" });
    expect(res.status).toBe(404);
  });

  it("returns 400 when no active org", async () => {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "simple-key",
        user: {
          id: "admin-1",
          mode: "simple-key",
          label: "Admin",
          role: "admin",
          activeOrganizationId: undefined,
        },
      }),
    );
    const res = await request("PUT", "/", { region: "eu-west" });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /migration — rowToMigration fallback branches
//
// Post-#1696 `RegionMigration` is a discriminated union; `rowToMigration`
// builds the matching variant from the DB row. When columns contradict
// the declared status, the helper sanitizes with a warn log rather than
// 404-ing the caller. These tests lock in each fallback branch.
// ---------------------------------------------------------------------------

describe("GET /migration — rowToMigration fallbacks", () => {
  beforeEach(resetMocks);

  function row(overrides: Record<string, unknown> = {}) {
    return {
      id: "mig-1",
      workspace_id: "org-1",
      source_region: "us-east",
      target_region: "eu-west",
      status: "pending",
      requested_by: "admin-1",
      requested_at: "2026-04-01T00:00:00Z",
      completed_at: null,
      error_message: null,
      ...overrides,
    };
  }

  it("returns null migration when no row exists", async () => {
    mockInternalQueryResult = [];
    const res = await request("GET", "/migration");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { migration: unknown };
    expect(json.migration).toBeNull();
  });

  it("returns a pending migration with nulled terminal fields", async () => {
    mockInternalQueryResult = [row()];
    const res = await request("GET", "/migration");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { migration: { status: string; completedAt: string | null; errorMessage: string | null } };
    expect(json.migration.status).toBe("pending");
    expect(json.migration.completedAt).toBeNull();
    expect(json.migration.errorMessage).toBeNull();
  });

  it("coerces populated completed_at on a pending row back to null", async () => {
    mockInternalQueryResult = [row({ completed_at: "2026-04-02T00:00:00Z", error_message: "stale error" })];
    const res = await request("GET", "/migration");
    const json = (await res.json()) as { migration: { status: string; completedAt: string | null; errorMessage: string | null } };
    expect(json.migration.status).toBe("pending");
    expect(json.migration.completedAt).toBeNull();
    expect(json.migration.errorMessage).toBeNull();
  });

  it("returns a completed migration with its completed_at", async () => {
    mockInternalQueryResult = [row({ status: "completed", completed_at: "2026-04-03T00:00:00Z" })];
    const res = await request("GET", "/migration");
    const json = (await res.json()) as { migration: { status: string; completedAt: string | null; errorMessage: string | null } };
    expect(json.migration.status).toBe("completed");
    expect(json.migration.completedAt).toBe("2026-04-03T00:00:00Z");
    expect(json.migration.errorMessage).toBeNull();
  });

  it("falls back to requested_at when a completed row is missing completed_at", async () => {
    mockInternalQueryResult = [
      row({ status: "completed", completed_at: null, requested_at: "2026-04-04T00:00:00Z" }),
    ];
    const res = await request("GET", "/migration");
    const json = (await res.json()) as { migration: { status: string; completedAt: string | null } };
    expect(json.migration.status).toBe("completed");
    expect(json.migration.completedAt).toBe("2026-04-04T00:00:00Z");
  });

  it("returns a failed migration with populated error_message", async () => {
    mockInternalQueryResult = [
      row({ status: "failed", completed_at: "2026-04-05T00:00:00Z", error_message: "export failed" }),
    ];
    const res = await request("GET", "/migration");
    const json = (await res.json()) as { migration: { status: string; errorMessage: string | null } };
    expect(json.migration.status).toBe("failed");
    expect(json.migration.errorMessage).toBe("export failed");
  });

  it("falls back to a stock error message when a failed row is missing error_message", async () => {
    mockInternalQueryResult = [
      row({ status: "failed", completed_at: "2026-04-05T00:00:00Z", error_message: null }),
    ];
    const res = await request("GET", "/migration");
    const json = (await res.json()) as { migration: { status: string; errorMessage: string | null } };
    expect(json.migration.status).toBe("failed");
    expect(json.migration.errorMessage).toBe("Migration failed (no error message recorded)");
  });

  it("returns a cancelled migration with legacy 'Cancelled by admin' errorMessage", async () => {
    mockInternalQueryResult = [
      row({ status: "cancelled", completed_at: "2026-04-06T00:00:00Z", error_message: "Cancelled by admin" }),
    ];
    const res = await request("GET", "/migration");
    const json = (await res.json()) as { migration: { status: string; errorMessage: string | null } };
    expect(json.migration.status).toBe("cancelled");
    expect(json.migration.errorMessage).toBe("Cancelled by admin");
  });

  it("returns a cancelled migration with null errorMessage", async () => {
    mockInternalQueryResult = [
      row({ status: "cancelled", completed_at: "2026-04-06T00:00:00Z", error_message: null }),
    ];
    const res = await request("GET", "/migration");
    const json = (await res.json()) as { migration: { status: string; errorMessage: string | null } };
    expect(json.migration.status).toBe("cancelled");
    expect(json.migration.errorMessage).toBeNull();
  });

  it("coerces an unknown status string to 'failed'", async () => {
    mockInternalQueryResult = [row({ status: "exploded", completed_at: "2026-04-07T00:00:00Z" })];
    const res = await request("GET", "/migration");
    const json = (await res.json()) as { migration: { status: string; errorMessage: string | null } };
    expect(json.migration.status).toBe("failed");
    // The coercion path still needs an errorMessage (failed variant
    // invariant); falls back to stock string because the row had none.
    expect(json.migration.errorMessage).toBe("Migration failed (no error message recorded)");
  });

  it("returns 404 when internal DB is not available", async () => {
    mockHasInternalDB = false;
    const res = await request("GET", "/migration");
    expect(res.status).toBe(404);
  });
});

describe("POST /migrate — request migration", () => {
  beforeEach(resetMocks);

  it("creates a pending migration with nulled terminal fields", async () => {
    mockAssignment = {
      workspaceId: "org-1",
      region: "us-east",
      assignedAt: "2026-04-01T00:00:00Z",
    };
    // Two internalQuery calls follow: "existing migration" check + rate limit.
    // Both must return empty rows for the handler to proceed to INSERT.
    mockInternalQueryResult = [];
    const res = await request("POST", "/migrate", { targetRegion: "eu-west" });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      status: string;
      completedAt: string | null;
      errorMessage: string | null;
      sourceRegion: string;
      targetRegion: string;
    };
    expect(json.status).toBe("pending");
    expect(json.completedAt).toBeNull();
    expect(json.errorMessage).toBeNull();
    expect(json.sourceRegion).toBe("us-east");
    expect(json.targetRegion).toBe("eu-west");
  });
});

describe("POST /migrate/:id/retry", () => {
  beforeEach(resetMocks);

  it("retries a failed migration successfully", async () => {
    mockInternalQueryResult = [{
      id: "mig-1",
      workspace_id: "org-1",
      source_region: "us-east",
      target_region: "eu-west",
      status: "pending",
      requested_by: "admin-1",
      requested_at: "2026-04-01T00:00:00Z",
      completed_at: null,
      error_message: null,
    }];
    const res = await request("POST", "/migrate/mig-1/retry");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string; status: string };
    expect(json.id).toBe("mig-1");
    expect(json.status).toBe("pending");
  });

  it("returns 400 when migration cannot be retried", async () => {
    mockResetResult = { ok: false, reason: "invalid_status", error: 'Cannot retry migration in "pending" status' };
    const res = await request("POST", "/migrate/mig-1/retry");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; message: string };
    expect(json.error).toBe("retry_failed");
  });

  it("returns 404 when migration not found", async () => {
    mockResetResult = { ok: false, reason: "not_found", error: "Migration not found" };
    const res = await request("POST", "/migrate/mig-nonexistent/retry");
    expect(res.status).toBe(404);
  });

  it("returns 404 when internal DB not available", async () => {
    mockHasInternalDB = false;
    const res = await request("POST", "/migrate/mig-1/retry");
    expect(res.status).toBe(404);
  });

  // #1986 — End-to-end: when resetMigrationForRetry throws the typed
  // UnsafeRegionMigrationResetError (Phase 3 already cut over), the bridge
  // must classify it via mapTaggedError and respond 409, not 400/500.
  it("returns 409 when reset is rejected as unsafe (region already updated)", async () => {
    mockResetThrow = Object.assign(
      new Error("Migration cannot be reset: workspace already moved to eu-west"),
      {
        _tag: "UnsafeRegionMigrationResetError" as const,
        migrationId: "mig-1",
        workspaceId: "org-1",
        targetRegion: "eu-west",
      },
    );
    const res = await request("POST", "/migrate/mig-1/retry");
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string; message: string };
    expect(json.error).toBe("conflict");
    expect(json.message).toContain("already moved");
  });
});

describe("POST /migrate/:id/cancel", () => {
  beforeEach(resetMocks);

  it("cancels a pending migration successfully", async () => {
    const res = await request("POST", "/migrate/mig-1/cancel");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { cancelled: boolean };
    expect(json.cancelled).toBe(true);
  });

  it("returns 400 when migration cannot be cancelled", async () => {
    mockCancelResult = { ok: false, reason: "invalid_status", error: 'Cannot cancel migration in "in_progress" status' };
    const res = await request("POST", "/migrate/mig-1/cancel");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; message: string };
    expect(json.error).toBe("cancel_failed");
  });

  it("returns 404 when migration not found", async () => {
    mockCancelResult = { ok: false, reason: "not_found", error: "Migration not found" };
    const res = await request("POST", "/migrate/mig-nonexistent/cancel");
    expect(res.status).toBe(404);
  });

  it("returns 404 when internal DB not available", async () => {
    mockHasInternalDB = false;
    const res = await request("POST", "/migrate/mig-1/cancel");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// F-32 audit-emission regression tests — admin-residency
//
// Residency is the highest-stakes class in this file. `workspace_assign` is
// permanent — its metadata MUST carry `permanent: true` so triage flags the
// permanence on the audit row. Migration request / retry / cancel are not
// permanent but are still compliance-critical (cross-region data movement).
// ---------------------------------------------------------------------------

describe("admin residency — F-32 audit emission", () => {
  beforeEach(resetMocks);

  it("PUT / emits residency.workspace_assign with permanent:true on success", async () => {
    mockAssignResult = {
      workspaceId: "org-1",
      region: "eu-west",
      assignedAt: "2026-04-23T00:00:00Z",
    };
    const res = await request("PUT", "/", { region: "eu-west" });
    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("residency.workspace_assign");
    expect(entry.targetType).toBe("residency");
    expect(entry.targetId).toBe("org-1");
    expect(entry.metadata?.region).toBe("eu-west");
    // F-32 acceptance criteria: `permanent: true` must be in metadata so
    // compliance triage knows this row represents an irreversible state
    // change, not a routine config tweak.
    expect(entry.metadata?.permanent).toBe(true);
  });

  it("PUT / emits residency.workspace_assign with status=failure on typed failure (409 probe)", async () => {
    // Permanent decisions deserve failure audits — the attempt itself is
    // useful evidence. Without this, a 409 "already assigned" probe that
    // reveals the current region leaves no forensic record.
    mockAssignError = new MockResidencyError(
      'Workspace is already assigned to region "us-east".',
      "already_assigned",
    );
    const res = await request("PUT", "/", { region: "eu-west" });
    expect(res.status).toBe(409);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("residency.workspace_assign");
    expect(entry.status).toBe("failure");
    expect(entry.metadata?.region).toBe("eu-west");
    expect(entry.metadata?.permanent).toBe(true);
    // metadata.error must carry the conflict reason so forensic queries
    // can distinguish a probe from a legitimate misconfiguration without
    // cross-referencing pino logs.
    expect(entry.metadata?.error).toContain("already assigned");
  });

  it("PUT / emits failure audit on DEFECT path (rejected Effect.promise, not typed failure)", async () => {
    // `assignWorkspaceRegion` wraps `setWorkspaceRegion` in `Effect.promise`,
    // so pg pool exhaustion / network drops surface as defects, not typed
    // failures. `Effect.tapError` alone would drop the audit row on the
    // exact infrastructure-failure path a malicious admin would probe for.
    // `tapErrorCause` + `causeToError` closes that gap.
    mockAssignCauseKind = "defect";
    mockAssignError = new Error("pg connection refused");
    const res = await request("PUT", "/", { region: "eu-west" });
    expect(res.status).toBe(500);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("residency.workspace_assign");
    expect(entry.status).toBe("failure");
    expect(entry.metadata?.permanent).toBe(true);
    expect(entry.metadata?.error).toContain("pg connection refused");
  });

  it("PUT / failure audit scrubs URI credentials from error metadata", async () => {
    // pg error text routinely echoes the connection string. If that lands
    // verbatim in admin_action_log.metadata, the DB password leaks into the
    // audit row compliance reviewers read directly. The local
    // `errorMessage` helper must scrub `proto://user:pass@host` userinfo.
    mockAssignError = new MockResidencyError(
      "setWorkspaceRegion failed: postgresql://admin:s3cret@db.internal/atlas — timeout",
      "invalid_region",
    );
    await request("PUT", "/", { region: "eu-west" });
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    const errText = entry.metadata?.error;
    expect(typeof errText).toBe("string");
    expect(errText).toContain("postgresql://***@");
    expect(errText).not.toContain("s3cret");
    expect(errText).not.toContain("admin:s3cret");
  });

  it("POST /migrate emits residency.migration_request with source/target regions", async () => {
    mockAssignment = {
      workspaceId: "org-1",
      region: "us-east",
      assignedAt: "2026-04-01T00:00:00Z",
    };
    // Two internalQuery calls follow (existing + rate-limit) then INSERT;
    // empty rows flow through the handler to the audit emit.
    mockInternalQueryResult = [];
    const res = await request("POST", "/migrate", { targetRegion: "eu-west" });
    expect(res.status).toBe(201);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("residency.migration_request");
    expect(entry.targetType).toBe("residency");
    expect(entry.metadata?.sourceRegion).toBe("us-east");
    expect(entry.metadata?.targetRegion).toBe("eu-west");
  });

  it("POST /migrate/:id/retry emits residency.migration_retry on success", async () => {
    mockInternalQueryResult = [
      {
        id: "mig-1",
        workspace_id: "org-1",
        source_region: "us-east",
        target_region: "eu-west",
        status: "pending",
        requested_by: "admin-1",
        requested_at: "2026-04-01T00:00:00Z",
        completed_at: null,
        error_message: null,
      },
    ];
    const res = await request("POST", "/migrate/mig-1/retry");
    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("residency.migration_retry");
    expect(entry.targetType).toBe("residency");
    expect(entry.targetId).toBe("mig-1");
  });

  it("POST /migrate/:id/retry emits a failure audit when retry is rejected", async () => {
    // Rejected retries are compliance-relevant: a 4xx here can fingerprint a
    // probe (operator attempting to undo a half-completed cross-region cutover).
    // The runbook requires a forensic trail showing every guard outcome; the
    // route emits a `status: "failure"` audit with the rejection reason.
    mockResetResult = { ok: false, reason: "invalid_status", error: "Cannot retry" };
    const res = await request("POST", "/migrate/mig-1/retry");
    expect(res.status).toBe(400);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("residency.migration_retry");
    expect(entry.status).toBe("failure");
    expect(entry.metadata.reason).toBe("invalid_status");
  });

  it("POST /migrate/:id/retry emits a failure audit when reset throws (409 path)", async () => {
    // The unsafe-reset throw path must also land an audit. tapErrorCause fires
    // before the bridge converts the tagged error to 409, so the forensic
    // trail captures the most compliance-relevant outcome in this file.
    mockResetThrow = Object.assign(
      new Error("Migration cannot be reset: workspace already moved to eu-west"),
      {
        _tag: "UnsafeRegionMigrationResetError" as const,
        migrationId: "mig-1",
        workspaceId: "org-1",
        targetRegion: "eu-west",
        sourceRegion: "us-east",
      },
    );
    const res = await request("POST", "/migrate/mig-1/retry");
    expect(res.status).toBe(409);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("residency.migration_retry");
    expect(entry.status).toBe("failure");
    expect(entry.metadata.error).toContain("already moved");
  });

  it("POST /migrate/:id/cancel emits residency.migration_cancel on success", async () => {
    const res = await request("POST", "/migrate/mig-1/cancel");
    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("residency.migration_cancel");
    expect(entry.targetType).toBe("residency");
    expect(entry.targetId).toBe("mig-1");
  });

  it("POST /migrate/:id/cancel does NOT emit audit when cancel is rejected", async () => {
    // Symmetric to the retry case — pre-handler rejection means the migration
    // wasn't actually cancelled, so no audit row should land.
    mockCancelResult = {
      ok: false,
      reason: "invalid_status",
      error: "Cannot cancel in_progress migration",
    };
    const res = await request("POST", "/migrate/mig-1/cancel");
    expect(res.status).toBe(400);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("GET / does not emit an audit row (read endpoint)", async () => {
    const res = await request("GET");
    expect(res.status).toBe(200);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("GET /migration does not emit an audit row (read endpoint)", async () => {
    mockInternalQueryResult = [];
    const res = await request("GET", "/migration");
    expect(res.status).toBe(200);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});

// --- Type helpers ---

interface ResidencyStatusResponse {
  configured: boolean;
  region: string | null;
  regionLabel: string | null;
  assignedAt: string | null;
  defaultRegion: string;
  availableRegions: Array<{
    id: string;
    label: string;
    isDefault: boolean;
  }>;
}
