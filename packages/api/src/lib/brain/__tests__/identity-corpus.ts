/**
 * The ONE corpus behind all three claim-identity consumers (#5021, ADR-0037 §9).
 *
 * `identity-consumers-pg.test.ts` drives corroboration, the tension scan, and
 * the publish gate's supersession join over these same rows and asserts a
 * DIFFERENT verdict from each — corroboration says *same*, tension says
 * *different-and-coexisting*, supersession says *different-and-stamping*. Three
 * verdicts over one fixture set, not three suites with three sets of fixtures
 * that agree with themselves.
 *
 * ## What this module fixes, and what it does not
 *
 * The trap it exists to close (#5000, and the map's T7 §1): three consumers with
 * three private fixture sets cannot disagree about what collides, because
 * nothing ever compares them.
 *
 *   - `promotion-pg.test.ts` had the predicate as a SQL literal inside its
 *     seeder, so the two sides *could not* differ even if an author wanted them
 *     to. Fixed in #5020.
 *   - `oversight-pg.test.ts` had the predicate AND the object as SQL literals.
 *     That is the seeder this change parameterizes — though no test there
 *     compares two rows' identity yet, so the fix is parity, not coverage.
 *   - `extract-reconcile-pg.test.ts` spreads one default `candidate()` into both
 *     sides of every pair, so agreement there is not asserted — it is the same
 *     reference. **Still open.** Its three overlapping identity cases moved here;
 *     what remains in that file is the cases this corpus cannot express
 *     (a NULL-keyed row, a degenerate rival, cross-tenant scoping).
 *
 * Exactly one file imports this corpus. It is not what the seeders above are
 * parameterized by — they take literals from their own call sites.
 *
 * ## What a human is allowed to write here
 *
 * Surfaces and a claim about MEANING. Nothing else.
 *
 * An entry says "a person reading these two claims would call them the same
 * thing" (or would not) — a statement about English, which a human is the right
 * oracle for. It never says what key either side normalizes to. Deriving
 * {@link ClaimPair.relation} from `slotKey` would compare the identity layer to
 * itself and pass against any implementation, including one that returns a
 * constant; writing the expected keys by hand would pin them twice in the same
 * commit and drift on the first change. So: the human authors the STIMULUS and
 * the meaning, and the system supplies every key and every OBSERVED verdict.
 *
 * That is the general form of the rule ADR-0037 §9 states —
 * *one side of every identity assertion is a value the system produced, not a
 * value the test wrote* — applied to the inputs rather than the assertions.
 *
 * ⚠️ **This is the deterministic half only.** The map's T7 §5 asks for the
 * predicate side to be produced by driving the real extractor in the eval lane,
 * precisely so nobody hand-authors it — and that half is not built. Until it is,
 * this corpus proves the identity layer handles the variation someone thought to
 * write, and nothing about variation nobody imagined. Do not read a green run
 * here as closing §9's loop.
 *
 * ⚠️ `promotion-pg.test.ts` also still holds a parallel consumer-3 fixture set
 * of its own (`ws-5020-phrasing`). It is NOT redundant with this corpus — it
 * additionally asserts the pair LABELS, the `supersedes` edges, and the
 * unkeyed-row direction, none of which this file expresses. Do not apply the
 * de-duplication argument above to it without checking what would be lost.
 *
 * ## Reading the verdict table
 *
 * The three consumers do not each get their own expectation column, because that
 * would let them drift into disagreeing about what collides. They share
 * {@link ClaimPair.relation}, and {@link VERDICTS} is what every consumer's
 * assertions are computed FROM — flip a cell and three tests go red.
 *
 * Not a `.test.ts`, so the isolated runner does not execute it — same reason as
 * `identity-fixtures.ts`, which holds the corpus for the OTHER half of the
 * identity work (the `lexicalNorm` ↔ migration 0187 pairing). That module pins
 * the key FUNCTION against the SQL; this one pins the three CONSUMERS against
 * each other. They are deliberately separate: an entry here has to be a whole
 * claim, and an entry there has to be a bare surface.
 */

// The producer declaration a `Claim` may carry (#5030). A TYPE-only import:
// this module stays free of behaviour, so it can never agree with the
// implementation by sharing code with it.
import type { DeclaredObjectType } from "@atlas/api/lib/brain/object-cmp";

/** One side of a pair — a whole claim, because identity is a triple. */
export interface Claim {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  /**
   * The SOURCE KIND stamped on the evidence behind this claim (#5033) — the
   * episode's `source`, which `reconcile.ts` copies into
   * `provenance.source` and which the tier guard reads.
   *
   * Omitted by every entry that does not need it; the consumer defaults it to
   * the ordinary extracted case.
   *
   * ⚠️ It is the ONLY field on a `Claim` that no consumer's MATCHING reads —
   * and that uniqueness is the whole design, so do not read it as "another
   * `objectType`". {@link objectType} very much changes what collides:
   * `cross-type-rival` exists because declaring `money:USD` on one side turns a
   * `<>`-different verdict into `unknown` and stops the stamp. `source` changes
   * only what a collision is allowed to DO.
   *
   * ⚠️ Deliberately `string`, not `EpisodeSource`. A value OUTSIDE the
   * vocabulary is a real stored shape — the region import restores a bundle's
   * `source` verbatim with no vocabulary gate (`lib/brain/sources.ts`'s header)
   * — and it is the population the tier guard's allowlist exists for. Typing
   * this to the union would make the corpus unable to express the case that
   * distinguishes an allowlist from a denylist.
   */
  readonly source?: string;
  /**
   * What the producer says its object IS (#5030) — omitted by every entry that
   * does not need it, which is the conservative default a producer gets.
   *
   * Present on the corpus because a declaration is the only way a bare `499`
   * ever becomes comparable AS MONEY (on its own it parses to `number:499`), and because the SIDES of a pair may declare
   * differently: that is what produces a cross-TYPE comparison, the one shape
   * the `split_part` tag arm exists for and the only shape that falsifies it.
   */
  readonly objectType?: DeclaredObjectType;
}

/**
 * Every relation, as the SOURCE the union is derived from.
 *
 * This array rather than a bare union so that adding a relation is a COMPILE
 * error in every `Record<SlotRelation, …>` — the verdict table below, and the
 * per-consumer title maps in `identity-consumers-pg.test.ts`. A hand-written
 * union plus hand-written `pairsWhere("…")` loops would let a new relation land
 * a corpus entry that no consumer ever reads, green.
 */
export const RELATIONS = [
  "same-claim",
  "unproven-rival",
  "proven-rival",
  "tier-guarded-rival",
  "different-claim",
] as const;

/**
 * What a human says the two claims mean, relative to each other:
 *
 *   - `same-claim` — one claim, two spellings. Same subject slot, same
 *     predicate slot, same value.
 *   - `unproven-rival` — one slot, two VALUES, and the values cannot be
 *     COMPARED. The subject and predicate collide through a phrasing difference
 *     and the objects visibly disagree to a human, but nothing on either row
 *     proves it: `Grace` and `Alan` are two names, and with no entity store the
 *     system genuinely cannot show they are two people. This is the ABSTAIN
 *     BAND (#5030) — tension only, never a stamp.
 *   - `proven-rival` — the same shape with COMPARABLE objects. Both sides carry
 *     an `object_cmp` of the same type and they disagree, so the difference is
 *     evidence rather than an inference from two strings failing to match. Only
 *     this class supersedes.
 *   - `tier-guarded-rival` — a `proven-rival` in every respect EXCEPT that the
 *     tier of one side (or both) is not provably below tier-1 (#5033,
 *     ADR-0037 §4). The identity layer is unchanged — same slot, same
 *     three-valued agreement, same tension edge — and only the CONSEQUENCE is
 *     withheld. *Identity is source-agnostic; consequence is tier-ordered.*
 *   - `different-claim` — different slots. The claims may look near-identical
 *     to a lexical matcher and are not the same claim, so nothing may collide
 *     them. This is the direction where an over-match costs a `valid_to` stamp
 *     on a belief nobody retired.
 *
 * ⚠️ **The split between the two rival classes is the whole of #5030, and it is
 * the change most likely to be read as a regression.** Before it there was one
 * `rival-claim` relation and it superseded; `unproven-rival` is what that class
 * became, and it no longer does. Merging the two back — or giving
 * `unproven-rival` `supersedes: true` because a human can plainly see the
 * claims disagree — restores the irreversible stamp the three-valued agreement
 * was built to remove. A human seeing it is exactly what the tension edge is
 * for.
 */
export type SlotRelation = (typeof RELATIONS)[number];

export interface ClaimPair {
  /**
   * Stable id, unique across the corpus — it names the workspace each `-pg` case
   * runs in and both of its episode source ids, so a failure points somewhere.
   * Uniqueness is asserted by the corpus guard, not by the type.
   */
  readonly id: string;
  readonly relation: SlotRelation;
  /** Why a human says so. The argument is in English because the claim is about English. */
  readonly why: string;
  readonly a: Claim;
  readonly b: Claim;
}

/**
 * The corpus.
 *
 * Every entry varies something a consumer's join arm reads. The
 * `different-claim` entries are each a documented REFUSAL of the identity layer
 * rather than an accident — collapsing any one of them is a change someone has
 * to argue for here.
 *
 * ## Covering the arms
 *
 * Both `TENSION_CANDIDATES_SQL` and `supersessionCollisionJoin` are
 * `subject_key = … AND predicate_key = … AND <an object arm>`, so a prohibition
 * can only bite on a given `=` arm when the OTHER two arms would have matched.
 * An entry whose objects are equal is blocked by the object arm alone and proves
 * nothing about the subject or predicate arm.
 *
 * ⚠️ **Since #5030 the two consumers no longer share an object arm, and that
 * splits this table's `≠` column in two.** The rival scan asks *not provably
 * same* — two names satisfy it. The collision join asks *provably different* —
 * two names do NOT, so an entry with entity-valued objects is blocked by the
 * OBJECT there and falsifies neither key arm for consumer 3. That is why
 * `subject-differs` and `predicate-differs` carry money objects: they exist to
 * falsify the subject and predicate arms, and with unparseable objects they
 * would have silently stopped doing it for the consumer that stamps `valid_to`.
 *
 * `cmp` below is the object's agreement verdict, which is what consumer 3 reads.
 *
 * | entry | subject | predicate | object key | cmp |
 * |---|---|---|---|---|
 * | `same-through-value`     | = | = | ≠ | **same** |
 * | `rival-through-phrasing` | = | = | ≠ | unknown |
 * | `priced-rival`           | = | = | ≠ | different |
 * | `declared-rival`         | = | = | ≠ | different |
 * | `sign-flip-rival`        | = | = | **=** | different |
 * | `cross-type-rival`       | = | = | ≠ | unknown |
 * | `warehouse-incumbent`    | = | = | ≠ | different |
 * | `warehouse-draft`        | = | = | ≠ | different |
 * | `warehouse-both`         | = | = | ≠ | different |
 * | `unresolvable-incumbent` | = | = | ≠ | different |
 * | `unresolvable-draft`     | = | = | ≠ | different |
 * | `subject-differs`        | ≠ | = | ≠ | different |
 * | `predicate-differs`      | = | ≠ | ≠ | different |
 * | `inverse-relations`      | ≠ | ≠ | ≠ | unknown |
 * | `copula-pair`            | = | ≠ | = | unknown |
 * | `entity-alias`           | ≠ | = | = | unknown |
 *
 * ## The tier dimension is NOT a fifth column (#5033)
 *
 * The five `tier-guarded-rival` entries are byte-identical to `priced-rival` in
 * every field above — they vary only {@link Claim.source}, which no arm of any
 * of the three consumers' matching reads. That is deliberate and it is the
 * falsification ADR-0037 §4 asks for: hold the identity inputs fixed, vary the
 * tier alone, and the only thing that may change is whether `valid_to` is
 * stamped. If varying the source moved a KEY, the guard would be per-class
 * matching rather than a consequence ordering, and the map forbids that.
 *
 * `priced-rival` is therefore doing double duty — it is the object-arm control
 * AND the accepted-shape control for the tier guard. Deleting it takes both
 * with it.
 */
export const IDENTITY_CORPUS = [
  {
    id: "phrasing-variant",
    relation: "same-claim",
    why:
      "Case and separator, on all three slots at once — the entirety of `lexicalNorm`. " +
      "Nobody would read these as two different claims, and byte-exact matching filed " +
      "them as two rows the reviewer then had to reconcile by hand.",
    a: { subject: "Deploy Window", predicate: "Ships On", object: "Thursdays" },
    b: { subject: "deploy_window", predicate: "ships-on", object: "thursdays" },
  },
  {
    id: "separator-edges",
    relation: "same-claim",
    why:
      "A producer's stray edge punctuation is not a claim about the world. Separated " +
      "from the entry above because it is the only one where the EDGE TRIM is " +
      "load-bearing: `_` and `-` are separators, so they collapse to a space that then " +
      "has to be trimmed off, and a norm that collapsed interior runs but kept the " +
      "edges passes `phrasing-variant` and fails here. " +
      "Deliberately NOT spelled with leading/trailing spaces — `reconcile.ts` trims the " +
      "candidate surfaces before it keys them, so a space-edged pair is normalized by " +
      "the stage no matter what `lexicalNorm` does, and proves nothing about this layer. " +
      "(Mutation-checked: the space-edged version survives deleting the edge trim.) " +
      "Both sides off normal form, for the reason spelled out under `rival-through-phrasing`.",
    a: { subject: "Release-Train", predicate: "Runs", object: "Weekly" },
    b: { subject: "__release train", predicate: "runs-", object: "-weekly_" },
  },
  {
    id: "same-through-value",
    relation: "same-claim",
    why:
      "⭐ ADR-0037 §2's pinned case, and the ONLY entry in the corpus that corroborates " +
      "through the COMPARABLE VALUE rather than through the object key. `499 USD` and " +
      "`USD 499` are one price; `lexicalNorm` keys them `499 usd` and `usd 499`, which do " +
      "not match, so the key arm alone mints a second row for a belief Atlas already holds — " +
      "and worse, the two then read as rivals and publishing either stamps `valid_to` on the " +
      "other.\n" +
      "  Its absence was measured, not guessed: with only key-equal `same-claim` entries, " +
      "neutralizing `CORROBORATION_LOOKUP_SQL`'s `OR object_cmp = $5` arm killed nothing but " +
      "a lexical assertion. Both arms of a disjunction need an entry that reaches them " +
      "ALONE, or one of them is decoration.\n" +
      "  The subject and predicate are held byte-identical on purpose: this entry is about " +
      "the OBJECT arm, and phrasing noise elsewhere would let a slot-level failure kill it " +
      "for the wrong reason.",
    a: { subject: "business tier", predicate: "priced at", object: "499 USD" },
    b: { subject: "business tier", predicate: "priced at", object: "USD 499" },
  },
  {
    id: "rival-through-phrasing",
    relation: "unproven-rival",
    why:
      "⚠️ THE abstain band's control (#5030). Two names, and nothing on either row " +
      "proves they are two people — `passthroughEntityResolver` supplies no id and " +
      "neither surface parses to a typed value, so both `object_cmp`s are NULL and the " +
      "agreement is UNKNOWN. Tension fires; the publish gate does not. This entry " +
      "superseded before #5030 and deliberately no longer does: `object_key <> object_key` " +
      "proves only that two surfaces did not normalize together, which is also true of " +
      "`$499` and `499 USD`, and supersession has no inverse verb anywhere in the product. " +
      "The rest of the argument is about the SLOT, and stands unchanged:\n" +
      "  " +
      "`Ada` reports to exactly one person and these name two. The subject and predicate " +
      "are one slot spelled two ways, so on the surface columns the rival scan matched " +
      "nothing and the reviewer saw two uncontested facts where there was a contradiction. " +
      "BOTH sides are spelled off normal form, and differently — that is not decoration, " +
      "it is what makes two separate mutations die. The scan is issued for `b` and compares " +
      "against `a`'s stored row, so: if `b` were already normalized, binding the raw " +
      "surfaces at the call site would still find the rival; if `a` were, repointing the " +
      "STATEMENT at the surface columns would still match `b`'s key binds. " +
      "(Mutation-checked, and the second case was a live survivor until `a` grew its noise.)",
    a: { subject: "Ada", predicate: "Reports_To", object: "Grace" },
    b: { subject: "ADA", predicate: "reports-to", object: "Alan" },
  },
  {
    id: "priced-rival",
    relation: "proven-rival",
    why:
      "⭐ #5030's supersession control, and the only relation that still stamps `valid_to`. " +
      "Two prices, both money with an EXPLICIT ISO-4217 code, so both sides carry an " +
      "`object_cmp` of the same tag and they disagree — positive evidence of difference " +
      "rather than an inference from two strings failing to match.\n" +
      "  BOTH sides are spelled off normal form on the subject and predicate, and " +
      "differently, for `rival-through-phrasing`'s reason verbatim: with `b` already " +
      "normalized, binding raw surfaces at the call site would still find the collision; " +
      "with `a` already normalized, repointing the JOIN at the surface columns would still " +
      "match. This entry inherits consumer 3's whole slot-pivot proof, because the entry " +
      "that used to carry it abstains now.\n" +
      "  The OBJECTS are deliberately in normal form — `499 USD` needs no phrasing noise, " +
      "and adding some would only test `lexicalNorm`, which no longer reads this position " +
      "for the collision at all.",
    a: { subject: "Business_Tier", predicate: "Priced At", object: "499 USD" },
    b: { subject: "business tier", predicate: "priced-at", object: "599 USD" },
  },
  {
    id: "declared-rival",
    relation: "proven-rival",
    why:
      "The same contradiction reached through a producer DECLARATION rather than through " +
      "the surface. Bare `499` and `599` parse to plain numbers; declaring both USD money " +
      "makes them comparable AS PRICES.\n" +
      "  ⚠️ **This entry falsifies no mutation of its own, and saying so is the point.** An " +
      "earlier `why` claimed it was what proved `objectType` reaches the stored column; that " +
      "was measured and is FALSE — drop the declaration and both sides parse as " +
      "`number:499`/`number:599`, same tag, unequal, so all three verdicts are unchanged. " +
      "The real threading falsifier at the `-pg` level is `cross-type-rival` below, and in " +
      "the fast lane it is `reconcile.test.ts`'s comparable-bind control. This entry earns " +
      "its place as the DECLARED spelling of a `proven-rival` — a shape a reader will " +
      "otherwise assume is untested — not as a mutation killer.",
    a: {
      subject: "starter tier",
      predicate: "priced at",
      object: "499",
      objectType: { kind: "money", currency: "USD" },
    },
    b: {
      subject: "starter tier",
      predicate: "priced at",
      object: "599",
      objectType: { kind: "money", currency: "USD" },
    },
  },
  {
    id: "sign-flip-rival",
    relation: "proven-rival",
    why:
      "⚠️ THE entry that falsifies the difference VETO, and the only shape in the corpus " +
      "where `same` and `different` would BOTH hold. `lexicalNorm` treats `-` as a " +
      "separator and trims it, so `-499` and `499` key IDENTICALLY (`499`) while their " +
      "comparable values are `number:-499` and `number:499` — same tag, unequal, provably " +
      "different.\n" +
      "  Under ADR-0037 §2's rule as literally written, corroboration's key arm fires " +
      "`same`: the two rows merge, the second claim never gets a row, Atlas records one " +
      "more piece of evidence for the OPPOSITE-signed belief, and the rival scan never " +
      "runs. That is T2's *corroboration merges two distinct beliefs into one row — " +
      "silent, unattended, no human in the loop*, reached through the arm nobody changed. " +
      "So proven difference vetoes sameness, and the pair lands here.\n" +
      "  A signed number is exactly what a warehouse producer emits for a margin, a delta " +
      "or a variance — the producer `objectType` exists to serve. Not a contrived surface.",
    a: { subject: "q3 forecast", predicate: "variance", object: "-499" },
    b: { subject: "q3 forecast", predicate: "variance", object: "499" },
  },
  {
    id: "cross-type-rival",
    relation: "unproven-rival",
    why:
      "⚠️ THE falsifier for the `split_part` tag arm at the CONSUMER level — it catches the " +
      "arm through the publish gate, where `object-cmp-pg.test.ts`'s per-row parity tests " +
      "catch it against the bare SQL. One producer declares its `price` column USD; the other reads a bare " +
      "number off the same slot and declares nothing. `number:599` and `money:USD:499` are " +
      "unequal STRINGS, so a difference arm spelled `<>` alone calls them different and " +
      "publish stamps `valid_to` — but nothing proves the bare number is not dollars. " +
      "Cross-type is UNKNOWN.\n" +
      "  Reachable the day any producer declares a type, which is what `objectType` is for, " +
      "so this is a live case and not a theoretical one. The amounts differ so the objects " +
      "do not simply corroborate through `object_key`.",
    a: { subject: "growth tier", predicate: "priced at", object: "499" },
    b: {
      subject: "growth tier",
      predicate: "priced at",
      object: "599",
      objectType: { kind: "money", currency: "USD" },
    },
  },
  {
    id: "warehouse-incumbent",
    relation: "tier-guarded-rival",
    why:
      "⭐ #5033's headline case, and the reason the guard is a prerequisite for the warehouse " +
      "producer rather than a follow-up to it. A draft LLM-extracted fact meets a PUBLISHED " +
      "warehouse-derived fact in one slot with provably different prices — every other arm of " +
      "the collision join is satisfied, and before the tier guard publish stamped `valid_to` on " +
      "the authoritative row. Tier-1 has no correction path at all (`correction.ts` refuses " +
      "every verb on a warehouse-derived target), so the reviewer who notices cannot undo it: " +
      "an LLM guess irreversibly retires a fact that is authoritative by construction.\n" +
      "  The claims are BYTE-IDENTICAL to `priced-rival` and the source is the only difference. " +
      "That is the pairing ADR-0037 §4's falsification asks for: without a stamping control of " +
      "the same shape, this entry passes green against a guard that dropped the pair from every " +
      "statement, which is indistinguishable from a guard that works.",
    a: {
      subject: "Business_Tier",
      predicate: "Priced At",
      object: "499 USD",
      source: "warehouse",
    },
    b: { subject: "business tier", predicate: "priced-at", object: "599 USD" },
  },
  {
    id: "warehouse-draft",
    relation: "tier-guarded-rival",
    why:
      "The SYMMETRIC direction, which the ticket did not expect and ADR-0037 §4 decides the " +
      "same way: a newly-produced warehouse fact colliding with a published extracted fact " +
      "also stops at tension. Auto-stamping here is autonomous supersession by ADR-0036's own " +
      "definition, merely with the sympathetic side winning — and the warehouse row is a " +
      "SNAPSHOT that may already be hours old, while a stale extracted fact in visible tension " +
      "is recoverable and a stamp is not.\n" +
      "  Falsifies the DRAFT-side arm alone: with only the entry above, deleting " +
      "`supersedableTierSql(d)` from the collision predicate stays green.",
    a: { subject: "Business_Tier", predicate: "Priced At", object: "499 USD" },
    b: {
      subject: "business tier",
      predicate: "priced-at",
      object: "599 USD",
      source: "warehouse",
    },
  },
  {
    id: "warehouse-both",
    relation: "tier-guarded-rival",
    why:
      "⚠️ WAREHOUSE↔WAREHOUSE RE-EMISSION — the producer re-runs, the price has moved, and the " +
      "new snapshot collides with its own predecessor. Tension-only, like every other cell of " +
      "this relation, and pinned HERE because it is the case a future reader is most likely to " +
      "'fix' by weakening the guard to block only when EXACTLY ONE side is warehouse — i.e. " +
      "warehouse↔warehouse may stamp. That weakening restores the stamp in the one direction " +
      "#4759 §2 forbids by name: a machine invalidating a fact.\n" +
      "  The consequence is real and was accepted with its eyes open — #5008's resolution " +
      "records it as open Fog: the brain accumulates a reviewer prompt every time a number the " +
      "warehouse already knows moves. The escape hatch (the producer stamps its own previous " +
      "snapshot) is a producer-design decision that no milestone has scoped, not a hole in " +
      "this guard.",
    a: {
      subject: "Business_Tier",
      predicate: "Priced At",
      object: "499 USD",
      source: "warehouse",
    },
    b: {
      subject: "business tier",
      predicate: "priced-at",
      object: "599 USD",
      source: "warehouse",
    },
  },
  {
    id: "unresolvable-incumbent",
    relation: "tier-guarded-rival",
    why:
      "⚠️ THE entry that separates an ALLOWLIST from a DENYLIST, and the only one that does. " +
      "`warehouse:prod` is one of the three drift shapes `sources.ts` names, and it reaches " +
      "`brain_facts` through the ONE producer with no vocabulary gate: the region import " +
      "restores a bundle's `source` verbatim so a bundle written by a newer vocabulary still " +
      "imports. `isWarehouseDerivedSource` answers `false` for it — so a guard spelled " +
      "`source <> 'warehouse'` admits the stamp, and the fact this region cannot classify is " +
      "retired by an LLM draft.\n" +
      "  That is #4964's conclusion arriving one seam over. There it cost a lost correction " +
      "refusal, recoverable by deploying the vocabulary that knows the kind; here it costs a " +
      "`valid_to` stamp, recoverable by nothing. So WHEN `source` IS PRESENT the guard requires " +
      "POSITIVE evidence of a sub-tier-1 kind, exactly as #5030 made supersession require " +
      "positive evidence of difference. (An ABSENT `source` is the separate carve-out, which " +
      "passes on no evidence at all — `promotion-pg.test.ts` owns it.)\n" +
      "  Byte-identical to `warehouse-incumbent` but for the stored value, so the two are also " +
      "each other's controls: a guard that resolved the class correctly but forgot the " +
      "unresolvable case passes that entry and fails this one. (That pairing only means " +
      "anything while `warehouse` really names a vocabulary member and `warehouse:prod` really " +
      "does not — which the corpus-invariant test `the tier fixtures name what they claim to` " +
      "asserts against `sources.ts`, since this module may not import it.)",
    a: {
      subject: "Business_Tier",
      predicate: "Priced At",
      object: "499 USD",
      source: "warehouse:prod",
    },
    b: { subject: "business tier", predicate: "priced-at", object: "599 USD" },
  },
  {
    id: "unresolvable-draft",
    relation: "tier-guarded-rival",
    why:
      "The unresolvable kind on the DRAFT side — `unresolvable-incumbent` mirrored, for the " +
      "reason `warehouse-draft` mirrors `warehouse-incumbent`. Without it the allowlist is " +
      "falsified on one alias only: weaken the guard to a denylist on the `d` side ALONE and " +
      "every other entry in the corpus stays green.\n" +
      "  Production-reachable rather than symmetric-for-its-own-sake: the region import writes " +
      "`status` verbatim (ADR-0024), so an imported row can arrive as a DRAFT carrying a source " +
      "kind this region cannot classify, and that draft is then a candidate to stamp an " +
      "ordinary extracted incumbent.",
    a: { subject: "Business_Tier", predicate: "Priced At", object: "499 USD" },
    b: {
      subject: "business tier",
      predicate: "priced-at",
      object: "599 USD",
      source: "warehouse:prod",
    },
  },
  {
    id: "subject-differs",
    relation: "different-claim",
    why:
      "Two tiers, each priced differently — no contradiction, nothing to arbitrate. Exists " +
      "to make the SUBJECT arm falsifiable: the predicates match and the objects are " +
      "PROVABLY different, so `subject_key =` is the only thing holding these apart, and " +
      "dropping it from the rival scan or the collision join turns this red. Every other " +
      "`different-claim` entry is also blocked by some other arm.\n" +
      "  ⚠️ The objects are money rather than two names since #5030, and the change is " +
      "load-bearing rather than cosmetic. With `Grace`/`Alan` the object arm abstains, so " +
      "the pair is blocked by the OBJECT and this entry stops falsifying the subject arm " +
      "for consumer 3 — a prohibition satisfied by the wrong arm, which is precisely the " +
      "trap this file's arm-coverage table exists to close.",
    a: { subject: "business tier", predicate: "priced at", object: "499 USD" },
    b: { subject: "starter tier", predicate: "priced at", object: "199 USD" },
  },
  {
    id: "predicate-differs",
    relation: "different-claim",
    why:
      "What a tier costs and what it costs to renew are different questions, and both " +
      "answers are true at once. The PREDICATE arm's falsifier, by the same argument as " +
      "the entry above — and the one the repo most needed: the whole supersession section " +
      "of `promotion-pg.test.ts` runs on a single predicate, so deleting " +
      "`p.predicate_key = d.predicate_key` from the collision join broke no test anywhere. " +
      "Objects are money for the reason recorded on `subject-differs`.",
    a: { subject: "business tier", predicate: "priced at", object: "499 USD" },
    b: { subject: "business tier", predicate: "renews at", object: "449 USD" },
  },
  {
    id: "inverse-relations",
    relation: "different-claim",
    why:
      "`led_by` and `leads` are INVERSE relations: they swap subject and object, so the " +
      "pair asserts one fact from two directions and neither side is a rival to the other. " +
      "Morphological normalization folds them together (T3 §3 falsified it with this pair), " +
      "and at `single` cardinality that hands the publish gate a `valid_to` stamp on a true " +
      "belief. Live in the corpus that started this map.",
    a: { subject: "Osprey rollout", predicate: "led_by", object: "Ana" },
    b: { subject: "Ana", predicate: "leads", object: "Osprey rollout" },
  },
  {
    id: "copula-pair",
    relation: "different-claim",
    why:
      "#5000's PREDICATE pair, with the objects held equal so the predicate slot is the " +
      "only variable. ADR-0037 §6 settles it as a vocabulary ENTRY with a reviewer behind " +
      "it (#5016) rather than a normalization rule — because the rule that closes this also " +
      "folds `is owned by` into `owns`, and `led_by` into `leads` (above). Until an entry " +
      "exists, the honest answer is two claims. " +
      "NOT the live #5000 rows: those are `499 a month` vs `599 a month`, whose objects " +
      "DISAGREE (ADR-0037 §4's correction to the record) — that instance is a contradiction, " +
      "and would be an `unproven-rival` here once an alias entry unified the predicates — `499 a month` is three tokens and the money grammar takes exactly two, so both sides abstain.",
    a: { subject: "Business tier", predicate: "is priced at", object: "$499" },
    b: { subject: "Business tier", predicate: "priced at", object: "$499" },
  },
  {
    id: "entity-alias",
    relation: "different-claim",
    why:
      "The same machine, two names — and unifying them is the ENTITY RESOLVER's decision, " +
      "per workspace, with a seam built for it. The lexical layer takes no decision it " +
      "owns: a rule that collapsed these would collapse every abbreviation in the corpus " +
      "globally, with no reviewer anywhere.",
    a: { subject: "deploy-01", predicate: "hosts", object: "the release job" },
    b: { subject: "the deploy box", predicate: "hosts", object: "the release job" },
  },
] as const satisfies readonly ClaimPair[];

/** One consumer's contract, per relation. */
export interface Verdict {
  /** The second observation strengthens the first instead of minting a row. */
  readonly corroborates: boolean;
  /** The pair earns an advisory `in-tension-with` edge at `single` cardinality. */
  readonly tension: boolean;
  /** Publishing the second stamps `valid_to` on the first. */
  readonly supersedes: boolean;
}

/**
 * What each consumer must say about each relation. ONE table, and every
 * assertion in `identity-consumers-pg.test.ts` is COMPUTED from it — flipping a
 * cell turns three tests red rather than being quietly contradicted by a
 * hardcoded literal beside it. That is what stops the three consumers drifting
 * into disagreeing about what collides.
 *
 * Read down a column and it is one consumer's contract; read across a row and it
 * is the three verdicts one relation earns. Every cell is exercised — the
 * `false` cells are the prohibitions, each paired with the `true` cell from its
 * own column as the positive control that proves the machinery ran.
 *
 * Flipping a cell reddens the tests in THAT COLUMN's consumer — the columns are
 * not cross-checked against each other, and should not be: they are three
 * different questions about one relation.
 */
export const VERDICTS = {
  // One claim: it corroborates, so there is no second row to contend with —
  // both the other two verdicts follow from there being nothing to compare.
  "same-claim": { corroborates: true, tension: false, supersedes: false },
  // One slot, two values, agreement UNKNOWN. The two beliefs coexist, visibly
  // flagged, and NOTHING settles them autonomously — the publish gate stamps
  // nothing, because it has no evidence they disagree beyond two strings not
  // matching. A human settles it at the review queue the tension edge feeds.
  "unproven-rival": { corroborates: false, tension: true, supersedes: false },
  // One slot, two values, agreement DIFFERENT — both sides comparable, same
  // type, unequal. The only class that supersedes.
  "proven-rival": { corroborates: false, tension: true, supersedes: true },
  // The same three-valued verdict as `proven-rival` — the identity layer does
  // not branch on source and this row is byte-identical to the one above except
  // in its last cell. That is the whole shape of #5033: the collision is found,
  // the tension edge is written, the reviewer sees the pair, and only the
  // irreversible CONSEQUENCE is withheld. A future edit that gave this row
  // `supersedes: true` would not be simplifying a duplicate — it would be
  // deleting the guard.
  "tier-guarded-rival": { corroborates: false, tension: true, supersedes: false },
  // Two slots: every consumer must leave the pair entirely alone.
  "different-claim": { corroborates: false, tension: false, supersedes: false },
} as const satisfies Record<SlotRelation, Verdict>;

/** The corpus, split by relation — the two halves of each prohibition/control pairing. */
export function pairsWhere(relation: SlotRelation): readonly ClaimPair[] {
  return IDENTITY_CORPUS.filter((pair) => pair.relation === relation);
}
