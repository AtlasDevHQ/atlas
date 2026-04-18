/**
 * ContentModeRegistry — Effect service exposing the content-mode tuple
 * via a small typed interface (#1515).
 *
 * The registration data is a static `as const` tuple in `tables.ts`;
 * this file only builds the Effect.ts service wrapper so callers can
 * `yield* ContentModeRegistry` from any Effect program. No runtime
 * plugin/register API — the tuple is the single source of truth.
 */

import { Context, Effect, Layer } from "effect";
import type { PoolClient } from "pg";
import type { AtlasMode } from "@useatlas/types/auth";
import type { ModeDraftCounts } from "@useatlas/types/mode";
import { InternalDB } from "@atlas/api/lib/db/internal";
import type { ContentModeEntry, PromotionReport } from "./port";
import { PublishPhaseError, UnknownTableError } from "./port";
import { CONTENT_MODE_TABLES } from "./tables";
import type { InferDraftCounts } from "./infer";

/** Zero-filled counts object used as the base for every countAllDrafts result. */
type DerivedCounts = InferDraftCounts<typeof CONTENT_MODE_TABLES>;

export interface ContentModeRegistryService {
  /**
   * Return a SQL fragment usable inside a WHERE clause. Callers
   * typically write `WHERE ${filter} AND org_id = $1` and let the
   * registry own the status semantics.
   */
  readonly readFilter: (
    table: string,
    mode: AtlasMode,
    alias: string,
  ) => Effect.Effect<string, UnknownTableError, never>;

  /**
   * One-round-trip fetch of every registered table's draft count.
   * Emits a single UNION ALL query, zero-fills segments whose branch
   * returned no rows, and returns the derived `ModeDraftCounts` shape.
   * Wraps executor failures in `PublishPhaseError` with `phase: "count"`.
   */
  readonly countAllDrafts: (
    orgId: string,
  ) => Effect.Effect<ModeDraftCounts, PublishPhaseError, InternalDB>;

  /**
   * Promote drafts for every registered table using the caller's
   * transactional `PoolClient`. Runs adapters in tuple order; stops
   * on the first failure and surfaces a `PublishPhaseError` tagged
   * with the offending table and phase. The registry never opens or
   * commits its own transaction — caller owns `BEGIN`/`COMMIT`.
   */
  readonly runPublishPhases: (
    tx: PoolClient,
    orgId: string,
  ) => Effect.Effect<ReadonlyArray<PromotionReport>, PublishPhaseError, never>;
}

export class ContentModeRegistry extends Context.Tag("ContentModeRegistry")<
  ContentModeRegistry,
  ContentModeRegistryService
>() {}

function findEntry(table: string): ContentModeEntry | undefined {
  for (const entry of CONTENT_MODE_TABLES) {
    if (entry.key === table) return entry;
    if (entry.kind === "simple" && "table" in entry && entry.table === table) {
      return entry;
    }
  }
  return undefined;
}

function defaultReadFilter(alias: string, mode: AtlasMode): string {
  return mode === "developer"
    ? `${alias}.status IN ('published', 'draft')`
    : `${alias}.status = 'published'`;
}

/** Shape of a simple entry's customizable fields — column names + table name. */
type SimpleFields = {
  readonly key: string;
  readonly table?: string;
  readonly orgColumn?: string;
  readonly statusColumn?: string;
};

/** Collapse a simple entry to its resolved DB identifiers, applying defaults. */
function resolveSimple(
  entry: SimpleFields,
): { readonly table: string; readonly orgCol: string; readonly statusCol: string } {
  return {
    table: entry.table ?? entry.key,
    orgCol: entry.orgColumn ?? "org_id",
    statusCol: entry.statusColumn ?? "status",
  };
}

/**
 * SELECT clause that counts drafts for a simple status-lifecycle table.
 * Emitted for every `kind: "simple"` entry as one branch of the UNION.
 */
function simpleCountSql(entry: SimpleFields, orgParam: string): string {
  const { table, orgCol, statusCol } = resolveSimple(entry);
  return `SELECT '${entry.key}' AS key, COUNT(*)::int AS n FROM ${table} WHERE ${orgCol} = ${orgParam} AND ${statusCol} = 'draft'`;
}

/** Every segment key contributed by a registered entry — used to zero-fill. */
function allSegmentKeys(): readonly string[] {
  const keys: string[] = [];
  for (const entry of CONTENT_MODE_TABLES) {
    if (entry.kind === "simple") {
      keys.push(entry.key);
    } else {
      for (const seg of entry.countSegments) keys.push(seg.key);
    }
  }
  return keys;
}

/** Fresh zero-filled counts object. */
function zeroCounts(): DerivedCounts {
  const base: Record<string, number> = {};
  for (const k of allSegmentKeys()) base[k] = 0;
  return base as DerivedCounts;
}

/** Compose every entry's count SQL into a single UNION ALL query. */
function buildDraftCountsQuery(): string {
  const branches: string[] = [];
  for (const entry of CONTENT_MODE_TABLES) {
    if (entry.kind === "simple") {
      branches.push(simpleCountSql(entry, "$1"));
    } else {
      for (const seg of entry.countSegments) branches.push(seg.sql("$1"));
    }
  }
  return branches.join("\nUNION ALL\n");
}

/** Default promote UPDATE for a simple status-lifecycle table. */
function simplePromoteSql(entry: SimpleFields): string {
  const { table, orgCol, statusCol } = resolveSimple(entry);
  return `UPDATE ${table} SET ${statusCol} = 'published', updated_at = now()
          WHERE ${orgCol} = $1 AND ${statusCol} = 'draft'`;
}

/** Promote a single simple table inside the caller's tx, wrapping errors. */
function promoteSimpleTable(
  entry: SimpleFields,
  tx: PoolClient,
  orgId: string,
): Effect.Effect<PromotionReport, PublishPhaseError, never> {
  const { table } = resolveSimple(entry);
  return Effect.tryPromise({
    try: async () => {
      const result = await tx.query(simplePromoteSql(entry), [orgId]);
      return { table, promoted: result.rowCount ?? 0 } satisfies PromotionReport;
    },
    catch: (cause) => new PublishPhaseError({ table, phase: "promote", cause }),
  });
}

function makeService(): ContentModeRegistryService {
  const countsQuery = buildDraftCountsQuery();

  return {
    readFilter: (table, mode, alias) =>
      Effect.gen(function* () {
        const entry = findEntry(table);
        if (!entry) {
          return yield* Effect.fail(new UnknownTableError({ table }));
        }
        if (entry.kind === "exotic" && entry.readFilter) {
          return mode === "developer"
            ? entry.readFilter.developerOverlay(alias)
            : entry.readFilter.published(alias);
        }
        return defaultReadFilter(alias, mode);
      }),

    countAllDrafts: (orgId) =>
      Effect.gen(function* () {
        const db = yield* InternalDB;
        const rows = yield* Effect.tryPromise({
          try: () => db.query<{ key: string; n: number }>(countsQuery, [orgId]),
          catch: (cause) =>
            new PublishPhaseError({
              table: "(all)",
              phase: "count",
              cause,
            }),
        });
        const counts = zeroCounts();
        for (const { key, n } of rows) {
          if (key in counts) {
            (counts as Record<string, number>)[key] = Number(n) || 0;
          }
        }
        return counts satisfies ModeDraftCounts;
      }),

    runPublishPhases: (tx, orgId) =>
      Effect.gen(function* () {
        const reports: PromotionReport[] = [];
        for (const entry of CONTENT_MODE_TABLES) {
          if (entry.kind === "simple") {
            const report = yield* promoteSimpleTable(entry, tx, orgId);
            reports.push(report);
          } else {
            const report = yield* entry.promote(tx, orgId);
            reports.push(report);
          }
        }
        return reports;
      }),
  };
}

export const ContentModeRegistryLive: Layer.Layer<ContentModeRegistry, never, never> =
  Layer.succeed(ContentModeRegistry, makeService());
