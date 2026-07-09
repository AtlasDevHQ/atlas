/**
 * Tests for GET /api/v1/integrations/catalog.
 *
 * Post-#2741 (slice 3 of 1.5.3): the route is a thin projection over the
 * `PillarCatalogQuery` facade. The route owns:
 *   - admin gating (delegated to `requireOrgContext()` + `createAdminRouter`)
 *   - `hasInternalDB()` short-circuit → 404
 *   - facade `withInstallStatusFor(orgId)` invocation
 *   - rich-row → wire-shape projection (preserves `type`, `accessible`,
 *     `upsellOnly`, `installStatus`, `installedAt`, `installedBy`; adds
 *     `pillar` + `implementationStatus`)
 *
 * The pre-slice-3 test mocked `internalQuery` to assert plan-filtering /
 * deploy-mode SQL fragments — that surface moved into the facade and is
 * covered there (`lib/effect/__tests__/pillar-catalog-query.test.ts`).
 * This file pins ONLY the route-level surface: gating, the 404 short
 * circuit, and the wire-shape projection (including the two new fields).
 */

import { describe, it, expect, afterEach, beforeEach, mock, type Mock } from "bun:test";
import { Effect } from "effect";
import type { CatalogEntryWithState } from "@atlas/api/lib/effect/pillar-catalog-query";

// ---------------------------------------------------------------------------
// Facade stub — single source of truth for the test's response shape.
// ---------------------------------------------------------------------------

const mockWithInstallStatusFor: Mock<
  (
    workspaceId: string,
    pillar?: "datasource" | "chat" | "action",
  ) => Effect.Effect<readonly CatalogEntryWithState[], Error>
> = mock(() => Effect.succeed([] as readonly CatalogEntryWithState[]));

let mockHasInternalDB = true;

// oxlint-disable-next-line @typescript-eslint/no-require-imports
const realPillarFacade = require("@atlas/api/lib/effect/pillar-catalog-query") as typeof import("@atlas/api/lib/effect/pillar-catalog-query");

void mock.module("@atlas/api/lib/effect/pillar-catalog-query", () => ({
  ...realPillarFacade,
  // Replace the Live Layer with a test layer that delegates to the mock.
  PillarCatalogQueryLive: realPillarFacade.createPillarCatalogQueryTestLayer({
    withInstallStatusFor: (workspaceId, pillar) =>
      mockWithInstallStatusFor(workspaceId, pillar),
    getByPillar: () =>
      Effect.fail(new Error("test: getByPillar not used by this route")),
    getBySlug: () =>
      Effect.fail(new Error("test: getBySlug not used by this route")),
  }),
}));

// oxlint-disable-next-line @typescript-eslint/no-require-imports
const realDbInternal = require("@atlas/api/lib/db/internal") as typeof import("@atlas/api/lib/db/internal");

void mock.module("@atlas/api/lib/db/internal", () => ({
  ...realDbInternal,
  hasInternalDB: () => mockHasInternalDB,
  // makeInternalDBShimLayer is invoked by the route; pass through the
  // real implementation so the facade test layer (which doesn't read
  // InternalDB) just gets a no-op shim.
  makeInternalDBShimLayer: realDbInternal.makeInternalDBShimLayer,
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

// Bypass adminAuth/MFA so the test can inject `orgContext` directly.
import { createMiddleware } from "hono/factory";
const passthrough = createMiddleware(async (_c, next) => {
  await next();
});

void mock.module("./routes/middleware", () => ({
  adminAuth: passthrough,
  adminAuthAllowApiKey: passthrough,
  platformAdminAuth: passthrough,
  requestContext: passthrough,
  standardAuth: passthrough,
  withRequestId: passthrough,
}));
void mock.module("../routes/middleware", () => ({
  adminAuth: passthrough,
  adminAuthAllowApiKey: passthrough,
  platformAdminAuth: passthrough,
  requestContext: passthrough,
  standardAuth: passthrough,
  withRequestId: passthrough,
}));
void mock.module("@atlas/api/api/routes/middleware", () => ({
  adminAuth: passthrough,
  adminAuthAllowApiKey: passthrough,
  platformAdminAuth: passthrough,
  requestContext: passthrough,
  standardAuth: passthrough,
  withRequestId: passthrough,
}));
void mock.module("./routes/admin-mfa-required", () => ({
  mfaRequired: passthrough,
}));

void mock.module("@atlas/api/lib/auth/middleware", () => ({
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

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

const { integrationsCatalog } = await import("../routes/integrations-catalog");
const { OpenAPIHono } = await import("@hono/zod-openapi");
// Real (unmocked) form-handler registry — the route derives
// `formInstallable` from it (#3387), so the tests below register/clear
// handlers per-test (never at module top-level).
const { registerFormHandler, _resetInstallHandlerRegistries } = await import(
  "@atlas/api/lib/integrations/install/dispatch"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(role: string = "admin", orgId: string | null = "org-1") {
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test helper bypasses typed env
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

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test helper for untyped JSON responses
const json = (res: Response) => res.json() as Promise<any>;

function makeRichRow(overrides: Partial<CatalogEntryWithState> = {}): CatalogEntryWithState {
  return {
    id: "catalog:slack",
    slug: "slack",
    name: "Slack",
    description: "Connect Slack",
    type: "chat",
    installModel: "oauth",
    iconUrl: null,
    configSchema: null,
    minPlan: "starter",
    saasEligible: true,
    pillar: "chat",
    implementationStatus: "available",
    autoInstall: false,
    install: null,
    state: "accessible",
    planAccessible: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/v1/integrations/catalog", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockWithInstallStatusFor.mockReset();
    mockWithInstallStatusFor.mockReturnValue(
      Effect.succeed([] as readonly CatalogEntryWithState[]),
    );
  });

  describe("admin gating", () => {
    it("returns 400 when no active org", async () => {
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

  describe("facade invocation", () => {
    it("calls withInstallStatusFor with the caller's orgId and no pillar by default", async () => {
      const app = buildApp();
      await app.request("/integrations/catalog");
      expect(mockWithInstallStatusFor).toHaveBeenCalledWith("org-1", undefined);
    });

    it("forwards ?pillar=datasource to the facade (#3377)", async () => {
      const app = buildApp();
      await app.request("/integrations/catalog?pillar=datasource");
      expect(mockWithInstallStatusFor).toHaveBeenCalledWith("org-1", "datasource");
    });

    it("rejects unknown pillar values with 422 (only 'datasource' is exposed)", async () => {
      const app = buildApp();
      for (const bad of ["chat", "action", "bogus"]) {
        const res = await app.request(`/integrations/catalog?pillar=${bad}`);
        // 422 via the shared validationHook (`Invalid query parameters`).
        expect(res.status).toBe(422);
      }
      expect(mockWithInstallStatusFor).not.toHaveBeenCalled();
    });
  });

  describe("default-path wire stability (#3377)", () => {
    // The pillar param is additive: the no-param response must stay
    // byte-identical to the pre-#3377 output. Pin the exact serialized
    // body for a representative row so any projection drift (added /
    // renamed / reordered field) fails loudly here.
    it("emits a byte-identical body for the default (no pillar) listing", async () => {
      const row = makeRichRow({ state: "accessible", planAccessible: true });
      mockWithInstallStatusFor.mockReturnValueOnce(Effect.succeed([row]));

      const app = buildApp();
      const res = await app.request("/integrations/catalog");
      expect(res.status).toBe(200);
      const bodyText = await res.text();
      expect(bodyText).toBe(
        JSON.stringify({
          catalog: [
            {
              id: "catalog:slack",
              slug: "slack",
              type: "chat",
              installModel: "oauth",
              name: "Slack",
              description: "Connect Slack",
              iconUrl: null,
              minPlan: "starter",
              configSchema: null,
              installed: false,
              installedAt: null,
              installedBy: null,
              installStatus: null,
              upsellOnly: false,
              accessible: true,
              upgradeRequired: null,
              pillar: "chat",
              implementationStatus: "available",
              installConfig: null,
            },
          ],
        }),
      );
    });
  });

  describe("datasource pillar projection (#3377)", () => {
    it("projects datasource rows (type='datasource') through the same envelope", async () => {
      const row = makeRichRow({
        id: "catalog:clickhouse",
        slug: "clickhouse",
        name: "ClickHouse",
        description: "Connect a ClickHouse instance as an analytics datasource.",
        type: "datasource",
        installModel: "form",
        pillar: "datasource",
        configSchema: [
          { key: "url", type: "string", secret: true, required: true },
          { key: "description", type: "string" },
        ],
        state: "accessible",
        planAccessible: true,
      });
      mockWithInstallStatusFor.mockReturnValueOnce(Effect.succeed([row]));

      const app = buildApp();
      const res = await app.request("/integrations/catalog?pillar=datasource");
      expect(res.status).toBe(200);
      const body = await json(res);
      const entry = body.catalog[0];
      expect(entry.slug).toBe("clickhouse");
      expect(entry.type).toBe("datasource");
      expect(entry.pillar).toBe("datasource");
      expect(entry.installModel).toBe("form");
      // The Add picker's FormInstallModal renders from configSchema —
      // it must survive the projection untouched.
      expect(entry.configSchema).toEqual([
        { key: "url", type: "string", secret: true, required: true },
        { key: "description", type: "string" },
      ]);
      expect(entry.installed).toBe(false);
    });
  });

  describe("formInstallable derivation (#3387)", () => {
    // Minimal registry entry — the flag derivation only consults
    // registration, never invokes the handler.
    const fakeFormHandler = {
      kind: "form" as const,
      validateConfig: () =>
        Promise.reject(new Error("test handler: validateConfig must not be called")),
    };

    afterEach(() => {
      _resetInstallHandlerRegistries();
    });

    it("derives formInstallable from the live form-handler registry on the pillar listing", async () => {
      registerFormHandler("clickhouse", fakeFormHandler);
      const rows = [
        // form model + registered handler → installable
        makeRichRow({
          id: "catalog:clickhouse",
          slug: "clickhouse",
          name: "ClickHouse",
          type: "datasource",
          installModel: "form",
          pillar: "datasource",
        }),
        // form model, NO registered handler (duckdb is deliberately
        // handler-less — atlas.config.ts-only) → not installable. This is
        // the drift scenario #3387 closes: the row must self-report false
        // so the picker can never render a submittable tile that would
        // 500 with "No form-based install handler registered".
        makeRichRow({
          id: "catalog:duckdb",
          slug: "duckdb",
          name: "DuckDB",
          type: "datasource",
          installModel: "form",
          pillar: "datasource",
        }),
        // non-form model → false regardless of registry state
        makeRichRow({
          id: "catalog:salesforce",
          slug: "salesforce",
          name: "Salesforce",
          type: "datasource",
          installModel: "oauth",
          pillar: "datasource",
        }),
      ];
      mockWithInstallStatusFor.mockReturnValueOnce(Effect.succeed(rows));

      const app = buildApp();
      const res = await app.request("/integrations/catalog?pillar=datasource");
      expect(res.status).toBe(200);
      const body = await json(res);
      const bySlug: Record<string, { formInstallable?: boolean }> = {};
      for (const e of body.catalog) bySlug[e.slug] = e;
      expect(bySlug["clickhouse"]?.formInstallable).toBe(true);
      expect(bySlug["duckdb"]?.formInstallable).toBe(false);
      expect(bySlug["salesforce"]?.formInstallable).toBe(false);
    });

    it("gates on installModel: a non-form row stays false even when a form handler shares its slug", async () => {
      // Defensive: the oauth/form registries are namespaced separately
      // (dispatch.ts) — a same-slug form handler must not flip an
      // oauth-datasource row to form-installable.
      registerFormHandler("github-data", fakeFormHandler);
      mockWithInstallStatusFor.mockReturnValueOnce(
        Effect.succeed([
          makeRichRow({
            id: "catalog:github-data",
            slug: "github-data",
            name: "GitHub Data",
            type: "datasource",
            installModel: "oauth-datasource",
            pillar: "datasource",
          }),
        ]),
      );

      const app = buildApp();
      const res = await app.request("/integrations/catalog?pillar=datasource");
      const body = await json(res);
      expect(body.catalog[0].formInstallable).toBe(false);
    });

    it("never emits the key on the default listing, even with handlers registered (byte-stability)", async () => {
      // The default (no-pillar) branch must omit the key entirely — the
      // exact-body pin above covers the serialized form; this pins the
      // key-absence semantics directly even when the registry would say
      // true.
      registerFormHandler("slack", fakeFormHandler);
      const row = makeRichRow({ installModel: "form" });
      mockWithInstallStatusFor.mockReturnValueOnce(Effect.succeed([row]));

      const app = buildApp();
      const res = await app.request("/integrations/catalog");
      const body = await json(res);
      expect("formInstallable" in body.catalog[0]).toBe(false);
    });
  });

  describe("wire-shape projection", () => {
    it("projects a rich row to the wire envelope (no install)", async () => {
      const row = makeRichRow({ state: "accessible", planAccessible: true });
      mockWithInstallStatusFor.mockReturnValueOnce(Effect.succeed([row]));

      const app = buildApp();
      const res = await app.request("/integrations/catalog");
      expect(res.status).toBe(200);
      const body = await json(res);
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
      expect(entry.accessible).toBe(true);
      expect(entry.upgradeRequired).toBeNull();
      // New #2741 fields:
      expect(entry.pillar).toBe("chat");
      expect(entry.implementationStatus).toBe("available");
    });

    it("surfaces install metadata when an install is present", async () => {
      const row = makeRichRow({
        state: "connected",
        planAccessible: true,
        install: {
          id: "install-1",
          catalogId: "catalog:slack",
          installId: "catalog:slack",
          workspaceId: "org-1",
          pillar: "chat",
          installedAt: "2026-05-20T10:00:00.000Z",
          installedBy: "user-42",
          status: "reconnect_needed",
          disabled: false,
          config: {},
        },
      });
      mockWithInstallStatusFor.mockReturnValueOnce(Effect.succeed([row]));

      const app = buildApp();
      const res = await app.request("/integrations/catalog");
      expect(res.status).toBe(200);
      const body = await json(res);
      const entry = body.catalog[0];
      expect(entry.installed).toBe(true);
      expect(entry.installedAt).toBe("2026-05-20T10:00:00.000Z");
      expect(entry.installedBy).toBe("user-42");
      expect(entry.installStatus).toBe("reconnect_needed");
    });

    // Slice 7 of 1.5.3 (#2745): `installConfig` projects the
    // non-secret subset of `workspace_plugins.config` to the wire so
    // /admin/connections can render Salesforce-specific detail rows
    // (instance URL, org ID) without a second round-trip.
    it("projects installConfig from the install row's config JSONB", async () => {
      const row = makeRichRow({
        slug: "salesforce",
        type: "integration",
        pillar: "datasource",
        state: "connected",
        planAccessible: true,
        install: {
          id: "install-sf",
          catalogId: "catalog:salesforce",
          installId: "install-sf",
          workspaceId: "org-1",
          pillar: "datasource",
          installedAt: "2026-05-20T10:00:00.000Z",
          installedBy: "user-42",
          status: "ok",
          disabled: false,
          config: {
            instance_url: "https://na139.my.salesforce.com",
            org_id: "00DAB000000ZmU8",
            scopes: "api refresh_token offline_access",
            status: "ok",
          },
        },
      });
      mockWithInstallStatusFor.mockReturnValueOnce(Effect.succeed([row]));

      const app = buildApp();
      const res = await app.request("/integrations/catalog");
      expect(res.status).toBe(200);
      const body = await json(res);
      const entry = body.catalog[0];
      // The catalog row has no `config_schema` (Salesforce OAuth has no
      // form fields), so `maskSecretFields` passes the whole object
      // through. The detail-row admin UI relies on `instance_url` and
      // `org_id` being readable as plain strings.
      expect(entry.installConfig).toEqual({
        instance_url: "https://na139.my.salesforce.com",
        org_id: "00DAB000000ZmU8",
        scopes: "api refresh_token offline_access",
        status: "ok",
      });
    });

    it("scrubs secret-marked config fields via maskSecretFields", async () => {
      // Defense-in-depth: when a future integration's catalog row marks
      // a field `secret: true`, the wire must replace it with the
      // masked placeholder so plaintext never crosses to the admin UI.
      const row = makeRichRow({
        slug: "future-oauth",
        type: "integration",
        pillar: "action",
        state: "connected",
        planAccessible: true,
        configSchema: [
          { key: "api_token", secret: true, type: "string" },
          { key: "tenant_id", type: "string" },
        ],
        install: {
          id: "install-future",
          catalogId: "catalog:future-oauth",
          installId: "install-future",
          workspaceId: "org-1",
          pillar: "action",
          installedAt: "2026-05-20T10:00:00.000Z",
          installedBy: "user-42",
          status: "ok",
          disabled: false,
          config: {
            api_token: "supersecret",
            tenant_id: "tenant-abc",
          },
        },
      });
      mockWithInstallStatusFor.mockReturnValueOnce(Effect.succeed([row]));

      const app = buildApp();
      const res = await app.request("/integrations/catalog");
      const body = await json(res);
      const entry = body.catalog[0];
      // The secret-marked field is masked; the operational field
      // passes through unchanged.
      expect(entry.installConfig.api_token).not.toBe("supersecret");
      expect(entry.installConfig.api_token).toMatch(/•/);
      expect(entry.installConfig.tenant_id).toBe("tenant-abc");
    });

    it("emits installConfig=null when not installed", async () => {
      const row = makeRichRow({ state: "accessible", planAccessible: true });
      mockWithInstallStatusFor.mockReturnValueOnce(Effect.succeed([row]));

      const app = buildApp();
      const res = await app.request("/integrations/catalog");
      const body = await json(res);
      expect(body.catalog[0].installConfig).toBeNull();
    });

    it("flags above-plan rows as upsellOnly with upgradeRequired carrying the catalog min_plan", async () => {
      const row = makeRichRow({
        slug: "salesforce",
        type: "integration",
        pillar: "action",
        minPlan: "business",
        state: "upgrade_required",
        planAccessible: false,
      });
      mockWithInstallStatusFor.mockReturnValueOnce(Effect.succeed([row]));

      const app = buildApp();
      const res = await app.request("/integrations/catalog");
      expect(res.status).toBe(200);
      const body = await json(res);
      const entry = body.catalog[0];
      expect(entry.upsellOnly).toBe(true);
      expect(entry.accessible).toBe(false);
      expect(entry.upgradeRequired).toBe("business");
      expect(entry.pillar).toBe("action");
    });

    it("surfaces the implementationStatus field for coming-soon rows", async () => {
      const row = makeRichRow({
        slug: "teams",
        pillar: "chat",
        implementationStatus: "coming_soon",
        state: "coming_soon",
        planAccessible: true,
      });
      mockWithInstallStatusFor.mockReturnValueOnce(Effect.succeed([row]));

      const app = buildApp();
      const res = await app.request("/integrations/catalog");
      const body = await json(res);
      expect(body.catalog[0].implementationStatus).toBe("coming_soon");
      expect(body.catalog[0].pillar).toBe("chat");
    });
  });
});
