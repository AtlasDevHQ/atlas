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
      // hosted/self-hosted tabs (#2113). The `:rest*` wildcard matches zero
      // or more segments, so this single rule handles both the bare path
      // and any deeper anchor links that survived the merge.
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
