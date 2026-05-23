/**
 * Tests for GET /api/v1/integrations/catalog (#2651, slice 3 of 1.5.2).
 *
 * Drives the catalog read-only endpoint directly without going through the
 * full admin router import graph. Follows the admin-marketplace.test.ts shape
 * — module-level mocks for `effect`, `@atlas/api/lib/effect/services`, and
 * `@atlas/api/lib/db/internal` — so we can assert plan filtering, install-state
 * join, SaaS `saas_eligible` filter, and admin-role gating without standing up
 * the entire app.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";

// --- Audit capture ---

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

mock.module("@atlas/api/lib/audit", async () => {
  const actual = await import("@atlas/api/lib/audit/actions");
  return {
    logAdminAction: mockLogAdminAction,
    logAdminActionAwait: mock(async () => {}),
    ADMIN_ACTIONS: actual.ADMIN_ACTIONS,
  };
});

mock.module("@atlas/api/lib/audit/error-scrub", () => ({
  errorMessage: (err: unknown): string => {
    const raw = err instanceof Error ? err.message : String(err);
    return raw.length > 512 ? `${raw.slice(0, 509)}...` : raw;
  },
  causeToError: () => undefined,
}));

// --- Effect bridge shim ---

const mockEffectUser: Record<string, unknown> = {
  id: "admin-1",
  mode: "simple-key",
  role: "admin",
  activeOrganizationId: "org-1",
  orgId: "org-1",
};

const fakeAuthContext = {
  [Symbol.iterator]: function* (): Generator<unknown, Record<string, unknown>> {
    return yield mockEffectUser;
  },
};

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
    gen: (genFn: () => Generator) => ({ _tag: "EffectGen", genFn }),
    promise: (fn: () => Promise<unknown>) => {
      const effectValue: TestEffectPromise = { _tag: "EffectPromise", fn, errorTaps: [] };
      return makePipeable(effectValue);
    },
    // `tryPromise({ try, catch })` — shim treats it as a promise that runs
    // `try()`; on rejection it applies `catch(err)` before propagation
    // (matches real Effect's typed-failure channel for assertions).
    tryPromise: <E>(opts: { try: () => Promise<unknown>; catch: (err: unknown) => E }) => {
      const effectValue: TestEffectPromise = {
        _tag: "EffectPromise",
        fn: async () => {
          try {
            return await opts.try();
          } catch (err) {
            throw opts.catch(err);
          }
        },
        errorTaps: [],
      };
      return makePipeable(effectValue);
    },
    runPromise: (value: unknown) => Promise.resolve(value),
    sync: (syncFn: () => unknown) => ({ _tag: "EffectSync", fn: syncFn }),
    tapError: (handler: (err: unknown) => unknown) => (source: TestPipeable) => {
      const originalIterator = source[Symbol.iterator].bind(source);
      const newPipeable: TestPipeable = {
        [Symbol.iterator]: function* (): Generator<unknown, unknown> {
          const gen = originalIterator();
          let next = gen.next();
          while (!next.done) {
            const value = next.value;
            if (
              value &&
              typeof value === "object" &&
              (value as { _tag?: string })._tag === "EffectPromise"
            ) {
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
  RequestContext: {
    [Symbol.iterator]: function* (): Generator<unknown, unknown> {
      return yield { requestId: "test-req-1", startTime: Date.now() };
    },
  },
  makeRequestContextLayer: () => ({}),
  makeAuthContextLayer: () => ({}),
  NoopEnterpriseDefaultsLayer: { _tag: "MockLayer" },
  IpAllowlistPolicy: { _tag: "MockTag" },
  SSOPolicy: { _tag: "MockTag" },
  SCIMProvenance: { _tag: "MockTag" },
  RolesPolicy: {
    [Symbol.iterator]: function* (): Generator<unknown, unknown> {
      return yield {};
    },
  },
}));

mock.module("@atlas/api/lib/effect/enterprise-layer", () => ({
  EnterpriseLayer: { _tag: "MockLayer" },
  getEnterpriseRuntime: () => ({
    runPromise: () => Promise.resolve(undefined),
    runPromiseExit: () => Promise.resolve({ _tag: "Success", value: undefined } as never),
    dispose: () => Promise.resolve(),
  }),
  runEnterprise: () => Promise.resolve(undefined),
}));

mock.module("@atlas/api/lib/effect/hono", () => ({
  runEffect: async (
    _c: unknown,
    effect: { _tag: string; genFn: () => Generator },
    _opts?: unknown,
  ) => {
    const gen = effect.genFn();
    let result = gen.next();
    while (!result.done) {
      const value = result.value;
      if (
        value &&
        typeof value === "object" &&
        (value as { _tag?: string })._tag === "EffectPromise"
      ) {
        const promiseValue = value as TestEffectPromise;
        try {
          const resolved = await promiseValue.fn();
          result = gen.next(resolved);
        } catch (err) {
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

// --- Middleware mock — bypass adminAuth so tests can set context vars directly ---

import { createMiddleware } from "hono/factory";

const passthrough = createMiddleware(async (_c, next) => {
  await next();
});

mock.module("./routes/middleware", () => ({
  adminAuth: passthrough,
  platformAdminAuth: passthrough,
  requestContext: passthrough,
  standardAuth: passthrough,
  withRequestId: passthrough,
}));

// admin-router.ts imports adminAuth/mfaRequired via relative `./middleware`
// + `./admin-mfa-required`. Bun's mock.module key matches the literal import
// spec — duplicate the registration under those specs so the real
// middleware never runs (otherwise adminAuth re-runs authenticateRequest and
// overwrites the test's `c.set("authResult", ...)`).
mock.module("../routes/middleware", () => ({
  adminAuth: passthrough,
  platformAdminAuth: passthrough,
  requestContext: passthrough,
  standardAuth: passthrough,
  withRequestId: passthrough,
}));

mock.module("@atlas/api/api/routes/middleware", () => ({
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
      user: { id: "admin-1", role: "admin", activeOrganizationId: "org-1" },
    }),
  ),
  checkRateLimit: mock(() => ({ allowed: true })),
  getClientIP: mock(() => null),
  resetRateLimits: mock(() => {}),
  rateLimitCleanupTick: mock(() => {}),
  _setValidatorOverrides: mock(() => {}),
}));

mock.module("./routes/admin-mfa-required", () => ({
  mfaRequired: passthrough,
}));

// --- Deploy-mode config mock — flip per test ---

let mockConfigOverride: { deployMode?: "saas" | "self-hosted" } | null = null;

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => mockConfigOverride,
  defineConfig: (c: unknown) => c,
}));

// --- Internal DB mock ---

let mockHasInternalDB = true;
let mockQueryResults: Map<string, unknown[] | Error> = new Map();
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

// --- Import the router after mocks ---

const { integrationsCatalog } = await import("../routes/integrations-catalog");
const { OpenAPIHono } = await import("@hono/zod-openapi");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildApp(role: string = "admin", orgId: string | null = "org-1") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper bypasses typed env
  const app = new OpenAPIHono<any>();
  app.use(async (c, next) => {
    c.set("requestId", "test-req-1");
    c.set("authResult", {
      authenticated: true,
      mode: "simple-key",
      user: { id: "admin-1", role, activeOrganizationId: orgId },
    });
    if (orgId) {
      c.set("orgContext", { requestId: "test-req-1", orgId });
    }
    await next();
  });
  app.route("/integrations", integrationsCatalog);
  return app;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper for untyped JSON responses
const json = (res: Response) => res.json() as Promise<any>;

const now = new Date().toISOString();

const slackRow = {
  id: "catalog:slack",
  slug: "slack",
  name: "Slack",
  description: "Connect Slack to receive answers in channel.",
  type: "chat",
  install_model: "oauth",
  icon_url: null,
  config_schema: null,
  min_plan: "starter",
  enabled: true,
  saas_eligible: true,
  created_at: now,
  updated_at: now,
};

const teamRow = {
  id: "catalog:salesforce",
  slug: "salesforce",
  name: "Salesforce",
  description: "Sync Salesforce records.",
  type: "integration",
  install_model: "oauth",
  icon_url: null,
  config_schema: null,
  min_plan: "team",
  enabled: true,
  saas_eligible: true,
  created_at: now,
  updated_at: now,
};

const githubPatRow = {
  id: "catalog:github-pat",
  slug: "github-pat",
  name: "GitHub (PAT)",
  description: "Per-user personal access token.",
  type: "integration",
  install_model: "form",
  icon_url: null,
  config_schema: null,
  min_plan: "starter",
  enabled: true,
  saas_eligible: false,
  created_at: now,
  updated_at: now,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/v1/integrations/catalog", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockQueryResults = new Map();
    capturedQueries = [];
    mockConfigOverride = null;
    mockLogAdminAction.mockClear();
  });

  describe("admin gating", () => {
    it("returns 400 when no active org", async () => {
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "starter" }]);
      setQueryResult("FROM plugin_catalog", [slackRow]);
      setQueryResult("FROM workspace_plugins", []);

      const app = buildApp("admin", null);
      const res = await app.request("/integrations/catalog");
      expect(res.status).toBe(400);
    });

    it("returns 404 when no internal DB", async () => {
      mockHasInternalDB = false;
      const app = buildApp();
      const res = await app.request("/integrations/catalog");
      expect(res.status).toBe(404);
    });
  });

  describe("response shape", () => {
    it("returns enabled catalog entries with installed=false when no installations", async () => {
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "starter" }]);
      setQueryResult("FROM plugin_catalog", [slackRow]);
      setQueryResult("FROM workspace_plugins", []);

      const app = buildApp();
      const res = await app.request("/integrations/catalog");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.catalog).toHaveLength(1);
      const entry = body.catalog[0];
      expect(entry.id).toBe("catalog:slack");
      expect(entry.slug).toBe("slack");
      expect(entry.type).toBe("chat");
      expect(entry.installModel).toBe("oauth");
      expect(entry.name).toBe("Slack");
      expect(entry.minPlan).toBe("starter");
      expect(entry.installed).toBe(false);
      expect(entry.installedAt).toBeNull();
      expect(entry.installedBy).toBeNull();
      expect(entry.installStatus).toBeNull();
      expect(entry.upsellOnly).toBe(false);
    });

    it("surfaces installStatus from workspace_plugins.config (e.g. reconnect_needed for Salesforce)", async () => {
      // #2658 — the Salesforce refresh-token flow flips config.status to
      // 'reconnect_needed' on permanent failure. The catalog response
      // carries the flag so /admin/integrations can render the
      // Reconnect affordance.
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "starter" }]);
      setQueryResult("FROM plugin_catalog", [slackRow]);
      setQueryResult("FROM workspace_plugins", [
        {
          catalog_id: "catalog:slack",
          installed_at: now,
          installed_by: "user-42",
          install_status: "reconnect_needed",
        },
      ]);

      const app = buildApp();
      const res = await app.request("/integrations/catalog");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.catalog[0].installStatus).toBe("reconnect_needed");
    });

    it("only includes enabled rows (planner filter at SQL layer)", async () => {
      // Endpoint should issue `WHERE enabled = true` — the mock matches the
      // SQL fragment and returns only enabled rows. This test asserts the
      // contract by verifying the captured SQL.
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "starter" }]);
      setQueryResult("FROM plugin_catalog", [slackRow]);
      setQueryResult("FROM workspace_plugins", []);

      const app = buildApp();
      const res = await app.request("/integrations/catalog");
      expect(res.status).toBe(200);

      const catalogQuery = capturedQueries.find((q) => q.sql.includes("FROM plugin_catalog"));
      expect(catalogQuery).toBeDefined();
      expect(catalogQuery!.sql).toContain("enabled = true");
    });

    it("filters out legacy plugin_catalog `type` values at the SQL layer", async () => {
      // The DB CHECK admits `datasource|context|interaction|action|sandbox`
      // (legacy marketplace types) alongside the new `chat|integration`
      // values. The customer-facing endpoint must narrow to the new pair
      // or the client-side Zod parse will fail.
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "starter" }]);
      setQueryResult("FROM plugin_catalog", [slackRow]);
      setQueryResult("FROM workspace_plugins", []);

      const app = buildApp();
      const res = await app.request("/integrations/catalog");
      expect(res.status).toBe(200);

      const catalogQuery = capturedQueries.find((q) => q.sql.includes("FROM plugin_catalog"));
      expect(catalogQuery).toBeDefined();
      expect(catalogQuery!.sql).toContain("type IN ('chat', 'integration')");
    });
  });

  describe("install-state join", () => {
    it("marks rows installed when workspace_plugins row exists", async () => {
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "starter" }]);
      setQueryResult("FROM plugin_catalog", [slackRow]);
      setQueryResult("FROM workspace_plugins", [
        {
          catalog_id: "catalog:slack",
          installed_at: now,
          installed_by: "user-42",
        },
      ]);

      const app = buildApp();
      const res = await app.request("/integrations/catalog");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.catalog[0].installed).toBe(true);
      expect(body.catalog[0].installedAt).toBe(now);
      expect(body.catalog[0].installedBy).toBe("user-42");
    });

    it("converts Date-typed installed_at to ISO string (pg returns timestamptz as Date)", async () => {
      const installedDate = new Date("2026-05-19T10:00:00Z");
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "starter" }]);
      setQueryResult("FROM plugin_catalog", [slackRow]);
      setQueryResult("FROM workspace_plugins", [
        {
          catalog_id: "catalog:slack",
          installed_at: installedDate,
          installed_by: "user-42",
        },
      ]);

      const app = buildApp();
      const res = await app.request("/integrations/catalog");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.catalog[0].installedAt).toBe(installedDate.toISOString());
    });

    it("scopes workspace_plugins lookup to caller's org via WHERE workspace_id = $1", async () => {
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "starter" }]);
      setQueryResult("FROM plugin_catalog", [slackRow]);
      setQueryResult("FROM workspace_plugins", []);

      const app = buildApp();
      await app.request("/integrations/catalog");
      const wpQuery = capturedQueries.find((q) => q.sql.includes("FROM workspace_plugins"));
      expect(wpQuery).toBeDefined();
      // Asserting both the SQL fragment AND `params[0] === orgId` guards
      // against a regression that drops the WHERE clause (cross-tenant
      // install-state leakage). `params.toContain` alone would pass even
      // if `workspace_id = $1` were removed.
      expect(wpQuery!.sql).toContain("workspace_id = $1");
      expect(wpQuery!.params[0]).toBe("org-1");
    });
  });

  describe("plan filtering", () => {
    it("flags above-plan entries as upsellOnly=true", async () => {
      // Workspace on starter; Salesforce requires team — should appear with
      // `upsellOnly: true`, not be filtered out.
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "starter" }]);
      setQueryResult("FROM plugin_catalog", [slackRow, teamRow]);
      setQueryResult("FROM workspace_plugins", []);

      const app = buildApp();
      const res = await app.request("/integrations/catalog");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.catalog).toHaveLength(2);
      const slack = body.catalog.find((e: { slug: string }) => e.slug === "slack");
      const salesforce = body.catalog.find((e: { slug: string }) => e.slug === "salesforce");
      expect(slack.upsellOnly).toBe(false);
      expect(salesforce.upsellOnly).toBe(true);
    });

    it("flags unknown min_plan values as upsellOnly (fail-closed)", async () => {
      // `#2666` migration window: a min_plan value outside both vocabularies
      // (e.g. typo or future tier) must render read-only rather than
      // silently allow install.
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "starter" }]);
      setQueryResult("FROM plugin_catalog", [
        { ...slackRow, min_plan: "platinum" },
      ]);
      setQueryResult("FROM workspace_plugins", []);

      const app = buildApp();
      const res = await app.request("/integrations/catalog");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.catalog[0].upsellOnly).toBe(true);
    });

    it("flags upsellOnly=false when workspace plan meets min_plan", async () => {
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "business" }]);
      setQueryResult("FROM plugin_catalog", [slackRow, teamRow]);
      setQueryResult("FROM workspace_plugins", []);

      const app = buildApp();
      const res = await app.request("/integrations/catalog");
      expect(res.status).toBe(200);
      const body = await json(res);
      const salesforce = body.catalog.find((e: { slug: string }) => e.slug === "salesforce");
      expect(salesforce.upsellOnly).toBe(false);
    });
  });

  describe("deploy-mode filter", () => {
    it("issues a SaaS-narrowed catalog query (`saas_eligible = true`) when deployMode is `saas`", async () => {
      mockConfigOverride = { deployMode: "saas" };
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "starter" }]);
      setQueryResult("FROM plugin_catalog", [slackRow]);
      setQueryResult("FROM workspace_plugins", []);

      const app = buildApp();
      const res = await app.request("/integrations/catalog");
      expect(res.status).toBe(200);

      const catalogQuery = capturedQueries.find((q) => q.sql.includes("FROM plugin_catalog"));
      expect(catalogQuery).toBeDefined();
      expect(catalogQuery!.sql).toContain("saas_eligible = true");
    });

    it("omits the `saas_eligible = true` predicate on self-hosted deploys", async () => {
      mockConfigOverride = { deployMode: "self-hosted" };
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "starter" }]);
      setQueryResult("FROM plugin_catalog", [slackRow, githubPatRow]);
      setQueryResult("FROM workspace_plugins", []);

      const app = buildApp();
      const res = await app.request("/integrations/catalog");
      expect(res.status).toBe(200);

      const catalogQuery = capturedQueries.find((q) => q.sql.includes("FROM plugin_catalog"));
      expect(catalogQuery).toBeDefined();
      expect(catalogQuery!.sql).not.toContain("saas_eligible = true");

      // And every row from the DB surfaces in the response.
      const body = await json(res);
      expect(body.catalog).toHaveLength(2);
    });

    it("treats unloaded config as self-hosted (no `saas_eligible = true` predicate)", async () => {
      mockConfigOverride = null;
      setQueryResult("SELECT plan_tier FROM organization", [{ plan_tier: "starter" }]);
      setQueryResult("FROM plugin_catalog", [slackRow, githubPatRow]);
      setQueryResult("FROM workspace_plugins", []);

      const app = buildApp();
      const res = await app.request("/integrations/catalog");
      expect(res.status).toBe(200);

      const catalogQuery = capturedQueries.find((q) => q.sql.includes("FROM plugin_catalog"));
      expect(catalogQuery).toBeDefined();
      expect(catalogQuery!.sql).not.toContain("saas_eligible = true");
    });
  });
});
