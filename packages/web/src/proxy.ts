/**
 * Next.js 16 proxy (replaces the middleware.ts convention from Next.js 15).
 *
 * Three responsibilities:
 * 1. Content-Security-Policy — mints a per-request nonce and emits a
 *    nonce-based CSP so `script-src` uses `'nonce-…' 'strict-dynamic'` instead
 *    of `'unsafe-inline'`. See the CSP section below.
 * 2. Auth redirects — redirects unauthenticated users to /login and
 *    authenticated users away from auth pages. Only active when
 *    NEXT_PUBLIC_ATLAS_AUTH_MODE is "managed" (Better Auth).
 * 3. Mode forwarding — reads the `atlas-mode` cookie and forwards it as
 *    an `x-atlas-mode` request header so server components can access the
 *    resolved mode without parsing cookies.
 *
 * Auth is an optimistic check — it reads the session cookie without hitting
 * the database. Actual auth enforcement happens at the API layer.
 *
 * --- CSP: why the nonce posture lives in the proxy (#3899) ---
 *
 * A nonce-based `script-src` needs a *fresh, per-request* nonce, which the
 * static `headers()` config in next.config.ts cannot mint. So the proxy mints
 * the nonce, surfaces it on the `x-nonce` request header, and sets the CSP on
 * BOTH the forwarded request (so Next, seeing a `'nonce-…'` token in the
 * request's `Content-Security-Policy`, stamps that nonce onto its own
 * framework/hydration <script> tags during SSR) and the response (so the
 * browser enforces it). The root layout reads `x-nonce` to stamp the one
 * hand-written inline script (theme init). Dropping `'unsafe-inline'` from
 * `script-src` is the point: it's the directive that otherwise neuters CSP's
 * XSS protection (an injected inline <script> would execute).
 *
 * next.config.ts `headers()` STILL declares a static `'unsafe-inline'` CSP.
 * That is deliberate and not a duplicate: in the standalone router-server
 * (how this package deploys — `output: "standalone"`, set whenever not on
 * Vercel; the canonical deploy is Railway) the proxy's response headers are
 * merged into the config headers BY KEY, so this proxy's later
 * `set("Content-Security-Policy", …)` OVERWRITES the config's static CSP — the
 * browser sees exactly one CSP header, the nonce one. (If a future Next.js
 * upgrade ever *appended* a same-key response header instead of replacing it,
 * two CSP headers would ship and the browser would enforce their intersection,
 * silently re-admitting the static `'unsafe-inline'`. The live header is
 * spot-checkable with `curl -sI <url> | grep -ci content-security-policy` →
 * must be 1.) The static block is kept because (a) it is drift-locked
 * byte-for-byte to the scaffold next.config.ts mirrors, which ship NO proxy
 * and so rely on it for a working CSP, and (b) it is a safe fallback if a
 * deploy ever bypasses the proxy. The non-CSP security headers (HSTS,
 * X-Frame-Options, nosniff, Referrer-Policy) and Cache-Control are owned
 * solely by next.config.ts.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { ATLAS_MODES } from "@useatlas/types/auth";
import { PUBLIC_ROUTE_PREFIXES } from "./lib/public-routes";
import { resolveWebCookiePrefix } from "./lib/cookie-prefix";
import { buildCsp, frameAncestorsFor } from "./lib/csp";

const authMode = process.env.NEXT_PUBLIC_ATLAS_AUTH_MODE ?? "";
const VALID_MODES = new Set<string>(ATLAS_MODES);

const cspEnv = process.env.NODE_ENV === "development" ? "dev" : "prod";

// Session-cookie name prefix — MUST match the API's `advanced.cookiePrefix`
// (resolved per deploy env in `@atlas/api/lib/env-profile`). The frontend
// can't import that module, so the value is mirrored here via env. Defaults
// to "atlas" to match the API's `production` profile, so unconfigured
// self-hosted deploys agree without extra wiring. Atlas staging sets
// NEXT_PUBLIC_ATLAS_COOKIE_PREFIX=atlas-staging; local dev sets atlas-dev.
// Without this, prod's `.useatlas.dev` cookie (delivered to staging because
// staging is a subdomain) would satisfy this optimistic presence check and
// suppress the /login redirect on a different environment.
// `process.env.NEXT_PUBLIC_*` is read here as a direct static reference so
// Next inlines it at build time; `resolveWebCookiePrefix` only applies the
// default/trim (mirrors the API's resolveCookiePrefix and is unit-tested).
const cookiePrefix = resolveWebCookiePrefix(process.env.NEXT_PUBLIC_ATLAS_COOKIE_PREFIX);

/** Routes that only unauthenticated users should see (exact match). */
const authRoutes = ["/signup", "/login", "/forgot-password", "/reset-password"];

/** Routes that are always accessible regardless of auth state. */
const publicPrefixes = [...PUBLIC_ROUTE_PREFIXES, "/api", "/_next"];

function isPublicRoute(pathname: string): boolean {
  return publicPrefixes.some((prefix) => pathname.startsWith(prefix));
}

function isAuthRoute(pathname: string): boolean {
  // Exact match only — sub-routes like /signup/workspace are onboarding
  // steps that require an active session and must not redirect away.
  return authRoutes.some((route) => pathname === route);
}

/**
 * Forward the `atlas-mode` cookie as an `x-atlas-mode` request header so
 * server components can read the resolved mode without parsing cookies.
 * Invalid or missing cookie values default to `published`.
 *
 * Also stamps the per-request `x-nonce` request header and the CSP on both the
 * forwarded request (so Next sees `'nonce-…'` and propagates it to its own
 * <script> tags during SSR) and the response (so the browser enforces it).
 */
function withModeHeader(request: NextRequest, nonce: string, csp: string): NextResponse {
  const raw = request.cookies.get("atlas-mode")?.value;
  const mode = raw && VALID_MODES.has(raw) ? raw : "published";
  const headers = new Headers(request.headers);
  headers.set("x-atlas-mode", mode);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

/**
 * A redirect (307) has no HTML/script body, so a missing CSP on it can't be
 * exploited — and the redirect target re-enters the proxy and gets its own
 * fresh nonce CSP. We still stamp the response CSP here so enforcement is
 * uniform across every exit point (no "why does this one response lack a CSP?"
 * surprise for a future reader) rather than relying on the target's re-entry.
 */
function redirectWithCsp(url: URL, csp: string): NextResponse {
  const response = NextResponse.redirect(url);
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // Per-request nonce: random and unguessable, so an injected inline <script>
  // can't carry a matching nonce. Encoded base64 per the Next.js CSP guide.
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce, frameAncestorsFor(pathname), cspEnv);

  // Only enforce redirects for managed (Better Auth) mode
  if (authMode !== "managed") {
    return withModeHeader(request, nonce, csp);
  }

  // Always allow public routes (demo, shared conversations, API, Next.js internals)
  if (isPublicRoute(pathname)) {
    return withModeHeader(request, nonce, csp);
  }

  try {
    const sessionToken = getSessionCookie(request, { cookiePrefix });

    // Authenticated user on an auth page → redirect to home
    if (sessionToken && isAuthRoute(pathname)) {
      return redirectWithCsp(new URL("/", request.url), csp);
    }

    // Unauthenticated user on any non-public, non-auth route → redirect to login.
    // Default-deny: new pages are protected without needing to update a list.
    if (!sessionToken && !isAuthRoute(pathname)) {
      return redirectWithCsp(new URL("/login", request.url), csp);
    }
  } catch (err) {
    // Fail open: the API layer is the real auth boundary. A crash here
    // must not take down the entire frontend with 500s on every request.
    console.error(
      "[atlas] Auth proxy cookie check failed — allowing request through:",
      err instanceof Error ? err.message : String(err),
    );
  }

  return withModeHeader(request, nonce, csp);
}

// Next.js 16 requires the export to be named `config`, not `proxyConfig`.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff2?|ttf|eot)$).*)"],
};
