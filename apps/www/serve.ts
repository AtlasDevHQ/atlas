import { join } from "path";

const OUT_DIR = join(import.meta.dir, "out");
const port = parseInt(process.env.PORT || "8080");

const SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

// Agent-discovery Link header on the homepage (RFC 8288 + RFC 9727).
// Points crawlers at the API catalog, OpenAPI spec, hosted docs, status,
// markdown twin, MCP server card, OAuth metadata, and the agent-skills
// index. Kept on a single line so curl -I shows it cleanly.
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

// /.well-known canonical URLs are extension-less per their RFCs. The
// underlying static files live with .json extensions so editors and CI
// linters recognize them. Each entry maps the canonical URL → file +
// content-type override.
const WELL_KNOWN_ROUTES: Record<string, { file: string; contentType: string }> = {
  "/.well-known/api-catalog": {
    file: "/.well-known/api-catalog.json",
    contentType: "application/linkset+json; charset=utf-8",
  },
  "/.well-known/oauth-authorization-server": {
    file: "/.well-known/oauth-authorization-server.json",
    contentType: "application/json; charset=utf-8",
  },
  "/.well-known/oauth-protected-resource": {
    file: "/.well-known/oauth-protected-resource.json",
    contentType: "application/json; charset=utf-8",
  },
  "/.well-known/openid-configuration": {
    file: "/.well-known/openid-configuration.json",
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

/** True when the Accept header lists text/markdown anywhere in its q-list. */
function prefersMarkdown(req: Request): boolean {
  const accept = req.headers.get("accept");
  if (!accept) return false;
  return accept
    .split(",")
    .some((part) => part.trim().toLowerCase().startsWith("text/markdown"));
}

/**
 * Markdown twin for a static page. Per-page markdown lives in
 * `public/markdown/<path>.md` (so /pricing → /markdown/pricing.md). The
 * homepage falls back to llms.txt — that file is hand-curated and kept in
 * sync as our canonical "what Atlas is" overview.
 */
function markdownTwinPath(pathname: string): string {
  if (pathname === "/" || pathname === "") return "/llms.txt";
  const trimmed = pathname.replace(/\/+$/, "");
  return `/markdown${trimmed}.md`;
}

async function tryServeMarkdown(pathname: string): Promise<Response | null> {
  const twin = markdownTwinPath(pathname);
  const file = Bun.file(join(OUT_DIR, twin));
  if (!(await file.exists())) return null;

  const text = await file.text();
  // Rough token estimate — most tokenizers land around 3.5–4 chars per
  // token for English markdown. We expose this so agents can budget
  // context windows without re-tokenizing.
  const tokenEstimate = Math.ceil(text.length / 4);

  return new Response(text, {
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "text/markdown; charset=utf-8",
      "X-Markdown-Tokens": String(tokenEstimate),
      "X-Markdown-Source": twin,
      Vary: "Accept",
    },
  });
}

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/health") {
      return new Response("ok", { headers: { "Content-Type": "text/plain" } });
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
    }

    if ((req.method === "GET" || req.method === "HEAD") && prefersMarkdown(req)) {
      const markdown = await tryServeMarkdown(pathname);
      if (markdown) return markdown;
      // No markdown twin — fall through to HTML. RFC 7231 lets us
      // ignore an Accept hint when no acceptable representation exists.
    }

    for (const suffix of ["", ".html", "/index.html"]) {
      const file = Bun.file(join(OUT_DIR, pathname + suffix));
      if (await file.exists()) {
        const headers: Record<string, string> = { ...SECURITY_HEADERS };
        if (pathname === "/" || pathname === "/index.html" || suffix === "/index.html") {
          headers["Link"] = HOMEPAGE_LINK_HEADER;
          headers["Vary"] = "Accept";
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
