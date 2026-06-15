/**
 * BigQuery connection factory for the datasource plugin.
 *
 * Wraps the @google-cloud/bigquery client using the Plugin SDK's
 * PluginDBConnection interface. BigQuery is a REST-based service —
 * each query creates a job, so there is no connection pool to manage.
 *
 * All provided auth options are passed through to the BigQuery client,
 * which resolves them internally in this order:
 * 1. Explicit `credentials` object (service account JSON key contents)
 * 2. `keyFilename` path to service account JSON key file
 * 3. Application Default Credentials (ADC) — automatic in GCP environments
 */

import type { PluginDBConnection, PluginQueryResult } from "@useatlas/plugin-sdk";

/**
 * Extract a safe identifier for logging (no credentials).
 * Returns the projectId if provided, otherwise "(default-project)".
 */
export function extractProjectId(config: BigQueryConnectionConfig): string {
  return config.projectId ?? "(default-project)";
}

export interface BigQueryConnectionConfig {
  projectId?: string;
  dataset?: string;
  location?: string;
  keyFilename?: string;
  credentials?: Record<string, unknown>;
  logger?: { warn(msg: string): void };
}

/**
 * Parse a `bigquery://` connection URL into a {@link BigQueryConnectionConfig}.
 *
 * Format: `bigquery://[location@]<project>[/<dataset>][?keyFilename=<path>]`
 *
 * Credentials are NOT embedded in the URL — they resolve the same way the
 * BigQuery client always resolves them: an explicit `keyFilename` query param
 * (or the `GOOGLE_APPLICATION_CREDENTIALS` env var the client reads), or
 * Application Default Credentials in a GCP environment. This mirrors the
 * Snowflake/Salesforce CLI url shape (the operator runs in their own shell —
 * the same trust model as the static atlas.config.ts path) and keeps the
 * url-based profiler-options contract (ADR-0017) usable for BigQuery without
 * ever surfacing a service-account key in a connection string.
 *
 * @throws {Error} If the scheme is not `bigquery://` or no project is present.
 */
export function parseBigQueryUrl(url: string): BigQueryConnectionConfig {
  if (!url.startsWith("bigquery://")) {
    throw new Error('BigQuery URL must start with "bigquery://".');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new Error(
      `Invalid bigquery:// URL: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  // `bigquery://location@project/dataset` — the URL host is `project`, and an
  // optional `location@` prefix lands in the username. The path's first
  // segment is the optional default dataset.
  const location = parsed.username ? decodeURIComponent(parsed.username) : undefined;
  const projectId = parsed.hostname ? decodeURIComponent(parsed.hostname) : "";
  if (!projectId) {
    throw new Error(
      "bigquery:// URL must include a project: bigquery://[location@]<project>[/<dataset>].",
    );
  }
  const datasetSegment = parsed.pathname.replace(/^\//, "").split("/")[0];
  const dataset = datasetSegment ? decodeURIComponent(datasetSegment) : undefined;
  const keyFilename = parsed.searchParams.get("keyFilename") ?? undefined;
  const locationParam = parsed.searchParams.get("location") ?? undefined;

  return {
    projectId,
    dataset,
    location: location ?? locationParam,
    keyFilename,
  };
}

/**
 * Create a PluginDBConnection backed by @google-cloud/bigquery.
 * BigQuery is stateless REST — no pool to manage.
 *
 * @throws {Error} If @google-cloud/bigquery is not installed (optional peer dependency).
 */
export function createBigQueryConnection(
  config: BigQueryConnectionConfig,
): PluginDBConnection {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let BigQueryClass: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ({ BigQuery: BigQueryClass } = require("@google-cloud/bigquery"));
  } catch (err) {
    const isNotFound =
      err != null &&
      typeof err === "object" &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND";
    // Only surface the install hint when the missing module is THIS package, not
    // a transitive dep that failed to load (same MODULE_NOT_FOUND code, different
    // named module). Node and bun both name the missing request quoted in the
    // message, so a transitive failure won't match our own specifier.
    const ownPackageMissing =
      isNotFound &&
      (err instanceof Error ? err.message : String(err)).includes(
        "'@google-cloud/bigquery'",
      );
    if (ownPackageMissing) {
      throw new Error(
        "BigQuery support requires the @google-cloud/bigquery package. Install it with: bun add @google-cloud/bigquery",
        { cause: err },
      );
    }
    throw new Error(
      `Failed to load @google-cloud/bigquery: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const clientOpts: Record<string, unknown> = {};
  if (config.projectId) clientOpts.projectId = config.projectId;
  if (config.keyFilename) clientOpts.keyFilename = config.keyFilename;
  if (config.credentials) clientOpts.credentials = config.credentials;

  const client = new BigQueryClass(clientOpts);

  return {
    async query(sql: string, timeoutMs = 30000): Promise<PluginQueryResult> {
      try {
        const options: Record<string, unknown> = {
          query: sql,
          jobTimeoutMs: timeoutMs,
          useLegacySql: false,
        };
        if (config.location) options.location = config.location;
        if (config.dataset) {
          options.defaultDataset = {
            datasetId: config.dataset,
            projectId: config.projectId,
          };
        }

        // BigQuery client.query() returns [rows, nextQuery, apiResponse]
        const response = await client.query(options);
        if (!Array.isArray(response) || response.length < 1) {
          throw new Error(
            "BigQuery query returned an unexpected response shape. " +
              "Expected a tuple [rows, nextQuery, apiResponse]. " +
              "This may indicate an incompatible @google-cloud/bigquery version.",
          );
        }
        if (response[0] != null && !Array.isArray(response[0])) {
          throw new Error(
            "BigQuery query returned non-array rows. " +
              "Expected an array of row objects from the BigQuery client.",
          );
        }
        const rows = (response[0] ?? []) as Record<string, unknown>[];

        // Extract column names from API response schema (third tuple element)
        const apiResponse = response[2];
        let columns: string[];
        if (apiResponse?.schema?.fields) {
          columns = (apiResponse.schema.fields as { name?: string }[]).map(
            (f, i) => f.name || `_unnamed_${i}`,
          );
        } else if (rows.length > 0) {
          columns = Object.keys(rows[0]);
        } else {
          columns = [];
        }

        return { columns, rows };
      } catch (err) {
        throw new Error(
          `BigQuery query failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    },
    async close(): Promise<void> {
      // BigQuery is a stateless REST API — no connection pool to drain.
    },
  };
}
