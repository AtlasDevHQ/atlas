/**
 * Model-routing errors — promoted to core in #2565 so the
 * `ModelRouter` Tag in `lib/effect/services.ts` can type its failure
 * channels without core code importing from `@atlas/ee`.
 *
 * EE's `ee/src/platform/model-routing.ts` re-exports both classes for
 * back-compat. The structural identity (`_tag` + payload shape) means
 * existing `instanceof` checks and `domainError(...)` mappings work
 * unchanged whether the class is loaded from core or via the EE
 * re-export.
 */

import { Data } from "effect";

export type ModelConfigErrorCode = "validation" | "not_found" | "test_failed";

export class ModelConfigError extends Data.TaggedError("ModelConfigError")<{
  message: string;
  code: ModelConfigErrorCode;
}> {}

/**
 * Raised when an encrypted API key cannot be decrypted (typically a key-
 * rotation drift between `ATLAS_ENCRYPTION_KEYS` and the row's
 * `api_key_key_version`). The agent loop must surface this to the user
 * — silently falling back to the platform default would bill the
 * platform without consent.
 */
export class ModelConfigDecryptError extends Data.TaggedError("ModelConfigDecryptError")<{
  configId: string;
  cause: string;
}> {}
