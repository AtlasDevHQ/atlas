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
import { IDENTITY_MUTATION_LOCK_NAMESPACE } from "@atlas/api/lib/brain/identity";
import type { ModeDraftCounts, PublishPromotedCounts } from "@useatlas/types/mode";
import { CONTENT_MODE_TABLES } from "../tables";
import type { InferDraftCounts, InferPromotedCounts } from "../infer";
import {
  ContentModeRegistry,
  ContentModeRegistryLive,
  makeService,
  type ContentModeRegistryService,
} from "../registry";
import { collectRefusals, collectWidenings, promotedCountsFromReports } from "../promoted";
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

// Compile-time assertion: InferPromotedCounts<CONTENT_MODE_TABLES> must equal
// PublishPromotedCounts — one promoted count per registered entry. Registering
// a surface without extending the wire type (or vice versa) fails here, so a
// publish result can never silently under-report a surface again (#81 arch
// review: knowledge documents published but were dropped from `promoted`).
const _assertPromotedEqualsWire: Equal<
  PublishPromotedCounts,
  InferPromotedCounts<typeof CONTENT_MODE_TABLES>
> = true;
void _assertPromotedEqualsWire;

describe("collectRefusals (#4769)", () => {
  it("sweeps every adapter's refusals and attributes each to its surface", () => {
    expect(
      collectRefusals([
        { table: "knowledge_documents", promoted: 3 },
        {
          table: "brain_facts",
          promoted: 1,
          refused: [{ rowId: "f1", reasons: ["GRANT_UNUSABLE"], detail: "d1" }],
        },
        {
          table: "future_table",
          promoted: 0,
          refused: [{ rowId: "r9", reasons: ["OTHER"], detail: "d2" }],
        },
      ]),
    ).toMatchObject({
      reported: [
        { id: "f1", surface: "brain_facts", reasons: ["GRANT_UNUSABLE"], detail: "d1" },
        { id: "r9", surface: "future_table", reasons: ["OTHER"], detail: "d2" },
      ],
      total: 2,
    });
  });

  it("treats absent and empty `refused` alike — both contribute nothing", () => {
    // The DISTINCTION between them is meaningful on the report (`undefined` =
    // this table cannot refuse; `[]` = it can and didn't), but it must not leak
    // into the wire list, where both mean "nothing to report".
    expect(
      collectRefusals([
        { table: "a", promoted: 1 },
        { table: "b", promoted: 2, refused: [] },
      ]),
    ).toMatchObject({ reported: [], all: [], total: 0 });
  });

  it("caps the report and says so rather than truncating silently", () => {
    // A runaway producer can refuse thousands of facts, each carrying a detail
    // that interpolates its grant verbatim. Bounding the REPORT keeps one
    // publish response from becoming multi-megabyte; every refused row is still
    // a draft and still counted, which is what the synthetic entry states.
    const many = Array.from({ length: 250 }, (_, i) => ({
      rowId: `f${i}`,
      reasons: ["GRANT_UNUSABLE"],
      detail: `detail ${i}`,
    }));
    const out = collectRefusals([{ table: "brain_facts", promoted: 0, refused: many }]);

    // EVERY reported entry is a REAL row. An earlier cut appended a synthetic
    // "(truncated)" marker, which made `reported.length` 101 and taught both
    // renderers to print 101 — the same lie the struct was added to prevent,
    // moved from the audit row to the UI.
    expect(out.reported).toHaveLength(100);
    expect(out.reported.map((r) => r.id)).toEqual(many.slice(0, 100).map((r) => r.rowId));
    expect(out.reported.some((r) => r.id === "(truncated)")).toBe(false);
    expect(out.reported.some((r) => r.reasons.includes("REPORT_TRUNCATED"))).toBe(false);
    // THE POINT of the struct: the count is never capped, and it is a separate
    // field precisely so no consumer can reach it by measuring the list.
    expect(out.total).toBe(250);
    expect(out.total).not.toBe(out.reported.length);
    // `all` is uncapped — the durable audit row stores ids for every refusal,
    // where the payload-size argument behind the cap does not apply.
    expect(out.all).toHaveLength(250);
  });

  it("does not cap when the list fits exactly", () => {
    const exactly = Array.from({ length: 100 }, (_, i) => ({
      rowId: `f${i}`,
      reasons: ["X"],
      detail: "d",
    }));
    const out = collectRefusals([{ table: "brain_facts", promoted: 0, refused: exactly }]);
    expect(out.reported).toHaveLength(100);
    expect(out.all).toHaveLength(100);
    expect(out.total).toBe(100);
  });
});

describe("collectWidenings (#4823)", () => {
  it("is NEVER capped, unlike collectRefusals", () => {
    // The asymmetry is the whole design, so it gets its own pin: a refusal list
    // is capped because it goes on the wire, and a widening list does not —
    // it goes into `logAdminAction`'s jsonb, where the payload-size argument
    // does not apply, and it is the ONLY durable record that who can read a
    // claim changed. A future "make these two consistent" refactor that capped
    // this at 100 would silently truncate that record.
    const many = Array.from({ length: 250 }, (_, i) => ({
      rowId: `f${i}`,
      added: ["org"] as [string, ...string[]],
    }));
    const out = collectWidenings([{ table: "brain_facts", promoted: 250, widened: many }]);
    expect(out).toHaveLength(250);
    expect(out[249]).toEqual({ surface: "brain_facts", id: "f249", added: ["org"] });
  });

  it("sweeps EVERY adapter and keeps the surface attributable", () => {
    // Swept rather than read off a named table, for `collectRefusals`' reason:
    // `brain_facts` is the only adapter with a grant today, and a second one is
    // reported here with no edit.
    const out = collectWidenings([
      { table: "semantic_entities", promoted: 1 },
      { table: "brain_facts", promoted: 1, widened: [{ rowId: "f1", added: ["org"] }] },
    ]);
    expect(out).toEqual([{ surface: "brain_facts", id: "f1", added: ["org"] }]);
  });

  it("returns [] when no adapter has a grant concept", () => {
    expect(collectWidenings([{ table: "prompt_collections", promoted: 3 }])).toEqual([]);
  });
});

describe("promotedCountsFromReports over the REAL registry tuple", () => {
  it("projects physical-table reports onto the wire keys (incl. the table-alias and promotedKey mappings)", () => {
    const counts = promotedCountsFromReports(CONTENT_MODE_TABLES, [
      { table: "workspace_plugins", promoted: 1 },
      { table: "semantic_entities", promoted: 2, tombstonesApplied: 9 },
      { table: "prompt_collections", promoted: 3 },
      { table: "query_suggestions", promoted: 4 },
      { table: "knowledge_documents", promoted: 5 },
      { table: "brain_facts", promoted: 6, refused: [] },
    ]);
    expect(counts).toEqual({
      connections: 1,
      entities: 2,
      prompts: 3,
      starterPrompts: 4,
      knowledgeDocuments: 5,
      brainFacts: 6,
    });
  });
});

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
      promotedKey: "fancy_entities",
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
      knowledgeDocuments: 0,
      brainFacts: 0,
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
    // 1. connections         → UPDATE (1 SQL)
    // 2. prompt_collections  → UPDATE (1 SQL)
    // 3. query_suggestions   → UPDATE (1 SQL)
    // 4. knowledge_documents → UPDATE (1 SQL)  [#4206]
    // 5. semantic_entities   → applyTombstones (2 SQL) + promoteDraftEntities (2 SQL)
    // 6. brain_facts         → SET LOCAL lock_timeout + identity-mutation
    //                          advisory lock + SET LOCAL lock_timeout = DEFAULT
    //                          (3 SQL) [#5024] + SELECT drafts
    //                          FOR UPDATE + SELECT evidence grants
    //                          + UPDATE promotable (3 SQL) [#4769, #4823]
    const { client, calls } = makeMockPoolClient([
      { rowCount: 3 }, // connections
      { rowCount: 2 }, // prompt_collections
      { rowCount: 1 }, // query_suggestions
      { rowCount: 0 }, // knowledge_documents (#4206 — no ingest yet, promotes 0)
      // semantic_entities.applyTombstones:
      { rows: [{ id: "e1" }, { id: "e2" }], rowCount: 2 }, //   DELETE published via tombstone join
      { rowCount: 2 }, //                                        DELETE tombstones
      // semantic_entities.promoteDraftEntities:
      { rowCount: 1 }, //                                        DELETE superseded published
      { rows: [{ id: "e3" }, { id: "e4" }, { id: "e5" }], rowCount: 3 }, // UPDATE promote
      // brain_facts (#5024): the lock bound, then the lock itself. Both return
      // nothing and nothing reads them — they are here because this double
      // answers in ORDER, so an unqueued statement silently consumes the next
      // response and shifts every assertion below by one.
      { rows: [] }, //                                           SET LOCAL lock_timeout
      { rows: [] }, //                                           pg_advisory_xact_lock
      { rows: [] }, //                                           SET LOCAL lock_timeout = DEFAULT
      // brain_facts (#4769): one compliant draft, one with an unusable grant.
      // The adapter classifies in TS (one grant grammar, no SQL restatement),
      // so the refusal shows up as a shorter id list on the UPDATE below.
      {
        rows: [
          {
            id: "f-ok",
            subject: "acme",
            predicate: "uses",
            object: "postgres",
            source_episode_id: "ep-1",
            provenance: { actor: "test" },
            visible_to: ["org"],
          },
          {
            id: "f-ungranted",
            subject: "acme",
            predicate: "prefers",
            object: "mysql",
            source_episode_id: "ep-1",
            provenance: { actor: "test" },
            visible_to: ["everyone"],
          },
        ],
      },
      // #4823 evidence-grant lookup: `f-ok`'s only episode carries the grant it
      // already has, so nothing widens and the plain promote runs.
      { rows: [{ fact_id: "f-ok", visible_to: ["org"] }] },
      { rowCount: 1 }, //                                        UPDATE promote (only f-ok)
    ]);

    const reports = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ContentModeRegistry;
        return yield* registry.runPublishPhases(client, "org-1");
      }).pipe(Effect.provide(ContentModeRegistryLive)),
    );

    // #2744 — `connections` segment key now points at the
    // `workspace_plugins` physical table per the CONTENT_MODE_TABLES
    // pivot (ADR-0007). The PromotionReport's `table` field reflects
    // the physical table name, so `connections` becomes `workspace_plugins`
    // in the report; the wire-side draft-count key stays `connections`
    // (see runPublishPhases + the /api/v1/mode tests).
    expect(reports.map((r: PromotionReport) => r.table)).toEqual([
      "workspace_plugins",
      "prompt_collections",
      "query_suggestions",
      "knowledge_documents",
      "semantic_entities",
      "brain_facts",
    ]);
    expect(reports[0].promoted).toBe(3);
    expect(reports[1].promoted).toBe(2);
    expect(reports[2].promoted).toBe(1);
    expect(reports[3].promoted).toBe(0); // knowledge_documents (#4206)
    // semantic_entities report composes both phases' counts.
    expect(reports[4].promoted).toBe(3);
    expect(reports[4].tombstonesApplied).toBe(2);
    // brain_facts is the one adapter that can decline a row (#4769): the
    // ungranted draft is refused and stays a draft; its sibling promotes.
    expect(reports[5].promoted).toBe(1);
    expect(reports[5].refused?.map((r) => r.rowId)).toEqual(["f-ungranted"]);
    expect(reports[5].widened).toEqual([]);

    // 14 since #5024: the eleven above plus the lock bound, the
    // identity-mutation lock the brain phase takes before it reads, and the
    // reset that keeps the bound off every later statement in the transaction.
    expect(calls).toHaveLength(14);
    expect(calls[0].sql).toContain("UPDATE workspace_plugins");
    expect(calls[1].sql).toContain("UPDATE prompt_collections");
    expect(calls[2].sql).toContain("UPDATE query_suggestions");
    expect(calls[3].sql).toContain("UPDATE knowledge_documents");
    // Tombstones before promote.
    expect(calls[4].sql).toContain("draft_delete");
    expect(calls[5].sql).toContain("draft_delete");
    expect(calls[6].sql).toMatch(/DELETE FROM semantic_entities/);
    expect(calls[7].sql).toContain("UPDATE semantic_entities");
    // brain_facts: bound the wait, take the identity-mutation lock (#5024),
    // read the drafts under a row lock, read the grants of the episodes behind
    // them (#4823), then promote by explicit id.
    expect(calls[8].sql).toContain("SET LOCAL lock_timeout = '");
    expect(calls[9].sql).toContain("pg_advisory_xact_lock");
    // Reset BEFORE the drafts are read: `SET LOCAL` reverts at COMMIT, so an
    // un-reset bound would govern the `FOR UPDATE` below — which exists to WAIT
    // for a concurrent publish — and everything after it in the transaction.
    expect(calls[10].sql).toContain("SET LOCAL lock_timeout = DEFAULT");
    expect(calls[11].sql).toMatch(/FROM brain_facts/);
    expect(calls[11].sql).toMatch(/FOR UPDATE/i);
    expect(calls[12].sql).toContain("brain_edges");
    expect(calls[13].sql).toContain("UPDATE brain_facts");

    // Every phase is org-scoped on $1. The brain promote additionally binds the
    // promotable id list on $2 — the refusal is enforced by which rows we ask
    // Postgres to touch, so that second param is the gate, not a filter. The
    // evidence lookup binds the SAME list, so a refused row's episodes cannot
    // widen anything either.
    // The two #5024 lock statements are excluded by INDEX rather than by a
    // predicate: the bound binds nothing and the lock binds `[namespace, org]`,
    // so neither is org-scoped on `$1` and a blanket loop would fail on both.
    // Their own params are asserted immediately after.
    for (const c of [...calls.slice(0, 8), calls[11]]) expect(c.params).toEqual(["org-1"]);
    expect(calls[8].params).toEqual([]);
    expect(calls[9].params).toEqual([IDENTITY_MUTATION_LOCK_NAMESPACE, "org-1"]);
    expect(calls[10].params).toEqual([]);
    expect(calls[12].params).toEqual(["org-1", ["f-ok"]]);
    expect(calls[13].params).toEqual(["org-1", ["f-ok"]]);
  });

  it("invokes simple and exotic adapters in tuple order with a non-failing exotic (test tuple)", async () => {
    const exoticReports: PromotionReport[] = [];
    const customTables: ReadonlyArray<ContentModeEntry> = [
      { kind: "simple", key: "alpha" },
      {
        kind: "exotic",
        key: "beta",
        promotedKey: "beta",
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
        promotedKey: "beta",
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
        promotedKey: "first",
        countSegments: [
          { key: "shared", sql: (p) => `SELECT 'shared' AS key, 0 AS n FROM (VALUES (${p})) v` },
        ],
        promote: () => Effect.succeed({ table: "first", promoted: 0 }),
      },
      {
        kind: "exotic",
        key: "second",
        promotedKey: "second",
        countSegments: [
          { key: "shared", sql: (p) => `SELECT 'shared' AS key, 0 AS n FROM (VALUES (${p})) v` },
        ],
        promote: () => Effect.succeed({ table: "second", promoted: 0 }),
      },
    ];
    expect(() => makeService(dupSegments)).toThrow(/duplicate draft-counts segment "shared"/);
  });
});
