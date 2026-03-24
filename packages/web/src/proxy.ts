/**
 * Next.js 16 proxy (formerly middleware.ts).
 *
 * Redirects unauthenticated users to /signup and authenticated users away
 * from auth pages. Only active when NEXT_PUBLIC_ATLAS_AUTH_MODE is "managed"
 * (Better Auth). Other auth modes (none, simple-key, byot) skip the proxy
 * entirely since they don't use browser session cookies.
 *
 * This is an optimistic check — it reads the session cookie without hitting
 * the database. Actual auth enforcement happens at the API layer.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

const authMode = process.env.NEXT_PUBLIC_ATLAS_AUTH_MODE ?? "";

/** Routes that require authentication. */
const protectedPrefixes = ["/notebook", "/wizard", "/admin", "/create-org"];

/** Routes that only unauthenticated users should see. */
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

function isProtectedRoute(pathname: string): boolean {
  // Root "/" is protected (the main chat UI)
  if (pathname === "/") return true;
  return protectedPrefixes.some((prefix) => pathname.startsWith(prefix));
}

export function proxy(request: NextRequest) {
  // Only enforce redirects for managed (Better Auth) mode
  if (authMode !== "managed") {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;

  // Always allow public routes (demo, shared conversations, API, static assets)
  if (isPublicRoute(pathname)) {
    return NextResponse.next();
  }

  const sessionToken = getSessionCookie(request);

  // Authenticated user on an auth page → redirect to home
  if (sessionToken && isAuthRoute(pathname)) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  // Unauthenticated user on a protected route → redirect to signup
  if (!sessionToken && isProtectedRoute(pathname)) {
    return NextResponse.redirect(new URL("/signup", request.url));
  }

  return NextResponse.next();
}

export const proxyConfig = {
  // Run on all routes except static files and images
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff2?|ttf|eot)$).*)"],
};
