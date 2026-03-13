/**
 * BigQuery dry-run cost estimation.
 *
 * Runs a query with `dryRun: true` to extract `totalBytesProcessed` from
 * job statistics without actually executing the query. Uses BigQuery
 * on-demand pricing ($5 per TB scanned) to estimate cost.
 *
 * Errors are caught and returned as `null` — callers should log a warning
 * but never block query execution due to a failed dry run.
 */

import type { BigQueryConnectionConfig } from "./connection";

export interface CostEstimate {
  bytesScanned: number;
  estimatedCostUsd: number;
}

/**
 * Run a dry-run query to estimate bytes scanned and cost.
 *
 * Returns `null` when the dry run fails (network error, permission issue,
 * unsupported query shape). Callers should log a warning but proceed.
 */
export async function estimateQueryCost(
  sql: string,
  config: BigQueryConnectionConfig,
): Promise<CostEstimate | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let BigQueryClass: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ({ BigQuery: BigQueryClass } = require("@google-cloud/bigquery"));
  } catch {
    return null;
  }

  try {
    const clientOpts: Record<string, unknown> = {};
    if (config.projectId) clientOpts.projectId = config.projectId;
    if (config.keyFilename) clientOpts.keyFilename = config.keyFilename;
    if (config.credentials) clientOpts.credentials = config.credentials;

    const client = new BigQueryClass(clientOpts);

    const options: Record<string, unknown> = {
      query: sql,
      dryRun: true,
      useLegacySql: false,
    };
    if (config.location) options.location = config.location;
    if (config.dataset) {
      options.defaultDataset = {
        datasetId: config.dataset,
        projectId: config.projectId,
      };
    }

    const [job] = await client.createQueryJob(options);
    const bytesScanned = Number(
      job?.metadata?.statistics?.totalBytesProcessed ?? 0,
    );
    const estimatedCostUsd = (bytesScanned / 1e12) * 5;
    return { bytesScanned, estimatedCostUsd };
  } catch {
    return null;
  }
}

/** Format bytes into a human-readable string (e.g. "2.3 GB"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(1)} KB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes < 1e12) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${(bytes / 1e12).toFixed(2)} TB`;
}
