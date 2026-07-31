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
 * The minimal transactional client the registry's adapters consume — exactly
 * what `promote`/count SQL needs (mirrors `TransactionalClient` in
 * `semantic/entities.ts`). Structurally satisfied by both `InternalPoolClient`
 * and `pg.PoolClient`, so callers pass their transaction client straight
 * through without casts. `rowCount` is optional in the TYPE (narrow client
 * types omit it) but authoritative when present — the simple-promote UPDATE
 * has no RETURNING, so `rows` is empty there and pg's runtime `rowCount`
 * carries the count.
 */
export interface ModeTxClient {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
}

/**
 * A status-lifecycle table where promote = `UPDATE ... SET status='published'
 * WHERE org_id=$1 AND status='draft'` and count = `COUNT(*) WHERE status='draft'`.
 *
 * `key` is the `ModeDraftCounts` segment key. `table` defaults to `key` for
 * the common case where the physical table name matches; override only when
 * the segment key diverges from the physical table name — e.g.
 * `prompts` → `prompt_collections`, or `starterPrompts` → `query_suggestions`.
 *
 * `where` is an extra SQL fragment ANDed into the count + promote queries
 * (no leading `AND`, no alias prefix — both queries reference the table
 * unaliased). Used when one physical table holds rows for multiple
 * unrelated content keys and a key-specific filter must scope the operation
 * — e.g. `connections` → `workspace_plugins` where only `pillar='datasource'`
 * rows are counted/promoted under the `connections` segment.
 */
export type SimpleModeTable = {
  readonly kind: "simple";
  readonly key: string;
  readonly table?: string;
  readonly orgColumn?: string;
  readonly statusColumn?: string;
  readonly where?: string;
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
  /**
   * The `PublishPromotedCounts` wire key this adapter's promotion count
   * reports under (e.g. `semantic_entities` → `"entities"`). Simple entries
   * report under their own `key`; exotic adapters must name theirs because
   * the physical key and the wire vocabulary can diverge. Drives
   * `InferPromotedCounts` + `promotedCountsFromReports`, so a registry entry
   * can never be silently dropped from the publish result again (#81 arch
   * review — knowledge published but was omitted from `promoted`).
   */
  readonly promotedKey: string;
  readonly countSegments: ReadonlyArray<{
    readonly key: string;
    readonly sql: (orgParam: string) => string;
  }>;
  readonly promote: (
    tx: ModeTxClient,
    orgId: string,
  ) => Effect.Effect<PromotionReport, PublishPhaseError, never>;
  readonly readFilter?: {
    readonly published: (alias: string) => string;
    readonly developerOverlay: (alias: string) => string;
  };
};

export type ContentModeEntry = SimpleModeTable | ExoticModeAdapter;

/**
 * A draft row an adapter DECLINED to promote, and why (#4769).
 *
 * The review gate's refusal vocabulary. A refused row is left at
 * `status='draft'` — it is quarantined, NOT the workspace: one malformed row
 * must never wedge a tenant's entire publish, which is what failing the shared
 * transaction would do. It therefore stays in `draftCounts`, stays in the
 * publish preview, and is re-offered on the next publish, so the refusal is a
 * visible backlog rather than a silent drop.
 *
 * Only an exotic adapter can produce these: a simple entry's promote is one
 * blanket UPDATE with no per-row opinion.
 */
export interface PromotionRefusal {
  /** Primary key of the refused row, so an operator can go look at it. */
  readonly rowId: string;
  /**
   * Machine-readable refusal codes, one per failed rule. A row can break more
   * than one rule and an admin needs to fix all of them, so this is a list
   * rather than a first-failure.
   */
  readonly reasons: readonly string[];
  /** Human-readable, actionable explanation. Surfaced to the admin verbatim. */
  readonly detail: string;
}

/**
 * A row whose ACL this publish widened, and the principals it added (#4823).
 *
 * Only `brain_facts` produces these today: it is the one table whose promote
 * computes a visibility grant rather than only flipping a status. Reported
 * rather than only logged because a log line rotates and its level is
 * hot-mutable — `admin-publish.ts` puts the sweep in `logAdminAction`'s durable
 * jsonb, the same argument `refusedDrafts` is written for, applied to the more
 * consequential of the two events. (The MCP publish seam writes no audit row
 * for anything, so there it reaches a `log.warn` and no further;
 * `collectWidenings` is shared so at least the two cannot report differently.)
 *
 * `added` is a non-empty tuple: a widening that widened nothing is not an
 * event, and the producer already makes that state unrepresentable.
 */
export interface GrantWidening {
  readonly rowId: string;
  /** Grant tokens added. Syntactic — a token may already be implied by a role. */
  readonly added: readonly [string, ...string[]];
}

/**
 * A promoted row that SUPERSEDED already-published rows on its way in (#4912,
 * ADR-0036 §Temporal). Only `brain_facts` produces these: promoting a
 * `single`-cardinality draft whose (subject, predicate) collides with a live
 * published fact holding a different object stamps the old fact's `valid_to`
 * and writes a `supersedes` edge, atomically with the promotion.
 *
 * Supersession is NOT deletion and not retraction — the superseded rows stay
 * `published`, keep `invalidated_at IS NULL`, and remain readable to as-of
 * reads. What changed is which fact answers an as-of-NOW read, which is why the
 * event is reported rather than only logged: this is the ONLY path allowed to
 * stamp `valid_to` (a human promotion), and a durable record of what it stamped
 * is the other half of "no autonomous supersession".
 *
 * `superseded` is a non-empty tuple for {@link GrantWidening.added}'s reason: a
 * supersession that superseded nothing is not an event.
 */
export interface FactSupersession {
  /** The newly-promoted fact — the `supersedes` edge's `from` end. */
  readonly rowId: string;
  /** The published facts whose `valid_to` this promotion stamped. */
  readonly superseded: readonly [string, ...string[]];
}

/** Result of promoting drafts for a single table. */
export interface PromotionReport {
  readonly table: string;
  readonly promoted: number;
  readonly deleted?: number;
  readonly tombstonesApplied?: number;
  /**
   * Rows this adapter refused to promote. Absent (not `[]`) for adapters that
   * cannot refuse, so "this table has no refusal concept" and "this table
   * refused nothing today" stay distinguishable.
   */
  readonly refused?: readonly PromotionRefusal[];
  /**
   * Rows whose grant this publish widened. Absent for every adapter that has
   * no grant concept at all, on the same distinguishability grounds as
   * {@link PromotionReport.refused}.
   */
  readonly widened?: readonly GrantWidening[];
  /**
   * Promoted rows that superseded already-published rows (#4912). Absent for
   * every adapter with no supersession concept, on the same distinguishability
   * grounds as {@link PromotionReport.refused}.
   */
  readonly superseded?: readonly FactSupersession[];
}

/**
 * Publish or count phase failed.
 *
 * For `promote` / `tombstone` phases the caller owns rollback — the
 * registry never opens its own transaction, so the caller must issue
 * `ROLLBACK` on the shared transaction client. For `count` this is simply
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
