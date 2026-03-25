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

const log = createLogger("effect-bridge");

// ── Error mapping ───────────────────────────────────────────────────

interface HttpErrorMapping {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly message: string;
}

/**
 * Type guard for tagged errors produced by `Data.TaggedError`.
 *
 * Tagged errors always have a `_tag` string discriminant and inherit
 * `message` from Error.
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
 * Map a tagged error to an HTTP status code and response body.
 *
 * Returns null for unknown tags — the caller should treat those as 500s.
 * Status code assignments match existing Hono route behavior.
 */
export function mapTaggedError(error: { readonly _tag: string; readonly message: string }): HttpErrorMapping | null {
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
    case "RateLimitExceededError":
    case "ConcurrencyLimitError":
      return { status: 429, code: "rate_limited", message: error.message };

    // ── 502 Bad Gateway — upstream DB error ──────────────────────
    case "QueryExecutionError":
      return { status: 502, code: "upstream_error", message: error.message };

    // ── 503 Service Unavailable ──────────────────────────────────
    case "PoolExhaustedError":
    case "NoDatasourceError":
      return { status: 503, code: "service_unavailable", message: error.message };

    // ── 504 Gateway Timeout ──────────────────────────────────────
    case "QueryTimeoutError":
    case "ActionTimeoutError":
      return { status: 504, code: "timeout", message: error.message };

    default:
      return null;
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
 * Three failure modes are handled:
 * 1. **Tagged error** (known `_tag`) → mapped HTTP status via `mapTaggedError`
 * 2. **Untagged typed error** → logged and returned as 500
 * 3. **Defect** (unexpected throw / fiber interruption) → logged and returned as 500
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

    if (isTaggedError(error)) {
      const mapped = mapTaggedError(error);
      if (mapped) {
        throw new HTTPException(mapped.status, {
          res: Response.json(
            { error: mapped.code, message: mapped.message, requestId },
            { status: mapped.status },
          ),
        });
      }
    }

    // Unmapped typed error — log context and return 500
    const errObj = error instanceof Error ? error : new Error(String(error));
    log.error({ err: errObj, requestId }, `Unmapped error in ${label}`);
    throw new HTTPException(500, {
      res: Response.json(
        { error: "internal_error", message: `Failed to ${label}.`, requestId },
        { status: 500 },
      ),
    });
  }

  // ── Defect (unexpected throw or fiber interruption) ──────────
  const defects = Arr.fromIterable(Cause.defects(exit.cause));
  const defect = defects.length > 0 ? defects[0] : undefined;
  const errObj = defect instanceof Error ? defect : new Error(String(defect ?? "unknown defect"));
  log.error({ err: errObj, requestId }, `Defect in ${label}`);
  throw new HTTPException(500, {
    res: Response.json(
      { error: "internal_error", message: `Failed to ${label}.`, requestId },
      { status: 500 },
    ),
  });
}
