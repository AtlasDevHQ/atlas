/**
 * ClickHouse connection factory for the datasource plugin.
 *
 * Extracted from packages/api/src/lib/db/connection.ts — adapts the
 * createClickHouseDB() logic (minus the port-8443 TLS mismatch warning)
 * using the Plugin SDK's PluginDBConnection interface instead of the
 * internal DBConnection.
 */

import type { PluginDBConnection, PluginQueryResult } from "@useatlas/plugin-sdk";

/**
 * Rewrite a `clickhouse://` or `clickhouses://` URL to `http://` or `https://`
 * for the @clickhouse/client HTTP transport.
 *
 * - `clickhouses://` → `https://` (TLS)
 * - `clickhouse://`  → `http://`  (plain)
 */
export function rewriteClickHouseUrl(url: string): string {
  if (url.startsWith("clickhouses://")) {
    return url.replace(/^clickhouses:\/\//, "https://");
  }
  return url.replace(/^clickhouse:\/\//, "http://");
}

/**
 * Extract hostname from a ClickHouse URL for safe logging (no credentials).
 * Returns "(unknown)" on parse failure.
 */
export function extractHost(url: string): string {
  try {
    const parsed = new URL(rewriteClickHouseUrl(url));
    return parsed.hostname || "(unknown)";
  } catch {
    return "(unknown)";
  }
}

export interface ClickHouseConnectionConfig {
  url: string;
  database?: string;
  logger?: { warn(msg: string): void };
}

/**
 * Create a PluginDBConnection backed by @clickhouse/client HTTP transport.
 * Enforces readonly mode and statement timeout per query.
 *
 * @throws {Error} If @clickhouse/client is not installed (optional peer dependency).
 */
export function createClickHouseConnection(
  config: ClickHouseConnectionConfig,
): PluginDBConnection {
  let createClient: (opts: Record<string, unknown>) => unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ({ createClient } = require("@clickhouse/client"));
  } catch (err) {
    const isNotFound =
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND";
    if (isNotFound) {
      throw new Error(
        "ClickHouse support requires the @clickhouse/client package. Install it with: bun add @clickhouse/client",
      );
    }
    throw new Error(
      `Failed to load @clickhouse/client: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const httpUrl = rewriteClickHouseUrl(config.url);
  const clientOpts: Record<string, unknown> = { url: httpUrl };
  if (config.database) clientOpts.database = config.database;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = (createClient as any)(clientOpts);

  return {
    async query(sql: string, timeoutMs = 30000): Promise<PluginQueryResult> {
      let json;
      try {
        const result = await client.query({
          query: sql,
          format: "JSON",
          clickhouse_settings: {
            max_execution_time: Math.ceil(timeoutMs / 1000),
            readonly: 1,
          },
        });
        json = await result.json();
      } catch (err) {
        throw new Error(
          `ClickHouse query failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      if (!json.meta || !Array.isArray(json.meta)) {
        throw new Error(
          "ClickHouse query returned an unexpected response: missing or invalid 'meta' field. " +
            "Ensure the query uses JSON format and returns a valid result set.",
        );
      }
      if (!Array.isArray(json.data)) {
        throw new Error(
          "ClickHouse query returned an unexpected response: missing or invalid 'data' field. " +
            "Ensure the query returns a valid result set.",
        );
      }
      const columns = (json.meta as { name: string }[]).map(
        (m: { name: string }) => m.name,
      );
      return { columns, rows: json.data as Record<string, unknown>[] };
    },
    async close(): Promise<void> {
      try {
        await client.close();
      } catch (err) {
        (config.logger ?? console).warn(`[clickhouse-datasource] Failed to close ClickHouse client: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
