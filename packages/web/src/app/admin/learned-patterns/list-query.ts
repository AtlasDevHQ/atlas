/**
 * Request-path builder for the learned-patterns cockpit list fetch.
 *
 * Extracted from `page.tsx` so the sort/filter → query-string threading is unit
 * testable in isolation (the page component is a large client tree). The
 * cockpit's `useServerDataTable` call delegates its `buildPath` here.
 *
 * Sorting: `useServerDataTable` already reads the table's `?sort=` state and
 * hands us the first sort column's TanStack id (`sortId`) + direction
 * (`sortDesc`). `SORT_PARAM_BY_COLUMN` maps that id to the API's WHITELISTED
 * `sort` value — only the four sortable columns appear, so a non-sortable
 * column id (or anything else) yields no `sort` param and the route defaults to
 * newest-first. The route rejects any non-whitelisted `sort` with a 400, so the
 * whitelist is enforced server-side; this map just keeps the client from ever
 * sending one. Keep the values in lockstep with the route's `SORT_COLUMNS` map
 * (packages/api/src/api/routes/admin-learned-patterns.ts).
 */

/**
 * Maps a sortable TanStack column id (from `columns.tsx`) to the API's
 * whitelisted `sort` value. A `Map` (not a plain object) so an unexpected key
 * like `"constructor"` resolves to `undefined` rather than walking the
 * prototype chain.
 */
export const SORT_PARAM_BY_COLUMN = new Map<string, string>([
  ["confidence", "confidence"],
  ["repetitionCount", "repetition"],
  ["avgDurationMs", "latency"],
  ["createdAt", "created"],
]);

/** Page-owned filter state threaded into the list request. */
export interface LearnedPatternsFilters {
  status: string;
  source_entity: string;
  min_confidence: string;
  max_confidence: string;
}

/** The pagination + sort binding `useServerDataTable` passes to `buildPath`. */
export interface LearnedPatternsBinding {
  offset: number;
  perPage: number;
  sortId?: string;
  sortDesc?: boolean;
}

/**
 * Build the `/api/v1/admin/learned-patterns` request path from the table
 * binding + page filters. Only non-empty filters are appended; sort is emitted
 * only for a whitelisted sortable column.
 */
export function buildLearnedPatternsPath(
  binding: LearnedPatternsBinding,
  filters: LearnedPatternsFilters,
): string {
  const qs = new URLSearchParams({
    limit: String(binding.perPage),
    offset: String(binding.offset),
  });
  if (filters.status) qs.set("status", filters.status);
  if (filters.source_entity) qs.set("source_entity", filters.source_entity);
  if (filters.min_confidence) qs.set("min_confidence", filters.min_confidence);
  if (filters.max_confidence) qs.set("max_confidence", filters.max_confidence);

  const sortKey = binding.sortId ? SORT_PARAM_BY_COLUMN.get(binding.sortId) : undefined;
  if (sortKey) {
    qs.set("sort", sortKey);
    qs.set("dir", binding.sortDesc ? "desc" : "asc");
  }

  return `/api/v1/admin/learned-patterns?${qs}`;
}

// ── Confidence display ⇄ wire conversion ──────────────────────────────
// The URL/API carry confidence as a decimal in [0,1]; the cockpit shows it as a
// percentage. These pure converters bridge the two and clamp out-of-range or
// non-numeric input to a safe value (or "" for unset), so the API only ever
// receives a well-formed `min_confidence`/`max_confidence`.

/** Percentage input (0–100) → the API's decimal confidence string (0–1). "" stays "". */
export function pctToConfidence(pct: string): string {
  const trimmed = pct.trim();
  if (trimmed === "") return "";
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return "";
  const clamped = Math.min(100, Math.max(0, n));
  return String(clamped / 100);
}

/** API decimal confidence string (0–1) → percentage string for display. "" stays "". */
export function confidenceToPct(dec: string): string {
  if (dec === "") return "";
  const n = Number(dec);
  if (!Number.isFinite(n)) return "";
  return String(Math.round(n * 100));
}
