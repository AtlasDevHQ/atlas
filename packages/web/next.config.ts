import type { NextConfig } from "next";
import fs from "fs";
import path from "path";

// Next.js only loads .env files from its own package root (packages/web/),
// but in the monorepo the .env file lives at the repo root. This makes
// NEXT_PUBLIC_* vars (e.g. NEXT_PUBLIC_ATLAS_AUTH_MODE used by the proxy)
// available in server-side code like proxy.ts. See #957.
const monorepoEnv = path.resolve(import.meta.dirname, "../../.env");
if (fs.existsSync(monorepoEnv)) {
  for (const line of fs.readFileSync(monorepoEnv, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq);
    // Don't override already-set vars (Docker ENV, CI, etc.)
    if (!(key in process.env)) {
      process.env[key] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, "");
    }
  }
}

const nextConfig: NextConfig = {
  reactCompiler: true,
  experimental: {
    authInterrupts: true,
  },
  // standalone is for self-hosted deployments (Docker, Railway, etc.); Vercel uses its own build pipeline
  ...(process.env.VERCEL ? {} : { output: "standalone" }),
  // Native bindings and worker-thread packages that must not be bundled by Next.js.
  // Matches the list in examples/nextjs-standalone/ and create-atlas/ template.
  serverExternalPackages: [
    "pg",
    "mysql2",
    "@clickhouse/client",
    "@duckdb/node-api",
    "snowflake-sdk",
    "jsforce",
    "just-bash",
    "pino",
    "pino-pretty",
    "stripe",
  ],
  // Monorepo: trace files up to the repo root so standalone output includes all packages
  outputFileTracingRoot: path.resolve(import.meta.dirname, "../.."),
  // Type checking is handled by `bun run type` (tsgo); skip during Next.js build
  // to avoid cross-package tsconfig path resolution issues.
  typescript: { ignoreBuildErrors: true },
  transpilePackages: ["@useatlas/react"],
  turbopack: {},
  // Security headers (issue #1984) — applied to all responses.
  //
  // - HSTS pins HTTPS for a year. `preload` advertises eligibility; submission
  //   is a separate operator decision.
  // - CSP is intentionally generous on connect-src/img-src because self-hosted
  //   deployments may point at any datasource host or load avatars from
  //   arbitrary origins. The strict bits — frame-ancestors, object-src,
  //   base-uri, form-action — are the ones that block real attack vectors.
  // - `script-src` keeps `'unsafe-inline'` because Next.js inlines hydration
  //   data; `'unsafe-eval'` is included for libraries like Recharts that JIT
  //   chart paths. Operators on a strict-CSP build can fork this list.
  //
  // The `/shared/:token/embed` route inherits everything except frame-ancestors,
  // which it overrides to `*` so customers can embed shared conversations.
  // Browsers ignore X-Frame-Options when CSP `frame-ancestors` is present, so
  // setting both globally is safe — the embed override wins where it matches.
  async headers() {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https: wss:",
      "frame-src 'self'",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
      "worker-src 'self' blob:",
    ].join("; ");

    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains; preload",
          },
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        // Embed view must remain framable from any origin. CSP frame-ancestors
        // takes precedence over X-Frame-Options per the W3C CSP spec, so the
        // global X-Frame-Options DENY is harmlessly ignored on this path.
        source: "/shared/:token/embed",
        headers: [
          {
            key: "Content-Security-Policy",
            value: csp.replace("frame-ancestors 'self'", "frame-ancestors *"),
          },
        ],
      },
    ];
  },
  // When NEXT_PUBLIC_ATLAS_API_URL is set, the frontend talks directly to the API
  // (cross-origin), so no server-side rewrite is needed. When unset, Next.js proxies
  // /api/* to the Hono API server (ATLAS_API_URL, default localhost:3001).
  async rewrites() {
    const apiUrl = process.env.NEXT_PUBLIC_ATLAS_API_URL;
    if (apiUrl) return [];
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.ATLAS_API_URL || "http://localhost:3001"}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
