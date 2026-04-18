/**
 * Boundary tests for the semantic_entities exotic adapter (#1515 phase 2d).
 *
 * Focuses on the adapter's contract with its caller:
 * - Runs tombstones before promote (ordering is load-bearing — promote
 *   would otherwise re-materialize rows the tombstones intended to
 *   delete).
 * - Reports both counts in the PromotionReport.
 * - Surfaces PublishPhaseError with the correct phase on failure so the
 *   admin-publish handler can attribute partial failures.
 * - Never issues BEGIN/COMMIT/ROLLBACK — caller owns the transaction.
 */

import { describe, it, expect } from "bun:test";
import { Effect } from "effect";
import type { PoolClient, QueryResult } from "pg";
import { promoteSemanticEntities } from "../semantic-entities";
import { PublishPhaseError } from "../../port";

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

describe("promoteSemanticEntities", () => {
  it("runs tombstones before promote and returns both counts", async () => {
    const { client, calls } = makeMockPoolClient([
      // applyTombstones
      { rows: [{ id: "a" }, { id: "b" }], rowCount: 2 }, // DELETE published targeted
      { rowCount: 2 }, //                                  DELETE tombstones
      // promoteDraftEntities
      { rowCount: 1 }, //                                  DELETE superseded published
      { rows: [{ id: "c" }, { id: "d" }, { id: "e" }], rowCount: 3 }, // UPDATE promote
    ]);

    const report = await Effect.runPromise(promoteSemanticEntities(client, "org-1"));

    expect(report.table).toBe("semantic_entities");
    expect(report.tombstonesApplied).toBe(2);
    expect(report.promoted).toBe(3);

    // Ordering: both tombstone DELETEs must fire before the promote path.
    expect(calls[0].sql).toContain("draft_delete");
    expect(calls[1].sql).toContain("draft_delete");
    expect(calls[2].sql).toMatch(/DELETE FROM semantic_entities/);
    expect(calls[3].sql).toContain("UPDATE semantic_entities");

    for (const c of calls) expect(c.params).toEqual(["org-1"]);
  });

  it("surfaces PublishPhaseError { phase: 'tombstone' } when applyTombstones fails", async () => {
    const boom = new Error("tombstone FK violation");
    const { client, calls } = makeMockPoolClient([boom]);

    const result = await Effect.runPromise(
      promoteSemanticEntities(client, "org-1").pipe(Effect.either),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(PublishPhaseError);
      expect(result.left._tag).toBe("PublishPhaseError");
      expect(result.left.table).toBe("semantic_entities");
      expect(result.left.phase).toBe("tombstone");
      expect(result.left.cause).toBe(boom);
    }
    // Promote must not run after tombstones fail.
    expect(calls).toHaveLength(1);
  });

  it("surfaces PublishPhaseError { phase: 'promote' } when promoteDraftEntities fails", async () => {
    const boom = new Error("promote unique violation");
    const { client, calls } = makeMockPoolClient([
      { rowCount: 0 }, // applyTombstones.DELETE published
      { rowCount: 0 }, // applyTombstones.DELETE tombstones
      boom, //          promoteDraftEntities.DELETE superseded FAILS
    ]);

    const result = await Effect.runPromise(
      promoteSemanticEntities(client, "org-1").pipe(Effect.either),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(PublishPhaseError);
      expect(result.left.phase).toBe("promote");
      expect(result.left.table).toBe("semantic_entities");
      expect(result.left.cause).toBe(boom);
    }
    expect(calls).toHaveLength(3);
  });

  it("never issues BEGIN/COMMIT/ROLLBACK — caller owns the transaction", async () => {
    const { client, calls } = makeMockPoolClient([
      { rowCount: 0 },
      { rowCount: 0 },
      { rowCount: 0 },
      { rowCount: 0 },
    ]);

    await Effect.runPromise(promoteSemanticEntities(client, "org-1"));

    for (const call of calls) {
      const upper = call.sql.toUpperCase();
      expect(upper).not.toMatch(/\bBEGIN\b/);
      expect(upper).not.toMatch(/\bCOMMIT\b/);
      expect(upper).not.toMatch(/\bROLLBACK\b/);
    }
  });
});
