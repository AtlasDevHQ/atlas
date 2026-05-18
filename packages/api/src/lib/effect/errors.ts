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

// Content-mode errors live in `lib/content-mode/port.ts` so that module
// stays self-contained and pure. They are folded into the `AtlasError`
// union below so `classifyError` / `mapTaggedError` pick them up when
// phase 2 of #1515 wires the registry into route handlers.
import {
  ExoticReadFilterUnavailableError,
  PublishPhaseError,
  UnknownTableError,
} from "@atlas/api/lib/content-mode/port";

export {
  ExoticReadFilterUnavailableError,
  PublishPhaseError,
  UnknownTableError,
} from "@atlas/api/lib/content-mode/port";

// EE-domain errors (promoted to core in slices 4–11 of #2017) — folded
// into `AtlasError` below so `classifyError` / `mapTaggedError` provide
// a safety-net mapping when a route forgets to wire its per-route
// `domainErrors: [...]` opt-in. Without this fallback (#2593), a new
// admin route that yields a Tag whose error isn't listed surfaces as a
// generic 500 in production instead of the expected 4xx envelope.
// Per-route `domainErrors:` still wins on `classifyError` precedence
// (instanceof check runs before the tagged-error fallback), so existing
// routes keep their bespoke per-code status maps.
import { RetentionError } from "@atlas/api/lib/audit/retention-errors";
import { RoleError } from "@atlas/api/lib/auth/roles-errors";
import { ApprovalError } from "@atlas/api/lib/governance/errors";
import { ResidencyError } from "@atlas/api/lib/residency/errors";
import { BrandingError } from "@atlas/api/lib/branding/branding-errors";
import { DomainError } from "@atlas/api/lib/platform/domains-errors";
import { ComplianceError, ReportError } from "@atlas/api/lib/compliance/errors";
import {
  ModelConfigError,
  ModelConfigDecryptError,
} from "@atlas/api/lib/model-routing/errors";

export {
  RetentionError,
  RoleError,
  ApprovalError,
  ResidencyError,
  BrandingError,
  DomainError,
  ComplianceError,
  ReportError,
  ModelConfigError,
  ModelConfigDecryptError,
};

// ── Utilities ──────────────────────────────────────────────────────

/** Normalize unknown caught values to Error. Used in Effect.tryPromise catch clauses. */
export function normalizeError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

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

/**
 * Enterprise subsystem failed to bind despite `ATLAS_ENTERPRISE_ENABLED=true`.
 *
 * Raised at consumer call sites (#2593) when a load-bearing Tag still
 * reports `available: false` after the EE Layer was supposed to overlay
 * its real implementation. The most common cause is the @atlas/ee/layers
 * dynamic import failing in `ConditionalEELayer` (which currently logs
 * `event: "enterprise.load_failed"` and falls through to no-op defaults).
 *
 * Maps to HTTP 503 — operator-visible, retryable. Distinct from
 * `EnterpriseError` (403: feature not enabled at all) and
 * `EnterpriseGateError` (403: feature gated on a self-hosted install).
 * Self-hosted (`ATLAS_ENTERPRISE_ENABLED !== true`) never raises this;
 * the consumer treats `available: false` as "feature off, proceed without".
 */
export class EnterpriseUnavailableError extends Data.TaggedError("EnterpriseUnavailableError")<{
  readonly message: string;
  /** Tag whose no-op default is still resolving — operator can correlate with `enterprise.load_failed` logs. */
  readonly tag: string;
}> {}

/** Query requires approval before execution. */
export class ApprovalRequiredError extends Data.TaggedError("ApprovalRequiredError")<{
  readonly message: string;
  readonly rules: ReadonlyArray<string>;
}> {}

/**
 * Enterprise-required guard error. Thrown by `requireEnterprise()` and
 * `Effect.fail`'d by `requireEnterpriseEffect()` when an enterprise feature
 * is accessed without the flag enabled.
 *
 * Hosted here (rather than in `@atlas/ee/index`) so core route handlers
 * and effect bridges can `instanceof`-check without importing from EE —
 * see #2563 (slice 1/11 of #2017, inverting the core → ee dependency).
 * EE re-exports this class from `ee/src/index.ts` for back-compat through
 * slice 11.
 *
 * **Invariant**: the `_tag` (and therefore the inherited `Error.name`) must
 * stay `"EnterpriseError"` — `lib/effect/hono.ts:isEnterpriseError` duck-types
 * on `err.name === "EnterpriseError"` to map this to HTTP 403 without taking
 * a hard import on the class. The shared `hono.test.ts` coupling test
 * guards this invariant.
 */
export class EnterpriseError extends Data.TaggedError("EnterpriseError")<{
  message: string;
  code: "enterprise_required";
}> {
  constructor(message = "Enterprise features are not enabled") {
    super({ message, code: "enterprise_required" });
  }
}

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

// ── Conversation Budget (F-77) ─────────────────────────────────────

/**
 * Aggregate per-conversation step ceiling exceeded. Per-request caps
 * (`stepCountIs(25)`, 180s wall-clock) bound a single agent run; this
 * error fires when `total_steps` on a conversation crosses
 * `ATLAS_CONVERSATION_STEP_CAP`. The chat handler returns 429 with the
 * specific `conversation_budget_exceeded` chat error code so the UI can
 * render a "start a new conversation" affordance instead of suggesting
 * retry. Audited via `conversation.budget_exceeded` so abuse detection
 * gets a signal.
 */
export class ConversationBudgetExceededError extends Data.TaggedError("ConversationBudgetExceededError")<{
  readonly message: string;
  readonly conversationId: string;
  readonly totalSteps: number;
  readonly cap: number;
}> {}

// ── Region Migration ───────────────────────────────────────────────

/**
 * Reset of a region migration was rejected because Phase 3 (cutover) had
 * already flipped the workspace into the destination region. Re-running
 * Phase 1 (export from source) on a workspace that already moved would
 * re-export stale data and corrupt the destination — so the code path
 * is closed entirely. Operators must follow the data-residency
 * manual-intervention runbook.
 *
 * Maps to HTTP 409 Conflict.
 */
export class UnsafeRegionMigrationResetError extends Data.TaggedError("UnsafeRegionMigrationResetError")<{
  readonly message: string;
  readonly migrationId: string;
  readonly workspaceId: string;
  /** Region the workspace already moved to (i.e. the destination that took ownership). */
  readonly targetRegion: string;
  /** Region the workspace moved from — runbook step 1 needs it to locate the orphaned source bundle. */
  readonly sourceRegion: string;
}> {}

// ── Semantic Entities ──────────────────────────────────────────────

/**
 * Narrow union for `AmbiguousEntityError.entityType`. Mirrors
 * `SemanticEntityType` from `semantic/entities.ts` — declared inline
 * here to avoid a circular import (errors.ts ↔ semantic/entities.ts).
 * Adding a new semantic entity kind requires updating both definitions;
 * the test suite asserts they stay in lockstep.
 */
export type AmbiguousEntityKind = "entity" | "metric" | "glossary" | "catalog";

/**
 * `getEntity(orgId, type, name)` resolved more than one row because the
 * same `(org, entity_type, name)` triple exists in multiple
 * `connection_group_id` scopes (#2412). Callers must disambiguate by
 * passing the group explicitly.
 *
 * Maps to HTTP 409 Conflict — the caller asked an ambiguous question.
 * The route layer returns the candidate groups so the UI can prompt the
 * admin to pick one (`POST` with `connectionGroupId` set).
 *
 * Invariant: `groups.length >= 2`. Caller paths in `getEntity` only
 * throw when the DISTINCT-on-group probe returned more than one row, so
 * a single-candidate ambiguity cannot fire in production. Tests that
 * construct this error by hand should respect the same constraint.
 */
export class AmbiguousEntityError extends Data.TaggedError("AmbiguousEntityError")<{
  readonly message: string;
  readonly entityName: string;
  readonly entityType: AmbiguousEntityKind;
  readonly groups: ReadonlyArray<string | null>;
}> {}

// ── Scheduler ──────────────────────────────────────────────────────

/** Scheduled task execution timed out. */
export class SchedulerTaskTimeoutError extends Data.TaggedError("SchedulerTaskTimeoutError")<{
  readonly message: string;
  readonly taskId: string;
  readonly timeoutMs: number;
}> {}

/** Scheduled task execution failed. */
export class SchedulerExecutionError extends Data.TaggedError("SchedulerExecutionError")<{
  readonly message: string;
  readonly taskId: string;
  readonly runId?: string;
}> {}

/** Delivery to a recipient channel failed. */
export class DeliveryError extends Data.TaggedError("DeliveryError")<{
  readonly message: string;
  readonly channel: string;
  readonly recipient: string;
  /** When true, this error is permanent and should not be retried. */
  readonly permanent: boolean;
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
  | EnterpriseUnavailableError
  | ApprovalRequiredError
  | PluginRejectedError
  | CustomValidatorError
  | ActionTimeoutError
  | ConversationBudgetExceededError
  | UnsafeRegionMigrationResetError
  | AmbiguousEntityError
  | SchedulerTaskTimeoutError
  | SchedulerExecutionError
  | DeliveryError
  | PublishPhaseError
  | UnknownTableError
  | ExoticReadFilterUnavailableError
  // ── EE-domain errors (safety net — see #2593) ───────────────────
  | RetentionError
  | RoleError
  | ApprovalError
  | ResidencyError
  | BrandingError
  | DomainError
  | ComplianceError
  | ReportError
  | ModelConfigError
  | ModelConfigDecryptError;

/** Discriminant union of all known `_tag` values — derived from `AtlasError`. */
export type AtlasErrorTag = AtlasError["_tag"];

/**
 * Compile-time verified list of all known `_tag` values.
 *
 * The `satisfies` clause ensures this array stays in sync with `AtlasErrorTag`:
 * adding a new error variant to the `AtlasError` union without updating this
 * list causes a type error. Used by `hono.ts` to build the `ATLAS_ERROR_TAGS`
 * set for runtime error classification.
 */
export const ATLAS_ERROR_TAG_LIST = [
  "EmptyQueryError",
  "ForbiddenPatternError",
  "ParseError",
  "WhitelistError",
  "ConnectionNotFoundError",
  "PoolExhaustedError",
  "NoDatasourceError",
  "QueryTimeoutError",
  "QueryExecutionError",
  "RateLimitExceededError",
  "ConcurrencyLimitError",
  "RLSError",
  "EnterpriseGateError",
  "EnterpriseUnavailableError",
  "ApprovalRequiredError",
  "PluginRejectedError",
  "CustomValidatorError",
  "ActionTimeoutError",
  "ConversationBudgetExceededError",
  "UnsafeRegionMigrationResetError",
  "AmbiguousEntityError",
  "SchedulerTaskTimeoutError",
  "SchedulerExecutionError",
  "DeliveryError",
  "PublishPhaseError",
  "UnknownTableError",
  "ExoticReadFilterUnavailableError",
  // ── EE-domain errors (safety net — see #2593) ───────────────────
  "RetentionError",
  "RoleError",
  "ApprovalError",
  "ResidencyError",
  "BrandingError",
  "DomainError",
  "ComplianceError",
  "ReportError",
  "ModelConfigError",
  "ModelConfigDecryptError",
] as const satisfies readonly AtlasErrorTag[];

/** Compile-time check: every `AtlasErrorTag` must appear in the list. */
type _AssertComplete = AtlasErrorTag extends (typeof ATLAS_ERROR_TAG_LIST)[number] ? true : never;
const _assertComplete: _AssertComplete = true;
void _assertComplete;
