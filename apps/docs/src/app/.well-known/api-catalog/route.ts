// RFC 9727 — API catalog. application/linkset+json (RFC 9264).
export const dynamic = "force-static";

const BODY = {
  linkset: [
    {
      anchor: "https://api.useatlas.dev/",
      "service-desc": [
        {
          href: "https://docs.useatlas.dev/api-reference/openapi.json",
          type: "application/openapi+json",
        },
      ],
      "service-doc": [
        { href: "https://docs.useatlas.dev/api-reference", type: "text/html" },
        {
          href: "https://docs.useatlas.dev/api-reference.mdx",
          type: "text/markdown",
        },
      ],
      status: [
        { href: "https://api.useatlas.dev/api/health", type: "application/json" },
      ],
      "service-meta": [
        {
          href: "https://docs.useatlas.dev/.well-known/oauth-protected-resource",
          type: "application/json",
        },
      ],
    },
    {
      anchor: "https://docs.useatlas.dev/",
      "service-doc": [
        { href: "https://docs.useatlas.dev/llms.txt", type: "text/plain" },
        { href: "https://docs.useatlas.dev/llms-full.txt", type: "text/plain" },
      ],
    },
  ],
};

export function GET(): Response {
  return new Response(JSON.stringify(BODY, null, 2), {
    headers: {
      "Content-Type": "application/linkset+json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
