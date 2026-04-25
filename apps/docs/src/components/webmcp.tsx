"use client";

import { useEffect } from "react";

// Provides tools to in-browser agents via Chrome's experimental webmcp
// proposal (navigator.modelContext). No-op elsewhere. Response envelope
// mirrors MCP server tools/call since the WebMCP draft hasn't finalized
// its own shape — track at https://webmachinelearning.github.io/webmcp/.
type ModelContextTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
  }>;
};

type ModelContext = {
  provideContext: (ctx: { tools: ModelContextTool[] }) => Promise<void> | void;
};

type WebMcpNavigator = Navigator & { modelContext?: ModelContext };

function openAndReport(
  url: string,
  openedText: string,
): { content: Array<{ type: "text"; text: string }> } {
  if (typeof window === "undefined") {
    return { content: [{ type: "text", text: `${url} (server context — cannot open)` }] };
  }
  const win = window.open(url, "_blank", "noopener");
  const text =
    win === null
      ? `Couldn't open a new tab — popup blocker likely. Visit ${url} directly.`
      : openedText;
  return { content: [{ type: "text", text }] };
}

const TOOLS: ModelContextTool[] = [
  {
    name: "atlas_search_docs",
    description:
      "Search the Atlas documentation. Use to find setup guides, API reference, plugin docs, or integration walkthroughs.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to search for (e.g. 'BigQuery setup', 'MCP server', 'rate limits').",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(input) {
      if (typeof input.query !== "string") {
        return { content: [{ type: "text", text: "query must be a string." }] };
      }
      const query = input.query.trim();
      if (!query) {
        return {
          content: [{ type: "text", text: "No query provided. Try 'BigQuery setup' or 'MCP server'." }],
        };
      }
      const url = `https://docs.useatlas.dev/?q=${encodeURIComponent(query)}`;
      return openAndReport(url, `Opened Atlas docs search for "${query}": ${url}`);
    },
  },
  {
    name: "atlas_get_doc_markdown",
    description:
      "Fetch the markdown source of an Atlas docs page by slug (e.g. 'getting-started', 'integrations/mcp'). Returns the full markdown inline so the agent can read it without a separate browser fetch. Use this when you need to ground an answer in the docs.",
    inputSchema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description: "Docs page slug, with or without leading slash (e.g. 'getting-started').",
        },
      },
      required: ["slug"],
      additionalProperties: false,
    },
    async execute(input) {
      if (typeof input.slug !== "string") {
        return { content: [{ type: "text", text: "slug must be a string." }] };
      }
      const slug = input.slug.trim().replace(/^\/+/, "").replace(/\.mdx?$/, "");
      if (!slug) {
        return { content: [{ type: "text", text: "No slug provided." }] };
      }
      const url = `https://docs.useatlas.dev/${slug}.mdx`;
      try {
        const res = await fetch(url, { headers: { Accept: "text/markdown,text/plain" } });
        if (!res.ok) {
          return {
            content: [{ type: "text", text: `Page not found: ${url} (HTTP ${res.status}).` }],
          };
        }
        const md = await res.text();
        return { content: [{ type: "text", text: md }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  },
  {
    name: "atlas_view_repo",
    description:
      "Open the Atlas source repository on GitHub (AtlasDevHQ/atlas). Useful when the agent needs to reference issues, PRs, or source code.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const url = "https://github.com/AtlasDevHQ/atlas";
      return openAndReport(url, `Opened Atlas repository: ${url}`);
    },
  },
];

export default function WebMCP() {
  useEffect(() => {
    const mc = (navigator as WebMcpNavigator).modelContext;
    if (!mc?.provideContext) return;
    Promise.resolve(mc.provideContext({ tools: TOOLS })).catch((err: unknown) => {
      console.warn(
        "[webmcp] provideContext failed:",
        err instanceof Error ? err.message : String(err),
      );
    });
  }, []);
  return null;
}
