/**
 * Unit tests for createAdminRouter, createPlatformRouter, and requireOrgContext.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

let mockHasInternalDB = true;

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: async () => [],
}));

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: () =>
    Promise.resolve({ authenticated: true, mode: "none", user: undefined }),
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
}));

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    createLogger: () => logger,
    withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import {
  createAdminRouter,
  createPlatformRouter,
  requireOrgContext,
  type OrgContextEnv,
} from "../admin-router";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a typed AuthResult for testing. Supports user-with-org, user-without-org, and no-user. */
function fakeAuthResult(
  orgId: string | undefined,
  opts?: { includeUser: boolean },
): AuthResult & { authenticated: true } {
  const includeUser = opts?.includeUser ?? !!orgId;
  if (includeUser) {
    return {
      authenticated: true,
      mode: "managed",
      user: {
        id: "user-1",
        mode: "managed",
        label: "admin@test.dev",
        role: "admin",
        ...(orgId !== undefined ? { activeOrganizationId: orgId } : {}),
      },
    };
  }
  return { authenticated: true, mode: "none", user: undefined };
}

/** Injects requestId + authResult into context for testing requireOrgContext in isolation. */
function withFakeAuth(
  app: OpenAPIHono<OrgContextEnv>,
  orgId: string | undefined,
  opts?: { includeUser: boolean },
) {
  app.use(createMiddleware<OrgContextEnv>(async (c, next) => {
    c.set("requestId", "test-req-id");
    c.set("authResult", fakeAuthResult(orgId, opts));
    await next();
  }));
}

const testRoute = createRoute({
  method: "get",
  path: "/test",
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
    },
  },
});

// ---------------------------------------------------------------------------
// requireOrgContext tests
// ---------------------------------------------------------------------------

describe("requireOrgContext", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
  });

  it("returns 404 when no internal DB is configured", async () => {
    mockHasInternalDB = false;

    const app = new OpenAPIHono<OrgContextEnv>();
    withFakeAuth(app, "org-1");
    app.use(requireOrgContext());
    app.openapi(testRoute, (c) => c.json({ ok: true }, 200));

    const res = await app.request("/test");
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string; message: string; requestId: string };
    expect(body.error).toBe("not_available");
    expect(body.message).toContain("No internal database");
    expect(body.requestId).toBe("test-req-id");
  });

  it("returns 400 when no active organization (no user)", async () => {
    const app = new OpenAPIHono<OrgContextEnv>();
    withFakeAuth(app, undefined);
    app.use(requireOrgContext());
    app.openapi(testRoute, (c) => c.json({ ok: true }, 200));

    const res = await app.request("/test");
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string; message: string; requestId: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toContain("No active organization");
    expect(body.requestId).toBe("test-req-id");
  });

  it("returns 400 when user exists but has no activeOrganizationId", async () => {
    const app = new OpenAPIHono<OrgContextEnv>();
    withFakeAuth(app, undefined, { includeUser: true });
    app.use(requireOrgContext());
    app.openapi(testRoute, (c) => c.json({ ok: true }, 200));

    const res = await app.request("/test");
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toContain("No active organization");
  });

  it("returns 400 when activeOrganizationId is an empty string", async () => {
    const app = new OpenAPIHono<OrgContextEnv>();
    withFakeAuth(app, "", { includeUser: true });
    app.use(requireOrgContext());
    app.openapi(testRoute, (c) => c.json({ ok: true }, 200));

    const res = await app.request("/test");
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toContain("No active organization");
  });

  it("returns 404 (not 400) when both DB and orgId are missing — DB check has priority", async () => {
    mockHasInternalDB = false;

    const app = new OpenAPIHono<OrgContextEnv>();
    withFakeAuth(app, undefined);
    app.use(requireOrgContext());
    app.openapi(testRoute, (c) => c.json({ ok: true }, 200));

    const res = await app.request("/test");
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_available");
  });

  it("sets orgContext and passes through on valid request", async () => {
    const app = new OpenAPIHono<OrgContextEnv>();
    withFakeAuth(app, "org-123");
    app.use(requireOrgContext());
    app.openapi(testRoute, (c) => {
      const ctx = c.get("orgContext");
      return c.json({ ok: true, requestId: ctx.requestId, orgId: ctx.orgId }, 200);
    });

    const res = await app.request("/test");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; requestId: string; orgId: string };
    expect(body.ok).toBe(true);
    expect(body.requestId).toBe("test-req-id");
    expect(body.orgId).toBe("org-123");
  });
});

// ---------------------------------------------------------------------------
// Factory tests
// ---------------------------------------------------------------------------

describe("createAdminRouter", () => {
  it("returns an OpenAPIHono instance with middleware wired", () => {
    const router = createAdminRouter();
    expect(router).toBeInstanceOf(OpenAPIHono);
  });

  it("surfaces HTTPExceptions via eeOnError", async () => {
    const router = createAdminRouter();
    const errorRoute = createRoute({
      method: "get",
      path: "/err",
      responses: { 403: { description: "Forbidden" } },
    });
    router.openapi(errorRoute, () => {
      throw new HTTPException(403, {
        res: Response.json({ error: "enterprise_required", message: "License required" }, { status: 403 }),
      });
    });

    const res = await router.request("/err");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("enterprise_required");
  });
});

describe("createPlatformRouter", () => {
  it("returns an OpenAPIHono instance", () => {
    const router = createPlatformRouter();
    expect(router).toBeInstanceOf(OpenAPIHono);
  });
});
