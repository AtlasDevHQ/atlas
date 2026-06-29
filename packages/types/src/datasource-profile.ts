/**
 * Wire format for the datasource-profiling REST endpoint
 * (`POST /api/v1/datasources/{id}/profile`, #4052 / ADR-0027) — the `atlas
 * datasource profile <id>` CLI surface and the REST sibling of the MCP
 * `profile_datasource` tool.
 *
 * The endpoint is long-running and streams newline-delimited JSON
 * (`application/x-ndjson`): a `start` event, one `table` event per profiled
 * table, then a terminal `result` (or `error`) event. Before #4111 the only
 * machine-checkable contract for this stream was a prose description on the
 * route's `ProfileResponseSchema = z.object({})` plus a hand-declared CLI
 * interface — nothing shared. These types are the SSOT for both the route's
 * emit-side ({@link DatasourceProfileStreamEvent}, so a malformed event fails
 * to compile) and the CLI's `.safeParse()` consumer (via `@useatlas/schemas`).
 */

/**
 * Terminal `error`-event codes the profile route emits AFTER the stream has
 * committed its 200 (so they ride as NDJSON, never an HTTP 5xx):
 *
 * - `reconnect_required` — an OAuth token was revoked mid-profile.
 * - `profiling_failed`   — an actionable validation outcome (no profilable
 *   tables, too many introspection failures, a persist failure).
 * - `internal_error`     — an unexpected throw from the profiler; carries a
 *   `requestId` for log correlation.
 */
export const DATASOURCE_PROFILE_ERROR_CODES = [
  "reconnect_required",
  "profiling_failed",
  "internal_error",
] as const;

export type DatasourceProfileErrorCode = (typeof DATASOURCE_PROFILE_ERROR_CODES)[number];

/** Type guard — checks whether a string is a known {@link DatasourceProfileErrorCode}. */
export function isDatasourceProfileErrorCode(value: string): value is DatasourceProfileErrorCode {
  return (DATASOURCE_PROFILE_ERROR_CODES as ReadonlyArray<string>).includes(value);
}

/**
 * The terminal `result` event's payload — the generated (draft) semantic-layer
 * summary. This is the value the `atlas datasource profile` command resolves
 * with, so it is also the CLI's public return shape.
 */
export interface DatasourceProfileResult {
  readonly id: string;
  readonly queryable: boolean;
  readonly persisted: boolean;
  /** Lifecycle of the persisted layer — `"draft"` today (never auto-published). */
  readonly persistedStatus?: string;
  readonly entitiesGenerated: number;
  readonly metricsGenerated: number;
  readonly tables: readonly string[];
  readonly profilingErrors: number;
  /**
   * Honest partial-success signal: some tables failed introspection but stayed
   * under the fatal threshold, so the layer persisted with those tables ABSENT.
   */
  readonly incomplete: boolean;
  /** Names of the tables that failed introspection (present only when `incomplete`). */
  readonly incompleteTables?: readonly string[];
  readonly elapsedMs: number;
}

/** `start` — emitted once, before any table is profiled. */
export interface DatasourceProfileStartEvent {
  readonly type: "start";
  readonly total: number;
}

/** `table` — one per profiled table, carrying its done/error status. */
export interface DatasourceProfileTableEvent {
  readonly type: "table";
  readonly name: string;
  readonly index: number;
  readonly total: number;
  readonly status: "done" | "error";
  /** Scrubbed introspection error message, present only on `status: "error"`. */
  readonly error?: string;
}

/** `result` — the terminal success event wrapping {@link DatasourceProfileResult}. */
export interface DatasourceProfileResultEvent extends DatasourceProfileResult {
  readonly type: "result";
}

/** `error` — the terminal failure event (rides as NDJSON; the 200 is already sent). */
export interface DatasourceProfileErrorEvent {
  readonly type: "error";
  readonly error: DatasourceProfileErrorCode;
  readonly message: string;
  /** Present on the codes that carry a log-correlation id (`internal_error`, `reconnect_required`). */
  readonly requestId?: string;
}

/**
 * The discriminated union of every line the profile NDJSON stream can emit,
 * keyed on `type`. The route's per-line `write(...)` is typed against this so a
 * malformed event fails to compile; the CLI `.safeParse()`s each parsed line
 * against the matching member.
 */
export type DatasourceProfileStreamEvent =
  | DatasourceProfileStartEvent
  | DatasourceProfileTableEvent
  | DatasourceProfileResultEvent
  | DatasourceProfileErrorEvent;
