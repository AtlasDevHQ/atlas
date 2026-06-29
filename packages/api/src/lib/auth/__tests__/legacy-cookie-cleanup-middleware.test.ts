import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createLegacyCookieCleanupMiddleware } from "../legacy-cookie-cleanup-middleware";

/**
 * Wiring test for the #4086 cleanup middleware. Drives the EXACT production
 * middleware (`createLegacyCookieCleanupMiddleware`, the same factory wired in
 * `api/index.ts`) — only the cookie-prefix source is injected, so the test
 * doesn't hinge on the ambient `ATLAS_DEPLOY_ENV`. Confirms the post-`next()`
 * append surfaces as distinct `Set-Cookie` headers in Hono, fires on the
 * `/api/v1/*` surface that actually broke (#4086), leaves the route's own
 * response intact, and that a cleanup failure can never break the response.
 */
const SHADOW_COOKIE =
  "__Secure-atlas.session_token=hostonly.sig; __Secure-atlas.session_token=staleparent.sig";
const ROUTE_COOKIE =
  "__Secure-atlas.session_token=fresh.sig; Path=/; HttpOnly; Secure; SameSite=Lax";

/** App with the real middleware and a route that sets its OWN host-only cookie. */
function makeApp(resolvePrefix: () => string = () => "atlas") {
  const app = new Hono();
  app.use("/api/*", createLegacyCookieCleanupMiddleware(resolvePrefix));
  // Stands in for Better Auth's response (sets its own host-only session cookie).
  app.get("/api/auth/get-session", (c) => {
    c.header("set-cookie", ROUTE_COOKIE, { append: true });
    return c.json({ ok: true });
  });
  // The exact endpoint #4086 reported 401-looping — a non-200 /api/v1/* route
  // that sets NO cookie of its own.
  app.post("/api/v1/onboarding/use-demo", (c) => c.json({ error: "unauthorized" }, 401));
  return app;
}

describe("#4086 cleanup middleware wiring", () => {
  it("appends parent-domain deletions when the shadow cookie is present", async () => {
    const app = makeApp();
    const res = await app.request("https://api.useatlas.dev/api/auth/get-session", {
      headers: { host: "api.useatlas.dev", cookie: SHADOW_COOKIE },
    });
    const setCookies = res.headers.getSetCookie();
    // The route's own host-only cookie survives…
    expect(setCookies.some((c) => c.startsWith("__Secure-atlas.session_token=fresh.sig"))).toBe(true);
    // …and the parent-domain deletions are appended.
    expect(setCookies).toContain(
      "__Secure-atlas.session_token=; Domain=useatlas.dev; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
    );
    expect(setCookies).toContain(
      "__Secure-atlas.session_data=; Domain=useatlas.dev; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
    );
  });

  it("fires on a non-200 /api/v1/* response (the #4086 endpoint), not just /api/auth/*", async () => {
    // Guards against a future "it's an auth cookie" refactor narrowing the glob
    // to /api/auth/* — which would re-break the reported use-demo 401 loop.
    const app = makeApp();
    const res = await app.request("https://api.useatlas.dev/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { host: "api.useatlas.dev", cookie: SHADOW_COOKIE },
    });
    expect(res.status).toBe(401);
    const setCookies = res.headers.getSetCookie();
    // The route set no cookie of its own → the deletions are the sole Set-Cookie.
    expect(setCookies).toEqual([
      "__Secure-atlas.session_token=; Domain=useatlas.dev; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
      "__Secure-atlas.session_data=; Domain=useatlas.dev; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
    ]);
  });

  it("appends nothing for a clean browser (no duplicate session token)", async () => {
    const app = makeApp();
    const res = await app.request("https://api.useatlas.dev/api/auth/get-session", {
      headers: {
        host: "api.useatlas.dev",
        cookie: "__Secure-atlas.session_token=hostonly.sig; __Secure-atlas.session_data=cache",
      },
    });
    // Only the route's own cookie; no Max-Age=0 deletions.
    expect(res.headers.getSetCookie()).toEqual([ROUTE_COOKIE]);
  });

  it("best-effort: a cleanup failure leaves the route response intact", async () => {
    // Force the helper path to throw (prefix resolution is inside the try) and
    // assert the committed auth response still returns — a cleanup failure must
    // never convert a good 200 into a 500.
    const app = makeApp(() => {
      throw new Error("prefix boom");
    });
    const res = await app.request("https://api.useatlas.dev/api/auth/get-session", {
      headers: { host: "api.useatlas.dev", cookie: SHADOW_COOKIE },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // The route's own cookie is untouched; no deletions were appended.
    expect(res.headers.getSetCookie()).toEqual([ROUTE_COOKIE]);
  });
});
