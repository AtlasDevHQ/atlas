/**
 * Unit tests for the {@link mfaRequired} middleware.
 *
 * Covers the role × mode × enrollment-state × url-bypass matrix:
 *   - managed admin without MFA → 403 with mfa_enrollment_required
 *   - managed admin with MFA → pass-through
 *   - managed platform_admin without MFA → 403
 *   - managed member without MFA → pass-through (not enforced for members)
 *   - simple-key admin without MFA → pass-through (programmatic, no TOTP)
 *   - byot admin without MFA → pass-through (MFA delegated to issuer)
 *   - mode "none" (local-dev) → pass-through (no user, nothing to gate)
 *   - managed admin without MFA hitting /api/auth/two-factor/* → pass-through
 *   - managed admin without MFA hitting /api/auth/sign-out → pass-through
 *
 * @see packages/api/src/api/routes/admin-mfa-required.ts
 */

import { describe, it, expect, mock } from "bun:test";

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    createLogger: () => logger,
    withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  };
});

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import { mfaRequired, ENROLLMENT_URL } from "../admin-mfa-required";
import type { AuthEnv } from "../middleware";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeUserOpts {
  role?: "admin" | "platform_admin" | "member" | "owner";
  twoFactorEnabled?: boolean;
}

function fakeAuthResult(opts: FakeUserOpts = {}): AuthResult & { authenticated: true } {
  const role = opts.role ?? "admin";
  return {
    authenticated: true,
    mode: "managed",
    user: {
      id: "user-1",
      mode: "managed",
      label: "test@atlas.dev",
      role,
      activeOrganizationId: "org-1",
      claims: Object.freeze({ twoFactorEnabled: opts.twoFactorEnabled === true }),
    },
  };
}

function fakeNoneAuthResult(): AuthResult & { authenticated: true } {
  return { authenticated: true, mode: "none", user: undefined };
}

function injectAuth(
  app: OpenAPIHono<AuthEnv>,
  authResult: AuthResult & { authenticated: true },
) {
  app.use(
    createMiddleware<AuthEnv>(async (c, next) => {
      c.set("requestId", "test-req-id");
      c.set("authResult", authResult);
      c.set("atlasMode", "published");
      await next();
    }),
  );
}

const okRoute = createRoute({
  method: "get",
  path: "/admin/anything",
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
    },
  },
});

const enrollRoute = createRoute({
  method: "get",
  path: "/api/auth/two-factor/enable",
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
    },
  },
});

const signOutRoute = createRoute({
  method: "get",
  path: "/api/auth/sign-out",
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
    },
  },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mfaRequired middleware", () => {
  it("blocks an admin user without MFA enrolled with 403 + mfa_enrollment_required", async () => {
    const app = new OpenAPIHono<AuthEnv>();
    injectAuth(app, fakeAuthResult({ role: "admin", twoFactorEnabled: false }));
    app.use(mfaRequired);
    app.openapi(okRoute, (c) => c.json({ ok: true }, 200));

    const res = await app.request("/admin/anything");
    expect(res.status).toBe(403);

    const body = (await res.json()) as {
      error: string;
      message: string;
      enrollmentUrl: string;
      requestId: string;
    };
    expect(body.error).toBe("mfa_enrollment_required");
    expect(body.enrollmentUrl).toBe(ENROLLMENT_URL);
    expect(body.requestId).toBe("test-req-id");
    expect(body.message).toMatch(/two-factor/i);
  });

  it("blocks a platform_admin user without MFA enrolled with 403", async () => {
    const app = new OpenAPIHono<AuthEnv>();
    injectAuth(app, fakeAuthResult({ role: "platform_admin", twoFactorEnabled: false }));
    app.use(mfaRequired);
    app.openapi(okRoute, (c) => c.json({ ok: true }, 200));

    const res = await app.request("/admin/anything");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("mfa_enrollment_required");
  });

  it("passes through when an admin user has MFA enrolled", async () => {
    const app = new OpenAPIHono<AuthEnv>();
    injectAuth(app, fakeAuthResult({ role: "admin", twoFactorEnabled: true }));
    app.use(mfaRequired);
    app.openapi(okRoute, (c) => c.json({ ok: true }, 200));

    const res = await app.request("/admin/anything");
    expect(res.status).toBe(200);
  });

  it("passes through for member-role users (gate is admin-only)", async () => {
    const app = new OpenAPIHono<AuthEnv>();
    injectAuth(app, fakeAuthResult({ role: "member", twoFactorEnabled: false }));
    app.use(mfaRequired);
    app.openapi(okRoute, (c) => c.json({ ok: true }, 200));

    const res = await app.request("/admin/anything");
    expect(res.status).toBe(200);
  });

  it("passes through for owner-role users (gate is admin/platform_admin only)", async () => {
    // owner is a separate role from admin in some auth modes — verify it
    // is not enforced unless an explicit policy expansion lands.
    const app = new OpenAPIHono<AuthEnv>();
    injectAuth(app, fakeAuthResult({ role: "owner", twoFactorEnabled: false }));
    app.use(mfaRequired);
    app.openapi(okRoute, (c) => c.json({ ok: true }, 200));

    const res = await app.request("/admin/anything");
    expect(res.status).toBe(200);
  });

  it("passes through for mode:'none' (local-dev no-auth carve-out)", async () => {
    const app = new OpenAPIHono<AuthEnv>();
    injectAuth(app, fakeNoneAuthResult());
    app.use(mfaRequired);
    app.openapi(okRoute, (c) => c.json({ ok: true }, 200));

    const res = await app.request("/admin/anything");
    expect(res.status).toBe(200);
  });

  it("passes through for simple-key admin without MFA (programmatic, TOTP not applicable)", async () => {
    // Service-to-service / CI calls authenticate with an API key. There is no
    // interactive login that could collect a TOTP, so the gate doesn't apply.
    const app = new OpenAPIHono<AuthEnv>();
    app.use(
      createMiddleware<AuthEnv>(async (c, next) => {
        c.set("requestId", "test-req-id");
        c.set("authResult", {
          authenticated: true,
          mode: "simple-key",
          user: {
            id: "ci-bot",
            mode: "simple-key",
            label: "ci-bot",
            role: "admin",
            activeOrganizationId: "org-1",
          },
        });
        c.set("atlasMode", "published");
        await next();
      }),
    );
    app.use(mfaRequired);
    app.openapi(okRoute, (c) => c.json({ ok: true }, 200));

    const res = await app.request("/admin/anything");
    expect(res.status).toBe(200);
  });

  it("passes through for byot admin without MFA (MFA delegated to JWT issuer)", async () => {
    // Bring-your-own-token assumes the upstream IdP enforced MFA before
    // signing the JWT. We trust the issuer.
    const app = new OpenAPIHono<AuthEnv>();
    app.use(
      createMiddleware<AuthEnv>(async (c, next) => {
        c.set("requestId", "test-req-id");
        c.set("authResult", {
          authenticated: true,
          mode: "byot",
          user: {
            id: "jwt-user",
            mode: "byot",
            label: "jwt@example.com",
            role: "admin",
            activeOrganizationId: "org-1",
          },
        });
        c.set("atlasMode", "published");
        await next();
      }),
    );
    app.use(mfaRequired);
    app.openapi(okRoute, (c) => c.json({ ok: true }, 200));

    const res = await app.request("/admin/anything");
    expect(res.status).toBe(200);
  });

  it("lets an admin without MFA reach /api/auth/two-factor/* (enrollment endpoints)", async () => {
    const app = new OpenAPIHono<AuthEnv>();
    injectAuth(app, fakeAuthResult({ role: "admin", twoFactorEnabled: false }));
    app.use(mfaRequired);
    app.openapi(enrollRoute, (c) => c.json({ ok: true }, 200));

    const res = await app.request("/api/auth/two-factor/enable");
    expect(res.status).toBe(200);
  });

  it("lets an admin without MFA reach /api/auth/sign-out (escape hatch)", async () => {
    const app = new OpenAPIHono<AuthEnv>();
    injectAuth(app, fakeAuthResult({ role: "admin", twoFactorEnabled: false }));
    app.use(mfaRequired);
    app.openapi(signOutRoute, (c) => c.json({ ok: true }, 200));

    const res = await app.request("/api/auth/sign-out");
    expect(res.status).toBe(200);
  });

  it("treats missing claims object as not-enrolled (fail closed)", async () => {
    const app = new OpenAPIHono<AuthEnv>();
    app.use(
      createMiddleware<AuthEnv>(async (c, next) => {
        c.set("requestId", "test-req-id");
        c.set("authResult", {
          authenticated: true,
          mode: "managed",
          user: {
            id: "user-1",
            mode: "managed",
            label: "test@atlas.dev",
            role: "admin",
            activeOrganizationId: "org-1",
            // no claims field at all
          },
        });
        c.set("atlasMode", "published");
        await next();
      }),
    );
    app.use(mfaRequired);
    app.openapi(okRoute, (c) => c.json({ ok: true }, 200));

    const res = await app.request("/admin/anything");
    expect(res.status).toBe(403);
  });

  it("treats twoFactorEnabled values other than literal true as not-enrolled", async () => {
    // Defensive — Better Auth could one day return a string "true" or 1; the
    // gate should only open on the strict boolean true.
    const app = new OpenAPIHono<AuthEnv>();
    app.use(
      createMiddleware<AuthEnv>(async (c, next) => {
        c.set("requestId", "test-req-id");
        c.set("authResult", {
          authenticated: true,
          mode: "managed",
          user: {
            id: "user-1",
            mode: "managed",
            label: "test@atlas.dev",
            role: "admin",
            activeOrganizationId: "org-1",
            claims: Object.freeze({ twoFactorEnabled: "true" as unknown as boolean }),
          },
        });
        c.set("atlasMode", "published");
        await next();
      }),
    );
    app.use(mfaRequired);
    app.openapi(okRoute, (c) => c.json({ ok: true }, 200));

    const res = await app.request("/admin/anything");
    expect(res.status).toBe(403);
  });
});
