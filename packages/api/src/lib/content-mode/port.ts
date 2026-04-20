/**
 * Port types for the content-mode registry (#1515).
 *
 * Describes how a table participates in Atlas's developer/published mode
 * system: how its drafts are counted, promoted, and filtered on reads.
 * Three of four existing tables are "simple" (one status column, one
 * UPDATE to promote, one COUNT for drafts); `semantic_entities` is
 * exotic because of its tombstones and overlay CTE.
 *
 * This module is pure — no auth/logger/middleware imports — so
 * `packages/api/src/lib/` consumers can depend on it without inverting
 * the purity constraint that previously lived in `lib/mode.ts` (retired
 * in #1531).
 */

import type { PoolClient } from "pg";
import { Data, type Effect } from "effect";
import type { AtlasMode } from "@useatlas/types/auth";
// `CONTENT_MODE_TABLES` creates a `port → tables → adapters/semantic-entities → port`
// ESM cycle. Resolves correctly because the classes this file exports
// (PublishPhaseError etc.) are only referenced inside adapter function
// bodies — never at module init — so the live bindings settle before
// anyone actually reads them. Same shape as the existing adapters→port
// cycle the registry already relies on.
import { CONTENT_MODE_TABLES } from "./tables";

/**
 * A status-lifecycle table where promote = `UPDATE ... SET status='published'
 * WHERE org_id=$1 AND status='draft'` and count = `COUNT(*) WHERE status='draft'`.
 *
 * `key` is the `ModeDraftCounts` segment key. `table` defaults to `key` for
 * the common case where the physical table name matches; override only when
 * the segment key diverges from the physical table name — e.g.
 * `prompts` → `prompt_collections`, or `starterPrompts` → `query_suggestions`.
 */
export type SimpleModeTable = {
  readonly kind: "simple";
  readonly key: string;
  readonly table?: string;
  readonly orgColumn?: string;
  readonly statusColumn?: string;
};

/**
 * A table whose draft counts, promotion, or read filter require
 * table-specific SQL. Exotic adapters wrap existing helpers rather than
 * rewriting them (e.g. `semantic_entities` wraps `promoteDraftEntities`
 * and the CTE overlay).
 *
 * If `readFilter` is omitted, `ContentModeRegistry.readFilter` fails
 * with `ExoticReadFilterUnavailableError` rather than silently falling
 * back to the simple-table default — exotic tables with tombstones or
 * overlays need dedicated read semantics, and a silent default would
 * serve wrong rows.
 */
export type ExoticModeAdapter = {
  readonly kind: "exotic";
  readonly key: string;
  readonly countSegments: ReadonlyArray<{
    readonly key: string;
    readonly sql: (orgParam: string) => string;
  }>;
  readonly promote: (
    tx: PoolClient,
    orgId: string,
  ) => Effect.Effect<PromotionReport, PublishPhaseError, never>;
  readonly readFilter?: {
    readonly published: (alias: string) => string;
    readonly developerOverlay: (alias: string) => string;
  };
};

export type ContentModeEntry = SimpleModeTable | ExoticModeAdapter;

/** Result of promoting drafts for a single table. */
export interface PromotionReport {
  readonly table: string;
  readonly promoted: number;
  readonly deleted?: number;
  readonly tombstonesApplied?: number;
}

/**
 * Publish or count phase failed.
 *
 * For `promote` / `tombstone` phases the caller owns rollback — the
 * registry never opens its own transaction, so the caller must issue
 * `ROLLBACK` on the shared `PoolClient`. For `count` this is simply
 * a wrapped executor failure with no transactional implication.
 */
export class PublishPhaseError extends Data.TaggedError("PublishPhaseError")<{
  readonly table: string;
  readonly phase: "promote" | "tombstone" | "count";
  readonly cause: unknown;
}> {}

/** Caller asked for a read filter on a table the registry doesn't know about. */
export class UnknownTableError extends Data.TaggedError("UnknownTableError")<{
  readonly table: string;
}> {}

/**
 * Caller asked for a read filter on a registered exotic table whose
 * adapter did not provide one. Exotic tables with tombstones or
 * overlays need dedicated read semantics; silently falling back to the
 * simple-table default would serve wrong rows.
 */
export class ExoticReadFilterUnavailableError extends Data.TaggedError(
  "ExoticReadFilterUnavailableError",
)<{
  readonly table: string;
}> {}

/**
 * Pure status-clause resolver for simple mode-participating tables.
 *
 * Single source of truth for the WHERE-clause fragment that
 * `ContentModeRegistry.readFilter` (Effect) and non-Effect callers
 * (e.g. `getPopularSuggestions` in `lib/db/internal.ts`) emit for
 * simple-table reads. Both paths go through here so mode semantics
 * stay in lockstep.
 *
 * `table` accepts either the segment key (e.g. `"prompts"`) or the
 * physical table name (e.g. `"prompt_collections"`). Resolved against
 * the live `CONTENT_MODE_TABLES` tuple so adding or renaming a
 * registered table takes effect here immediately — no drift.
 *
 * Returns e.g. `q.status = 'published'` or `q.status IN ('published', 'draft')`
 * with no leading AND; callers prefix `AND` / `WHERE` as needed.
 *
 * Throws if the table isn't registered as a simple entry. Exotic
 * tables need dedicated overlay CTEs and must go through
 * `ContentModeRegistry.readFilter` — this helper refuses to fall back
 * to the simple-table default in that case so wrong rows can't slip
 * through.
 */
export function resolveStatusClause(
  table: string,
  mode: AtlasMode | undefined,
  alias: string,
): string {
  const entry = (CONTENT_MODE_TABLES as ReadonlyArray<ContentModeEntry>).find(
    (e) =>
      e.key === table ||
      (e.kind === "simple" && e.table === table),
  );
  if (!entry) {
    throw new Error(
      `resolveStatusClause: "${table}" is not a registered content-mode table`,
    );
  }
  if (entry.kind !== "simple") {
    throw new Error(
      `resolveStatusClause: "${table}" is an exotic entry — use ContentModeRegistry.readFilter`,
    );
  }
  const col = entry.statusColumn ?? "status";
  return mode === "developer"
    ? `${alias}.${col} IN ('published', 'draft')`
    : `${alias}.${col} = 'published'`;
}
