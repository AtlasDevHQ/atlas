/**
 * Combine multiple mutation error slots into a single banner message.
 *
 * Admin pages that run several mutations against the same surface (e.g.
 * residency: assign + migrate + retry + cancel) collapse their errors into
 * one page-level `ErrorBanner`. Using `a.error ?? b.error ?? ...` silently
 * hides any failure past the first — this helper preserves all distinct
 * messages so concurrent failures stay visible.
 */
export function combineMutationErrors(
  errors: ReadonlyArray<string | null | undefined>,
): string | null {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const err of errors) {
    if (typeof err !== "string" || err.length === 0) continue;
    if (seen.has(err)) continue;
    seen.add(err);
    unique.push(err);
  }

  if (unique.length === 0) return null;
  if (unique.length === 1) return unique[0];
  return `${unique[0]} (+${unique.length - 1} more)`;
}
