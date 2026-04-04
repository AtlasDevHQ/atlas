import { hasInternalDB } from "@atlas/api/lib/db/internal";

/**
 * Guard for write-path EE functions — throws when no internal database is available.
 * Standardizes the error message across all 18 EE modules.
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
