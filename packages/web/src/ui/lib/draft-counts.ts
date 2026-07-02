import type { ModeDraftCounts } from "@useatlas/types/mode";

/**
 * Deploy-overlap-safe total across every draft-count segment.
 *
 * `ModeDraftCounts` fields are required in the current wire type, but during a
 * web-before-API deploy-overlap window an older API omits a newer segment
 * (e.g. `knowledgeDocuments`, added v0.0.41) — and `useModeStatus` casts the
 * JSON without a Zod parse, so the missing field reaches the sum. An unguarded
 * per-field sum then poisons the total to NaN, which defeats the `=== 0`
 * hide-guards and the singular/plural logic: the pill renders a visible
 * "NaN pending" badge (and aria-label) while the count is garbage. Summing
 * whatever numeric values are present keeps the total meaningful for whatever
 * the API sent, with no hand-maintained field list to forget when the next
 * segment lands.
 */
export function totalDraftCount(counts: ModeDraftCounts): number {
  return Object.values(counts).reduce<number>(
    (sum, v) => sum + (typeof v === "number" && Number.isFinite(v) ? v : 0),
    0,
  );
}
