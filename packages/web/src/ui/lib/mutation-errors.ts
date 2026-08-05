import { isPlaceholderMessage, type FetchError } from "@/ui/lib/fetch-error";

/**
 * Combine multiple mutation error slots into a single banner entry.
 *
 * Admin pages that run several mutations against the same surface (e.g.
 * residency: assign + migrate + retry + cancel) collapse their errors into
 * one page-level `ErrorBanner`. Using `a.error ?? b.error ?? ...` silently
 * hides any failure past the first — this helper preserves all distinct
 * messages so concurrent failures stay visible.
 *
 * Returns a {@link FetchError} so the structured fields (`status`, `code`,
 * `requestId`) from the first distinct error flow through to
 * `AdminContentWrapper` — without them the 403-to-EnterpriseUpsell branch
 * and request-ID surfacing would break for multi-mutation pages.
 */
export function combineMutationErrors(
  errors: ReadonlyArray<FetchError | null | undefined>,
): FetchError | null {
  const seen = new Set<string>();
  const unique: FetchError[] = [];
  for (const err of errors) {
    // Trimmed, to match every other blank guard on this path (`serverMessage`,
    // `FeatureGate`, `GateRequestId`). A whitespace-only message that became
    // primary rendered a gate description of "(+1 more)" — icon and headline
    // over a parenthetical.
    if (!err || err.message.trim().length === 0) continue;
    if (seen.has(err.message.trim())) continue;
    seen.add(err.message.trim());
    unique.push(err);
  }

  if (unique.length === 0) return null;
  const primary = unique[0]!;
  if (unique.length === 1) return primary;
  // A placeholder is returned UNDECORATED — not re-worded, not suffixed.
  //
  // Any transform of `message` destroys its provenance, because provenance is
  // recovered by string-comparing against the two spellings this module mints
  // (`serverMessage`). `"HTTP 403"` suffixed to `"HTTP 403 (+1 more)"` matches
  // neither, so every downstream surface takes it for the server's own words —
  // and since #5068 the gated placeholders render exactly that as their only
  // line of copy. Re-wording it to `"Request failed (+1 more)"` first does not
  // help: that is equally unrecognized, and it replaces the enterprise upsell's
  // "Upgrade your plan or contact sales…" with a sentence carrying strictly
  // less than the canned copy it displaced. The count is cosmetic; the correct
  // diagnosis is not.
  //
  // `isPlaceholderMessage`, not `serverMessage`: a message with no status is
  // client-authored ("Network error") and decorates fine, but `serverMessage`
  // would discard it.
  if (isPlaceholderMessage(primary)) return primary;
  return { ...primary, message: `${primary.message} (+${unique.length - 1} more)` };
}
