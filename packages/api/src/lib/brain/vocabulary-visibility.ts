/**
 * The POSITIONAL-VISIBILITY seam — who may see a vocabulary entry, and the one
 * place that rule is written down (#5087, ADR-0037 §6 as corrected by the
 * 2026-08-06 design pass).
 *
 * ## The rule
 *
 * > Predicate-position entries are unscoped. Entity-position entries are
 * > reader-scoped on **both** sides, re-derived at read time by joining
 * > `brain_facts` on the two norms.
 *
 * Predicate: a verb phrase discloses nothing an approver could not have
 * guessed, and `vocabulary-decide.ts` already grants the lower ENTITLEMENT bar
 * at that position for the same reason. It is also what keeps #5000's own entry
 * (`is priced at → priced at`) visible for the prod verification the arc closes
 * on.
 *
 * Entity: `project atlas → nova` **is** the confidential bit. Its evidence is a
 * warehouse row, and the grant grammar has no arm for warehouse RLS — so the
 * only expressible question is whether the reader can see, at that position, at
 * least one fact on **each** side.
 *
 * ## Why it is re-derived rather than stored
 *
 * T11 §5(b) originally gated entity proposals on "both evidence rows", and
 * ADR-0037 §6's amendment **corrects** it: `brain_vocabulary_proposal` (0190)
 * stores no fact ids, so there are no evidence rows to gate on. And storing a
 * grant on the vocabulary is refused outright — §6 makes the vocabulary the one
 * piece of brain state with no ACL, permanently, so a `visible_to` column here
 * would be a second, drifting copy of an ACL the design says does not exist.
 *
 * Re-derivation has a real cost and it is worth naming: the answer moves when
 * the corpus moves. An edge visible today is invisible tomorrow if the last
 * fact on one side is retracted. That is correct — the disclosure is *"you can
 * see claims on both sides of this merge"*, which is a fact about now — but it
 * means an entry can leave the *In force* pane without anybody deciding
 * anything, and {@link withheldCount} is what keeps that legible.
 *
 * ## ⚠️ This module is the SEAM, and #5087 owns it because it landed first
 *
 * `loadWillSupersedeCount`'s docstring in `oversight.ts` states the anti-drift
 * rule: *a disclosure that restates a rule drifts from it — import the join the
 * transaction will run.* (Cited by name, not by line: this repo's line refs into
 * `oversight.ts` have already rotted once.) Both children of #5025 need that
 * rule (the *In force* pane here, the Pending queue in child 3), and two
 * spellings of it is the likeliest thing to fall out of a split. So it is one
 * module with one exported clause builder, and child 3 imports
 * {@link visibleNormsSql} rather than writing the join again.
 *
 * Concretely, that means every consumer gets the rule through
 * {@link positionalScopeClause} — including the ones that are not about
 * visibility at all. The authoring picker (*which surfaces exist at this
 * position*) and the zero-population refusal both scope through it, so there is
 * exactly one answer in the process to *"which `brain_facts` rows count, at this
 * position, for this reader"*.
 *
 * ## Rate, not nature
 *
 * §6 accepts the leak's NATURE — *"what leaks is one bit of a relation"* — at
 * the RATE today's surfaces produce it. Enumerating every edge on page load
 * changes that to the whole relation at once, which is #4823's class. The scoped
 * read is what holds the rate down; {@link withheldCount} is what keeps the
 * scoping from reading as an absence.
 */

import { createLogger } from "@atlas/api/lib/logger";
import {
  aclVisibilityClause,
  type AclDecision,
  type BrainPrincipalContext,
} from "@atlas/api/lib/brain/acl";
import {
  SLOT_COLUMNS,
  lexicalNormSql,
  type SlotPosition,
} from "@atlas/api/lib/brain/identity";

const log = createLogger("brain-vocabulary-visibility");

/**
 * Which arm of the positional rule a clause took.
 *
 * Observable so a caller can log it and a test can assert the BRANCH rather
 * than pattern-match SQL text — `AclDecision`'s reason, and this type is the
 * positional rule's own version of it.
 *
 * `deny-all` is reachable at BOTH positions, and that is the half most easily
 * got wrong: "predicate is unscoped" means unscoped *within a workspace*, not
 * unscoped full stop. A context with no workspace has no tenant boundary to
 * enforce, and a predicate read that skipped the deny would answer about every
 * tenant at once.
 */
export type PositionalDecision =
  /** Predicate position: workspace containment only. */
  | "unscoped"
  /** Entity position: workspace containment AND grant overlap. */
  | "reader-scoped"
  /** No workspace, or an unresolvable reader. Matches nothing. */
  | "deny-all";

/**
 * A WHERE fragment scoping `brain_facts` rows at one position, plus its binds.
 *
 * Shaped on {@link AclClause} deliberately — same `nextParamIndex` discipline,
 * same "parenthesised, no leading `AND`" contract — so a caller that already
 * composes ACL clauses composes this one the same way.
 */
export interface PositionalScopeClause {
  readonly sql: string;
  readonly params: readonly unknown[];
  /** First placeholder the caller may use AFTER this clause. */
  readonly nextParamIndex: number;
  readonly decision: PositionalDecision;
  /**
   * The underlying ACL decision at an entity position, or `null` at a predicate
   * one where no ACL clause was built.
   *
   * Surfaced rather than swallowed because `audit-override` and `grant-match`
   * are both `reader-scoped` here and an operator reading a withheld count of
   * zero must be able to tell "you can see everything" from "an override was in
   * force". Nothing in this module BRANCHES on it; it exists for the log line.
   */
  readonly aclDecision: AclDecision | null;
}

/** A SQL identifier safe to interpolate. `aclVisibilityClause`'s own guard. */
const SAFE_ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The LIVE set — the population a vocabulary decision is about.
 *
 * `invalidated_at IS NULL AND valid_to IS NULL`, matching `ALIAS_PROPOSAL_SQL`'s
 * two arms and the partial index #5019 repointed onto the identity keys.
 *
 * ⚠️ Deliberately NARROWER than the drift re-key's scope, and the asymmetry is
 * load-bearing rather than an inconsistency. `REKEY_DRIFTED_FACTS_SQL` applies
 * no TEMPORAL arm at all, because a tombstoned row left on a stale key is a row
 * whose surface and key disagree forever. (It does apply other arms — a
 * workspace scope, the key disagreement, and since #5047 a refusal on a null
 * recomputed key. An earlier cut of this line said "and nothing else", which
 * was true when written and went stale twice over.) This clause answers a different question —
 * *is there a live claim a human could be looking at?* — and counting retracted
 * claims toward a population would let an alias be authored for a spelling the
 * corpus has already withdrawn, which is the "unfalsifiable and rots silently"
 * case the zero-population refusal exists to prevent.
 */
function liveFactSql(alias: string): string {
  return `${alias}.invalidated_at IS NULL AND ${alias}.valid_to IS NULL`;
}

export interface PositionalScopeOptions {
  /** 1-based index of the FIRST placeholder this clause may use. */
  readonly paramIndex: number;
  /** The `brain_facts` alias the emitted SQL references. Defaults to `vf`. */
  readonly alias?: string;
  /** Correlates this clause's log lines with the originating request. */
  readonly requestId?: string;
  /**
   * Count RETRACTED and superseded claims toward the population too.
   *
   * ⚠️ Off by default, and the caller that turns it on is answering a
   * different question from the one the panes ask.
   *
   * A DISPLAY read wants the live set: an entry whose claims are all withdrawn
   * describes nothing an approver is looking at. A REMOVAL gate wants the wider
   * one, because "no live claims" and "not visible to you" are different facts
   * and collapsing them makes an in-force edge permanently unremovable — by
   * everyone, since the live-set test fails for every reader at once. The ACL
   * arm is unchanged either way: a retracted claim is still a claim this reader
   * was entitled to, so widening the temporal filter discloses nothing the
   * grant does not already allow.
   */
  readonly includeRetracted?: boolean;
}

/**
 * THE positional rule, as a composable WHERE fragment.
 *
 * Every consumer of the rule — this module's own {@link visibleNormsSql} and
 * {@link isPairVisible}, the authoring picker, the *In force* pane, and child
 * 3's Pending queue — goes through here. That is the whole point of the seam.
 *
 * ## Why the predicate arm still emits workspace containment
 *
 * `aclVisibilityClause` argues this for the grant case and the argument
 * transfers unchanged: a predicate read composed into a query whose own
 * workspace scoping was missing or accidentally OR-ed would answer about every
 * tenant. Redundant tenant scoping inside a disclosure predicate is the
 * difference between a primitive that is safe standalone and one that is safe
 * only when used correctly. Postgres folds the duplicate for free.
 *
 * ## Why `deny-all` is `(FALSE)` rather than a throw
 *
 * A throw is the right answer for a reader who cannot be resolved AT ALL, and
 * `loadBlastRadius` takes it. This clause is composed into reads that also
 * carry an unscoped half (a workspace's edge COUNT is disclosable even when its
 * contents are not — see {@link withheldCount}), so denying the scoped half
 * while the count survives is the shape that lets *"12 entity edges you cannot
 * see"* be said at all. Callers that need the harder posture check
 * {@link PositionalScopeClause.decision} themselves.
 */
export function positionalScopeClause(
  position: SlotPosition,
  ctx: BrainPrincipalContext,
  options: PositionalScopeOptions,
): PositionalScopeClause {
  const { paramIndex, requestId } = options;
  const alias = options.alias ?? "vf";

  if (!Number.isInteger(paramIndex) || paramIndex < 1) {
    throw new Error(
      `positionalScopeClause: paramIndex must be a positive integer, got ${paramIndex}`,
    );
  }
  if (!SAFE_ALIAS.test(alias)) {
    throw new Error(
      `positionalScopeClause: alias ${JSON.stringify(alias)} is not a plain SQL identifier`,
    );
  }

  const live = options.includeRetracted ? "TRUE" : liveFactSql(alias);

  if (position !== "predicate") {
    // ENTITY. The whole clause comes from `aclVisibilityClause` — the same
    // primitive every other brain read composes — so this arm cannot drift from
    // the grant grammar by being re-derived here.
    const acl = aclVisibilityClause(ctx, {
      table: "brain_facts",
      alias,
      paramIndex,
      requestId,
    });
    return {
      sql: `(${acl.sql} AND ${live})`,
      params: acl.params,
      nextParamIndex: acl.nextParamIndex,
      decision: acl.decision === "deny-all" ? "deny-all" : "reader-scoped",
      aclDecision: acl.decision,
    };
  }

  // PREDICATE. Unscoped by grant, still bounded by tenant — and still denied
  // for a reader whose identity did not resolve.
  //
  // `unresolved` is refused here as well as at the entity arm, and that is not
  // belt-and-braces: an unresolvable identity is an upstream defect, and the
  // predicate pane is reachable from the same route as the entity one. Answering
  // it for a caller whose workspace attribution is itself in doubt would put the
  // tenant boundary on the same footing as the grant boundary this arm
  // deliberately drops.
  if (!ctx.workspaceId || ctx.origin === "unresolved") {
    log.warn(
      { position, origin: ctx.origin, workspaceId: ctx.workspaceId, requestId },
      "brain vocabulary visibility: predicate-position read has no workspace or no resolved reader — denying all rows",
    );
    return {
      sql: "(FALSE)",
      params: [],
      nextParamIndex: paramIndex,
      decision: "deny-all",
      aclDecision: null,
    };
  }

  return {
    sql: `(${alias}.workspace_id = $${paramIndex} AND ${live})`,
    params: [ctx.workspaceId],
    nextParamIndex: paramIndex + 1,
    decision: "unscoped",
    aclDecision: null,
  };
}

/**
 * The set of norms this reader may see at this position — *"join `brain_facts`
 * on the two norms"*, as a subquery.
 *
 * THE shape both panes need. The *In force* pane tests an approved edge's two
 * norms against it; child 3's Pending queue tests a proposal's two norms against
 * the same subquery, built by this same call. A per-edge `EXISTS` builder would
 * have been the other shape and it is worse for both: N correlated subqueries
 * per page, and — the reason that matters — a builder that takes ONE norm
 * cannot express *both sides* without the caller writing the AND, which is
 * precisely the half of the rule (*"reader-scoped on **both** sides"*) most
 * likely to be dropped in the copy this seam exists to prevent.
 *
 * Emitted as a bare `SELECT`, not a named CTE, so the caller decides whether it
 * is a `WITH` or an inline `IN (…)`. `sql` is parenthesised like every other
 * clause here.
 *
 * ## Norm, not key — and the difference is not cosmetic
 *
 * It projects `lexicalNorm(surface)`, NOT `<position>_key`. The key column has
 * the vocabulary ALREADY APPLIED to it, so a key projection would answer *which
 * claims currently occupy the slot* — and once `a → b` is approved, no live row
 * keys `a` any more. The edge just authored would report an empty population and
 * disappear from the pane that exists to show it in force, on the very path
 * #5000 closes on. The norm is the pre-alias spelling: it is what an entry is
 * MADE of, and it is what survives the entry's own approval.
 *
 * ⚠️ It follows that a caller must compare against `from_norm`/`to_norm` — the
 * stored norm columns — and never against a key.
 */
export function visibleNormsSql(
  position: SlotPosition,
  ctx: BrainPrincipalContext,
  options: PositionalScopeOptions,
): PositionalScopeClause {
  const alias = options.alias ?? "vf";
  const scope = positionalScopeClause(position, ctx, options);
  const { surface } = SLOT_COLUMNS[position];
  if (scope.decision === "deny-all") {
    // A subquery over `(FALSE)` is correct but pointless, and it would still
    // cost a plan on a page that can never show a row. `WHERE FALSE` keeps the
    // shape a caller can splice in unconditionally; `nextParamIndex` is the
    // caller's untouched cursor either way, which is what makes every branch's
    // arithmetic identical.
    return {
      ...scope,
      sql: `(SELECT NULL::text AS norm WHERE FALSE)`,
    };
  }
  return {
    ...scope,
    sql:
      `(SELECT DISTINCT ${lexicalNormSql(`${alias}.${surface}`)} AS norm` +
      ` FROM brain_facts ${alias} WHERE ${scope.sql})`,
  };
}

/** The reader this module's one query needs. Satisfied by a pool and a `tx`. */
export interface PairVisibilityReader {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: readonly unknown[] }>;
}

/**
 * *May this reader SEE the entry joining these two norms?* — the same rule
 * {@link visibleNormsSql} applies to a list, asked about one pair.
 *
 * ## ⚠️ Why a WRITE path needs this, and what its absence was
 *
 * The *In force* pane withholds an entity edge whose two populations the reader
 * cannot both read. Removal ran no such check: it validated the workspace, the
 * owner/admin bar and the norm shape, then went straight to the proposal row. So
 * a reader the pane had withheld an edge from could remove it by naming the pair
 * — and, more sharply, could learn whether it existed at all, because a real
 * edge answered `removed` and an imagined one answered `not-in-force`.
 *
 * That is an **existence oracle for exactly the population the scoping exists to
 * withhold**: ADR-0037 §6's whole entity-position argument is that
 * `project atlas → nova` **is** the confidential bit. And it made
 * {@link logFailClosedHole}'s line — *"those entries are also un-removable by
 * them"* — false, enforced only by a UI that declined to render a button.
 *
 * ## The caller must NOT distinguish invisible from absent
 *
 * This returns a boolean, and the one correct way to use it is to fold "you may
 * not see it" into the SAME refusal as "it is not there" — `admin-brain-facts.ts`
 * does exactly this for its retract 404, *"deliberately indistinguishable, so
 * the response cannot confirm the existence of a fact the reader may not see."*
 * A distinct `not-visible` refusal would restore the oracle in words after
 * closing it in rows.
 *
 * ## Predicate position is unscoped, and short-circuits
 *
 * A predicate edge is visible to anyone who can read the workspace, so the
 * answer is `true` for any resolved reader and no query runs.
 *
 * ⚠️ It was NOT short-circuited at first, on a "keep the rule single-sited"
 * argument, and that was wrong in a way worth recording: the uniform path ran
 * the population join, which tests the LIVE set — so a predicate edge whose
 * claims had all been retracted refused, and an in-force, identity-shaping edge
 * became permanently unremovable at a position with no confidentiality argument
 * at all. The rule is still single-sited (`positionalScopeClause` decides the
 * arm); what changed is that the unscoped arm now means what it says.
 */
export async function isPairVisible(
  db: PairVisibilityReader,
  position: SlotPosition,
  ctx: BrainPrincipalContext,
  pair: { readonly fromNorm: string; readonly toNorm: string },
  options: { readonly requestId?: string } = {},
): Promise<boolean> {
  const scope = positionalScopeClause(position, ctx, {
    paramIndex: 1,
    alias: "vf",
    requestId: options.requestId,
  });
  if (scope.decision === "deny-all") return false;
  // ⚠️ PREDICATE SHORT-CIRCUITS — see the ⚠️ in the docstring. Not an optimization.
  if (scope.decision === "unscoped") return true;

  const visible = visibleNormsSql(position, ctx, {
    paramIndex: 1,
    alias: "vf",
    requestId: options.requestId,
    // RETRACTED-INCLUSIVE. See {@link PositionalScopeOptions.includeRetracted}:
    // the live-set test fails for every reader at once, so using it here would
    // make an edge invisible-and-unremovable rather than merely invisible.
    includeRetracted: true,
  });
  if (visible.decision === "deny-all") return false;

  const params = [...visible.params, pair.fromNorm, pair.toNorm];
  const fromParam = visible.nextParamIndex;
  const toParam = visible.nextParamIndex + 1;

  // BOTH sides, in ONE statement — the same snapshot, so a concurrent write
  // cannot make a pair pass one half and fail the other. `EXISTS … AND EXISTS`
  // rather than two round trips for that reason and for `loadPairPopulation`'s.
  const { rows } = await db.query(
    `WITH visible_norms AS ${visible.sql}
     SELECT (EXISTS (SELECT 1 FROM visible_norms v WHERE v.norm = $${fromParam})
         AND EXISTS (SELECT 1 FROM visible_norms v WHERE v.norm = $${toParam})) AS visible`,
    params,
  );
  const raw = rows[0];
  const row: Record<string, unknown> | undefined =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : undefined;
  if (typeof row?.visible !== "boolean") {
    // FAIL CLOSED, and loudly. An unreadable answer here becomes "you may not
    // remove this", which costs an admin a retry; the permissive default would
    // reopen the oracle this function exists to close.
    log.error(
      { workspaceId: ctx.workspaceId, position, requestId: options.requestId },
      "brain vocabulary: the pair-visibility probe returned no usable answer — refusing rather than assuming the reader may see this entry",
    );
    return false;
  }
  return row.visible;
}

/**
 * `total − scoped`, floored at zero, with the clamp REPORTED rather than
 * absorbed.
 *
 * ADR-0037 §6's rule for the *In force* pane: **a withheld count, never a silent
 * omission.** The vocabulary is workspace-global, so its SIZE is not a secret
 * even when its contents are — and an approver must be able to tell *"12 entity
 * edges you cannot see"* from *"none"*. Those are opposite facts and a scoped
 * `SELECT` renders them identically.
 *
 * The clamp exists because `total` and `scoped` come from two statements that
 * can straddle a concurrent write, so `scoped > total` is reachable without
 * anything being wrong. It is reported through `consistent: false` for
 * `loadFactOversight`'s reason, quoted in `BlastRadiusSide.countsConsistent`:
 * *silently clamping the delta to zero renders as "nothing is hidden from you",
 * which is the pre-#4825 defect reproduced by its own fix.*
 */
export interface WithheldCount {
  readonly total: number;
  readonly scoped: number;
  readonly withheld: number;
  /** False when the two statements disagreed and the delta was clamped. */
  readonly consistent: boolean;
}

export function withheldCount(total: number, scoped: number): WithheldCount {
  // `!Number.isFinite` rather than a NaN check: an unreadable count must fail
  // every comparison rather than clear one, and `NaN - 0` is `NaN`, which
  // renders as "NaN edges you cannot see".
  if (!Number.isFinite(total) || !Number.isFinite(scoped)) {
    return { total: 0, scoped: 0, withheld: 0, consistent: false };
  }
  const delta = total - scoped;
  return {
    total,
    scoped,
    withheld: delta > 0 ? delta : 0,
    consistent: delta >= 0,
  };
}

/**
 * Log the fail-closed hole — an entity entry this reader cannot see is also one
 * they cannot REMOVE.
 *
 * ADR-0037 §6's rule: **the fail-closed hole is logged, not skipped silently.**
 * The pane is correct and fail-closed, and the cost is real: a workspace whose
 * only admin cannot READ a bad edge's populations has no console recovery for it,
 * at exactly the moment recovery is needed (`led_by → leads` approved, `valid_to`
 * stamping across the manager graph). Nothing here can widen the disclosure —
 * that would be the leak — so the one honest response is to make the situation
 * findable in the logs by somebody who CAN reach the database.
 *
 * Called once per position per load with the aggregate — plus once more for the
 * curated-predicate accounting, which is also stamped `position: "predicate"`,
 * so a load emits two predicate-stamped lines and not one. Never once per
 * withheld row: a per-row line would put the withheld pairs' norms in the log,
 * which is the content the scoping just withheld.
 */
export function logFailClosedHole(details: {
  readonly workspaceId: string;
  readonly position: SlotPosition;
  readonly counts: WithheldCount;
  readonly decision: PositionalDecision;
  readonly aclDecision: AclDecision | null;
  readonly userId: string | null;
  readonly requestId?: string;
}): void {
  if (details.counts.withheld <= 0 && details.counts.consistent) return;
  log.warn(
    {
      workspaceId: details.workspaceId,
      position: details.position,
      total: details.counts.total,
      scoped: details.counts.scoped,
      withheld: details.counts.withheld,
      countsConsistent: details.counts.consistent,
      decision: details.decision,
      aclDecision: details.aclDecision,
      userId: details.userId,
      requestId: details.requestId,
    },
    // Position-agnostic wording. It said "entity-position entries" and is now
    // also called for the curated-predicate accounting, where that would be a
    // false label on the one line an operator is meant to trust — `position` is
    // in the payload and says which.
    // ⚠️ Qualified to the ACL case. The unqualified claim went false the moment
    // the removal gate started counting RETRACTED claims: `withheld` is still
    // computed from the live set, so an entry withheld only because its claims
    // were retracted is now recoverable. Over-alarming rather than
    // under-disclosing, but this surface's premise is that these sentences are
    // exact.
    "brain vocabulary: entries in force were withheld from an approver — an entry withheld because its populations are unreadable to them is also un-removable by them, so a bad entry there has no in-product recovery path",
  );
}
