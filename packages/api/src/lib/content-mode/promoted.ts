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
 * Lives here — not in a route — because more than one publish surface needs it:
 * `admin-publish.ts` (REST) and `publishWorkspaceDrafts` (the MCP lib seam).
 * The first cut computed it inline in the route, which left MCP silently
 * reporting `published: true` over refused drafts.
 *
 * NOT swept by every publish surface: `knowledge/ingest-bundle.ts`'s "upload &
 * publish" runs the same phases and sweeps only the supersessions (#4937 wired
 * that one alone, the deliberate scope — a dropped refusal under-reports a
 * draft that is still pending and still re-offered, whereas a dropped
 * supersession retires a belief with nothing recording what replaced it). So
 * an upload & publish that refuses a draft leaves only the adapter's own
 * `log.warn` — uncapped, so nothing is lost, but no durable record and nothing
 * in the HTTP response.
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
 * Lives beside {@link collectRefusals} and for the same stated reason: every
 * publish surface runs the identical `runPublishPhases`, so a per-route inline
 * sweep is the exact layout that let MCP report `published: true` over refused
 * drafts. A widening is the more consequential of the two events — it
 * permanently changed who can read a claim, and unlike a refusal nothing
 * re-offers it — so it is the last thing that should be collected twice.
 *
 * Swept by the same two surfaces as {@link collectRefusals}, and with a sharper
 * version of the same gap: `knowledge/ingest-bundle.ts` runs the phases without
 * sweeping this, so on that path a widening survives only as the adapter's INFO
 * line — which is SAMPLED at `LOGGED_ID_SAMPLE_CAP` (20) ids, because the
 * complete list is exactly what rides `PromotionReport.widened`, and that is
 * what this path discards. A publish widening more than 20 grants loses ids for
 * good there. Unlike the refusal case, this one TRUNCATES rather than merely
 * failing to persist.
 *
 * Uncapped. Its callers put it in a durable-ish record rather than an HTTP
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

/** One promoted row that superseded published rows, attributed to its table. */
export interface SupersessionRecord {
  readonly surface: string;
  /** The newly-promoted row. */
  readonly id: string;
  /** The published rows whose `valid_to` this promotion stamped. */
  readonly superseded: readonly [string, ...string[]];
}

/**
 * Every supersession any adapter performed this publish (#4912), attributed by
 * surface.
 *
 * Lives beside {@link collectWidenings} and for the same stated reason: EVERY
 * caller of `runPublishPhases` runs the identical phases, and a supersession
 * recorded by one seam and dropped by another is a difference nothing would
 * keep in sync. Like a widening it is permanent from the promoted side —
 * nothing re-offers it — and it is MORE consequential for readers: the
 * superseded fact stops answering as-of-now reads the moment the transaction
 * commits, so "why did the agent stop saying X?" is answered by this record.
 *
 * The caller list is deliberately NOT enumerated here — a count in this comment
 * is what went stale when `knowledge/ingest-bundle.ts` became the third publish
 * surface and silently dropped its reports (#4937). `content-mode/__tests__/
 * publish-caller-supersession-wiring.test.ts` DISCOVERS the callers and pins
 * that each one sweeps through this helper; read it for the live list.
 *
 * Uncapped, for {@link collectWidenings}' reason: callers put it in a
 * durable-ish record rather than an HTTP response.
 */
export function collectSupersessions(
  reports: ReadonlyArray<PromotionReport>,
): readonly SupersessionRecord[] {
  return reports.flatMap((report) =>
    (report.superseded ?? []).map((s) => ({
      surface: report.table,
      id: s.rowId,
      superseded: s.superseded,
    })),
  );
}

/**
 * Total supersessions DECLINED on trust-tier grounds across every adapter
 * (#5033) — {@link collectSupersessions}'s complement.
 *
 * A number rather than records, because that is what the reports carry and why:
 * a held-back pair left BOTH claims live and separately addressable through the
 * fact's `in-tension-with` cluster, where a performed supersession hid one of
 * them. What the total
 * buys the audit row is the distinction an empty `supersededFacts` cannot make
 * — "nothing collided" versus "a collision was proven and its consequence
 * withheld".
 *
 * Swept with the same shape as its sibling so a second adapter growing a tier
 * guard is picked up here rather than at a call site — today only `brain_facts`
 * reports the field.
 *
 * @returns the total, or `null` when ANY reporting adapter could not compute
 * its own count — see the loop for why that is not summed as 0.
 */
export function countSupersessionsHeldBack(
  reports: ReadonlyArray<PromotionReport>,
): number | null {
  let total = 0;
  for (const report of reports) {
    const held = report.supersessionHeldBack;
    // `null` — an adapter that could not compute its count — POISONS the total
    // rather than contributing 0. A sum that silently dropped it would report a
    // confident workspace-wide number built from a partial answer, which is the
    // failure the per-adapter `null` exists to prevent, re-introduced by the
    // sweep. `undefined` is different and contributes nothing: that adapter has
    // no supersession concept, so there was never anything to count.
    if (held === null) return null;
    total += held ?? 0;
  }
  return total;
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
