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
 * the purity constraint documented in `lib/mode.ts`.
 */

import type { PoolClient } from "pg";
import { Data, type Effect } from "effect";

/**
 * A status-lifecycle table where promote = `UPDATE ... SET status='published'
 * WHERE org_id=$1 AND status='draft'` and count = `COUNT(*) WHERE status='draft'`.
 *
 * `key` is the `ModeDraftCounts` segment key. `table` defaults to `key` for
 * the common case where the physical table name matches; override only when
 * the draft-counts segment name diverges from the DB table (e.g. the
 * `query_suggestions` table surfaces as the `starterPrompts` segment).
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

/** Publish phase failed — caller owns rollback. */
export class PublishPhaseError extends Data.TaggedError("PublishPhaseError")<{
  readonly table: string;
  readonly phase: "promote" | "tombstone" | "count";
  readonly cause: unknown;
}> {}

/** Caller asked for a read filter on a table the registry doesn't know about. */
export class UnknownTableError extends Data.TaggedError("UnknownTableError")<{
  readonly table: string;
}> {}
