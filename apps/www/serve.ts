import { join } from "path";

const OUT_DIR = join(import.meta.dir, "out");
const port = parseInt(process.env.PORT || "8080");

// `script-src 'unsafe-inline'` is required by Next.js's `__NEXT_DATA__` and
// hydration runtime. `style-src 'unsafe-inline'` is required by Next.js's
// inlined critical CSS. Operators who add analytics or third-party scripts
// will need to extend this in their own deploy.
const WWW_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "Content-Security-Policy": WWW_CSP,
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // Set globally so any cache fronting the server keeps the markdown twin
  // and the HTML representation distinct.
  Vary: "Accept",
};

// RFC 8288 / 9727 link relations advertised on the homepage. Single line
// so curl -I shows it cleanly.
const HOMEPAGE_LINK_HEADER = [
  '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
  '<https://docs.useatlas.dev/api-reference/openapi.json>; rel="service-desc"; type="application/openapi+json"',
  '<https://docs.useatlas.dev/api-reference>; rel="service-doc"; type="text/html"',
  '<https://api.useatlas.dev/api/health>; rel="status"; type="application/json"',
  '</llms.txt>; rel="alternate"; type="text/markdown"',
  '</.well-known/mcp/server-card.json>; rel="mcp-server-card"; type="application/json"',
  '</.well-known/oauth-protected-resource>; rel="oauth-protected-resource"; type="application/json"',
  '</.well-known/agent-skills/index.json>; rel="agent-skills"; type="application/json"',
].join(", ");

// /.well-known canonical URLs are extension-less per their RFCs; the on-disk
// files keep .json so editors and CI linters recognize them.
const WELL_KNOWN_ROUTES: Record<string, { file: string; contentType: string }> = {
  "/.well-known/api-catalog": {
    file: "/.well-known/api-catalog.json",
    contentType: "application/linkset+json; charset=utf-8",
  },
  "/.well-known/oauth-protected-resource": {
    file: "/.well-known/oauth-protected-resource.json",
    contentType: "application/json; charset=utf-8",
  },
};

const API_HEALTH_URL = "https://api.useatlas.dev/api/health";
const HEALTH_TIMEOUT_MS = 10_000;

/** Server-side proxy for the Atlas API health endpoint. Avoids CORS. */
async function proxyApiHealth(): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

  try {
    const start = performance.now();
    const res = await fetch(API_HEALTH_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    const latencyMs = Math.round(performance.now() - start);

    if (!res.ok) {
      return Response.json({ status: "down", latencyMs });
    }

    const body = (await res.json()) as { status?: string };
    const status =
      body.status === "ok"
        ? "operational"
        : body.status === "degraded"
          ? "degraded"
          : "down";

    return Response.json({ status, latencyMs });
  } catch (err) {
    console.debug(
      "[health-proxy] API health check failed:",
      err instanceof Error ? err.message : String(err),
    );
    return Response.json({ status: "down" });
  } finally {
    clearTimeout(timeout);
  }
}

function prefersMarkdown(req: Request): boolean {
  const accept = req.headers.get("accept");
  if (!accept) return false;
  return accept
    .split(",")
    .some((part) => part.trim().toLowerCase().startsWith("text/markdown"));
}

function markdownTwinPath(pathname: string): string {
  // "/" maps to llms.txt — hand-curated as our canonical "what Atlas is"
  // overview, not a generated twin. Other paths look up a sibling .md.
  if (pathname === "/" || pathname === "") return "/llms.txt";
  const trimmed = pathname.replace(/\/+$/, "");
  return `/markdown${trimmed}.md`;
}

async function tryServeMarkdown(pathname: string): Promise<Response | null> {
  const twin = markdownTwinPath(pathname);
  const file = Bun.file(join(OUT_DIR, twin));
  if (!(await file.exists())) return null;

  let text: string;
  try {
    text = await file.text();
  } catch (err) {
    // exists() / text() are not atomic; the file can disappear or flip
    // permissions in between. Log + fall through to HTML rather than 500
    // the caller, since the markdown twin is an opportunistic agent
    // affordance, not a load-bearing surface.
    console.warn(
      "[serve] markdown twin read failed:",
      twin,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  // Most tokenizers land around 3.5–4 chars/token for English markdown;
  // exposed so agents can budget context windows without re-tokenizing.
  const tokenEstimate = Math.ceil(text.length / 4);

  return new Response(text, {
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "text/markdown; charset=utf-8",
      "X-Markdown-Tokens": String(tokenEstimate),
      "X-Markdown-Source": twin,
    },
  });
}

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/health") {
      return new Response("ok", {
        headers: { ...SECURITY_HEADERS, "Content-Type": "text/plain" },
      });
    }

    if (pathname === "/api/health") {
      return proxyApiHealth();
    }

    const wellKnown = WELL_KNOWN_ROUTES[pathname];
    if (wellKnown) {
      const file = Bun.file(join(OUT_DIR, wellKnown.file));
      if (await file.exists()) {
        return new Response(file, {
          headers: {
            ...SECURITY_HEADERS,
            "Content-Type": wellKnown.contentType,
            "Cache-Control": "public, max-age=300",
          },
        });
      }
      // Build/template drift: route is registered but the underlying
      // .well-known file is missing. Surface as a 404 with a log line so
      // it doesn't silently fall through into the HTML SPA shell.
      console.warn("[serve] well-known asset missing on disk:", wellKnown.file);
      return new Response("Not Found", { status: 404, headers: SECURITY_HEADERS });
    }

    if ((req.method === "GET" || req.method === "HEAD") && prefersMarkdown(req)) {
      const markdown = await tryServeMarkdown(pathname);
      if (markdown) return markdown;
      // RFC 7231: Accept is ignorable when no acceptable representation
      // exists. Fall through to HTML.
    }

    for (const suffix of ["", ".html", "/index.html"]) {
      const file = Bun.file(join(OUT_DIR, pathname + suffix));
      if (await file.exists()) {
        const headers: Record<string, string> = { ...SECURITY_HEADERS };
        if (pathname === "/" || pathname === "/index.html" || suffix === "/index.html") {
          headers["Link"] = HOMEPAGE_LINK_HEADER;
        }
        return new Response(file, { headers });
      }
    }

    const notFound = Bun.file(join(OUT_DIR, "404.html"));
    if (await notFound.exists()) {
      return new Response(notFound, { status: 404, headers: SECURITY_HEADERS });
    }
    return new Response("Not Found", { status: 404, headers: SECURITY_HEADERS });
  },
});

console.log(`Static server listening on :${port}`);
