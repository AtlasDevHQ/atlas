/**
 * Boundary tests for the ContentModeRegistry (#1515).
 *
 * These tests describe the public surface, not the internal SQL shape.
 * The registry is exercised through its exported Context.Tag service and
 * the derived `InferDraftCounts` type. Internal helpers stay untested so
 * they can be refactored freely.
 */

import { describe, it, expect } from "bun:test";
import { Effect } from "effect";
import type { ModeDraftCounts } from "@useatlas/types/mode";
import { CONTENT_MODE_TABLES } from "../tables";
import type { InferDraftCounts } from "../infer";
import { Layer } from "effect";
import { ContentModeRegistry, ContentModeRegistryLive } from "../registry";
import type { PromotionReport } from "../port";
import { PublishPhaseError, UnknownTableError } from "../port";
import { InternalDB, createInternalDBTestLayer } from "@atlas/api/lib/db/internal";
import type { PoolClient, QueryResult } from "pg";

/**
 * Minimal PoolClient mock: records every `query()` invocation and returns
 * pre-seeded results in FIFO order. Unused `release`/`connect` surface.
 */
function makeMockPoolClient(
  responses: Array<Partial<QueryResult> | Error>,
): { client: PoolClient; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const next = responses.shift();
      if (!next) return { rows: [], rowCount: 0 };
      if (next instanceof Error) throw next;
      return { rows: next.rows ?? [], rowCount: next.rowCount ?? 0 };
    },
    release: () => {},
  } as unknown as PoolClient;
  return { client, calls };
}

/**
 * Build a test layer where `InternalDB.query` records its SQL + params and
 * returns `rows` shaped like the count row union.
 */
function makeInternalDBCapture(
  rows: ReadonlyArray<{ key: string; n: number }> = [],
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

// ---------------------------------------------------------------------------
// Type-level equality helpers (no runtime cost).
// The conditional-function trick distinguishes structurally equal types from
// merely mutually-assignable ones — required so a drift in readonly-ness or
// added keys surfaces as a compile error.
// ---------------------------------------------------------------------------
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

describe("CONTENT_MODE_TABLES type inference", () => {
  it("derives a type exactly equal to the published ModeDraftCounts", () => {
    // If anyone adds a key to ModeDraftCounts without registering a matching
    // entry in CONTENT_MODE_TABLES (or vice versa), this line fails to compile.
    type _assertEqual = Expect<
      Equal<ModeDraftCounts, InferDraftCounts<typeof CONTENT_MODE_TABLES>>
    >;
    const ok: _assertEqual = true;
    expect(ok).toBe(true);
  });
});

describe("ContentModeRegistry.readFilter — published mode", () => {
  it("returns `alias.status = 'published'` for a simple table", async () => {
    const clause = await runWithLive(
      Effect.gen(function* () {
        const registry = yield* ContentModeRegistry;
        return yield* registry.readFilter("connections", "published", "c");
      }),
    );
    expect(clause).toBe("c.status = 'published'");
  });
});

describe("ContentModeRegistry.readFilter — developer mode", () => {
  it("overlays drafts onto published rows for a simple table", async () => {
    const clause = await runWithLive(
      Effect.gen(function* () {
        const registry = yield* ContentModeRegistry;
        return yield* registry.readFilter("connections", "developer", "c");
      }),
    );
    expect(clause).toBe("c.status IN ('published', 'draft')");
  });
});

describe("ContentModeRegistry.readFilter — unknown table", () => {
  it("fails with UnknownTableError tagged error", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ContentModeRegistry;
        return yield* registry.readFilter("bogus_table", "published", "b");
      }).pipe(Effect.provide(ContentModeRegistryLive), Effect.either),
    );
    // Either.left holds the failure; assert shape without leaning on Effect internals
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(UnknownTableError);
      expect(result.left.table).toBe("bogus_table");
      expect(result.left._tag).toBe("UnknownTableError");
    }
  });
});

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
      expect(result.left.phase).toBe("count");
      expect(result.left.cause).toBe(boom);
    }
  });
});

describe("ContentModeRegistry.runPublishPhases", () => {
  it("invokes adapters in tuple order and returns a report per entry", async () => {
    // Seed three simple UPDATEs (connections, prompt_collections, query_suggestions)
    // with decreasing rowCount so ordering is observable in the report.
    const { client, calls } = makeMockPoolClient([
      { rowCount: 3 }, // connections
      { rowCount: 2 }, // prompt_collections
      { rowCount: 1 }, // query_suggestions
    ]);

    const reports = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ContentModeRegistry;
        return yield* registry.runPublishPhases(client, "org-1");
      }).pipe(Effect.provide(ContentModeRegistryLive)),
    );

    // Three simple + one exotic (stubbed to succeed with zero promoted)
    expect(reports).toHaveLength(4);
    expect(reports.map((r: PromotionReport) => r.table)).toEqual([
      "connections",
      "prompt_collections",
      "query_suggestions",
      "semantic_entities",
    ]);
    expect(reports[0].promoted).toBe(3);
    expect(reports[1].promoted).toBe(2);
    expect(reports[2].promoted).toBe(1);

    // Three UPDATEs hit the passed-in client, in tuple order.
    expect(calls).toHaveLength(3);
    expect(calls[0].sql).toContain("UPDATE connections");
    expect(calls[1].sql).toContain("UPDATE prompt_collections");
    expect(calls[2].sql).toContain("UPDATE query_suggestions");
    for (const c of calls) expect(c.params).toEqual(["org-1"]);
  });

  it("stops on first failure and surfaces PublishPhaseError — no later adapters run", async () => {
    const boom = new Error("duplicate key violation");
    const { client, calls } = makeMockPoolClient([
      { rowCount: 3 }, // connections succeeds
      boom, // prompt_collections fails
      // query_suggestions and semantic_entities must NOT run; no seeded responses for them.
    ]);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ContentModeRegistry;
        return yield* registry.runPublishPhases(client, "org-1");
      }).pipe(Effect.provide(ContentModeRegistryLive), Effect.either),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(PublishPhaseError);
      expect(result.left._tag).toBe("PublishPhaseError");
      expect(result.left.phase).toBe("promote");
      expect(result.left.table).toBe("prompt_collections");
      expect(result.left.cause).toBe(boom);
    }
    // Exactly two UPDATEs attempted: connections succeeded, prompt_collections failed.
    expect(calls).toHaveLength(2);
    expect(calls[0].sql).toContain("UPDATE connections");
    expect(calls[1].sql).toContain("UPDATE prompt_collections");
  });

  it("never issues BEGIN/COMMIT/ROLLBACK — caller owns the transaction", async () => {
    const { client, calls } = makeMockPoolClient([
      { rowCount: 0 },
      { rowCount: 0 },
      { rowCount: 0 },
    ]);

    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ContentModeRegistry;
        return yield* registry.runPublishPhases(client, "org-1");
      }).pipe(Effect.provide(ContentModeRegistryLive)),
    );

    // No call's SQL may reference transaction control — that stays the caller's job.
    for (const call of calls) {
      const upper = call.sql.toUpperCase();
      expect(upper).not.toContain("BEGIN");
      expect(upper).not.toContain("COMMIT");
      expect(upper).not.toContain("ROLLBACK");
    }
  });
});
