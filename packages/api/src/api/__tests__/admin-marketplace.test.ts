/**
 * Tests for plugin marketplace API endpoints.
 *
 * Tests the platformCatalog and workspaceMarketplace sub-routers directly
 * (not through the parent admin router) to avoid needing to mock every
 * sub-router dependency.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";

// --- Audit capture ---
// Intercept every logAdminAction emission so tests can assert audit shape.
// Mocked at module level so the route module binds to this mock when first
// imported below.

interface CapturedAuditEntry {
  actionType: string;
  targetType: string;
  targetId: string;
  status?: "success" | "failure";
  metadata?: Record<string, unknown>;
  scope?: "platform" | "workspace";
  ipAddress?: string | null;
}

const mockLogAdminAction: Mock<(entry: CapturedAuditEntry) => void> = mock(
  () => {},
);

mock.module("@atlas/api/lib/audit", async () => {
  const actual = await import("@atlas/api/lib/audit/actions");
  return {
    logAdminAction: mockLogAdminAction,
    logAdminActionAwait: mock(async () => {}),
    ADMIN_ACTIONS: actual.ADMIN_ACTIONS,
  };
});

// --- Effect mock ---
// Mock the Effect bridge so the route file can load and execute without
// the full Effect runtime. Effect.gen + runEffect are shimmed to execute
// the generator directly, resolving yield* calls to mocked services.

const mockEffectUser: Record<string, unknown> = {
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

// EffectPromise carries a list of error taps (side-effect handlers run before
// the error propagates into the generator). `.pipe(Effect.tapError(fn))` on
// the queryEffect return decorates this list so the catch block in runEffect
// runs the taps before calling `gen.throw()`. Any operator beyond tapError
// (map, catchAll, flatMap, zip, race) is not implemented — if a route starts
// using one, extend the shim. For failure-path branching, routes use plain
// try/catch around `yield* queryEffect(...)` which works under both real
// Effect and this shim.
interface TestEffectPromise {
  _tag: "EffectPromise";
  fn: () => Promise<unknown>;
  errorTaps: Array<(err: unknown) => unknown>;
}

interface TestPipeable {
  [Symbol.iterator]: () => Generator<unknown, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pipe is variadic across operator types
  pipe(...ops: Array<(source: TestPipeable) => any>): any;
}

function makePipeable(effectValue: TestEffectPromise): TestPipeable {
  const pipeable: TestPipeable = {
    [Symbol.iterator]: function* (): Generator<unknown, unknown> {
      return yield effectValue;
    },
    pipe(...ops) {
      let current: TestPipeable = pipeable;
      for (const op of ops) current = op(current);
      return current;
    },
  };
  return pipeable;
}

mock.module("effect", () => {
  const Effect = {
    gen: (genFn: () => Generator) => {
      return { _tag: "EffectGen", genFn };
    },
    promise: (fn: () => Promise<unknown>) => {
      const effectValue: TestEffectPromise = { _tag: "EffectPromise", fn, errorTaps: [] };
      return makePipeable(effectValue);
    },
    // Support Effect.runPromise for routes that unwrap Effect-returning EE functions
    runPromise: (value: unknown) => {
      return Promise.resolve(value);
    },
    sync: (syncFn: () => unknown) => ({ _tag: "EffectSync", fn: syncFn }),
    // tapError attaches a handler that runs before the error propagates.
    // The handler returns another Effect (typically Effect.sync(...)) — if
    // it's an EffectSync we run its fn inline for the side effect (test-only
    // shim; real Effect composes them asynchronously).
    tapError: (handler: (err: unknown) => unknown) => (source: TestPipeable) => {
      const originalIterator = source[Symbol.iterator].bind(source);
      const newPipeable: TestPipeable = {
        [Symbol.iterator]: function* (): Generator<unknown, unknown> {
          const gen = originalIterator();
          let next = gen.next();
          while (!next.done) {
            const value = next.value;
            if (value && typeof value === "object" && (value as { _tag?: string })._tag === "EffectPromise") {
              (value as TestEffectPromise).errorTaps.push(handler);
            }
            const piped = yield value;
            next = gen.next(piped);
          }
          return next.value;
        },
        pipe: source.pipe.bind(source),
      };
      return newPipeable;
    },
  };
  return { Effect };
});

mock.module("@atlas/api/lib/effect/services", () => ({
  AuthContext: fakeAuthContext,
  RequestContext: { [Symbol.iterator]: function* (): Generator<unknown, unknown> { return yield { requestId: "test-req-1", startTime: Date.now() }; } },
  makeRequestContextLayer: () => ({}),
  makeAuthContextLayer: () => ({}),
}));

mock.module("@atlas/api/lib/effect/hono", () => ({
  runEffect: async (_c: unknown, effect: { _tag: string; genFn: () => Generator }, _opts?: unknown) => {
    const gen = effect.genFn();
    let result = gen.next();
    while (!result.done) {
      const value = result.value;
      if (value && typeof value === "object" && (value as { _tag?: string })._tag === "EffectPromise") {
        const promiseValue = value as TestEffectPromise;
        try {
          const resolved = await promiseValue.fn();
          result = gen.next(resolved);
        } catch (err) {
          // Run any error taps attached via .pipe(Effect.tapError(...)) BEFORE
          // the error enters the generator. Matches real Effect behavior
          // observationally: tap runs, then error propagates. (Real Effect
          // composes these in the error channel asynchronously; the shim
          // inlines them — the end-state is the same for our assertions.)
          for (const tap of promiseValue.errorTaps) {
            try {
              const tapResult = tap(err);
              if (
                tapResult &&
                typeof tapResult === "object" &&
                (tapResult as { _tag?: string })._tag === "EffectSync"
              ) {
                (tapResult as { fn: () => unknown }).fn();
              }
            } catch {
              // tap failures must not swallow the original error
            }
          }
          result = gen.throw(err);
        }
      } else {
        result = gen.next(value);
      }
    }
    return result.value;
  },
  DomainErrorMapping: Array,
}));

// --- Middleware mock ---
// Mock the middleware and admin-router modules so that auth, rate limiting,
// and org-context extraction are bypassed. Test apps set context vars directly.

import { createMiddleware } from "hono/factory";

const passthrough = createMiddleware(async (_c, next) => { await next(); });

mock.module("./routes/middleware", () => ({
  adminAuth: passthrough,
  platformAdminAuth: passthrough,
  requestContext: passthrough,
  standardAuth: passthrough,
  withRequestId: passthrough,
}));

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mock(() =>
    Promise.resolve({
      authenticated: true,
      mode: "simple-key",
      user: { id: "admin-1", role: "platform_admin", activeOrganizationId: "org-1" },
    }),
  ),
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

mock.module("@atlas/ee/auth/ip-allowlist", () => ({
  checkIPAllowlist: mock(() => ({ allowed: true })),
  listIPAllowlistEntries: mock(async () => []),
  addIPAllowlistEntry: mock(async () => ({})),
  removeIPAllowlistEntry: mock(async () => false),
  IPAllowlistError: class extends Error { constructor(message: string, public readonly code: string) { super(message); this.name = "IPAllowlistError"; } },
}));

// --- Internal DB mock ---

let mockHasInternalDB = true;
// Map SQL fragment → rows (normal case) or Error (rejection). Using a union
// means tests can set `mockQueryResults.set("prompt_catalog", new Error("db down"))`
// and drive both the internalQuery and queryEffect mocks down the failure path.
let mockQueryResults: Map<string, unknown[] | Error> = new Map();

/**
 * Every (sql, params) pair issued by the route under test. Tests asserting
 * what was persisted (e.g. secret restoration in a PUT config round-trip) pop
 * matching entries out of here. Cleared in each `beforeEach` alongside
 * `mockQueryResults`.
 */
let capturedQueries: Array<{ sql: string; params: unknown[] }> = [];

function setQueryResult(pattern: string, rows: unknown[] | Error) {
  mockQueryResults.set(pattern, rows);
}

function findQueryResult(sql: string): unknown[] | Error {
  for (const [pattern, rows] of mockQueryResults) {
    if (sql.includes(pattern)) return rows;
  }
  return [];
}

function invokeInternalQueryMock(sql: string, params: unknown[] = []): Promise<unknown[]> {
  capturedQueries.push({ sql, params });
  const result = findQueryResult(sql);
  return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
}

function findCapturedQuery(pattern: string): { sql: string; params: unknown[] } | undefined {
  return capturedQueries.find((q) => q.sql.includes(pattern));
}

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  getInternalDB: () => ({
    query: () => Promise.resolve({ rows: [] }),
    end: async () => {},
    on: () => {},
  }),
  internalQuery: (sql: string, params?: unknown[]) => invokeInternalQueryMock(sql, params),
  queryEffect: (sql: string, params?: unknown[]) => {
    const effectValue: TestEffectPromise = {
      _tag: "EffectPromise",
      fn: () => invokeInternalQueryMock(sql, params),
      errorTaps: [],
    };
    return makePipeable(effectValue);
  },
  internalExecute: () => {},
  setWorkspaceRegion: mock(async () => {}),
  insertSemanticAmendment: mock(async () => "mock-amendment-id"),
  getPendingAmendmentCount: mock(async () => 0),
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

// --- Import routes after mocks ---

const { platformCatalog, workspaceMarketplace } = await import("../routes/admin-marketplace");
const { OpenAPIHono } = await import("@hono/zod-openapi");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildPlatformApp() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper bypasses typed env
  const app = new OpenAPIHono<any>();
  app.use(async (c, next) => {
    c.set("requestId", "test-req-1");
    c.set("authResult", {
      authenticated: true,
      mode: "simple-key",
      user: { id: "admin-1", role: "platform_admin", activeOrganizationId: "org-1" },
    });
    await next();
  });
  app.route("/catalog", platformCatalog);
  return app;
}

function buildWorkspaceApp() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper bypasses typed env
  const app = new OpenAPIHono<any>();
  app.use(async (c, next) => {
    c.set("requestId", "test-req-1");
    c.set("authResult", {
      authenticated: true,
      mode: "simple-key",
      user: { id: "admin-1", role: "admin", activeOrganizationId: "org-1" },
    });
    c.set("orgContext", { requestId: "test-req-1", orgId: "org-1" });
    await next();
  });
  app.route("/marketplace", workspaceMarketplace);
  return app;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper for untyped JSON responses
const json = (res: Response) => res.json() as Promise<any>;

const now = new Date().toISOString();

const sampleCatalogRow = {
  id: "cat-1",
  name: "BigQuery",
  slug: "bigquery",
  description: "Google BigQuery datasource",
  type: "datasource",
  npm_package: "@useatlas/bigquery",
  icon_url: null,
  config_schema: null,
  min_plan: "starter",
  enabled: true,
  created_at: now,
  updated_at: now,
};

// ---------------------------------------------------------------------------
// Platform Catalog CRUD
// ---------------------------------------------------------------------------

describe("Platform Plugin Catalog", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockQueryResults = new Map();
    capturedQueries = [];
  });

  describe("GET /catalog", () => {
    it("lists all catalog entries", async () => {
      setQueryResult("SELECT * FROM plugin_catalog ORDER BY", [sampleCatalogRow]);

      const app = buildPlatformApp();
      const res = await app.request("/catalog");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].slug).toBe("bigquery");
      expect(body.total).toBe(1);
    });

    it("returns 404 when no internal DB", async () => {
      mockHasInternalDB = false;
      const app = buildPlatformApp();
      const res = await app.request("/catalog");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /catalog", () => {
    it("creates a catalog entry", async () => {
      // No existing slug
      setQueryResult("SELECT id FROM plugin_catalog WHERE slug", []);
      // INSERT returns the new row
      setQueryResult("INSERT INTO plugin_catalog", [sampleCatalogRow]);

      const app = buildPlatformApp();
      const res = await app.request("/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "BigQuery",
          slug: "bigquery",
          type: "datasource",
          npmPackage: "@useatlas/bigquery",
        }),
      });
      expect(res.status).toBe(201);
      const body = await json(res);
      expect(body.slug).toBe("bigquery");
    });

    it("returns 409 on duplicate slug", async () => {
      setQueryResult("SELECT id FROM plugin_catalog WHERE slug", [{ id: "existing" }]);

      const app = buildPlatformApp();
      const res = await app.request("/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "BigQuery",
          slug: "bigquery",
          type: "datasource",
        }),
      });
      expect(res.status).toBe(409);
    });
  });

  describe("PUT /catalog/:id", () => {
    it("updates a catalog entry", async () => {
      setQueryResult("UPDATE plugin_catalog", [{ ...sampleCatalogRow, name: "BigQuery v2" }]);

      const app = buildPlatformApp();
      const res = await app.request("/catalog/cat-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "BigQuery v2" }),
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.name).toBe("BigQuery v2");
    });

    it("returns 404 for non-existent entry", async () => {
      setQueryResult("UPDATE plugin_catalog", []);

      const app = buildPlatformApp();
      const res = await app.request("/catalog/nonexistent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated" }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 400 with empty body", async () => {
      const app = buildPlatformApp();
      const res = await app.request("/catalog/cat-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /catalog/:id", () => {
    it("deletes a catalog entry", async () => {
      // Route fetches slug + count before the delete so the audit row
      // captures both even after FK cascade wipes the row.
      setQueryResult("SELECT slug FROM plugin_catalog WHERE id", [{ slug: "bigquery" }]);
      setQueryResult("SELECT COUNT(*)::int AS count FROM workspace_plugins", [{ count: 0 }]);
      setQueryResult("DELETE FROM plugin_catalog", [{ id: "cat-1" }]);

      const app = buildPlatformApp();
      const res = await app.request("/catalog/cat-1", { method: "DELETE" });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.deleted).toBe(true);
    });

    it("returns 404 for non-existent entry", async () => {
      // Pre-lookup returns zero rows — handler short-circuits before the DELETE.
      setQueryResult("SELECT slug FROM plugin_catalog WHERE id", []);

      const app = buildPlatformApp();
      const res = await app.request("/catalog/nonexistent", { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });
});

// ---------------------------------------------------------------------------
// Workspace Plugin Installations
// ---------------------------------------------------------------------------

describe("Workspace Plugin Marketplace", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockQueryResults = new Map();
    capturedQueries = [];
  });

  describe("GET /marketplace/available", () => {
    it("lists available plugins filtered by plan", async () => {
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "starter" }]);
      setQueryResult("SELECT * FROM plugin_catalog WHERE enabled", [
        sampleCatalogRow,
        { ...sampleCatalogRow, id: "cat-2", slug: "enterprise-only", min_plan: "business" },
      ]);
      setQueryResult("SELECT catalog_id, id, config FROM workspace_plugins", []);

      const app = buildWorkspaceApp();
      const res = await app.request("/marketplace/available");
      expect(res.status).toBe(200);
      const body = await json(res);
      // Should filter out enterprise-only plugin for team plan
      expect(body.plugins).toHaveLength(1);
      expect(body.plugins[0].slug).toBe("bigquery");
      expect(body.plugins[0].installed).toBe(false);
    });

    it("marks installed plugins", async () => {
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "starter" }]);
      setQueryResult("SELECT * FROM plugin_catalog WHERE enabled", [sampleCatalogRow]);
      setQueryResult("SELECT catalog_id, id, config FROM workspace_plugins", [
        { catalog_id: "cat-1", id: "inst-1", config: { host: "localhost" } },
      ]);

      const app = buildWorkspaceApp();
      const res = await app.request("/marketplace/available");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.plugins[0].installed).toBe(true);
      expect(body.plugins[0].installationId).toBe("inst-1");
      expect(body.plugins[0].installedConfig).toEqual({ host: "localhost" });
    });

    it("masks secret: true fields in installedConfig and leaves non-secret fields untouched (F-43 #1817)", async () => {
      // Catalog advertises one secret field + one non-secret. Installed row
      // holds concrete values. The response must hide only the secret; any
      // leak would let a workspace admin read the live credential.
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "starter" }]);
      setQueryResult("SELECT * FROM plugin_catalog WHERE enabled", [
        {
          ...sampleCatalogRow,
          config_schema: [
            { key: "apiKey", type: "string", secret: true },
            { key: "region", type: "string" },
          ],
        },
      ]);
      setQueryResult("SELECT catalog_id, id, config FROM workspace_plugins", [
        { catalog_id: "cat-1", id: "inst-1", config: { apiKey: "sk-live-12345", region: "us-east-1" } },
      ]);

      const app = buildWorkspaceApp();
      const res = await app.request("/marketplace/available");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.plugins[0].installedConfig.apiKey).toBe("••••••••");
      expect(body.plugins[0].installedConfig.region).toBe("us-east-1");
      // Exact-match the placeholder string — drifting from admin-plugins.ts
      // would confuse the write-path restoration guard.
      expect(body.plugins[0].installedConfig.apiKey).not.toContain("sk-live");
    });

    it("leaves null installedConfig unchanged when plugin is not installed", async () => {
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "starter" }]);
      setQueryResult("SELECT * FROM plugin_catalog WHERE enabled", [
        {
          ...sampleCatalogRow,
          config_schema: [{ key: "apiKey", type: "string", secret: true }],
        },
      ]);
      setQueryResult("SELECT catalog_id, id, config FROM workspace_plugins", []);

      const app = buildWorkspaceApp();
      const res = await app.request("/marketplace/available");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.plugins[0].installed).toBe(false);
      expect(body.plugins[0].installedConfig).toBeNull();
    });
  });

  describe("POST /marketplace/install", () => {
    it("installs a plugin", async () => {
      setQueryResult("SELECT * FROM plugin_catalog WHERE id", [sampleCatalogRow]);
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "starter" }]);
      setQueryResult("SELECT id FROM workspace_plugins WHERE workspace_id", []);
      setQueryResult("INSERT INTO workspace_plugins", [{
        id: "inst-1",
        workspace_id: "org-1",
        catalog_id: "cat-1",
        config: {},
        enabled: true,
        installed_at: now,
        installed_by: "admin-1",
        name: "BigQuery",
        slug: "bigquery",
        type: "datasource",
        description: "Google BigQuery datasource",
      }]);

      const app = buildWorkspaceApp();
      const res = await app.request("/marketplace/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ catalogId: "cat-1" }),
      });
      expect(res.status).toBe(201);
      const body = await json(res);
      expect(body.catalogId).toBe("cat-1");
      expect(body.name).toBe("BigQuery");
    });

    it("rejects when plan is insufficient", async () => {
      setQueryResult("SELECT * FROM plugin_catalog WHERE id", [
        { ...sampleCatalogRow, min_plan: "business" },
      ]);
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "starter" }]);
      setQueryResult("SELECT id FROM workspace_plugins WHERE workspace_id", []);

      const app = buildWorkspaceApp();
      const res = await app.request("/marketplace/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ catalogId: "cat-1" }),
      });
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toBe("plan_ineligible");
    });

    it("returns 409 when already installed", async () => {
      setQueryResult("SELECT * FROM plugin_catalog WHERE id", [sampleCatalogRow]);
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "starter" }]);
      setQueryResult("SELECT id FROM workspace_plugins WHERE workspace_id", [{ id: "inst-1" }]);

      const app = buildWorkspaceApp();
      const res = await app.request("/marketplace/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ catalogId: "cat-1" }),
      });
      expect(res.status).toBe(409);
    });

    it("returns 404 for non-existent catalog entry", async () => {
      setQueryResult("SELECT * FROM plugin_catalog WHERE id", []);

      const app = buildWorkspaceApp();
      const res = await app.request("/marketplace/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ catalogId: "nonexistent" }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /marketplace/:id", () => {
    it("uninstalls a plugin", async () => {
      setQueryResult("DELETE FROM workspace_plugins WHERE id", [{ id: "inst-1" }]);

      const app = buildWorkspaceApp();
      const res = await app.request("/marketplace/inst-1", { method: "DELETE" });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.deleted).toBe(true);
    });

    it("returns 404 for non-existent installation", async () => {
      setQueryResult("DELETE FROM workspace_plugins WHERE id", []);

      const app = buildWorkspaceApp();
      const res = await app.request("/marketplace/nonexistent", { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /marketplace/:id/config", () => {
    it("updates plugin config", async () => {
      // Pre-SELECT: current config + catalog schema (for secret restoration).
      setQueryResult("FROM workspace_plugins wp", [
        { config: { key: "old-value" }, config_schema: null },
      ]);
      setQueryResult("UPDATE workspace_plugins", [{
        id: "inst-1",
        workspace_id: "org-1",
        catalog_id: "cat-1",
        config: { key: "new-value" },
        enabled: true,
        installed_at: now,
        installed_by: "admin-1",
        name: "BigQuery",
        slug: "bigquery",
        type: "datasource",
        description: "Google BigQuery datasource",
      }]);

      const app = buildWorkspaceApp();
      const res = await app.request("/marketplace/inst-1/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: { key: "new-value" } }),
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.config).toEqual({ key: "new-value" });
    });

    it("round-trips MASKED_PLACEHOLDER: PUT leaves the stored secret intact (F-43 #1817)", async () => {
      // A UI that renders the masked GET /available response will echo
      // "••••••••" back on save for any secret the admin didn't touch.
      // Without restoration, this PUT would overwrite the live credential
      // with the placeholder — turning a disclosure bug into a corruption
      // bug.
      setQueryResult("FROM workspace_plugins wp", [
        {
          config: { apiKey: "sk-live-12345", region: "us-east-1" },
          config_schema: [
            { key: "apiKey", type: "string", secret: true },
            { key: "region", type: "string" },
          ],
        },
      ]);
      setQueryResult("UPDATE workspace_plugins", [{
        id: "inst-1",
        workspace_id: "org-1",
        catalog_id: "cat-1",
        config: { apiKey: "sk-live-12345", region: "eu-west-1" },
        enabled: true,
        installed_at: now,
        installed_by: "admin-1",
        name: "BigQuery",
        slug: "bigquery",
        type: "datasource",
        description: "Google BigQuery datasource",
      }]);

      const app = buildWorkspaceApp();
      const res = await app.request("/marketplace/inst-1/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: { apiKey: "••••••••", region: "eu-west-1" },
        }),
      });
      expect(res.status).toBe(200);

      // The persisted config blob is param[0] of the UPDATE (stringified JSON).
      const updateCall = findCapturedQuery("UPDATE workspace_plugins");
      expect(updateCall).toBeDefined();
      const persisted = JSON.parse(updateCall!.params[0] as string) as Record<string, unknown>;
      expect(persisted.apiKey).toBe("sk-live-12345"); // original preserved
      expect(persisted.apiKey).not.toBe("••••••••");  // placeholder stripped
      expect(persisted.region).toBe("eu-west-1");     // non-secret passed through
    });

    it("rotates a secret when the admin submits a new value (not the placeholder)", async () => {
      setQueryResult("FROM workspace_plugins wp", [
        {
          config: { apiKey: "sk-old" },
          config_schema: [{ key: "apiKey", type: "string", secret: true }],
        },
      ]);
      setQueryResult("UPDATE workspace_plugins", [{
        id: "inst-1",
        workspace_id: "org-1",
        catalog_id: "cat-1",
        config: { apiKey: "sk-new" },
        enabled: true,
        installed_at: now,
        installed_by: "admin-1",
      }]);

      const app = buildWorkspaceApp();
      const res = await app.request("/marketplace/inst-1/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: { apiKey: "sk-new" } }),
      });
      expect(res.status).toBe(200);
      const updateCall = findCapturedQuery("UPDATE workspace_plugins");
      const persisted = JSON.parse(updateCall!.params[0] as string) as Record<string, unknown>;
      expect(persisted.apiKey).toBe("sk-new");
    });

    it("returns 404 when the pre-fetch finds no installation", async () => {
      setQueryResult("FROM workspace_plugins wp", []);

      const app = buildWorkspaceApp();
      const res = await app.request("/marketplace/nonexistent/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: {} }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 for non-existent installation", async () => {
      setQueryResult("FROM workspace_plugins wp", [{ config: {}, config_schema: null }]);
      setQueryResult("UPDATE workspace_plugins", []);

      const app = buildWorkspaceApp();
      const res = await app.request("/marketplace/nonexistent/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: {} }),
      });
      expect(res.status).toBe(404);
    });
  });
});

// ---------------------------------------------------------------------------
// Audit emission across catalog + marketplace write routes
// ---------------------------------------------------------------------------

describe("audit emission — Platform catalog", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockQueryResults = new Map();
    capturedQueries = [];
    mockLogAdminAction.mockClear();
  });

  describe("POST /catalog — plugin.catalog_create", () => {
    it("emits exactly one plugin.catalog_create audit on success", async () => {
      setQueryResult("SELECT id FROM plugin_catalog WHERE slug", []);
      setQueryResult("INSERT INTO plugin_catalog", [sampleCatalogRow]);

      const app = buildPlatformApp();
      const res = await app.request("/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "BigQuery",
          slug: "bigquery",
          type: "datasource",
          npmPackage: "@useatlas/bigquery",
        }),
      });
      expect(res.status).toBe(201);
      expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
      const entry = mockLogAdminAction.mock.calls[0]![0];
      expect(entry.actionType).toBe("plugin.catalog_create");
      expect(entry.targetType).toBe("plugin");
      expect(entry.scope).toBe("platform");
      expect(entry.metadata).toMatchObject({ pluginSlug: "bigquery" });
      expect(entry.metadata!.pluginId).toBeString();
    });

    it("emits status=failure when INSERT throws", async () => {
      setQueryResult("SELECT id FROM plugin_catalog WHERE slug", []);
      setQueryResult("INSERT INTO plugin_catalog", new Error("db insert failed"));

      const app = buildPlatformApp();
      const res = await app.request("/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "X", slug: "x", type: "datasource" }),
      });
      expect(res.status).toBe(500);
      expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
      const entry = mockLogAdminAction.mock.calls[0]![0];
      expect(entry.actionType).toBe("plugin.catalog_create");
      expect(entry.status).toBe("failure");
      expect(entry.metadata!.pluginSlug).toBe("x");
      expect(entry.metadata!.error).toContain("db insert failed");
    });

    it("does not emit audit on duplicate slug (pre-handler rejection)", async () => {
      setQueryResult("SELECT id FROM plugin_catalog WHERE slug", [{ id: "existing" }]);

      const app = buildPlatformApp();
      const res = await app.request("/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "BigQuery", slug: "bigquery", type: "datasource" }),
      });
      expect(res.status).toBe(409);
      expect(mockLogAdminAction).not.toHaveBeenCalled();
    });
  });

  describe("PUT /catalog/:id — plugin.catalog_update", () => {
    it("emits exactly one plugin.catalog_update audit with keysChanged", async () => {
      setQueryResult("UPDATE plugin_catalog", [{ ...sampleCatalogRow, name: "BigQuery v2" }]);

      const app = buildPlatformApp();
      const res = await app.request("/catalog/cat-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "BigQuery v2", enabled: false }),
      });
      expect(res.status).toBe(200);
      expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
      const entry = mockLogAdminAction.mock.calls[0]![0];
      expect(entry.actionType).toBe("plugin.catalog_update");
      expect(entry.targetId).toBe("cat-1");
      expect(entry.scope).toBe("platform");
      expect(entry.metadata!.pluginSlug).toBe("bigquery");
      expect(entry.metadata!.keysChanged).toEqual(["enabled", "name"]);
    });

    it("emits status=failure when UPDATE throws — carries pluginSlug from pre-lookup", async () => {
      // Pre-lookup succeeds, UPDATE fails. Failure audit includes the slug
      // even though the UPDATE never returned a row.
      setQueryResult("SELECT slug FROM plugin_catalog WHERE id", [{ slug: "bigquery" }]);
      setQueryResult("UPDATE plugin_catalog", new Error("db update failed"));

      const app = buildPlatformApp();
      const res = await app.request("/catalog/cat-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "X" }),
      });
      expect(res.status).toBe(500);
      expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
      const entry = mockLogAdminAction.mock.calls[0]![0];
      expect(entry.actionType).toBe("plugin.catalog_update");
      expect(entry.status).toBe("failure");
      expect(entry.metadata!.pluginSlug).toBe("bigquery");
      expect(entry.metadata!.keysChanged).toEqual(["name"]);
    });

    it("emits failure audit with priorLookupFailed when pre-lookup throws", async () => {
      // Pre-lookup throws → degrade to priorLookupFailed sentinel and let
      // the UPDATE throw its own failure (the pre-lookup isn't allowed to
      // replace the UPDATE error channel). This keeps the audit trail honest
      // even under pool-exhaustion attacks.
      setQueryResult("SELECT slug FROM plugin_catalog WHERE id", new Error("pool exhausted"));
      setQueryResult("UPDATE plugin_catalog", new Error("subsequent UPDATE failed"));

      const app = buildPlatformApp();
      const res = await app.request("/catalog/cat-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "X" }),
      });
      expect(res.status).toBe(500);
      expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
      const entry = mockLogAdminAction.mock.calls[0]![0];
      expect(entry.actionType).toBe("plugin.catalog_update");
      expect(entry.status).toBe("failure");
      expect(entry.metadata!.priorLookupFailed).toBe(true);
      expect(entry.metadata).not.toHaveProperty("pluginSlug");
    });
  });

  describe("DELETE /catalog/:id — plugin.catalog_delete + cascade", () => {
    it("emits only plugin.catalog_delete when no workspaces have it installed", async () => {
      setQueryResult("SELECT slug FROM plugin_catalog WHERE id", [{ slug: "bigquery" }]);
      setQueryResult("SELECT COUNT(*)::int AS count FROM workspace_plugins", [{ count: 0 }]);
      setQueryResult("DELETE FROM plugin_catalog", [{ id: "cat-1" }]);

      const app = buildPlatformApp();
      const res = await app.request("/catalog/cat-1", { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
      const entry = mockLogAdminAction.mock.calls[0]![0];
      expect(entry.actionType).toBe("plugin.catalog_delete");
      expect(entry.targetId).toBe("cat-1");
      expect(entry.metadata).toMatchObject({
        pluginId: "cat-1",
        pluginSlug: "bigquery",
        affectedOrgCount: 0,
      });
    });

    it("emits catalog_delete + catalog_cascade_uninstall when workspaces are affected", async () => {
      setQueryResult("SELECT slug FROM plugin_catalog WHERE id", [{ slug: "bigquery" }]);
      setQueryResult("SELECT COUNT(*)::int AS count FROM workspace_plugins", [{ count: 7 }]);
      setQueryResult("DELETE FROM plugin_catalog", [{ id: "cat-1" }]);

      const app = buildPlatformApp();
      const res = await app.request("/catalog/cat-1", { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(mockLogAdminAction).toHaveBeenCalledTimes(2);
      const [first, second] = mockLogAdminAction.mock.calls.map((c) => c[0]);
      expect(first!.actionType).toBe("plugin.catalog_delete");
      expect(first!.metadata).toMatchObject({ pluginSlug: "bigquery", affectedOrgCount: 7 });
      expect(second!.actionType).toBe("plugin.catalog_cascade_uninstall");
      expect(second!.metadata).toMatchObject({
        pluginSlug: "bigquery",
        affectedOrgCount: 7,
      });
      // Ordering is meaningful — cascade is the follow-up to the delete.
      expect(first!.targetId).toBe(second!.targetId);
    });

    it("emits status=failure when DELETE throws and no cascade event fires", async () => {
      setQueryResult("SELECT slug FROM plugin_catalog WHERE id", [{ slug: "bigquery" }]);
      setQueryResult("SELECT COUNT(*)::int AS count FROM workspace_plugins", [{ count: 3 }]);
      setQueryResult("DELETE FROM plugin_catalog", new Error("FK violation"));

      const app = buildPlatformApp();
      const res = await app.request("/catalog/cat-1", { method: "DELETE" });
      expect(res.status).toBe(500);
      expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
      const entry = mockLogAdminAction.mock.calls[0]![0];
      expect(entry.actionType).toBe("plugin.catalog_delete");
      expect(entry.status).toBe("failure");
      expect(entry.metadata!.pluginSlug).toBe("bigquery");
      expect(entry.metadata!.affectedOrgCount).toBe(3);
      expect(entry.metadata!.error).toContain("FK violation");
    });

    it("does not emit audit when plugin not found (pre-handler rejection)", async () => {
      setQueryResult("SELECT slug FROM plugin_catalog WHERE id", []);

      const app = buildPlatformApp();
      const res = await app.request("/catalog/nonexistent", { method: "DELETE" });
      expect(res.status).toBe(404);
      expect(mockLogAdminAction).not.toHaveBeenCalled();
    });

    it("emits failure audit with priorLookupFailed when pre-lookup throws", async () => {
      // The critical silent-audit-miss path: pre-delete SELECT throws, the
      // handler must still emit a failure audit so a compromised admin
      // can't flood transient errors to hide attempted deletes.
      setQueryResult("SELECT slug FROM plugin_catalog WHERE id", new Error("pool exhausted"));
      setQueryResult("DELETE FROM plugin_catalog", new Error("subsequent DELETE failed"));

      const app = buildPlatformApp();
      const res = await app.request("/catalog/cat-1", { method: "DELETE" });
      expect(res.status).toBe(500);
      expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
      const entry = mockLogAdminAction.mock.calls[0]![0];
      expect(entry.actionType).toBe("plugin.catalog_delete");
      expect(entry.status).toBe("failure");
      expect(entry.metadata!.priorLookupFailed).toBe(true);
      expect(entry.metadata).not.toHaveProperty("pluginSlug");
    });
  });
});

describe("audit emission — Workspace marketplace", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockQueryResults = new Map();
    capturedQueries = [];
    mockLogAdminAction.mockClear();
  });

  describe("POST /marketplace/install — plugin.install", () => {
    it("emits exactly one plugin.install audit with orgId scope", async () => {
      setQueryResult("SELECT * FROM plugin_catalog WHERE id", [sampleCatalogRow]);
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "starter" }]);
      setQueryResult("SELECT id FROM workspace_plugins WHERE workspace_id", []);
      setQueryResult("INSERT INTO workspace_plugins", [{
        id: "inst-1",
        workspace_id: "org-1",
        catalog_id: "cat-1",
        config: {},
        enabled: true,
        installed_at: now,
        installed_by: "admin-1",
        name: "BigQuery",
        slug: "bigquery",
        type: "datasource",
        description: null,
      }]);

      const app = buildWorkspaceApp();
      const res = await app.request("/marketplace/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ catalogId: "cat-1" }),
      });
      expect(res.status).toBe(201);
      expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
      const entry = mockLogAdminAction.mock.calls[0]![0];
      expect(entry.actionType).toBe("plugin.install");
      expect(entry.targetType).toBe("plugin");
      expect(entry.scope).toBe("workspace");
      expect(entry.metadata).toMatchObject({
        pluginId: "cat-1",
        pluginSlug: "bigquery",
        orgId: "org-1",
      });
    });

    it("emits status=failure when INSERT throws", async () => {
      setQueryResult("SELECT * FROM plugin_catalog WHERE id", [sampleCatalogRow]);
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "starter" }]);
      setQueryResult("SELECT id FROM workspace_plugins WHERE workspace_id", []);
      setQueryResult("INSERT INTO workspace_plugins", new Error("install failed"));

      const app = buildWorkspaceApp();
      const res = await app.request("/marketplace/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ catalogId: "cat-1" }),
      });
      expect(res.status).toBe(500);
      expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
      const entry = mockLogAdminAction.mock.calls[0]![0];
      expect(entry.actionType).toBe("plugin.install");
      expect(entry.status).toBe("failure");
      expect(entry.metadata!.pluginSlug).toBe("bigquery");
      expect(entry.metadata!.orgId).toBe("org-1");
      expect(entry.metadata!.error).toContain("install failed");
    });

    it("does not emit audit on plan-ineligible (pre-handler rejection)", async () => {
      setQueryResult("SELECT * FROM plugin_catalog WHERE id", [
        { ...sampleCatalogRow, min_plan: "business" },
      ]);
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "starter" }]);
      setQueryResult("SELECT id FROM workspace_plugins WHERE workspace_id", []);

      const app = buildWorkspaceApp();
      const res = await app.request("/marketplace/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ catalogId: "cat-1" }),
      });
      expect(res.status).toBe(400);
      expect(mockLogAdminAction).not.toHaveBeenCalled();
    });

    it("does not emit audit when catalog entry not found (404)", async () => {
      // Prevents log flooding from attackers brute-forcing catalogId to probe
      // which entries exist in this deployment.
      setQueryResult("SELECT * FROM plugin_catalog WHERE id", []);

      const app = buildWorkspaceApp();
      const res = await app.request("/marketplace/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ catalogId: "missing-cat" }),
      });
      expect(res.status).toBe(404);
      expect(mockLogAdminAction).not.toHaveBeenCalled();
    });

    it("does not emit audit when plugin already installed (409)", async () => {
      // Symmetric with the catalog-create duplicate-slug rejection — a
      // workspace-level enumeration probe should not flood the audit trail.
      setQueryResult("SELECT * FROM plugin_catalog WHERE id", [sampleCatalogRow]);
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "starter" }]);
      setQueryResult("SELECT id FROM workspace_plugins WHERE workspace_id", [{ id: "inst-existing" }]);

      const app = buildWorkspaceApp();
      const res = await app.request("/marketplace/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ catalogId: "cat-1" }),
      });
      expect(res.status).toBe(409);
      expect(mockLogAdminAction).not.toHaveBeenCalled();
    });

    it("emits failure audit when pre-lookup SELECT throws (F-22 pattern)", async () => {
      // Pre-lookup failure must not silently 500 — without the failure audit
      // an attacker could flood transient errors to probe catalog IDs.
      setQueryResult("SELECT * FROM plugin_catalog WHERE id", new Error("pool exhausted"));

      const app = buildWorkspaceApp();
      const res = await app.request("/marketplace/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ catalogId: "cat-1" }),
      });
      expect(res.status).toBe(500);
      expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
      const entry = mockLogAdminAction.mock.calls[0]![0];
      expect(entry.actionType).toBe("plugin.install");
      expect(entry.status).toBe("failure");
      expect(entry.metadata!.priorLookupFailed).toBe(true);
      expect(entry.metadata!.orgId).toBe("org-1");
      expect(entry.metadata!.error).toContain("pool exhausted");
    });
  });

  describe("DELETE /marketplace/:id — plugin.uninstall", () => {
    it("emits exactly one plugin.uninstall audit on success", async () => {
      setQueryResult("DELETE FROM workspace_plugins WHERE id", [
        { id: "inst-1", catalog_id: "cat-1", slug: "bigquery" },
      ]);

      const app = buildWorkspaceApp();
      const res = await app.request("/marketplace/inst-1", { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
      const entry = mockLogAdminAction.mock.calls[0]![0];
      expect(entry.actionType).toBe("plugin.uninstall");
      expect(entry.targetType).toBe("plugin");
      expect(entry.targetId).toBe("inst-1");
      expect(entry.scope).toBe("workspace");
      expect(entry.metadata).toMatchObject({
        pluginId: "cat-1",
        pluginSlug: "bigquery",
        orgId: "org-1",
      });
    });

    it("emits status=failure when DELETE throws", async () => {
      setQueryResult("DELETE FROM workspace_plugins WHERE id", new Error("uninstall failed"));

      const app = buildWorkspaceApp();
      const res = await app.request("/marketplace/inst-1", { method: "DELETE" });
      expect(res.status).toBe(500);
      expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
      const entry = mockLogAdminAction.mock.calls[0]![0];
      expect(entry.actionType).toBe("plugin.uninstall");
      expect(entry.status).toBe("failure");
      expect(entry.metadata!.error).toContain("uninstall failed");
    });

    it("does not emit audit when installation not found (404)", async () => {
      // 404 short-circuits after the DELETE returns zero rows — no state
      // changed, no audit.
      setQueryResult("DELETE FROM workspace_plugins WHERE id", []);

      const app = buildWorkspaceApp();
      const res = await app.request("/marketplace/missing-inst", { method: "DELETE" });
      expect(res.status).toBe(404);
      expect(mockLogAdminAction).not.toHaveBeenCalled();
    });

    it("emits audit without pluginSlug when catalog row raced away", async () => {
      // catalog_delete cascade could fire concurrently and wipe the
      // plugin_catalog row the subselect relies on. The audit still emits
      // with pluginId + orgId so forensic reconstruction isn't completely
      // blind even though the slug is gone.
      setQueryResult("DELETE FROM workspace_plugins WHERE id", [
        { id: "inst-1", catalog_id: "cat-1", slug: null },
      ]);

      const app = buildWorkspaceApp();
      const res = await app.request("/marketplace/inst-1", { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
      const entry = mockLogAdminAction.mock.calls[0]![0];
      expect(entry.actionType).toBe("plugin.uninstall");
      expect(entry.metadata).toMatchObject({ pluginId: "cat-1", orgId: "org-1" });
      expect(entry.metadata).not.toHaveProperty("pluginSlug");
    });
  });

  describe("PUT /marketplace/:id/config — plugin.config_update", () => {
    it("emits exactly one plugin.config_update audit with keysChanged only", async () => {
      setQueryResult("FROM workspace_plugins wp", [{ config: {}, config_schema: null }]);
      setQueryResult("UPDATE workspace_plugins", [{
        id: "inst-1",
        workspace_id: "org-1",
        catalog_id: "cat-1",
        config: {},
        enabled: true,
        installed_at: now,
        installed_by: "admin-1",
        name: "BigQuery",
        slug: "bigquery",
        type: "datasource",
        description: null,
      }]);

      const app = buildWorkspaceApp();
      const res = await app.request("/marketplace/inst-1/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: {
            serviceAccountKey: "SECRET_JSON_BLOB",
            projectId: "my-project",
            location: "us-central1",
          },
        }),
      });
      expect(res.status).toBe(200);
      expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
      const entry = mockLogAdminAction.mock.calls[0]![0];
      expect(entry.actionType).toBe("plugin.config_update");
      expect(entry.targetId).toBe("inst-1");
      expect(entry.scope).toBe("workspace");
      expect(entry.metadata).toMatchObject({
        pluginId: "cat-1",
        pluginSlug: "bigquery",
        orgId: "org-1",
      });
      expect(entry.metadata!.keysChanged).toEqual(["location", "projectId", "serviceAccountKey"]);
    });

    it("never includes config values in audit metadata", async () => {
      setQueryResult("FROM workspace_plugins wp", [{ config: {}, config_schema: null }]);
      setQueryResult("UPDATE workspace_plugins", [{
        id: "inst-1",
        workspace_id: "org-1",
        catalog_id: "cat-1",
        config: {},
        enabled: true,
        installed_at: now,
        installed_by: "admin-1",
        name: "Snowflake",
        slug: "snowflake",
        type: "datasource",
        description: null,
      }]);

      await buildWorkspaceApp().request("/marketplace/inst-1/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: {
            password: "SUPER_SECRET_SNOWFLAKE_PW",
            account: "myacct",
          },
        }),
      });
      const entry = mockLogAdminAction.mock.calls[0]![0];
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain("SUPER_SECRET_SNOWFLAKE_PW");
      expect(entry.metadata).not.toHaveProperty("password");
      expect(entry.metadata).not.toHaveProperty("config");
      expect(entry.metadata).not.toHaveProperty("values");
    });

    it("emits status=failure when UPDATE throws", async () => {
      setQueryResult("FROM workspace_plugins wp", [{ config: {}, config_schema: null }]);
      setQueryResult("UPDATE workspace_plugins", new Error("config update failed"));

      const app = buildWorkspaceApp();
      const res = await app.request("/marketplace/inst-1/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: { key: "val" } }),
      });
      expect(res.status).toBe(500);
      expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
      const entry = mockLogAdminAction.mock.calls[0]![0];
      expect(entry.actionType).toBe("plugin.config_update");
      expect(entry.status).toBe("failure");
      expect(entry.metadata!.keysChanged).toEqual(["key"]);
      expect(entry.metadata!.error).toContain("config update failed");
    });

    it("does not emit audit when installation not found (404)", async () => {
      // The pre-SELECT for secret restoration finds no row, short-circuits
      // to 404 before UPDATE runs.
      setQueryResult("FROM workspace_plugins wp", []);

      const app = buildWorkspaceApp();
      const res = await app.request("/marketplace/missing/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: { key: "val" } }),
      });
      expect(res.status).toBe(404);
      expect(mockLogAdminAction).not.toHaveBeenCalled();
    });

    it("sorts keysChanged alphabetically regardless of input order", async () => {
      setQueryResult("FROM workspace_plugins wp", [{ config: {}, config_schema: null }]);
      setQueryResult("UPDATE workspace_plugins", [{
        id: "inst-1",
        workspace_id: "org-1",
        catalog_id: "cat-1",
        config: {},
        enabled: true,
        installed_at: now,
        installed_by: "admin-1",
        name: "BigQuery",
        slug: "bigquery",
        type: "datasource",
        description: null,
      }]);

      await buildWorkspaceApp().request("/marketplace/inst-1/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: { zzz: 1, mmm: 2, aaa: 3 },
        }),
      });
      const entry = mockLogAdminAction.mock.calls[0]![0];
      expect(entry.metadata!.keysChanged).toEqual(["aaa", "mmm", "zzz"]);
    });
  });
});
