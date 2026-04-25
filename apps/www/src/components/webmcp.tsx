"use client";

import { useEffect } from "react";

// Provides tools to in-browser agents via Chrome's experimental webmcp
// proposal (navigator.modelContext). No-op elsewhere. The response
// envelope mirrors MCP server tools/call (`{ content: [{type, text}] }`)
// since the WebMCP draft hasn't finalized its own shape — track the
// proposal at https://webmachinelearning.github.io/webmcp/.
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

/**
 * Open a URL in a new tab and report back to the agent. Handles popup-
 * blocker rejection (`window.open` returns null) so the response text
 * matches what the user actually sees.
 */
function openAndReport(url: string, openedText: string): {
  content: Array<{ type: "text"; text: string }>;
} {
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
    name: "atlas_start_free_trial",
    description:
      "Open the Atlas hosted SaaS signup at app.useatlas.dev. Returns the URL so the agent can offer it to the user.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const url = "https://app.useatlas.dev/signup";
      return openAndReport(
        url,
        `Opened the Atlas signup page: ${url}. New workspaces include a 14-day Team-tier trial; no credit card required.`,
      );
    },
  },
  {
    name: "atlas_open_live_demo",
    description:
      "Open the Atlas live demo at app.useatlas.dev/demo against a sample database. No signup required.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const url = "https://app.useatlas.dev/demo";
      return openAndReport(
        url,
        `Opened the Atlas live demo: ${url}. Pre-loaded with an e-commerce sample schema.`,
      );
    },
  },
  {
    name: "atlas_search_docs",
    description:
      "Search the Atlas documentation at docs.useatlas.dev. Use to find setup guides, API reference, plugin docs, or integration walkthroughs.",
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
        return {
          content: [{ type: "text", text: "query must be a string." }],
        };
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
];

export default function WebMCP() {
  useEffect(() => {
    const mc = (navigator as WebMcpNavigator).modelContext;
    if (!mc?.provideContext) return;
    Promise.resolve(mc.provideContext({ tools: TOOLS })).catch((err: unknown) => {
      // console.warn so the failure is visible at the default devtools
      // level — silent breakage of the whole webmcp surface is exactly
      // what we don't want to ship.
      console.warn(
        "[webmcp] provideContext failed:",
        err instanceof Error ? err.message : String(err),
      );
    });
  }, []);
  return null;
}
