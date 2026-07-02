/**
 * Runtime companion to `InferPromotedCounts` — project the registry's
 * `PromotionReport[]` onto the `PublishPromotedCounts` wire shape by iterating
 * the registry tuple, so every consumer of `runPublishPhases` reports every
 * registered surface. Replaces the per-consumer `findReport(...)` fan-outs in
 * `admin-publish.ts` and `datasources/mcp-lifecycle.ts` that each hand-listed
 * the surfaces (and both silently dropped `knowledge_documents` when it
 * registered — the milestone #81 under-report).
 */

import type { ContentModeEntry, PromotionReport } from "./port";
import type { InferPromotedCounts } from "./infer";

/**
 * One promoted count per registered entry, keyed by the entry's wire key
 * (`key` for simple entries, `promotedKey` for exotic adapters), looked up by
 * the entry's physical table name in the reports.
 */
export function promotedCountsFromReports<T extends ReadonlyArray<ContentModeEntry>>(
  entries: T,
  reports: ReadonlyArray<PromotionReport>,
): InferPromotedCounts<T> {
  const out: Record<string, number> = {};
  for (const entry of entries) {
    const physicalTable = entry.kind === "simple" ? (entry.table ?? entry.key) : entry.key;
    const wireKey = entry.kind === "simple" ? entry.key : entry.promotedKey;
    out[wireKey] = reports.find((r) => r.table === physicalTable)?.promoted ?? 0;
  }
  return out as InferPromotedCounts<T>;
}
