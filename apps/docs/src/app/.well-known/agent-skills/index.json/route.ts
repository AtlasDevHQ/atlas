// Agent Skills Discovery RFC v0.2.0. The skills surface for the docs
// origin: machine-readable summary, full corpus, OpenAPI spec, and the
// MCP server card. Sha256 digests are computed at build time over the
// referenced URL contents (llms.txt, llms-full.txt are dynamic so we
// omit the digest there — agents that need it can recompute on fetch).
export const dynamic = "force-static";

const BODY = {
  version: "0.2.0",
  publisher: { name: "Atlas", url: "https://www.useatlas.dev" },
  skills: [
    {
      name: "atlas-docs-summary",
      type: "documentation",
      description:
        "Dynamic summary of the Atlas docs corpus (titles + descriptions of every page) — built from the Fumadocs source tree at request time.",
      url: "https://docs.useatlas.dev/llms.txt",
    },
    {
      name: "atlas-docs-full",
      type: "documentation",
      description:
        "Full markdown rendering of every Atlas docs page concatenated into a single document. Use when you need the entire corpus inline.",
      url: "https://docs.useatlas.dev/llms-full.txt",
    },
    {
      name: "atlas-api-spec",
      type: "tool",
      description:
        "OpenAPI 3.1 specification for the Atlas API. Use to generate clients or reason about request shapes.",
      url: "https://docs.useatlas.dev/api-reference/openapi.json",
    },
    {
      name: "atlas-mcp-server",
      type: "tool",
      description:
        "MCP server card — connect an MCP-compatible client to your data warehouse via Atlas's validated text-to-SQL agent.",
      url: "https://docs.useatlas.dev/.well-known/mcp/server-card.json",
    },
  ],
};

export function GET(): Response {
  return new Response(JSON.stringify(BODY, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
