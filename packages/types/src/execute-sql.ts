/**
 * Wire format for `executeSQL` tool results.
 *
 * Single-environment executions emit a 1-element `envContributions` array
 * (just the one connection that ran). Cross-environment fanouts (PRD #2515,
 * `scope: "all"` or picker mode `all`) emit one entry per member of the
 * active connection group, so SDK consumers can render side-by-side panes
 * keyed by `connectionId`.
 *
 * The runtime shape produced by `mergeMemberResults` in
 * `@atlas/api/lib/multi-env-merger` mirrors {@link ConnectionContribution}
 * exactly. The merger's interface IS the wire shape — both sides converged
 * during slice 4 (#2519).
 *
 * @see PRD #2515 — agent-routed cross-environment querying
 * @see issue #2519 — slice 4 acceptance criteria
 */

/**
 * Per-environment execution metadata surfaced alongside merged rows.
 *
 * `error` is explicitly `null` (not omitted) on success so the JSON wire
 * shape is stable — clients can render `c.error ?? "OK"` without an
 * `in` check. `durationMs` is wall-clock for that one member's
 * execution; the overall tool-call `executionMs` is the max across
 * members (parallel fanout).
 */
export interface ConnectionContribution {
  /** Connection id that this member executed against. */
  readonly connectionId: string;
  /** Rows produced by this member. `0` when the member errored or returned no rows. */
  readonly rowCount: number;
  /** Error message if this member failed; `null` on success. */
  readonly error: string | null;
  /** Wall-clock duration of this member's execution in milliseconds. */
  readonly durationMs: number;
}

/**
 * Successful `executeSQL` tool-call payload.
 *
 * `envContributions` is always present and has at least one entry — even
 * for single-environment executions, where it carries a 1-element array
 * describing the lone connection. This keeps the consumer code path
 * uniform between single-env and fanout responses (slice 4 invariant).
 *
 * `executionMs` is the *overall* tool-call duration. For fanouts that's
 * the max member duration (Promise.allSettled runs in parallel); for
 * single-env it equals the member's `envContributions[0].durationMs`.
 */
export interface ExecuteSqlSuccessResult {
  readonly success: true;
  readonly explanation?: string;
  readonly row_count: number;
  readonly columns: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
  readonly truncated?: boolean;
  readonly cached?: boolean;
  readonly maskingApplied?: boolean;
  readonly executionMs?: number;
  readonly envContributions?: readonly ConnectionContribution[];
}

/**
 * Failed `executeSQL` tool-call payload.
 *
 * `envContributions` is present on cross-environment "all members failed"
 * outcomes so consumers can attribute the failure per connection. Other
 * failure shapes (validation errors, approval required, etc.) omit the
 * field entirely — the success/failure decision happened before any
 * member executed.
 */
export interface ExecuteSqlFailureResult {
  readonly success: false;
  readonly explanation?: string;
  readonly error?: string;
  readonly executionMs?: number;
  readonly envContributions?: readonly ConnectionContribution[];
  /** Other fields (approval_required, approval_request_id, etc.) flow through as `unknown`. */
  readonly [key: string]: unknown;
}

/**
 * Wire format for the `executeSQL` tool-call result, as emitted in the
 * `tool-output-available` SSE event and persisted in conversation
 * messages.
 */
export type ExecuteSqlResult = ExecuteSqlSuccessResult | ExecuteSqlFailureResult;

/**
 * Wire format for the raw-SQL REST endpoint's success body
 * (`POST /api/v1/execute-sql`, #4047 / ADR-0027) — the `atlas sql "SELECT …"`
 * CLI surface. This is the REST sibling of the agent loop's
 * {@link ExecuteSqlResult}, named distinctly to avoid colliding with that
 * tool-call shape (which carries `success`/`row_count`/`envContributions`).
 * Here the route has already mapped every non-`ok` outcome to an HTTP error
 * envelope, so this models only the 200 body: a flat `{columns, rows}` plus
 * row-count / truncation / timing metadata (no pagination — `truncated` is the
 * auto-LIMIT cap signal, not a paging cursor).
 *
 * SSOT for the route's local hono-`z` `ExecuteSqlResponseSchema`
 * (`satisfies z.ZodType<ExecuteSqlRestResponse>`) and the CLI's
 * `.safeParse()` (via `@useatlas/schemas` `ExecuteSqlRestResponseSchema`).
 */
export interface ExecuteSqlRestResponse {
  readonly columns: string[];
  readonly rows: Record<string, unknown>[];
  readonly rowCount: number;
  /** True when the result hit the auto-LIMIT row cap (more rows exist upstream). */
  readonly truncated: boolean;
  /** Wall-clock execution time in milliseconds. */
  readonly executionMs: number;
  /** ISO-8601 timestamp stamped when the route shaped the response. */
  readonly executedAt: string;
}
