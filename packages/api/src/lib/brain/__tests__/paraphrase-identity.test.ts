/**
 * What the identity layer does with claims the REAL extractor produced (#5041,
 * ADR-0037 §9) — the consuming half of the loop `eval/brain-paraphrase/` opens.
 *
 * Every surface asserted here came out of a model. The eval lane
 * (`packages/cli/bin/brain-paraphrase-eval.ts`) drives `llmFactExtractor` over
 * human-authored MESSAGES and records what it emitted; this file reads that
 * recording. Nothing below makes a model call, and nothing below chose a
 * predicate.
 *
 * ## Why that direction is the whole point
 *
 * A corpus whose predicate side is hand-authored cannot falsify an identity
 * rule: the author picks two spellings they already believe should collide, and
 * the test then agrees with the belief rather than with the world. #5000 shipped
 * through exactly that gap — three consumers, three private fixture sets, one
 * hardcoded predicate string in each, and no test anywhere that could see two
 * different phrasings of one claim, because no fixture contained two.
 *
 * ## Every prohibition here is paired with a positive control
 *
 * ADR-0037 §9's rule, and the reason this file is longer than its assertions:
 * a prohibition passes green against machinery that does nothing at all. Each
 * `does not collide` test has a sibling naming the pair that DOES, over the same
 * recording, in a SEPARATE `test()` block — separate so that a broken control
 * cannot mask the prohibition it licenses by failing first inside one body.
 *
 * ## What this file deliberately does NOT do
 *
 * It does not re-derive the three-valued agreement rule. That rule lives in SQL
 * (`comparableDifferentSql`) and `identity-consumers-pg.test.ts` owns it against
 * a real database. Restating it here in TypeScript would be an oracle agreeing
 * with itself. What this file asserts is the INPUT to that rule — the comparable
 * values the recorded objects produce — which is a fact about the parser and the
 * recording, not about the join.
 *
 * ## ⚠️ It cannot falsify `lexicalNorm`, and that was MEASURED
 *
 * Four mutations, run against this file at the commit that added it:
 *
 *   | mutation | tests killed |
 *   |---|---|
 *   | `slotKey` ignores its `alias` argument | 2 |
 *   | `comparableValue` always abstains | 2 |
 *   | the vocabulary leaks across slot positions | 1 |
 *   | **`lexicalNorm` stops case-folding** | **0** |
 *   | **`lexicalNorm` stops collapsing separators** | **0** |
 *
 * The two zeroes are a property of the corpus rather than a hole to be patched.
 * The extractor is instructed to emit short lowercase verb phrases and it obeys,
 * so almost every recorded surface arrives already at normal form — there is
 * nothing for the case arm or the separator arm to do. `Deploy Window` /
 * `deploy_window` is a shape a HUMAN writes, and `identity-corpus.ts` +
 * `identity.test.ts` are where it is exercised, deliberately, by hand.
 *
 * That is the strongest available argument against retiring the hand-authored
 * corpus in favour of this one: a machine-produced corpus can only ever exercise
 * the variance the machine happens to produce. Do not read a green run here as
 * covering the lexical layer.
 */

import { describe, expect, test } from "bun:test";

import {
  identityKey,
  identityVocabulary,
  slotKey,
  type AliasLookup,
  type ClaimVocabulary,
} from "@atlas/api/lib/brain/identity";
import { comparableTag, comparableValue } from "@atlas/api/lib/brain/object-cmp";

import {
  corpusDigest,
  loadMessages,
  loadRecordedArtifact,
  soleClaim,
  type RecordedTriple,
} from "./paraphrase-corpus";

const artifact = loadRecordedArtifact();
const messages = loadMessages();

/**
 * A claim's SLOT — subject and predicate. The object is the VALUE in that slot,
 * not part of it: that is the shape of all three consumers, which join on
 * `subject_key = … AND predicate_key = …` and then ask a separate question about
 * the object.
 */
function slotOf(
  claim: RecordedTriple,
  vocabulary: ClaimVocabulary,
): { subject: string | null; predicate: string | null } {
  return {
    subject: slotKey(claim.subject, vocabulary.subject),
    predicate: slotKey(claim.predicate, vocabulary.predicate),
  };
}

function sameSlot(a: RecordedTriple, b: RecordedTriple, vocabulary: ClaimVocabulary): boolean {
  const left = slotOf(a, vocabulary);
  const right = slotOf(b, vocabulary);
  // A null key means the surface normalized away and the claim asserts nothing —
  // it has no slot to share, so it can never be "the same slot" as anything,
  // including another null. Without this arm two unkeyable claims would compare
  // equal and read as one belief, which is migration 0187's `DEFAULT ''` hazard
  // reached through a test helper.
  if (left.subject === null || left.predicate === null) return false;
  return left.subject === right.subject && left.predicate === right.predicate;
}

/** Both sides of a pair, as the extractor emitted them. */
function pair(id: string): { a: RecordedTriple; b: RecordedTriple } {
  return { a: soleClaim(artifact, id, "a"), b: soleClaim(artifact, id, "b") };
}

/**
 * A vocabulary with ONE approved predicate alias, derived from the recording.
 *
 * ⚠️ The two norms come out of the artifact, never out of this file — mapping a
 * hand-typed `"is priced at"` onto a hand-typed `"priced at"` would be the
 * agrees-by-construction trap re-entering through the control rather than the
 * prohibition. What a human decides here is only THAT the two recorded
 * predicates name one relation, which is the decision ADR-0037 §6 reserves for a
 * reviewer at the vocabulary queue.
 */
function withPredicateAlias(from: string, to: string): ClaimVocabulary {
  const fromNorm = identityKey(from);
  const toNorm = identityKey(to);
  if (fromNorm === null || toNorm === null) {
    throw new Error(
      `cannot build an alias between "${from}" and "${to}": one of them normalizes away, ` +
        `so the recording is not what this test believes it is.`,
    );
  }
  const alias: AliasLookup = (norm) => (norm === fromNorm ? toNorm : norm);
  // Position-scoped, which is the point of the record shape (#5022): the alias
  // is installed at the PREDICATE and the other two positions keep the identity
  // lookup. `identityVocabulary` supplies them, so a future edit that spread one
  // lookup across all three has to delete this line to do it.
  return { ...identityVocabulary, predicate: alias };
}

describe("the recorded fixture is what it claims to be", () => {
  test("it was recorded from the message corpus currently in the tree", () => {
    // The one check that catches an edited message with a stale recording, and
    // it needs no model call. A mismatch means someone changed what the
    // extractor is shown and did not re-run the eval — so every triple below
    // was produced from text that is no longer here.
    expect(artifact.corpusDigest).toBe(corpusDigest(messages));
  });

  test("every message pair has a recording, and the artifact carries no orphan", () => {
    const corpusIds = messages.pairs.map((p) => p.id).sort();
    const recordedIds = Object.keys(artifact.pairs).sort();
    expect(recordedIds).toEqual(corpusIds);
  });

  test("it names the model and the extractor version that produced it", () => {
    // Provenance is what makes a regenerated fixture reviewable: the diff has to
    // say whether the surfaces moved because the model changed or because the
    // extractor did. Asserted non-empty rather than pinned to a literal — the
    // model id is `eval-llm.yml`'s to choose, and pinning it here would make a
    // deliberate model change fail in a file that has no opinion about it.
    expect(artifact.model.length).toBeGreaterThan(0);
    expect(artifact.extractor).toBe("extraction:v1");
  });
});

describe("the extractor's phrasing variance is real", () => {
  // The premise the whole deterministic half rests on. If the extractor emitted
  // one canonical predicate for every phrasing, #5000 would not exist and none
  // of the prohibitions below would mean anything.
  test("one claim, told twice, produced two DIFFERENT predicate surfaces", () => {
    const { a, b } = pair("price-copula");
    expect(a.predicate).not.toBe(b.predicate);
    // Not merely different bytes — different after normalization, so the gap is
    // semantic and not a case or separator difference `lexicalNorm` would fold.
    expect(identityKey(a.predicate)).not.toBe(identityKey(b.predicate));
  });

  test("positive control: the recorder is not simply reporting difference", () => {
    // `price-object-phrasing` states one price two ways and the extractor chose
    // the SAME predicate for both. Without this, "the predicates differ" is
    // satisfied by a recorder that never writes two equal strings — including
    // one that had started recording a uuid.
    const { a, b } = pair("price-object-phrasing");
    expect(a.predicate).toBe(b.predicate);
  });

  test("small talk produced no claim at all", () => {
    // The extractor's own positive control, in the other direction. An extractor
    // that had silently stopped working returns an empty list for EVERYTHING,
    // which satisfies every prohibition in this file while proving nothing —
    // so `soleClaim` above throws on an empty side, and this asserts the one
    // pair where empty is the right answer.
    const sides = artifact.pairs["small-talk"];
    expect(sides).toBeDefined();
    expect(sides?.a).toEqual([]);
    expect(sides?.b).toEqual([]);
  });
});

describe("what the lexical layer does with machine-produced paraphrase", () => {
  /**
   * ⚠️ THE GAP, AS AN EXACT SET — this is #5000, in the tree, produced by the
   * real extractor rather than argued about.
   *
   * Every id below is a pair a human reads as ONE claim and the identity layer
   * files in TWO slots, so corroboration never fires: Atlas records a second
   * belief where it already held the first, and the reviewer sees two uncontested
   * facts. The set is asserted exactly, in both directions. Shrinking it — a
   * vocabulary entry, a better extractor — fails this test, and it should: that
   * is a change to what Atlas believes, and it deserves a deliberate edit here
   * rather than a quietly greener run.
   */
  test("these one-claim pairs do NOT share a slot, and that is the defect", () => {
    const oneClaimPairs = messages.pairs
      .filter((p) => p.relation === "same-claim")
      .map((p) => p.id);
    const gap = oneClaimPairs.filter((id) => {
      const { a, b } = pair(id);
      return !sameSlot(a, b, identityVocabulary);
    });
    expect(gap).toEqual(["price-copula", "manager-phrasing", "schedule-phrasing"]);
  });

  test("positive control: a one-claim pair that DOES share a slot", () => {
    // Without this, "the paraphrase pairs do not share a slot" passes against a
    // `slotKey` returning a fresh value for every call — including `null`, which
    // `sameSlot` reads as "no slot" for both sides. The layer has to be shown
    // agreeing about something before its refusals mean anything.
    const { a, b } = pair("price-object-phrasing");
    expect(sameSlot(a, b, identityVocabulary)).toBe(true);
  });

  test("the gap is not only at the predicate — an article splits the subject too", () => {
    // `schedule-phrasing` is in the gap set above for TWO reasons, and the
    // second is easy to miss: the extractor wrote `The deploy job` on one side
    // and `deploy job` on the other. `lexicalNorm` folds case and separators, and
    // a definite article is neither — so a vocabulary entry at the predicate
    // alone would not close this pair. Pinned because a reader who fixed the
    // predicate half would otherwise expect it to move.
    const { a, b } = pair("schedule-phrasing");
    expect(identityKey(a.subject)).not.toBe(identityKey(b.subject));
  });

  test("a contradiction phrased two ways is invisible to the rival scan", () => {
    // ⭐ #5000's live shape. The two claims disagree about the price of one
    // product — and because the extractor phrased the relationship differently
    // on each side, they do not land in one slot, so nothing compares them and
    // no tension edge is ever written. The bug is not that Atlas resolves the
    // contradiction wrongly; it is that Atlas cannot see there is one.
    const { a, b } = pair("price-contradiction");
    expect(identityKey(a.subject)).toBe(identityKey(b.subject));
    expect(sameSlot(a, b, identityVocabulary)).toBe(false);
  });

  test("positive control: a contradiction the layer CAN see", () => {
    // Same disagreement, and here the extractor happened to phrase the
    // relationship identically — so the pair reaches one slot and the rival scan
    // has something to compare. This is what the pair above would look like if
    // the phrasing had gone the other way, which is the whole reason #5000 is
    // intermittent rather than total.
    const { a, b } = pair("price-comparable-contradiction");
    expect(sameSlot(a, b, identityVocabulary)).toBe(true);
  });

  test("⚠️ the layer cannot tell a WRONG refusal from a RIGHT one", () => {
    // The sharpest thing in this corpus, and the argument for a human-curated
    // vocabulary rather than a similarity rule.
    //
    // `price-copula` and `price-vs-renewal` have the IDENTICAL key signature —
    // subjects equal, predicates different — and opposite correct verdicts. One
    // is a single claim that must merge; the other is two true claims that must
    // not, because what a tier costs and what it costs to renew are different
    // questions. Nothing in the surfaces distinguishes them.
    //
    // So a rule that closed the first by lexical proximity would close the
    // second too, and at `single` cardinality that stamps `valid_to` on a belief
    // nobody retired. This is why ADR-0037 §6 sends the decision to a reviewer.
    const merge = pair("price-copula");
    const keep = pair("price-vs-renewal");
    for (const p of [merge, keep]) {
      expect(identityKey(p.a.subject)).toBe(identityKey(p.b.subject));
      expect(identityKey(p.a.predicate)).not.toBe(identityKey(p.b.predicate));
      expect(sameSlot(p.a, p.b, identityVocabulary)).toBe(false);
    }
  });

  test("two tiers with the SAME predicate are held apart by the subject alone", () => {
    // The subject arm's falsifier over machine-produced surfaces: the extractor
    // chose one predicate for both messages, so nothing but the subject keeps
    // these two prices from occupying one slot and retiring each other.
    const { a, b } = pair("different-subject");
    expect(identityKey(a.predicate)).toBe(identityKey(b.predicate));
    expect(sameSlot(a, b, identityVocabulary)).toBe(false);
  });
});

describe("only a reviewed vocabulary entry closes the gap", () => {
  test("an alias derived from the recording puts the paraphrase pair in one slot", () => {
    // The positive control for the whole vocabulary layer (T3's target: an
    // identity-default `alias` means a green suite can mean the layer does
    // nothing). One approved edge between the two predicates the extractor
    // actually emitted, and the claim Atlas held twice becomes the claim it
    // holds once.
    const { a, b } = pair("price-copula");
    expect(sameSlot(a, b, withPredicateAlias(a.predicate, b.predicate))).toBe(true);
  });

  test("⚠️ no predicate alias can collapse an inverse relation, ever", () => {
    // `leads` / `is led by` — the pair every similarity detector ranks first,
    // and the one place collapsing is destructive. The prohibition holds
    // STRUCTURALLY rather than by policy: inverse relations swap the subject and
    // the object, so even with the two predicates aliased onto one norm the
    // subjects still differ and the slot arm still refuses. That is why #5034's
    // proposal query joins on the subject as well, and why relaxing it is
    // forbidden by name.
    const { a, b } = pair("leads-inverse");
    const aliased = withPredicateAlias(a.predicate, b.predicate);
    expect(slotKey(a.predicate, aliased.predicate)).toBe(slotKey(b.predicate, aliased.predicate));
    expect(sameSlot(a, b, aliased)).toBe(false);
  });

  test("a PREDICATE alias does not re-key subjects", () => {
    // Position scoping (#5022, ADR-0037 §6). The vocabulary is a record per slot
    // precisely so an approval at one position cannot re-key another — the
    // failure mode where `owned by → platform` plus `platform → platform team`
    // composes into a workspace-wide subject re-key that nothing can undo.
    //
    // ⚠️ THE ALIAS IS BUILT FROM THE TWO SUBJECT SURFACES AND INSTALLED AT THE
    // PREDICATE, and that construction is what makes this test able to fail. An
    // alias built from a predicate surface proves nothing here: no subject in
    // the corpus matches a predicate norm, so it would pass identically against
    // a vocabulary that leaked across all three positions — a prohibition
    // blocked by the wrong arm. Mapped this way, a leak is visible and
    // catastrophic in one step: `business tier` becomes `starter tier`, the
    // predicates already match, and two tiers' prices land in ONE slot where
    // publishing either retires the other.
    const { a, b } = pair("different-subject");
    const leaky = withPredicateAlias(a.subject, b.subject);
    expect(slotKey(a.subject, leaky.subject)).toBe(identityKey(a.subject));
    expect(slotKey(a.subject, leaky.subject)).not.toBe(slotKey(b.subject, leaky.subject));
    expect(sameSlot(a, b, leaky)).toBe(false);
  });
});

describe("the comparable values the recorded objects produce", () => {
  // These assert the INPUT to the three-valued agreement, not the rule — see the
  // header. `identity-consumers-pg.test.ts` owns the rule against real SQL.

  test("two spellings of one price leave nothing that could prove difference", () => {
    // ⭐ The abstain band (#5030), machine-produced. `499 USD` carries an
    // explicit ISO-4217 code and parses; `499 dollars` does not, because the
    // money grammar takes exactly two tokens and `dollars` is not a currency
    // code. So one side has a comparable value and the other has none — and a
    // difference arm spelled `<>` over the surfaces would call these two prices
    // a contradiction, publish the second, and stamp `valid_to` on the first.
    // Nothing here proves they disagree, because they do not: it is one price.
    const { a, b } = pair("price-object-phrasing");
    expect(comparableValue({ surface: a.object })).not.toBeNull();
    expect(comparableValue({ surface: b.object })).toBeNull();
  });

  test("positive control: two ISO-coded prices DO prove difference", () => {
    // Without this, "one side is null" is satisfied by a parser that had stopped
    // resolving anything — every object in the corpus would abstain and the
    // abstain band would be indistinguishable from a dead parser. Both sides
    // here carry the same tag and disagree, which is the only shape that may
    // ever supersede.
    const { a, b } = pair("price-comparable-contradiction");
    const left = comparableValue({ surface: a.object });
    const right = comparableValue({ surface: b.object });
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    expect(comparableTag(String(left))).toBe(comparableTag(String(right)));
    expect(left).not.toBe(right);
  });

  test("a price written the way people write it in chat abstains", () => {
    // `$499 a month` is three tokens, so the money grammar refuses it — which is
    // why `price-contradiction` could never supersede even if a vocabulary entry
    // put its two claims in one slot. Recorded here so that nobody reads the
    // gap-closing test above as making that pair destructive. The honest result
    // of closing it is a visible tension edge and a human, which is the design.
    const { a, b } = pair("price-contradiction");
    expect(comparableValue({ surface: a.object })).toBeNull();
    expect(comparableValue({ surface: b.object })).toBeNull();
  });
});
