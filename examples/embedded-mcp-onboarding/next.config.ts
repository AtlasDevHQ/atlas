import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.resolve(import.meta.dirname, "../.."),
  transpilePackages: ["@useatlas/react", "@useatlas/sdk"],
  typescript: { ignoreBuildErrors: true },
  turbopack: {},
};

export default nextConfig;
