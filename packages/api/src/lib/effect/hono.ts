/**
 * Effect ↔ Hono bridge.
 *
 * Runs Effect programs inside Hono route handlers, mapping tagged errors
 * to HTTP responses and logging defects with requestId.
 *
 * @example
 * ```ts
 * import { runEffect } from "@atlas/api/lib/effect";
 *
 * router.get("/data", async (c) => {
 *   const result = await runEffect(c, myEffectProgram, { label: "fetch data" });
 *   return c.json(result, 200);
 * });
 * ```
 */

import { Array as Arr, Effect, Exit, Cause, Option } from "effect";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createLogger } from "@atlas/api/lib/logger";
import type { AtlasError } from "./errors";

const log = createLogger("effect-bridge");

// ── Error mapping ───────────────────────────────────────────────────

/** Known error code vocabulary for HTTP error responses. */
type HttpErrorCode =
  | "bad_request"
  | "forbidden"
  | "not_found"
  | "unprocessable_entity"
  | "rate_limited"
  | "upstream_error"
  | "service_unavailable"
  | "timeout";

interface HttpErrorMapping {
  readonly status: ContentfulStatusCode;
  readonly code: HttpErrorCode;
  readonly message: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Set of all `_tag` values in the `AtlasError` union.
 * Used by `isAtlasError` to narrow unknown objects before calling `mapTaggedError`.
 */
const ATLAS_ERROR_TAGS = new Set<string>([
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
  "ApprovalRequiredError",
  "PluginRejectedError",
  "CustomValidatorError",
  "ActionTimeoutError",
  "SchedulerTaskTimeoutError",
  "SchedulerExecutionError",
  "DeliveryError",
]);

/**
 * Type guard for objects with a `_tag` string and `message` string.
 */
function isTaggedError(error: unknown): error is { readonly _tag: string; readonly message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof (error as Record<string, unknown>)._tag === "string" &&
    "message" in error &&
    typeof (error as Record<string, unknown>).message === "string"
  );
}

/**
 * Narrow a tagged error to a known `AtlasError`.
 * Returns true only when `_tag` is one of the known tags in `ATLAS_ERROR_TAGS`.
 */
function isAtlasError(error: { readonly _tag: string }): error is AtlasError {
  return ATLAS_ERROR_TAGS.has(error._tag);
}

/**
 * Map a known Atlas error to an HTTP status code, error code, and optional headers.
 *
 * Exhaustive over `AtlasError` — the compiler will error if a new variant
 * is added to the union without a corresponding case here.
 *
 * Status code assignments are designed to match the HTTP semantics of each
 * error category and align with existing route behavior.
 */
export function mapTaggedError(error: AtlasError): HttpErrorMapping {
  switch (error._tag) {
    // ── 400 Bad Request — malformed input ────────────────────────
    case "EmptyQueryError":
    case "ParseError":
      return { status: 400, code: "bad_request", message: error.message };

    // ── 403 Forbidden — policy/permission violations ─────────────
    case "ForbiddenPatternError":
    case "WhitelistError":
    case "EnterpriseGateError":
    case "ApprovalRequiredError":
    case "RLSError":
      return { status: 403, code: "forbidden", message: error.message };

    // ── 404 Not Found ────────────────────────────────────────────
    case "ConnectionNotFoundError":
      return { status: 404, code: "not_found", message: error.message };

    // ── 422 Unprocessable Entity — plugin rejected ───────────────
    case "PluginRejectedError":
    case "CustomValidatorError":
      return { status: 422, code: "unprocessable_entity", message: error.message };

    // ── 429 Too Many Requests ────────────────────────────────────
    case "RateLimitExceededError": {
      const retryAfterSec = Math.ceil((error.retryAfterMs ?? 60_000) / 1000);
      return {
        status: 429,
        code: "rate_limited",
        message: error.message,
        headers: { "Retry-After": String(retryAfterSec) },
      };
    }
    case "ConcurrencyLimitError":
    case "PoolExhaustedError":
      return { status: 429, code: "rate_limited", message: error.message };

    // ── 502 Bad Gateway — upstream DB error ──────────────────────
    case "QueryExecutionError":
      return { status: 502, code: "upstream_error", message: error.message };

    // ── 503 Service Unavailable ──────────────────────────────────
    case "NoDatasourceError":
      return { status: 503, code: "service_unavailable", message: error.message };

    // ── 504 Gateway Timeout ──────────────────────────────────────
    case "QueryTimeoutError":
    case "ActionTimeoutError":
    case "SchedulerTaskTimeoutError":
      return { status: 504, code: "timeout", message: error.message };

    // ── Scheduler ──────────────────────────────────────────────
    case "SchedulerExecutionError":
      return { status: 500, code: "upstream_error", message: error.message };
    case "DeliveryError":
      return { status: 502, code: "upstream_error", message: error.message };
  }
}

// ── Bridge ──────────────────────────────────────────────────────────

/**
 * Run an Effect program inside a Hono route handler.
 *
 * On success, returns the program's value so the handler can build its
 * own response.  On failure, throws an `HTTPException` with a JSON body
 * containing `{ error, message, requestId }` — Hono's error handler
 * returns this to the client.
 *
 * Four failure modes are handled:
 * 1. **Known tagged error** (Atlas `_tag`) → mapped HTTP status via `mapTaggedError`
 * 2. **Unknown tagged / untagged typed error** → logged with `_tag` (if present) and returned as 500
 * 3. **Fiber interruption** → logged at warn level, returned as 500
 * 4. **Defect** (unexpected throw) → all defects logged at error level, returned as 500
 *
 * @param c - Hono context (used for `requestId` extraction)
 * @param program - Fully-provided Effect program (`R = never`)
 * @param options.label - Human-readable action label for error messages and logs
 */
export async function runEffect<A, E>(
  c: Context,
  program: Effect.Effect<A, E, never>,
  options?: { label?: string },
): Promise<A> {
  const exit = await Effect.runPromiseExit(program);

  if (Exit.isSuccess(exit)) {
    return exit.value;
  }

  const requestId = (c.get("requestId") as string | undefined) ?? "unknown";
  const label = options?.label ?? "process request";

  // ── Expected failure (typed error in the E channel) ──────────
  const failureOpt = Cause.failureOption(exit.cause);

  if (Option.isSome(failureOpt)) {
    const error = failureOpt.value;

    // Known Atlas error — map to HTTP status with optional headers
    if (isTaggedError(error) && isAtlasError(error)) {
      const mapped = mapTaggedError(error);
      throw new HTTPException(mapped.status, {
        res: Response.json(
          { error: mapped.code, message: mapped.message, requestId },
          { status: mapped.status, headers: mapped.headers },
        ),
      });
    }

    // Unknown tagged error — include _tag in log for debugging
    if (isTaggedError(error)) {
      const errObj = error instanceof Error ? error : new Error(String(error));
      log.error({ err: errObj, requestId, tag: error._tag }, `Unmapped tagged error "${error._tag}" in ${label}`);
    } else {
      const errObj = error instanceof Error ? error : new Error(String(error));
      log.error({ err: errObj, requestId }, `Unmapped error in ${label}`);
    }

    throw new HTTPException(500, {
      res: Response.json(
        { error: "internal_error", message: `Failed to ${label}.`, requestId },
        { status: 500 },
      ),
    });
  }

  // ── Fiber interruption ────────────────────────────────────────
  if (Cause.isInterruptedOnly(exit.cause)) {
    log.warn({ requestId }, `Fiber interrupted in ${label}`);
    throw new HTTPException(500, {
      res: Response.json(
        { error: "interrupted", message: `Request to ${label} was interrupted.`, requestId },
        { status: 500 },
      ),
    });
  }

  // ── Defect (unexpected throw) ─────────────────────────────────
  const defects = Arr.fromIterable(Cause.defects(exit.cause));
  const primary = defects.length > 0 ? defects[0] : undefined;
  const errObj = primary instanceof Error ? primary : new Error(String(primary ?? "unknown defect"));

  if (defects.length > 1) {
    log.error(
      {
        err: errObj,
        requestId,
        defectCount: defects.length,
        defects: defects.map((d) => (d instanceof Error ? d.message : String(d))),
      },
      `${defects.length} defects in ${label} (logging primary)`,
    );
  } else {
    log.error({ err: errObj, requestId }, `Defect in ${label}`);
  }

  throw new HTTPException(500, {
    res: Response.json(
      { error: "internal_error", message: `Failed to ${label}.`, requestId },
      { status: 500 },
    ),
  });
}
