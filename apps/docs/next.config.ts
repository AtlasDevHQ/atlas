import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // Static export disables rewrites() and redirects() — Caddy owns the
  // markdown-twin rewrite and legacy /guides/mcp-hosted aliasing in front
  // of /srv (see deploy/docs/Caddyfile).
  output: "export",
  // Directory-style canonical URLs (/<slug>/) work with Caddy's file_server
  // index resolution and pair with the /llms.mdx/<slug>/index.md emission
  // shape from src/app/llms.mdx/[[...slug]]/route.ts.
  trailingSlash: true,
  images: {
    // ImageResponse from generateOGImage works under output: 'export' but
    // next/image's default optimizer doesn't. Force unoptimized so any
    // <Image> in MDX still renders.
    unoptimized: true,
  },
};

const withMDX = createMDX();

export default withMDX(config);
