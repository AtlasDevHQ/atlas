/**
 * The blast-radius preview — *what becomes supersedable if I approve this?*
 * (#5025, ADR-0037 §6).
 *
 * `lib/brain/oversight.ts` answers *what will the next publish supersede under
 * the vocabulary as it stands*. This module answers a **counterfactual** over a
 * vocabulary that does not exist yet, and #5025's own issue flags the difference
 * as the design decision to settle before writing the AC-2 parity test: the
 * SHAPE is `loadSupersessionPreview`'s, the QUESTION is not.
 *
 * ## It is a parameterization, not a fork, and the seam is the columns
 *
 * `oversight.ts:800-803`'s anti-drift rule — *a disclosure that restates the
 * rule drifts from it; import the same join the re-key will run* — rules out
 * copying the collision arms with two columns swapped. So `brain-facts.ts` grew
 * {@link CollisionExprs}: the collision's CONJUNCTS stay single-spelled and its
 * SLOT EXPRESSIONS became a parameter. Every statement here is
 * `supersessionCollisionPredicate` evaluated twice over the same two rows —
 * once against the stored columns, once against the hypothetical ones.
 *
 * ⚠️ Be precise about what that buys, because the comfortable version is false.
 * FOUR conjuncts are structurally unreachable through {@link CollisionExprs} —
 * the tier guard, the homonym suppression, the `object_cmp` arm and the
 * published row's live-and-current arms. THREE are caller-supplied: both slot
 * expressions and the cardinality gate. `cardinalityFlipExpr` below forces that
 * gate TRUE for one predicate on purpose, so "a caller cannot drop the
 * cardinality gate" is disproved by this very file. The discipline on those
 * three is `collision-sql-pinned.test.ts` — which holds the shipped statements
 * byte-for-byte and proves the DEFAULT parameterization is the stored one — plus
 * review. See `brain-facts.ts`'s table.
 *
 * ## The delta is TWO-SIDED, and that is what makes removal expressible
 *
 * #5025's grill checkpoint adds an *In force* pane where an approved edge is
 * removable **behind the same preview approval uses** — *a removal is a re-key
 * too*. Rather than a second function, the preview is a DELTA between two
 * vocabularies:
 *
 *   - **arming** — pairs that do not supersede today and would after. The
 *     dangerous set for an approval, and the one AC 2 calls *newly-supersedable
 *     rather than merely newly-colliding*.
 *   - **disarming** — pairs that supersede today and would not after. Empty for
 *     an approval (a merge only creates collisions) and the informative set for
 *     a removal, where it is the arbitration a human is about to withdraw.
 *
 * One code path computes both by swapping which side of the delta the JOIN runs
 * on. The alternative — an `approve` preview and a `remove` preview — is two
 * spellings of one question, which is the shape this file exists to avoid.
 *
 * ## The exclusion arm is `IS NOT TRUE`, and the honest claim is narrower than
 * ## it first looks
 *
 * The delta's second half asks *and it does NOT collide under the other
 * vocabulary*, and `supersedableTierSql` is SQL **NULL** — not `false` — for a
 * `{"source": null}` provenance, which is the shape that makes `NOT (…)` the
 * repo's recurring bug (`TIER_HELD_BACK_COUNT_SQL`, `objectNotSameSql`).
 *
 * ⚠️ **Here the two spellings are extensionally IDENTICAL, and saying otherwise
 * would be the overclaim this file is least entitled to make.** Measured, not
 * reasoned: every arm of the exclusion that can be NULL — the tier guard, the
 * `object_cmp` comparison, a NULL slot key — is SHARED with the JOIN predicate,
 * and a row only reaches the exclusion by joining, which forces each shared arm
 * to TRUE. A NULL slot key stays NULL through the substitution too (`CASE WHEN
 * NULL = $x` takes the ELSE branch), so it cannot join either. So the exclusion
 * is two-valued for every row that ever evaluates it, and `NOT (…)` would
 * return the same set today. `vocabulary-preview-pg.test.ts` seeds a
 * `{"source": null}` pair and shows it is excluded by the JOIN rather than by
 * this arm — the falsifier for the equivalence, not for the spelling.
 *
 * The spelling stays anyway, and the reason is a CHANGE rather than a value:
 * the equivalence holds only while the exclusion's NULL-capable arms are a
 * subset of the join's. An exclusion-only arm — the obvious one being a scope
 * narrowing that reads a nullable column the join does not — breaks it silently
 * and in the under-disclosing direction. A defensive spelling that costs
 * nothing and stops being a no-op exactly when someone stops thinking about it
 * is worth keeping; a docstring calling it load-bearing when it is not is not.
 *
 * ## ⚠️ The object position has NO supersession blast radius
 *
 * The collision joins on `subject_key`, `predicate_key` and `object_cmp`.
 * `object_key` appears nowhere in it — an object-position alias moves
 * `object_key`, which is a CORROBORATION arm (`reconcile.ts`'s `objectSameSql`)
 * — so approving one changes what corroborates and what earns a tension edge,
 * and changes nothing about what supersedes.
 *
 * That is reported as a `structurally-empty` {@link BlastRadius} carrying a
 * reason, rather than as a zero, because *"0 pairs"* and *"this position cannot produce pairs"* are the
 * same number and opposite facts, and an approver reading the first will
 * reasonably conclude the alias is harmless when what is true is that its harm
 * is of a different kind. The same trap the M1 dogfood fell into: the sync
 * reported green because the flag was on, and only a row count separated that
 * from a source never connected.
 *
 * ⚠️ **Since #5088 that refusal is no longer the whole answer.** Saying *"this
 * cannot produce supersession pairs"* and stopping was half a disclosure: the
 * surface then said *"Atlas cannot yet show you that"* about the change an object
 * alias DOES make, which is a different confident silence in the same place. So
 * an object-position alias now takes its own {@link BlastRadius} arm carrying the
 * corroboration and tension deltas — a different query over a different relation,
 * built in `vocabulary-object-radius.ts`. This module keeps the counterfactual
 * (both object-key substitutions live here beside their supersession siblings,
 * so `removalKeyExpr`'s *removal is not approval inverted* is spelled once) and
 * that module owns what an object merge changes.
 *
 * `structurallyEmptyReason`'s `"object-position"` member survives as the answer
 * for a request that reaches the planner anyway — see `planCounterfactual`'s two
 * position guards, which are unreachable by construction and exist for the
 * hypothetical where that stops being true.
 *
 * ## Counts are FLOORS and say so
 *
 * `WILL_SUPERSEDE_TOTAL_SQL`'s deliberate over-statement is inherited (it counts
 * colliding live drafts including ones the promotion classifier will refuse) —
 * kept, because replicating the refusal rules in SQL is the second spelling
 * `oversight.ts:806-811` declines. On top of that, a cardinality flip is **not a
 * batch**: it applies to every future claim in the slot, forever. So every count
 * this module returns is a floor, {@link BlastRadius.floor} says so in the type,
 * and the surface renders *"at least N today, and every future claim in this
 * slot"* rather than *"N pairs"*.
 */

import { createLogger } from "@atlas/api/lib/logger";
import type { BrainCandidateReader } from "@atlas/api/lib/brain/candidates";
import type { BrainFactWillSupersedePair, BrainVocabularyBlastRadius } from "@useatlas/types";
import type { Exact } from "@atlas/api/lib/type-utils";
import { aclVisibilityClause, type BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import { BrainReaderUnresolvedError } from "@atlas/api/lib/brain/reader-context";
import {
  identityKey,
  identityKeySql,
  lexicalNorm,
  type SlotPosition,
} from "@atlas/api/lib/brain/identity";
import { MAX_CHAIN_DEPTH } from "@atlas/api/lib/brain/vocabulary";
import { cardinalitySingleSql } from "@atlas/api/lib/brain/cardinality";
import {
  loadObjectPositionRadius,
  type ObjectPositionRadius,
} from "@atlas/api/lib/brain/vocabulary-object-radius";
import {
  STORED_COLLISION_EXPRS,
  cardinalityHeldBackCountSql,
  supersedingDraftPredicate,
  supersessionCollisionPredicate,
  type CollisionExprs,
} from "@atlas/api/lib/content-mode/adapters/brain-facts";

const log = createLogger("brain-vocabulary-preview");

/**
 * Which read surface refused, for {@link BrainReaderUnresolvedError}.
 *
 * ⚠️ Its own member rather than reusing `"oversight"`. The constant was named
 * `PREVIEW_SURFACE` and assigned `"oversight"` — the SAME literal
 * `lib/brain/oversight.ts` uses — so both modules produced the byte-identical
 * refusal `brain oversight: reader identity resolved to no usable principals`.
 * An operator triaging a burst of them could not tell the publish preview from
 * the blast-radius preview: two surfaces, two different fixes, one message.
 * `BrainReadSurface` is diagnostics-only and explicitly "never branched on", so
 * extending it costs nothing and buys the distinction.
 */
const PREVIEW_SURFACE = "vocabulary-preview";

/**
 * Most pairs one preview enumerates — {@link WILL_SUPERSEDE_PAIR_MAX}'s bound
 * and posture. Overrun is reported as `truncated`, never silent, and never
 * laundered into `withheld`, which means something else entirely.
 */
export const BLAST_RADIUS_PAIR_MAX = 50;

/**
 * One pair a decision would arm or disarm.
 *
 * ⚠️ An ALIAS of the wire type, not a copy. It was a field-for-field duplicate
 * of `BrainFactWillSupersedePair` — same four fields, same semantics, same
 * rationale docstring — which is the SSOT violation CLAUDE.md names. No route
 * serializes it YET, and that is the argument for fixing it now rather than
 * deferring: the moment one does, the duplicate becomes a wire contract and the
 * drift is permanent.
 *
 * Labels, never keys. ADR-0037 §6 forbids projecting a key beside its claim
 * (`keys-not-on-the-wire.test.ts` is the guard), and a consumer that can branch
 * on a key is what makes an alias un-removable.
 */
export type BlastRadiusPair = BrainFactWillSupersedePair;

/**
 * Why a preview can produce no pairs AT ALL, as distinct from producing none.
 *
 * A nullable reason rather than a boolean, because the two known causes are not
 * interchangeable and a surface must be able to say which. `null` means the
 * question was asked and answered.
 */
export type StructurallyEmptyReason =
  /**
   * An object-position alias. The collision does not read `object_key`, so no
   * object alias can arm or disarm a supersession — see the module header.
   */
  | "object-position"
  /**
   * A predicate that is already curated `single`. There is nothing to flip, so
   * the flip preview has no counterfactual to compute.
   */
  | "already-single"
  /**
   * A predicate with no approved `single` entry, asked about a REMOVAL. Its own
   * member rather than reusing `already-single`, because the two render as
   * opposite sentences to an approver and a surface that mapped both to one
   * string would tell someone their un-curation is a no-op *because the
   * predicate is already single*.
   */
  | "not-curated"
  /**
   * The decision names a surface that does not KEY — it norms away to nothing
   * (`-`, `___`, `  `), so it occupies no slot and can join nothing.
   *
   * ⚠️ **This member exists because its absence was a defect, and the defect
   * was this module's own signature failure.** The path used to return
   * `structurallyEmpty: null` with two zeroed sides — and `null` is documented
   * above as *"the question was asked and answered"* — so a request that was
   * never computable rendered as *"at least 0 today, and every future claim in
   * this slot"*. That is the confident false all-clear the module header spends
   * four paragraphs arguing against, produced by the module itself, on the one
   * path nothing logged.
   *
   * A disclosed REASON rather than a throw, because `identityKey`'s ⚠️ calls a
   * surface that norms away **permanent and legal** rather than an error:
   * `reconcile.ts`'s `MALFORMED_CLAIM` guard tests `trim() === ""` and so admits
   * `-` and `___`, which means such rows exist in real corpora. A corrupt stored
   * closure target is the DIFFERENT case, and {@link resolveEffectiveTarget}
   * refuses that one rather than routing it here.
   */
  | "unkeyable-surface"
  /**
   * An `alias-removal` naming a norm with no approved parent edge.
   *
   * ⚠️ Added because the alias kinds had NO analogue of `not-curated`, and the
   * consequence was strictly worse than the one that member exists to prevent.
   * With no edge, the removal's subtree is `{fromNorm}` and `removalKeyExpr`
   * maps those rows onto the key they already carry — so `hypothetical ≡
   * stored`, both deltas are empty, and the caller received a **computed**
   * radius of zeros with `floor: true`. A renderer then says *"at least 0
   * today, and every future claim in this slot"* for a decision that does
   * nothing at all.
   *
   * `not-curated`'s own docstring argues it had to be its own member because
   * collapsing it *"would tell someone their un-curation is a no-op"*. This is
   * that same sentence for the alias path, and it was routed to `computed`
   * zeros rather than merely mislabelled — which is why it is a reason and not
   * a rewording.
   */
  | "no-such-edge";

/**
 * Is the predicate slot this decision moves a population INTO curated `single`?
 *
 * ## The count shipped; the sentence did not
 *
 * {@link aliasExprs}' predicate arm already re-points the cardinality lookup, so
 * the arming total for `is priced at → priced at` into a curated-single
 * `priced at` ALREADY includes the pairs the merge newly arms. This field adds
 * no arithmetic — it names where that number came from. Without it an approver
 * sees a larger number with no explanation, which is the *magnitude but not
 * kind* failure the module header spends four paragraphs on, and ADR-0037 §6's
 * amendment calls this the more dangerous direction: *supersession is now armed
 * for claims that were safe a moment earlier*.
 *
 * ## "Not asked" is its own arm
 *
 * Not a nullable boolean. The gate reads `predicate_key`, so at the SUBJECT
 * position the question does not arise, and both cardinality verbs move the gate
 * itself rather than moving a population under it — their version of this
 * question is answered by {@link StructurallyEmptyReason}'s `already-single` /
 * `not-curated`. A `false` on any of those is a fabricated zero of exactly the
 * kind that type exists to refuse. (The object position never reaches here: it
 * takes its own radius arm before {@link planCounterfactual} runs.)
 *
 * ## One question, both alias verbs
 *
 * The slot the population LANDS IN, not "the alias's target" — because a removal
 * lands one too. `removalKeyExpr` re-roots the subtree onto `fromNorm`, and if
 * `fromNorm` carries a pre-existing approved `single` entry the removal arms
 * supersession in the freshly-rooted slot by the same mechanism. #5093's
 * falsification asked for that sweep; it is the same shape, so it gets the same
 * sentence rather than a follow-up.
 */
export type TargetCardinality =
  /** The decision moves no population under a cardinality gate. */
  | { readonly kind: "not-asked" }
  /** Asked; the landing slot carries no approved `single` entry. */
  | { readonly kind: "uncurated" }
  /**
   * Asked, and yes — the population lands where supersession is already armed.
   *
   * The norm the counterfactual SUBSTITUTES, which for an approval is `to`'s
   * current effective target rather than `to` as typed ({@link
   * resolveEffectiveTarget}, and `approvalKeyExpr`'s ⚠️ for why the two differ).
   * A norm, the class `BrainVocabularyEdgeEntry.toNorm` already puts on the
   * wire — not a key projection, which ADR-0037 §6 forbids.
   */
  | { readonly kind: "curated-single"; readonly targetPredicate: string };

/** No population moves under a cardinality gate. Frozen, like {@link NO_SUBTREE}. */
const NOT_ASKED: TargetCardinality = Object.freeze({ kind: "not-asked" });

/**
 * The counterfactual's answer — a DISCRIMINATED UNION, and the discrimination
 * is the module's thesis made unrepresentable rather than argued.
 *
 * ⚠️ It used to be one record carrying `arming`, `disarming`, `floor: true` AND
 * a nullable `structurallyEmpty`, with a shared `EMPTY_SIDE` filling the fields
 * that had no meaning. Every field was readable on every branch — so a renderer
 * that read `floor` before checking `structurallyEmpty` produced *"at least 0
 * today, and every future claim in this slot"* for an object-position alias.
 * That sentence is false (no future claim in that slot can supersede) and it is
 * precisely the confident false all-clear the module header spends four
 * paragraphs on, reachable by reading two fields in the wrong order.
 *
 * Split, the numbers do not exist on the branch where they are meaningless and
 * `EMPTY_SIDE` disappears entirely. The cost is one `switch` at the single
 * future call site; the module is unwired, so this is the cheapest this change
 * will ever be.
 */
export type BlastRadius =
  /** The counterfactual cannot produce pairs BY CONSTRUCTION. No numbers. */
  | { readonly kind: "structurally-empty"; readonly reason: StructurallyEmptyReason }
  /**
   * An OBJECT-position alias decision. A different KIND of blast radius, not a
   * smaller one — see `vocabulary-object-radius.ts`.
   *
   * ⚠️ Its own arm rather than a `computed` with two re-labelled sides. The
   * numbers here count claim pairs that would AGREE and advisory edges that
   * would go STALE; `arming`/`disarming` count published claims that would be
   * REPLACED. A consumer that read one as the other would tell an approver a
   * merge destroys beliefs when it merely reconciles them, or the reverse — and
   * `BlastRadiusSide`'s own field names (`draftLabel`, `supersededLabel`) would
   * be lies on this branch.
   */
  | ({
      readonly kind: "object-position";
      /** The counts describe today; the decision applies to every future claim. */
      readonly floor: true;
      /** The removal's subtree walk hit {@link MAX_CHAIN_DEPTH}. */
      readonly subtreeTruncated: boolean;
      // ⚠️ SPREAD from `ObjectPositionRadius` rather than re-listing its fields.
      // Re-listed, this arm silently lost the `separating` side the moment that
      // module grew one — the type still compiled, `objectPositionRadius`'s
      // spread supplied the field at runtime, and a consumer had no way to read
      // it. A structural copy of another module's record is the same class of
      // duplicate `BlastRadiusPair` was collapsed into an alias to avoid.
    } & ObjectPositionRadius)
  /** The question was asked and answered. */
  | {
      readonly kind: "computed";
      /**
       * Pairs the decision would make supersedable — content-free count plus a
       * reader-scoped bounded sample.
       */
      readonly arming: BlastRadiusSide;
      /** Pairs it would make safe again. Empty for every approval. */
      readonly disarming: BlastRadiusSide;
      /**
       * Whether the slot this decision moves a population INTO is curated
       * `single` — see {@link TargetCardinality}.
       *
       * ⚠️ A DISCLOSURE of `arming`'s number, never a second computation of it.
       * `oversight.ts:800-803`'s anti-drift rule: the moment this is derived
       * from its own count the two can disagree, and a sentence that disagrees
       * with the number beside it is worse than no sentence.
       */
      readonly targetCardinality: TargetCardinality;
      /**
       * ALWAYS true, and a field rather than a comment because the surface must
       * render the floor wording and a literal type is what makes that
       * assertable. See the module header for the two independent reasons.
       */
      readonly floor: true;
      /**
       * The alias subtree walk hit {@link MAX_CHAIN_DEPTH}, so BOTH sides
       * describe a smaller population than was asked about.
       *
       * ⚠️ Its own field on the RADIUS rather than folded into
       * {@link BlastRadiusSide.countsConsistent}, and the distinction is the one
       * this module already made when it split `not-curated` from
       * `already-single`: a truncated walk is not two statements disagreeing, it
       * is one statement asking about a smaller population. Those render as
       * different sentences and demand different actions from an approver —
       * *"these numbers may not agree"* versus *"we could not see your whole
       * alias subtree"* — so they are different fields. Smeared across both
       * sides it also became impossible to tell a side-local disagreement from a
       * radius-wide blind spot.
       */
      readonly subtreeTruncated: boolean;
    };

/**
 * ⚠️ Compile-time lock: this union and the wire union are the SAME TYPE.
 *
 * Pinned at the UNION, not at one arm's record, and that distinction is the
 * whole finding. A previous cut pinned `ObjectPositionRadius` — the spread half
 * of the `object-position` arm — and its docstring claimed the arm was closed.
 * It covered four of the arm's seven fields: `kind`, `floor` and
 * `subtreeTruncated` live in the literal half of the intersection above, which
 * no pin reached and which the `/preview` response annotation cannot reach
 * either (excess-property checking reads the response literal's own keys, never
 * the value assigned into `radius`). Measured, not reasoned: a field added to
 * that literal half and populated at both construction sites compiled COMPLETELY
 * CLEAN, and then `z.strictObject` rejected it — a 500 on every object-position
 * preview, from a change that looked additive.
 *
 * At the union this holds for all three arms at once, including `computed`,
 * which had the identical hole, and including `BlastRadiusSide` and
 * `StructurallyEmptyReason`, which are hand-written twins of their wire
 * counterparts rather than aliases.
 *
 * BIDIRECTIONAL: a field the engine grows is one no client can read and that the
 * schema rejects on the way out; a field the wire grows is one the engine never
 * populates and the schema then demands.
 *
 * ⚠️ `Exact`'s two holes are narrow, and `type-utils.ts` states them precisely.
 * The one that could bite here: a field ADDED as optional to either side passes
 * this pin. Turning an existing required field optional does NOT — that is
 * caught — and neither is dropping `readonly` from `pairs`, because a readonly
 * ARRAY type is compared even though a readonly property modifier is not.
 */
const _blastRadiusMatchesTheWire: Exact<BlastRadius, BrainVocabularyBlastRadius> = true;
void _blastRadiusMatchesTheWire;

export interface BlastRadiusSide {
  /** Unscoped, workspace-wide. A number, never content. */
  readonly total: number;
  /** Reader-scoped on BOTH sides. See {@link loadBlastRadiusSide}. */
  readonly pairs: readonly BlastRadiusPair[];
  /** `total − scopedTotal`: pairs that happen regardless, listing rows this reader may not read. */
  readonly withheld: number;
  /**
   * The sample lists fewer pairs than the reader is entitled to — either the
   * page overran {@link BLAST_RADIUS_PAIR_MAX}, or rows failed to narrow and
   * were dropped. `countsConsistent` distinguishes the two.
   *
   * Never folded into `withheld`, which means something else entirely: pairs
   * the ACL withheld. Truncation dressed as an ACL boundary is what the wire
   * type forbids.
   */
  readonly truncated: boolean;
  /**
   * Whether the two statements behind this side agree well enough for the
   * numbers above to be rendered as facts.
   *
   * ⚠️ **Its absence was a defect, and the module header claimed the opposite.**
   * The header said the clamping and floors were inherited from
   * `loadSupersessionPreview` — true of the clamp, false of the half that
   * matters: `loadFactOversight` ships `countsConsistent` precisely because
   * *"silently clamping the delta to zero renders as 'nothing is hidden from
   * you', which is the pre-#4825 defect reproduced by its own fix."* This module
   * clamped and logged and shipped nothing, so a client rendered
   * `withheld: 0` — "no pairs are hidden from you" — off two statements that had
   * just disagreed.
   *
   * Cleared by: an inverted delta (`scopedTotal > total`), a row whose columns
   * would not narrow, a window that would not parse, and a depth probe that did
   * not answer. Every one of those is two statements failing to agree.
   *
   * ⚠️ **NOT cleared by a truncated subtree walk** — that is a SCOPE fact and
   * travels on {@link BlastRadius.subtreeTruncated}. A consumer gating trust on
   * this flag alone will believe it saw the whole alias subtree when it did
   * not, so a renderer must read both. Four docstrings in this module asserted
   * the old behaviour after it changed; that is what this sentence replaces.
   *
   * The cardinality flip is the most exposed: its `total` comes from a DIFFERENT
   * statement than its pairs, so the two are structurally more able to disagree
   * than the sibling's, not less.
   */
  readonly countsConsistent: boolean;
}

// ---------------------------------------------------------------------------
// The hypothetical vocabularies
// ---------------------------------------------------------------------------

/**
 * The slot column for one position — the only three a counterfactual may move.
 *
 * A mapped type rather than a string concatenation, on `SLOT_COLUMNS`'
 * precedent in `vocabulary-decide.ts`: `object: "subject_key"` is the
 * cross-position slip ADR-0037 §6 calls unrecoverable, and it should not
 * compile.
 */
const SLOT_KEY_COLUMN: { readonly [P in SlotPosition]: `${P}_key` } = {
  subject: "subject_key",
  predicate: "predicate_key",
  object: "object_key",
};

/** The retained surface column for one position. */
const SLOT_SURFACE_COLUMN: { readonly [P in SlotPosition]: P } = {
  subject: "subject",
  predicate: "predicate",
  object: "object",
};

/**
 * A slot position that can actually produce a collision.
 *
 * ⚠️ The object position is excluded AT THE TYPE, not detected at runtime.
 * `aliasExprs` used to carry an `object` arm that threw, with five lines
 * explaining that `structurallyEmptyReason` runs first — i.e. an ordering
 * guarantee between two independent functions, enforced by a comment. Narrowing
 * here moves it to the compiler: "an object-position plan was built" becomes
 * unrepresentable rather than merely detected, and the throw and its
 * justification both disappear.
 */
type CollidingSlot = Exclude<SlotPosition, "object">;

/** Narrow a position to one that can collide. */
function isCollidingSlot(position: SlotPosition): position is CollidingSlot {
  return position !== "object";
}

/**
 * The APPROVAL counterfactual: rows keyed `$fromKey` move to `$toKey`.
 *
 * Well-defined key-to-key, and that is a quotation rather than an assumption —
 * `REKEY_DRIFTED_FACTS_SQL`'s header states it: *adding `a → b` moves exactly
 * the rows keyed `a` onto `b`*. Every norm that currently resolves to `from`
 * (`from` itself and its descendants) shares the key `from`, so one CASE covers
 * the whole moving population.
 *
 * ⚠️ `$toKey` is `to`'s CURRENT EFFECTIVE TARGET, not `to`. If `to → z` is
 * already approved the closure lands the merged population on `z`, and a
 * preview that used `to` would compute a slot the re-key never writes. Resolved
 * against the closure by {@link resolveEffectiveTarget} rather than assumed.
 */
function approvalKeyExpr(
  position: CollidingSlot,
  fromKeyParam: number,
  toKeyParam: number,
): (alias: string) => string {
  const column = SLOT_KEY_COLUMN[position];
  return (alias) =>
    `(CASE WHEN ${alias}.${column} = $${fromKeyParam} THEN $${toKeyParam} ` +
    `ELSE ${alias}.${column} END)`;
}

/**
 * The REMOVAL counterfactual, and it is NOT the approval one inverted.
 *
 * `REKEY_DRIFTED_FACTS_SQL`'s header is explicit about why: *removal is not
 * well-defined key-to-key. Dropping `a`'s parent makes `a` a root again, so of
 * the rows keyed `R`, those whose norm chains through `a` become `a` and the
 * rest stay `R` — and the key column cannot tell the two populations apart,
 * because sharing a key is precisely what it records. Only the retained surface
 * can.*
 *
 * So this expression re-derives from the SURFACE, exactly as the re-key does,
 * and the population is the SUBTREE of `from` in the approved-edge graph:
 * post-removal every descendant of `from` chains up to `from` and stops there,
 * because `from`'s own parent is the edge being dropped.
 *
 * `identityKeySql` — the same expression the re-key runs — is what makes the
 * comparison meaningful; a hand-written `lower()` here would be the third
 * implementation of `lexicalNorm` and the one that disagrees.
 */
function removalKeyExpr(
  position: CollidingSlot,
  subtreeCte: string,
  fromKeyParam: number,
): (alias: string) => string {
  const column = SLOT_KEY_COLUMN[position];
  const surface = SLOT_SURFACE_COLUMN[position];
  return (alias) =>
    `(CASE WHEN ${identityKeySql(`${alias}.${surface}`)} IN (SELECT node FROM ${subtreeCte}) ` +
    `THEN $${fromKeyParam} ELSE ${alias}.${column} END)`;
}

/**
 * Every norm that resolves THROUGH `from` — `from` and its descendants in the
 * approved-edge graph.
 *
 * Bounded by {@link MAX_CHAIN_DEPTH} for `vocabulary.ts`'s liveness reason: an
 * at-most-one-parent acyclic store cannot produce a chain longer than its node
 * count, so reaching the bound is a corruption signal rather than a design
 * limit. A preview that spun on a corrupt store would hang an admin request
 * with no signal, which is the shape `IDENTITY_MUTATION_LOCK_TIMEOUT_SQL`
 * exists to prevent one seam over.
 *
 * ⚠️ The bound TRUNCATES here rather than raising, and the asymmetry with
 * `recomputeEffectiveTargets` is deliberate: that function WRITES a closure, so
 * a truncated walk would commit keys nobody approved. This one only DISCLOSES,
 * and a preview must never be the thing that takes a workspace's admin console
 * down.
 *
 * ⚠️ **But a truncated walk UNDERSTATES the blast radius, so it cannot be
 * silent.** An earlier version of this comment said the condition was *"logged
 * by `loadBlastRadius`'s caller through the corruption the closure rebuild will
 * independently refuse"* — three things wrong with that sentence, and it is the
 * kind this file is least entitled to: there is no caller (the module is
 * unwired); a rebuild running at some LATER approval is not a signal on THIS
 * request; and `truncated` means page overrun only, so nothing on the response
 * carried it. An admin could withdraw an arbitration whose scope was understated
 * by an order of magnitude with every counter reading trustworthy.
 *
 * So the bound is PROBED ({@link subtreeTruncatedSql}) and travels on
 * {@link BlastRadius.subtreeTruncated} — a scope statement, not a count
 * disagreement. Note the bound is also not purely a
 * corruption signal: `vocabulary.ts` records that a rebuild fails when edges are
 * cyclic **or deeper than** the bound, so depth alone can trip it.
 */
function subtreeCteSql(
  cteName: string,
  workspaceParam: number,
  positionParam: number,
  fromNormParam: number,
  depth: number,
): string {
  return `${cteName} AS (
       SELECT $${fromNormParam}::text AS node, 1 AS depth
       UNION ALL
       SELECT e.from_norm, s.depth + 1
         FROM ${cteName} s
         JOIN brain_vocabulary_edge e
           ON e.workspace_id = $${workspaceParam}::text
          AND e.slot_position = $${positionParam}::text
          AND e.to_norm = s.node
        WHERE s.depth < ${depth}
     )`;
}

/**
 * The CARDINALITY-FLIP counterfactual: one predicate key reads `single`.
 *
 * A whole expression rather than a flag, because the gate must answer TRUE for
 * a key that has no `approved` row yet while still answering the stored lookup
 * for every other key in the workspace — a preview scoped to one predicate that
 * disabled the gate globally would count collisions in slots the flip does not
 * touch.
 *
 * The disjunct is ORDERED with the cheap equality first, and the stored `EXISTS`
 * second, so the correlated subquery is skipped for the flip's own rows.
 */
function cardinalityFlipExpr(predicateKeyParam: number): CollisionExprs {
  return {
    ...STORED_COLLISION_EXPRS,
    cardinalitySingle: (alias) =>
      `(${alias}.predicate_key = $${predicateKeyParam} ` +
      `OR ${STORED_COLLISION_EXPRS.cardinalitySingle(alias)})`,
  };
}

/**
 * The UN-curation counterfactual: one predicate key stops reading `single`.
 *
 * The *In force* pane's removal for a cardinality entry, and it is not
 * {@link cardinalityFlipExpr} inverted — it is the gate with one key subtracted
 * rather than one key added, because every OTHER curated predicate in the
 * workspace must keep answering the stored lookup.
 *
 * `IS DISTINCT FROM`, not `<>`.
 *
 * ⚠️ **The reason is the EXPRESSION this builder substitutes, not the column.**
 * An earlier version of this paragraph said `predicate_key` "is nullable on
 * disk", which contradicts the schema: migration
 * `0194_brain_fact_slot_keys_not_null.sql` made all three slot key columns
 * `NOT NULL`, and `tension-sweep.ts`'s header says so in as many words. Two
 * docstrings in one subsystem disagreeing about what the schema admits is worth
 * less than either, and review caught this one.
 *
 * What IS nullable is the counterfactual key this module binds: a preview asks
 * about a surface the caller typed, `identityKey` answers `null` for one that
 * norms away (permanent and legal), and an alias counterfactual re-points the
 * expression at a value that may be absent. `NULL <> $k` is NULL, which would
 * make the whole conjunct NULL and drop the row through the three-valued hole
 * rather than excluding it on the merits. `IS DISTINCT FROM` excludes it on the
 * merits.
 */
function cardinalityUnflipExpr(predicateKeyParam: number): CollisionExprs {
  return {
    ...STORED_COLLISION_EXPRS,
    cardinalitySingle: (alias) =>
      `(${alias}.predicate_key IS DISTINCT FROM $${predicateKeyParam} ` +
      `AND ${STORED_COLLISION_EXPRS.cardinalitySingle(alias)})`,
  };
}

/**
 * An alias approval or removal at ONE position, as a full expression bundle.
 *
 * Spelled as an exhaustive switch rather than a computed key
 * (a computed member name chosen by a ternary on the position), which needed
 * an `as CollisionExprs` — and that cast is load-bearing in the wrong
 * direction: it tells the compiler the record is complete, so a fourth
 * `SlotPosition`, or a typo in either property name, produces a bundle silently
 * missing an expression and a counterfactual that quietly reads the stored
 * column it was supposed to move.
 *
 * ## The predicate arm moves TWO expressions, and missing the second is silent
 *
 * A predicate-position alias moves `predicate_key`, and the cardinality gate is
 * a lookup ON that key. After `is priced at → priced at` the merged slot's
 * cardinality is the one curated on **`priced at`** — so a bundle that
 * re-pointed only the slot arm would ask whether the claim's OLD predicate is
 * curated while joining on its NEW one. That answers about the slot the claim is
 * leaving, and it fails in the under-disclosing direction: the compound case
 * ADR-0037 §6's amendment exists for (*"approving `is priced at → priced at`
 * moves that predicate's whole population into a slot where, if `priced at` is
 * curated `single`, supersession is now armed for claims that were safe a moment
 * earlier"*) is exactly the case it would report as zero.
 */
function aliasExprs(
  position: CollidingSlot,
  keyExpr: (alias: string) => string,
): CollisionExprs {
  switch (position) {
    case "subject":
      return { ...STORED_COLLISION_EXPRS, subjectSlot: keyExpr };
    case "predicate":
      return {
        ...STORED_COLLISION_EXPRS,
        predicateSlot: keyExpr,
        cardinalitySingle: (alias) => cardinalitySingleSql(alias, keyExpr(alias)),
      };
  }
}

// ---------------------------------------------------------------------------
// The delta
// ---------------------------------------------------------------------------

/**
 * The CTE name, spelled ONCE.
 *
 * {@link subtreeTruncatedSql} takes the CTE definition as a parameter but reads
 * `FROM subtree` in its body, so a rename at one of the three sites was a
 * runtime SQL error nothing would catch until production.
 */
const SUBTREE_CTE = "subtree";

/** No walk was performed — every kind but `alias-removal`. */
const NO_SUBTREE: SubtreeProbe = Object.freeze({ truncated: false, probeDrifted: false });

/**
 * The walk's depth bound — the shipped constant unless a test injects one.
 *
 * ⚠️ CLAMPED, and interpolated raw into SQL at two sites. `maxChainDepth` sits
 * on an EXPORTED options bag beside `requestId`, so a future route spreading a
 * parsed query string into this call would hand a client control of a value
 * that reaches the statement text. The clamp makes the seam incapable of
 * injecting, of widening past the shipped bound, and of producing a
 * non-integral depth — it can only ever NARROW, which is the whole production
 * invariant.
 */
function maxDepth(opts: BlastRadiusOptions): number {
  const requested = opts.maxChainDepth;
  if (requested === undefined) return MAX_CHAIN_DEPTH;
  return Math.min(Math.max(1, Math.trunc(requested)), MAX_CHAIN_DEPTH);
}

/**
 * Did the subtree walk reach its depth bound?
 *
 * Asked as its own statement rather than folded into the delta, because the
 * delta's shape is fixed by {@link deltaSql} and a `bool_or` column would have
 * to survive both the count and the pairs projection. One extra round trip on a
 * human-paced admin preview, and only for a removal.
 */
function subtreeTruncatedSql(cte: string, depth: number): string {
  return `WITH RECURSIVE ${cte} SELECT bool_or(depth >= ${depth}) AS hit FROM ${SUBTREE_CTE}`;
}

/** Which half of the delta a statement computes. */

export type DeltaDirection = "arming" | "disarming";

/**
 * One side of the delta, as SQL.
 *
 * `joinExprs` is the vocabulary the pair must collide UNDER; `excludeExprs` is
 * the one it must NOT collide under. For `arming` those are (hypothetical,
 * stored); for `disarming` they are (stored, hypothetical). Both come from
 * `supersessionCollisionPredicate`, so both carry every conjunct.
 *
 * `IS NOT TRUE` on the exclusion rather than `NOT (…)` — a DEFENSIVE spelling,
 * not a load-bearing one. The module header carries the measurement: the two
 * are extensionally identical today because every NULL-capable arm of the
 * exclusion is shared with the join, and it is an exclusion-ONLY nullable arm
 * that would break the equivalence.
 */
function deltaSql(opts: {
  readonly select: string;
  readonly joinExprs: CollisionExprs;
  readonly excludeExprs: CollisionExprs;
  readonly workspaceParam: number;
  readonly extraWhere?: string;
  readonly ctes?: readonly string[];
  readonly tail?: string;
}): string {
  const ctes = opts.ctes && opts.ctes.length > 0 ? `WITH RECURSIVE ${opts.ctes.join(",\n     ")}\n` : "";
  const extra = opts.extraWhere ? `\n     AND ${opts.extraWhere}` : "";
  return `${ctes}SELECT ${opts.select}
    FROM brain_facts d
    JOIN brain_facts p
      ON ${supersessionCollisionPredicate("d", "p", opts.joinExprs)}
   WHERE d.workspace_id = $${opts.workspaceParam}
     AND ${supersedingDraftPredicate("d")}
     AND (${supersessionCollisionPredicate("d", "p", opts.excludeExprs)}) IS NOT TRUE${extra}${opts.tail ?? ""}`;
}

/** The content-free count. */
const TOTAL_SELECT = "COUNT(*)::int AS delta_total";

/**
 * The reader-scoped pair projection, BOTH sides gated.
 *
 * Requiring both sides is `willSupersedePairsSql`'s decision and it transfers
 * unchanged: *"something you cannot see will replace X"* and *"Y will replace
 * something you cannot see"* each disclose half a claim's history to a reader
 * the grant excluded from the other half.
 */
function pairsSelect(): string {
  return `d.id::text AS draft_id,
         d.subject || ' ' || d.predicate || ' ' || d.object AS draft_label,
         p.id::text AS superseded_id,
         p.subject || ' ' || p.predicate || ' ' || p.object AS superseded_label,
         COUNT(*) OVER ()::int AS scoped_total`;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Per-call knobs.
 *
 * `maxChainDepth` is injectable ONLY so the depth bound is falsifiable: with
 * the shipped 64 no fixture can reach it, and a mutation weakening the probe's
 * threshold (`>=` to `>`) was measured surviving all 59 tests — the walk would
 * truncate silently and `subtreeTruncated` would stay false, which is the exact
 * failure the probe exists to prevent. Production never passes it.
 */
export interface BlastRadiusOptions {
  readonly requestId?: string;
  /** Test seam. Defaults to {@link MAX_CHAIN_DEPTH}. */
  readonly maxChainDepth?: number;
}

/** What a caller asks a preview about. */
export type BlastRadiusRequest =
  /** Approving `fromNorm → toNorm` at `position`. */
  | {
      readonly kind: "alias-approval";
      readonly position: SlotPosition;
      readonly fromNorm: string;
      readonly toNorm: string;
    }
  /** Removing the approved edge whose child is `fromNorm` at `position`. */
  | {
      readonly kind: "alias-removal";
      readonly position: SlotPosition;
      readonly fromNorm: string;
    }
  /**
   * Curating `predicateSurface`'s canonical predicate `single`.
   *
   * Takes the SURFACE, not the key. The key is derived here, and it never
   * travels back out — `PredicateCardinalityRecord`'s ⚠️ and
   * `keys-not-on-the-wire.test.ts` are the same prohibition, and a request type
   * that accepted a key would be the seam through which one reaches a route
   * body.
   */
  | { readonly kind: "cardinality-flip"; readonly predicateSurface: string }
  /** Un-curating one — the *In force* pane's removal for a cardinality entry. */
  | { readonly kind: "cardinality-removal"; readonly predicateSurface: string };

/**
 * Compute a decision's blast radius, both directions.
 *
 * @throws {BrainReaderUnresolvedError} when the reader has no usable principals
 *   — `loadSupersessionPreview`'s posture. A preview that answered an
 *   unresolvable reader with an empty pair list would render as *"this approval
 *   supersedes nothing"*, the exact false all-clear this surface exists to
 *   prevent.
 */
export async function loadBlastRadius(
  db: BrainCandidateReader,
  ctx: BrainPrincipalContext,
  request: BlastRadiusRequest,
  opts: BlastRadiusOptions = {},
): Promise<BlastRadius> {
  const workspaceId = ctx.workspaceId;

  // RESOLVE THE READER FIRST, before any early return.
  //
  // ⚠️ This call used to sit inside `loadBlastRadiusSide`, i.e. AFTER both
  // early returns — so a reader with an unresolvable identity asking about a
  // degenerate norm received a clean `{total: 0}` instead of the refusal this
  // function's own `@throws` contract promises. The fail-closed gate was
  // reachable only on the paths that did not need it.
  assertReaderResolvable(ctx, opts.requestId);

  // OBJECT POSITION FIRST — before `structurallyEmptyReason`, which would
  // otherwise answer `"object-position"` and end the request. That reason is
  // still the right answer for a SUPERSESSION question at this position; it is
  // no longer the right answer to the request, because the decision does change
  // something and this branch is what says what.
  if (
    (request.kind === "alias-approval" || request.kind === "alias-removal") &&
    request.position === "object"
  ) {
    return objectPositionRadius(db, ctx, request, opts);
  }

  const structurallyEmpty = await structurallyEmptyReason(db, workspaceId, request);
  if (structurallyEmpty !== null) {
    return { kind: "structurally-empty", reason: structurallyEmpty };
  }

  const plan = await planCounterfactual(db, workspaceId, request, opts);
  if (typeof plan === "string") {
    // ⚠️ A REASON, carried out of `planCounterfactual` rather than manufactured
    // here. It used to return a bare `null` from six sites and this caller
    // stamped `"unkeyable-surface"` on all of them — so an object-position
    // request (reachable if `structurallyEmptyReason` is ever reordered or a
    // second caller appears) rendered as *"this surface does not key"*, which
    // is a factually wrong reason in the under-disclosing direction, with a log
    // line asserting something untrue. `"object-position"` and
    // `"unkeyable-surface"` are opposite facts.
    log.warn(
      { workspaceId, requestId: opts.requestId, kind: request.kind, reason: plan },
      "brain vocabulary preview: the decision could not be turned into a counterfactual — disclosing a reason rather than a zero blast radius",
    );
    return { kind: "structurally-empty", reason: plan };
  }

  const [arming, disarming] = await Promise.all([
    loadBlastRadiusSide(db, ctx, plan, "arming", opts),
    loadBlastRadiusSide(db, ctx, plan, "disarming", opts),
  ]);

  return {
    kind: "computed",
    arming,
    disarming,
    // ⚠️ CARRIED from the plan, never re-derived from `arming.total`. The two
    // are one fact seen twice — the count follows the cardinality gate through
    // `aliasExprs`, and this names the gate it followed — so deriving either
    // from the other is how the sentence and the number come to disagree.
    targetCardinality: plan.targetCardinality,
    floor: true,
    subtreeTruncated: plan.subtree.truncated,
  };
}

/**
 * The object-position arm: build the substitution here, hand it to the module
 * that knows what an object merge changes.
 *
 * ## The two substitutions are the SUPERSESSION ones, unchanged
 *
 * `approvalKeyExpr` and `removalKeyExpr` are position-parameterized already, and
 * the object position is a legal argument to neither — {@link CollidingSlot}
 * excludes it at the type, deliberately, because building a supersession bundle
 * for it is what must stay unrepresentable. So this arm builds the same two CASE
 * expressions against `object_key` directly rather than widening `CollidingSlot`,
 * which would re-admit exactly the mistake that narrowing removed.
 *
 * ⚠️ **They are inlined and they are still not two spellings, and the difference
 * matters.** `aliasExprs` is what a supersession bundle needs and it carries the
 * cardinality re-point the predicate arm must have; none of that is expressible
 * at a position the collision never reads. What IS shared — the subtree CTE, its
 * depth bound, its truncation probe, and the effective-target resolution — is
 * called rather than copied, and those are the parts whose two spellings would
 * actually disagree.
 */
async function objectPositionRadius(
  db: BrainCandidateReader,
  ctx: BrainPrincipalContext,
  request: Extract<BlastRadiusRequest, { kind: "alias-approval" | "alias-removal" }>,
  opts: BlastRadiusOptions,
): Promise<BlastRadius> {
  const workspaceId = ctx.workspaceId;
  const fromKey = identityKey(request.fromNorm);
  if (fromKey === null) {
    log.warn(
      { workspaceId, requestId: opts.requestId, kind: request.kind },
      "brain vocabulary preview: an object-position decision names a surface that norms away — disclosing a reason rather than a zero blast radius",
    );
    return { kind: "structurally-empty", reason: "unkeyable-surface" };
  }

  if (request.kind === "alias-removal") {
    // ⚠️ The `no-such-edge` probe FIRST, and its absence was a real hole. This
    // arm short-circuits before `structurallyEmptyReason`, so that reason became
    // unreachable at the object position — and a removal naming a norm with no
    // approved parent produced three honest zeros, which the pane renders as
    // *"Nothing in the corpus agrees or contradicts differently under this
    // merge … it applies to every future claim in this slot as well"*: a floor
    // promise about a decision that does not exist. `no-such-edge`'s own
    // docstring argues exactly this case for the supersession path; the object
    // path has to ask the same question.
    const { rows } = await db.query(
      `SELECT 1 AS hit FROM brain_vocabulary_edge
        WHERE workspace_id = $1 AND slot_position = $2 AND from_norm = $3`,
      [workspaceId, "object", fromKey],
    );
    if (rows.length === 0) {
      log.warn(
        { workspaceId, requestId: opts.requestId, kind: request.kind },
        "brain vocabulary preview: an object-position removal names a norm with no approved parent edge — disclosing a reason rather than a zeroed radius",
      );
      return { kind: "structurally-empty", reason: "no-such-edge" };
    }
    // Same probe the supersession removal runs, so a truncated walk is reported
    // identically on both branches rather than silently understating one.
    const subtree = await subtreeHitBound(db, workspaceId, "object", fromKey, opts);
    const radius = await loadObjectPositionRadius(
      db,
      ctx,
      {
        // `$2` is BOTH the substituted key and the walk's seed, bound once —
        // `planCounterfactual`'s reason: a future edit must not be able to start
        // the walk somewhere the substitution does not land.
        keyExpr: (alias) =>
          `(CASE WHEN ${identityKeySql(`${alias}.object`)} IN (SELECT node FROM ${SUBTREE_CTE}) ` +
          `THEN $2 ELSE ${alias}.object_key END)`,
        params: [fromKey, "object"],
        ctes: [subtreeCteSql(SUBTREE_CTE, 1, 3, 2, maxDepth(opts))],
        // ⚠️ THREADED, not dropped. `SubtreeProbe` carries two facts: a genuine
        // bound hit is a radius-wide SCOPE statement (`subtreeTruncated` below),
        // and an unreadable probe is STATEMENT DRIFT that must clear
        // `countsConsistent` — which is what the supersession path does. The
        // object arm read only the first, so a probe that did not answer
        // produced a fully trustworthy-looking radius over a walk nobody could
        // confirm.
        probeDrifted: subtree.probeDrifted,
      },
      opts,
    );
    return {
      kind: "object-position",
      ...radius,
      floor: true,
      subtreeTruncated: subtree.truncated,
    };
  }

  const toNorm = lexicalNorm(request.toNorm);
  if (toNorm === "") {
    log.warn(
      { workspaceId, requestId: opts.requestId, kind: request.kind },
      "brain vocabulary preview: an object-position approval names a target that norms away — disclosing a reason rather than a zero blast radius",
    );
    return { kind: "structurally-empty", reason: "unkeyable-surface" };
  }
  // `to`'s CURRENT effective target, for `approvalKeyExpr`'s ⚠️: if `to → z` is
  // already approved the closure lands the merged population on `z`, and a
  // preview that used `to` would describe a slot the re-key never writes.
  const toKey = await resolveEffectiveTarget(db, workspaceId, "object", toNorm, opts.requestId);
  const radius = await loadObjectPositionRadius(
    db,
    ctx,
    {
      keyExpr: (alias) => `(CASE WHEN ${alias}.object_key = $2 THEN $3 ELSE ${alias}.object_key END)`,
      params: [fromKey, toKey],
      ctes: [],
      // No walk on an approval, so nothing could have drifted. Stated rather
      // than omitted — the field is required precisely so "no walk" and "forgot"
      // are different keystrokes.
      probeDrifted: false,
    },
    opts,
  );
  return { kind: "object-position", ...radius, floor: true, subtreeTruncated: false };
}

/**
 * Refuse an unresolvable reader BEFORE any early return.
 *
 * `aclVisibilityClause`'s `deny-all` is the same condition
 * {@link loadBlastRadiusSide} checks per statement; this is that check hoisted
 * so it cannot be skipped by a request that never reaches a statement. Built on
 * a throwaway alias and param index — the clause is discarded, only its
 * DECISION is read — because the real clauses must be built with the plan's
 * arity, which is not known yet.
 *
 * @throws {BrainReaderUnresolvedError}
 */
function assertReaderResolvable(ctx: BrainPrincipalContext, requestId?: string): void {
  const probe = aclVisibilityClause(ctx, {
    table: "brain_facts",
    alias: "d",
    paramIndex: 1,
    requestId,
  });
  if (probe.decision === "deny-all") {
    throw new BrainReaderUnresolvedError(ctx.workspaceId, ctx.origin, PREVIEW_SURFACE);
  }
}

/**
 * The resolved counterfactual — parameters bound, expressions built.
 *
 * Split from {@link loadBlastRadius} so the two delta directions share one
 * resolution: computing `$toKey` twice would be two closure reads that could
 * straddle a concurrent approval, and the two halves of one delta must describe
 * ONE pair of vocabularies or their difference is meaningless.
 */
interface CounterfactualPlan {
  readonly hypothetical: CollisionExprs;
  /**
   * Everything after `$1` (the workspace id), in order.
   *
   * `readonly string[]`, not `unknown[]`. Every kind binds strings, and the
   * wider type was actively hiding a hole: round 2 deleted the caller's
   * `toKey === null` check on the strength of a prose argument, and
   * `unknown[]` accepted the `string | null` silently. A NULL here binds `$3`,
   * the approval CASE moves the whole population onto a NULL key, both deltas
   * return 0, and the surface reports "this approval arms nothing" — the
   * module's own named worst outcome, with no log line. The invariant went from
   * CHECKED to DOCUMENTED, in the file whose thesis is that this is the
   * anti-pattern. One word puts the compiler back in the room.
   */
  readonly params: readonly string[];
  readonly ctes: readonly string[];
  /**
   * What the depth probe established about the removal's subtree walk.
   *
   * `truncated` travels to {@link BlastRadius.subtreeTruncated} — a radius-wide
   * SCOPE statement. `probeDrifted` clears
   * {@link BlastRadiusSide.countsConsistent} instead, because an unreadable
   * probe is statement drift and says nothing about the graph's depth.
   */
  readonly subtree: SubtreeProbe;
  /**
   * Whether the slot this plan moves a population INTO is curated `single`.
   *
   * REQUIRED, not optional, for `probeDrifted`'s reason one field up: every arm
   * must SAY the question does not arise rather than omit it, so "not asked"
   * and "forgot to ask" are different keystrokes.
   */
  readonly targetCardinality: TargetCardinality;
  /**
   * An ARMING-side total that comes from a different statement.
   *
   * ONE optional record rather than three loose ones. As two independent
   * optionals plus a column name derived from a boolean at the read site, the
   * type admitted `{sql, params: undefined}` — which fell back to `[workspaceId]`
   * and failed at Postgres on the statement's own `$2` — and forced an
   * `as string` re-assertion because a `boolean` cannot narrow a sibling field.
   * Grouped, the presence check narrows all three and the cast disappears.
   */
  readonly armingTotalOverride?: {
    readonly sql: string;
    readonly params: readonly unknown[];
    /** The result column. Lives WITH the statement, not with its consumer. */
    readonly column: string;
  };
}

async function planCounterfactual(
  db: BrainCandidateReader,
  workspaceId: string,
  request: BlastRadiusRequest,
  opts: BlastRadiusOptions,
): Promise<CounterfactualPlan | StructurallyEmptyReason> {
  switch (request.kind) {
    case "alias-approval": {
      // POSITION FIRST, matching the removal arm below. Both guards are
      // unreachable today (`structurallyEmptyReason` runs before this
      // function), and the whole reason they exist is the hypothetical where
      // that stops being true — under which two arms answering DIFFERENT
      // reasons for one request shape is exactly the confusion they were added
      // to prevent. Position is the structural fact; keyability is the
      // request-content fact.
      if (!isCollidingSlot(request.position)) return "object-position";
      const fromKey = identityKey(request.fromNorm);
      const toNorm = lexicalNorm(request.toNorm);
      if (fromKey === null || toNorm === "") return "unkeyable-surface";
      // `to`'s CURRENT effective target — see `approvalKeyExpr`'s ⚠️.
      // `resolveEffectiveTarget` returns `string`: `toNorm` is a non-empty norm
      // and `lexicalNorm` is idempotent, so the null arm that used to sit here
      // was dead AND fed the overloaded null channel. It refuses loudly on the
      // two corrupt-closure shapes instead.
      const toKey = await resolveEffectiveTarget(
        db,
        workspaceId,
        request.position,
        toNorm,
        opts.requestId,
      );
      return {
        hypothetical: aliasExprs(request.position, approvalKeyExpr(request.position, 2, 3)),
        params: [fromKey, toKey],
        ctes: [],
        subtree: NO_SUBTREE,
        // SEQUENTIAL after `resolveEffectiveTarget`, and not a waterfall to
        // unpick: the disclosure is about the slot the re-key WRITES, so it
        // cannot be asked until the closure has said which slot that is.
        targetCardinality: await targetCardinalityOf(db, workspaceId, request.position, toKey),
      };
    }
    case "alias-removal": {
      if (!isCollidingSlot(request.position)) return "object-position";
      const fromKey = identityKey(request.fromNorm);
      if (fromKey === null) return "unkeyable-surface";
      // Both probes read `fromKey` and neither feeds the other, so they run
      // together — the no-async-waterfalls rule, and the reason the approval arm
      // above cannot do the same.
      const [subtree, targetCardinality] = await Promise.all([
        subtreeHitBound(db, workspaceId, request.position, fromKey, opts),
        // ⚠️ `fromKey`, not a target: a removal re-roots the subtree onto
        // `fromNorm` itself, so THAT is the slot the population lands in. If it
        // carries a pre-existing approved `single` entry the removal arms
        // supersession there, by the same mechanism an approval does.
        targetCardinalityOf(db, workspaceId, request.position, fromKey),
      ]);
      return {
        hypothetical: aliasExprs(request.position, removalKeyExpr(request.position, SUBTREE_CTE, 2)),
        // `$2` is BOTH the substituted key and the subtree seed, and they are the
        // same string rather than two values that happen to match: `fromNorm` is
        // already a norm, and `identityKey` is idempotent on one, so
        // `identityKey(fromNorm) === fromNorm`. Bound once so a future edit
        // cannot make the walk start somewhere the substitution does not land.
        params: [fromKey, request.position],
        ctes: [subtreeCteSql(SUBTREE_CTE, 1, 3, 2, maxDepth(opts))],
        subtree,
        targetCardinality,
      };
    }
    case "cardinality-flip":
    case "cardinality-removal": {
      const canonicalKey = identityKey(request.predicateSurface);
      if (canonicalKey === null) return "unkeyable-surface";
      return {
        // A flip ADDS this key to the gate; a removal SUBTRACTS it. Both are
        // "the vocabulary after the decision", and the delta's direction swap
        // supplies "the vocabulary today" — so a removal's arming side is
        // provably empty (un-curating cannot create a collision) and its
        // disarming side is the arbitration the approver is withdrawing.
        hypothetical:
          request.kind === "cardinality-flip"
            ? cardinalityFlipExpr(2)
            : cardinalityUnflipExpr(2),
        params: [canonicalKey],
        ctes: [],
        subtree: NO_SUBTREE,
        // ⚠️ NOT ASKED, and stated rather than defaulted. A cardinality verb
        // moves the GATE, not a population under it — no claim changes slot —
        // so "is the landing slot curated" has no referent here. The question
        // these verbs DO answer is `structurallyEmptyReason`'s `already-single`
        // / `not-curated`, which run before this function. Answering `false`
        // would put *"the target predicate is not curated single"* on a flip
        // preview, which is both meaningless and the reassuring direction.
        targetCardinality: NOT_ASKED,
        // ⚠️ NO `extraWhere: d.predicate_key = $2`, and its absence is the
        // decision rather than an omission. It was there, and it was a SECOND
        // mechanism doing the gate's job: given `d.predicate_key = $2`, the
        // expression `(d.predicate_key = $2 OR stored)` is just `TRUE`, so the
        // scope came entirely from the WHERE and the gate could be replaced by
        // `TRUE` with no test noticing — measured, as a surviving mutation.
        //
        // The gate alone is sufficient AND self-scoping: for a pair in any
        // other predicate the hypothetical and the stored expression coincide,
        // so `hyp ∧ ¬stored` is empty for it. One mechanism, and it is the one
        // a mutation can reach. The cost is that the delta scans the
        // workspace's drafts rather than one predicate's — a human-paced
        // preview on an admin surface, and the same posture
        // `REKEY_DRIFTED_FACTS_SQL` takes on a far hotter path.
        // The literal reuse #5025's handoff requires: the arming total is
        // `CARDINALITY_HELD_BACK_COUNT_SQL`'s own question at a predicate scope
        // rather than a batch scope. `vocabulary-preview-pg.test.ts` asserts
        // this statement and the delta agree on a real corpus, so the reuse is
        // CHECKED rather than claimed.
        armingTotalOverride:
          request.kind === "cardinality-flip"
            ? {
                sql: cardinalityHeldBackCountSql("d.predicate_key = $2"),
                params: [canonicalKey],
                column: "held_back",
              }
            : undefined,
      };
    }
  }
}

/**
 * A norm's effective target under the CURRENT closure, or itself.
 *
 * Reads `brain_vocabulary_target` rather than walking the edges: the closure is
 * what `alias` reads, so this is the same answer the re-key will compute. Its
 * absence means the norm is unaliased, which is `identityAlias` and therefore
 * the norm itself — `loadClaimVocabulary`'s empty/absent equivalence, one layer
 * down.
 */
/**
 * Probe whether the removal's subtree walk reaches the depth bound.
 *
 * Answers `true` on an unreadable result rather than `false`: the flag's only
 * job is to CLEAR `countsConsistent`, so the fail-closed direction is to say
 * "do not trust these numbers" when the probe itself could not be read.
 */
async function subtreeHitBound(
  db: BrainCandidateReader,
  workspaceId: string,
  // ⚠️ `SlotPosition`, not `CollidingSlot`. The probe asks the EDGE graph how
  // deep a subtree is, and `brain_vocabulary_edge` stores all three positions —
  // the narrowing next door exists to keep a supersession bundle unbuildable at
  // the object position, which is a statement about the collision and not about
  // this walk. Narrowing here too would have forced the object-removal arm to
  // re-spell the CTE it already shares.
  position: SlotPosition,
  fromKey: string,
  opts: BlastRadiusOptions,
): Promise<SubtreeProbe> {
  const depth = maxDepth(opts);
  const { rows } = await db.query(
    subtreeTruncatedSql(subtreeCteSql(SUBTREE_CTE, 1, 3, 2, depth), depth),
    [workspaceId, fromKey, position],
  );
  const hit = (rows[0] as { hit?: unknown } | undefined)?.hit;
  if (hit === true) {
    log.warn(
      { workspaceId, requestId: opts.requestId, position, fromNorm: fromKey, maxChainDepth: depth },
      "brain vocabulary preview: the alias subtree walk hit the depth bound — the approved-edge graph is cyclic or deeper than the bound, so this removal's disarming set is TRUNCATED and understates the blast radius",
    );
    return { truncated: true, probeDrifted: false };
  }
  // ⚠️ `false` is the ONLY value that may answer "the walk was complete".
  // `null` used to take this arm unlogged — a `bool_or` over an empty CTE, a
  // probe that lost its seed row, a driver mapping an aggregate to null — each
  // means the probe told us nothing, and each was recorded as "complete". The
  // same file argues exactly this for `Number(null)` forty lines down; two
  // treatments of SQL NULL in one module, and the silent one was on the side
  // that decides whether an approver is shown a trustworthy number.
  if (hit === false) return { truncated: false, probeDrifted: false };
  log.warn(
    { workspaceId, requestId: opts.requestId, position, hit: hit === null ? "null" : typeof hit },
    "brain vocabulary preview: the subtree depth probe did not read back as a boolean — the numbers cannot be trusted, but nothing establishes that the graph is deep or cyclic",
  );
  // ⚠️ NOT `truncated: true`. An unreadable probe and a genuine bound hit are
  // two different facts, and `BlastRadius.subtreeTruncated`'s docstring asserts
  // the SECOND one specifically ("the walk hit MAX_CHAIN_DEPTH"). Collapsing
  // them told an approver their approved-edge graph was cyclic or deeper than
  // 64 whenever a driver or a query shape drifted — sending them to inspect a
  // vocabulary that may be perfectly healthy. A drifted probe is statement
  // drift, which is exactly what `countsConsistent` already means, so it goes
  // there. Same distinction the module drew between `not-curated` and
  // `already-single`.
  return { truncated: false, probeDrifted: true };
}

/** What the depth probe established — two facts, deliberately not one boolean. */
interface SubtreeProbe {
  /** The walk provably reached its bound. */
  readonly truncated: boolean;
  /** The probe did not answer, so nothing about the walk is established. */
  readonly probeDrifted: boolean;
}

async function resolveEffectiveTarget(
  db: BrainCandidateReader,
  workspaceId: string,
  // `SlotPosition` for {@link subtreeHitBound}'s reason: the closure table is
  // keyed by position and answers at all three.
  position: SlotPosition,
  norm: string,
  requestId?: string,
): Promise<string> {
  const { rows } = await db.query(
    `SELECT effective_target FROM brain_vocabulary_target
      WHERE workspace_id = $1 AND slot_position = $2 AND norm = $3`,
    [workspaceId, position, norm],
  );
  // Branch on ROW PRESENCE, never on value shape. One ternary used to collapse
  // two opposite facts: *no row* (legitimately unaliased — `alias` is total, so
  // the norm is its own target) and *row present, column unreadable* (the
  // column is `NOT NULL` with a `<> ''` CHECK, so this is unreachable from
  // Postgres and therefore a query-shape change).
  //
  // ⚠️ Collapsed, the drift case answered with the UN-ALIASED norm — which is
  // precisely `approvalKeyExpr`'s ⚠️: a slot the re-key never writes, joining
  // nothing, so every approval preview in the workspace reports zero arming
  // pairs forever with no log line. That is the same defect class `readCount`
  // throws on 130 lines below, and it was handled the opposite way.
  const row = rows[0] as Record<string, unknown> | undefined;
  // `?? norm` is honest rather than defensive: the only caller guarantees a
  // non-empty norm and `lexicalNorm` is idempotent, so `identityKey` cannot
  // answer null here. Returning `string` is what lets the plan's `params` be
  // `string[]`, which is what puts the guarantee under the compiler instead of
  // in a comment two functions away.
  if (row === undefined) return identityKey(norm) ?? norm;

  const stored = row.effective_target;
  // ⚠️ QUERY SHAPE ONLY — `typeof`, and deliberately NOT `|| stored.trim() ===
  // ""`. That extra clause read as harmless and was a second collapse inside
  // the fix for the first one: 0189's CHECK is `effective_target <> ''`, and
  // `'   ' <> ''` is TRUE, so a whitespace-only target is STORABLE (0189's
  // header says outright that normal form is not enforced on this table). It
  // therefore intercepted a genuinely corrupt row and reported it as driver /
  // migration drift, sending an operator to look at the SELECT — while making
  // the "closure is corrupt" arm below, written for exactly this row,
  // unreachable. Every non-empty string now falls through to `identityKey`,
  // which answers `null` for every degenerate spelling.
  if (typeof stored !== "string") {
    log.error(
      { workspaceId, position, norm, requestId },
      "brain vocabulary preview: brain_vocabulary_target.effective_target did not read back as a string — the closure query shape changed",
    );
    throw new Error(
      `brain vocabulary preview: brain_vocabulary_target.effective_target did not read back as a ` +
        `string for ${position}/"${norm}" in workspace ${workspaceId}. The column is NOT NULL with a ` +
        `non-empty CHECK, so this is unreachable from Postgres and the query shape has changed — ` +
        `refusing to compute a counterfactual against an unresolved target, which would report every ` +
        `approval as arming nothing.`,
    );
  }

  // Re-normed for `slotKey`'s reason: the vocabulary's answer is a data table's
  // and not a proof, and an entry authored as `"Priced At"` would otherwise make
  // this preview compute a key that joins nothing — a confident zero.
  const key = identityKey(stored);
  if (key === null) {
    log.error(
      { workspaceId, position, norm, requestId },
      "brain vocabulary preview: the stored effective target norms away — the closure is corrupt",
    );
    throw new Error(
      `brain vocabulary preview: the stored effective target "${stored}" for ${position}/"${norm}" in ` +
        `workspace ${workspaceId} norms away to nothing. A closure target that keys nothing is corrupt ` +
        `— 0189's CHECKs do not constrain it to being a norm, and the region importer rebuilds this ` +
        `table — so it is refused rather than folded into an unkeyable-surface answer, which would ` +
        `report store corruption as an ordinary property of the request.`,
    );
  }
  return key;
}

/**
 * Is this counterfactual incapable of producing pairs by construction?
 *
 * Asked BEFORE any delta statement runs, so the answer is a reason rather than
 * an empty result the caller has to interpret.
 */
async function structurallyEmptyReason(
  db: BrainCandidateReader,
  workspaceId: string,
  request: BlastRadiusRequest,
): Promise<StructurallyEmptyReason | null> {
  // ⚠️ DEAD from `loadBlastRadius`, and kept deliberately rather than deleted.
  // #5088 made the object position take its own radius arm, so the caller
  // short-circuits object-position requests BEFORE reaching here — this branch
  // used to be the live path and a reader will assume it still is.
  //
  // It stays because this function is not the only caller's guard: the same
  // reason is still reachable from `planCounterfactual`'s two `isCollidingSlot`
  // checks, which is where the wire union's `"object-position"` member earns its
  // keep. Deleting the branch here would leave that reason produced in one place
  // and defended in none.
  if (
    (request.kind === "alias-approval" || request.kind === "alias-removal") &&
    request.position === "object"
  ) {
    return "object-position";
  }
  if (request.kind === "alias-removal") {
    const fromKey = identityKey(request.fromNorm);
    if (fromKey === null) return "unkeyable-surface";
    const { rows } = await db.query(
      `SELECT 1 AS hit FROM brain_vocabulary_edge
        WHERE workspace_id = $1 AND slot_position = $2 AND from_norm = $3`,
      [workspaceId, request.position, fromKey],
    );
    // The same probe shape the cardinality kinds use one branch down: ask the
    // store whether there is anything to undo, rather than inferring it from an
    // empty delta.
    if (rows.length === 0) return "no-such-edge";
  }

  if (request.kind === "cardinality-flip" || request.kind === "cardinality-removal") {
    const canonicalKey = identityKey(request.predicateSurface);
    if (canonicalKey === null) return null;
    // The two kinds read the SAME probe and branch on opposite answers: a flip
    // has nothing to compute when the entry already exists, and a removal has
    // nothing to compute when it does not. One statement rather than two so the
    // "is this predicate curated" question has one spelling.
    const curated = await curatedSingle(db, workspaceId, canonicalKey);
    if (request.kind === "cardinality-flip" && curated) return "already-single";
    if (request.kind === "cardinality-removal" && !curated) return "not-curated";
  }
  return null;
}

/**
 * Does this predicate key carry an approved `single` entry?
 *
 * ⚠️ ONE spelling of the question, called from both places that ask it:
 * {@link structurallyEmptyReason}'s two cardinality verbs and
 * {@link targetCardinalityOf}'s disclosure. It was inline in the first when the
 * second was written, and a second copy is how a preview comes to say *"the
 * target is uncurated"* beside a count computed against a gate that disagreed —
 * the module's own two-statements-disagreeing failure, in prose.
 *
 * It is deliberately NOT {@link cardinalitySingleSql}. That expression is
 * correlated on `${alias}.workspace_id` and lives INSIDE the collision join,
 * where its whole job is to be one arm of a row predicate; this is a
 * standalone yes/no about one key. The two would have to be kept in step by
 * hand either way, and `readPredicateCardinality`'s ⚠️ rules itself out for a
 * different reason: it answers `null` for absent-OR-unreadable, and a caller
 * reading that as *uncurated* makes exactly the inference it exists to prevent.
 *
 * Row presence is unambiguous, so there is no "drifted" third answer to carry:
 * a statement that cannot be read THROWS, and a 500 on the preview is the
 * fail-loud direction this surface wants.
 */
async function curatedSingle(
  db: BrainCandidateReader,
  workspaceId: string,
  // ⚠️ NOT `predicateKey`, and the rename is not cosmetic:
  // `keys-not-on-the-wire.test.ts` scans this file for the ORM spelling of a key
  // column and refuses it OUTRIGHT — a fact-shaped type that grows a key field
  // is the leak it exists to stop, and the arm is deliberately over-broad
  // because a missed key is the unrecoverable direction. `canonicalKey` is the
  // name `planCounterfactual` already uses for this same value.
  canonicalKey: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 AS hit FROM brain_predicate_cardinality
      WHERE workspace_id = $1 AND predicate_key = $2
        AND cardinality = 'single' AND status = 'approved'`,
    [workspaceId, canonicalKey],
  );
  return rows.length > 0;
}

/**
 * The compound-blast-radius disclosure for one alias decision.
 *
 * `targetKey` is the key the counterfactual SUBSTITUTES — `toKey` for an
 * approval, `fromKey` for a removal — rather than the norm the request named,
 * so the sentence describes the slot the re-key actually writes. Passing the
 * requested norm here would name a slot nothing lands in whenever `to` is
 * itself aliased, which is `approvalKeyExpr`'s ⚠️ reproduced one layer up.
 *
 * ⚠️ The position check is what keeps a subject alias unanswerable. It is a
 * runtime narrowing of {@link CollidingSlot} rather than a type-level one
 * because `planCounterfactual` reaches here with the position still open; the
 * TYPE-level half of the AC is that `targetPredicate` is unreadable on the two
 * arms that do not carry it.
 */
async function targetCardinalityOf(
  db: BrainCandidateReader,
  workspaceId: string,
  position: CollidingSlot,
  targetKey: string,
): Promise<TargetCardinality> {
  if (position !== "predicate") return NOT_ASKED;
  return (await curatedSingle(db, workspaceId, targetKey))
    ? { kind: "curated-single", targetPredicate: targetKey }
    : { kind: "uncurated" };
}

/**
 * One direction of the delta: the unscoped total and the reader-scoped sample.
 *
 * Two statements, one request — `loadSupersessionPreview`'s shape, and
 * `withheld` is their difference. The clamping, the window-drift floors and the
 * `truncated` derivation are that function's, restated here only where the
 * parameter list differs; where the logic is identical it is identical on
 * purpose, and `vocabulary-preview.test.ts` runs the same drift fixtures
 * against both.
 */
async function loadBlastRadiusSide(
  db: BrainCandidateReader,
  ctx: BrainPrincipalContext,
  plan: CounterfactualPlan,
  direction: DeltaDirection,
  opts: BlastRadiusOptions,
): Promise<BlastRadiusSide> {
  const workspaceId = ctx.workspaceId;
  const joinExprs = direction === "arming" ? plan.hypothetical : STORED_COLLISION_EXPRS;
  const excludeExprs = direction === "arming" ? STORED_COLLISION_EXPRS : plan.hypothetical;

  // The plan's own params occupy $2..$N; the reader's ACL params follow.
  const aclBase = 2 + plan.params.length;
  const draftAcl = aclVisibilityClause(ctx, {
    table: "brain_facts",
    alias: "d",
    paramIndex: aclBase,
    requestId: opts.requestId,
  });
  if (draftAcl.decision === "deny-all") {
    throw new BrainReaderUnresolvedError(workspaceId, ctx.origin, PREVIEW_SURFACE);
  }
  const publishedAcl = aclVisibilityClause(ctx, {
    table: "brain_facts",
    alias: "p",
    paramIndex: draftAcl.nextParamIndex,
    requestId: opts.requestId,
  });
  if (publishedAcl.decision === "deny-all") {
    // Unreachable — same context, same table, and the first clause resolved.
    // Kept because a silent empty list under a deny renders as "this approval
    // arms nothing", the false all-clear this module exists to prevent.
    throw new BrainReaderUnresolvedError(workspaceId, ctx.origin, PREVIEW_SURFACE);
  }
  const limitParam = publishedAcl.nextParamIndex;

  // ⚠️ The plan's expressions carry HAND-WRITTEN placeholder literals (`$2`,
  // `$3`) while `aclBase` is derived from `plan.params.length`. They agree
  // today — verified for all four kinds — and the failure mode if they ever
  // stop is silent and in the under-disclosing direction: an expression
  // referencing a placeholder at or above `aclBase` would compare a slot key
  // against an ACL principal token, join nothing, and report "this approval
  // arms nothing" on an admin console.
  //
  // A `ParamBuilder` is the mechanical answer (`AclClause.nextParamIndex` is
  // that answer one seam over) and was judged more machinery than this earns.
  // This is the four-line version: loud, at the seam, rather than a zero.
  assertPlaceholdersBelowAclBase(
    pairsSqlPlaceholderSource(plan),
    aclBase,
    workspaceId,
    direction,
    opts.requestId,
  );

  // Narrowed once, so the statement, its params and its result column travel
  // together and no `as` is needed to re-assert what the check established.
  const override = direction === "arming" ? plan.armingTotalOverride : undefined;
  // ONE presence test, not two. `override?.sql ?? …` and `override ? … : …`
  // coincide only because `sql` is a required non-nullish string — which is the
  // same inconsistently-read optional the regrouping was meant to close.
  const { sql: totalSql, params: totalParams, column: totalColumn } = override
    ? { sql: override.sql, params: [workspaceId, ...override.params], column: override.column }
    : {
        column: "delta_total",
        sql: deltaSql({
          select: TOTAL_SELECT,
          joinExprs,
          excludeExprs,
          workspaceParam: 1,
          ctes: plan.ctes,
        }),
        params: [workspaceId, ...plan.params],
      };

  const pairsSql = deltaSql({
    select: pairsSelect(),
    joinExprs,
    excludeExprs,
    workspaceParam: 1,
    extraWhere: [draftAcl.sql, publishedAcl.sql].join("\n     AND "),
    ctes: plan.ctes,
    tail: `\n   ORDER BY d.ingested_at, d.id, p.ingested_at, p.id\n   LIMIT $${limitParam}`,
  });

  const [totalResult, pairsResult] = await Promise.all([
    db.query(totalSql, totalParams),
    db.query(pairsSql, [
      workspaceId,
      ...plan.params,
      ...draftAcl.params,
      ...publishedAcl.params,
      BLAST_RADIUS_PAIR_MAX + 1,
    ]),
  ]);

  const total = readCount(totalResult.rows[0], totalColumn);
  if (total === null) {
    // LOGGED before it throws, with the requestId — the two refusals in
    // `resolveEffectiveTarget` do, and this is the one an operator is most
    // likely to actually hit (two statements, drift on either). CLAUDE.md:
    // request ids on all 500s.
    log.error(
      { workspaceId, requestId: opts.requestId, direction, column: totalColumn },
      "brain vocabulary preview: the delta total did not read back as a number — refusing rather than disclosing a blast radius Atlas cannot establish",
    );
    // A THROW, not a degraded 0 — `loadSupersessionPreview`'s reason exactly: 0
    // renders as "this decision arms nothing", a confident false all-clear
    // fabricated from query drift, on the surface whose whole job is this
    // disclosure. `COUNT(*)` cannot return NULL, so this is unreachable from
    // Postgres.
    throw new Error(
      `brain vocabulary preview: the ${direction} total did not read back as a number for ` +
        `workspace ${workspaceId} (request ${opts.requestId ?? "unknown"}) — refusing to disclose ` +
        `a blast radius Atlas cannot establish`,
    );
  }

  const { pairs, scopedTotal, truncated, drifted } = readPairs(
    pairsResult.rows,
    workspaceId,
    direction,
    opts.requestId,
  );

  const inverted = scopedTotal > total;
  if (inverted) {
    log.warn(
      { workspaceId, requestId: opts.requestId, direction, scopedTotal, total },
      "brain vocabulary preview: the reader-scoped delta exceeds the workspace delta — a brief ingest race, or the two statements disagree; reporting 0 withheld and clearing countsConsistent",
    );
  }

  return {
    total,
    pairs,
    withheld: Math.max(0, total - scopedTotal),
    truncated,
    // The clamp above is `loadSupersessionPreview`'s; this flag is the half that
    // module ships and this one had dropped. Without it the clamp renders as
    // "nothing is hidden from you" off two statements that just disagreed.
    // ⚠️ NOT `&& !plan.subtreeTruncated` any more. A truncated walk is a
    // radius-wide scope blind spot, not a side-local count disagreement, and it
    // now travels on `BlastRadius.subtreeTruncated` where it renders as its own
    // sentence. Smearing it here made the two indistinguishable to a consumer.
    countsConsistent: !inverted && !drifted && !plan.subtree.probeDrifted,
  };
}

/**
 * Every `$n` the plan's own expressions reference, as one string to scan.
 *
 * Built from the plan rather than from the emitted statement so the check does
 * not accidentally read the ACL clause's own placeholders — which are legal at
 * and above `aclBase` by construction.
 */
function pairsSqlPlaceholderSource(plan: CounterfactualPlan): string {
  const probe = "__x";
  // `Object.values`, NOT a hand-enumeration of the three members. Enumerating
  // them meant a FOURTH member on `CollisionExprs` would silently shrink this
  // guard's coverage with no compile error — the guard would keep passing while
  // covering less, which is the failure mode a guard must not have.
  const exprs = Object.values(plan.hypothetical).map((build) => build(probe));
  // ⚠️ `armingTotalOverride.sql` is deliberately NOT scanned: it carries no ACL
  // clause, so it has no reader range to collide with. Stated because that is
  // an invariant of the override rather than a property of this function.
  return [...exprs, ...plan.ctes].join(" ");
}

/**
 * Refuse a plan whose expressions reach into the reader's placeholder range.
 *
 * EXPORTED for its test. It is a pure function over a string and a number, and
 * the alternative was leaving it uncovered: no legal `BlastRadiusRequest` can
 * construct a plan that trips it (that is the point — it guards a FUTURE edit),
 * so deleting its body survived the whole suite. A guard whose only failure
 * mode is unreachable through the public API is one whose test has to reach it
 * directly.
 */
export function assertPlaceholdersBelowAclBase(
  source: string,
  aclBase: number,
  workspaceId: string,
  direction: DeltaDirection,
  requestId?: string,
): void {
  const refs = [...source.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  const highest = refs.length === 0 ? 0 : Math.max(...refs);
  if (highest >= aclBase) {
    log.error(
      { workspaceId, requestId, direction, highest, aclBase },
      "brain vocabulary preview: a counterfactual expression references a placeholder inside the reader's range — the ACL clause and the slot substitution would bind the same parameter",
    );
    throw new Error(
      `brain vocabulary preview: the ${direction} counterfactual references $${highest}, at or above ` +
        `the ACL base $${aclBase} (workspace ${workspaceId}, request ${requestId ?? "unknown"}). ` +
        `The plan's placeholder literals and its ` +
        `\`params\` array have drifted, so the reader's visibility predicate would bind against a slot ` +
        `key — joining nothing and reporting that this decision changes nothing. Refusing.`,
    );
  }
}

/**
 * A non-negative integer count, or `null` when the value did not read back as
 * one.
 *
 * ONE spelling, used by both the total columns and the per-row window. `""` is
 * refused explicitly — `Number("")` is a finite 0, which is the shape that
 * reads as "no rows" when it means "the column drifted".
 */
function readNonNegativeInt(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

/** One `COUNT(*)::int` column, or `null` when it did not read back as one. */
function readCount(raw: unknown, column: string): number | null {
  return readNonNegativeInt((raw as Record<string, unknown> | undefined)?.[column]);
}

/**
 * Narrow the pair page, carrying `loadSupersessionPreview`'s floors verbatim.
 *
 * A row whose window will not parse is COUNTED — the floor is what keeps that
 * drift from silently relabelling clipped rows as ACL-withheld, which the wire
 * type forbids. `null` is mapped to NaN explicitly because `Number(null)` is a
 * finite 0, the one shape of window drift that would otherwise go unlogged.
 */
function readPairs(
  rawRows: readonly unknown[],
  workspaceId: string,
  direction: DeltaDirection,
  requestId?: string,
): { pairs: BlastRadiusPair[]; scopedTotal: number; truncated: boolean; drifted: boolean } {
  const clipped = rawRows.length > BLAST_RADIUS_PAIR_MAX;
  const pairs: BlastRadiusPair[] = [];
  let scopedTotal = 0;
  let droppedRows = 0;
  let windowDriftRows = 0;

  for (const raw of clipped ? rawRows.slice(0, BLAST_RADIUS_PAIR_MAX) : rawRows) {
    if (typeof raw !== "object" || raw === null) {
      droppedRows++;
      continue;
    }
    const r = raw as Record<string, unknown>;
    if (
      typeof r.draft_id !== "string" ||
      typeof r.draft_label !== "string" ||
      typeof r.superseded_id !== "string" ||
      typeof r.superseded_label !== "string"
    ) {
      droppedRows++;
      continue;
    }
    // ⚠️ The SAME narrowing `readCount` applies, rather than a looser twin.
    // The looser one accepted `""` (`Number("") === 0`, finite) and negative
    // values as trustworthy, so a `scoped_total` column drifting to empty
    // string left `scopedTotal` at 0, `withheld` computed off a number nothing
    // established, and `countsConsistent` saying the numbers were facts —
    // while `readCount` forty lines up refuses both. Two treatments of one
    // question is the asymmetry this module keeps having to remove.
    const windowed = readNonNegativeInt(r.scoped_total);
    if (windowed !== null && windowed > scopedTotal) scopedTotal = windowed;
    else if (windowed === null) windowDriftRows++;
    pairs.push({
      draftId: r.draft_id,
      draftLabel: r.draft_label,
      supersededId: r.superseded_id,
      supersededLabel: r.superseded_label,
    });
  }

  if (droppedRows > 0) {
    log.warn(
      { workspaceId, requestId, direction, droppedRows, kept: pairs.length },
      "brain vocabulary preview: delta pair rows came back with an unreadable column — the sample understates the blast radius; the query shape changed",
    );
  }
  if (windowDriftRows > 0) {
    log.warn(
      { workspaceId, requestId, direction, windowDriftRows },
      "brain vocabulary preview: the scoped window did not read back as a number on some rows — truncation may be under-reported; the query shape changed",
    );
  }

  if (clipped && scopedTotal < rawRows.length) scopedTotal = rawRows.length;
  if (scopedTotal < pairs.length) scopedTotal = pairs.length;

  // ⚠️ `drifted` is what stops a DROPPED row being reported to the approver as
  // an ACL-WITHHELD one. On the unclipped path the first floor does not apply,
  // so a row that failed to PARSE falls through to `scopedTotal = pairs.length`
  // and re-emerges inside `withheld` — i.e. "you lack permission to see this"
  // for a row that simply would not narrow. Both cases log, but the number the
  // human reads is wrong, and only this flag says so on the wire.
  return {
    pairs,
    scopedTotal,
    truncated: clipped || scopedTotal > pairs.length,
    drifted: droppedRows > 0 || windowDriftRows > 0,
  };
}
