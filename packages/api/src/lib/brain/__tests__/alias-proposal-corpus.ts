/**
 * The corpus behind the alias-proposal query (#5034, ADR-0037 §4).
 *
 * `alias-proposal-pg.test.ts` lands each case's rows through `reconcileFacts`
 * into that case's own workspace, runs `loadAliasCandidates`, and asserts the
 * result EXACTLY. Nothing here writes a key, a norm, or an `object_cmp` — the
 * human authors surfaces and a claim about what a reviewer ought to be shown,
 * and the system supplies every identity value and every observed candidate.
 * That is ADR-0037 §9's *one side of every identity assertion must be a value
 * the system produced* applied to the inputs.
 *
 * ## Why this is a SECOND corpus rather than a column on `identity-corpus.ts`
 *
 * The unit differs, and the difference is not cosmetic. That corpus is a set of
 * PAIRS, each carrying one `relation` from which all three consumers' verdicts
 * are computed; the proposal query's verdict is not a function of `relation` at
 * all. `copula-pair` and the live #5000 rows are both `different-claim` and this
 * query must answer differently about them — the first is a restatement it
 * should propose an alias for, the second a contradiction it must not. A single
 * verdict cell could not hold both.
 *
 * The unit here is a WORKSPACE: a set of rows plus the exact candidate set the
 * query must return over them. Several cases need more than two rows (the repeat
 * gate is a claim about how many distinct subjects exhibit a pair), which a
 * pair-shaped corpus cannot express either.
 *
 * ## Reading the case table
 *
 * | case | proposes | the arm it falsifies |
 * |---|---|---|
 * | `restatement-across-subjects` | the pair | ⭐ THE POSITIVE CONTROL — proves the query fires at all |
 * | `inverse-relations` | the control pair only | ⭐ `led_by`/`leads` never surface, beside a firing control |
 * | `subject-differs` | nothing | the SUBJECT arm |
 * | `objects-contradict` | nothing | the object EQUALITY arm |
 * | `prod-5000-pair` | nothing | ⭐ #5000's live rows, so nobody "fixes" the coverage gap |
 * | `seen-once` | nothing | the REPEAT GATE |
 * | `seen-twice` | the pair | the repeat gate's control — it is a threshold, not an off switch |
 * | `one-subject-two-objects` | nothing | `COUNT(DISTINCT subject_key)` vs `COUNT(*)` |
 * | `warehouse-target` | the pair, DIRECTED | the direction rule, and which side is the target |
 * | `warehouse-target-swapped` | the pair, DIRECTED | the same rule with the norms in the OTHER byte order — the swap |
 * | `warehouse-both` | the pair, undirected | *exactly one* — kills `either side is warehouse ⇒ directed` |
 * | `unclassifiable-source` | the pair, undirected | kills `directed = NOT supersedableTierSql(…)` |
 *
 * ## Two arms are deliberately NOT falsified here, and both are stated
 *
 * **The `predicate_key >` arm cannot be reached in the direction that would
 * catch a `<>`.** The shape that would catch it is *same subject, same
 * predicate, two rows*, and `reconcileFacts` cannot produce it — corroboration
 * merges the second claim into the first before a row exists. (Two spellings
 * whose `object_key`s differ but whose comparable values agree merge too: the
 * `object_cmp` arm of `objectSameSql` fires.) `identity-corpus.ts` records the
 * same unreachability one arm over, for the rival scan's `object_key <> $4`.
 *
 * What IS caught, and by the ordinary controls rather than by a case of its
 * own, is the over-match: weaken `>` to `>=` and every row joins ITSELF, so
 * every predicate becomes its own alias candidate. Every `proposes` list below
 * is asserted EXACTLY, so a self-pair turns the two firing cases red.
 *
 * **`inverse-relations` is blocked by TWO arms at once and no fixture can
 * isolate one.** That is the property, not a gap: inverse relations SWAP subject
 * and object, so `Osprey rollout / led_by / Ana` and `Ana / leads / Osprey
 * rollout` fail the subject arm and the object arm together. There is no
 * spelling of an inverse pair that fails only one. T7 §6 records the same
 * conclusion (*the claim is sound; it is simply untestable until the query can
 * fire at all*) — which is exactly why the case carries a firing control in the
 * SAME workspace. Without it, "the query proposed nothing" is satisfied by a
 * query that does nothing.
 *
 * ## What a human is allowed to write here
 *
 * Surfaces, an episode source kind, and a claim about which pairs a reviewer
 * should be shown. Never a norm, never a comparable value, never a repeat count
 * the test does not observe. Deriving an expectation from the implementation
 * would compare the layer to itself and pass against any implementation,
 * including one that returns a constant.
 *
 * Not a `.test.ts`, so the isolated runner does not execute it — the same reason
 * `identity-corpus.ts` and `identity-fixtures.ts` are not.
 */

// A TYPE-only import: this module stays free of behaviour, so it can never agree
// with the implementation by sharing code with it. Same discipline as
// `identity-corpus.ts`, and the same reason.
import type { DeclaredObjectType } from "@atlas/api/lib/brain/object-cmp";

/**
 * One stored claim.
 *
 * Deliberately NOT `identity-corpus.ts`'s `Claim`, despite the overlap. That
 * type carries `subjectEntityId`, which feeds `subject_cmp` — a column this
 * query has no arm for and must not grow one (see `ALIAS_PROPOSAL_SQL`'s
 * docstring on why homonymy does not suppress a proposal). Importing the type
 * would put a field on every fixture here that the suite must then be careful to
 * ignore, and a field a suite ignores is one a later edit sets by accident.
 */
export interface ProposalClaim {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  /**
   * The episode's stored kind — what `reconcile.ts` copies into
   * `provenance.source` and what the DIRECTION rule reads. Omitted by every case
   * that does not vary it; the suite defaults it to the ordinary extracted case.
   *
   * ⚠️ Deliberately `string`, not `EpisodeSource`. A value OUTSIDE the
   * vocabulary is a real stored shape (the region import restores a bundle's
   * `source` verbatim with no vocabulary gate) and it is the population
   * `unclassifiable-source` exists for. Typing it to the union would make the
   * corpus unable to express the case that distinguishes the shipped
   * positive-evidence rule from a negated tier guard.
   */
  readonly source?: string;
  /** What the producer says its object IS. Unused today; kept for parity with `FactCandidate`. */
  readonly objectType?: DeclaredObjectType;
}

/** One candidate the query must return. */
export interface ExpectedProposal {
  /**
   * The two predicate SURFACES, as they appear in `rows`. Order is not
   * significant — the suite compares unordered, because the query's orientation
   * is set by a byte comparison of NORMS, which is the implementation's business
   * and not a claim a human should be authoring.
   */
  readonly predicates: readonly [string, string];
  /**
   * The predicate surface the direction rule must name as the TARGET, or `null`
   * when the candidate must be UNDIRECTED.
   *
   * `null` is the common case and the safe one: with no warehouse side there is
   * nothing in the evidence that prefers one spelling, so approval routes the
   * choice to a human.
   */
  readonly target: string | null;
  /**
   * How many DISTINCT subjects the query must have counted. Asserted, not
   * decorative — it is the number the repeat gate is a threshold on, and
   * `one-subject-two-objects` exists because `COUNT(*)` and
   * `COUNT(DISTINCT subject_key)` differ only where a fixture makes them.
   */
  readonly subjects: number;
}

export interface ProposalCase {
  readonly id: string;
  /** Why a human says so. In English, because the claim is about English. */
  readonly why: string;
  /** Landed into this case's own workspace, in order. */
  readonly rows: readonly ProposalClaim[];
  /** EXACTLY what the query must return. Empty is a prohibition. */
  readonly proposes: readonly ExpectedProposal[];
}

/**
 * The objects are money and numbers throughout, and that is load-bearing rather
 * than a stylistic choice.
 *
 * `object_cmp` is the only thing this query joins on, and it is populated by a
 * fail-closed parse: `499 USD` yields `money:USD:499`, a bare `2019` yields
 * `number:2019`, and `$499`, `499 a month`, `Ana` and every other entity-shaped
 * surface yield NULL. A corpus of names would leave every case proposing
 * nothing, including the controls — a green suite over machinery that does
 * nothing at all, which is the exact failure ADR-0037 §9 names.
 */
export const ALIAS_PROPOSAL_CORPUS = [
  {
    id: "restatement-across-subjects",
    why:
      "⭐ THE POSITIVE CONTROL, and every prohibition below is licensed by it. Two tiers, " +
      "each priced once in each of two spellings, with the price stated identically both " +
      "times. The system can PROVE the two claims agree about the object and can see they " +
      "did not share a slot — which is ADR-0037 §4's *agreement without a slot*, and " +
      "structurally the definition of a missing alias.\n" +
      "  This is T4 §3's worked example, corrected: T4 spelled it with `$499`, which parses " +
      "to no comparable value at all, so the pair it illustrated the rule with could not " +
      "actually fire it. `499 USD` is the same claim in the spelling the money grammar " +
      "accepts.\n" +
      "  UNDIRECTED, because neither side is warehouse-derived. Nothing in the evidence " +
      "says `priced at` is more canonical than `is priced at`, and #5000's own pair is this " +
      "shape — approval picks the target.",
    rows: [
      { subject: "Business tier", predicate: "is priced at", object: "499 USD" },
      { subject: "Business tier", predicate: "priced at", object: "499 USD" },
      { subject: "Starter tier", predicate: "is priced at", object: "199 USD" },
      { subject: "Starter tier", predicate: "priced at", object: "199 USD" },
    ],
    proposes: [{ predicates: ["is priced at", "priced at"], target: null, subjects: 2 }],
  },
  {
    id: "inverse-relations",
    why:
      "⭐ THE prohibition ADR-0037 §4 names by hand. `led_by` and `leads` are both live in " +
      "the corpus that started this map, they are INVERSE relations, and they are exactly " +
      "the top-ranked pair any similarity detector returns — approving that alias stamps " +
      "`valid_to` across the manager graph.\n" +
      "  They never surface because inverse relations SWAP subject and object: `Osprey " +
      "rollout / led_by / Ana` and `Ana / leads / Osprey rollout` fail the subject arm and " +
      "the object arm at once. Both, and no spelling of an inverse pair fails only one — so " +
      "this case cannot isolate an arm, and does not pretend to.\n" +
      "  ⚠️ What makes it a real test is the four control rows landed in the SAME workspace. " +
      "They are `restatement-across-subjects`, verbatim. Without them the assertion is " +
      "satisfied by a query that returns nothing on any input, which is precisely the state " +
      "of this query on day one.",
    rows: [
      { subject: "Osprey rollout", predicate: "led_by", object: "Ana" },
      { subject: "Ana", predicate: "leads", object: "Osprey rollout" },
      { subject: "Falcon rollout", predicate: "led_by", object: "Bo" },
      { subject: "Bo", predicate: "leads", object: "Falcon rollout" },
      { subject: "Business tier", predicate: "is priced at", object: "499 USD" },
      { subject: "Business tier", predicate: "priced at", object: "499 USD" },
      { subject: "Starter tier", predicate: "is priced at", object: "199 USD" },
      { subject: "Starter tier", predicate: "priced at", object: "199 USD" },
    ],
    proposes: [{ predicates: ["is priced at", "priced at"], target: null, subjects: 2 }],
  },
  {
    id: "subject-differs",
    why:
      "The SUBJECT arm's own falsifier. Four tiers that happen to cost the same, described " +
      "in two spellings — the predicates differ and the objects are PROVABLY equal, so the " +
      "subject arm is the only thing holding these apart. Delete `b.subject_key = " +
      "a.subject_key` and this case proposes a pair.\n" +
      "  It is also the shape a near-miss detector produces on real data: two predicates " +
      "that both mean *costs this much* will collide across unrelated subjects constantly, " +
      "and agreeing about one subject's price is what makes the evidence about the " +
      "PREDICATES rather than about the number 499.",
    rows: [
      { subject: "Business tier", predicate: "is priced at", object: "499 USD" },
      { subject: "Starter tier", predicate: "priced at", object: "499 USD" },
      { subject: "Growth tier", predicate: "is priced at", object: "499 USD" },
      { subject: "Enterprise tier", predicate: "priced at", object: "499 USD" },
    ],
    proposes: [],
  },
  {
    id: "objects-contradict",
    why:
      "The object EQUALITY arm's falsifier, and the case that keeps the rule STRUCTURAL. " +
      "Same subjects, same two predicate spellings, comparable objects that DISAGREE. " +
      "Relax the arm from *equal* to *both present* — the obvious way to make the query " +
      "cover #5000 — and this case proposes a pair on evidence that says the two claims " +
      "CONTRADICT each other.\n" +
      "  That relaxation is a lexical near-miss detector wearing a structural hat: it would " +
      "return every `Business tier` predicate pair in the workspace, ranked by nothing.",
    rows: [
      { subject: "Business tier", predicate: "is priced at", object: "499 USD" },
      { subject: "Business tier", predicate: "priced at", object: "599 USD" },
      { subject: "Starter tier", predicate: "is priced at", object: "199 USD" },
      { subject: "Starter tier", predicate: "priced at", object: "299 USD" },
    ],
    proposes: [],
  },
  {
    id: "prod-5000-pair",
    why:
      "⭐ #5000's LIVE rows, spelled as they are in prod — `499 a month` and `599 a month` — " +
      "so that the coverage gap ADR-0037 §4 records is itself falsifiable. T4 §3 claimed " +
      "#5000's own case as covered by this query and T7 §6 corrected it: the prod objects " +
      "DISAGREE, so this is a contradiction rather than a restatement, and the query " +
      "proposes NOTHING for it. #5000's vocabulary entry arrives through direct human " +
      "authoring (ADR-0037 §6).\n" +
      "  ⚠️ It is refused TWICE over, and only the first refusal is visible here: `499 a " +
      "month` is three tokens where the money grammar takes exactly two, so both sides " +
      "abstain and `object_cmp` is NULL on every row. `objects-contradict` above is the " +
      "case that isolates the equality arm; this one exists so that nobody reads *the query " +
      "does not fix #5000* as a bug and closes it by widening the arm.",
    rows: [
      { subject: "Business tier", predicate: "is priced at", object: "499 a month" },
      { subject: "Business tier", predicate: "priced at", object: "599 a month" },
      { subject: "Starter tier", predicate: "is priced at", object: "199 a month" },
      { subject: "Starter tier", predicate: "priced at", object: "299 a month" },
    ],
    proposes: [],
  },
  {
    id: "seen-once",
    why:
      "The REPEAT GATE, in ADR-0037 §4's own words: *a lone coincidental object match " +
      "(`Acme / founded / 2019` vs `Acme / incorporated / 2019`) does not become work*. " +
      "One company, founded and incorporated in the same year. The two claims genuinely " +
      "agree about the object and the predicates genuinely differ — the evidence is real " +
      "and it is an anecdote, and `founded`/`incorporated` are NOT synonyms.\n" +
      "  Its control is `seen-twice` below, and the two are the same rows with one more " +
      "company. Without that pairing this case passes against a gate set to infinity.",
    rows: [
      { subject: "Acme", predicate: "founded", object: "2019" },
      { subject: "Acme", predicate: "incorporated", object: "2019" },
    ],
    proposes: [],
  },
  {
    id: "seen-twice",
    why:
      "`seen-once`'s control: the same two claims plus a second company with the same " +
      "coincidence. The gate is a THRESHOLD and not an off switch, and this is what says " +
      "so — a gate stuck closed passes `seen-once` and every other prohibition in the file.\n" +
      "  ⚠️ It also shows the gate's honest cost. Two companies founded and incorporated in " +
      "the same year are still not evidence that `founded` and `incorporated` name one " +
      "relation, and this pair reaches the queue. That is the design: the threshold buys a " +
      "reviewer fewer entries, not correct ones, and the human is the filter. Raising it " +
      "would trade this false positive for a missed real one.",
    rows: [
      { subject: "Acme", predicate: "founded", object: "2019" },
      { subject: "Acme", predicate: "incorporated", object: "2019" },
      { subject: "Beta Industries", predicate: "founded", object: "2019" },
      { subject: "Beta Industries", predicate: "incorporated", object: "2019" },
    ],
    proposes: [{ predicates: ["founded", "incorporated"], target: null, subjects: 2 }],
  },
  {
    id: "one-subject-two-objects",
    why:
      "⭐ The falsifier for DISTINCT SUBJECTS, and the only case where `COUNT(*)` and " +
      "`COUNT(DISTINCT subject_key)` disagree. One company with two offices, each stated " +
      "under both predicate spellings: TWO agreeing evidence rows, ONE subject. Count rows " +
      "and the gate clears; count subjects and it does not.\n" +
      "  The distinction is the whole reason the gate counts subjects. A pair is a claim " +
      "about two PREDICATES, and only variety across subjects makes it that — one subject " +
      "repeating itself has told us about that subject.\n" +
      "  Postcodes rather than city names because the object has to be COMPARABLE for the " +
      "rows to join at all; `New York` parses to nothing.",
    rows: [
      { subject: "Acme", predicate: "located in", object: "10001" },
      { subject: "Acme", predicate: "has office in", object: "10001" },
      { subject: "Acme", predicate: "located in", object: "94107" },
      { subject: "Acme", predicate: "has office in", object: "94107" },
    ],
    proposes: [],
  },
  {
    id: "warehouse-target",
    why:
      "The DIRECTION rule (ADR-0037 §4): direction is fixed only when EXACTLY ONE side is " +
      "warehouse-derived, and the warehouse norm is the proposed TARGET — its space being " +
      "closed, typed and described, where English is open. A `price` column read off the " +
      "warehouse beside the same claim said in English, across two tiers.\n" +
      "  The target is asserted, not merely the directedness: a rule that set `directed` " +
      "correctly and picked the ENGLISH side would re-key the warehouse's own rows onto a " +
      "phrase nobody's schema contains, and `directed: true` alone cannot see that.",
    rows: [
      { subject: "Business tier", predicate: "price", object: "499 USD", source: "warehouse" },
      { subject: "Business tier", predicate: "is priced at", object: "499 USD" },
      { subject: "Starter tier", predicate: "price", object: "199 USD", source: "warehouse" },
      { subject: "Starter tier", predicate: "is priced at", object: "199 USD" },
    ],
    proposes: [{ predicates: ["is priced at", "price"], target: "price", subjects: 2 }],
  },
  {
    id: "warehouse-target-swapped",
    why:
      "`warehouse-target` with the two norms the other way round in BYTE ORDER, and it is a " +
      "separate case rather than a variation because the two exercise different code. The " +
      "query emits a pair oriented by `<`; the warehouse side is the TARGET, which is the " +
      "second position — so when the warehouse norm sorts FIRST the reader has to swap, and " +
      "when it sorts second it must not.\n" +
      "  `amount` beside `is billed at` puts the warehouse norm first (`a` < `i`), where " +
      "`price` beside `is priced at` puts it second. Measured: with only the `price` case, " +
      "deleting the swap killed ZERO tests in this file — the target was already in the " +
      "right position for the wrong reason. Both orientations, or the swap is decoration.",
    rows: [
      { subject: "Invoice 4471", predicate: "amount", object: "499 USD", source: "warehouse" },
      { subject: "Invoice 4471", predicate: "is billed at", object: "499 USD" },
      { subject: "Invoice 4472", predicate: "amount", object: "199 USD", source: "warehouse" },
      { subject: "Invoice 4472", predicate: "is billed at", object: "199 USD" },
    ],
    proposes: [{ predicates: ["amount", "is billed at"], target: "amount", subjects: 2 }],
  },
  {
    id: "warehouse-both",
    why:
      "*EXACTLY one*, spelled as a fixture. Two warehouse columns for the same quantity — a " +
      "real shape the moment a workspace has two connection groups, or one schema with both " +
      "`price` and `unit price`. Both spaces are closed, typed and described, so nothing " +
      "prefers one, and the candidate must be UNDIRECTED.\n" +
      "  It kills `either side is warehouse ⇒ directed`, which is the reading a person " +
      "arrives at from the sentence *the warehouse norm is the target* without the *exactly " +
      "one* qualifier. Under that rule this case would direct at whichever side the byte " +
      "ordering put second — a workspace-wide re-key chosen by `<`.",
    rows: [
      { subject: "Business tier", predicate: "price", object: "499 USD", source: "warehouse" },
      { subject: "Business tier", predicate: "unit price", object: "499 USD", source: "warehouse" },
      { subject: "Starter tier", predicate: "price", object: "199 USD", source: "warehouse" },
      { subject: "Starter tier", predicate: "unit price", object: "199 USD", source: "warehouse" },
    ],
    proposes: [{ predicates: ["price", "unit price"], target: null, subjects: 2 }],
  },
  {
    id: "unclassifiable-source",
    why:
      "⚠️ The case that stops the direction arm being written as `NOT " +
      "supersedableTierSql(…)`. One side carries `warehouse:prod` — a stored kind this " +
      "region cannot classify, which the region import restores verbatim with no vocabulary " +
      "gate — and the other is ordinary chat.\n" +
      "  Under the shipped POSITIVE rule neither side is warehouse-derived, so the candidate " +
      "is undirected and a human picks the target. Under a negated tier guard the " +
      "unclassifiable side reads as warehouse (it is not on the non-warehouse allowlist " +
      "either), and the query would name a target on the basis of a value nothing could " +
      "resolve — evidence of nothing becoming evidence of a direction.\n" +
      "  Same population #5033 refuses to STAMP; here the consequence is smaller and runs " +
      "the other way, and the fail-closed answer is *undirected* rather than *excluded*.",
    rows: [
      {
        subject: "Business tier",
        predicate: "price",
        object: "499 USD",
        source: "warehouse:prod",
      },
      { subject: "Business tier", predicate: "is priced at", object: "499 USD" },
      {
        subject: "Starter tier",
        predicate: "price",
        object: "199 USD",
        source: "warehouse:prod",
      },
      { subject: "Starter tier", predicate: "is priced at", object: "199 USD" },
    ],
    proposes: [{ predicates: ["is priced at", "price"], target: null, subjects: 2 }],
  },
] as const satisfies readonly ProposalCase[];
