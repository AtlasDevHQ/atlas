import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone is for self-hosted deployments (Docker, Railway, etc.); Vercel uses its own build pipeline
  ...(process.env.VERCEL ? {} : { output: "standalone" }),
  serverExternalPackages: ["pg", "mysql2", "@clickhouse/client", "@duckdb/node-api", "snowflake-sdk", "jsforce", "just-bash", "pino", "pino-pretty", "stripe", "effect", "@effect/sql", "@effect/sql-pg", "@effect/sql-mysql2", "postgres"],
  // Type checking is handled by `bun run type` — skip during next build to avoid
  // false positives from @ts-expect-error directives that differ between monorepo and standalone
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
