/**
 * Compliance errors — promoted to core in #2566 so the `MaskingPolicy`
 * and `ComplianceReports` Tags in `lib/effect/services.ts` can type
 * their failure channels without core importing from `@atlas/ee`.
 *
 * EE's `ee/src/compliance/{masking,reports}.ts` re-exports both classes
 * for back-compat. The structural identity (`_tag` + payload shape)
 * means existing `instanceof` checks and `domainError(...)` mappings
 * work unchanged whether the class is loaded from core or via the EE
 * re-export.
 */

import { Data } from "effect";

export type ComplianceErrorCode = "validation" | "not_found" | "conflict";

export class ComplianceError extends Data.TaggedError("ComplianceError")<{
  message: string;
  code: ComplianceErrorCode;
}> {}

export type ReportErrorCode = "validation" | "not_available";

export class ReportError extends Data.TaggedError("ReportError")<{
  message: string;
  code: ReportErrorCode;
}> {}
