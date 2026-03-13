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

/** Subset of BigQueryConnectionConfig needed for dry-run estimation. */
export interface CostEstimatorConfig {
  projectId?: string;
  dataset?: string;
  location?: string;
  keyFilename?: string;
  credentials?: Record<string, unknown>;
}

export interface CostEstimate {
  bytesScanned: number;
  estimatedCostUsd: number;
}

// Cached BigQuery client — lazily created on first dry run,
// reused across all subsequent calls to avoid re-resolving credentials.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedClient: any = null;
let cachedConfigKey: string | undefined;

/** Build a stable cache key from the auth-relevant config fields. */
function configCacheKey(config: CostEstimatorConfig): string {
  return JSON.stringify({
    p: config.projectId,
    k: config.keyFilename,
    c: config.credentials ? Object.keys(config.credentials).sort().join(",") : undefined,
  });
}

/**
 * Run a dry-run query to estimate bytes scanned and cost.
 *
 * Returns `null` when the dry run fails (network error, permission issue,
 * unsupported query shape). Callers should log a warning but proceed.
 */
export async function estimateQueryCost(
  sql: string,
  config: CostEstimatorConfig,
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
    const key = configCacheKey(config);
    if (!cachedClient || cachedConfigKey !== key) {
      const clientOpts: Record<string, unknown> = {};
      if (config.projectId) clientOpts.projectId = config.projectId;
      if (config.keyFilename) clientOpts.keyFilename = config.keyFilename;
      if (config.credentials) clientOpts.credentials = config.credentials;
      cachedClient = new BigQueryClass(clientOpts);
      cachedConfigKey = key;
    }

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

    const [job] = await cachedClient.createQueryJob(options);
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
  return `${(bytes / 1e12).toFixed(1)} TB`;
}

/** Reset the cached client — for testing only. */
export function _resetCachedClient(): void {
  cachedClient = null;
  cachedConfigKey = undefined;
}
