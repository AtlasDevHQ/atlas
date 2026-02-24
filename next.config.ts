import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "pg", "just-bash"],
};

export default nextConfig;
