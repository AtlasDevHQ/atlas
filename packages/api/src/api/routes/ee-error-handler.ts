/**
 * Shared enterprise error → HTTPException mapper for admin routes.
 *
 * Replaces the per-file throwIf*Error helpers that each duplicated the same
 * pattern: EnterpriseError → 403, domain error → status-mapped code.
 */

import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { EnterpriseError } from "@atlas/ee/index";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- constructor signatures vary across EE error classes
type DomainErrorClass = new (...args: any[]) => Error & { code: string };

/**
 * Rethrow known enterprise/domain errors as HTTPExceptions.
 * Call in catch blocks. Unknown errors fall through.
 *
 * EnterpriseError always maps to 403. Domain errors map to the status
 * specified in their statusMap, falling back to 400 for unmapped codes.
 *
 * @example
 * ```ts
 * throwIfEEError(err, [ApprovalError, { validation: 400, not_found: 404 }]);
 * ```
 *
 * @example Multiple domain errors (compliance has both ComplianceError and ReportError):
 * ```ts
 * throwIfEEError(err, [ComplianceError, COMPLIANCE_STATUS], [ReportError, REPORT_STATUS]);
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
