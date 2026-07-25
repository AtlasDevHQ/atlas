/**
 * Runtime companion to `InferPromotedCounts` — project the registry's
 * `PromotionReport[]` onto the `PublishPromotedCounts` wire shape by iterating
 * the registry tuple, so every consumer of `runPublishPhases` reports every
 * registered surface. Replaces the per-consumer `findReport(...)` fan-outs in
 * `admin-publish.ts` and `datasources/mcp-lifecycle.ts` that each hand-listed
 * the surfaces — the layout that produced the milestone #81 under-report
 * (knowledge documents published but were dropped from `promoted` until
 * #4229 patched both lists by hand).
 */

import type { PublishRefusedDraft } from "@useatlas/types";
import { createLogger } from "@atlas/api/lib/logger";
import type { ContentModeEntry, PromotionReport } from "./port";
import type { InferPromotedCounts } from "./infer";

const log = createLogger("content-mode-promoted");

/**
 * Every refusal any adapter reported, projected onto the shared wire shape
 * (#4769).
 *
 * Swept across ALL reports rather than read off one named table, for the same
 * reason `promotedCountsFromReports` exists: a hand-listed lookup is what let
 * knowledge documents ship under-reported in milestone #81. `brain_facts` is
 * the only adapter that can refuse today; a second one is reported here with no
 * edit, and `surface` keeps it attributable.
 *
 * Lives here — not in a route — because BOTH publish surfaces need it:
 * `admin-publish.ts` (REST) and `publishWorkspaceDrafts` (the MCP lib seam).
 * The first cut computed it inline in the route, which left MCP silently
 * reporting `published: true` over refused drafts.
 */
export function collectRefusals(
  reports: ReadonlyArray<PromotionReport>,
): readonly PublishRefusedDraft[] {
  return reports.flatMap((report) =>
    (report.refused ?? []).map((refusal) => ({
      id: refusal.rowId,
      surface: report.table,
      reasons: refusal.reasons,
      detail: refusal.detail,
    })),
  );
}

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
    const report = reports.find((r) => r.table === physicalTable);
    if (report === undefined) {
      // The real registry emits one report per entry, so a miss means the
      // entry↔report `table` correspondence broke (a rename on one side) —
      // exactly the silent-under-report class this module exists to close.
      // Report 0 (never invent a count) but say so loudly. Mocked registries
      // in tests legitimately emit partial report lists.
      log.error(
        { wireKey, physicalTable },
        "promotedCountsFromReports: no PromotionReport for registered entry — reporting 0",
      );
    }
    out[wireKey] = report?.promoted ?? 0;
  }
  return out as InferPromotedCounts<T>;
}
