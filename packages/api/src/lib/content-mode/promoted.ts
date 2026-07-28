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
/**
 * The result of sweeping every adapter's refusals.
 *
 * `total` is the TRUE count; `reported` may be shorter. A struct rather than a
 * bare array precisely so a caller cannot mistake `reported.length` for the
 * number of rows refused — the first cut returned only the array, and the
 * durable audit row immediately began recording the capped length. The SECOND
 * cut kept the array-only wire shape and papered over it with a synthetic
 * "(truncated)" entry, which just moved the same lie to the UI: both renderers
 * counted the list and said "101 drafts were not published" when 250 were.
 *
 * So there is no synthetic entry. Every element of `reported` is a REAL refused
 * row a reader can go look up, and the count lives in its own field.
 */
export interface RefusalSweep {
  /** Real refused rows, capped at {@link MAX_REPORTED_REFUSALS}. For the wire. */
  readonly reported: readonly PublishRefusedDraft[];
  /**
   * Every refused row, uncapped. For the DURABLE audit record, where the
   * payload-size argument behind the cap simply does not apply (it is a jsonb
   * column, not an HTTP response) and "which rows" is the whole point.
   */
  readonly all: readonly PublishRefusedDraft[];
  /** How many rows were ACTUALLY refused, regardless of the cap. */
  readonly total: number;
}

export function collectRefusals(reports: ReadonlyArray<PromotionReport>): RefusalSweep {
  const all = reports.flatMap((report) =>
    (report.refused ?? []).map((refusal) => ({
      id: refusal.rowId,
      surface: report.table,
      reasons: refusal.reasons,
      detail: refusal.detail,
    })),
  );
  if (all.length <= MAX_REPORTED_REFUSALS) return { reported: all, all, total: all.length };

  // Cap the enumerated LIST, never the count and never the promotion. Every
  // refused row is still a draft and still in `draftCounts`; this only bounds
  // how many are spelled out in one JSON response. A buggy extraction fiber can
  // refuse thousands of facts, each carrying a `detail` that interpolates its
  // grant tokens verbatim — unbounded, that is a multi-megabyte payload.
  log.warn(
    { totalRefused: all.length, reported: MAX_REPORTED_REFUSALS },
    "collectRefusals: refusal LIST truncated for the response — the count is unaffected and every refused row is still a draft",
  );
  return { reported: all.slice(0, MAX_REPORTED_REFUSALS), all, total: all.length };
}

/**
 * How many refusals one publish response enumerates. Well above any plausible
 * hand-authored backlog, low enough that a runaway producer cannot turn a
 * publish response into a multi-megabyte payload. The COUNT is never capped.
 */
const MAX_REPORTED_REFUSALS = 100;

/** One row whose grant a publish widened, attributed to the table it came from. */
export interface WidenedGrantRecord {
  readonly surface: string;
  readonly id: string;
  readonly added: readonly [string, ...string[]];
}

/**
 * Every grant any adapter widened this publish (#4823), attributed by surface.
 *
 * Lives beside {@link collectRefusals} and for the same stated reason: BOTH
 * publish surfaces run the identical `runPublishPhases`, so a per-route inline
 * sweep is the exact layout that let MCP report `published: true` over refused
 * drafts. A widening is the more consequential of the two events — it
 * permanently changed who can read a claim, and unlike a refusal nothing
 * re-offers it — so it is the last thing that should be collected twice.
 *
 * Uncapped. Both callers put it in a durable-ish record rather than an HTTP
 * response, so the payload-size argument behind `MAX_REPORTED_REFUSALS` does
 * not apply, and "which rows" is the entire point.
 */
export function collectWidenings(
  reports: ReadonlyArray<PromotionReport>,
): readonly WidenedGrantRecord[] {
  return reports.flatMap((report) =>
    (report.widened ?? []).map((w) => ({
      surface: report.table,
      id: w.rowId,
      added: w.added,
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
