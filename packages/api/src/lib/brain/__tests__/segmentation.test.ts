/**
 * The tension scan's REACH, in the fast lane (#5438).
 *
 * ## Why a lexical suite exists beside a behavioural one
 *
 * The real proof that `segmentation.ts` recognizes the #5438 pair is
 * `identity-consumers-pg.test.ts` — the corpus entry `series-b-segmentation-drift`
 * run through the actual stage against an actual Postgres, with
 * `series-anchor-unrelated` and `series-anchor-token-boundary` as its two
 * falsifiers. That file SKIPS without `TEST_DATABASE_URL`, which is the default
 * local run, so on a developer's machine the entire change would otherwise be
 * unfalsified. `reconcile.test.ts` records the same reasoning for the arms it
 * pins lexically, in those words: *"without these assertions the revert is green
 * on a default local run."*
 *
 * So this file asserts the SHAPE of the SQL and the two statements that carry
 * it. It cannot tell you the rule is right — only that the rule is still there.
 * Do not read a green run here as covering the behaviour.
 *
 * ## What is deliberately NOT here
 *
 * No TypeScript twin of the predicate. `identity.ts` has one twin (migration
 * 0187's SQL `lexicalNorm`) and it costs a whole pinning suite to keep the two
 * honest, justified there because the backfill genuinely has to compute the same
 * function in two places. Nothing computes this reach outside the two
 * statements, so a twin would be an oracle agreeing with itself while adding a
 * second thing to keep true.
 */

import { describe, expect, test } from "bun:test";
import {
  exactSlotFirstSql,
  exactSlotSql,
  subjectAnchorSql,
  tensionReachSql,
} from "@atlas/api/lib/brain/segmentation";
import {
  CORROBORATION_LOOKUP_SQL,
  TENSION_CANDIDATES_SQL,
} from "@atlas/api/lib/brain/reconcile";
import { TENSION_SWEEP_SQL } from "@atlas/api/lib/brain/tension-sweep";
import { cardinalitySingleSql } from "@atlas/api/lib/brain/cardinality";

/** Whitespace-insensitive containment — the builders wrap and indent. */
const flat = (sql: string): string => sql.replace(/\s+/g, " ");

describe("subjectAnchorSql — the anchor, and the boundary that bounds it", () => {
  test("admits an exact match and a whole-token prefix in BOTH directions", () => {
    const sql = flat(subjectAnchorSql("a.subject_key", "b.subject_key"));
    expect(sql).toContain("a.subject_key = b.subject_key");
    // Both directions, because the drift can put the longer subject on either
    // side: `reconcile.ts` binds the INCOMING claim and scans stored rows, and
    // whether the extractor absorbed the word this time or last time is not
    // something either statement can know.
    expect(sql).toContain("starts_with(a.subject_key, b.subject_key || ' ')");
    expect(sql).toContain("starts_with(b.subject_key, a.subject_key || ' ')");
  });

  test("⚠️ the token boundary is a literal space, and it is not optional", () => {
    // `series b` IS a character prefix of `series bridge` and is NOT a
    // whole-token one. Without the `|| ' '` a bridge round becomes a rival of
    // the Series B on every claim either carries. `lexicalNorm` collapses every
    // separator run to exactly one space and trims the edges, so one literal
    // space is the whole boundary vocabulary.
    //
    // The behavioural falsifier is the corpus entry
    // `series-anchor-token-boundary`; this is the lexical backstop for the lane
    // where that entry does not run.
    const sql = subjectAnchorSql("x", "y");
    expect(sql).toContain("|| ' '");
    expect(sql.match(/\|\| ' '/g) ?? []).toHaveLength(2);
  });

  test("⚠️ starts_with, never LIKE — a subject key may contain a % ", () => {
    // `%` and `_` are LIKE metacharacters. `_` cannot survive `lexicalNorm`
    // (it is a separator); `%` can — `50% owner` norms to `50% owner` — and
    // under `LIKE` it would match anything. `starts_with` has no pattern
    // semantics at all, so the test is exact rather than approximate.
    const sql = subjectAnchorSql("x", "y");
    expect(sql).toContain("starts_with(");
    expect(sql).not.toContain("LIKE");
    expect(sql).not.toContain("~");
  });

  test("parenthesized, so an OR arm cannot re-widen an enclosing AND chain", () => {
    // `comparableDifferentSql`'s rule, in the mirror-image case it warns about:
    // these arms are all `OR`, and spliced unparenthesized into an `AND` chain
    // the `OR` binds looser than the conjunction and admits everything.
    const sql = subjectAnchorSql("x", "y");
    expect(sql.startsWith("(")).toBe(true);
    expect(sql.endsWith(")")).toBe(true);
  });
});

describe("tensionReachSql — two arms, and which is which", () => {
  const side = (p: string) => ({
    subjectKeyExpr: `${p}.subject_key`,
    predicateKeyExpr: `${p}.predicate_key`,
    episodeIdExpr: `${p}.source_episode_id`,
  });

  test("the EXACT slot survives untouched — nothing that earned an edge stops", () => {
    // The non-regression half, and the one worth asserting first: #5438 ADDS
    // recall, it does not trade any away. Same-episode rivals in a shared slot
    // have earned an edge since #4912 and still must.
    const sql = flat(tensionReachSql(side("a"), side("b")));
    expect(sql).toContain(
      "(a.subject_key = b.subject_key AND a.predicate_key = b.predicate_key)",
    );
  });

  test("⭐ the ANCHOR arm carries NO predicate test — that is the whole change", () => {
    // The #5438 pair diverged at BOTH slot arms: `series b` / `target raise`
    // against `series b fundraise` / `has goal of`. Re-introducing a predicate
    // comparison on this arm restores the silence the issue is about.
    const sql = flat(tensionReachSql(side("a"), side("b")));
    const anchorArm = sql.slice(sql.indexOf("OR ("));
    expect(anchorArm).toContain("starts_with(");
    expect(anchorArm).not.toContain("predicate_key");
  });

  test("⚠️ the different-episode arm belongs to the ANCHOR arm, not to the pair", () => {
    // Hoisting it to the top of the conjunction is the obvious tidy-up and it
    // silently removes same-episode rivals from the EXACT slot — a behaviour
    // change wearing a refactor's clothes, which subtracts edges and so would
    // be reported by nothing downstream.
    const sql = flat(tensionReachSql(side("a"), side("b")));
    const exactArm = sql.slice(0, sql.indexOf("OR ("));
    expect(exactArm).not.toContain("source_episode_id");
    expect(sql.slice(sql.indexOf("OR ("))).toContain(
      "a.source_episode_id <> b.source_episode_id",
    );
  });

  test("`<>` on the episode, never IS DISTINCT FROM — a NULL must fail CLOSED", () => {
    // A NULL on either side makes the arm unknown, a WHERE reads that as false,
    // and the pair falls back to the exact slot. `IS DISTINCT FROM` would make
    // a NULL episode read as "a different episode" and admit the pair, which is
    // the widening direction for a widening arm.
    const sql = tensionReachSql(side("a"), side("b"));
    expect(sql).not.toContain("IS DISTINCT FROM");
    expect(flat(sql)).toContain("<>");
  });
});

describe("exactSlotFirstSql — the cap must not turn a widening into a subtraction", () => {
  const slot = (p: string) => ({
    subjectKeyExpr: `${p}.subject_key`,
    predicateKeyExpr: `${p}.predicate_key`,
  });

  test("⭐ ranks the exact slot first, on the SAME test the first arm admits on", () => {
    // `TENSION_EDGE_CAP` is 10 and both statements are `ORDER BY … LIMIT`, so
    // the cap bites on the candidate set — which the anchor arm makes strictly
    // larger. Without this term a subject anchor with more than ten live claims
    // can fill the cap with newer anchor-only rivals and push out the exact-slot
    // rival that earned an edge before #5438: a regression that removes a true
    // contradiction from the review queue and that nothing would report, since a
    // missing advisory edge looks exactly like agreement.
    const rank = exactSlotFirstSql(slot("a"), slot("b"));
    expect(rank).toBe(
      "(a.subject_key = b.subject_key AND a.predicate_key = b.predicate_key) DESC",
    );
    // The ranking is only correct while it ranks on the same test the arm
    // admits on, so assert they agree rather than trusting two spellings.
    const reachSide = (p: string) => ({ ...slot(p), episodeIdExpr: `${p}.source_episode_id` });
    expect(flat(tensionReachSql(reachSide("a"), reachSide("b")))).toContain(
      rank.replace(" DESC", ""),
    );
  });

  test("both statements take THIS term at the HEAD of the ORDER BY", () => {
    // At the head, so the sweep's `id` tiebreak in the TAIL — which its header
    // documents as a deliberate difference from the ingest path — is unaffected.
    //
    // ⚠️ Asserts the BUILT string, not merely that some `DESC` precedes
    // `ingested_at`. The weaker form stayed green when the head term was
    // replaced by any other `X DESC`, which is the same "green against a
    // property it cannot see" failure the sibling test above avoids by
    // comparing against the builder's own output rather than a retyped literal.
    const cases: readonly (readonly [string, string])[] = [
      [
        TENSION_CANDIDATES_SQL,
        exactSlotFirstSql(
          { subjectKeyExpr: "subject_key", predicateKeyExpr: "predicate_key" },
          { subjectKeyExpr: "$2", predicateKeyExpr: "$3" },
        ),
      ],
      [
        TENSION_SWEEP_SQL,
        exactSlotFirstSql(
          { subjectKeyExpr: "b.subject_key", predicateKeyExpr: "b.predicate_key" },
          { subjectKeyExpr: "a.subject_key", predicateKeyExpr: "a.predicate_key" },
        ),
      ],
    ];
    for (const [sql, rank] of cases) {
      const order = flat(sql.slice(sql.indexOf("ORDER BY")));
      expect(order).toContain(flat(rank));
      // …and it leads: nothing else sorts before it.
      expect(order.indexOf(flat(rank))).toBe("ORDER BY ".length);
      expect(order.indexOf(flat(rank))).toBeLessThan(order.indexOf("ingested_at"));
    }
  });
});

describe("both tension statements carry the reach — and no other consumer does", () => {
  const reach = flat(
    tensionReachSql(
      {
        subjectKeyExpr: "subject_key",
        predicateKeyExpr: "predicate_key",
        episodeIdExpr: "source_episode_id",
      },
      { subjectKeyExpr: "$2", predicateKeyExpr: "$3", episodeIdExpr: "$9::uuid" },
    ),
  );

  test("the ingest scan is built from the shared builder, at the documented binds", () => {
    // The bind numbers are the footgun `reconcile.ts`'s header names: the
    // statement spreads `agreementBinds` in the MIDDLE of its list, so `$9` is
    // appended after the cap and a tenth bind goes after IT.
    expect(flat(TENSION_CANDIDATES_SQL)).toContain(reach);
    // Still true after the widening, and pinned in `reconcile.test.ts` too:
    // the exact arm is unchanged, so the pivot onto slot keys (#5020) is
    // asserted by the same literals it always was.
    expect(TENSION_CANDIDATES_SQL).toContain("subject_key = $2");
    expect(TENSION_CANDIDATES_SQL).toContain("predicate_key = $3");
  });

  test("the SWEEP replays the same rule rather than a second spelling of it", () => {
    // `tension-sweep.ts`'s header: two spellings of "what is in tension" is how
    // the sweep and the ingest path drift into flagging different pairs, and a
    // reviewer has no way to tell which one is right.
    expect(flat(TENSION_SWEEP_SQL)).toContain(
      flat(
        tensionReachSql(
          {
            subjectKeyExpr: "b.subject_key",
            predicateKeyExpr: "b.predicate_key",
            episodeIdExpr: "b.source_episode_id",
          },
          {
            subjectKeyExpr: "a.subject_key",
            predicateKeyExpr: "a.predicate_key",
            episodeIdExpr: "a.source_episode_id",
          },
        ),
      ),
    );
  });

  test("⭐ CORROBORATION keeps the exact slot — the arm must never leak there", () => {
    // The load-bearing prohibition. Corroboration is the one identity consumer
    // with no grant arm and no cardinality arm: a merge attaches a public
    // episode as evidence to a private fact and publish then widens the private
    // claim's grant to the union, which discloses the claim's BODY
    // (`subject-cmp.ts`). The reach's licence is that a tension edge is
    // advisory; nothing about that argument transfers here.
    expect(CORROBORATION_LOOKUP_SQL).toContain("subject_key = $2");
    expect(CORROBORATION_LOOKUP_SQL).toContain("predicate_key = $3");
    expect(CORROBORATION_LOOKUP_SQL).not.toContain("starts_with(");
    expect(CORROBORATION_LOOKUP_SQL).not.toContain("source_episode_id");
  });

  test("neither tension statement acquired an UPDATE on the way", () => {
    // `reconcile.test.ts` asserts this over every statement the stage issues.
    // Repeated for the two this change edited, because a widening that reached
    // a stamp is the one failure the whole module argues cannot happen here.
    expect(TENSION_CANDIDATES_SQL).not.toMatch(/\bUPDATE\b/i);
    expect(TENSION_SWEEP_SQL).not.toMatch(/\bUPDATE\s+brain_facts\b/i);
    expect(TENSION_CANDIDATES_SQL).not.toContain("valid_to =");
    expect(TENSION_SWEEP_SQL).not.toContain("valid_to =");
  });
});

describe("⭐ the anchor arm's coverage bound on the correction lane (#5467)", () => {
  /**
   * The gate as `reconcile.ts` builds it: the workspace's approved entry for the
   * INCOMING claim's predicate (`$3`), read off the scanned row's workspace.
   *
   * Built from `cardinalitySingleSql` rather than retyped, for the reason this
   * file already gives about `exactSlotFirstSql`: a hand-written copy would be a
   * second spelling that could agree with itself while disagreeing with the
   * sweep, and the sweep is the whole reason the gate is this expression.
   */
  const gate = flat(cardinalitySingleSql("f", "$3"));

  const exactArm = flat(
    exactSlotSql(
      { subjectKeyExpr: "subject_key", predicateKeyExpr: "predicate_key" },
      { subjectKeyExpr: "$2", predicateKeyExpr: "$3" },
    ),
  );

  test("the ingest scan carries the APPROVED-entry gate the sweep already had", () => {
    // #5450 measured that "approved-predicate coverage" bounded the sweep lane
    // and nothing else; the correction lane minted a false prod edge
    // (`e78de65d`) with no cardinality entry anywhere in the loop. This is that
    // bound arriving on the ingest statement.
    expect(flat(TENSION_CANDIDATES_SQL)).toContain(gate);
    // …asking about the INCOMING claim's predicate. Binding the ROW's
    // `predicate_key` would ask whether some OTHER slot is single-valued, which
    // under the anchor arm is a different predicate every time — the gate would
    // then be answered by the rival rather than about the claim being scanned
    // for, and the sweep's `cardinalitySingleSql("a")` asks about its driving
    // side for exactly this reason.
    expect(flat(TENSION_CANDIDATES_SQL)).not.toContain(
      flat(cardinalitySingleSql("f", "f.predicate_key")),
    );
  });

  test("⭐ the EXACT SLOT is exempt — the bound is on the ANCHOR arm alone", () => {
    // The load-bearing half. A correction's `single` is an assertion about the
    // slot the human corrected, and that assertion is not what #5467 withdrew:
    // gating the whole scan would stop the correction lane minting the true
    // exact-slot edge it has minted since #4912, on every uncurated predicate —
    // which in a workspace that has curated nothing is every predicate. A
    // missing advisory edge is indistinguishable from agreement, so nothing
    // downstream would report the subtraction.
    //
    // Asserted as the STRUCTURE `(exact OR $10 OR gate)`, not merely as "both
    // strings appear": the statement already contains the exact arm twice (the
    // reach and the ORDER BY), so a containment pair stays green against a gate
    // that is ANDed on and subtracts the slot.
    const sql = flat(TENSION_CANDIDATES_SQL);
    expect(sql).toContain(`AND (${exactArm} OR $10::boolean OR ${gate})`);
  });

  test("the producer's own licence is the TENTH bind, after the episode", () => {
    // `reconcile.ts`'s `agreementBinds` docstring: the spread sits in the MIDDLE
    // of this statement's bind list, so every trailing placeholder moves when
    // the tuple widens. `$9` was appended after the cap for that reason and
    // `$10` after `$9` for the same one. A stale index here binds a comparable
    // value into `::boolean`, which pg rejects at runtime and no unit fake would
    // notice.
    expect(TENSION_CANDIDATES_SQL).toContain("$10::boolean");
    expect(TENSION_CANDIDATES_SQL.indexOf("$10")).toBeGreaterThan(
      TENSION_CANDIDATES_SQL.indexOf("$9"),
    );
    // `::boolean` and never a bare `$10`: the bind reaches an `OR` arm directly,
    // where an untyped parameter is one pg has to infer from context.
    expect(TENSION_CANDIDATES_SQL).not.toMatch(/\$10(?!::boolean)/);
  });

  test("⚠️ the SWEEP is untouched — it neither grew a bind nor lost its gate", () => {
    // The sweep's radius was already approved-predicate coverage. #5467 does not
    // change it, and the two statements must still agree about what "in tension"
    // means — `tensionReachSql`'s output is byte-identical at both call sites
    // precisely because the gate went BESIDE the reach rather than inside it.
    expect(TENSION_SWEEP_SQL).not.toContain("$10");
    expect(flat(TENSION_SWEEP_SQL)).toContain(flat(cardinalitySingleSql("a")));
  });

  test("⚠️ CORROBORATION acquired no cardinality arm on the way past", () => {
    // `segmentation.ts` calls corroboration "the one consumer with no grant arm
    // and no cardinality arm". Adding one here would look conservative and be
    // the opposite: it would make a MERGE — the ACL-widening direction —
    // conditional on curation, which is not a bound anyone argued for.
    expect(CORROBORATION_LOOKUP_SQL).not.toContain("brain_predicate_cardinality");
  });
});
