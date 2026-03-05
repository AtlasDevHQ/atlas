import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone is for self-hosted deployments (Docker, Railway, etc.); Vercel uses its own build pipeline
  ...(process.env.VERCEL ? {} : { output: "standalone" }),
  serverExternalPackages: ["pg", "mysql2", "@clickhouse/client", "@duckdb/node-api", "snowflake-sdk", "jsforce", "just-bash", "pino", "pino-pretty"],
};

export default nextConfig;
