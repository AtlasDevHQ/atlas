import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone is for self-hosted deployments (Docker, Railway, etc.); Vercel uses its own build pipeline
  ...(process.env.VERCEL ? {} : { output: "standalone" }),
  serverExternalPackages: ["pg", "just-bash"],
};

export default nextConfig;
