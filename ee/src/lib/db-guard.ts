import { Effect } from "effect";
import { hasInternalDB } from "@atlas/api/lib/db/internal";

/**
 * Guard for write-path EE functions — throws when no internal database is available.
 * Standardizes the error message across EE modules that require an internal database.
 *
 * @param label - Human-readable operation name (e.g. "custom role management")
 * @param errorFactory - Optional factory to throw a domain-specific error instead of plain Error
 */
export function requireInternalDB(
  label: string,
  errorFactory?: () => Error,
): void {
  if (!hasInternalDB()) {
    if (errorFactory) throw errorFactory();
    throw new Error(`Internal database required for ${label}.`);
  }
}

/**
 * Effect version of `requireInternalDB`. Fails with a typed error when no
 * internal database is available. Use in EE modules that return Effect.
 */
export const requireInternalDBEffect = (
  label: string,
  errorFactory?: () => Error,
): Effect.Effect<void, Error> =>
  hasInternalDB()
    ? Effect.void
    : Effect.fail(errorFactory?.() ?? new Error(`Internal database required for ${label}.`));
