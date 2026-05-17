/**
 * Residency error class — promoted to core in #2564 so the
 * `ResidencyResolver` Tag in `lib/effect/services.ts` can expose typed
 * failure channels without core code needing to import from `@atlas/ee`.
 *
 * EE's `ee/src/platform/residency.ts` re-exports this same class for
 * back-compat. The structural identity (`_tag === "ResidencyError"` +
 * `{ message, code }` payload) means existing `instanceof` checks and
 * `domainError(ResidencyError, ...)` mappings work unchanged whether the
 * class is loaded from core or via the EE re-export.
 */

import { Data } from "effect";

export type ResidencyErrorCode =
  | "not_configured"
  | "invalid_region"
  | "already_assigned"
  | "workspace_not_found"
  | "no_internal_db";

export class ResidencyError extends Data.TaggedError("ResidencyError")<{
  message: string;
  code: ResidencyErrorCode;
}> {}
