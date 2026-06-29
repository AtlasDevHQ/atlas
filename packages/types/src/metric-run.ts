/**
 * Wire format for the canonical metric-run REST endpoint
 * (`POST /api/v1/metrics/{id}/run`, #4048 / ADR-0027) — the `atlas metric run
 * <id>` CLI surface and the REST sibling of the MCP `runMetric` tool.
 *
 * SSOT for the route's local hono-`z` `RunMetricResponseSchema`
 * (`satisfies z.ZodType<RunMetricRestResponse>`) and the CLI's `.safeParse()`
 * (via `@useatlas/schemas` `RunMetricRestResponseSchema`). The route maps every
 * non-`ok` execution outcome to an HTTP error envelope, so this models only the
 * 200 body.
 */
export interface RunMetricRestResponse {
  /** The metric id (from `semantic/metrics/*.yml`). */
  readonly id: string;
  /** Human-readable label, or `null` when the metric defines none. */
  readonly label: string | null;
  /**
   * Scalar value for a single-column/single-row metric, else the full row set.
   * Mirrors the MCP `runMetric` tool's `value` projection — `unknown` because
   * the cell type is metric-defined.
   */
  readonly value: unknown;
  readonly columns: string[];
  readonly rows: Record<string, unknown>[];
  readonly rowCount: number;
  /** True when the result hit the auto-LIMIT row cap (more rows exist upstream). */
  readonly truncated: boolean;
  /** The authoritative SQL that was executed (used exactly as defined). */
  readonly sql: string;
  /** ISO-8601 timestamp stamped when the route shaped the response. */
  readonly executedAt: string;
}
