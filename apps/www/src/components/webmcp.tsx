"use client";

import { useEffect } from "react";

/**
 * WebMCP tool-provider for the marketing site.
 *
 * Exposes a small surface to in-browser AI agents (Chrome's `webmcp`
 * proposal): start the SaaS signup flow, jump to the live demo, and
 * search the docs. No-op on browsers without `navigator.modelContext`.
 */
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

declare global {
  interface Navigator {
    modelContext?: ModelContext;
  }
}

const TOOLS: ModelContextTool[] = [
  {
    name: "atlas_start_free_trial",
    description:
      "Open the Atlas hosted SaaS signup at app.useatlas.dev. Returns the URL so the agent can offer it to the user.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const url = "https://app.useatlas.dev/signup";
      if (typeof window !== "undefined") window.open(url, "_blank", "noopener");
      return {
        content: [
          {
            type: "text",
            text: `Opened the Atlas signup page: ${url}. New workspaces include a 14-day Team-tier trial; no credit card required.`,
          },
        ],
      };
    },
  },
  {
    name: "atlas_open_live_demo",
    description:
      "Open the Atlas live demo at app.useatlas.dev/demo against a sample database. No signup required.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const url = "https://app.useatlas.dev/demo";
      if (typeof window !== "undefined") window.open(url, "_blank", "noopener");
      return {
        content: [
          {
            type: "text",
            text: `Opened the Atlas live demo: ${url}. Pre-loaded with an e-commerce sample schema.`,
          },
        ],
      };
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
      const query = String(input.query ?? "").trim();
      if (!query) {
        return {
          content: [{ type: "text", text: "No query provided. Try 'BigQuery setup' or 'MCP server'." }],
        };
      }
      const url = `https://docs.useatlas.dev/?q=${encodeURIComponent(query)}`;
      if (typeof window !== "undefined") window.open(url, "_blank", "noopener");
      return {
        content: [
          { type: "text", text: `Opened Atlas docs search for "${query}": ${url}` },
        ],
      };
    },
  },
];

export default function WebMCP() {
  useEffect(() => {
    const mc = navigator.modelContext;
    if (!mc?.provideContext) return;
    Promise.resolve(mc.provideContext({ tools: TOOLS })).catch((err: unknown) => {
      console.debug(
        "[webmcp] provideContext failed:",
        err instanceof Error ? err.message : String(err),
      );
    });
  }, []);
  return null;
}
