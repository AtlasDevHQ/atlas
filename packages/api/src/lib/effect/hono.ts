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

import { Array as Arr, Effect, Exit, Cause, Option, Layer } from "effect";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createLogger } from "@atlas/api/lib/logger";
import { ATLAS_ERROR_TAG_LIST, type AtlasError } from "./errors";
import {
  RequestContext,
  makeRequestContextLayer,
  AuthContext,
  makeAuthContextLayer,
} from "./services";

// ── Domain error mapping ────────────────────────────────────────────

/**
 * A domain error class → HTTP status code mapping pair.
 *
 * Always construct via `domainError()` — raw tuples bypass the compile-time
 * exhaustive code check. The brand prevents direct tuple construction.
 *
 * Used by `runEffect` to convert EE domain errors into proper HTTP responses.
 * Domain errors surface either as typed failures (from Effect programs) or as
 * defects (from `Effect.tryPromise` in `runHandler`).
 */
declare const DomainErrorMappingBrand: unique symbol;
export type DomainErrorMapping = [
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- constructor signatures vary across EE error classes; { code: string } ensures the statusMap lookup is valid
  errorClass: new (...args: any[]) => Error & { code: string },
  statusMap: Record<string, ContentfulStatusCode>,
] & { readonly [DomainErrorMappingBrand]: true };

/**
 * Type-safe constructor for `DomainErrorMapping` tuples.
 *
 * Infers `TCode` from the error class's `code` property and requires the
 * status map to cover every code — the compiler will error if a code is
 * added to the error class's union without a corresponding entry here.
 *
 * @example
 * ```ts
 * // ApprovalErrorCode = "validation" | "not_found" | "conflict" | "expired"
 * const approvalErrors = domainError(ApprovalError, {
 *   validation: 400, not_found: 404, conflict: 409, expired: 410,
 * });
 * // Missing "expired" would be a compile error ↑
 * ```
 */
export function domainError<TCode extends string>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- must accept varied constructor signatures; TCode constraint ensures the statusMap is exhaustive
  errorClass: new (...args: any[]) => Error & { code: TCode },
  statusMap: Record<TCode, ContentfulStatusCode>,
): DomainErrorMapping {
  return [errorClass, statusMap] as unknown as DomainErrorMapping;
}

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
 * Derived from the compile-time verified `ATLAS_ERROR_TAG_LIST` in errors.ts —
 * adding a new error variant without updating the list causes a type error.
 */
const ATLAS_ERROR_TAGS: ReadonlySet<string> = new Set(ATLAS_ERROR_TAG_LIST);

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

// ── Common error classification ─────────────────────────────────────

/**
 * Check if an error is an EnterpriseError (from @atlas/ee).
 *
 * Uses duck-typing (`name === "EnterpriseError"` + string `code`) to avoid a
 * hard import of `@atlas/ee` in the bridge module. The actual `code` value is
 * read from the error and used in the HTTP response, so future code additions
 * (e.g. `"license_expired"`) are forward-compatible.
 *
 * Coupling: ee/src/index.ts `EnterpriseError` sets `this.name = "EnterpriseError"`.
 * If that class is renamed, this guard silently stops matching — a cross-package
 * test in hono.test.ts verifies the coupling.
 */
function isEnterpriseError(err: unknown): err is Error & { code: string } {
  return (
    err instanceof Error &&
    err.name === "EnterpriseError" &&
    "code" in err &&
    typeof (err as Record<string, unknown>).code === "string"
  );
}

/**
 * Try to map an error to an HTTPException using the shared vocabulary:
 * HTTPException passthrough → EnterpriseError → domain error mappings → AtlasError.
 *
 * Returns the HTTPException to throw, or `undefined` if the error is unrecognized.
 */
function classifyError(
  error: unknown,
  requestId: string,
  domainErrors?: DomainErrorMapping[],
): HTTPException | undefined {
  // 1. HTTPException — re-throw unchanged (framework validation, auth failures)
  if (error instanceof HTTPException) return error;

  // 2. EnterpriseError → 403
  if (isEnterpriseError(error)) {
    return new HTTPException(403, {
      res: Response.json(
        { error: error.code, message: error.message, requestId },
        { status: 403 },
      ),
    });
  }

  // 3. Domain error mappings (EE module errors with { code } property)
  if (domainErrors) {
    for (const [errorClass, statusMap] of domainErrors) {
      if (error instanceof errorClass) {
        const code = error.code;
        if (statusMap[code] === undefined) {
          log.error({ err: error, code, requestId }, `Unmapped domain error code "${code}" for ${errorClass.name}, defaulting to 500`);
        }
        const status = (statusMap[code] ?? 500) as ContentfulStatusCode;
        // Sanitize messages for 5xx domain errors — they may contain infrastructure
        // details (Railway URLs, project IDs, internal hostnames) that should not
        // be exposed to clients. 4xx errors are user-facing and pass through.
        if (status >= 500) {
          log.error({ err: error, code, requestId }, `Infrastructure domain error (${errorClass.name})`);
        }
        const message = status >= 500
          ? `Service error (ref: ${requestId.slice(0, 8)})`
          : error.message;
        return new HTTPException(status, {
          res: Response.json(
            { error: code, message, requestId },
            { status },
          ),
        });
      }
    }
  }

  // 4. Known Atlas tagged error → mapped HTTP status
  if (isTaggedError(error) && isAtlasError(error)) {
    const mapped = mapTaggedError(error);
    return new HTTPException(mapped.status, {
      res: Response.json(
        { error: mapped.code, message: mapped.message, requestId },
        { status: mapped.status, headers: mapped.headers },
      ),
    });
  }

  return undefined;
}

// ── Bridge ──────────────────────────────────────────────────────────

export interface RunEffectOptions {
  /** Human-readable action label for error messages and logs. */
  label?: string;
  /** Domain error class → HTTP status code mappings for EE module errors. */
  domainErrors?: DomainErrorMapping[];
}

/**
 * Run an Effect program inside a Hono route handler.
 *
 * On success, returns the program's value so the handler can build its
 * own response.  On failure, throws an `HTTPException` with a JSON body
 * containing `{ error, message, requestId }` — Hono's error handler
 * returns this to the client.
 *
 * Five failure modes are handled (in priority order):
 * 1. **HTTPException** → re-thrown unchanged (framework validation, auth)
 * 2. **EnterpriseError** → 403 (EE feature gate)
 * 3. **Domain error** → mapped via `domainErrors` option (EE module errors)
 * 4. **Known tagged error** (Atlas `_tag`) → mapped HTTP status via `mapTaggedError`
 * 5. **Unmapped / defect** → logged + 500 with requestId
 *
 * Also handles fiber interruption (→ 500).
 *
 * @param c - Hono context (used for `requestId` extraction)
 * @param program - Fully-provided Effect program (`R = never`)
 * @param options - Label and optional domain error mappings
 */
export async function runEffect<A, E>(
  c: Context,
  program: Effect.Effect<A, E, RequestContext | AuthContext> | Effect.Effect<A, E, never>,
  options?: RunEffectOptions,
): Promise<A> {
  // Provide Hono context as Effect Context layers (same bridge as runHandler)
  const contextLayer = buildContextLayer(c);
  const provided = contextLayer
    ? (program as Effect.Effect<A, E, RequestContext | AuthContext>).pipe(Effect.provide(contextLayer))
    : program as Effect.Effect<A, E, never>;

  const exit = await Effect.runPromiseExit(provided);

  if (Exit.isSuccess(exit)) {
    return exit.value;
  }

  const requestId = (c.get("requestId") as string | undefined) ?? "unknown";
  const label = options?.label ?? "process request";

  // ── Expected failure (typed error in the E channel) ──────────
  const failureOpt = Cause.failureOption(exit.cause);

  if (Option.isSome(failureOpt)) {
    const error = failureOpt.value;

    // Try shared error classification (HTTPException, EnterpriseError, domain, Atlas)
    const classified = classifyError(error, requestId, options?.domainErrors);
    if (classified) throw classified;

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

  // Try shared classification on the primary defect — domain errors thrown
  // inside Effect.tryPromise surface as defects, not typed failures.
  if (primary !== undefined) {
    const classified = classifyError(primary, requestId, options?.domainErrors);
    if (classified) throw classified;
  }

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

// ── Context bridge ───────────────────────────────────────────────────

/**
 * Build a Layer that bridges Hono request context → Effect Context.
 *
 * Reads `requestId`, `atlasMode`, and `authResult` from `c.get()` and provides
 * `RequestContext` + `AuthContext` as Effect services. This allows
 * Effect programs to `yield* RequestContext` or `yield* AuthContext`
 * instead of relying on runtime `c.get()` calls.
 *
 * Returns undefined if no request context is available (e.g. before middleware runs).
 */
function buildContextLayer(
  c: Context,
): Layer.Layer<RequestContext | AuthContext> | undefined {
  const requestId = (c.get("requestId") as string | undefined);
  if (!requestId) return undefined;

  // Read resolved mode set by auth middleware (defaults to "published" if not set)
  const atlasMode = (c.get("atlasMode") as import("@useatlas/types/auth").AtlasMode | undefined) ?? "published";

  const requestLayer = makeRequestContextLayer(requestId, undefined, atlasMode);

  // authResult may not be set (e.g. public routes, before auth middleware)
  const authResult = c.get("authResult") as
    | { authenticated: true; mode: string; user?: { activeOrganizationId?: string } & Record<string, unknown> }
    | undefined;

  if (authResult) {
    const authLayer = makeAuthContextLayer(
      authResult.mode as import("@useatlas/types/auth").AuthMode,
      authResult.user as import("@useatlas/types/auth").AtlasUser | undefined,
    );
    return Layer.merge(requestLayer, authLayer);
  }

  // No auth — provide RequestContext with a fallback AuthContext (mode: "none",
  // no user) so programs that yield* AuthContext always get a valid service
  // rather than a cryptic "service not found" at runtime.
  const noAuthLayer = makeAuthContextLayer("none", undefined);
  return Layer.merge(requestLayer, noAuthLayer);
}

// ── Convenience wrapper ─────────────────────────────────────────────

/**
 * Run an async handler inside the Effect bridge.
 *
 * Convenience wrapper around `runEffect` + `Effect.tryPromise` for route handlers
 * that haven't been converted to full Effect programs yet. The handler body stays
 * as async/await — thrown errors are caught and classified by `runEffect`.
 *
 * Automatically bridges Hono request context → Effect Context so that any
 * Effect programs called transitively can access `RequestContext` and `AuthContext`.
 *
 * @example
 * ```ts
 * router.openapi(route, async (c) => runHandler(c, "list users", async () => {
 *   const users = await listUsers();
 *   return c.json({ users }, 200);
 * }));
 * ```
 */
export function runHandler<T>(
  c: Context,
  label: string,
  handler: () => Promise<T>,
  options?: Pick<RunEffectOptions, "domainErrors">,
): Promise<T> {
  const program = Effect.tryPromise({
    try: handler,
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  });

  // Provide Hono context as Effect Context layers
  const contextLayer = buildContextLayer(c);
  const provided = contextLayer
    ? program.pipe(Effect.provide(contextLayer))
    : program;

  return runEffect(c, provided, { label, domainErrors: options?.domainErrors });
}
