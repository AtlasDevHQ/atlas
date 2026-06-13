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
import {
  type ReadResourceResult,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getSemanticRoot } from "@atlas/api/lib/semantic/files";
import { createMcpLogger } from "./logger.js";

const log = createMcpLogger("mcp:resources");

/**
 * Resolve the semantic root lazily, per read (#3502). The previous
 * module-load `const SEMANTIC_ROOT = getSemanticRoot()` captured the value
 * before `initializeConfig()` could set `ATLAS_SEMANTIC_ROOT`, so a non-
 * default root (or a root configured after import) was silently ignored.
 * Resolving on each call closes that ordering hole and lets the resource
 * watcher track the live root.
 */
function semanticRoot(): string {
  return getSemanticRoot();
}

/**
 * Resolve a path within the semantic directory, rejecting path traversal.
 * Returns null if the resolved path escapes the semantic root.
 */
function safePath(relativePath: string): string | null {
  const root = semanticRoot();
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
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
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") return [];
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)), subdir },
      "Failed to list YAML files in semantic subdirectory",
    );
    throw err;
  }
}

/**
 * Completion candidates for a resource-template `{name}` variable (#3503):
 * YAML basenames in `subdir` whose name starts with the typed `value`
 * (case-insensitive), capped at 100. The SDK also caps at 100 and sets
 * `hasMore`; capping here keeps the contract explicit and bounds the work.
 * Sourced from the same `listYamlFiles` the template's `list` callback uses,
 * so completions never offer a name that isn't a listable resource.
 */
export function completeSemanticName(subdir: string, value: string): string[] {
  const prefix = value.toLowerCase();
  return listYamlFiles(subdir)
    .filter((name) => name.toLowerCase().startsWith(prefix))
    .slice(0, 100);
}

/** Read a YAML file from the semantic directory. Returns null on failure. */
function readSemanticFile(relativePath: string): string | null {
  const filePath = safePath(relativePath);
  if (!filePath) return null;
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") return null;
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)), relativePath },
      "Failed to read semantic file",
    );
    throw err;
  }
}

/**
 * Map a semantic file path (relative to the semantic root, POSIX-style) to
 * the `atlas://semantic/...` resource URI it backs, or `null` if the file
 * isn't an exposed resource. Used by the change watcher to fan a file change
 * out to the subscribed resource URI. Exported for testing.
 */
export function semanticFileToResourceUri(relPath: string): string | null {
  const normalized = relPath.split(path.sep).join("/");
  if (normalized === "catalog.yml") return "atlas://semantic/catalog";
  if (normalized === "glossary.yml") return "atlas://semantic/glossary";
  const entity = /^entities\/([^/]+)\.yml$/.exec(normalized);
  if (entity) return `atlas://semantic/entities/${entity[1]}`;
  const metric = /^metrics\/([^/]+)\.yml$/.exec(normalized);
  if (metric) return `atlas://semantic/metrics/${metric[1]}`;
  return null;
}

/**
 * Handle returned by {@link registerResources} for the resource-subscription
 * seam (#3502). `notifyResourceUpdated` is the single place a
 * `notifications/resources/updated` is emitted — the change hook a
 * semantic-layer regeneration (the datasource/profiling tool) calls, and the
 * file watcher's sink. Keeping it behind this seam means the 2026-07-28
 * `subscriptions/listen` delivery change is a contained edit. `close` stops
 * the watcher (call on server shutdown).
 */
export interface ResourceSubscriptionHandle {
  notifyResourceUpdated(uri: string): Promise<void>;
  /** Test-only/operational: current subscription set size. */
  readonly subscriptionCount: () => number;
  close(): void;
}

export function registerResources(server: McpServer): ResourceSubscriptionHandle {
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
      // #3503 — IDE-quality autocompletion of the `{name}` variable.
      complete: {
        name: (value) => completeSemanticName("entities", value),
      },
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
      // #3503 — autocompletion of metric ids for the `{name}` variable.
      complete: {
        name: (value) => completeSemanticName("metrics", value),
      },
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

  // --- Resource subscriptions (#3502) ---------------------------------------
  // Declare the capability alongside the listChanged the SDK already set when
  // resources were registered, then handle subscribe/unsubscribe. A semantic
  // resource changes when the layer is regenerated (the datasource/profiling
  // tool calls `notifyResourceUpdated`) or when a file on disk changes (the
  // lazy fs watcher below) — both funnel through the one seam.
  server.server.registerCapabilities({ resources: { subscribe: true } });

  const subscriptions = new Set<string>();
  let watcher: fs.FSWatcher | undefined;

  const notifyResourceUpdated = async (uri: string): Promise<void> => {
    if (!subscriptions.has(uri)) return;
    // Best-effort: a failed notify must not crash the watcher / caller.
    await server.server.sendResourceUpdated({ uri }).catch((err: unknown) => {
      log.warn(
        { err: err instanceof Error ? err : new Error(String(err)), uri },
        "failed to send resources/updated notification",
      );
    });
  };

  const stopWatching = (): void => {
    if (watcher) {
      watcher.close();
      watcher = undefined;
    }
  };

  // Start watching lazily on the first subscription, and only watch while at
  // least one subscription is live — so an idle server holds no FS watcher.
  const ensureWatching = (): void => {
    if (watcher) return;
    const root = semanticRoot();
    if (!fs.existsSync(root)) return;
    try {
      watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const uri = semanticFileToResourceUri(filename.toString());
        if (uri) void notifyResourceUpdated(uri);
      });
      // A watcher must never take down the process — log and degrade to the
      // explicit-notify path (regeneration still emits updates).
      watcher.on("error", (err) => {
        log.warn(
          { err: err instanceof Error ? err : new Error(String(err)) },
          "semantic resource watcher errored — file-change notifications disabled",
        );
        stopWatching();
      });
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err : new Error(String(err)) },
        "could not start semantic resource watcher — file-change notifications disabled",
      );
    }
  };

  server.server.setRequestHandler(SubscribeRequestSchema, async ({ params }) => {
    subscriptions.add(params.uri);
    ensureWatching();
    return {};
  });

  server.server.setRequestHandler(UnsubscribeRequestSchema, async ({ params }) => {
    subscriptions.delete(params.uri);
    if (subscriptions.size === 0) stopWatching();
    return {};
  });

  return {
    notifyResourceUpdated,
    subscriptionCount: () => subscriptions.size,
    close: () => {
      stopWatching();
      subscriptions.clear();
    },
  };
}
