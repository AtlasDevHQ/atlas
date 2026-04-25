// MCP Server Card (SEP-1649). Mirrors www's card so an agent that
// discovers via either origin reaches the same metadata.
export const dynamic = "force-static";

const BODY = {
  serverInfo: {
    name: "atlas",
    title: "Atlas — Text-to-SQL Data Analyst",
    version: "0.1.0",
    description:
      "Atlas MCP server. Connects an MCP-compatible client (Claude Desktop, Cursor, Windsurf, Zed) to your data warehouse via Atlas's text-to-SQL agent. Read-only by default; every query is AST-validated against a YAML semantic layer and table whitelist.",
    websiteUrl: "https://www.useatlas.dev",
    documentationUrl: "https://docs.useatlas.dev/integrations/mcp",
    license: "AGPL-3.0-or-later",
    vendor: { name: "Atlas", url: "https://www.useatlas.dev" },
  },
  transports: [
    {
      type: "http",
      endpoint: "https://api.useatlas.dev/api/v1/mcp/sse",
      authentication: {
        scheme: "bearer",
        tokenSource: "https://app.useatlas.dev/admin/api-keys",
      },
    },
  ],
  capabilities: {
    tools: { listChanged: true },
    resources: { subscribe: false, listChanged: true },
    prompts: { listChanged: true },
    logging: {},
  },
  tools: [
    {
      name: "executeSQL",
      description:
        "Run a read-only SELECT against a connected datasource. Validates against the semantic-layer whitelist.",
    },
    {
      name: "explore",
      description:
        "Read-only filesystem access (ls / cat / grep / find) over the semantic layer YAML.",
    },
    {
      name: "executePython",
      description:
        "Run sandboxed Python (nsjail / Vercel sandbox / sidecar) for chart rendering and analysis.",
    },
  ],
  links: {
    agentSkills:
      "https://docs.useatlas.dev/.well-known/agent-skills/index.json",
    apiCatalog: "https://docs.useatlas.dev/.well-known/api-catalog",
    openapi: "https://docs.useatlas.dev/api-reference/openapi.json",
  },
};

export function GET(): Response {
  return new Response(JSON.stringify(BODY, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
