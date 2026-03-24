/**
 * Shared enterprise error → HTTPException mapper for admin routes.
 *
 * Replaces the per-file throwIf*Error helpers that each duplicated the same
 * pattern: EnterpriseError → 403, domain error → status-mapped code.
 * New admin routes should use throwIfEEError and eeOnError from this module
 * rather than creating local error-mapping helpers.
 */

import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { EnterpriseError } from "@atlas/ee/index";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- constructor signatures vary across EE error classes; { code: string } ensures the statusMap lookup is valid
type DomainErrorClass = new (...args: any[]) => Error & { code: string };

/**
 * Rethrow known enterprise/domain errors as HTTPExceptions.
 * Call in catch blocks. Unknown errors fall through.
 *
 * EnterpriseError always maps to 403. Domain errors map to the status
 * specified in their statusMap. If a code is missing from the map (all codes
 * should be mapped), defaults to 400 as a safety net.
 *
 * @throws {HTTPException} When err is an EnterpriseError or matched domain error.
 *
 * @example
 * ```ts
 * throwIfEEError(err, [ApprovalError, APPROVAL_ERROR_STATUS]);
 * ```
 *
 * @example Multiple domain errors (compliance has both ComplianceError and ReportError):
 * ```ts
 * throwIfEEError(err, [ComplianceError, COMPLIANCE_ERROR_STATUS], [ReportError, REPORT_ERROR_STATUS]);
 * ```
 */
export function throwIfEEError(
  err: unknown,
  ...mappings: Array<[errorClass: DomainErrorClass, statusMap: Record<string, number>]>
): void {
  if (err instanceof EnterpriseError) {
    throw new HTTPException(403, {
      res: Response.json(
        { error: "enterprise_required", message: err.message },
        { status: 403 },
      ),
    });
  }
  for (const [errorClass, statusMap] of mappings) {
    if (err instanceof errorClass) {
      if (statusMap[err.code] === undefined) {
        console.warn(`[ee-error-handler] Unmapped error code "${err.code}" for ${errorClass.name}, defaulting to 400`);
      }
      const status = (statusMap[err.code] ?? 400) as ContentfulStatusCode;
      throw new HTTPException(status, {
        res: Response.json(
          { error: err.code, message: err.message },
          { status },
        ),
      });
    }
  }
}

/**
 * Shared Hono onError handler for admin routes.
 *
 * Surfaces HTTPExceptions thrown by throwIfEEError (or framework validation)
 * as JSON responses. Unhandled errors re-throw to Hono's default handler.
 */
export function eeOnError(err: Error, c: Context): Response {
  if (err instanceof HTTPException) {
    if (err.res) return err.res;
    if (err.status === 400) {
      return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400);
    }
  }
  throw err;
}
