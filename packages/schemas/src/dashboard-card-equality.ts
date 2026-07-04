/**
 * Shared dashboard card-equality (#4325 — publish-diff SSOT).
 *
 * ONE definition of "are these two cards the same?" consumed by BOTH sides of
 * the publish path so the diff the user reviews is exactly the change the
 * server merges:
 *
 *   - the CLIENT publish-diff (`packages/web/.../dashboard-diff.ts`) decides
 *     which cards are `changed` and whether Publish is enabled;
 *   - the SERVER merge (`@atlas/api/lib/dashboard-versioning`) decides which
 *     cards get an `updateCard` op vs. a no-op.
 *
 * Before #4325 the client compared only `chartConfig.type` and never
 * `position`, so a thresholds/colours edit or a pure reorder read as "no
 * change" — Publish went disabled on a real edit, or the modal never showed a
 * change the server DID apply. Extracting this equality and using it on both
 * sides closes that gap.
 *
 * It lives in `@useatlas/schemas` (not `@useatlas/types`) because schemas is
 * source-bundled into the scaffold while types is registry-installed — a new
 * value export in types would trip the publish-symbol gate before release
 * (same rationale as the `dashboardParameterTypeSchema` enum next door).
 *
 * The function takes a STRUCTURAL input so both the web wire `DashboardCard`
 * and the server `DashboardSnapshotCard` satisfy it without a conversion step:
 * `content`/`annotations` are optional so a pre-#3138 / pre-#3209 draft JSONB
 * (which omits those keys) compares identically to a freshly-forked card.
 */

import type {
  DashboardChartConfig,
  DashboardCardAnnotation,
  DashboardCardLayout,
} from "@useatlas/types";

/**
 * The minimal card slice that determines identity for publish. Both the web
 * `DashboardCard` and the server `DashboardSnapshotCard` are assignable to it.
 * Deliberately excludes cache fields (`cachedRows`/`cachedAt`), timestamps, and
 * ids — those never make a card "different" for publish purposes.
 */
export interface DashboardCardEqualityInput {
  title: string;
  position: number;
  sql: string;
  chartConfig: DashboardChartConfig | null;
  /** Absent/undefined ≡ null ≡ a chart card (kind is derived from presence). */
  content?: string | null;
  /** Absent/undefined ≡ `[]` — a card with no event markers. */
  annotations?: DashboardCardAnnotation[];
  connectionGroupId: string | null;
  layout: DashboardCardLayout | null;
}

/** Structural deep-equality for the small JSON blobs (layout / chartConfig /
 *  annotations). `null`/`undefined` normalize equal; otherwise stringify. */
function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Whether two cards are equal for publish purposes. Covers the FULL
 * `chartConfig` (not just `type`) and `position` — the two fields the client
 * diff historically missed.
 *
 * A card's kind is derived from `content` presence (#3138): a text card's
 * identity is its markdown; a chart card's is its `sql` + viz config +
 * annotations. A chart↔text flip is never equal.
 */
export function dashboardCardsEqual(
  a: DashboardCardEqualityInput,
  b: DashboardCardEqualityInput,
): boolean {
  if (a.title !== b.title) return false;
  if (a.position !== b.position) return false;
  if ((a.connectionGroupId ?? null) !== (b.connectionGroupId ?? null)) return false;
  if (!jsonEquals(a.layout, b.layout)) return false;

  const aText = a.content != null;
  const bText = b.content != null;
  if (aText !== bText) return false;
  if (aText) {
    if (a.content !== b.content) return false;
  } else {
    if (a.sql !== b.sql) return false;
    if (!jsonEquals(a.chartConfig, b.chartConfig)) return false;
    // #3209 — annotations are part of a chart card's identity. Normalize the
    // absent value to `[]` so a pre-#3209 draft doesn't read as different.
    if (!jsonEquals(a.annotations ?? [], b.annotations ?? [])) return false;
  }
  return true;
}
