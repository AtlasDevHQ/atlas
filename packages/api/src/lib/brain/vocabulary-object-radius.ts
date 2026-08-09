/**
 * The OBJECT-position blast radius — the disclosure #5025's 2026-08-08
 * checkpoint (finding 2) left open, and #5088's own AC: *an object-position
 * alias reports its KIND of blast radius, never a zero.*
 *
 * ## Why the supersession engine cannot answer this
 *
 * `supersessionCollisionPredicate` joins on `subject_key`, `predicate_key` and
 * `object_cmp`. **`object_key` appears nowhere in it.** An object-position alias
 * moves `object_key` — which is a CORROBORATION arm (`reconcile.ts`'s
 * `objectSameSql`) and a TENSION arm (`objectNotSameSql`) — so approving one
 * changes what agrees and what is flagged as contested, and changes nothing
 * about what supersedes.
 *
 * `vocabulary-preview.ts` therefore reports `structurally-empty:
 * "object-position"` rather than a count, on the argument that *"0 pairs"* and
 * *"this position cannot produce pairs"* are the same number and opposite facts.
 * That was the right refusal and only half the answer: the pane then said *"Atlas
 * cannot yet show you that"* about the change the alias DOES make, which is a
 * different confident silence in the same place. This module is the other half.
 *
 * ## Three sides — a two-sided DELTA plus a different relation
 *
 * {@link ObjectPositionRadius.corroborating} and
 * {@link ObjectPositionRadius.separating} are ONE predicate evaluated under two
 * vocabularies, exactly as `BlastRadius`'s `arming` / `disarming` are: the
 * direction swap is which side of the delta the JOIN runs on. That is what makes
 * the removal expressible, and its absence was a defect the removal fixture
 * caught — a one-sided delta answered a removal with zeros, i.e. *"this splits
 * nothing apart"* for a decision whose whole job is splitting.
 *
 * {@link ObjectPositionRadius.tension} is a genuinely DIFFERENT question over a
 * different relation: `in-tension-with` edges that ALREADY EXIST between pairs
 * the decision would stop treating as rivals. It reads `brain_edges` rather than
 * re-deriving the rival set, because *"advisories a reviewer has already been
 * shown"* is the fact worth disclosing and a re-derivation would be a weaker
 * second spelling of the corroboration delta.
 *
 * The corroboration and tension sides very nearly coincide, and the gap is the
 * informative part. A pair whose comparable values PROVE they differ
 * (`number:1` vs `number:2`) stays in tension after the merge —
 * `objectSameSql`'s veto keeps it out of corroboration — so it appears on
 * neither. An approver reading *"3 pairs would newly agree, 5 flags would go
 * stale"* can see that two of the flagged contradictions survive the merge,
 * which is the one thing a single number cannot say.
 *
 * ## ⚠️ Neither side is retroactive, and saying otherwise is the lie to avoid
 *
 * The approval's write is `rekeyDriftedFacts`: it updates `object_key` on the
 * affected live rows and stops. It does **not** merge two existing beliefs into
 * one, and it does **not** delete an `in-tension-with` edge. Corroboration and
 * tension are evaluated at INGEST, once, per episode.
 *
 * So the honest sentences are *"the next re-observation of either claim attaches
 * to one row instead of minting a second"* and *"these advisory edges are left
 * behind and become stale"*. {@link ObjectPositionRadius.staleEdgesPersist} is a
 * literal `true` for {@link BlastRadius.floor}'s reason — a surface has to render
 * that sentence, and a literal type is what makes the rendering assertable rather
 * than merely intended.
 *
 * ## Disclosure posture is `vocabulary-preview.ts`'s, unchanged
 *
 * Unscoped workspace-wide TOTAL, reader-scoped bounded SAMPLE gated on BOTH
 * sides, `withheld` as their difference, `countsConsistent` when the two
 * statements disagree. `willSupersedePairsSql`'s both-sides rule transfers
 * verbatim: *"something you cannot see agrees with X"* discloses half a claim's
 * history to a reader the grant excluded from the other half.
 */

import { createLogger } from "@atlas/api/lib/logger";
import type { BrainCandidateReader } from "@atlas/api/lib/brain/candidates";
import { aclVisibilityClause, type BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import { objectNotSameSql, objectSameSql } from "@atlas/api/lib/brain/object-cmp";
import { subjectNotDifferentSql } from "@atlas/api/lib/brain/subject-cmp";
import type {
  BrainVocabularyBlastRadius,
  BrainVocabularyObjectPair,
  BrainVocabularyObjectRadiusSide,
} from "@useatlas/types";
import type { Exact } from "@atlas/api/lib/type-utils";

const log = createLogger("brain-vocabulary-object-radius");

/**
 * Most pairs one side enumerates. {@link BLAST_RADIUS_PAIR_MAX}'s bound and
 * posture, spelled here rather than imported so the two surfaces can diverge
 * without one silently re-tuning the other — they answer different questions
 * over different relations.
 */
export const OBJECT_RADIUS_PAIR_MAX = 50;

/**
 * One pair of live claims an object merge would relate.
 *
 * ⚠️ An ALIAS of the wire type, not a hand-written twin — `BlastRadiusPair`'s
 * shape and its reason. It WAS a twin, in the same diff whose `BlastRadius` arm
 * cites collapsing that exact duplicate as its precedent: renaming `leftLabel`
 * here would have 500'd the whole preview pane for object aliases, with nothing
 * but a runtime `z.strictObject` between the two spellings.
 *
 * ⚠️ SYMMETRIC field names, deliberately not `BrainFactWillSupersedePair`'s
 * `draft`/`superseded`. Neither of these claims replaces the other, and a
 * consumer reading `supersededLabel` on a corroboration pair learns exactly the
 * thing this whole module exists to stop it concluding.
 *
 * Labels, never keys — ADR-0037 §6, `keys-not-on-the-wire.test.ts`.
 */
export type ObjectRadiusPair = BrainVocabularyObjectPair;

/**
 * One side's accounting — `BlastRadiusSide`'s contract, over a different
 * relation, and an ALIAS of the wire type for {@link ObjectRadiusPair}'s reason.
 *
 * Every field means what it means there, including the two that are easy to
 * conflate: `withheld` is what the ACL kept back, `truncated` is what the page
 * cap dropped, and folding either into the other is truncation wearing an ACL
 * boundary's face.
 */
export type ObjectRadiusSide = BrainVocabularyObjectRadiusSide;

/** What an object-position decision actually changes. */
export interface ObjectPositionRadius {
  /**
   * Live claim pairs that do NOT agree about the object today and would after.
   *
   * Empty for a REMOVAL by construction — splitting a merged norm apart cannot
   * create agreement — which is why this and {@link separating} are two fields
   * rather than one whose meaning depends on the verb.
   *
   * A FLOOR in the same sense every count on this surface is: it describes the
   * corpus as it stands, and the decision applies to every future claim in the
   * slot too.
   */
  readonly corroborating: ObjectRadiusSide;
  /**
   * Live claim pairs that DO agree today and would not after.
   *
   * ⚠️ Its own field, and its absence was a defect the removal fixture caught.
   * With one side only, `loadBlastRadius` answered a removal with three zeros —
   * *"this decision changes nothing about what agrees"* — for a decision that
   * splits an agreeing population in two. That is the confident false all-clear
   * this whole module exists to replace, produced by the module itself, on the
   * verb `REKEY_DRIFTED_FACTS_SQL` warns is NOT approval inverted.
   *
   * Empty for every approval: a merge only creates agreement.
   * `BlastRadius.disarming` is the same shape for the same reason.
   */
  readonly separating: ObjectRadiusSide;
  /**
   * `in-tension-with` edges that already exist between pairs the decision would
   * stop treating as rivals.
   *
   * ⚠️ Not a count of edges that would be REMOVED. Nothing removes them — see
   * {@link staleEdgesPersist}.
   *
   * ⚠️ There is deliberately no *newly-contested* counterpart, and the asymmetry
   * is the honest one rather than an omission: a removal makes agreeing pairs
   * contested, and NO advisory edge exists for them — they were never rivals, so
   * nothing was ever written. Counting them would mean re-deriving the rival set
   * rather than reading the edge table, at which point the number stops being
   * *"advisories a reviewer has already been shown"* and becomes a second, weaker
   * spelling of {@link separating}. The removal's cost is that population, and
   * that is where it is reported.
   */
  readonly tension: ObjectRadiusSide;
  /**
   * ALWAYS true. The re-key rewrites `object_key` and nothing else, so every
   * advisory edge in {@link tension} survives the approval and becomes a
   * contradiction Atlas is still flagging between two claims it now considers to
   * agree.
   *
   * A literal-typed field rather than a comment, on {@link BlastRadius.floor}'s
   * precedent: the surface must say this, and a literal is what lets a test
   * assert the sentence is rendered rather than assert the developer meant to.
   */
  readonly staleEdgesPersist: true;
}

/**
 * ⚠️ Compile-time lock: this record and the wire arm carry the SAME sides.
 *
 * `vocabulary-preview.ts` builds the `object-position` arm by SPREADING an
 * {@link ObjectPositionRadius}, and says why: re-listed, that arm silently lost
 * the `separating` side the moment this module grew one. But the wire arm in
 * `@useatlas/types` re-lists these four fields by hand, and an annotation on the
 * response does NOT close the loop — TypeScript's excess-property check applies
 * to a literal's own keys, not to the value spread into it. So growing a fifth
 * side here would compile everywhere, ship through the spread, and be rejected
 * at runtime by `z.strictObject` — a 500 on every object-position preview, from
 * a change that looked additive.
 *
 * The lock is BIDIRECTIONAL on purpose. A side added here without a wire arm is
 * a field no client can read; a side added to the wire without one here is a
 * field the engine never populates and `z.strictObject` then demands. Both are
 * the same class of drift and neither should be discoverable in production.
 *
 * ## ⚠️ This pin covers this record's FIELDS ONLY, and that is not the whole arm
 *
 * `kind`, `floor` and `subtreeTruncated` are the wire arm's own — the first
 * discriminates the union, the other two are the preview's disclosure posture
 * rather than anything this module measures — so they are excluded here. An
 * earlier version of this docstring stopped at that sentence and read as though
 * the arm were closed. It is not, by this pin: this record carries four fields
 * (three sides plus `staleEdgesPersist`) and the wire arm carries seven — the
 * other three live in the literal half of `vocabulary-preview.ts`'s
 * intersection, and a field added THERE compiled clean and 500'd at runtime.
 *
 * `_blastRadiusMatchesTheWire` in `vocabulary-preview.ts` is what closes the
 * whole union, arm by arm. This one is kept because it fails in the module that
 * would GROW a field — a build error next to the edit rather than two files away.
 */
type _ObjectRadiusSidesMatchTheWire = Exact<
  ObjectPositionRadius,
  Omit<
    Extract<BrainVocabularyBlastRadius, { kind: "object-position" }>,
    "kind" | "floor" | "subtreeTruncated"
  >
>;
const _objectRadiusSidesMatchTheWire: _ObjectRadiusSidesMatchTheWire = true;
void _objectRadiusSidesMatchTheWire;

// ---------------------------------------------------------------------------
// The counterfactual
// ---------------------------------------------------------------------------

/**
 * `object_key` after the decision, plus whatever the expression needs bound.
 *
 * ⚠️ Supplied by the CALLER rather than built here, and that is the seam rather
 * than an indirection. `vocabulary-preview.ts` already owns both object-key
 * substitutions — `approvalKeyExpr`'s flat CASE and `removalKeyExpr`'s
 * subtree-driven one — along with the recursive CTE the second needs, its depth
 * bound and its truncation probe. Rebuilding either here would be the second
 * spelling of the removal counterfactual, and `REKEY_DRIFTED_FACTS_SQL`'s header
 * is explicit that removal is *not* approval inverted: the two expressions
 * disagree on which rows move, and the disagreement is invisible in the result.
 *
 * So this module owns *what an object merge changes* and knows nothing about
 * which decision produced the merge.
 */
export interface ObjectCounterfactualPlan {
  /** `object_key` as the decision would leave it, for one `brain_facts` alias. */
  readonly keyExpr: (alias: string) => string;
  /**
   * Everything after `$1` (the workspace id), in order.
   *
   * `readonly string[]`, not `unknown[]` — `CounterfactualPlan.params`' reason
   * verbatim: a NULL bound here moves the whole population onto a NULL key, both
   * sides return 0, and the surface reports that the alias changes nothing.
   */
  readonly params: readonly string[];
  /** CTEs the expression references, spliced under one `WITH RECURSIVE`. */
  readonly ctes: readonly string[];
  /**
   * The caller's depth probe did not answer, so nothing about the walk is
   * established.
   *
   * ⚠️ Its own field because `SubtreeProbe` carries TWO facts and they have
   * different destinations: `truncated` is a radius-wide SCOPE statement, and
   * this one is STATEMENT DRIFT and belongs in `countsConsistent`. The object
   * arm read only the first and dropped this on the floor — so an unreadable
   * probe produced `subtreeTruncated: false` (correct) beside
   * `countsConsistent: true` (never established): a fully trustworthy-looking
   * radius over a walk nobody could confirm, on the one verb where the walk
   * decides which rows move. The predicate path has honoured it since #5086.
   *
   * ⚠️ REQUIRED, not optional. Optional, the consumer reads
   * `probeDrifted !== true` — so an omitted field silently means *"the walk was
   * confirmed"*, which re-admits exactly the forgetting this field was added to
   * stop. The walk-less approval path passes `false` deliberately, and the
   * compiler is what makes that a keystroke rather than an assumption.
   */
  readonly probeDrifted: boolean;
}

/**
 * *These two live claims corroborate* — `CORROBORATION_LOOKUP_SQL`'s two object
 * arms, asked pairwise.
 *
 * The homonym suppression travels WITH the sameness test rather than beside it,
 * because the delta below evaluates this expression twice and a suppression left
 * outside would be applied to the join and not to the exclusion — which reads as
 * *"this pair newly corroborates"* for a pair the store has proven is about two
 * different entities.
 */
function corroboratesSql(keyA: string, keyB: string): string {
  return (
    `(${objectSameSql(keyA, keyB, "a.object_cmp", "b.object_cmp")}` +
    ` AND ${subjectNotDifferentSql("a.subject_cmp", "b.subject_cmp")})`
  );
}

/** *These two live claims are rivals* — `TENSION_CANDIDATES_SQL`'s two arms, pairwise. */
function rivalsSql(keyA: string, keyB: string): string {
  return (
    `(${objectNotSameSql(keyA, keyB, "a.object_cmp", "b.object_cmp")}` +
    ` AND ${subjectNotDifferentSql("a.subject_cmp", "b.subject_cmp")})`
  );
}

/** The live set both sides scope to — `liveFactSql`'s two arms, on both aliases. */
const BOTH_LIVE =
  "a.invalidated_at IS NULL AND a.valid_to IS NULL " +
  "AND b.invalidated_at IS NULL AND b.valid_to IS NULL";

/**
 * The pair projection. `COUNT(*) OVER ()` is the reader-scoped total, which is
 * what makes `withheld` sayable — `loadBlastRadiusSide`'s shape.
 */
const PAIR_SELECT = `a.id::text AS left_id,
         a.subject || ' ' || a.predicate || ' ' || a.object AS left_label,
         b.id::text AS right_id,
         b.subject || ' ' || b.predicate || ' ' || b.object AS right_label,
         COUNT(*) OVER ()::int AS scoped_total`;

/**
 * The CORROBORATION delta: pairs that do not agree today and would after.
 *
 * `b.id > a.id` emits each unordered pair once, in a stable orientation —
 * `ALIAS_PROPOSAL_SQL`'s `b.predicate_key > a.predicate_key` trick, and it does
 * the same two jobs: it excludes the self-pair and it stops the same pair being
 * counted twice under two spellings.
 *
 * ⚠️ `IS NOT TRUE` on the exclusion, not `NOT (…)`. Here the spelling IS
 * load-bearing, unlike `deltaSql`'s defensive one: the stored expression's
 * `comparableDifferentSql` veto is NULL whenever either `object_cmp` is NULL —
 * which is the common case, since `object_cmp` is never backfilled — and the
 * stored key arm is NULL for an unkeyed row. Those rows reach the exclusion
 * through the join (the hypothetical arm is TRUE on the key alone), so `NOT (…)`
 * would evaluate to NULL and drop exactly the population an object alias is most
 * often authored for.
 */
function corroborationDeltaSql(
  opts: SideSqlOptions,
  direction: "arming" | "disarming",
): string {
  const { keyExpr } = opts.plan;
  const hypothetical = corroboratesSql(keyExpr("a"), keyExpr("b"));
  const stored = corroboratesSql("a.object_key", "b.object_key");
  // `deltaSql`'s swap, and it is what makes ONE code path answer both verbs:
  // `arming` joins on the hypothetical and excludes the stored, `disarming` the
  // reverse. Two separate functions would be two spellings of one question,
  // which is the shape this subsystem keeps paying for.
  const [join, exclude] =
    direction === "arming" ? [hypothetical, stored] : [stored, hypothetical];
  return `${cteBlock(opts.plan)}SELECT ${opts.select}
    FROM brain_facts a
    JOIN brain_facts b
      ON b.workspace_id = a.workspace_id
     AND b.subject_key = a.subject_key
     AND b.predicate_key = a.predicate_key
     AND b.id > a.id
     AND ${join}
   WHERE a.workspace_id = $1
     AND ${BOTH_LIVE}
     AND (${exclude}) IS NOT TRUE${opts.extraWhere}${opts.tail}`;
}

/**
 * The TENSION delta: advisory edges between pairs that are rivals today and
 * would not be after.
 *
 * Reads `brain_edges` rather than re-deriving the rival set, and the difference
 * is the whole point of the side. A re-derivation would answer *"how many pairs
 * would stop qualifying as rivals"*, which is nearly the corroboration count
 * again; the edge table answers *"how many advisory edges a reviewer has already
 * been shown are about to become wrong"*, and those are the ones left behind.
 *
 * ⚠️ No `id` ordering arm here, and none is needed: `brain_edges` already holds
 * one row per direction and the join is onto its two endpoints, so the edge is
 * the identity. Adding `b.id > a.id` would silently drop every edge whose writer
 * happened to record the pair the other way round.
 */
function tensionDeltaSql(opts: SideSqlOptions): string {
  const { keyExpr } = opts.plan;
  return `${cteBlock(opts.plan)}SELECT ${opts.select}
    FROM brain_edges e
    JOIN brain_facts a ON a.id = e.from_fact_id AND a.workspace_id = e.workspace_id
    JOIN brain_facts b ON b.id = e.to_fact_id AND b.workspace_id = e.workspace_id
   WHERE e.workspace_id = $1
     AND e.edge_type = 'in-tension-with'
     AND ${BOTH_LIVE}
     AND ${rivalsSql("a.object_key", "b.object_key")}
     AND (${rivalsSql(keyExpr("a"), keyExpr("b"))}) IS NOT TRUE${opts.extraWhere}${opts.tail}`;
}

/** `WITH RECURSIVE …`, or nothing. `deltaSql`'s spelling. */
function cteBlock(plan: ObjectCounterfactualPlan): string {
  return plan.ctes.length > 0 ? `WITH RECURSIVE ${plan.ctes.join(",\n     ")}\n` : "";
}

interface SideSqlOptions {
  readonly plan: ObjectCounterfactualPlan;
  readonly select: string;
  readonly extraWhere: string;
  readonly tail: string;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Which side a statement computes. */
type ObjectRadiusDirection = "corroborating" | "separating" | "tension";

const BUILDERS: {
  readonly [D in ObjectRadiusDirection]: (opts: SideSqlOptions) => string;
} = {
  corroborating: (opts) => corroborationDeltaSql(opts, "arming"),
  separating: (opts) => corroborationDeltaSql(opts, "disarming"),
  tension: tensionDeltaSql,
};

/**
 * What an object-position decision would change.
 *
 * The plan is the caller's — see {@link ObjectCounterfactualPlan}. Approval and
 * removal differ only in the substitution, so both arrive here as one shape and
 * this module never learns which verb it is describing.
 */
export async function loadObjectPositionRadius(
  db: BrainCandidateReader,
  ctx: BrainPrincipalContext,
  plan: ObjectCounterfactualPlan,
  opts: { readonly requestId?: string } = {},
): Promise<ObjectPositionRadius> {
  const [corroborating, separating, tension] = await Promise.all([
    loadSide(db, ctx, "corroborating", plan, opts),
    loadSide(db, ctx, "separating", plan, opts),
    loadSide(db, ctx, "tension", plan, opts),
  ]);

  return { corroborating, separating, tension, staleEdgesPersist: true };
}

async function loadSide(
  db: BrainCandidateReader,
  ctx: BrainPrincipalContext,
  direction: ObjectRadiusDirection,
  plan: ObjectCounterfactualPlan,
  opts: { readonly requestId?: string },
): Promise<ObjectRadiusSide> {
  const workspaceId = ctx.workspaceId;
  const build = BUILDERS[direction];

  // `$1` is the workspace; the plan's own params follow; the reader's clauses
  // come after those.
  const aclBase = 2 + plan.params.length;
  assertPlanPlaceholdersBelow(plan, aclBase, workspaceId, direction, opts.requestId);
  const leftAcl = aclVisibilityClause(ctx, {
    table: "brain_facts",
    alias: "a",
    paramIndex: aclBase,
    requestId: opts.requestId,
  });
  const rightAcl = aclVisibilityClause(ctx, {
    table: "brain_facts",
    alias: "b",
    paramIndex: leftAcl.nextParamIndex,
    requestId: opts.requestId,
  });
  if (leftAcl.decision === "deny-all" || rightAcl.decision === "deny-all") {
    // ⚠️ NOT a throw, and the asymmetry with `loadBlastRadiusSide` is deliberate.
    // That function's caller hoists the same check into `assertReaderResolvable`
    // and refuses the whole request, and this module's caller does too — so
    // reaching here means the resolvable check passed and one clause still
    // denied, which is a shape change rather than an unresolvable reader.
    // The workspace-wide total is content-free and stays sayable, so the honest
    // answer is a scoped list of nothing beside a total that is not zero, with
    // `withheld` carrying the difference. Reported inconsistent because the two
    // statements were not asked the same question.
    log.warn(
      { workspaceId, requestId: opts.requestId, direction },
      "brain vocabulary object radius: the reader's visibility clause denied every row while the reader itself resolved — listing nothing and reporting the counts inconsistent rather than a zero",
    );
  }

  const limitParam = rightAcl.nextParamIndex;
  const totalSql = build({ plan, select: "COUNT(*)::int AS delta_total", extraWhere: "", tail: "" });
  const pairsSql = build({
    plan,
    // ⚠️ `` `${PAIR_SELECT}` `` rather than the bare identifier, and it is a
    // GUARD rather than noise. `keys-not-on-the-wire.test.ts` inlines
    // module-level column-list constants only where they appear as a `${NAME}`
    // template interpolation; passed as a plain property the projection was
    // invisible to it, and adding `a.object_key,` to the front of `PAIR_SELECT`
    // left the guard green — measured. The interpolation is what puts this
    // module's one projection back inside the scan.
    select: `${PAIR_SELECT}`,
    extraWhere: `\n     AND ${leftAcl.sql}\n     AND ${rightAcl.sql}`,
    tail: `\n   ORDER BY a.ingested_at, a.id, b.ingested_at, b.id\n   LIMIT $${limitParam}`,
  });

  const [totalResult, pairsResult] = await Promise.all([
    db.query(totalSql, [workspaceId, ...plan.params]),
    db.query(pairsSql, [
      workspaceId,
      ...plan.params,
      ...leftAcl.params,
      ...rightAcl.params,
      OBJECT_RADIUS_PAIR_MAX + 1,
    ]),
  ]);

  // Guarded like every other row narrowing in this module, rather than cast and
  // trusted to `?.`. The optional chain does make the old spelling runtime-safe,
  // but it was the one `as Record<string, unknown>` here with no `typeof ===
  // "object"` in front of it, and "safe because of a `?.` two tokens away" is a
  // property a later edit removes without noticing.
  const totalRow = totalResult.rows[0];
  const total = readNonNegativeInt(
    typeof totalRow === "object" && totalRow !== null
      ? (totalRow as Record<string, unknown>).delta_total
      : undefined,
  );
  if (total === null) {
    // A THROW, not a degraded 0 — `loadBlastRadiusSide`'s reason exactly. Zero
    // here renders as *"this alias changes nothing about what agrees"*, which is
    // the confident false all-clear the whole object-position disclosure was
    // added to replace. `COUNT(*)` cannot return NULL, so this is unreachable
    // from Postgres.
    log.error(
      { workspaceId, requestId: opts.requestId, direction },
      "brain vocabulary object radius: the delta total did not read back as a number — refusing rather than disclosing a change Atlas cannot establish",
    );
    throw new Error(
      `brain vocabulary object radius: the ${direction} total did not read back as a number for ` +
        `workspace ${workspaceId} (request ${opts.requestId ?? "unknown"}) — refusing to disclose ` +
        `an object-position blast radius Atlas cannot establish`,
    );
  }

  const page = readPairs(pairsResult.rows, workspaceId, direction, opts.requestId);
  const inverted = page.scopedTotal > total;
  if (inverted) {
    log.warn(
      { workspaceId, requestId: opts.requestId, direction, scopedTotal: page.scopedTotal, total },
      "brain vocabulary object radius: the reader-scoped delta exceeds the workspace delta — a brief ingest race, or the two statements disagree; reporting 0 withheld and clearing countsConsistent",
    );
  }

  return {
    total,
    pairs: page.pairs,
    withheld: Math.max(0, total - page.scopedTotal),
    truncated: page.truncated,
    countsConsistent:
      !inverted &&
      !page.drifted &&
      !plan.probeDrifted &&
      leftAcl.decision !== "deny-all" &&
      rightAcl.decision !== "deny-all",
  };
}

/**
 * Refuse a plan whose expressions reach into the reader's placeholder range.
 *
 * `assertPlaceholdersBelowAclBase`'s guard, applied to this module's own plan
 * shape and for the identical reason: the plan carries HAND-WRITTEN `$n`
 * literals while `aclBase` is derived from `params.length`, so a drift between
 * the two makes the reader's visibility predicate bind against an object key —
 * joining nothing, and reporting that the merge changes nothing about what
 * agrees. Loud, at the seam, rather than a zero.
 *
 * The CTEs are scanned alongside the key expression: `removalKeyExpr`'s subtree
 * walk binds the workspace, the seed key and the position, and a plan that grew
 * the walk without growing `params` would trip here rather than in production.
 */
function assertPlanPlaceholdersBelow(
  plan: ObjectCounterfactualPlan,
  aclBase: number,
  workspaceId: string,
  direction: ObjectRadiusDirection,
  requestId?: string,
): void {
  const source = [plan.keyExpr("__x"), ...plan.ctes].join(" ");
  const refs = [...source.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  const highest = refs.length === 0 ? 0 : Math.max(...refs);
  if (highest >= aclBase) {
    log.error(
      { workspaceId, requestId, direction, highest, aclBase },
      "brain vocabulary object radius: a counterfactual expression references a placeholder inside the reader's range — the ACL clause and the object substitution would bind the same parameter",
    );
    throw new Error(
      `brain vocabulary object radius: the ${direction} counterfactual references $${highest}, at ` +
        `or above the ACL base $${aclBase} (workspace ${workspaceId}, request ` +
        `${requestId ?? "unknown"}). The plan's placeholder literals and its \`params\` array have ` +
        `drifted, so the reader's visibility predicate would bind against an object key — joining ` +
        `nothing and reporting that this decision changes nothing. Refusing.`,
    );
  }
}

/**
 * `readNonNegativeInt`'s spelling, one module over and for its reason: `""` is
 * refused explicitly, because `Number("")` is a finite 0 — the shape that reads
 * as *"no rows"* when it means *"the column drifted"*.
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

/** `readPairs`'s floors, carried verbatim onto the symmetric pair shape. */
function readPairs(
  rawRows: readonly unknown[],
  workspaceId: string,
  direction: ObjectRadiusDirection,
  requestId?: string,
): { pairs: ObjectRadiusPair[]; scopedTotal: number; truncated: boolean; drifted: boolean } {
  const clipped = rawRows.length > OBJECT_RADIUS_PAIR_MAX;
  const pairs: ObjectRadiusPair[] = [];
  let scopedTotal = 0;
  let droppedRows = 0;
  let windowDriftRows = 0;

  for (const raw of clipped ? rawRows.slice(0, OBJECT_RADIUS_PAIR_MAX) : rawRows) {
    if (typeof raw !== "object" || raw === null) {
      droppedRows++;
      continue;
    }
    const r = raw as Record<string, unknown>;
    if (
      typeof r.left_id !== "string" ||
      typeof r.left_label !== "string" ||
      typeof r.right_id !== "string" ||
      typeof r.right_label !== "string"
    ) {
      droppedRows++;
      continue;
    }
    const windowed = readNonNegativeInt(r.scoped_total);
    if (windowed !== null && windowed > scopedTotal) scopedTotal = windowed;
    else if (windowed === null) windowDriftRows++;
    pairs.push({
      leftId: r.left_id,
      leftLabel: r.left_label,
      rightId: r.right_id,
      rightLabel: r.right_label,
    });
  }

  if (droppedRows > 0) {
    log.warn(
      { workspaceId, requestId, direction, droppedRows, kept: pairs.length },
      "brain vocabulary object radius: pair rows came back with an unreadable column — the sample understates the change; the query shape changed",
    );
  }
  if (windowDriftRows > 0) {
    log.warn(
      { workspaceId, requestId, direction, windowDriftRows },
      "brain vocabulary object radius: the scoped window did not read back as a number on some rows — truncation may be under-reported; the query shape changed",
    );
  }

  if (clipped && scopedTotal < rawRows.length) scopedTotal = rawRows.length;
  if (scopedTotal < pairs.length) scopedTotal = pairs.length;

  return {
    pairs,
    scopedTotal,
    truncated: clipped || scopedTotal > pairs.length,
    // ⚠️ What stops a DROPPED row being reported as an ACL-WITHHELD one. Both
    // cases log, but the number the approver reads is wrong, and only this flag
    // says so on the wire.
    drifted: droppedRows > 0 || windowDriftRows > 0,
  };
}
