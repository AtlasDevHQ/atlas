/**
 * Unit tests for createAdminRouter, createPlatformRouter, and requireOrgContext.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

let mockHasInternalDB = true;

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: async () => [],
  setWorkspaceRegion: async () => {},
  insertSemanticAmendment: async () => "mock-amendment-id",
  getPendingAmendmentCount: async () => 0,
}));

// Mutable so individual tests can flip the auth result returned by the
// shared auth-middleware mock — needed to exercise the managed-mode +
// admin-role path through `mfaRequired`, which is wired into both
// router factories.
let mockAuthResult: unknown = {
  authenticated: true,
  mode: "none",
  user: undefined,
};

void mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: () => Promise.resolve(mockAuthResult),
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
}));

void mock.module("@atlas/api/lib/logger", () => {
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
  noActiveOrgBody,
  NO_ACTIVE_ORG_MESSAGE,
  NO_INTERNAL_DB_MESSAGE,
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

  // #4356 — the ~53 hand-rolled inline org-context checks were migrated onto
  // this middleware (or, for the routers that structurally cannot mount it,
  // onto `noActiveOrgBody`). These pin the "exactly one definition" property
  // so the copies can't drift apart again.
  it("renders the 400 body through the shared noActiveOrgBody builder", async () => {
    const app = new OpenAPIHono<OrgContextEnv>();
    withFakeAuth(app, undefined);
    app.use(requireOrgContext());
    app.openapi(testRoute, (c) => c.json({ ok: true }, 200));

    const res = await app.request("/test");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(noActiveOrgBody("test-req-id"));
  });

  it("renders the 404 body from the shared no-internal-DB message", async () => {
    mockHasInternalDB = false;

    const app = new OpenAPIHono<OrgContextEnv>();
    withFakeAuth(app, "org-1");
    app.use(requireOrgContext());
    app.openapi(testRoute, (c) => c.json({ ok: true }, 200));

    const res = await app.request("/test");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "not_available",
      message: NO_INTERNAL_DB_MESSAGE,
      requestId: "test-req-id",
    });
  });
});

describe("noActiveOrgBody", () => {
  it("carries the single no-active-organization message and a requestId", () => {
    expect(noActiveOrgBody("req-9")).toEqual({
      error: "bad_request",
      message: NO_ACTIVE_ORG_MESSAGE,
      requestId: "req-9",
    });
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

// ---------------------------------------------------------------------------
// mfaRequired wiring — proves the gate is applied to BOTH router factories
// in the managed-mode + admin-role path that the unit middleware tests
// can't cover (those tests build their own OpenAPIHono).
// ---------------------------------------------------------------------------

describe("mfaRequired is wired into createAdminRouter / createPlatformRouter", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
  });

  it("createAdminRouter blocks managed admin without enrolled MFA with 403", async () => {
    mockAuthResult = {
      authenticated: true,
      mode: "managed",
      user: {
        id: "admin-1",
        mode: "managed",
        label: "admin@test.com",
        role: "admin",
        activeOrganizationId: "org-1",
        // No claims.twoFactorEnabled — this must trigger the gate.
      },
    };

    const router = createAdminRouter();
    const ok = createRoute({
      method: "get",
      path: "/protected",
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
        },
      },
    });
    router.openapi(ok, (c) => c.json({ ok: true }, 200));

    const res = await router.request("/protected");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; enrollmentUrl: string };
    expect(body.error).toBe("mfa_enrollment_required");
    expect(body.enrollmentUrl).toBe("/admin/account-security");

    // Reset for siblings.
    mockAuthResult = { authenticated: true, mode: "none", user: undefined };
  });

  it("createAdminRouter passes managed admin WITH enrolled MFA through to the handler", async () => {
    mockAuthResult = {
      authenticated: true,
      mode: "managed",
      user: {
        id: "admin-1",
        mode: "managed",
        label: "admin@test.com",
        role: "admin",
        activeOrganizationId: "org-1",
        claims: { twoFactorEnabled: true },
      },
    };

    const router = createAdminRouter();
    const ok = createRoute({
      method: "get",
      path: "/protected",
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
        },
      },
    });
    router.openapi(ok, (c) => c.json({ ok: true }, 200));

    const res = await router.request("/protected");
    expect(res.status).toBe(200);

    mockAuthResult = { authenticated: true, mode: "none", user: undefined };
  });

  it("createPlatformRouter blocks managed platform_admin without enrolled MFA", async () => {
    mockAuthResult = {
      authenticated: true,
      mode: "managed",
      user: {
        id: "platform-1",
        mode: "managed",
        label: "platform@test.com",
        role: "platform_admin",
        activeOrganizationId: "org-1",
      },
    };

    const router = createPlatformRouter();
    const ok = createRoute({
      method: "get",
      path: "/platform-protected",
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
        },
      },
    });
    router.openapi(ok, (c) => c.json({ ok: true }, 200));

    const res = await router.request("/platform-protected");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("mfa_enrollment_required");

    mockAuthResult = { authenticated: true, mode: "none", user: undefined };
  });
});

// ---------------------------------------------------------------------------
// #4110 — workspace API key admin reach: denied by default, allowed only on
// the explicitly key-allowed datasource CLI surface (allowApiKey: true).
// ---------------------------------------------------------------------------

describe("workspace API key admin reach (#4110)", () => {
  const apiKeyActor = {
    authenticated: true,
    mode: "managed",
    user: {
      id: "key-owner-1",
      mode: "managed",
      label: "ci@test.com",
      role: "admin",
      activeOrganizationId: "org-1",
      // The api-key marker + no MFA claim — would 403 on mfaRequired if it
      // weren't first denied at adminAuth (default) / exempted (allowApiKey).
      claims: { api_key: true },
    },
  };

  const ok = createRoute({
    method: "get",
    path: "/protected",
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
      },
    },
  });

  beforeEach(() => {
    mockHasInternalDB = true;
  });

  it("createAdminRouter() DENIES an api-key actor with 403 api_key_not_permitted", async () => {
    mockAuthResult = apiKeyActor;
    const router = createAdminRouter();
    router.openapi(ok, (c) => c.json({ ok: true }, 200));

    const res = await router.request("/protected");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("api_key_not_permitted");

    mockAuthResult = { authenticated: true, mode: "none", user: undefined };
  });

  it("createAdminRouter({ allowApiKey: true }) ALLOWS an api-key actor through both the deny + MFA gate", async () => {
    mockAuthResult = apiKeyActor;
    const router = createAdminRouter({ allowApiKey: true });
    router.openapi(ok, (c) => c.json({ ok: true }, 200));

    const res = await router.request("/protected");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    mockAuthResult = { authenticated: true, mode: "none", user: undefined };
  });
});

/**
 * STRUCTURAL ENFORCEMENT (#4751) — reading `orgContext` implies mounting
 * `requireOrgContext()`.
 *
 * #4356 replaced ~53 inline `if (!orgId) return 400` guards with
 * `const { orgId } = c.get("orgContext")`. The middleware is what makes that
 * read safe: without it, `c.get("orgContext")` is `undefined` and the
 * destructure throws a TypeError — a 500 where the route used to return a
 * clean 400 with an actionable message. Every converted router mounts it
 * today, but nothing pinned that, and the type system cannot: Hono's context
 * variable map is declared, not proven, so a router that forgets the mount
 * still type-checks.
 *
 * Sources are DISCOVERED by walking the tree rather than enumerated, so a
 * router added tomorrow is auto-enrolled instead of silently skipped.
 *
 * GRANULARITY: this is a FILE-level guard — a file that reads `orgContext`
 * must also mount `requireOrgContext()` somewhere. It deliberately does not
 * try to match reads to the specific router instance (several files declare
 * more than one `OpenAPIHono`), which would need an AST walk. It catches the
 * realistic failure — a whole router converted to the context read with no
 * mount — not a cross-wired read inside a multi-router file.
 *
 * CAVEAT (same as `trial-state.test.ts`): this reads sources off disk rather
 * than importing them, so it is `--affected`-blind. The full `bun run test` /
 * CI `api-tests` shards are what actually catch a missing mount.
 */
describe("structural: c.get(\"orgContext\") requires a requireOrgContext() mount (#4751)", () => {
  /** Walk up to the monorepo root (has both `packages/` and `plugins/`). */
  function repoRoot(): string {
    let dir = import.meta.dir;
    for (let i = 0; i < 12; i++) {
      if (existsSync(join(dir, "packages")) && existsSync(join(dir, "plugins"))) return dir;
      dir = dirname(dir);
    }
    throw new Error(`repo root not found from ${import.meta.dir}`);
  }

  function collectSources(dir: string, out: string[]): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        collectSources(full, out);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push(full);
      }
    }
    return out;
  }

  it("every source reading orgContext also mounts requireOrgContext()", () => {
    const root = repoRoot();
    // `admin-router.ts` DEFINES both the middleware and the fallback readers —
    // it is the canonical home, exempt the way `trial-state.ts` is for #4354.
    const canonical = join(root, "packages/api/src/api/routes/admin-router.ts");
    const roots = ["packages/api/src/api", "ee/src"].map((r) => join(root, r));
    // Assert the scanned trees are actually THERE rather than quietly guarding
    // nothing — `ee/` in particular is stub-swappable, and a guard that
    // silently stops covering a tree is worse than no guard at all.
    for (const dir of roots) expect({ dir, exists: existsSync(dir) }).toEqual({ dir, exists: true });

    const files = roots.flatMap((dir) => collectSources(dir, [])).filter((f) => f !== canonical);
    // Sanity: the walk actually found the tree it claims to guard.
    expect(files.length).toBeGreaterThan(100);

    const readers: string[] = [];
    const offenders: string[] = [];
    for (const file of files) {
      // Strip block + line comments — the 37 `// orgId is guaranteed non-null
      // by requireOrgContext()` notes are prose, not a mount.
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      if (!/c\.get\(\s*["']orgContext["']\s*\)/.test(source)) continue;
      readers.push(relative(root, file));
      if (!/requireOrgContext\s*\(\s*\)/.test(source)) offenders.push(relative(root, file));
    }

    // Anti-vacuity: the guard must actually be guarding the converted routers.
    expect(readers.length).toBeGreaterThan(5);
    expect(offenders).toEqual([]);
  });
});
