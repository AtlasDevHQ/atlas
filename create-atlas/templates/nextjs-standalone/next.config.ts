import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vercel uses its own build pipeline — no `output: "standalone"` needed
  serverExternalPackages: ["pg", "mysql2", "@clickhouse/client", "@duckdb/node-api", "snowflake-sdk", "jsforce", "just-bash", "pino", "pino-pretty", "stripe"],
  // Type checking is handled by `bun run type` (tsgo); skip during Next.js build
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
