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
 * once against the stored columns, once against the hypothetical ones — so a
 * caller cannot reach a rule with the tier guard, the cardinality gate or the
 * homonym suppression absent. `collision-sql-pinned.test.ts` holds the shipped
 * statements byte-for-byte and proves the default parameterization is the
 * stored one.
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
 * That is reported as {@link BlastRadius.structurallyEmpty} rather than as a
 * zero, because *"0 pairs"* and *"this position cannot produce pairs"* are the
 * same number and opposite facts, and an approver reading the first will
 * reasonably conclude the alias is harmless when what is true is that its harm
 * is of a different kind. The same trap the M1 dogfood fell into: the sync
 * reported green because the flag was on, and only a row count separated that
 * from a source never connected.
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
  STORED_COLLISION_EXPRS,
  cardinalityHeldBackCountSql,
  supersedingDraftPredicate,
  supersessionCollisionPredicate,
  type CollisionExprs,
} from "@atlas/api/lib/content-mode/adapters/brain-facts";

const log = createLogger("brain-vocabulary-preview");

/** Which read surface refused, for {@link BrainReaderUnresolvedError}. */
const PREVIEW_SURFACE = "oversight";

/**
 * Most pairs one preview enumerates — {@link WILL_SUPERSEDE_PAIR_MAX}'s bound
 * and posture. Overrun is reported as `truncated`, never silent, and never
 * laundered into `withheld`, which means something else entirely.
 */
export const BLAST_RADIUS_PAIR_MAX = 50;

/**
 * One pair a decision would arm or disarm.
 *
 * Labels, never keys. ADR-0037 §6 forbids projecting a key beside its claim
 * (`keys-not-on-the-wire.test.ts` is the guard), and a consumer that can branch
 * on a key is what makes an alias un-removable. The SURFACE is what an approver
 * reads anyway.
 */
export interface BlastRadiusPair {
  readonly draftId: string;
  readonly draftLabel: string;
  readonly supersededId: string;
  readonly supersededLabel: string;
}

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
  | "not-curated";

/** The counterfactual's answer. */
export interface BlastRadius {
  /**
   * Pairs a decision would make supersedable — content-free count plus a
   * reader-scoped bounded sample.
   */
  readonly arming: BlastRadiusSide;
  /** Pairs a decision would make safe again. Empty for every approval. */
  readonly disarming: BlastRadiusSide;
  /**
   * ALWAYS true today, and a field rather than a comment because the surface
   * must render the floor wording and a boolean is what makes that assertable.
   * See the module header for the two independent reasons.
   */
  readonly floor: true;
  /** Non-null when the counterfactual cannot produce pairs by construction. */
  readonly structurallyEmpty: StructurallyEmptyReason | null;
}

export interface BlastRadiusSide {
  /** Unscoped, workspace-wide. A number, never content. */
  readonly total: number;
  /** Reader-scoped on BOTH sides. See {@link loadBlastRadiusSide}. */
  readonly pairs: readonly BlastRadiusPair[];
  /** `total − scopedTotal`: pairs that happen regardless, listing rows this reader may not read. */
  readonly withheld: number;
  /** The page overran {@link BLAST_RADIUS_PAIR_MAX}. Never folded into `withheld`. */
  readonly truncated: boolean;
}

const EMPTY_SIDE: BlastRadiusSide = Object.freeze({
  total: 0,
  pairs: [],
  withheld: 0,
  truncated: false,
});

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
  position: SlotPosition,
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
  position: SlotPosition,
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
 * and a truncated walk understates the blast radius — which is logged by
 * {@link loadBlastRadius}'s caller through the corruption the closure rebuild
 * will independently refuse. A preview must never be the thing that takes a
 * workspace's admin console down.
 */
function subtreeCteSql(
  cteName: string,
  workspaceParam: number,
  positionParam: number,
  fromNormParam: number,
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
        WHERE s.depth < ${MAX_CHAIN_DEPTH}
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
 * `IS DISTINCT FROM`, not `<>`. `predicate_key` is nullable on disk (a surface
 * that norms away — `identityKey`'s ⚠️, permanent and legal), and `NULL <> $k`
 * is NULL, which would make the whole conjunct NULL and drop the row through the
 * three-valued hole rather than excluding it on the merits. A NULL-keyed row
 * never matched the stored `EXISTS` either, so the two spellings agree on the
 * OUTCOME here — but only by coincidence, and the coincidence is exactly what
 * stops holding when someone edits the stored gate.
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
 * (`{ [pos === "subject" ? "subjectKey" : "predicateKey"]: … }`), which needed
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
  position: SlotPosition,
  keyExpr: (alias: string) => string,
): CollisionExprs {
  switch (position) {
    case "subject":
      return { ...STORED_COLLISION_EXPRS, subjectKey: keyExpr };
    case "predicate":
      return {
        ...STORED_COLLISION_EXPRS,
        predicateKey: keyExpr,
        cardinalitySingle: (alias) => cardinalitySingleSql(alias, keyExpr(alias)),
      };
    case "object":
      // Unreachable: `structurallyEmptyReason` returns `object-position` before
      // any plan is built. Thrown rather than falling through to the stored
      // bundle, because a silent identity counterfactual would render as "this
      // alias changes nothing" — which is TRUE for supersession and false for
      // what an approver would take it to mean.
      throw new Error(
        "loadBlastRadius: an object-position alias has no supersession counterfactual — the " +
          "collision does not read `object_key`. This is reported as structurallyEmpty " +
          '"object-position" before a plan is built, so reaching here is an ordering regression.',
      );
  }
}

// ---------------------------------------------------------------------------
// The delta
// ---------------------------------------------------------------------------

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
  requestId?: string,
): Promise<BlastRadius> {
  const workspaceId = ctx.workspaceId;

  const structurallyEmpty = await structurallyEmptyReason(db, workspaceId, request);
  if (structurallyEmpty !== null) {
    return {
      arming: EMPTY_SIDE,
      disarming: EMPTY_SIDE,
      floor: true,
      structurallyEmpty,
    };
  }

  const plan = await planCounterfactual(db, workspaceId, request);
  if (plan === null) {
    // The decision names nothing this workspace holds — an unaliased norm, a
    // predicate with no facts. Reported as an ordinary empty radius rather than
    // as an error: it is a legitimate answer to "what would this change", and
    // the authoring path refuses a zero-population pair separately and with a
    // reason (`vocabulary-author.ts`).
    return { arming: EMPTY_SIDE, disarming: EMPTY_SIDE, floor: true, structurallyEmpty: null };
  }

  const [arming, disarming] = await Promise.all([
    loadBlastRadiusSide(db, ctx, plan, "arming", requestId),
    loadBlastRadiusSide(db, ctx, plan, "disarming", requestId),
  ]);

  return { arming, disarming, floor: true, structurallyEmpty: null };
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
  /** Everything after `$1` (the workspace id), in order. */
  readonly params: readonly unknown[];
  readonly ctes: readonly string[];
  /** Narrows the draft side, e.g. to one predicate's slot. */
  readonly extraWhere?: string;
  /** The imported held-back count, when this request's arming side has one. */
  readonly importedTotalSql?: string;
  readonly importedTotalParams?: readonly unknown[];
}

async function planCounterfactual(
  db: BrainCandidateReader,
  workspaceId: string,
  request: BlastRadiusRequest,
): Promise<CounterfactualPlan | null> {
  switch (request.kind) {
    case "alias-approval": {
      const fromKey = identityKey(request.fromNorm);
      const toNorm = lexicalNorm(request.toNorm);
      if (fromKey === null || toNorm === "") return null;
      // `to`'s CURRENT effective target — see `approvalKeyExpr`'s ⚠️.
      const toKey = await resolveEffectiveTarget(db, workspaceId, request.position, toNorm);
      if (toKey === null) return null;
      return {
        hypothetical: aliasExprs(request.position, approvalKeyExpr(request.position, 2, 3)),
        params: [fromKey, toKey],
        ctes: [],
      };
    }
    case "alias-removal": {
      const fromKey = identityKey(request.fromNorm);
      if (fromKey === null) return null;
      return {
        hypothetical: aliasExprs(request.position, removalKeyExpr(request.position, "subtree", 2)),
        // `$2` is BOTH the substituted key and the subtree seed, and they are the
        // same string rather than two values that happen to match: `fromNorm` is
        // already a norm, and `identityKey` is idempotent on one, so
        // `identityKey(fromNorm) === fromNorm`. Bound once so a future edit
        // cannot make the walk start somewhere the substitution does not land.
        params: [fromKey, request.position],
        ctes: [subtreeCteSql("subtree", 1, 3, 2)],
      };
    }
    case "cardinality-flip":
    case "cardinality-removal": {
      const predicateKey = identityKey(request.predicateSurface);
      if (predicateKey === null) return null;
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
        params: [predicateKey],
        ctes: [],
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
        importedTotalSql:
          request.kind === "cardinality-flip"
            ? cardinalityHeldBackCountSql("d.predicate_key = $2")
            : undefined,
        importedTotalParams: request.kind === "cardinality-flip" ? [predicateKey] : undefined,
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
async function resolveEffectiveTarget(
  db: BrainCandidateReader,
  workspaceId: string,
  position: SlotPosition,
  norm: string,
): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT effective_target FROM brain_vocabulary_target
      WHERE workspace_id = $1 AND slot_position = $2 AND norm = $3`,
    [workspaceId, position, norm],
  );
  const row = rows[0] as { effective_target?: unknown } | undefined;
  const target = typeof row?.effective_target === "string" ? row.effective_target : norm;
  // Re-normed for `slotKey`'s reason: the vocabulary's answer is a data table's
  // and not a proof, and an entry authored as `"Priced At"` would otherwise make
  // this preview compute a key that joins nothing — a confident zero.
  return identityKey(target);
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
  if (
    (request.kind === "alias-approval" || request.kind === "alias-removal") &&
    request.position === "object"
  ) {
    return "object-position";
  }
  if (request.kind === "cardinality-flip" || request.kind === "cardinality-removal") {
    const predicateKey = identityKey(request.predicateSurface);
    if (predicateKey === null) return null;
    const { rows } = await db.query(
      `SELECT 1 AS hit FROM brain_predicate_cardinality
        WHERE workspace_id = $1 AND predicate_key = $2
          AND cardinality = 'single' AND status = 'approved'`,
      [workspaceId, predicateKey],
    );
    // The two kinds read the SAME probe and branch on opposite answers: a flip
    // has nothing to compute when the entry already exists, and a removal has
    // nothing to compute when it does not. One statement rather than two so the
    // "is this predicate curated" question has one spelling.
    const curated = rows.length > 0;
    if (request.kind === "cardinality-flip" && curated) return "already-single";
    if (request.kind === "cardinality-removal" && !curated) return "not-curated";
  }
  return null;
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
  requestId?: string,
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
    requestId,
  });
  if (draftAcl.decision === "deny-all") {
    throw new BrainReaderUnresolvedError(workspaceId, ctx.origin, PREVIEW_SURFACE);
  }
  const publishedAcl = aclVisibilityClause(ctx, {
    table: "brain_facts",
    alias: "p",
    paramIndex: draftAcl.nextParamIndex,
    requestId,
  });
  if (publishedAcl.decision === "deny-all") {
    // Unreachable — same context, same table, and the first clause resolved.
    // Kept because a silent empty list under a deny renders as "this approval
    // arms nothing", the false all-clear this module exists to prevent.
    throw new BrainReaderUnresolvedError(workspaceId, ctx.origin, PREVIEW_SURFACE);
  }
  const limitParam = publishedAcl.nextParamIndex;

  const useImported = direction === "arming" && plan.importedTotalSql !== undefined;
  const totalSql = useImported
    ? (plan.importedTotalSql as string)
    : deltaSql({
        select: TOTAL_SELECT,
        joinExprs,
        excludeExprs,
        workspaceParam: 1,
        extraWhere: plan.extraWhere,
        ctes: plan.ctes,
      });
  const totalParams = useImported
    ? [workspaceId, ...(plan.importedTotalParams ?? [])]
    : [workspaceId, ...plan.params];

  const pairsSql = deltaSql({
    select: pairsSelect(),
    joinExprs,
    excludeExprs,
    workspaceParam: 1,
    extraWhere: [plan.extraWhere, draftAcl.sql, publishedAcl.sql].filter(Boolean).join("\n     AND "),
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

  const total = readCount(totalResult.rows[0], useImported ? "held_back" : "delta_total");
  if (total === null) {
    // A THROW, not a degraded 0 — `loadSupersessionPreview`'s reason exactly: 0
    // renders as "this decision arms nothing", a confident false all-clear
    // fabricated from query drift, on the surface whose whole job is this
    // disclosure. `COUNT(*)` cannot return NULL, so this is unreachable from
    // Postgres.
    throw new Error(
      `brain vocabulary preview: the ${direction} total did not read back as a number for ` +
        `workspace ${workspaceId} — refusing to disclose a blast radius Atlas cannot establish`,
    );
  }

  const { pairs, scopedTotal, truncated } = readPairs(
    pairsResult.rows,
    workspaceId,
    direction,
    requestId,
  );

  if (scopedTotal > total) {
    log.warn(
      { workspaceId, requestId, direction, scopedTotal, total },
      "brain vocabulary preview: the reader-scoped delta exceeds the workspace delta — a brief ingest race, or the two statements disagree; reporting 0 withheld",
    );
  }

  return { total, pairs, withheld: Math.max(0, total - scopedTotal), truncated };
}

/** One `COUNT(*)::int` column, or `null` when it did not read back as one. */
function readCount(raw: unknown, column: string): number | null {
  const value = (raw as Record<string, unknown> | undefined)?.[column];
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
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
): { pairs: BlastRadiusPair[]; scopedTotal: number; truncated: boolean } {
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
    const windowed =
      typeof r.scoped_total === "number"
        ? r.scoped_total
        : r.scoped_total == null
          ? Number.NaN
          : Number(r.scoped_total);
    if (Number.isFinite(windowed) && windowed > scopedTotal) scopedTotal = Math.trunc(windowed);
    else if (!Number.isFinite(windowed)) windowDriftRows++;
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

  return { pairs, scopedTotal, truncated: clipped || scopedTotal > pairs.length };
}
