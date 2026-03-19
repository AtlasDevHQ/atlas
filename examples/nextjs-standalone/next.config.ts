import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Vercel uses its own build pipeline — no `output: "standalone"` needed.
  // For Docker deployments, see examples/docker/.
  // Monorepo: trace files up to the repo root so the build includes all packages
  outputFileTracingRoot: path.resolve(import.meta.dirname, "../.."),
  transpilePackages: ["@atlas/api", "@atlas/web"],
  // Native bindings and worker threads incompatible with Next.js bundling
  serverExternalPackages: ["pg", "mysql2", "@clickhouse/client", "@duckdb/node-api", "snowflake-sdk", "jsforce", "just-bash", "pino", "pino-pretty", "stripe"],
  // Type checking is handled by `bun run type` (tsgo); skip during Next.js build
  typescript: { ignoreBuildErrors: true },
  turbopack: {},
  // Semantic layer YAMLs are read at runtime via fs — not imported — so Next.js
  // file tracing can't discover them. Include them explicitly in the API function bundle.
  outputFileTracingIncludes: {
    "/api/*": ["./semantic/**/*"],
  },
};

export default nextConfig;
