import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  async rewrites() {
    return [
      {
        source: "/:path*.mdx",
        destination: "/llms.mdx/:path*",
      },
    ];
  },
  async redirects() {
    return [
      // /guides/mcp-hosted was consolidated into /guides/mcp under the
      // hosted/self-hosted tabs (#2113). Anchors that survived the merge
      // continue to deep-link the right section.
      { source: "/guides/mcp-hosted", destination: "/guides/mcp", permanent: true },
      {
        source: "/guides/mcp-hosted/:rest*",
        destination: "/guides/mcp/:rest*",
        permanent: true,
      },
    ];
  },
};

const withMDX = createMDX();

export default withMDX(config);
