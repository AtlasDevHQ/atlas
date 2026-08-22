/**
 * The alias-proposal query — what may propose a vocabulary edge (#5034,
 * ADR-0037 §4, T4 §3 as corrected by T7 §6).
 *
 * The seam proposes, from positive evidence it already computes:
 * **agreement without a slot.**
 *
 *     same subject_key
 *     AND object_cmp non-null AND equal on both sides
 *     AND predicate_key differs
 *
 * Two claims that provably agree about the OBJECT but failed to share a slot are
 * structurally the definition of a missing alias. This is **evidence, not
 * resemblance**, and the distinction is the whole of the module.
 *
 * ## ⚠️ Lexical near-miss detection is PROHIBITED as a proposal source
 *
 * No stemming, no edit distance, no copula- or stopword-stripping, no
 * embeddings. Stated as a prohibition rather than a preference because it is the
 * obvious thing to build and it has already been falsified against this repo's
 * own corpus: `led_by` and `leads` are both live, are **inverse** relations, and
 * are exactly the top-ranked pair any similarity detector returns. A
 * resemblance-seeded queue puts its most dangerous entry first wearing a high
 * confidence score, and approving it stamps `valid_to` across the manager graph.
 *
 * Structural evidence has the opposite bias, and that is why the rule is shaped
 * this way rather than merely accompanied by a warning: inverse relations SWAP
 * subject and object, so the subject arm and the object arm cannot both match and
 * the pair never surfaces. The prohibition is enforced by the join, not by a
 * filter someone can delete. `alias-proposal-pg.test.ts` pins it against the
 * corpus rather than against this paragraph — with a positive control beside it,
 * because on day one this query returns zero rows for want of populated
 * `object_cmp` and an unpaired prohibition is vacuous.
 *
 * ## ⚠️ It CANNOT propose #5000's own fix, and that is not a coverage gap
 *
 * T4 §3 illustrated the rule with *"`Business tier / price / $499` beside
 * `Business tier / is priced at / $499`"* and claimed #5000's own case as
 * covered. **The prod instance is not that pair.** #5000's rows are `499 a
 * month` and `599 a month` — the objects DISAGREE. That is the whole point of
 * the bug: it is a *contradiction*, not a restatement, and this query proposes
 * **nothing** for it. #5000's vocabulary entry arrives through direct human
 * authoring (ADR-0037 §6).
 *
 * **Do not relax the object arm to close that gap.** Relaxing it is a lexical
 * near-miss detector wearing a structural hat — it would return every `Business
 * tier` predicate pair in the workspace and rank `led_by`/`leads` near the top.
 * The gap is itself a falsification target (`alias-proposal-pg.test.ts` asserts
 * ZERO candidates for the prod pair) so that nobody later "fixes" the coverage
 * by widening the arm.
 *
 * ## Where this sits
 *
 * A PRODUCER, not a consumer: it reads the corpus and writes to
 * `brain_vocabulary_proposal` through `vocabulary-decide.ts`'s
 * {@link proposeAliasEdges}, which owns rejection memory, pair identity and the
 * decide split. Nothing here approves anything, and nothing here writes an edge.
 *
 * Shaped on `cardinality.ts`'s `proposeFromCorrectionEvents` deliberately — the
 * other repeat-gated proposer in this subsystem. Same three properties, for the
 * same reasons: it RE-DERIVES its gate from the corpus rather than incrementing a
 * counter (so a proposal deleted by hand is re-raised, and a REJECTED one is not,
 * because the rejected row occupies the pair's only slot); it runs in its own
 * transaction AFTER the caller's has committed (an advisory proposal must never
 * roll back the write that triggered it); and it THROWS, leaving the caller that
 * knows what already committed to decide what a failure means.
 *
 * ## The PREDICATE position only
 *
 * `slotPosition` is a literal here, and that is a scope decision rather than an
 * omission. The three-arm rule holds the subject fixed and requires the
 * predicates to differ, so what it finds is by construction a predicate pair.
 * The entity positions have a different and better evidence source — a warehouse
 * primary key, which is `warehouse_key`-class and auto-approvable — and routing
 * this query's output there would put structural corpus evidence through an
 * approval bar built for certainty.
 *
 * @see docs/adr/0037-claim-identity-in-the-brain.md §4
 * @see lib/brain/vocabulary-decide.ts — the queue, the rejection memory, decide
 * @see lib/brain/cardinality.ts — the sibling repeat-gated proposer
 */

import { createLogger } from "@atlas/api/lib/logger";
import { comparableSameSql } from "@atlas/api/lib/brain/object-cmp";
import { observationSql } from "@atlas/api/lib/brain/observation";
import {
  proposeAliasEdges,
  type AliasDecideDeps,
  type AliasProducerCounters,
  type AliasProposalInput,
} from "@atlas/api/lib/brain/vocabulary-decide";
import type { ReconcileExecutor, ReconcileTransactionRunner } from "@atlas/api/lib/brain/reconcile";
import { withBrainTransaction } from "@atlas/api/lib/brain/reconcile";

const log = createLogger("brain-alias-proposal");

/**
 * The minimal executor this module needs — `cardinality.ts`'s shape.
 *
 * Declared locally so this module's PUBLIC SURFACE names no `reconcile.ts`
 * type: a caller supplying its own executor need not reach for one. That is
 * the narrower claim `cardinality.ts:119` makes, and it is the true one here —
 * an earlier version said "without either module importing the other's concrete
 * runner", which the value import of `withBrainTransaction` a few lines up
 * falsifies.
 */
export interface AliasProposalExecutor {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: readonly unknown[] }>;
}

/**
 * Compile-time pin: a `reconcile.ts` `tx` must satisfy this module's executor.
 *
 * ⚠️ Spelled through `Assert<…>` with a `: false` else-branch, and BOTH halves
 * are load-bearing: an unused type alias is never checked, and `never extends
 * true` is vacuously true, so the first cut (`? true : never`, assigned to an
 * unused alias) pinned nothing twice over — the #5068 shape.
 *
 * ⚠️ **Be exact about what that cost, because the first version of this note was
 * not.** It claimed the broken form let drift through entirely. It did not:
 * `proposeAliasesFromCorpus`'s own `bounded((tx) => loadAliasCandidates(tx, …))`
 * checks the same assignability, so drift was caught there — with a message
 * pointing at a call site rather than at the contract. What this pin buys is a
 * named error, and survival if that call site ever changes shape. Both were
 * measured against a deliberately drifted executor.
 *
 * `: false` rather than `: never` because `never extends true` is vacuously
 * true, so the `never` spelling would stay dead even inside the assertion.
 */
type Assert<T extends true> = T;
type _ReconcileExecutorIsAnAliasProposalExecutor = Assert<
  ReconcileExecutor extends AliasProposalExecutor ? true : false
>;

/** The producer id recorded on every row this module proposes. */
export const SEAM_PROPOSAL_PRODUCER = "brain:alias-proposal";

/**
 * How many DISTINCT subjects must exhibit the same agreeing predicate pair
 * before it enters the queue.
 *
 * ## Distinct SUBJECTS, not evidence rows
 *
 * The pair is a claim about two PREDICATES, and only variety across subjects
 * makes it that. One subject with two office locations produces
 * `Acme / located in / NYC` beside `Acme / has office in / NYC` and again for
 * `SF` — two evidence rows, one subject, and nothing whatever about whether the
 * two predicates name one relation in general. Counting rows would make the
 * loudest evidence the least informative kind. `cardinality.ts`'s
 * `CORRECTION_REPEAT_COUNT_SQL` reached the same shape from the other direction
 * and its docstring carries the longer argument.
 *
 * ## TWO, where the correction gate is three
 *
 * On T3 §1's Pattern-identity precedent — *a seen-once pattern is captured but
 * sits below the default review queue until it repeats* — and matching
 * `lib/learn/pattern-tiers.ts`'s `REPEATED_PATTERN_MIN_REPETITIONS`. The
 * difference from `CORRECTION_REPEAT_THRESHOLD`'s three is a difference in the
 * evidence, not in the appetite:
 *
 *   - A correction event is CIRCUMSTANTIAL. A reviewer editing a slot may be
 *     fixing their own typing, so two of them is a coincidence one confused
 *     afternoon produces.
 *   - Agreement without a slot is POSITIVE and typed. Both sides carry a
 *     comparable value, the same tag, and equal bytes — two independent claims
 *     that the system can PROVE agree about the object while failing to share a
 *     predicate. A second, independent subject exhibiting it is already the
 *     coincidence being ruled out: `Acme / founded / 2019` beside
 *     `Acme / incorporated / 2019` is one subject and stays out.
 *
 * A PROPOSAL threshold, never an approval one. Getting it wrong costs a human a
 * queue entry to reject — and, at the predicate position, one they must direct
 * by hand before it can be approved at all. It can never cost a `valid_to`
 * stamp.
 */
export const ALIAS_PROPOSAL_REPEAT_THRESHOLD = 2;

/**
 * The most candidates one run may propose.
 *
 * A bound on the QUEUE rather than on the query's correctness: the pairs are
 * ordered by repeat count descending, so a truncated run drops the weakest
 * evidence and the next run re-derives the whole set from the corpus — this
 * producer holds no cursor and no watermark.
 *
 * ⚠️ **"The next run" is worth less than it sounds, and an earlier version of
 * this line said "nothing is lost permanently".** `extract.ts`'s
 * `proposeAliasesAfterCommit` is this producer's ONLY caller and it is gated on
 * an episode creating a comparable row — which the same docstring describes as
 * very nearly never. So a workspace with 30 agreeing pairs proposes 25 and the
 * remaining 5 wait for another comparable-creating episode that may not arrive.
 *
 * ⚠️ **It does not bound the query's COST, and reading it as if it did is the
 * mistake worth naming.** `LIMIT` applies after `GROUP BY`/`HAVING`, so the
 * self-join and the aggregate have already run in full; a hub subject with
 * hundreds of live facts produces a quadratic number of pairs before a single
 * row is dropped. {@link ALIAS_PROPOSAL_STATEMENT_TIMEOUT_SQL} is what bounds
 * the work, and the *"Cost: no new index"* section of
 * {@link ALIAS_PROPOSAL_SQL} establishes only that the join is INDEXABLE, not
 * that it is small.
 *
 * ⚠️ Truncation is LOGGED at `warn` ({@link loadAliasCandidates}), never silent.
 * A cap that binds quietly reads as *"this workspace has 25 agreeing pairs"* when
 * the truth is *"it has at least 25"*, and the operator debugging a missing
 * proposal has nothing to read.
 */
export const ALIAS_PROPOSAL_CANDIDATE_CAP = 25;

/**
 * How much a matching extractor hint raises a candidate's rank.
 *
 * Small, and deliberately smaller than the gap between adjacent repeat counts at
 * the low end ({@link structuralConfidence}: 2 subjects → 0.67, 3 → 0.75). A
 * hint may re-order two pairs whose structural evidence is otherwise equal; it
 * may never lift a two-subject pair above a three-subject one. That is the
 * quantitative form of *the hint ranks, the corpus decides*.
 */
export const ALIAS_HINT_RANK_BONUS = 0.05;

/**
 * *Positively warehouse-derived* — the direction arm (ADR-0037 §4).
 *
 * ⚠️ **NOT the negation of #5033's `supersedableTierSql`, and it must not be
 * rewritten as one.** That predicate answers *is there evidence this row is
 * below tier-1*, and admits a row carrying NO `source` key at all as a
 * deliberate carve-out.
 *
 * ⚠️ The two rules differ on **exactly one** population, and an earlier version
 * of this paragraph named the wrong one. `supersedableTierSql` is
 * `NOT jsonb_exists(…) OR source = ANY(non-warehouse)`, so negating it answers
 * FALSE for a `source`-less row — the same as this predicate. Evaluated against
 * Postgres rather than reasoned about:
 *
 * | stored `provenance` | this predicate | `NOT supersedableTierSql` |
 * |---|---|---|
 * | no `source` key | NULL → false | false |
 * | `{"source":"slack"}` | false | false |
 * | `{"source":"warehouse:prod"}` | false | **true** ← the only divergence |
 * | `{"source":"warehouse"}` | true | true |
 *
 * One population, and it is the one that matters: a kind this region cannot
 * classify would become the canonical TARGET of a workspace-wide re-key on
 * evidence of nothing. That is the whole reason the rule is a positive
 * allowlist, and `unclassifiable-source` in the corpus is what proves it.
 *
 * Three populations, and only the first is TRUE here:
 *
 *   - `source` resolves to a warehouse-class member → TRUE. Its space is closed,
 *     typed and described, which is the entire argument for making it the target.
 *   - `source` is present and resolves to anything else → FALSE.
 *   - `source` is present and does not resolve to a warehouse-class member
 *     (`slack`, and also `warehouse:prod` or `snowflake`) → FALSE. Evidence of
 *     nothing must not become evidence of a direction.
 *   - `source` is ABSENT → `provenance->>'source'` is SQL NULL, so `= ANY(…)` is
 *     unknown and `bool_or` over an all-NULL group answers NULL, folded to
 *     FALSE by {@link ALIAS_PROPOSAL_SQL}'s `COALESCE`. ⚠️ Only the ABSENT case
 *     reaches NULL — an earlier version of this bullet folded the unresolvable
 *     case in with it, which the truth table above contradicts.
 *
 * FALSE on both sides makes the candidate UNDIRECTED, which is the fail-closed
 * outcome: approval routes the choice of target to a human instead of the
 * producer guessing it.
 *
 * `alias` is interpolated; callers pass a plain identifier they control — the
 * same contract as `supersedableTierSql` and `comparableDifferentSql`.
 *
 * ⚠️ The SPELLING is `observationSql` (`lib/brain/observation.ts`), called
 * directly at the two sites below. It moved there at #5341, where ADR-0042's
 * serving exclusion needed the identical predicate — one string with two
 * readings that are the same reading: *this stored row is an observation*. This
 * block stays because what it argues is THIS consumer's rule — why the
 * DIRECTION arm must be a positive allowlist — which is not what the SQL says
 * and does not belong next to the SQL.
 */

/**
 * The proposal query. Exported so the real-Postgres suite runs this exact string
 * against the live schema rather than asserting a paraphrase of it.
 *
 * ## The three arms, and what each one refuses
 *
 * | arm | refuses |
 * |---|---|
 * | `b.subject_key = a.subject_key` | inverse relations — they swap subject and object, so this and the object arm cannot both hold |
 * | `object_cmp` equal, both non-null | contradictions (#5000's prod pair), and the whole `unknown` band |
 * | `b.predicate_key > a.predicate_key` | one claim seen twice, and the pair's mirror image |
 *
 * `>` rather than `<>` does two jobs at once and both are load-bearing. It is
 * the *differs* arm — a total order excludes equality — and it is what makes the
 * self-join emit each unordered pair ONCE, in a stable orientation, so the
 * `GROUP BY` counts a pair rather than counting it twice under two spellings.
 * `LEAST`/`GREATEST` would be the second spelling of that and would still need
 * the inequality.
 *
 * ⚠️ NULL keys join nothing here, which is the abstention every consumer in this
 * subsystem shares: `NULL = NULL` is unknown and so is `NULL > 'x'`. A row whose
 * surface norms away therefore proposes nothing, in the direction that costs a
 * missing proposal rather than a wrong one.
 *
 * ## `a.object_cmp IS NOT NULL` is redundant TODAY and is a second line of defence
 *
 * `comparableSameSql` is `a = b`, which is NULL — and so excluded — whenever
 * either side is NULL, so under the shipped spelling this arm changes no result.
 * It is written anyway for three reasons, and the third was MEASURED rather than
 * anticipated:
 *
 *   1. it states ADR-0037 §4's rule as the ADR spells it (*non-null AND equal on
 *      both sides*) rather than leaving it implied by SQL's NULL semantics;
 *   2. it makes the day-one behaviour legible — `object_cmp` is never
 *      backfilled, so on a workspace with no entity store this predicate is
 *      false for every row and the query returns zero candidates;
 *   3. ⚠️ **it is the arm that survives the most likely relaxation.** Rewriting
 *      the object arm as `IS NOT DISTINCT FROM` — the NULL-safe spelling, which
 *      reads as a fix for the day-one zero-rows problem — makes two ABSENT
 *      comparables count as agreement, which is the widest possible widening:
 *      every predicate pair in the workspace whose objects are both unparseable
 *      becomes a candidate. With this arm present that rewrite still returns
 *      nothing. The mutation table's *admits two NULLs as agreement* row has to
 *      delete BOTH to land, which is the honest measurement of what this arm is
 *      worth: it does not stop the relaxation, it makes it take two edits.
 *
 * ## The object arm is the SHARED spelling
 *
 * `comparableSameSql` and not a hand-written `=`, so this producer and
 * corroboration cannot drift into disagreeing about what *provably the same
 * object* means. It inherits that builder's stated residual — two byte-identical
 * MALFORMED values compare equal and there is no well-formedness arm — and the
 * consequence lands softer here than anywhere else it is inherited: a malformed
 * match costs a queue entry a human rejects, not a merge and not a stamp.
 *
 * ## The arms it does NOT have
 *
 * No `status` arm, matching `CORROBORATION_LOOKUP_SQL` and
 * `TENSION_CANDIDATES_SQL`. A draft is real evidence of what a workspace's
 * producers say, and the proposal it feeds is reviewed by a human either way.
 * No grant arm either: the vocabulary is the one piece of brain state with no
 * ACL, permanently (ADR-0037 §6), and this producer is a fiber with no reader.
 * Proposal VISIBILITY is positional and is re-derived at READ time by #5025's
 * queue, from the evidence rows rather than stored here as a second, drifting
 * ACL — see ADR-0037 §6's correction to T11 §5(b).
 *
 * No `subject_cmp` arm, and its absence is a decision rather than an oversight.
 * The homonymy suppression (#5032) exists to stop two claims about DIFFERENT
 * entities merging; here the two claims are held in the same subject SLOT by
 * `subject_key` and the evidence being read is about the two PREDICATES. A
 * homonym pair that agrees about the object under two predicate spellings is
 * still evidence those spellings name one relation, and the proposal it raises
 * re-keys predicates and touches no subject.
 *
 * ## Cost: no new index
 *
 * `idx_brain_facts_subject` is `(workspace_id, subject_key, predicate_key)
 * WHERE invalidated_at IS NULL AND valid_to IS NULL` — the index #5019
 * repointed onto the identity keys. Both sides of this join are exactly that
 * shape, and the live-set arms are repeated on both sides so both may use it.
 */
export const ALIAS_PROPOSAL_SQL = `
  WITH agreeing AS (
    SELECT a.predicate_key AS from_norm,
           b.predicate_key AS to_norm,
           a.subject_key   AS subject_key,
           ${observationSql("a")} AS from_warehouse,
           ${observationSql("b")} AS to_warehouse
      FROM brain_facts a
      JOIN brain_facts b
        ON b.workspace_id = a.workspace_id
       AND b.subject_key = a.subject_key
       AND ${comparableSameSql("b.object_cmp", "a.object_cmp")}
       AND b.predicate_key > a.predicate_key
       AND b.invalidated_at IS NULL
       AND b.valid_to IS NULL
     WHERE a.workspace_id = $1
       AND a.object_cmp IS NOT NULL
       AND a.invalidated_at IS NULL
       AND a.valid_to IS NULL
  )
  SELECT from_norm,
         to_norm,
         COUNT(DISTINCT subject_key)::int   AS subjects,
         COALESCE(bool_or(from_warehouse), false) AS from_warehouse,
         COALESCE(bool_or(to_warehouse), false)   AS to_warehouse
    FROM agreeing
   GROUP BY from_norm, to_norm
  HAVING COUNT(DISTINCT subject_key) >= $2
   ORDER BY COUNT(DISTINCT subject_key) DESC, from_norm, to_norm
   LIMIT $3`;

/**
 * One structural candidate, as the query found it.
 *
 * Carries the EVIDENCE COUNT rather than a score, so the ranking function is
 * visible at one place ({@link structuralConfidence}) instead of being baked
 * into the SQL where no test can vary it.
 */
export interface AliasCandidate {
  readonly fromNorm: string;
  readonly toNorm: string;
  /**
   * Distinct subjects exhibiting the pair — the repeat gate's own number,
   * checked at {@link toCandidate} and branded there so
   * {@link structuralConfidence}'s codomain is provable from its signature.
   */
  readonly subjects: SubjectCount;
  /**
   * TRUE only when EXACTLY ONE side has warehouse-derived evidence (ADR-0037
   * §4). When true, {@link toNorm} is that side: the warehouse norm is the
   * proposed target, its space being closed, typed and described.
   *
   * When neither side is — or both are — the candidate is UNDIRECTED and
   * approval picks the target. Both-warehouse is undirected for the same reason
   * neither-warehouse is: the rule is *exactly one*, and with two closed spaces
   * nothing in the evidence prefers one over the other.
   *
   * ⚠️ **This is a cross-field claim and no type carries it.** `directed: true`
   * asserts something about `toNorm`'s POSITION, and the correlation is
   * established by one branch in {@link toCandidate} and re-checked nowhere —
   * so a value built anywhere else can spell `directed: true` with no warehouse
   * evidence at all, and downstream that becomes a proposal whose approval sets
   * the target without a human supplying one. The falsifiers are the corpus's
   * `warehouse-target` / `warehouse-target-swapped` pair (which assert the
   * TARGET, not merely the flag) and the mutation row *the direction rule stops
   * swapping*. A discriminated union with `aliasNorm`/`canonicalNorm` would put
   * it in the type; it was weighed and declined because both arms carry
   * identical fields and the mapping at the propose call would gain a `switch`
   * for one boolean — but if a second construction site is ever added, that
   * trade flips.
   *
   * ⚠️ It is also a claim about the GROUP, not about a row:
   * {@link ALIAS_PROPOSAL_SQL} folds with `bool_or`, so one warehouse-derived
   * row among fifty makes its side warehouse. That is deliberate (a predicate
   * the warehouse also emits is a good canonical target however rarely it does)
   * and the corpus's `mixed-provenance` case is what pins the reading.
   */
  readonly directed: boolean;
}

/**
 * An extractor's guess that two predicate spellings name one relation.
 *
 * ⚠️ **It is a RANK on structural evidence already found, and NEVER a
 * candidate.** {@link hintedRank} is the only function that ever sees a hint and
 * it returns a `number`, so nothing that reads a hint has a list-shaped result
 * to append to; the caller is the `candidates.map(…)` CALL in
 * {@link applyHintRanks}'s body, which is what preserves the length.
 *
 * ⚠️ Not its SIGNATURE — an earlier version said that and it is false three
 * lines above its own retraction. `map<U>(cb) => U[]` relates the result to
 * nothing, and `[...candidates, ...minted].map(…)` has the identical signature;
 * that is the mutation row's own spelling.
 *
 * ⚠️ **Be precise about how strong that is, because an earlier version of this
 * docstring was not.** It said *"it cannot append, and the type says so"* — and
 * the type did not: a reviewer compiled the counter-example. `candidates` is a
 * reassignable parameter, and when this interface had `fromNorm`/`toNorm` a hint
 * was a structural SUBSET of {@link AliasCandidate}, so
 * `{ ...hint, subjects: 2, directed: false }` type-checked as one. TypeScript
 * cannot express *"the same members"*, and branding the destination is not
 * available either — `AliasProposalInput` must stay open for human-authored
 * proposals. So the honest statement is: **the prohibition is enforced by
 * `hintedRank`'s scalar return and by `candidates.map`, and it is FALSIFIED by
 * the `an extractor hint may become a candidate` row in
 * `scripts/mutations/alias-proposal.md`.** That mutation row is what holds this
 * line; do not delete it as redundant with a type guarantee that is not there.
 *
 * `norms` as a TUPLE rather than two `fromNorm`/`toNorm` fields is the part the
 * type does buy, and it is cheap: a hint is no longer structurally an
 * `AliasCandidate`, so the spread above stops compiling and
 * `applyHintRanks(candidates, candidates)` — which used to compile and would
 * have given every candidate the bonus — stops too. Minting a candidate from a
 * hint now takes explicitly naming `fromNorm:` and `toNorm:`, which is a
 * deliberate act rather than a spread.
 *
 * The reason a hint may not be a candidate is T3 §1's reason for rejecting
 * canonical-at-extraction, arriving one layer down: **an extractor asked for a
 * canonical predicate always produces one — it cannot abstain.** Hint-only
 * proposals would fill the queue with confident, unfalsifiable noise, and T3 §5
 * already argued that a signal present on nearly everything is a filter that has
 * been fooled. As a rank on a pair the corpus already agreed about, it is
 * genuinely useful: it is the only input that can tell two equally-repeated
 * pairs apart.
 *
 * Norms, not surfaces — matched against the values {@link ALIAS_PROPOSAL_SQL}
 * returned, which are stored `predicate_key`s. UNORDERED: a hint matches a
 * candidate either way round, because the pair identity
 * `brain_vocabulary_proposal` enforces is unordered too and an extractor's guess
 * about direction is worth even less than its guess about equivalence.
 */
export interface AliasRankHint {
  readonly norms: readonly [string, string];
}

declare const SubjectCountBrand: unique symbol;

/**
 * A repeat count that has been checked: an integer, at least
 * {@link ALIAS_PROPOSAL_REPEAT_THRESHOLD}.
 *
 * Branded so {@link structuralConfidence}'s codomain claim is provable from its
 * signature rather than asserted in prose. {@link toCandidate} is the ONLY mint
 * site, immediately after the guard that checks both properties — and unlike the
 * hint prohibition one type up, there is no competing unbranded producer that
 * could satisfy the destination, so the brand actually holds here. (That
 * distinction is #5032's lesson: brand the OUTPUT, and check that no sibling
 * producer reopens the defect.)
 */
export type SubjectCount = number & { readonly [SubjectCountBrand]: true };

/**
 * The rank a candidate's own structural evidence earns — a monotone map from the
 * repeat count into `(0, 1)`.
 *
 * ⚠️ **A RANK, not a probability.** Nothing calibrated it and nothing should
 * read `0.75` as three-in-four. Its whole job is to order a queue, and the only
 * property that matters is that more independent subjects sort higher.
 *
 * It reaches no gate. `autoApproveEligible` refuses every non-entity position
 * before it looks at confidence, and this producer proposes at the PREDICATE
 * position only — so a seam candidate always queues for a human however high
 * this climbs. That is what makes it safe for {@link ALIAS_HINT_RANK_BONUS} to
 * move it at all.
 */
export function structuralConfidence(subjects: SubjectCount): number {
  // Saturating rather than linear: the interesting distinction is between two
  // subjects and five, not between fifty and fifty-one.
  //
  // The codomain claim — inside 0190's `confidence >= 0 AND confidence <= 1` —
  // is a property of the DOMAIN, which is why the parameter is a
  // {@link SubjectCount} rather than a `number`. Written against a bare `number`
  // this function answers `2` for `-2` and `-Infinity` for `-1`, and both of
  // those reach `proposeAliasEdge` as `confidence-out-of-range`: the pair
  // silently never queues while the producer reports success. The earlier
  // spelling carried the precondition as a COMMENT ("`subjects` is a positive
  // integer past the HAVING clause"), which is an assumption about SQL held in
  // the one place whose whole job is to distrust what SQL returned.
  return 1 - 1 / (subjects + 1);
}

/**
 * The separator that makes an unordered pair key unambiguous.
 *
 * A NUL, and it is the one byte that can do this job: Postgres `text` cannot
 * hold one, so no `predicate_key` contains one and `{"a b", "c"}` can never key
 * the same as `{"a", "b c"}`. A space would NOT do — `lexicalNorm` unifies every
 * separator to a single space, so spaces are exactly what norms are full of
 * (`is priced at`).
 *
 * Built with `String.fromCharCode` rather than written into a literal so the
 * source file holds no control character: a NUL in a `.ts` file is invisible in
 * a diff and breaks `grep` over the whole file.
 */
const PAIR_KEY_SEPARATOR = String.fromCharCode(0);

/** The unordered pair key two norms share, whichever way round they arrive. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}${PAIR_KEY_SEPARATOR}${b}` : `${b}${PAIR_KEY_SEPARATOR}${a}`;
}

/**
 * A candidate paired with its queue rank.
 *
 * A WRAPPER, not `AliasCandidate & { confidence }`. The intersection was the
 * first spelling and it admitted a real defect: the ranked value was still an
 * `AliasCandidate`, so `applyHintRanks(applyHintRanks(cs, hs), hs)` type-checked
 * and applied the bonus twice — 0.10, which is more than one step of the
 * structural curve at the low end and therefore exactly what
 * {@link ALIAS_HINT_RANK_BONUS}'s docstring promises can never happen. The
 * wrapper makes the result not-a-candidate, so re-entry stops compiling.
 *
 * `confidence` is in `[0, 1]` — migration 0190's CHECK — and this is the one
 * place that promise lives.
 */
export interface RankedAliasCandidate {
  readonly candidate: AliasCandidate;
  readonly confidence: number;
}

/**
 * The two type facts rounds 1–2 established, pinned so a refactor cannot quietly
 * undo them.
 *
 * ⚠️ Unlike the executor pin above, these have NO live call site behind them —
 * nothing in the tree writes `applyHintRanks(applyHintRanks(…))` or
 * `applyHintRanks(candidates, candidates)`, so a type-shape widening breaks no
 * test and fires no mutation row (mutation rows are source edits measured
 * against tests; a widened interface simply admits more). They are exactly the
 * facts that need a compile-time guard, and the executor pin — which a call
 * site already checks — is the one that did not.
 *
 *   - Adding `fromNorm`/`toNorm` to {@link RankedAliasCandidate} "for
 *     convenience" reopens the double-bonus defect its docstring records.
 *   - Restoring `fromNorm`/`toNorm` on {@link AliasRankHint} — the shape it USED
 *     to have — makes `applyHintRanks(candidates, candidates)` legal again and
 *     gives every candidate the bonus.
 *
 * ⚠️ **Spelled as `keyof` and as the REVERSE assignability, and the first cut of
 * both was a no-op.** `RankedAliasCandidate extends AliasCandidate` never
 * becomes true by adding two fields, because `AliasCandidate` needs four — so
 * the pin stayed satisfied through the exact refactor it names. And
 * `applyHintRanks(candidates, candidates)` is legal iff `AliasCandidate extends
 * AliasRankHint`, which is the other direction from the one that was written.
 * Both replacements were compiled against their named refactor and both now
 * error at the pin. #5068's lesson — a type annotation derived from the type it
 * guards is a no-op — in a new spelling.
 */
type _RankedIsNotACandidate = Assert<"fromNorm" extends keyof RankedAliasCandidate ? false : true>;
type _HintIsNotACandidate = Assert<AliasCandidate extends AliasRankHint ? false : true>;

/**
 * The rank ONE candidate earns, given the hints — the only function in the
 * module that reads an {@link AliasRankHint}.
 *
 * ⚠️ It returns a **number**. That is the design, not an implementation detail:
 * nothing that reads a hint has a list-shaped result, so the "a hint became a
 * candidate" edit has nowhere inside this function to be written. It is still
 * writable at the call site — TypeScript cannot express *"the same members"* —
 * which is why the mutation row is the falsifier of record.
 */
function hintedRank(candidate: AliasCandidate, hints: readonly AliasRankHint[]): number {
  const base = structuralConfidence(candidate.subjects);
  const key = pairKey(candidate.fromNorm, candidate.toNorm);
  const isHinted = hints.some((hint) => pairKey(hint.norms[0], hint.norms[1]) === key);
  // Clamped on BOTH arms, which the first cut was not: it clamped only the
  // hinted branch, so the path with MORE arithmetic applied was the better
  // protected one. `base` is inside `[0, 1)` by {@link SubjectCount}'s
  // construction, so the clamp is now genuinely only about the bonus — but a
  // one-sided clamp beside an unchecked domain is how a guard comes to describe
  // something other than what it does.
  return Math.min(1, isHinted ? base + ALIAS_HINT_RANK_BONUS : base);
}

/**
 * Rank every candidate, raising the ones an extractor also guessed at.
 *
 * `candidates.map(…)`, so the result has the same length and the same members
 * whatever the hints say. A hint for a pair that is not in `candidates` has no
 * effect — see {@link AliasRankHint} for exactly how much of that the type
 * carries and how much the mutation table carries.
 */
export function applyHintRanks(
  candidates: readonly AliasCandidate[],
  hints: readonly AliasRankHint[],
): readonly RankedAliasCandidate[] {
  return candidates.map((candidate) => ({
    candidate,
    confidence: hintedRank(candidate, hints),
  }));
}

/**
 * Narrow one raw row from {@link ALIAS_PROPOSAL_SQL}.
 *
 * ⚠️ Every one of the five columns is checked, and the DOMAIN of `subjects` is
 * checked too — not merely its type. The first cut validated three columns
 * strictly, read the two booleans with `=== true`, and accepted any finite
 * `subjects`, which left three silent failures behind a branch whose own comment
 * said *"dropped and named, never coerced"*:
 *
 *   - a driver or projection change delivering `"t"` for a boolean made
 *     `directed` false for every candidate, forever, with no line — the whole
 *     direction rule off, fail-closed but SILENTLY so;
 *   - a negative or fractional `subjects` reached {@link structuralConfidence},
 *     which answers `2` for `-2` and `-Infinity` for `-1`; both are refused
 *     downstream as `confidence-out-of-range`, so the pair stops queuing while
 *     the producer reports success;
 *   - `raw` is typed `unknown` and this module advertises a hand-written
 *     {@link AliasProposalExecutor} as a legal shape, so a `null` row
 *     dereferenced instead of dropping.
 */
function toCandidate(raw: unknown, workspaceId: string): AliasCandidate | null {
  // The guard `toProposalRow` opens with, for the same reason: `unknown`
  // includes `null`, and dereferencing it throws where the contract says drop.
  if (typeof raw !== "object" || raw === null) {
    log.warn(
      { workspaceId, received: raw === null ? "null" : typeof raw },
      "brain alias proposal: a candidate row was not an object — dropped; the executor is not returning what ALIAS_PROPOSAL_SQL projects",
    );
    return null;
  }
  const row = raw as {
    readonly from_norm?: unknown;
    readonly to_norm?: unknown;
    readonly subjects?: unknown;
    readonly from_warehouse?: unknown;
    readonly to_warehouse?: unknown;
  };
  if (
    typeof row.from_norm !== "string" ||
    typeof row.to_norm !== "string" ||
    typeof row.subjects !== "number" ||
    !Number.isInteger(row.subjects) ||
    row.subjects < ALIAS_PROPOSAL_REPEAT_THRESHOLD ||
    typeof row.from_warehouse !== "boolean" ||
    typeof row.to_warehouse !== "boolean"
  ) {
    // Dropped and named, never coerced. A row that does not read back is a
    // statement that drifted from its reader, and every permissive fallback is
    // wrong in the expensive direction: a defaulted `subjects` manufactures a
    // repeat count nothing measured, a coerced norm proposes a re-key of a
    // predicate nobody said, and a coerced boolean retires the direction rule.
    //
    // The domain arm costs no false negatives: `COUNT(DISTINCT …)::int` past
    // `HAVING >= $2` is always an integer at least the threshold, so this can
    // only fire on drift.
    //
    // ⚠️ KEYS and TYPES, never the values. This branch fires precisely when the
    // row's shape is UNKNOWN — that is what it is for — so it is the one call
    // site that cannot know whether a value it prints is a predicate (loggable
    // here, per `reconcile.ts`) or an object (never).
    log.warn(
      {
        workspaceId,
        keys: Object.keys(row),
        types: Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v])),
      },
      "brain alias proposal: a candidate row did not read back with the columns ALIAS_PROPOSAL_SQL selects — dropped; diff ALIAS_PROPOSAL_SQL against this module's reader",
    );
    return null;
  }
  const subjects = row.subjects as SubjectCount;
  // EXACTLY ONE side, spelled as inequality over two booleans. Both-warehouse is
  // undirected: see `AliasCandidate.directed`.
  const fromWarehouse = row.from_warehouse;
  const toWarehouse = row.to_warehouse;
  const directed = fromWarehouse !== toWarehouse;
  // The warehouse norm is the TARGET, so the pair is swapped when the warehouse
  // side arrived first. `brain_vocabulary_proposal`'s pair identity is generated
  // from `LEAST`/`GREATEST` and is invariant under this, so the swap sets a
  // direction without changing which pair the row is or what the rejection
  // memory remembers.
  if (directed && fromWarehouse) {
    return { fromNorm: row.to_norm, toNorm: row.from_norm, subjects, directed };
  }
  return { fromNorm: row.from_norm, toNorm: row.to_norm, subjects, directed };
}

/**
 * Run the query and read back the candidates.
 *
 * Separated from {@link proposeAliasesFromCorpus} so the falsification suite can
 * assert what the corpus YIELDS without also asserting what the queue does with
 * it — the prohibitions are properties of this function, and routing them
 * through the propose path would let a refusal in `proposeAliasEdge` (a
 * degenerate norm, rejection memory) stand in for a candidate the query
 * correctly never found.
 */
export async function loadAliasCandidates(
  executor: AliasProposalExecutor,
  workspaceId: string,
  cap: number = ALIAS_PROPOSAL_CANDIDATE_CAP,
): Promise<readonly AliasCandidate[]> {
  if (!Number.isInteger(cap) || cap < 1) {
    // Thrown, not clamped. `cap` is exported API (`AliasProposalRun.cap`), and
    // both bad values fail in ways that read as something else: `0` yields
    // `LIMIT 0` AND a spurious "the cap bound this run" warn (`0 >= 0`), and a
    // negative one is a Postgres error attributed to the statement rather than
    // to its caller.
    throw new Error(
      `alias proposal: cap must be a positive integer; got ${cap}. A zero cap reads as "this workspace has no agreeing pairs" while also warning that it was truncated.`,
    );
  }
  const { rows } = await executor.query(ALIAS_PROPOSAL_SQL, [
    workspaceId,
    ALIAS_PROPOSAL_REPEAT_THRESHOLD,
    cap,
  ]);
  if (rows.length >= cap) {
    // WARN and not DEBUG: this is the line that stops a bounded run reading as a
    // complete one. The run is still correct — the pairs are ordered by evidence
    // descending and the whole set is re-derived whenever the trigger next fires — but "25 candidates"
    // means "at least 25" and only this line says so.
    log.warn(
      { workspaceId, cap },
      "brain alias proposal: the candidate cap bound this run — the weakest-evidence pairs were dropped. They are re-derived only by the NEXT episode in this workspace that creates a comparable object — there is no sweep — so treat the count below as a floor rather than a total",
    );
  }
  const candidates: AliasCandidate[] = [];
  for (const raw of rows) {
    const candidate = toCandidate(raw, workspaceId);
    if (candidate !== null) candidates.push(candidate);
  }
  if (rows.length > 0 && candidates.length === 0) {
    // ERROR, and it is the difference between two states that are otherwise
    // byte-identical to every caller: the corpus supports nothing, and the
    // reader has drifted from the statement. `toCandidate` warns per row, but
    // the SUMMARY a caller acts on is `candidates.length`, and
    // `proposeAliasesFromCorpus` would otherwise log "no predicate pair agrees
    // …" — which is false, and sits a level ABOVE the per-row warns that
    // contradict it.
    log.error(
      { workspaceId, rows: rows.length },
      "brain alias proposal: the query returned rows and NONE of them read back — this run proposed nothing because the reader has drifted from ALIAS_PROPOSAL_SQL, not because the corpus supports nothing; diff the statement's SELECT list against `toCandidate`",
    );
  }
  return candidates;
}

/**
 * How long any one statement this producer causes may run ONCE THIS SETTING HAS
 * LANDED — see {@link boundedTransaction} on the two round trips ahead of it
 * that it cannot cover.
 *
 * Sized against the work rather than against a feeling: the self-join is over
 * one workspace's live facts filtered to non-null `object_cmp`, which is a small
 * fraction of any real corpus, and every proposal statement after it is a
 * single-row read or insert. Ten seconds is far past a healthy run and far short
 * of a hung fiber.
 */
export const ALIAS_PROPOSAL_STATEMENT_TIMEOUT_SQL = `SET LOCAL statement_timeout = '10s'`;

/**
 * How long a proposal may wait for the workspace vocabulary lock.
 *
 * `identity.ts`'s `IDENTITY_MUTATION_LOCK_TIMEOUT_SQL`, at the other end of the
 * same contention: a human approving an alias holds that lock, and this producer
 * must yield to them rather than queue behind them indefinitely.
 *
 * ⚠️ **Its cost is a whole BATCH, not one candidate, and it is not cheap.**
 * `proposeAliasEdges` is a sequential loop with no per-candidate catch, so the
 * first `55P03` propagates out and candidates *n+1…cap* are never attempted. And
 * they are not simply "next run's": this producer has one caller, gated on an
 * episode creating a comparable object, so the rest of the batch waits for
 * however long that takes (see {@link proposeAliasesFromCorpus}). Accepted
 * anyway, because the alternative is queueing behind a human at the review gate
 * — and the counters `proposeAliasEdges` logs before re-throwing are what makes
 * the truncation visible rather than silent.
 */
export const ALIAS_PROPOSAL_LOCK_TIMEOUT_SQL = `SET LOCAL lock_timeout = '5s'`;

/**
 * Wrap a transaction runner so every statement inside it is bounded.
 *
 * ⚠️ **This is ONE OF TWO bounds and it is not the anti-wedge one.** Read
 * `extract.ts`'s `proposeAliasesAfterCommit` before changing either; an earlier
 * version of this docstring claimed a JS-side deadline was not an equivalent
 * substitute, and that claim was wrong in the direction that matters.
 *
 * The division of labour:
 *
 *   - **This bound RECLAIMS THE CONNECTION.** `Promise.race` does not CANCEL
 *     anything — `correction.ts`'s `proposeUnderDeadline` records the property —
 *     so a JS deadline alone abandons a statement that goes on holding one of
 *     five pooled connections. `statement_timeout` cancels it; `lock_timeout`
 *     does the same for a wait on the workspace vocabulary lock.
 *   - **`ALIAS_PROPOSAL_DEADLINE_MS` LETS THE DRAIN ADVANCE**, and only it can:
 *     `withBrainTransaction` issues `BEGIN` *before* the callback runs, so
 *     `BEGIN` and the first `SET LOCAL` are two unbounded round trips and these
 *     settings **cannot bound their own arrival**. Against the failure they are
 *     both written for — an internal database that is reachable and not
 *     answering — the pair never lands at all.
 *
 * So neither is sufficient. The connection checkout ahead of both is bounded by
 * the pool's `connectionTimeoutMillis`; the two round trips after it are not,
 * which is why the deadline exists and why `extract.ts` trips a per-tick
 * breaker when it fires (a stall that precedes the first `SET LOCAL` leaks the
 * connection it was holding, and the drain advancing is what would otherwise
 * leak one per episode).
 *
 * `proposeUnderDeadline` itself is not reused: it is private to `correction.ts`
 * and `cardinality.mutations.ts` anchors a mutation on its call site, so lifting
 * it would break a generated table's anchor. `extract.ts` carries its own clone,
 * written against the two bugs that helper's docstring records.
 *
 * `LOCAL`, so both settings revert at COMMIT or ROLLBACK and no pooled
 * connection carries them to the next borrower.
 */
function boundedTransaction(runner: ReconcileTransactionRunner): ReconcileTransactionRunner {
  return async <T>(fn: (tx: ReconcileExecutor) => Promise<T>): Promise<T> =>
    runner(async (tx) => {
      await tx.query(ALIAS_PROPOSAL_STATEMENT_TIMEOUT_SQL);
      await tx.query(ALIAS_PROPOSAL_LOCK_TIMEOUT_SQL);
      return fn(tx);
    });
}

/** What one run may be told, beyond the workspace it runs over. */
export interface AliasProposalRun {
  /**
   * Extractor guesses, used ONLY to rank candidates the corpus already produced.
   * See {@link AliasRankHint} — a hint is never a candidate.
   */
  readonly hints?: readonly AliasRankHint[];
  /** Bound on one run's proposals. Defaults to {@link ALIAS_PROPOSAL_CANDIDATE_CAP}. */
  readonly cap?: number;
}

/**
 * Propose every alias the corpus structurally supports, once.
 *
 * **THROWS.** The decision that a failed proposal run is survivable belongs to
 * the caller that knows what already committed, not to a producer primitive —
 * `reconcile.ts` catches, logs, and returns its report unchanged. Swallowing
 * here would also make the falsification suite unable to tell a refused proposal
 * from a broken one. `cardinality.ts`'s `proposeFromCorrectionEvents` carries the
 * same contract for the same reason.
 *
 * ⚠️ A run that fails or is refused is NOT automatically retried: see
 * `extract.ts`'s `proposeAliasesAfterCommit` for what "re-derived next run"
 * actually costs, since this producer has exactly one caller and no sweep.
 *
 * Returns the producer counters verbatim, including `rejected` — THE number that
 * matters on a re-run, because a producer whose second pass reports zero there is
 * one whose human removals did not stick (#4507).
 */
export async function proposeAliasesFromCorpus(
  workspaceId: string,
  run: AliasProposalRun = {},
  deps: AliasDecideDeps = {},
): Promise<AliasProducerCounters> {
  const bounded = boundedTransaction(deps.withTransaction ?? withBrainTransaction);
  // The READ runs in its own transaction and commits before any proposal is
  // written, rather than wrapping the whole run: `proposeAliasEdge` takes the
  // workspace vocabulary lock per proposal, and holding a reader open across
  // that would serialize this producer against every approval for the length of
  // a batch. The candidate set is advisory and re-derived every run, so a pair
  // that appears between the read and the write is next run's — which, per
  // this function's ⚠️, means the next comparable-creating episode in this
  // workspace and may be a long wait.
  const candidates = await bounded((tx) => loadAliasCandidates(tx, workspaceId, run.cap));
  // The bounded runner is threaded into the PROPOSE half too, not just the read.
  // Every statement this producer causes — including `proposeAliasEdge`'s
  // vocabulary lock — is then covered by the deadlines above.
  const boundedDeps: AliasDecideDeps = { ...deps, withTransaction: bounded };

  if (candidates.length === 0) {
    // DEBUG, because it is the steady state and will be for as long as
    // `object_cmp` is unpopulated — an INFO here would be a line per episode
    // saying nothing happened.
    log.debug(
      { workspaceId },
      "brain alias proposal: no predicate pair agrees about an object across enough distinct subjects — nothing proposed",
    );
    return { queued: 0, autoApproved: 0, deduped: 0, alreadyApproved: 0, rejected: 0, refused: 0 };
  }

  const ranked = applyHintRanks(candidates, run.hints ?? []);
  const inputs: AliasProposalInput[] = ranked.map(({ candidate, confidence }) => ({
    position: "predicate",
    fromNorm: candidate.fromNorm,
    // The DIRECTION rule's whole content, spelled at the one place it crosses
    // into the queue: `toNorm` is the target, and for a directed candidate
    // `toCandidate` has already put the warehouse norm there.
    toNorm: candidate.toNorm,
    directed: candidate.directed,
    sourceClass: "seam",
    confidence,
    proposedBy: SEAM_PROPOSAL_PRODUCER,
  }));

  log.info(
    {
      workspaceId,
      candidates: inputs.length,
      directed: ranked.filter((r) => r.candidate.directed).length,
      threshold: ALIAS_PROPOSAL_REPEAT_THRESHOLD,
    },
    "brain alias proposal: predicate pairs agree about an object across enough distinct subjects — queueing them for review, and nothing re-keys until a human approves",
  );

  return proposeAliasEdges(workspaceId, inputs, SEAM_PROPOSAL_PRODUCER, boundedDeps);
}
