/**
 * Tests for plugin marketplace API endpoints.
 *
 * Tests the platformCatalog and workspaceMarketplace sub-routers directly
 * (not through the parent admin router) to avoid needing to mock every
 * sub-router dependency.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

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

mock.module("effect", () => {
  const Effect = {
    gen: (genFn: () => Generator) => {
      return { _tag: "EffectGen", genFn };
    },
    promise: (fn: () => Promise<unknown>) => {
      return {
        [Symbol.iterator]: function* (): Generator<unknown, unknown> {
          return yield { _tag: "EffectPromise", fn };
        },
      };
    },
    // Support Effect.runPromise for routes that unwrap Effect-returning EE functions
    runPromise: (value: unknown) => {
      return Promise.resolve(value);
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
      let value = result.value;
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
let mockQueryResults: Map<string, unknown[]> = new Map();

function setQueryResult(pattern: string, rows: unknown[]) {
  mockQueryResults.set(pattern, rows);
}

function findQueryResult(sql: string): unknown[] {
  for (const [pattern, rows] of mockQueryResults) {
    if (sql.includes(pattern)) return rows;
  }
  return [];
}

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  getInternalDB: () => ({
    query: () => Promise.resolve({ rows: [] }),
    end: async () => {},
    on: () => {},
  }),
  internalQuery: (_sql: string, _params?: unknown[]) => Promise.resolve(findQueryResult(_sql)),
  internalExecute: () => {},
  setWorkspaceRegion: mock(async () => {}),
  insertSemanticAmendment: mock(async () => "mock-amendment-id"),
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
  min_plan: "team",
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
      setQueryResult("DELETE FROM plugin_catalog", [{ id: "cat-1" }]);

      const app = buildPlatformApp();
      const res = await app.request("/catalog/cat-1", { method: "DELETE" });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.deleted).toBe(true);
    });

    it("returns 404 for non-existent entry", async () => {
      setQueryResult("DELETE FROM plugin_catalog", []);

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
  });

  describe("GET /marketplace/available", () => {
    it("lists available plugins filtered by plan", async () => {
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "team" }]);
      setQueryResult("SELECT * FROM plugin_catalog WHERE enabled", [
        sampleCatalogRow,
        { ...sampleCatalogRow, id: "cat-2", slug: "enterprise-only", min_plan: "enterprise" },
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
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "team" }]);
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
  });

  describe("POST /marketplace/install", () => {
    it("installs a plugin", async () => {
      setQueryResult("SELECT * FROM plugin_catalog WHERE id", [sampleCatalogRow]);
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "team" }]);
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
        { ...sampleCatalogRow, min_plan: "enterprise" },
      ]);
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "team" }]);
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
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "team" }]);
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

    it("returns 404 for non-existent installation", async () => {
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
