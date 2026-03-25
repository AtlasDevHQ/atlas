/**
 * Tagged error types for the Effect.ts migration.
 *
 * Each error class uses `Data.TaggedError` so that Effect's `catchTag` and
 * `catchTags` can discriminate on the `_tag` field. The field set on each
 * error carries the context needed for logging and HTTP response mapping.
 *
 * Categories match the existing error shapes in the codebase:
 *   - SQL validation (4-layer pipeline in tools/sql.ts)
 *   - Connection (connection.ts registry)
 *   - Query execution (DB errors from pg/mysql2)
 *   - Rate limiting (source-rate-limit.ts)
 *   - RLS (row-level security injection)
 *   - Enterprise (feature gates and approval workflows)
 *   - Plugin (hook and validator errors)
 *   - Action (timeout in action handler)
 */

import { Data } from "effect";

// ── SQL Validation ──────────────────────────────────────────────────

/** Empty or whitespace-only SQL input. */
export class EmptyQueryError extends Data.TaggedError("EmptyQueryError")<{
  readonly message: string;
}> {}

/** DML/DDL keyword detected by regex guard (layer 1). */
export class ForbiddenPatternError extends Data.TaggedError("ForbiddenPatternError")<{
  readonly message: string;
  readonly pattern: string;
  readonly sql: string;
}> {}

/** AST parse failure, multiple statements, or non-SELECT (layer 2). */
export class ParseError extends Data.TaggedError("ParseError")<{
  readonly message: string;
  readonly sql: string;
  readonly detail?: string;
}> {}

/** Table not in the semantic-layer whitelist (layer 3). */
export class WhitelistError extends Data.TaggedError("WhitelistError")<{
  readonly message: string;
  readonly table: string;
  readonly allowed: ReadonlyArray<string>;
}> {}

// ── Connection ──────────────────────────────────────────────────────

/** Connection ID not found in the ConnectionRegistry. */
export class ConnectionNotFoundError extends Data.TaggedError("ConnectionNotFoundError")<{
  readonly message: string;
  readonly connectionId: string;
  readonly available: ReadonlyArray<string>;
}> {}

/** Org pool would exceed maxTotalConnections. */
export class PoolExhaustedError extends Data.TaggedError("PoolExhaustedError")<{
  readonly message: string;
  readonly current: number;
  readonly max: number;
}> {}

/** No analytics datasource URL configured. */
export class NoDatasourceError extends Data.TaggedError("NoDatasourceError")<{
  readonly message: string;
}> {}

// ── Query Execution ─────────────────────────────────────────────────

/** Statement timeout exceeded. */
export class QueryTimeoutError extends Data.TaggedError("QueryTimeoutError")<{
  readonly message: string;
  readonly sql: string;
  readonly timeoutMs: number;
}> {}

/** Database returned an error during query execution. */
export class QueryExecutionError extends Data.TaggedError("QueryExecutionError")<{
  readonly message: string;
  readonly hint?: string;
  readonly position?: string;
}> {}

// ── Rate Limiting ───────────────────────────────────────────────────

/** QPM (queries per minute) limit exceeded for a datasource. */
export class RateLimitExceededError extends Data.TaggedError("RateLimitExceededError")<{
  readonly message: string;
  readonly sourceId: string;
  readonly limit: number;
  readonly retryAfterMs?: number;
}> {}

/** Concurrent query limit reached for a datasource. */
export class ConcurrencyLimitError extends Data.TaggedError("ConcurrencyLimitError")<{
  readonly message: string;
  readonly sourceId: string;
  readonly limit: number;
}> {}

// ── Row-Level Security ──────────────────────────────────────────────

/** RLS processing failed (table extraction, filter resolution, or injection). */
export class RLSError extends Data.TaggedError("RLSError")<{
  readonly message: string;
  readonly phase: "extraction" | "filter" | "injection";
}> {}

// ── Enterprise ──────────────────────────────────────────────────────

/** Enterprise feature not available (ee module missing or disabled). */
export class EnterpriseGateError extends Data.TaggedError("EnterpriseGateError")<{
  readonly message: string;
  readonly feature: string;
}> {}

/** Query requires approval before execution. */
export class ApprovalRequiredError extends Data.TaggedError("ApprovalRequiredError")<{
  readonly message: string;
  readonly rules: ReadonlyArray<string>;
}> {}

// ── Plugin ──────────────────────────────────────────────────────────

/** Plugin beforeQuery hook rejected the query. */
export class PluginRejectedError extends Data.TaggedError("PluginRejectedError")<{
  readonly message: string;
  readonly connectionId: string;
}> {}

/** Custom validator threw an exception or returned invalid shape. */
export class CustomValidatorError extends Data.TaggedError("CustomValidatorError")<{
  readonly message: string;
  readonly connectionId: string;
}> {}

// ── Action ──────────────────────────────────────────────────────────

/** Action execution timed out. */
export class ActionTimeoutError extends Data.TaggedError("ActionTimeoutError")<{
  readonly message: string;
  readonly timeoutMs: number;
}> {}

// ── Union type ──────────────────────────────────────────────────────

/** Union of all known Atlas error types for exhaustive matching. */
export type AtlasError =
  | EmptyQueryError
  | ForbiddenPatternError
  | ParseError
  | WhitelistError
  | ConnectionNotFoundError
  | PoolExhaustedError
  | NoDatasourceError
  | QueryTimeoutError
  | QueryExecutionError
  | RateLimitExceededError
  | ConcurrencyLimitError
  | RLSError
  | EnterpriseGateError
  | ApprovalRequiredError
  | PluginRejectedError
  | CustomValidatorError
  | ActionTimeoutError;

/** Discriminant union of all known `_tag` values — derived from `AtlasError`. */
export type AtlasErrorTag = AtlasError["_tag"];
