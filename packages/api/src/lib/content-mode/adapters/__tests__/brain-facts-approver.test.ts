/**
 * **Both promote arms stamp the approver, and both stamp the date** (#5635).
 *
 * `brain_facts.published_by` is the column the product claim rests on: an
 * answer states its source, its date, and the name of the person who approved
 * it. The first two were already backed; the third was not, and
 * `provenance.attribution` was being read as if it answered it. It does not —
 * attribution names who SAID a thing, and the approver is who stood behind it.
 *
 * ## Why this file tests the two arms against each other
 *
 * `promoteBrainFacts` partitions one publish between two statements:
 * `PROMOTE_FACTS_SQL` for drafts whose grant does not widen, and
 * `WIDEN_AND_PROMOTE_FACTS_SQL` for those whose does. A column stamped by only
 * one arm is therefore a column ABSENT FROM EXACTLY THE FACTS WHOSE ACL
 * CHANGED — and silent, because such a fact looks published everywhere else.
 *
 * That is not hypothetical. `published_at` sat in that position from #5591
 * until #5635: set by the plain arm, never by the widening one. It never
 * surfaced only because no fact widened on a serving region in that window (us
 * prod when #5635 was written: 40 published, 27 stamped, and all 13 unstamped
 * predating the column). The assertions below are written as "both arms, both
 * columns" rather than as two independent cases so that adding a third
 * approval-time column to one statement fails here.
 */

import { describe, expect, it } from "bun:test";
import { Effect } from "effect";

import {
  DRAFT_FACTS_SQL,
  PROMOTE_FACTS_SQL,
  WIDEN_AND_PROMOTE_FACTS_SQL,
  promoteBrainFacts,
} from "../brain-facts";
import type { ModeTxClient, PublishPhaseError } from "../../port";

const WORKSPACE = "ws-approver";
const APPROVER = "user-priya";

/** One draft that will widen (evidence carries a broader grant) and one that will not. */
const DRAFTS = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    subject: "NovaMart",
    predicate: "has return window of",
    object: "30 days",
    source_episode_id: "aaaaaaaa-1111-4111-8111-111111111111",
    provenance: { source: "slack" },
    visible_to: ["audience:finance"],
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    subject: "NovaMart",
    predicate: "ships from",
    object: "Rotterdam",
    source_episode_id: "aaaaaaaa-2222-4222-8222-222222222222",
    provenance: { source: "slack" },
    visible_to: ["org"],
  },
] as const;

/** Evidence that widens the FIRST draft only, so both arms fire in one run. */
const EVIDENCE = [
  {
    fact_id: DRAFTS[0].id,
    episode_id: DRAFTS[0].source_episode_id,
    visible_to: ["org"],
  },
];

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function txOver(): { tx: ModeTxClient; calls: Call[] } {
  const calls: Call[] = [];
  const tx: ModeTxClient = {
    query: async (sql, params = []) => {
      // Locks and savepoints are plumbing; recording them would make the
      // assertions below depend on statement order they do not care about.
      if (/advisory|SAVEPOINT|ROLLBACK TO SAVEPOINT|SET LOCAL/i.test(sql)) return { rows: [] };
      calls.push({ sql, params });
      if (sql === DRAFT_FACTS_SQL) return { rows: [...DRAFTS] };
      if (sql === PROMOTE_FACTS_SQL) {
        return { rows: [], rowCount: (params[1] as readonly string[]).length };
      }
      if (sql === WIDEN_AND_PROMOTE_FACTS_SQL) {
        return { rows: [], rowCount: (JSON.parse(String(params[1])) as unknown[]).length };
      }
      if (sql.includes("brain_edges")) {
        const offered = params[1] as readonly string[];
        return { rows: EVIDENCE.filter((row) => offered.includes(row.fact_id)) };
      }
      if (sql.includes("held_back")) return { rows: [{ held_back: 0 }] };
      // Every other read in the phase (supersession targets, counts) is empty
      // for this fixture: neither draft collides with a published rival.
      return { rows: [], rowCount: 0 };
    },
  };
  return { tx, calls };
}

const run = <A>(e: Effect.Effect<A, PublishPhaseError, never>) => Effect.runPromise(e);

function promoteCalls(calls: readonly Call[]) {
  const plain = calls.find((c) => c.sql === PROMOTE_FACTS_SQL);
  const widen = calls.find((c) => c.sql === WIDEN_AND_PROMOTE_FACTS_SQL);
  return { plain, widen };
}

describe("the approver reaches both promote arms (#5635)", () => {
  it("binds the approver as $3 on the plain arm AND the widening arm", async () => {
    const { tx, calls } = txOver();
    await run(promoteBrainFacts(tx, WORKSPACE, undefined, APPROVER));
    const { plain, widen } = promoteCalls(calls);

    // Both arms must have fired, or this test would pass vacuously on a
    // fixture where only one partition is non-empty.
    expect(plain).toBeDefined();
    expect(widen).toBeDefined();
    expect(plain?.params[2]).toBe(APPROVER);
    expect(widen?.params[2]).toBe(APPROVER);
  });

  it("binds null rather than a stand-in when the caller names nobody", async () => {
    // The region import is the real caller here: it restores a decision made in
    // another region by a person this row cannot identify. NULL means "not
    // attributable", which is true; any default would be a lie with a
    // plausible shape.
    const { tx, calls } = txOver();
    await run(promoteBrainFacts(tx, WORKSPACE));
    const { plain, widen } = promoteCalls(calls);
    expect(plain?.params[2]).toBeNull();
    expect(widen?.params[2]).toBeNull();
  });

  it("stamps published_at on BOTH statements — the gap #5635 closed", () => {
    // Asserted on the SQL text, not on a call: the widening arm set `status`
    // without `published_at` from #5591 until #5635, and a fixture cannot
    // observe a column a statement never names.
    for (const sql of [PROMOTE_FACTS_SQL, WIDEN_AND_PROMOTE_FACTS_SQL]) {
      expect(sql).toContain("published_at = now()");
      expect(sql).toContain("published_by = $3");
      expect(sql).toContain("status = 'published'");
    }
  });

  it("keeps the draft predicate on both arms, so a re-run cannot move a stamp", () => {
    // The predicate is what makes "the approver of an already-published fact is
    // never overwritten by whoever ran a later publish" unreachable rather than
    // merely unlikely.
    for (const sql of [PROMOTE_FACTS_SQL, WIDEN_AND_PROMOTE_FACTS_SQL]) {
      expect(sql).toContain("status = 'draft'");
    }
  });
});
