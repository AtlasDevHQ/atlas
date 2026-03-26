import type { NextConfig } from "next";
import path from "path";

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
  // Allow embedding shared conversations in iframes. The /embed route removes
  // chrome for a minimal read-only view; frame-ancestors * permits any origin.
  async headers() {
    return [
      {
        source: "/shared/:token/embed",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors *",
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
