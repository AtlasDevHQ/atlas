/**
 * Unit tests for the {@link mfaRequired} middleware.
 *
 * Covers the role × mode × enrollment-state matrix:
 *   - managed admin without MFA → 403 with mfa_enrollment_required
 *   - managed admin with TOTP → pass-through
 *   - managed admin with passkey only → pass-through
 *   - managed admin with both factors → pass-through
 *   - managed platform_admin without MFA → 403
 *   - managed owner without MFA → 403 (mirrors adminAuth's role admit-list)
 *   - managed member without MFA → pass-through (not enforced for members)
 *   - simple-key admin without MFA → pass-through (programmatic, no TOTP)
 *   - byot admin without MFA → pass-through (MFA delegated to issuer)
 *   - mode "none" (local-dev) → pass-through (no user, nothing to gate)
 *   - missing authResult (middleware misorder) → 500 fail-closed with auth_misconfigured
 *
 * The 403 response shape is part of the public API — every key is asserted
 * by literal value, not by comparison against the module's own constants.
 *
 * Better Auth's enrollment routes (`/api/auth/two-factor/*`) and sign-out
 * are NOT exercised here — they live on a different sub-app
 * (`api/index.ts`) and never traverse this middleware. See the file
 * header in `admin-mfa-required.ts`.
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
import { mfaRequired } from "../admin-mfa-required";
import type { AuthEnv } from "../middleware";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeUserOpts {
  role?: "admin" | "platform_admin" | "member" | "owner";
  twoFactorEnabled?: boolean;
  passkeyCount?: number;
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
      claims: Object.freeze({
        twoFactorEnabled: opts.twoFactorEnabled === true,
        passkeyCount: opts.passkeyCount ?? 0,
      }),
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

    // Wire-format contract — every key is asserted by literal value so a
    // future rename (e.g. ENROLLMENT_URL drift) breaks this test rather
    // than slipping past silently.
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("mfa_enrollment_required");
    expect(body.enrollmentUrl).toBe("/admin/account-security");
    expect(body.requestId).toBe("test-req-id");
    expect(typeof body.message).toBe("string");
    expect((body.message as string).toLowerCase()).toContain("two-factor");
    // Copy must mention both options so passkey-only users aren't told to set up TOTP.
    expect((body.message as string).toLowerCase()).toMatch(/passkey/);
    // Lock the body shape — no leakage of internal fields like userId/role/claims.
    expect(Object.keys(body).toSorted()).toEqual(
      ["enrollmentUrl", "error", "message", "requestId"].toSorted(),
    );
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

  it("blocks an owner-role user without MFA (mirrors adminAuth's admit-list)", async () => {
    // `managed.ts:resolveEffectiveRole` returns "owner" whenever the user's
    // org-level role outranks their user-level role. `adminAuth` admits
    // owner alongside admin/platform_admin (`middleware.ts:ADMIN_ROLE_SET`).
    // If `mfaRequired` exempted owner, every workspace owner would silently
    // bypass the gate — the `/privacy` §9 + `/dpa` Annex II promise has to
    // hold for every role that can reach an admin route.
    const app = new OpenAPIHono<AuthEnv>();
    injectAuth(app, fakeAuthResult({ role: "owner", twoFactorEnabled: false }));
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

  it("passes through when an admin user has only a passkey enrolled (no TOTP)", async () => {
    const app = new OpenAPIHono<AuthEnv>();
    injectAuth(app, fakeAuthResult({ role: "admin", twoFactorEnabled: false, passkeyCount: 1 }));
    app.use(mfaRequired);
    app.openapi(okRoute, (c) => c.json({ ok: true }, 200));

    const res = await app.request("/admin/anything");
    expect(res.status).toBe(200);
  });

  it("passes through when an admin user has both TOTP and passkeys enrolled", async () => {
    const app = new OpenAPIHono<AuthEnv>();
    injectAuth(app, fakeAuthResult({ role: "admin", twoFactorEnabled: true, passkeyCount: 2 }));
    app.use(mfaRequired);
    app.openapi(okRoute, (c) => c.json({ ok: true }, 200));

    const res = await app.request("/admin/anything");
    expect(res.status).toBe(200);
  });

  it("blocks when both factors are absent (twoFactorEnabled=false, passkeyCount=0)", async () => {
    // The both-zero case is the canonical reject — admin with no second
    // factor of any kind. Asserted explicitly so a regression where
    // passkeyCount=0 accidentally short-circuits admit can't slip past.
    const app = new OpenAPIHono<AuthEnv>();
    injectAuth(app, fakeAuthResult({ role: "admin", twoFactorEnabled: false, passkeyCount: 0 }));
    app.use(mfaRequired);
    app.openapi(okRoute, (c) => c.json({ ok: true }, 200));

    const res = await app.request("/admin/anything");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("mfa_enrollment_required");
  });

  it("passes through when an owner user has MFA enrolled", async () => {
    const app = new OpenAPIHono<AuthEnv>();
    injectAuth(app, fakeAuthResult({ role: "owner", twoFactorEnabled: true }));
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

  it("treats passkeyCount values that aren't real positive numbers as not-enrolled", async () => {
    // Symmetric to the twoFactorEnabled-as-string case. The gate's strict
    // narrowing is the load-bearing defense against shape drift.
    const cases: Array<{ name: string; value: unknown }> = [
      { name: "string '1'", value: "1" as unknown as number },
      { name: "string 'true'", value: "true" as unknown as number },
      { name: "boolean true", value: true as unknown as number },
      { name: "NaN", value: Number.NaN },
      { name: "negative", value: -1 },
      { name: "zero", value: 0 },
    ];
    for (const { name, value } of cases) {
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
              claims: Object.freeze({ twoFactorEnabled: false, passkeyCount: value }),
            },
          });
          c.set("atlasMode", "published");
          await next();
        }),
      );
      app.use(mfaRequired);
      app.openapi(okRoute, (c) => c.json({ ok: true }, 200));

      const res = await app.request("/admin/anything");
      expect(res.status, `passkeyCount=${name} should reject`).toBe(403);
    }
  });

  it("treats claims with twoFactorEnabled=false and no passkeyCount field as not-enrolled", async () => {
    // The gate must fail closed when `passkeyCount` is absent from claims —
    // not just when its value is the wrong shape. Catches a future managed.ts
    // refactor that stops writing the field under some code path.
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
            claims: Object.freeze({ twoFactorEnabled: false }), // no passkeyCount key
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

  it("returns 500 auth_misconfigured when authResult is missing (middleware-order contract)", async () => {
    // If somebody mounts mfaRequired without adminAuth in front of it, the
    // gate must fail closed with a clear error rather than throwing a bare
    // TypeError that surfaces as an opaque 500.
    const app = new OpenAPIHono<AuthEnv>();
    app.use(
      createMiddleware<AuthEnv>(async (c, next) => {
        c.set("requestId", "test-req-id");
        // intentionally no c.set("authResult", ...)
        c.set("atlasMode", "published");
        await next();
      }),
    );
    app.use(mfaRequired);
    app.openapi(okRoute, (c) => c.json({ ok: true }, 200));

    const res = await app.request("/admin/anything");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("auth_misconfigured");
    expect(body.requestId).toBe("test-req-id");
  });
});
