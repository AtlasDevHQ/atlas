/**
 * Next.js 16 proxy (replaces the middleware.ts convention from Next.js 15).
 *
 * Two responsibilities:
 * 1. Auth redirects — redirects unauthenticated users to /signup and
 *    authenticated users away from auth pages. Only active when
 *    NEXT_PUBLIC_ATLAS_AUTH_MODE is "managed" (Better Auth).
 * 2. Mode forwarding — reads the `atlas-mode` cookie and forwards it as
 *    an `x-atlas-mode` request header so server components can access the
 *    resolved mode without parsing cookies.
 *
 * Auth is an optimistic check — it reads the session cookie without hitting
 * the database. Actual auth enforcement happens at the API layer.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { ATLAS_MODES } from "@useatlas/types/auth";

const authMode = process.env.NEXT_PUBLIC_ATLAS_AUTH_MODE ?? "";
const VALID_MODES = new Set<string>(ATLAS_MODES);

/** Routes that only unauthenticated users should see (exact match). */
const authRoutes = ["/signup", "/login"];

/** Routes that are always accessible regardless of auth state. */
const publicPrefixes = ["/demo", "/shared", "/api", "/_next"];

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
 */
function withModeHeader(request: NextRequest): NextResponse {
  const raw = request.cookies.get("atlas-mode")?.value;
  const mode = raw && VALID_MODES.has(raw) ? raw : "published";
  const headers = new Headers(request.headers);
  headers.set("x-atlas-mode", mode);
  return NextResponse.next({ request: { headers } });
}

export function proxy(request: NextRequest) {
  // Only enforce redirects for managed (Better Auth) mode
  if (authMode !== "managed") {
    return withModeHeader(request);
  }

  const { pathname } = request.nextUrl;

  // Always allow public routes (demo, shared conversations, API, Next.js internals)
  if (isPublicRoute(pathname)) {
    return withModeHeader(request);
  }

  try {
    const sessionToken = getSessionCookie(request);

    // Authenticated user on an auth page → redirect to home
    if (sessionToken && isAuthRoute(pathname)) {
      return NextResponse.redirect(new URL("/", request.url));
    }

    // Unauthenticated user on any non-public, non-auth route → redirect to login.
    // Default-deny: new pages are protected without needing to update a list.
    if (!sessionToken && !isAuthRoute(pathname)) {
      return NextResponse.redirect(new URL("/login", request.url));
    }
  } catch (err) {
    // Fail open: the API layer is the real auth boundary. A crash here
    // must not take down the entire frontend with 500s on every request.
    console.error(
      "[atlas] Auth proxy cookie check failed — allowing request through:",
      err instanceof Error ? err.message : String(err),
    );
  }

  return withModeHeader(request);
}

// Next.js 16 requires the export to be named `config`, not `proxyConfig`.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff2?|ttf|eot)$).*)"],
};
