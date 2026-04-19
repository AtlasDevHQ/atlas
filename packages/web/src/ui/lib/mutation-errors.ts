import type { FetchError } from "@/ui/lib/fetch-error";

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
    if (!err || err.message.length === 0) continue;
    if (seen.has(err.message)) continue;
    seen.add(err.message);
    unique.push(err);
  }

  if (unique.length === 0) return null;
  const primary = unique[0]!;
  if (unique.length === 1) return primary;
  return { ...primary, message: `${primary.message} (+${unique.length - 1} more)` };
}
