/**
 * MCP resources — exposes the semantic layer as read-only MCP resources.
 *
 * Static resources:
 * - atlas://semantic/catalog — Data catalog
 * - atlas://semantic/glossary — Business glossary
 *
 * Dynamic resource templates:
 * - atlas://semantic/entities/{name} — Entity schemas
 * - atlas://semantic/metrics/{name} — Metric definitions
 *
 * Path traversal protection: all resolved paths must stay within SEMANTIC_ROOT.
 */

import * as fs from "fs";
import * as path from "path";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

const SEMANTIC_ROOT = path.resolve(process.cwd(), "semantic");

/**
 * Resolve a path within the semantic directory, rejecting path traversal.
 * Returns null if the resolved path escapes SEMANTIC_ROOT.
 */
function safePath(relativePath: string): string | null {
  const resolved = path.resolve(SEMANTIC_ROOT, relativePath);
  if (!resolved.startsWith(SEMANTIC_ROOT + path.sep) && resolved !== SEMANTIC_ROOT) {
    return null;
  }
  return resolved;
}

/** List .yml files in a subdirectory, returning basenames without extension. */
function listYamlFiles(subdir: string): string[] {
  const dir = safePath(subdir);
  if (!dir || !fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".yml"))
      .map((f) => f.replace(/\.yml$/, ""))
      .sort();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    process.stderr.write(`[atlas-mcp] Failed to list YAML files in "${subdir}": ${err}\n`);
    throw err;
  }
}

/** Read a YAML file from the semantic directory. Returns null on failure. */
function readSemanticFile(relativePath: string): string | null {
  const filePath = safePath(relativePath);
  if (!filePath) return null;
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    process.stderr.write(`[atlas-mcp] Failed to read "${relativePath}": ${err}\n`);
    throw err;
  }
}

export function registerResources(server: McpServer): void {
  // --- Static: catalog.yml ---
  server.registerResource(
    "catalog",
    "atlas://semantic/catalog",
    {
      title: "Data Catalog",
      description:
        "Index of all entities and their descriptions, with use_for guidance and common questions",
      mimeType: "text/yaml",
    },
    async (uri): Promise<ReadResourceResult> => {
      const text = readSemanticFile("catalog.yml");
      if (!text) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/plain",
              text: "catalog.yml not found",
            },
          ],
        };
      }
      return {
        contents: [{ uri: uri.href, mimeType: "text/yaml", text }],
      };
    },
  );

  // --- Static: glossary.yml ---
  server.registerResource(
    "glossary",
    "atlas://semantic/glossary",
    {
      title: "Business Glossary",
      description:
        "Business term definitions, disambiguation guidance, and relationship descriptions",
      mimeType: "text/yaml",
    },
    async (uri): Promise<ReadResourceResult> => {
      const text = readSemanticFile("glossary.yml");
      if (!text) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/plain",
              text: "glossary.yml not found",
            },
          ],
        };
      }
      return {
        contents: [{ uri: uri.href, mimeType: "text/yaml", text }],
      };
    },
  );

  // --- Dynamic: entities ---
  server.registerResource(
    "entity",
    new ResourceTemplate("atlas://semantic/entities/{name}", {
      list: async () => ({
        resources: listYamlFiles("entities").map((name) => ({
          uri: `atlas://semantic/entities/${name}`,
          name: `${name} entity`,
        })),
      }),
    }),
    {
      title: "Entity Schema",
      description:
        "Table/view schema with columns, types, sample values, joins, measures, and query patterns",
      mimeType: "text/yaml",
    },
    async (uri, { name }): Promise<ReadResourceResult> => {
      // Guard against path traversal in the name parameter
      if (typeof name !== "string" || name.includes("/") || name.includes("\\") || name.includes("..")) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/plain",
              text: "Invalid entity name",
            },
          ],
        };
      }

      const text = readSemanticFile(`entities/${name}.yml`);
      if (!text) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/plain",
              text: `Entity "${name}" not found`,
            },
          ],
        };
      }
      return {
        contents: [{ uri: uri.href, mimeType: "text/yaml", text }],
      };
    },
  );

  // --- Dynamic: metrics ---
  server.registerResource(
    "metric",
    new ResourceTemplate("atlas://semantic/metrics/{name}", {
      list: async () => ({
        resources: listYamlFiles("metrics").map((name) => ({
          uri: `atlas://semantic/metrics/${name}`,
          name: `${name} metrics`,
        })),
      }),
    }),
    {
      title: "Metric Definitions",
      description:
        "Authoritative SQL for atomic and breakdown metrics with aggregation, units, and objectives",
      mimeType: "text/yaml",
    },
    async (uri, { name }): Promise<ReadResourceResult> => {
      if (typeof name !== "string" || name.includes("/") || name.includes("\\") || name.includes("..")) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/plain",
              text: "Invalid metric name",
            },
          ],
        };
      }

      const text = readSemanticFile(`metrics/${name}.yml`);
      if (!text) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/plain",
              text: `Metric "${name}" not found`,
            },
          ],
        };
      }
      return {
        contents: [{ uri: uri.href, mimeType: "text/yaml", text }],
      };
    },
  );
}
