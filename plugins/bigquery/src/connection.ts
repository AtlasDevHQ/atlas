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
 * Coerce a service-account JSON string into a credentials object, with an
 * actionable error for malformed input. Shared by the connection factory's
 * config normalization ({@link normalizeBigQueryConfigFields}) and the
 * registry/MCP profiler so the two credential paths can't drift (#3664).
 *
 * @throws {Error} when the string is not valid JSON, OR parses to something
 *   other than a JSON object (a non-null, non-array object). The shape check
 *   matters: `JSON.parse("null")` / a parsed array/number/string would
 *   otherwise be handed on as a falsy-or-malformed `credentials`, and the
 *   BigQuery client would silently fall back to Application Default Credentials
 *   (operator/ambient env) — a per-tenant-credential-isolation violation. Fail
 *   loud instead.
 */
export function parseServiceAccountJson(serviceAccountJson: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serviceAccountJson);
  } catch (err) {
    throw new Error(
      `BigQuery service_account_json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "BigQuery service_account_json must be a JSON object (the service account key contents).",
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Normalize a DB-stored / tenant BigQuery config (the Admin → Connections
 * catalog form shape: snake_case `service_account_json` + `project_id`) onto the
 * connection factory's field shape (camelCase `credentials` + `projectId`),
 * WITHOUT clobbering explicit camelCase values a programmatic caller passed.
 * Shared by `createFromConfig` (index.ts) and the registry/MCP profiler
 * (profiler.ts `bigQueryConfigFromTenantConfig`) so the connection path and the
 * profiling path resolve credentials identically and can't drift (#3664). An
 * explicit `keyFilename` takes precedence over `service_account_json` (the key
 * file wins), matching the connection factory's historical behavior.
 *
 * @throws {Error} when `service_account_json` is present but not a valid JSON object.
 */
export function normalizeBigQueryConfigFields(
  raw: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  if (out.projectId === undefined && typeof out.project_id === "string") {
    out.projectId = out.project_id;
  }
  if (
    out.credentials === undefined &&
    out.keyFilename === undefined &&
    typeof out.service_account_json === "string" &&
    out.service_account_json.trim().length > 0
  ) {
    out.credentials = parseServiceAccountJson(out.service_account_json);
  }
  return out;
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
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  let BigQueryClass: any;
  try {
    // oxlint-disable-next-line @typescript-eslint/no-require-imports
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
