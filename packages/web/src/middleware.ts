/**
 * Next.js middleware — reads the `atlas-mode` cookie for SSR.
 *
 * Forwards the cookie value as an `x-atlas-mode` request header so that
 * server components and API route proxies can read it without parsing
 * cookies themselves. If the cookie is missing, defaults to `published`.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const VALID_MODES = new Set(["developer", "published"]);

export function middleware(request: NextRequest) {
  const raw = request.cookies.get("atlas-mode")?.value;
  const mode = raw && VALID_MODES.has(raw) ? raw : "published";

  const headers = new Headers(request.headers);
  headers.set("x-atlas-mode", mode);

  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Run on all routes except static assets and Next.js internals
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
