/**
 * Workspace-branding error class — promoted to core in #2572 so the
 * `Branding` Tag in `lib/effect/services.ts` can type its failure
 * channel without core importing from `@atlas/ee`.
 *
 * EE's `ee/src/branding/white-label.ts` re-exports for back-compat. The
 * structural identity (`_tag` + payload) means existing `instanceof`
 * checks and `domainError(...)` mappings work unchanged.
 */

import { Data } from "effect";

export type BrandingErrorCode = "validation" | "not_found";

export class BrandingError extends Data.TaggedError("BrandingError")<{
  message: string;
  code: BrandingErrorCode;
}> {}
