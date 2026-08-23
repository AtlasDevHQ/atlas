import { describe, expect, test } from "bun:test";

import { reapStandDown } from "@atlas/api/lib/brain/observation-reap";

/**
 * The stand-down rule (#5388): the reaper deletes on evidence that a row LEFT,
 * never on a run that merely failed to represent it.
 *
 * These drive the pure decision only. That the decision is honoured — that the
 * excluded predicates reach the statement and the blind run issues none — is
 * `observation-reap-pg.test.ts`' and `warehouse-producer.test.ts`' half.
 */

/** A run that read rows and represented all of them. Overridden per case. */
const healthy = {
  rowsRead: 10,
  candidatePredicates: ["status", "plan"],
  blockedCandidates: 0,
  blockedByPredicate: new Map<string, number>(),
  unsurfaceableByDimension: new Map<string, number>(),
  unsurfaceableKeyRows: 0,
  collidingSubjectRows: 0,
  unidentifiedRows: 0,
} as const;

describe("reapStandDown — the blind-run arm", () => {
  test("a TRUNCATED table is not blind, and is the case the reaper exists for", () => {
    // Zero rows read is positive evidence of absence: the rows are gone. This is
    // migration 0206's motivating case and it must keep reaping.
    const decision = reapStandDown({ ...healthy, rowsRead: 0, candidatePredicates: [] });

    expect(decision.blind).toBe(false);
    expect(decision.predicates).toEqual([]);
  });

  test("rows read but every primary key unsurfaceable IS blind", () => {
    // The `status`-column-to-jsonb scenario applied to the KEY column. The rows
    // are present and counted; the run simply could not name them. Reaping here
    // deletes for a reason that never happened.
    const decision = reapStandDown({
      ...healthy,
      candidatePredicates: [],
      unsurfaceableKeyRows: 10,
    });

    expect(decision.blind).toBe(true);
  });

  test("rows whose cells are all NULL are NOT blind — they assert nothing now", () => {
    // ⚠️ The distinction that keeps this rule from becoming "stand down whenever
    // anything is imperfect". An absent cell is not a representation FAILURE: the
    // warehouse answered, and the answer was "nothing". That is a real change in
    // the world and the observations should age out.
    const decision = reapStandDown({ ...healthy, candidatePredicates: [] });

    expect(decision.blind).toBe(false);
    expect(decision.predicates).toEqual([]);
  });

  test("a run that represented SOMETHING is never blind", () => {
    const decision = reapStandDown({
      ...healthy,
      candidatePredicates: ["plan"],
      unsurfaceableKeyRows: 4,
    });

    expect(decision.blind).toBe(false);
  });
});

describe("reapStandDown — the per-dimension arm", () => {
  test("a wholly unsurfaceable dimension is excluded, and its siblings are not", () => {
    // #5388's worked example: someone alters `status` to jsonb. Every `status`
    // cell is unsurfaceable while `plan` keeps emitting, so the run succeeds,
    // represents plenty, and would otherwise reap every `status` observation and
    // the tension edges they carried against live human beliefs.
    const decision = reapStandDown({
      ...healthy,
      candidatePredicates: ["plan"],
      unsurfaceableByDimension: new Map([["status", 10]]),
    });

    expect(decision.blind).toBe(false);
    expect(decision.predicates).toEqual(["status"]);
  });

  test("ONE bad cell among good ones protects nothing", () => {
    // The issue's own argument against suppressing on the raw counter: a
    // per-entity aggregate lets a single bad cell pin the whole comparison
    // surface open. Scoping to "surfaced NOTHING" is what answers it.
    const decision = reapStandDown({
      ...healthy,
      candidatePredicates: ["status", "plan"],
      unsurfaceableByDimension: new Map([["status", 1]]),
    });

    expect(decision.predicates).toEqual([]);
  });

  test("several blind dimensions are all excluded", () => {
    const decision = reapStandDown({
      ...healthy,
      candidatePredicates: ["plan"],
      unsurfaceableByDimension: new Map([
        ["status", 10],
        ["tier", 10],
      ]),
    });

    expect([...decision.predicates].sort()).toEqual(["status", "tier"]);
  });

  test("a healthy run stands down for nothing", () => {
    const decision = reapStandDown(healthy);

    expect(decision.blind).toBe(false);
    expect(decision.predicates).toEqual([]);
  });

  test("a run that surfaced NOTHING and fenced something is always blind", () => {
    // ⚠️ The implication the zero-candidate producer arm rests on, pinned here
    // rather than left as a comment. That arm passes `predicates` to a reap it
    // only reaches when `blind` is false, and the bind is dead precisely because
    // these two cannot both be "no candidates" and "something fenced" without
    // `blind` being true. A mutation replacing that bind with `[]` survives every
    // test in the tree, which is what an equivalent mutant looks like — so the
    // thing worth testing is the implication, not the bind.
    //
    // Narrow `blind` and this goes red, which is the signal to re-examine that
    // call site rather than discover it three schema changes later.
    for (const count of [1, 5]) {
      const decision = reapStandDown({
        ...healthy,
        rowsRead: 5,
        candidatePredicates: [],
        unsurfaceableByDimension: new Map([["status", count]]),
      });

      expect(decision.predicates).toEqual(["status"]);
      expect(decision.blind, "something was fenced on a run that surfaced nothing, yet the reap would still fire").toBe(true);
    }
  });

  test("an episode blocked WHOLESALE is blind, though every candidate was built", () => {
    // The fourth warn-don't-refuse path (#5388). `reconcile.ts` sets
    // `blocked[reason] = candidates.length` when it refuses an episode entirely,
    // so the candidates exist, nothing is written, and no evidence edge is
    // minted for any of them. From the reap's side that is indistinguishable
    // from an entity that returned nothing — and reaping on it would empty the
    // comparison surface because reconcile refused to WRITE, not because
    // anything left.
    const decision = reapStandDown({ ...healthy, blockedCandidates: 2 });

    expect(decision.blind).toBe(true);
  });

  test("a PARTIAL block is no longer blind, and its dimension is held back instead", () => {
    // ⚠️ This case USED to assert the opposite, and the flip is #5396 rather
    // than a relaxed test. `report.blocked` is keyed by REASON, so a partial
    // block had no dimension-shaped answer to give and the unwritten
    // candidates' dimensions reaped — the narrowing #5388 stated and left open.
    // `reconcile.ts` now reports the same refusals keyed by predicate, so the
    // partial case moves out of `blind`, which is still wrong for it (the run
    // represented `plan` perfectly well), and into `predicates`, which is
    // exactly right.
    const decision = reapStandDown({
      ...healthy,
      blockedCandidates: 1,
      blockedByPredicate: new Map([["status", 1]]),
    });

    expect(decision.blind, "one refused candidate is not a blind run — `plan` was written").toBe(
      false,
    );
    expect(decision.predicates).toEqual(["status"]);
  });

  test("a dimension that had ANY candidate written keeps reaping", () => {
    // The direct analogue of the `unsurfaceableByDimension` arm's rule, and the
    // answer to "one refusal protects everything". Two `status` candidates were
    // built and one was refused: the dimension surfaced, earned an evidence
    // edge, and its loss is ROW-shaped rather than dimension-shaped. A reaper
    // that stands down whenever anything is imperfect never runs on the
    // workspaces that need it most.
    const decision = reapStandDown({
      ...healthy,
      candidatePredicates: ["status", "status", "plan"],
      blockedCandidates: 1,
      blockedByPredicate: new Map([["status", 1]]),
    });

    expect(decision.blind).toBe(false);
    expect(decision.predicates).toEqual([]);
  });

  test("a refusal for a dimension that built NOTHING holds nothing back", () => {
    // Fail-safe on the join between the two sides. The producer counts what it
    // built and reconcile counts what it refused; a predicate present only on
    // the refusal side cannot have gone unrepresented BY THIS RUN, so holding it
    // back would fence a dimension off the delete on no evidence at all.
    const decision = reapStandDown({
      ...healthy,
      blockedCandidates: 1,
      blockedByPredicate: new Map([["tier", 1]]),
    });

    expect(decision.blind).toBe(false);
    expect(decision.predicates).toEqual([]);
  });

  test("a wholesale block stays BLIND rather than degrading to the per-dimension arm", () => {
    // #5396 must not move the wholesale case out of `blind`. Every candidate is
    // refused, so every dimension is also individually held back — but `blind`
    // is the stronger statement and the one that stops the reap issuing at all,
    // and a run that reaped "only the dimensions it built" would still delete
    // every observation of a dimension this run never mentioned.
    const decision = reapStandDown({
      ...healthy,
      blockedCandidates: 2,
      blockedByPredicate: new Map([
        ["status", 1],
        ["plan", 1],
      ]),
    });

    expect(decision.blind).toBe(true);
    expect([...decision.predicates].sort()).toEqual(["plan", "status"]);
  });

  test("colliding subjects alone exclude no dimension", () => {
    // A collision drops the ROW, not a dimension, and the dropped row's other
    // observations are equally unrepresented. It is caught by the blind arm when
    // it takes every row and by nothing when it does not — deliberately, because
    // there is no dimension-shaped answer to give.
    const decision = reapStandDown({ ...healthy, collidingSubjectRows: 3 });

    expect(decision.blind).toBe(false);
    expect(decision.predicates).toEqual([]);
  });
});
