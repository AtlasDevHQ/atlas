import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { buildLegacyCookieDeletions } from "../legacy-cookie-cleanup";

/**
 * Wiring test for the #4086 cleanup middleware: confirms that appending the
 * helper's deletions via `c.res.headers.append("set-cookie", …)` AFTER `next()`
 * actually surfaces as distinct `Set-Cookie` response headers in Hono — and that
 * it leaves the route's own response (incl. its own Set-Cookie) intact. Mirrors
 * the middleware in `api/index.ts` without standing up the full Atlas app.
 */
function makeApp() {
  const app = new Hono();
  app.use("/api/*", async (c, next) => {
    await next();
    const deletions = buildLegacyCookieDeletions({
      cookieHeader: c.req.header("cookie"),
      host: c.req.header("host"),
      cookiePrefix: "atlas",
    });
    for (const setCookie of deletions) c.res.headers.append("set-cookie", setCookie);
  });
  // A route that authenticates and sets its OWN (host-only) session cookie,
  // standing in for Better Auth's response.
  app.get("/api/auth/get-session", (c) => {
    c.header("set-cookie", "__Secure-atlas.session_token=fresh.sig; Path=/; HttpOnly; Secure; SameSite=Lax", { append: true });
    return c.json({ ok: true });
  });
  return app;
}

describe("#4086 cleanup middleware wiring", () => {
  it("appends parent-domain deletions when the shadow cookie is present", async () => {
    const app = makeApp();
    const res = await app.request("https://api.useatlas.dev/api/auth/get-session", {
      headers: {
        host: "api.useatlas.dev",
        cookie:
          "__Secure-atlas.session_token=hostonly.sig; __Secure-atlas.session_token=staleparent.sig",
      },
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

  it("appends nothing for a clean browser (no duplicate session token)", async () => {
    const app = makeApp();
    const res = await app.request("https://api.useatlas.dev/api/auth/get-session", {
      headers: {
        host: "api.useatlas.dev",
        cookie: "__Secure-atlas.session_token=hostonly.sig; __Secure-atlas.session_data=cache",
      },
    });
    const setCookies = res.headers.getSetCookie();
    // Only the route's own cookie; no Max-Age=0 deletions.
    expect(setCookies).toEqual(["__Secure-atlas.session_token=fresh.sig; Path=/; HttpOnly; Secure; SameSite=Lax"]);
  });
});
