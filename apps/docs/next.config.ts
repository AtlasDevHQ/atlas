import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // Static export — served by Caddy in front (apps/docs/Caddyfile). The
  // markdown-twin rewrite (/:path*.mdx -> /llms.mdx/:path*) and the
  // /guides/mcp-hosted/* legacy redirect that used to live here now live
  // in the Caddyfile, because Next.js rewrites/redirects don't run under
  // output: 'export'.
  output: "export",
  // The /llms.mdx/[[...slug]] route handler emits file paths without an
  // extension (e.g. out/llms.mdx/guides/slack). Adding a trailing slash
  // makes the Caddy /*.mdx -> /llms.mdx/* rewrite resolve cleanly.
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
