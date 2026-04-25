import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// RFC 8288 / 9727 link relations advertised on every docs response.
const LINK_HEADER = [
  '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
  '<https://docs.useatlas.dev/api-reference/openapi.json>; rel="service-desc"; type="application/openapi+json"',
  '<https://api.useatlas.dev/api/health>; rel="status"; type="application/json"',
  '</llms.txt>; rel="alternate"; type="text/plain"',
  '</llms-full.txt>; rel="describedby"; type="text/plain"',
  '</.well-known/mcp/server-card.json>; rel="mcp-server-card"; type="application/json"',
  '</.well-known/oauth-protected-resource>; rel="oauth-protected-resource"; type="application/json"',
  '</.well-known/agent-skills/index.json>; rel="agent-skills"; type="application/json"',
].join(", ");

function prefersMarkdown(req: NextRequest): boolean {
  const accept = req.headers.get("accept");
  if (!accept) return false;
  return accept
    .split(",")
    .some((part) => part.trim().toLowerCase().startsWith("text/markdown"));
}

/**
 * Map a docs page path to its markdown twin route. The
 * /llms.mdx/[[...slug]] route handler already produces a complete
 * markdown rendering (title + processed MDX) via getLLMText(), so
 * Accept-based negotiation is just an internal rewrite to that handler.
 */
// Paths that don't have a markdown twin. Most static-asset extensions
// are already filtered by the matcher regex below; this list covers the
// remaining route prefixes (Fumadocs internals, our own llms* + .well-
// known surfaces) plus the document-format extensions matcher doesn't
// strip. Keep both layers — the matcher is a perf gate, this is a
// correctness gate against a future matcher refactor.
const MARKDOWN_TWIN_SKIP_PREFIXES = ["/_next/", "/api/", "/.well-known/", "/llms", "/docs-og/"];
const MARKDOWN_TWIN_SKIP_SUFFIXES = [".mdx", ".txt", ".json", ".xml"];

function markdownTwinPath(pathname: string): string | null {
  // Homepage maps to the index.mdx page; the bare /llms.mdx route returns
  // 404 because source.getPage([]) doesn't resolve. /llms.mdx/index does.
  if (pathname === "/" || pathname === "/index") return "/llms.mdx/index";
  if (MARKDOWN_TWIN_SKIP_PREFIXES.some((p) => pathname.startsWith(p))) return null;
  if (MARKDOWN_TWIN_SKIP_SUFFIXES.some((s) => pathname.endsWith(s))) return null;
  const trimmed = pathname.replace(/\/+$/, "");
  return `/llms.mdx${trimmed}`;
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  if (prefersMarkdown(req)) {
    const twin = markdownTwinPath(pathname);
    if (twin) {
      const url = req.nextUrl.clone();
      url.pathname = twin;
      const res = NextResponse.rewrite(url);
      res.headers.set("Vary", "Accept");
      return res;
    }
  }

  const res = NextResponse.next();
  res.headers.set("Link", LINK_HEADER);
  res.headers.set("Vary", "Accept");
  return res;
}

// Run on /.well-known/* so the Link header advertises them on the
// canonical docs origin.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/search|.*\\.(?:woff2?|png|jpg|jpeg|gif|webp|avif|css|js)).*)",
  ],
};
