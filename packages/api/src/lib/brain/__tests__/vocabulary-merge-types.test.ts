/**
 * The compile-time half of the vocabulary merge (#5036, ADR-0037 §8).
 *
 * ⚠️ SEPARATE FROM `vocabulary-merge-pg.test.ts` FOR TWO REASONS, and the second
 * is the one that matters. The obvious one: `mock.module` there is process-wide,
 * so a file that wants the real logger cannot share it. The load-bearing one:
 * every behavioural falsifier for this slice lives in a `-pg` file, which is
 * `describe.skip`ped whenever `TEST_DATABASE_URL` is unset — the local default.
 * So a mutation to the merge produces a GREEN local `bun run test`, which is the
 * topology that let a workspace-fatal `slice(0, 1)` survive a whole review round.
 * The claims below need no database, so they run everywhere and put at least the
 * type-level guarantees back inside the local loop.
 *
 * `@ts-expect-error` IS the assertion here, which is this repo's existing idiom
 * (`subject-cmp.test.ts`, `sources.test.ts`): an UNUSED `@ts-expect-error` is
 * itself a compile error, so deleting the guard the directive documents turns
 * `bun run type` red. That is what makes a type-level barrier falsifiable at
 * all — nothing at runtime can observe it.
 */

import { describe, expect, test } from "bun:test";
import { approveAliasEdge, type ArrivingAliasEdge } from "@atlas/api/lib/brain/vocabulary";
import type { VocabularyExecutor } from "@atlas/api/lib/brain/vocabulary";

/** Never called — every assertion in this file is settled by the compiler. */
const unusedExecutor = { query: async () => ({ rows: [] }) } satisfies VocabularyExecutor;

describe("approveAliasEdge refuses a row-copy edge (⚠️ the `@ts-expect-error` IS the assertion)", () => {
  test("an ArrivingAliasEdge cannot be approved, because approval would re-date it", () => {
    // The mistake this makes unrepresentable is silent and permanent.
    // `ArrivingAliasEdge extends AliasEdgeInput`, so without the
    // `approvedAt?: never` barrier on the parameter this call type-checks
    // perfectly — and `approveAliasEdge`'s INSERT omits `approved_at`, so the
    // column falls to its `now()` default. Every migrated human decision would
    // be re-dated to the migration, which is exactly what ADR-0037 §8's
    // row-copy rule exists to prevent, reached through the one door that looks
    // like it belongs.
    //
    // Nothing at runtime can catch it: the write succeeds, the timestamp is
    // plausible, and the original is deleted at the source after the grace
    // period. The compiler is the only detector, so the guard needs the only
    // kind of test a compiler-enforced guard can have.
    const arriving: ArrivingAliasEdge = {
      position: "predicate",
      fromNorm: "price",
      toNorm: "cost",
      approvedBy: "source-admin",
      approvedAt: "2026-01-02T03:04:05.000Z",
    };

    // @ts-expect-error #5036 — a row-copy edge must not go through the approval path
    const refused = () => approveAliasEdge(unusedExecutor, "ws", arriving);
    void refused;

    // The control: the same call WITHOUT the carried timestamp is legal, so the
    // barrier refuses the row-copy shape specifically rather than refusing
    // everything. Without this, deleting `approvedAt` from `ArrivingAliasEdge`
    // would satisfy the directive above for the wrong reason.
    const allowed = () =>
      approveAliasEdge(unusedExecutor, "ws", {
        position: "predicate",
        fromNorm: "price",
        toNorm: "cost",
        approvedBy: "an-admin",
      });
    void allowed;

    // One runtime assertion so the case is not a no-op body — the compile-time
    // claims above are the point, and this keeps the test honest about that.
    expect(arriving.approvedAt).toBe("2026-01-02T03:04:05.000Z");
  });
});
