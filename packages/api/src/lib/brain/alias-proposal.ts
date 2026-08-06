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
import { episodeSourceArraySql, WAREHOUSE_SOURCES } from "@atlas/api/lib/brain/sources";
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
 * The minimal executor this module needs — `cardinality.ts`'s shape, so a
 * `reconcile.ts` `tx` satisfies it without either module importing the other's
 * concrete runner.
 */
export interface AliasProposalExecutor {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: readonly unknown[] }>;
}

/** Compile-time pin: a `reconcile.ts` `tx` must satisfy this module's executor. */
type _ReconcileExecutorIsAnAliasProposalExecutor =
  ReconcileExecutor extends AliasProposalExecutor ? true : never;

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
 * evidence and the next run re-derives the whole set from the corpus. Nothing is
 * lost permanently — this producer holds no cursor and no watermark.
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
 * The tier vocabulary as a SQL array literal, built ONCE at module load — the
 * POSITIVE list, unlike #5033's tier guard, which splices the complement.
 *
 * Safe unquoted for the reason `sources.ts` owns: `EPISODE_SOURCE_SLUG` is
 * enforced over the whole vocabulary at that module's load, so the escaping rule
 * lives beside the values and not beside this consumer.
 */
const WAREHOUSE_SOURCE_ARRAY_SQL = episodeSourceArraySql(WAREHOUSE_SOURCES);

/**
 * *Positively warehouse-derived* — the direction arm (ADR-0037 §4).
 *
 * ⚠️ **NOT the negation of #5033's `supersedableTierSql`, and it must not be
 * rewritten as one.** That predicate answers *is there evidence this row is
 * below tier-1*, and admits a row carrying NO `source` key at all as a
 * deliberate carve-out. Negating it would make every such row — every row
 * written before `reconcile.ts` spread `source` into provenance, and every row a
 * region import restored without one — read as warehouse-derived, which is the
 * one reading that lets a producer pick the canonical TARGET of a workspace-wide
 * re-key on no evidence whatsoever.
 *
 * Three populations, and only the first is TRUE here:
 *
 *   - `source` resolves to a warehouse-class member → TRUE. Its space is closed,
 *     typed and described, which is the entire argument for making it the target.
 *   - `source` is present and resolves to anything else → FALSE.
 *   - `source` is absent, or present and unresolvable (`warehouse:prod`,
 *     `snowflake`) → SQL NULL, folded to FALSE by {@link ALIAS_PROPOSAL_SQL}'s
 *     `COALESCE`. Evidence of nothing must not become evidence of a direction.
 *
 * FALSE on both sides makes the candidate UNDIRECTED, which is the fail-closed
 * outcome: approval routes the choice of target to a human instead of the
 * producer guessing it.
 *
 * `alias` is interpolated; callers pass a plain identifier they control — the
 * same contract as `supersedableTierSql` and `comparableDifferentSql`.
 */
function warehouseDerivedSql(alias: string): string {
  return `(${alias}.provenance->>'source' = ANY (${WAREHOUSE_SOURCE_ARRAY_SQL}))`;
}

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
 * ## `a.object_cmp IS NOT NULL` is REDUNDANT, and it stays
 *
 * `comparableSameSql` is `a = b`, which is NULL — and so excluded — whenever
 * either side is NULL. The arm is therefore already implied. It is written
 * anyway because it is the arm that states ADR-0037 §4's rule as the ADR spells
 * it (*non-null AND equal on both sides*), and because it is the arm that makes
 * this query's day-one behaviour legible: `object_cmp` is never backfilled, so
 * on a workspace with no entity store and no typed objects this predicate is
 * false for every row and the query returns zero candidates. Deleting it changes
 * no result and deletes that sentence. (The same reason migration 0187 carries
 * redundant parens: a redundant token whose job is to survive the next reader.)
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
           ${warehouseDerivedSql("a")} AS from_warehouse,
           ${warehouseDerivedSql("b")} AS to_warehouse
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
  /** Distinct subjects exhibiting the pair — the repeat gate's own number. */
  readonly subjects: number;
  /**
   * TRUE only when EXACTLY ONE side is warehouse-derived (ADR-0037 §4). When
   * true, {@link toNorm} is that side: the warehouse norm is the proposed
   * target, its space being closed, typed and described.
   *
   * When neither side is — or both are — the candidate is UNDIRECTED and
   * approval picks the target. Both-warehouse is undirected for the same reason
   * neither-warehouse is: the rule is *exactly one*, and with two closed spaces
   * nothing in the evidence prefers one over the other.
   */
  readonly directed: boolean;
}

/**
 * An extractor's guess that two predicate spellings name one relation.
 *
 * ⚠️ **It is a RANK on a candidate structural evidence already found, and NEVER
 * a candidate.** {@link applyHintRanks} can only raise the confidence of a pair
 * {@link loadAliasCandidates} returned; a hint naming a pair with no structural
 * evidence produces no proposal at all, and there is no code path by which it
 * could.
 *
 * The reason is T3 §1's reason for rejecting canonical-at-extraction, arriving
 * one layer down: **an extractor asked for a canonical predicate always produces
 * one — it cannot abstain.** Hint-only proposals would therefore fill the queue
 * with confident, unfalsifiable noise, and T3 §5 already argued that a signal
 * present on nearly everything is a filter that has been fooled. As a rank on a
 * pair the corpus already agreed about, it is genuinely useful: it is the only
 * input that can tell two equally-repeated pairs apart.
 *
 * Norms, not surfaces — {@link applyHintRanks} matches on the values
 * {@link ALIAS_PROPOSAL_SQL} returned, which are stored `predicate_key`s.
 * Unordered: a hint matches a candidate in either orientation, because the pair
 * identity `brain_vocabulary_proposal` enforces is unordered too and an
 * extractor's guess about direction is worth even less than its guess about
 * equivalence.
 */
export interface AliasRankHint {
  readonly fromNorm: string;
  readonly toNorm: string;
}

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
export function structuralConfidence(subjects: number): number {
  // Saturating rather than linear: the interesting distinction is between two
  // subjects and five, not between fifty and fifty-one, and the codomain has to
  // stay inside 0190's `confidence <= 1` CHECK for every count a corpus can
  // produce. `subjects` is a positive integer past the HAVING clause.
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
 * Raise the rank of candidates an extractor also guessed at — and ONLY those.
 *
 * A pure function over the candidate list, which is what makes the prohibition
 * testable: it cannot append, and the type says so. A hint for a pair that is
 * not in `candidates` has no representable effect — the result is
 * `candidates.map(…)`, so it has the same length and the same members whatever
 * the hints say.
 */
export function applyHintRanks(
  candidates: readonly AliasCandidate[],
  hints: readonly AliasRankHint[],
): readonly (AliasCandidate & { readonly confidence: number })[] {
  const hinted = new Set(hints.map((hint) => pairKey(hint.fromNorm, hint.toNorm)));
  return candidates.map((candidate) => {
    const base = structuralConfidence(candidate.subjects);
    // Clamped, so the bonus can never push a candidate outside 0190's
    // `confidence <= 1` CHECK and turn a rank into a refused INSERT.
    const confidence = hinted.has(pairKey(candidate.fromNorm, candidate.toNorm))
      ? Math.min(1, base + ALIAS_HINT_RANK_BONUS)
      : base;
    return { ...candidate, confidence };
  });
}

/** Narrow one raw row from {@link ALIAS_PROPOSAL_SQL}. */
function toCandidate(raw: unknown, workspaceId: string): AliasCandidate | null {
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
    !Number.isFinite(row.subjects)
  ) {
    // Dropped and named, never coerced. A row that does not read back is a
    // statement that drifted from its reader, and the two permissive fallbacks
    // are both wrong in the expensive direction: a defaulted `subjects` would
    // manufacture a repeat count nothing measured, and a coerced norm would
    // propose a re-key of a predicate nobody said.
    log.warn(
      { workspaceId, row },
      "brain alias proposal: a candidate row did not read back with the columns ALIAS_PROPOSAL_SQL selects — dropped; diff ALIAS_PROPOSAL_SQL against this module's reader",
    );
    return null;
  }
  // EXACTLY ONE side, spelled as inequality over two booleans. Both-warehouse is
  // undirected: see `AliasCandidate.directed`.
  const fromWarehouse = row.from_warehouse === true;
  const toWarehouse = row.to_warehouse === true;
  const directed = fromWarehouse !== toWarehouse;
  // The warehouse norm is the TARGET, so the pair is swapped when the warehouse
  // side arrived first. `brain_vocabulary_proposal`'s pair identity is generated
  // from `LEAST`/`GREATEST` and is invariant under this, so the swap sets a
  // direction without changing which pair the row is or what the rejection
  // memory remembers.
  if (directed && fromWarehouse) {
    return { fromNorm: row.to_norm, toNorm: row.from_norm, subjects: row.subjects, directed };
  }
  return { fromNorm: row.from_norm, toNorm: row.to_norm, subjects: row.subjects, directed };
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
  const { rows } = await executor.query(ALIAS_PROPOSAL_SQL, [
    workspaceId,
    ALIAS_PROPOSAL_REPEAT_THRESHOLD,
    cap,
  ]);
  if (rows.length >= cap) {
    // WARN and not DEBUG: this is the line that stops a bounded run reading as a
    // complete one. The run is still correct — the pairs are ordered by evidence
    // descending and the next run re-derives the whole set — but "25 candidates"
    // means "at least 25" and only this line says so.
    log.warn(
      { workspaceId, cap },
      "brain alias proposal: the candidate cap bound this run — the weakest-evidence pairs were dropped and will be re-derived next run, so the count below is a floor rather than a total",
    );
  }
  const candidates: AliasCandidate[] = [];
  for (const raw of rows) {
    const candidate = toCandidate(raw, workspaceId);
    if (candidate !== null) candidates.push(candidate);
  }
  return candidates;
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
 * Returns the producer counters verbatim, including `rejected` — THE number that
 * matters on a re-run, because a producer whose second pass reports zero there is
 * one whose human removals did not stick (#4507).
 */
export async function proposeAliasesFromCorpus(
  workspaceId: string,
  run: AliasProposalRun = {},
  deps: AliasDecideDeps & { readonly withTransaction?: ReconcileTransactionRunner } = {},
): Promise<AliasProducerCounters> {
  const withTransaction = deps.withTransaction ?? withBrainTransaction;
  // The READ runs in its own transaction and commits before any proposal is
  // written, rather than wrapping the whole run: `proposeAliasEdge` takes the
  // workspace vocabulary lock per proposal, and holding a reader open across
  // that would serialize this producer against every approval for the length of
  // a batch. The candidate set is advisory and re-derived every run, so a pair
  // that appears between the read and the write is simply next run's.
  const candidates = await withTransaction((tx) => loadAliasCandidates(tx, workspaceId, run.cap));

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
  const inputs: AliasProposalInput[] = ranked.map((candidate) => ({
    position: "predicate",
    fromNorm: candidate.fromNorm,
    toNorm: candidate.toNorm,
    directed: candidate.directed,
    sourceClass: "seam",
    confidence: candidate.confidence,
    proposedBy: SEAM_PROPOSAL_PRODUCER,
  }));

  log.info(
    {
      workspaceId,
      candidates: inputs.length,
      directed: ranked.filter((c) => c.directed).length,
      threshold: ALIAS_PROPOSAL_REPEAT_THRESHOLD,
    },
    "brain alias proposal: predicate pairs agree about an object across enough distinct subjects — queueing them for review, and nothing re-keys until a human approves",
  );

  return proposeAliasEdges(workspaceId, inputs, SEAM_PROPOSAL_PRODUCER, deps);
}
