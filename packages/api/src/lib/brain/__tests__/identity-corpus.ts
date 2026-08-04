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

/** One side of a pair — a whole claim, because identity is a triple. */
export interface Claim {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
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
export const RELATIONS = ["same-claim", "rival-claim", "different-claim"] as const;

/**
 * What a human says the two claims mean, relative to each other:
 *
 *   - `same-claim` — one claim, two spellings. Same subject slot, same
 *     predicate slot, same value.
 *   - `rival-claim` — one slot, two VALUES. The subject and predicate collide
 *     through a phrasing difference and the objects genuinely disagree. This is
 *     the contradiction class: byte-exact matching hid these, which is #5000.
 *   - `different-claim` — different slots. The claims may look near-identical
 *     to a lexical matcher and are not the same claim, so nothing may collide
 *     them. This is the direction where an over-match costs a `valid_to` stamp
 *     on a belief nobody retired.
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
 * `subject_key = … AND predicate_key = … AND object_key <>`, so a prohibition
 * can only bite on a given `=` arm when the OTHER two arms would have matched.
 * An entry whose objects are equal is blocked by the `<>` arm alone and proves
 * nothing about the subject or predicate arm. The six shapes below are what
 * make each arm individually falsifiable; `subject-differs` and
 * `predicate-differs` exist for exactly that reason and for no other.
 *
 * | entry | subject | predicate | object |
 * |---|---|---|---|
 * | `rival-through-phrasing` | = | = | ≠ |
 * | `subject-differs`        | ≠ | = | ≠ |
 * | `predicate-differs`      | = | ≠ | ≠ |
 * | `inverse-relations`      | ≠ | ≠ | ≠ |
 * | `copula-pair`            | = | ≠ | = |
 * | `entity-alias`           | ≠ | = | = |
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
    id: "rival-through-phrasing",
    relation: "rival-claim",
    why:
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
    id: "subject-differs",
    relation: "different-claim",
    why:
      "Two people, each reporting to someone different — no contradiction, nothing to " +
      "arbitrate. Exists to make the SUBJECT arm falsifiable: the predicates match and " +
      "the objects differ, so `subject_key =` is the only thing holding these apart, and " +
      "dropping it from the rival scan or the collision join turns this red. Every other " +
      "`different-claim` entry is also blocked by some other arm.",
    a: { subject: "ada", predicate: "reports to", object: "Grace" },
    b: { subject: "bea", predicate: "reports to", object: "Alan" },
  },
  {
    id: "predicate-differs",
    relation: "different-claim",
    why:
      "Who `Ada` reports to and who she sits with are different questions, and both " +
      "answers are true at once. The PREDICATE arm's falsifier, by the same argument as " +
      "the entry above — and the one the repo most needed: the whole supersession section " +
      "of `promotion-pg.test.ts` runs on a single predicate, so deleting " +
      "`p.predicate_key = d.predicate_key` from the collision join broke no test anywhere.",
    a: { subject: "ada", predicate: "reports to", object: "Grace" },
    b: { subject: "ada", predicate: "sits with", object: "Alan" },
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
      "and would be a `rival-claim` here once an alias entry unified the predicates.",
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
  // One slot, two values: the two beliefs coexist and are visibly in tension
  // while both are drafts, and the publish gate is where a human settles it.
  "rival-claim": { corroborates: false, tension: true, supersedes: true },
  // Two slots: every consumer must leave the pair entirely alone.
  "different-claim": { corroborates: false, tension: false, supersedes: false },
} as const satisfies Record<SlotRelation, Verdict>;

/** The corpus, split by relation — the two halves of each prohibition/control pairing. */
export function pairsWhere(relation: SlotRelation): readonly ClaimPair[] {
  return IDENTITY_CORPUS.filter((pair) => pair.relation === relation);
}
