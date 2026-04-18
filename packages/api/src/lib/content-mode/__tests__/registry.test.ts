/**
 * Boundary tests for the ContentModeRegistry (#1515).
 *
 * These tests describe the public surface, not the internal SQL shape.
 * The registry is exercised through its exported Context.Tag service and
 * the derived `InferDraftCounts` type. Internal helpers stay untested so
 * they can be refactored freely.
 *
 * Tests that exercise dispatch branches the production tuple doesn't
 * currently hit (exotic readFilter override, failing exotic promote,
 * duplicate-key guard) build a throwaway `makeService(tables)` around
 * a test-only tuple.
 */

import { describe, it, expect } from "bun:test";
import { Effect, Layer } from "effect";
import type { ModeDraftCounts } from "@useatlas/types/mode";
import { CONTENT_MODE_TABLES } from "../tables";
import type { InferDraftCounts } from "../infer";
import {
  ContentModeRegistry,
  ContentModeRegistryLive,
  makeService,
  type ContentModeRegistryService,
} from "../registry";
import type { ContentModeEntry, PromotionReport } from "../port";
import {
  ExoticReadFilterUnavailableError,
  PublishPhaseError,
  UnknownTableError,
} from "../port";
import { InternalDB, createInternalDBTestLayer } from "@atlas/api/lib/db/internal";
import type { PoolClient, QueryResult } from "pg";

/**
 * Minimal PoolClient mock: records every `query()` invocation and returns
 * pre-seeded results in FIFO order. Throws if the registry issues more
 * queries than seeded responses — an unexpected extra query (e.g. stray
 * BEGIN/COMMIT) fails loudly instead of silently returning empty.
 */
function makeMockPoolClient(
  responses: Array<Partial<QueryResult> | Error>,
): { client: PoolClient; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (responses.length === 0) {
        throw new Error(
          `makeMockPoolClient: unexpected query #${calls.length} — no seeded response (sql: ${sql.slice(0, 80)})`,
        );
      }
      const next = responses.shift()!;
      if (next instanceof Error) throw next;
      return { rows: next.rows ?? [], rowCount: next.rowCount ?? 0 };
    },
    release: () => {},
  } as unknown as PoolClient;
  return { client, calls };
}

/**
 * Build a test layer where `InternalDB.query` records its SQL + params and
 * returns `rows` shaped like the count row union. Supports either a fixed
 * row array or a custom query function.
 */
function makeInternalDBCapture(
  rows: ReadonlyArray<{ key: string; n: number | string }> = [],
): {
  layer: Layer.Layer<InternalDB>;
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const layer = createInternalDBTestLayer({
    query: async <T extends Record<string, unknown>>(
      sql: string,
      params: unknown[] = [],
    ): Promise<T[]> => {
      calls.push({ sql, params });
      return rows as unknown as T[];
    },
  });
  return { layer, calls };
}

/** Run an Effect program with the live registry layer and return the result. */
function runWithLive<A, E>(program: Effect.Effect<A, E, ContentModeRegistry>): Promise<A> {
  return Effect.runPromise(program.pipe(Effect.provide(ContentModeRegistryLive)));
}

/** Build a test-only registry layer from a custom tables tuple. */
function testRegistryLayer(
  tables: ReadonlyArray<ContentModeEntry>,
): Layer.Layer<ContentModeRegistry> {
  return Layer.succeed(ContentModeRegistry, makeService(tables));
}

// ---------------------------------------------------------------------------
// Type-level equality helpers (no runtime cost).
// The conditional-function trick distinguishes structurally equal types from
// merely mutually-assignable ones — required so a drift in readonly-ness or
// added keys surfaces as a compile error.
// ---------------------------------------------------------------------------
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

// Compile-time assertion: InferDraftCounts<CONTENT_MODE_TABLES> must equal
// ModeDraftCounts. Adding a key on either side without the other causes this
// line to fail type-check. This is the real gate — not a runtime expect.
const _assertInferredEqualsWire: Equal<
  ModeDraftCounts,
  InferDraftCounts<typeof CONTENT_MODE_TABLES>
> = true;
void _assertInferredEqualsWire;

// Compile-time assertion: makeService returns the right shape.
const _assertMakeServiceShape: ContentModeRegistryService =
  null as unknown as ContentModeRegistryService;
void _assertMakeServiceShape;

// ============================================================================
// readFilter
// ============================================================================

describe("ContentModeRegistry.readFilter — simple tables", () => {
  it("returns `alias.status = 'published'` in published mode", async () => {
    const clause = await runWithLive(
      Effect.gen(function* () {
        const registry = yield* ContentModeRegistry;
        return yield* registry.readFilter("connections", "published", "c");
      }),
    );
    expect(clause).toBe("c.status = 'published'");
  });

  it("overlays drafts onto published rows in developer mode", async () => {
    const clause = await runWithLive(
      Effect.gen(function* () {
        const registry = yield* ContentModeRegistry;
        return yield* registry.readFilter("connections", "developer", "c");
      }),
    );
    expect(clause).toBe("c.status IN ('published', 'draft')");
  });

  it("resolves simple entries by physical table name (prompt_collections, query_suggestions)", async () => {
    const clauses = await runWithLive(
      Effect.gen(function* () {
        const registry = yield* ContentModeRegistry;
        const byKey = yield* registry.readFilter("prompts", "published", "p");
        const byTable = yield* registry.readFilter("prompt_collections", "published", "p");
        const byKey2 = yield* registry.readFilter("starterPrompts", "published", "s");
        const byTable2 = yield* registry.readFilter("query_suggestions", "published", "s");
        return { byKey, byTable, byKey2, byTable2 };
      }),
    );
    expect(clauses.byKey).toBe("p.status = 'published'");
    expect(clauses.byTable).toBe("p.status = 'published'");
    expect(clauses.byKey2).toBe("s.status = 'published'");
    expect(clauses.byTable2).toBe("s.status = 'published'");
  });
});

describe("ContentModeRegistry.readFilter — failure modes", () => {
  it("fails with UnknownTableError for an unregistered table", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ContentModeRegistry;
        return yield* registry.readFilter("bogus_table", "published", "b");
      }).pipe(Effect.provide(ContentModeRegistryLive), Effect.either),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(UnknownTableError);
      expect(result.left._tag).toBe("UnknownTableError");
      expect((result.left as UnknownTableError).table).toBe("bogus_table");
    }
  });

  it("fails with ExoticReadFilterUnavailableError for an exotic entry with no readFilter adapter", async () => {
    // semantic_entities in the production tuple has no readFilter — phase 2
    // of #1515 will add it. Until then, calling readFilter for it must fail
    // loudly rather than returning the simple-table default.
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ContentModeRegistry;
        return yield* registry.readFilter("semantic_entities", "developer", "s");
      }).pipe(Effect.provide(ContentModeRegistryLive), Effect.either),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ExoticReadFilterUnavailableError);
      expect(result.left._tag).toBe("ExoticReadFilterUnavailableError");
      expect((result.left as ExoticReadFilterUnavailableError).table).toBe(
        "semantic_entities",
      );
    }
  });
});

describe("ContentModeRegistry.readFilter — exotic tables with readFilter adapter", () => {
  // Test-only tuple with an exotic entry that ships a readFilter override.
  // Covers the dispatch branch the production tuple cannot currently hit
  // (and that phase 2 activates for semantic_entities).
  const exoticWithFilter: ReadonlyArray<ContentModeEntry> = [
    {
      kind: "exotic",
      key: "fancy_entities",
      countSegments: [
        {
          key: "fancy_entities",
          sql: (p) => `SELECT 'fancy_entities' AS key, 0::int AS n FROM (VALUES (${p})) v`,
        },
      ],
      promote: () =>
        Effect.succeed({ table: "fancy_entities", promoted: 0 }),
      readFilter: {
        published: (alias) =>
          `${alias}.status = 'published' AND ${alias}.deleted_at IS NULL`,
        developerOverlay: (alias) =>
          `${alias}.status IN ('published', 'draft') AND ${alias}.draft_status != 'draft_delete'`,
      },
    },
  ];

  it("invokes readFilter.published(alias) in published mode", async () => {
    const clause = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ContentModeRegistry;
        return yield* registry.readFilter("fancy_entities", "published", "f");
      }).pipe(Effect.provide(testRegistryLayer(exoticWithFilter))),
    );
    expect(clause).toBe("f.status = 'published' AND f.deleted_at IS NULL");
  });

  it("invokes readFilter.developerOverlay(alias) in developer mode", async () => {
    const clause = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ContentModeRegistry;
        return yield* registry.readFilter("fancy_entities", "developer", "f");
      }).pipe(Effect.provide(testRegistryLayer(exoticWithFilter))),
    );
    expect(clause).toBe(
      "f.status IN ('published', 'draft') AND f.draft_status != 'draft_delete'",
    );
  });
});

// ============================================================================
// countAllDrafts
// ============================================================================

describe("ContentModeRegistry.countAllDrafts", () => {
  it("issues exactly one UNION ALL query and zero-fills missing segments", async () => {
    const { layer, calls } = makeInternalDBCapture([
      { key: "connections", n: 2 },
      { key: "prompts", n: 1 },
      // Intentionally omit entities/entityEdits/entityDeletes/starterPrompts
      // so the test asserts zero-fill for absent segments.
    ]);

    const counts = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ContentModeRegistry;
        return yield* registry.countAllDrafts("org-123");
      }).pipe(Effect.provide(ContentModeRegistryLive), Effect.provide(layer)),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("UNION ALL");
    expect(calls[0].params).toEqual(["org-123"]);
    expect(counts).toEqual({
      connections: 2,
      prompts: 1,
      starterPrompts: 0,
      entities: 0,
      entityEdits: 0,
      entityDeletes: 0,
    });
    // Every `$N` token in the query must be `$1` — the registry passes a
    // single orgId param; a future exotic segment that introduces `$2`
    // would cause silent param/branch mismatches.
    const tokens = calls[0].sql.match(/\$\d+/g) ?? [];
    expect(new Set(tokens)).toEqual(new Set(["$1"]));
  });

  it("coerces string counts from the driver to numbers", async () => {
    // Some pg pool configurations return ::int COUNTs as strings; the
    // registry must coerce explicitly without falling back to 0.
    const { layer } = makeInternalDBCapture([
      { key: "connections", n: "5" as unknown as number },
      { key: "prompts", n: "0" as unknown as number },
    ]);

    const counts = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ContentModeRegistry;
        return yield* registry.countAllDrafts("org-1");
      }).pipe(Effect.provide(ContentModeRegistryLive), Effect.provide(layer)),
    );
    expect(counts.connections).toBe(5);
    expect(counts.prompts).toBe(0);
  });

  it("wraps executor errors in PublishPhaseError with phase 'count'", async () => {
    const boom = new Error("connection refused");
    const failingLayer = createInternalDBTestLayer({
      query: async () => {
        throw boom;
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ContentModeRegistry;
        return yield* registry.countAllDrafts("org-1");
      }).pipe(
        Effect.provide(ContentModeRegistryLive),
        Effect.provide(failingLayer),
        Effect.either,
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(PublishPhaseError);
      expect(result.left._tag).toBe("PublishPhaseError");
      expect((result.left as PublishPhaseError).phase).toBe("count");
      expect((result.left as PublishPhaseError).cause).toBe(boom);
    }
  });

  it("fails with PublishPhaseError when a row returns an unknown segment key", async () => {
    // Drift scenario: the DB returns a row for a segment that isn't in the
    // tuple. Silently dropping would mask tuple/UNION drift; the registry
    // must fail so the admin banner never under-reports drafts.
    const { layer } = makeInternalDBCapture([
      { key: "connections", n: 1 },
      { key: "stale_removed_segment", n: 99 },
    ]);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ContentModeRegistry;
        return yield* registry.countAllDrafts("org-1");
      }).pipe(
        Effect.provide(ContentModeRegistryLive),
        Effect.provide(layer),
        Effect.either,
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(PublishPhaseError);
      expect((result.left as PublishPhaseError).phase).toBe("count");
      const cause = (result.left as PublishPhaseError).cause;
      expect(cause).toBeInstanceOf(Error);
      expect(String(cause)).toContain("stale_removed_segment");
    }
  });

  it("fails with PublishPhaseError when a row returns a non-numeric count", async () => {
    const { layer } = makeInternalDBCapture([
      { key: "connections", n: "abc" as unknown as number },
    ]);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ContentModeRegistry;
        return yield* registry.countAllDrafts("org-1");
      }).pipe(
        Effect.provide(ContentModeRegistryLive),
        Effect.provide(layer),
        Effect.either,
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(PublishPhaseError);
      expect((result.left as PublishPhaseError).phase).toBe("count");
      const cause = (result.left as PublishPhaseError).cause;
      expect(String(cause)).toContain("non-numeric count");
    }
  });

  it("fails with PublishPhaseError when a row returns a negative count", async () => {
    const { layer } = makeInternalDBCapture([{ key: "connections", n: -1 }]);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ContentModeRegistry;
        return yield* registry.countAllDrafts("org-1");
      }).pipe(
        Effect.provide(ContentModeRegistryLive),
        Effect.provide(layer),
        Effect.either,
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(PublishPhaseError);
      expect((result.left as PublishPhaseError).phase).toBe("count");
    }
  });
});

// ============================================================================
// runPublishPhases
// ============================================================================

describe("ContentModeRegistry.runPublishPhases", () => {
  it("invokes simple adapters in tuple order followed by semantic_entities tombstone+promote", async () => {
    // Production tuple flow (phase 2d of #1515):
    // 1. connections       → UPDATE (1 SQL)
    // 2. prompt_collections → UPDATE (1 SQL)
    // 3. query_suggestions  → UPDATE (1 SQL)
    // 4. semantic_entities  → applyTombstones (2 SQL) + promoteDraftEntities (2 SQL)
    const { client, calls } = makeMockPoolClient([
      { rowCount: 3 }, // connections
      { rowCount: 2 }, // prompt_collections
      { rowCount: 1 }, // query_suggestions
      // semantic_entities.applyTombstones:
      { rows: [{ id: "e1" }, { id: "e2" }], rowCount: 2 }, //   DELETE published via tombstone join
      { rowCount: 2 }, //                                        DELETE tombstones
      // semantic_entities.promoteDraftEntities:
      { rowCount: 1 }, //                                        DELETE superseded published
      { rows: [{ id: "e3" }, { id: "e4" }, { id: "e5" }], rowCount: 3 }, // UPDATE promote
    ]);

    const reports = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ContentModeRegistry;
        return yield* registry.runPublishPhases(client, "org-1");
      }).pipe(Effect.provide(ContentModeRegistryLive)),
    );

    expect(reports.map((r: PromotionReport) => r.table)).toEqual([
      "connections",
      "prompt_collections",
      "query_suggestions",
      "semantic_entities",
    ]);
    expect(reports[0].promoted).toBe(3);
    expect(reports[1].promoted).toBe(2);
    expect(reports[2].promoted).toBe(1);
    // semantic_entities report composes both phases' counts.
    expect(reports[3].promoted).toBe(3);
    expect(reports[3].tombstonesApplied).toBe(2);

    expect(calls).toHaveLength(7);
    expect(calls[0].sql).toContain("UPDATE connections");
    expect(calls[1].sql).toContain("UPDATE prompt_collections");
    expect(calls[2].sql).toContain("UPDATE query_suggestions");
    // Tombstones before promote.
    expect(calls[3].sql).toContain("draft_delete");
    expect(calls[4].sql).toContain("draft_delete");
    expect(calls[5].sql).toMatch(/DELETE FROM semantic_entities/);
    expect(calls[6].sql).toContain("UPDATE semantic_entities");
    for (const c of calls) expect(c.params).toEqual(["org-1"]);
  });

  it("invokes simple and exotic adapters in tuple order with a non-failing exotic (test tuple)", async () => {
    const exoticReports: PromotionReport[] = [];
    const customTables: ReadonlyArray<ContentModeEntry> = [
      { kind: "simple", key: "alpha" },
      {
        kind: "exotic",
        key: "beta",
        countSegments: [
          { key: "beta", sql: (p) => `SELECT 'beta' AS key, 0::int AS n FROM (VALUES (${p})) v` },
        ],
        promote: () => {
          const report: PromotionReport = {
            table: "beta",
            promoted: 7,
            tombstonesApplied: 2,
          };
          exoticReports.push(report);
          return Effect.succeed(report);
        },
      },
      { kind: "simple", key: "gamma" },
    ];
    const { client, calls } = makeMockPoolClient([
      { rowCount: 5 }, // alpha
      { rowCount: 4 }, // gamma (beta uses its adapter, no tx.query)
    ]);

    const reports = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ContentModeRegistry;
        return yield* registry.runPublishPhases(client, "org-1");
      }).pipe(Effect.provide(testRegistryLayer(customTables))),
    );

    expect(reports.map((r) => r.table)).toEqual(["alpha", "beta", "gamma"]);
    expect(reports[0].promoted).toBe(5);
    expect(reports[1].promoted).toBe(7);
    expect(reports[1].tombstonesApplied).toBe(2);
    expect(reports[2].promoted).toBe(4);
    // Two simple UPDATEs hit tx.query; the exotic adapter uses its own
    // promote Effect and does not route through the client in this fixture.
    expect(calls).toHaveLength(2);
    expect(calls[0].sql).toContain("UPDATE alpha");
    expect(calls[1].sql).toContain("UPDATE gamma");
    expect(exoticReports).toHaveLength(1);
  });

  it("surfaces PublishPhaseError from a failing exotic adapter and skips subsequent entries", async () => {
    const boom = new PublishPhaseError({
      table: "beta",
      phase: "tombstone",
      cause: new Error("FK violation on tombstone cascade"),
    });
    const customTables: ReadonlyArray<ContentModeEntry> = [
      { kind: "simple", key: "alpha" },
      {
        kind: "exotic",
        key: "beta",
        countSegments: [
          { key: "beta", sql: (p) => `SELECT 'beta' AS key, 0::int AS n FROM (VALUES (${p})) v` },
        ],
        promote: () => Effect.fail(boom),
      },
      // gamma must NOT run.
      { kind: "simple", key: "gamma" },
    ];
    const { client, calls } = makeMockPoolClient([
      { rowCount: 1 }, // alpha succeeds
    ]);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ContentModeRegistry;
        return yield* registry.runPublishPhases(client, "org-1");
      }).pipe(Effect.provide(testRegistryLayer(customTables)), Effect.either),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(PublishPhaseError);
      expect((result.left as PublishPhaseError).phase).toBe("tombstone");
      expect((result.left as PublishPhaseError).table).toBe("beta");
    }
    // Only alpha ran; gamma never got a chance.
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("UPDATE alpha");
  });

  it("stops on first simple-adapter failure and surfaces PublishPhaseError", async () => {
    const boom = new Error("duplicate key violation");
    // Test tuple: two simple adapters only, so the failure is observable
    // without the production semantic_entities stub firing.
    const customTables: ReadonlyArray<ContentModeEntry> = [
      { kind: "simple", key: "alpha" },
      { kind: "simple", key: "beta" },
      { kind: "simple", key: "gamma" },
    ];
    const { client, calls } = makeMockPoolClient([
      { rowCount: 3 }, // alpha succeeds
      boom, // beta fails
      // gamma must NOT run; no seeded response for it.
    ]);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ContentModeRegistry;
        return yield* registry.runPublishPhases(client, "org-1");
      }).pipe(Effect.provide(testRegistryLayer(customTables)), Effect.either),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(PublishPhaseError);
      expect(result.left._tag).toBe("PublishPhaseError");
      expect((result.left as PublishPhaseError).phase).toBe("promote");
      expect((result.left as PublishPhaseError).table).toBe("beta");
      expect((result.left as PublishPhaseError).cause).toBe(boom);
    }
    expect(calls).toHaveLength(2);
    expect(calls[0].sql).toContain("UPDATE alpha");
    expect(calls[1].sql).toContain("UPDATE beta");
  });

  it("never issues BEGIN/COMMIT/ROLLBACK — caller owns the transaction", async () => {
    // Use a simple-only tuple so the stub doesn't halt iteration early.
    const customTables: ReadonlyArray<ContentModeEntry> = [
      { kind: "simple", key: "alpha" },
      { kind: "simple", key: "beta" },
      { kind: "simple", key: "gamma" },
    ];
    const { client, calls } = makeMockPoolClient([
      { rowCount: 0 },
      { rowCount: 0 },
      { rowCount: 0 },
    ]);

    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ContentModeRegistry;
        return yield* registry.runPublishPhases(client, "org-1");
      }).pipe(Effect.provide(testRegistryLayer(customTables))),
    );

    // No call's SQL may reference transaction control — that stays the caller's job.
    for (const call of calls) {
      const upper = call.sql.toUpperCase();
      expect(upper).not.toMatch(/\bBEGIN\b/);
      expect(upper).not.toMatch(/\bCOMMIT\b/);
      expect(upper).not.toMatch(/\bROLLBACK\b/);
    }
  });
});

// ============================================================================
// makeService — startup invariants
// ============================================================================

describe("makeService startup guards", () => {
  it("throws if the tuple contains duplicate entry keys", () => {
    const dupKeys: ReadonlyArray<ContentModeEntry> = [
      { kind: "simple", key: "alpha" },
      { kind: "simple", key: "alpha" },
    ];
    expect(() => makeService(dupKeys)).toThrow(/duplicate entry key "alpha"/);
  });

  it("throws if a simple entry's `table` alias collides with another entry's key", () => {
    const collidingAlias: ReadonlyArray<ContentModeEntry> = [
      { kind: "simple", key: "beta" },
      { kind: "simple", key: "alpha", table: "beta" },
    ];
    expect(() => makeService(collidingAlias)).toThrow(/already registered/);
  });

  it("throws if two exotic entries declare the same countSegments key", () => {
    const dupSegments: ReadonlyArray<ContentModeEntry> = [
      {
        kind: "exotic",
        key: "first",
        countSegments: [
          { key: "shared", sql: (p) => `SELECT 'shared' AS key, 0 AS n FROM (VALUES (${p})) v` },
        ],
        promote: () => Effect.succeed({ table: "first", promoted: 0 }),
      },
      {
        kind: "exotic",
        key: "second",
        countSegments: [
          { key: "shared", sql: (p) => `SELECT 'shared' AS key, 0 AS n FROM (VALUES (${p})) v` },
        ],
        promote: () => Effect.succeed({ table: "second", promoted: 0 }),
      },
    ];
    expect(() => makeService(dupSegments)).toThrow(/duplicate draft-counts segment "shared"/);
  });
});
