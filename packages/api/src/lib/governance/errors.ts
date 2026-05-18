/**
 * Approval-workflow errors — promoted to core in #2567 so the
 * `ApprovalGate` Tag in `lib/effect/services.ts` can type its failure
 * channels without core importing from `@atlas/ee`.
 *
 * EE's `ee/src/governance/approval.ts` re-exports this class for
 * back-compat. The structural identity (`_tag` + payload) means existing
 * `instanceof` checks and `domainError(ApprovalError, ...)` mappings
 * work unchanged whether the class is loaded from core or via the EE
 * re-export.
 */

import { Data } from "effect";

export type ApprovalErrorCode = "validation" | "not_found" | "conflict" | "expired";

export class ApprovalError extends Data.TaggedError("ApprovalError")<{
  message: string;
  code: ApprovalErrorCode;
}> {}
