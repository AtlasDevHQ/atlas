/**
 * Route handler error wrapper for consistent 500 responses.
 *
 * Eliminates the 6-8 line try-catch boilerplate repeated across route
 * handlers. Each wrapped handler gets: type-narrowed error logging, requestId
 * inclusion, and a consistent JSON 500 response.
 *
 * Domain errors (EnterpriseError, typed EE errors) are re-thrown as
 * HTTPExceptions via throwIfEEError so eeOnError can surface them with the
 * correct status codes. HTTPExceptions from framework validation are also
 * re-thrown untouched.
 *
 * @example Simple handler (most common):
 * ```ts
 * router.openapi(route, withErrorHandler("list organizations", async (c) => {
 *   const orgs = await listOrgs();
 *   return c.json({ items: orgs }, 200);
 * }));
 * ```
 *
 * @example Handler with enterprise domain error mappings:
 * ```ts
 * router.openapi(route, withErrorHandler("create rule", async (c) => {
 *   const rule = await createApprovalRule(orgId, body);
 *   return c.json({ rule }, 201);
 * }, [ApprovalError, APPROVAL_ERROR_STATUS]));
 * ```
 */

import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createLogger } from "@atlas/api/lib/logger";
import { throwIfEEError } from "../../api/routes/ee-error-handler";

const log = createLogger("route-error-handler");

/**
 * A domain error class → HTTP status code mapping pair.
 * Passed to throwIfEEError to convert known domain errors into HTTPExceptions.
 *
 * Single source of truth — also used by throwIfEEError in ee-error-handler.ts.
 */
export type DomainErrorMapping = [
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- constructor signatures vary across EE error classes; { code: string } ensures the statusMap lookup is valid
  errorClass: new (...args: any[]) => Error & { code: string },
  statusMap: Record<string, ContentfulStatusCode>,
];

/**
 * Wrap a Hono route handler with consistent error handling.
 *
 * - Catches unexpected errors and returns a structured 500 response
 * - Re-throws HTTPExceptions (framework validation, throwIfEEError output)
 * - Optionally maps domain errors to HTTPExceptions via throwIfEEError
 * - Always includes requestId in the error response and log
 *
 * @param label - Human-readable action label (e.g., "list organizations").
 *   Used in both the log message and the 500 response body.
 * @param handler - The original route handler function.
 * @param domainErrors - Optional domain error class → status code mappings
 *   passed to throwIfEEError (e.g., `[ApprovalError, APPROVAL_ERROR_STATUS]`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic HOF must use `any` to preserve the caller's exact handler type for Hono's OpenAPI type inference
export function withErrorHandler<H extends (c: any) => any>(
  label: string,
  handler: H,
  ...domainErrors: DomainErrorMapping[]
): H {
  return ((async (c: Parameters<H>[0]) => {
    try {
      return await handler(c);
    } catch (err) {
      // Re-throw HTTPExceptions — handled by eeOnError or Hono's default handler.
      // This covers: framework validation errors, throwIfEEError output called
      // within the handler, and adminAuthAndContext auth failures.
      if (err instanceof HTTPException) throw err;

      // Map known enterprise/domain errors to HTTPExceptions.
      // throwIfEEError always checks EnterpriseError (→ 403) first, then each
      // provided mapping. If the error matches, it throws an HTTPException
      // which propagates to the router's onError handler (eeOnError).
      // Called unconditionally so EnterpriseError is always surfaced as 403,
      // even for handlers that don't provide domain error mappings.
      throwIfEEError(err, ...domainErrors);

      // Unexpected error — log and return 500
      const error = err instanceof Error ? err : new Error(String(err));
      const requestId = (c.get("requestId") as string | undefined) ?? "unknown";
      log.error({ err: error, requestId }, `Failed to ${label}`);
      return c.json(
        { error: "internal_error", message: `Failed to ${label}.`, requestId },
        500,
      );
    }
  }) as unknown) as H;
}
