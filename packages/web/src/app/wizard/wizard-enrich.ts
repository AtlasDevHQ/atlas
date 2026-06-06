/**
 * Pure helpers for the wizard's two-phase generate flow (issue #3236,
 * docs/design/semantic-onboarding.md § D).
 *
 * Phase 1 (mechanical baseline) is produced by `/wizard/generate`. Phase 2
 * (enrichment) is an explicit, cost-gated, per-table LLM upgrade. These helpers
 * are deliberately UI- and fetch-free so the gating/partitioning/streaming
 * logic is unit-testable without a React render or a network mock.
 */

import type { WizardEntityResult } from "@/ui/lib/types";

/**
 * Per-row enrichment status surfaced in the review list. `unchanged` = the model
 * ran but returned nothing usable, so the row kept its mechanical baseline (we
 * must not badge it "enriched" — issue #3236 review).
 */
export type EnrichRowStatus = "idle" | "enriching" | "enriched" | "unchanged" | "error";

/** How many tables enrich concurrently — bounded so a big "Enrich all" doesn't
 * fan out an unbounded burst of LLM + DB-profiling requests. */
export const ENRICH_CONCURRENCY = 4;

/**
 * Seed the ignore list from the profiler's `possibly_abandoned` signal (§ D):
 * dead/legacy/junction/cache tables the profiler already flagged, so the user
 * *confirms* the exclusions rather than hunting for them. Returns the table
 * names to pre-ignore.
 */
export function seedIgnoredTables(entities: readonly WizardEntityResult[]): string[] {
  return entities
    .filter((e) => e.profile.flags.possiblyAbandoned)
    .map((e) => e.tableName);
}

/**
 * Tables eligible for enrichment / save: every generated table minus the
 * ignored set. "Enrich all" enriches exactly these, and the ignored tables are
 * also excluded from the final save (acceptance criteria C3/C4 — "ignored
 * tables are excluded and not enriched").
 */
export function enrichableTables(
  entities: readonly WizardEntityResult[],
  ignored: ReadonlySet<string>,
): string[] {
  return entities.filter((e) => !ignored.has(e.tableName)).map((e) => e.tableName);
}

/**
 * Filter a chosen set of table names down to those still enrichable — i.e. drop
 * any that have since been ignored. Used by "Enrich selected" so an ignored row
 * never sneaks into the batch even if it was checked earlier.
 */
export function excludeIgnored(
  names: readonly string[],
  ignored: ReadonlySet<string>,
): string[] {
  return names.filter((n) => !ignored.has(n));
}

/**
 * Run `task` over `items` with bounded concurrency, invoking `onSettled` as each
 * item finishes (success OR failure). This is what makes enrichment "stream in
 * per table, upgrading each row in place" (§ D) without a streaming wire
 * protocol: every settled item updates its row immediately. Each item is
 * independent — one failure never blocks the others, so partial completion is
 * always safe.
 *
 * `task` rejections are caught and surfaced via `onSettled(item, undefined, err)`
 * so a single thrown task can't abort the whole batch.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
  onSettled: (item: T, result: R | undefined, error: unknown) => void,
): Promise<void> {
  if (items.length === 0) return;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) return;
      const item = items[i];
      try {
        const result = await task(item);
        onSettled(item, result, undefined);
      } catch (error) {
        onSettled(item, undefined, error);
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}
