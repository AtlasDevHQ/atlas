import { join } from "path";

const OUT_DIR = join(import.meta.dir, "out");
const port = parseInt(process.env.PORT || "8080");

const SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
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

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "Content-Type": "text/plain" } });
    }

    if (url.pathname === "/api/health") {
      return proxyApiHealth();
    }

    for (const suffix of ["", ".html", "/index.html"]) {
      const file = Bun.file(join(OUT_DIR, url.pathname + suffix));
      if (await file.exists()) {
        return new Response(file, { headers: SECURITY_HEADERS });
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
