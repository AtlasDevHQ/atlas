/**
 * ContentModeRegistry — Effect service exposing the content-mode tuple
 * via a small typed interface (#1515).
 *
 * The registration data is a static `as const` tuple in `tables.ts`;
 * this file only builds the Effect.ts service wrapper so callers can
 * `yield* ContentModeRegistry` from any Effect program. No runtime
 * plugin/register API — the tuple is the single source of truth.
 *
 * `makeService(tables)` is exported for tests so alternate tuples can
 * exercise the exotic-readFilter and failing-exotic-adapter dispatch
 * branches that the production tuple does not currently hit. Production
 * code uses `ContentModeRegistryLive`, which closes over `CONTENT_MODE_TABLES`.
 */

import { Context, Effect, Layer } from "effect";
import type { PoolClient } from "pg";
import type { AtlasMode } from "@useatlas/types/auth";
import type { ModeDraftCounts } from "@useatlas/types/mode";
import { InternalDB } from "@atlas/api/lib/db/internal";
import type {
  ContentModeEntry,
  ExoticModeAdapter,
  PromotionReport,
  SimpleModeTable,
} from "./port";
import {
  ExoticReadFilterUnavailableError,
  PublishPhaseError,
  UnknownTableError,
} from "./port";
import { CONTENT_MODE_TABLES } from "./tables";
import type { InferDraftCounts } from "./infer";

/** The concrete shape `countAllDrafts` returns — must stay structurally
 *  equal to `ModeDraftCounts`; asserted by the test in `registry.test.ts`. */
type DerivedCounts = InferDraftCounts<typeof CONTENT_MODE_TABLES>;

export interface ContentModeRegistryService {
  /**
   * Return a SQL fragment usable inside a WHERE clause. Callers
   * typically write `WHERE ${filter} AND org_id = $1` and let the
   * registry own the status semantics.
   *
   * Accepts either the segment key (e.g. `"prompts"`) or the physical
   * table name (e.g. `"prompt_collections"`) for simple entries.
   * Exotic entries are looked up by their `key` only.
   *
   * Fails with `UnknownTableError` if the table isn't registered, or
   * `ExoticReadFilterUnavailableError` if the table is an exotic entry
   * whose adapter did not supply a `readFilter` — exotic tables with
   * tombstones or overlays need dedicated read semantics; the registry
   * refuses to fall back to the simple-table default in that case.
   */
  readonly readFilter: (
    table: string,
    mode: AtlasMode,
    alias: string,
  ) => Effect.Effect<string, UnknownTableError | ExoticReadFilterUnavailableError, never>;

  /**
   * One-round-trip fetch of every registered table's draft count.
   * Emits a single UNION ALL query, zero-fills every registered segment,
   * and returns the derived `ModeDraftCounts` shape.
   *
   * Requires `InternalDB` in the Effect context; `ContentModeRegistryLive`
   * alone is insufficient — callers must also provide an `InternalDB` layer
   * (production or test).
   *
   * Wraps executor failures in `PublishPhaseError` with `phase: "count"`.
   * Fails the same way if a row returns a `key` outside the registered
   * segment set, or a non-finite / negative `n` — those indicate drift
   * between the tuple and the UNION SQL and must not silently under-report.
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

function defaultReadFilter(alias: string, mode: AtlasMode): string {
  return mode === "developer"
    ? `${alias}.status IN ('published', 'draft')`
    : `${alias}.status = 'published'`;
}

/** Collapse a simple entry to its resolved DB identifiers, applying defaults. */
function resolveSimple(entry: SimpleModeTable): {
  readonly table: string;
  readonly orgCol: string;
  readonly statusCol: string;
} {
  return {
    table: entry.table ?? entry.key,
    orgCol: entry.orgColumn ?? "org_id",
    statusCol: entry.statusColumn ?? "status",
  };
}

/** SELECT branch that counts drafts for a simple status-lifecycle table. */
function simpleCountSql(entry: SimpleModeTable, orgParam: string): string {
  const { table, orgCol, statusCol } = resolveSimple(entry);
  return `SELECT '${entry.key}' AS key, COUNT(*)::int AS n FROM ${table} WHERE ${orgCol} = ${orgParam} AND ${statusCol} = 'draft'`;
}

/** Default promote UPDATE for a simple status-lifecycle table. */
function simplePromoteSql(entry: SimpleModeTable): string {
  const { table, orgCol, statusCol } = resolveSimple(entry);
  return `UPDATE ${table} SET ${statusCol} = 'published', updated_at = now()
          WHERE ${orgCol} = $1 AND ${statusCol} = 'draft'`;
}

/** Promote a single simple table inside the caller's tx, wrapping errors. */
function promoteSimpleTable(
  entry: SimpleModeTable,
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

/**
 * Build the registry service around a given table tuple. Production
 * callers use `ContentModeRegistryLive` which binds `CONTENT_MODE_TABLES`;
 * tests pass alternate tuples to cover dispatch branches the static
 * production tuple does not currently exercise.
 *
 * Throws at construction if the tuple contains duplicate segment keys —
 * a misconfiguration that would otherwise silently dedup entries in
 * `zeroCounts` / `findEntry`.
 */
export function makeService(
  tables: ReadonlyArray<ContentModeEntry>,
): ContentModeRegistryService {
  // Precompute lookup index and invariants once — the tuple is static
  // over the lifetime of the service.
  const byLookup = new Map<string, ContentModeEntry>();
  const segmentKeys: string[] = [];
  const seenSegments = new Set<string>();

  for (const entry of tables) {
    // Registration lookup: entries are findable by their `key`, and
    // simple entries additionally by their physical `table` name.
    if (byLookup.has(entry.key)) {
      throw new Error(
        `ContentModeRegistry: duplicate entry key "${entry.key}" in tables tuple`,
      );
    }
    byLookup.set(entry.key, entry);
    if (entry.kind === "simple" && entry.table && entry.table !== entry.key) {
      if (byLookup.has(entry.table)) {
        throw new Error(
          `ContentModeRegistry: entry for "${entry.key}" overrides table alias "${entry.table}" that is already registered`,
        );
      }
      byLookup.set(entry.table, entry);
    }

    // Segment-key collection: simple entries contribute their `key`;
    // exotic entries contribute every `countSegments[].key`.
    switch (entry.kind) {
      case "simple":
        if (seenSegments.has(entry.key)) {
          throw new Error(
            `ContentModeRegistry: duplicate draft-counts segment "${entry.key}"`,
          );
        }
        seenSegments.add(entry.key);
        segmentKeys.push(entry.key);
        break;
      case "exotic":
        for (const seg of entry.countSegments) {
          if (seenSegments.has(seg.key)) {
            throw new Error(
              `ContentModeRegistry: duplicate draft-counts segment "${seg.key}"`,
            );
          }
          seenSegments.add(seg.key);
          segmentKeys.push(seg.key);
        }
        break;
      default: {
        // Exhaustiveness guard: adding a new `kind` to `ContentModeEntry`
        // must update this switch. The `never` assignment fails at compile
        // time at every `switch (entry.kind)` site if that step is missed.
        const _exhaustive: never = entry;
        throw new Error(
          `ContentModeRegistry: unhandled entry kind ${JSON.stringify(_exhaustive)}`,
        );
      }
    }
  }

  // Compose the UNION ALL query once.
  const countBranches: string[] = [];
  for (const entry of tables) {
    switch (entry.kind) {
      case "simple":
        countBranches.push(simpleCountSql(entry, "$1"));
        break;
      case "exotic":
        for (const seg of entry.countSegments) countBranches.push(seg.sql("$1"));
        break;
      default: {
        const _exhaustive: never = entry;
        throw new Error(
          `ContentModeRegistry: unhandled entry kind ${JSON.stringify(_exhaustive)}`,
        );
      }
    }
  }
  const countsQuery = countBranches.join("\nUNION ALL\n");

  /** Fresh zero-filled counts object — one entry per registered segment. */
  const zeroCounts = (): DerivedCounts => {
    const base: Record<string, number> = {};
    for (const k of segmentKeys) base[k] = 0;
    return base as DerivedCounts;
  };

  return {
    readFilter: (table, mode, alias) =>
      Effect.gen(function* () {
        const entry = byLookup.get(table);
        if (!entry) {
          return yield* Effect.fail(new UnknownTableError({ table }));
        }
        switch (entry.kind) {
          case "simple":
            return defaultReadFilter(alias, mode);
          case "exotic": {
            const exotic: ExoticModeAdapter = entry;
            if (!exotic.readFilter) {
              // Exotic tables need dedicated read semantics (tombstones,
              // overlay CTEs). Refusing the fallback prevents serving
              // wrong rows when a caller assumes the registry "just works".
              return yield* Effect.fail(
                new ExoticReadFilterUnavailableError({ table: entry.key }),
              );
            }
            return mode === "developer"
              ? exotic.readFilter.developerOverlay(alias)
              : exotic.readFilter.published(alias);
          }
          default: {
            const _exhaustive: never = entry;
            throw new Error(
              `ContentModeRegistry: unhandled entry kind ${JSON.stringify(_exhaustive)}`,
            );
          }
        }
      }),

    countAllDrafts: (orgId) =>
      Effect.gen(function* () {
        const db = yield* InternalDB;
        const rows = yield* Effect.tryPromise({
          try: () => db.query<{ key: string; n: number }>(countsQuery, [orgId]),
          catch: (cause) =>
            new PublishPhaseError({ table: "(all)", phase: "count", cause }),
        });
        const counts = zeroCounts();
        for (const { key, n } of rows) {
          // An unknown key here means the UNION SQL and the tuple drifted —
          // silently dropping the row would under-report drafts to the admin
          // banner and mask the drift. Fail with enough context to grep for.
          if (!(key in counts)) {
            return yield* Effect.fail(
              new PublishPhaseError({
                table: "(all)",
                phase: "count",
                cause: new Error(
                  `ContentModeRegistry: unknown count segment "${String(key)}" — tuple and UNION SQL are out of sync`,
                ),
              }),
            );
          }
          // `pg` normally returns `COUNT(*)::int` as a JS number, but some
          // drivers / pool configurations return numerics as strings.
          // Coerce explicitly and reject NaN / negatives — `|| 0` would
          // hide both.
          const parsed = typeof n === "number" ? n : Number(n);
          if (!Number.isFinite(parsed) || parsed < 0) {
            return yield* Effect.fail(
              new PublishPhaseError({
                table: "(all)",
                phase: "count",
                cause: new Error(
                  `ContentModeRegistry: non-numeric count "${String(n)}" for segment "${key}"`,
                ),
              }),
            );
          }
          (counts as Record<string, number>)[key] = parsed;
        }
        return counts satisfies ModeDraftCounts;
      }),

    runPublishPhases: (tx, orgId) =>
      Effect.gen(function* () {
        const reports: PromotionReport[] = [];
        for (const entry of tables) {
          switch (entry.kind) {
            case "simple": {
              const report = yield* promoteSimpleTable(entry, tx, orgId);
              reports.push(report);
              break;
            }
            case "exotic": {
              const report = yield* entry.promote(tx, orgId);
              reports.push(report);
              break;
            }
            default: {
              const _exhaustive: never = entry;
              throw new Error(
                `ContentModeRegistry: unhandled entry kind ${JSON.stringify(_exhaustive)}`,
              );
            }
          }
        }
        return reports;
      }),
  } satisfies ContentModeRegistryService;
}

export const ContentModeRegistryLive: Layer.Layer<ContentModeRegistry, never, never> =
  Layer.succeed(ContentModeRegistry, makeService(CONTENT_MODE_TABLES));
