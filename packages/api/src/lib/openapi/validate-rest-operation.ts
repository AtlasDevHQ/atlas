/**
 * `validateRestOperation` — the REST write-side safety stack (PRD #2868 slice 5,
 * #2929). The sibling to `validateSQL` (`lib/tools/sql.ts`): a parallel
 * authorization boundary for the OpenAPI Datasource primitive, NOT folded into
 * the 4-layer SQL validator (which stays SQL-only per PRD §"Option B — parallel
 * adapter, not subordinate").
 *
 * This is a SECURITY boundary. Treat it like `validateSQL`:
 *   - default-deny on writes (a non-GET only executes if its `operationId` is in
 *     the install's `write_allowlist`),
 *   - fail loud on an operation that isn't in the probed graph (never dispatch a
 *     fabricated operation),
 *   - never a silent fallback — every rejection is an explicit
 *     {@link RestValidationError} the caller maps to a structured tool result.
 *
 * The five layers, enforced in order (mirroring the PRD's validation/safety
 * stack — network-level `networkPolicy` allowlisting is "layer 0", enforced in
 * the sandbox boundary, before any of this runs):
 *
 *   1. **Operation in graph.** Unknown `operationId` → `unknown-operation`.
 *   2. **Method allowlist.** GET/HEAD always pass; any other method requires
 *      `policy.writeAllowlist.has(operationId)` → `writes-disabled` otherwise.
 *   3. **Parameter shape.** Required params + required body present; no params
 *      that the spec doesn't declare → `invalid-params`.
 *   4. **Rate limit.** A per-`(workspace, datasource, operation)` token bucket
 *      (default 60/min, per-install override). Debited ONLY when the validation
 *      precedes a real upstream dispatch (`policy.dispatch !== false`) — staging
 *      a write for confirmation never hits the upstream, so it never debits →
 *      `rate-limit-exceeded` otherwise.
 *   5. **Timeout.** The effective per-request timeout, capped at
 *      `ATLAS_OPENAPI_TIMEOUT` (default 30s). A per-install requested timeout
 *      outside `(0, cap]` → `timeout-exceeded`.
 *
 * The numbering is the PRD's conceptual stack, but the rate-limit *debit*
 * (layer 4 — the only stateful side-effect) is performed **last**, after the
 * timeout check passes. A request rejected by any earlier validation (including
 * a misconfigured per-install timeout) must never drain the token bucket — the
 * quota throttles real upstream dispatches, not pre-flight rejections.
 *
 * On success the verdict carries the resolved {@link Operation}, whether the
 * caller must obtain human confirmation before dispatching (every non-GET/HEAD),
 * and the effective `timeoutMs` to pass to the client.
 */
import { Data } from "effect";

import { createLogger } from "@atlas/api/lib/logger";
import type { Operation, OperationGraph, OperationParams } from "./types";

const log = createLogger("openapi.validate-rest-operation");

// ─────────────────────────────────────────────────────────────────────
//  Rejection model
// ─────────────────────────────────────────────────────────────────────

/**
 * Why a REST operation was refused. Machine-readable so callers branch on the
 * `reason` (mirroring this module's sibling `OpenApiClientError` / `OpenApiSpecError`
 * convention of one tagged error with a `reason` union, rather than N classes).
 */
export type RestValidationReason =
  | "unknown-operation"
  | "writes-disabled"
  | "invalid-params"
  | "rate-limit-exceeded"
  | "timeout-exceeded";

/**
 * The single tagged error every rejection arm carries. Reason-specific detail is
 * optional (only the relevant fields are populated): `missingParams` /
 * `unexpectedParams` for `invalid-params`, `availableOperations` for
 * `unknown-operation`, `retryAfterMs` for `rate-limit-exceeded`.
 */
export class RestValidationError extends Data.TaggedError("RestValidationError")<{
  readonly reason: RestValidationReason;
  readonly message: string;
  readonly operationId: string;
  readonly missingParams?: ReadonlyArray<string>;
  readonly unexpectedParams?: ReadonlyArray<string>;
  readonly availableOperations?: ReadonlyArray<string>;
  readonly retryAfterMs?: number;
}> {}

// ─────────────────────────────────────────────────────────────────────
//  Policy + verdict
// ─────────────────────────────────────────────────────────────────────

/**
 * The per-install + per-request policy the validator authorizes against.
 * Resolved by the caller (the `executeRestOperation` tool / the confirm
 * endpoint) from the {@link import("./datasource").RestDatasource} install row
 * plus the request context.
 */
export interface RestOperationPolicy {
  /** Tenant scope for the rate-limit bucket key. */
  readonly workspaceId: string;
  /** Install scope for the rate-limit bucket key. */
  readonly datasourceId: string;
  /** The `operationId`s permitted to execute a non-GET method. Empty = read-only. */
  readonly writeAllowlist: ReadonlySet<string>;
  /** Per-install rate-limit override (calls/min). Default {@link DEFAULT_RATE_LIMIT_PER_MINUTE}. */
  readonly rateLimitPerMinute?: number;
  /**
   * Whether this validation precedes a real upstream dispatch. Reads, and the
   * human-confirmed write execution, set `true` (the default) and debit the
   * per-operation quota. Staging a write for confirmation sets `false` — it
   * never hits the upstream, so it must not burn quota (and the confirm step
   * debits exactly once).
   */
  readonly dispatch?: boolean;
  /**
   * Requested per-request timeout (ms) from per-install config. Validated
   * against {@link getOpenApiTimeoutCap}. Omit → the effective timeout is the cap.
   */
  readonly requestedTimeoutMs?: number;
  /** Test seam: injectable clock for the token bucket. Default `Date.now`. */
  readonly now?: () => number;
}

/** The result of authorizing a single operation. */
export type RestOperationVerdict =
  | {
      readonly allowed: true;
      readonly operation: Operation;
      /**
       * `true` for every non-GET/HEAD method — the caller MUST obtain human
       * confirmation (the confirm-before-write banner) before dispatching.
       */
      readonly requiresConfirmation: boolean;
      /** The effective per-request timeout the client should use. */
      readonly timeoutMs: number;
    }
  | { readonly allowed: false; readonly error: RestValidationError };

// ─────────────────────────────────────────────────────────────────────
//  Defaults / config
// ─────────────────────────────────────────────────────────────────────

/** Default per-operation rate limit (PRD layer 4). */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;

/** Fallback per-request timeout when `ATLAS_OPENAPI_TIMEOUT` is unset/invalid (30s). */
export const DEFAULT_OPENAPI_TIMEOUT_MS = 30_000;

let lastWarnedTimeout: string | undefined;

/**
 * The per-request timeout cap (ms), read from `ATLAS_OPENAPI_TIMEOUT` (the same
 * env the probe uses), defaulting to 30s. A non-positive / unparseable value is
 * ignored (warn once) and the default applies — a misconfigured cap must never
 * widen the ceiling to NaN/Infinity.
 */
export function getOpenApiTimeoutCap(): number {
  const raw = process.env.ATLAS_OPENAPI_TIMEOUT;
  if (raw === undefined) return DEFAULT_OPENAPI_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  if (Number.isFinite(n) && n > 0) return n;
  if (raw !== lastWarnedTimeout) {
    log.warn({ value: raw }, "Invalid ATLAS_OPENAPI_TIMEOUT value; using default 30000ms");
    lastWarnedTimeout = raw;
  }
  return DEFAULT_OPENAPI_TIMEOUT_MS;
}

// ─────────────────────────────────────────────────────────────────────
//  Layer 4 — token bucket (per workspace × datasource × operation)
// ─────────────────────────────────────────────────────────────────────

interface BucketState {
  tokens: number;
  lastRefill: number;
}

/**
 * In-process token-bucket store, keyed by `(workspaceId, datasourceId,
 * operationId)`. In-memory like `auth/middleware.ts`'s `checkRateLimit` windows
 * — the quota's job is to throttle a runaway agent loop on a paid upstream, not
 * to be a distributed billing primitive (PRD §Quotas). Reset between tests via
 * {@link _resetRestRateLimits}.
 */
const buckets = new Map<string, BucketState>();

// `\x00` cannot appear in a workspace/datasource/operation id, so the joined key
// can never collide across the three dimensions.
function bucketKey(workspaceId: string, datasourceId: string, operationId: string): string {
  return `${workspaceId}\x00${datasourceId}\x00${operationId}`;
}

/**
 * Try to consume one token from the bucket. Returns `{ allowed: true }` or
 * `{ allowed: false, retryAfterMs }`. Classic continuous-refill token bucket:
 * capacity = `perMinute`, refill = `perMinute` tokens per 60s.
 */
function tryConsumeToken(
  key: string,
  perMinute: number,
  now: number,
): { allowed: true } | { allowed: false; retryAfterMs: number } {
  const capacity = Number.isFinite(perMinute) && perMinute > 0 ? perMinute : DEFAULT_RATE_LIMIT_PER_MINUTE;
  const refillPerMs = capacity / 60_000;

  let state = buckets.get(key);
  if (!state) {
    state = { tokens: capacity, lastRefill: now };
    buckets.set(key, state);
  }

  // Continuous refill since the last access (clamped to capacity).
  const elapsed = Math.max(0, now - state.lastRefill);
  state.tokens = Math.min(capacity, state.tokens + elapsed * refillPerMs);
  state.lastRefill = now;

  if (state.tokens >= 1) {
    state.tokens -= 1;
    return { allowed: true };
  }
  // Time until the next whole token refills.
  const retryAfterMs = Math.ceil((1 - state.tokens) / refillPerMs);
  return { allowed: false, retryAfterMs: Math.max(1, retryAfterMs) };
}

/** Clear all rate-limit buckets. For tests. */
export function _resetRestRateLimits(): void {
  buckets.clear();
}

// ─────────────────────────────────────────────────────────────────────
//  Layer 3 — parameter shape
// ─────────────────────────────────────────────────────────────────────

/** Buckets on {@link OperationParams} that carry agent-supplied named params. */
const PARAM_BUCKETS = ["path", "query", "header"] as const;

/**
 * Validate the supplied params against the operation's declared parameters:
 *   - every `required` declared parameter has a value in its matching bucket,
 *   - a required request body is present,
 *   - no supplied param is undeclared by the spec (no extras).
 *
 * Returns the rejection's detail, or `null` when the shape is valid. Type
 * coercion beyond presence (deep JSON-Schema type checks) is intentionally out
 * of scope — the client encodes scalars/arrays and the upstream rejects a true
 * type mismatch with a structured 4xx the agent can read.
 */
function validateParamShape(
  operation: Operation,
  params: OperationParams,
): { missingParams?: string[]; unexpectedParams?: string[] } | null {
  // Declared param names, grouped by location.
  const declared: Record<(typeof PARAM_BUCKETS)[number], Set<string>> = {
    path: new Set(),
    query: new Set(),
    header: new Set(),
  };
  const missing: string[] = [];
  for (const p of operation.parameters) {
    if (p.in === "cookie") continue; // not emitted by the client this slice
    declared[p.in].add(p.name);
    if (p.required) {
      const supplied = params[p.in]?.[p.name];
      if (supplied === undefined) missing.push(p.name);
    }
  }

  // Required request body.
  if (operation.requestBody?.required && params.body === undefined) {
    missing.push("body");
  }

  // Extras — any supplied key the spec doesn't declare for that location.
  const unexpected: string[] = [];
  for (const bucket of PARAM_BUCKETS) {
    const supplied = params[bucket];
    if (!supplied) continue;
    for (const key of Object.keys(supplied)) {
      if (!declared[bucket].has(key)) unexpected.push(key);
    }
  }

  if (missing.length === 0 && unexpected.length === 0) return null;
  return {
    ...(missing.length > 0 ? { missingParams: missing } : {}),
    ...(unexpected.length > 0 ? { unexpectedParams: unexpected } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Public entry point
// ─────────────────────────────────────────────────────────────────────

/**
 * A GET/HEAD reads; anything else mutates and is gated by the write allowlist.
 * Exported so the `executeRestOperation` tool peeks an operation's write-ness
 * with the same predicate the validator authorizes against (no re-deriving the
 * `!== "GET" && !== "HEAD"` check inline, where it could drift).
 */
export function isWriteMethod(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

/**
 * Authorize a single REST operation against the install policy. See the module
 * doc for the layer ordering and security contract. Pure except for the layer-4
 * token bucket (the only stateful layer, and only when `dispatch !== false`).
 */
export function validateRestOperation(
  graph: OperationGraph,
  operationId: string,
  params: OperationParams,
  policy: RestOperationPolicy,
): RestOperationVerdict {
  // ── Layer 1 — operation must be in the probed graph (fail loud) ──────────
  const operation = graph.operations.get(operationId);
  if (operation === undefined) {
    return {
      allowed: false,
      error: new RestValidationError({
        reason: "unknown-operation",
        operationId,
        availableOperations: [...graph.operations.keys()].toSorted(),
        message:
          `Unknown operationId "${operationId}". It is not in the probed operation graph ` +
          `(${graph.operations.size} operations available). Refusing to dispatch a fabricated operation.`,
      }),
    };
  }

  const isWrite = isWriteMethod(operation.method);

  // ── Layer 2 — method allowlist (default-deny writes) ─────────────────────
  if (isWrite && !policy.writeAllowlist.has(operationId)) {
    return {
      allowed: false,
      error: new RestValidationError({
        reason: "writes-disabled",
        operationId,
        message:
          `Operation "${operationId}" is a ${operation.method} (write). Writes are disabled for this ` +
          `datasource — add "${operationId}" to its write allowlist to enable it. Do not claim it succeeded.`,
      }),
    };
  }

  // ── Layer 3 — parameter shape (required present, no extras) ──────────────
  const shape = validateParamShape(operation, params);
  if (shape) {
    const parts: string[] = [];
    if (shape.missingParams) parts.push(`missing required: ${shape.missingParams.join(", ")}`);
    if (shape.unexpectedParams) parts.push(`not declared by the spec: ${shape.unexpectedParams.join(", ")}`);
    return {
      allowed: false,
      error: new RestValidationError({
        reason: "invalid-params",
        operationId,
        ...(shape.missingParams ? { missingParams: shape.missingParams } : {}),
        ...(shape.unexpectedParams ? { unexpectedParams: shape.unexpectedParams } : {}),
        message: `Invalid parameters for "${operationId}" (${parts.join("; ")}).`,
      }),
    };
  }

  // ── Layer 5 — timeout cap (validated BEFORE the rate-limit debit) ────────
  // Side-effect-free, so it runs ahead of layer 4: a misconfigured per-install
  // timeout must reject without burning a token (the request never dispatches).
  const cap = getOpenApiTimeoutCap();
  let timeoutMs = cap;
  if (policy.requestedTimeoutMs !== undefined) {
    const requested = policy.requestedTimeoutMs;
    if (!Number.isFinite(requested) || requested <= 0 || requested > cap) {
      return {
        allowed: false,
        error: new RestValidationError({
          reason: "timeout-exceeded",
          operationId,
          message:
            `Requested timeout ${requested}ms for "${operationId}" is outside the allowed range ` +
            `(0, ${cap}ms]. Lower the per-install timeout or raise ATLAS_OPENAPI_TIMEOUT.`,
        }),
      };
    }
    timeoutMs = requested;
  }

  // ── Layer 4 — rate limit (debited LAST, only when this precedes a real ───
  // upstream call). Performed after every other validation so a request
  // rejected by layers 1–3 or 5 never drains the token bucket.
  if (policy.dispatch !== false) {
    const now = (policy.now ?? Date.now)();
    const verdict = tryConsumeToken(
      bucketKey(policy.workspaceId, policy.datasourceId, operationId),
      policy.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE,
      now,
    );
    if (!verdict.allowed) {
      return {
        allowed: false,
        error: new RestValidationError({
          reason: "rate-limit-exceeded",
          operationId,
          retryAfterMs: verdict.retryAfterMs,
          message:
            `Rate limit exceeded for "${operationId}" on this datasource ` +
            `(${policy.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE}/min). ` +
            `Retry in ~${Math.ceil(verdict.retryAfterMs / 1000)}s.`,
        }),
      };
    }
  }

  return { allowed: true, operation, requiresConfirmation: isWrite, timeoutMs };
}
