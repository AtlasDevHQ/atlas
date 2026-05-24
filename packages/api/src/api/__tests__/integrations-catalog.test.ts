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

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import { Effect } from "effect";
import type { CatalogEntryWithState } from "@atlas/api/lib/effect/pillar-catalog-query";

// ---------------------------------------------------------------------------
// Facade stub — single source of truth for the test's response shape.
// ---------------------------------------------------------------------------

const mockWithInstallStatusFor: Mock<
  (workspaceId: string) => Effect.Effect<readonly CatalogEntryWithState[], Error>
> = mock(() => Effect.succeed([] as readonly CatalogEntryWithState[]));

let mockHasInternalDB = true;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realPillarFacade = require("@atlas/api/lib/effect/pillar-catalog-query") as typeof import("@atlas/api/lib/effect/pillar-catalog-query");

mock.module("@atlas/api/lib/effect/pillar-catalog-query", () => ({
  ...realPillarFacade,
  // Replace the Live Layer with a test layer that delegates to the mock.
  PillarCatalogQueryLive: realPillarFacade.createPillarCatalogQueryTestLayer({
    withInstallStatusFor: (workspaceId) => mockWithInstallStatusFor(workspaceId),
    getByPillar: () =>
      Effect.fail(new Error("test: getByPillar not used by this route")),
    getBySlug: () =>
      Effect.fail(new Error("test: getBySlug not used by this route")),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realDbInternal = require("@atlas/api/lib/db/internal") as typeof import("@atlas/api/lib/db/internal");

mock.module("@atlas/api/lib/db/internal", () => ({
  ...realDbInternal,
  hasInternalDB: () => mockHasInternalDB,
  // makeInternalDBShimLayer is invoked by the route; pass through the
  // real implementation so the facade test layer (which doesn't read
  // InternalDB) just gets a no-op shim.
  makeInternalDBShimLayer: realDbInternal.makeInternalDBShimLayer,
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

// Bypass adminAuth/MFA so the test can inject `orgContext` directly.
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
mock.module("./routes/admin-mfa-required", () => ({
  mfaRequired: passthrough,
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

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

const { integrationsCatalog } = await import("../routes/integrations-catalog");
const { OpenAPIHono } = await import("@hono/zod-openapi");

// ---------------------------------------------------------------------------
// Helpers
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
    it("calls withInstallStatusFor with the caller's orgId", async () => {
      const app = buildApp();
      await app.request("/integrations/catalog");
      expect(mockWithInstallStatusFor).toHaveBeenCalledWith("org-1");
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
