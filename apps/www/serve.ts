import { join } from "path";

const OUT_DIR = join(import.meta.dir, "out");
const port = parseInt(process.env.PORT || "8080");

const SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "Content-Type": "text/plain" } });
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
