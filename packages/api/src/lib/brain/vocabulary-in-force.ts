/**
 * The **In force** pane — what is currently shaping identity, and what an
 * approver may take back out (#5087, ADR-0037 §6 + #5025's 2026-08-07 grill).
 *
 * ## Why removal needed a surface at all
 *
 * Every AC that predates the grill covers PENDING work, and a queue of pending
 * proposals **structurally cannot show an edge that was already approved**. So
 * `removeAliasEdge` shipped in #5022 with a test and no surface, and
 * `declarePredicateCardinality` / `decidePredicateCardinality` shipped in #5027
 * with zero production callers.
 *
 * Deferring removal is the cheaper build and wrong on two counts. ADR-0037 §6
 * makes removal the load-bearing half of the two-relation design — *"removal
 * becomes a recomputation"* is why approved edges and effective target are split
 * at all — and calls reversibility **the sole thing that makes a bad alias
 * undoable**. Leaving it function-only puts bad-alias recovery in a database
 * console at exactly the moment it is needed: approve `led_by → leads`, watch
 * `valid_to` stamp across the manager graph. And #5000 closes on **prod
 * verification**, which means seeing the authored edge in force and confirming
 * the re-key landed — something an emptied queue cannot tell you.
 *
 * ## A removal is a re-key too, and it is NOT approval inverted
 *
 * Every removal here goes behind the same blast-radius preview an approval
 * uses — child 1's `loadBlastRadius`, on its `disarming` side. That is not
 * symmetry for its own sake: `REKEY_DRIFTED_FACTS_SQL`'s header carries the
 * argument that removal is *not* well-defined key-to-key (of the rows keyed `R`,
 * only those whose norm chains through `a` move), so the counterfactual is a
 * genuinely different expression over the same delta function. This module does
 * not compute it; it names the request and the pane hands it to the preview.
 *
 * ## Disclosure: the SAME positional rule as Pending, applied to populations
 *
 * `vocabulary-visibility.ts` is the seam and this is its first consumer. An
 * approved edge is **strictly more disclosive** than a pending proposal — a
 * pending row is a guess about two spellings, an approved edge is a standing
 * assertion that two spellings name the same thing — and per §6 the vocabulary
 * is permanently ACL-less, so a naked `SELECT` of `brain_vocabulary_edge` hands
 * every admin every equivalence anyone ever approved, including ones whose
 * populations live entirely in channels they cannot read.
 *
 * §6 accepts that leak's NATURE at the RATE today's surfaces produce it.
 * Enumerating every edge on page load changes it to the whole relation at once —
 * #4823's class. So: predicate-position unscoped, entity-position reader-scoped
 * on both sides, and a **withheld count** so an approver can tell *"12 entity
 * edges you cannot see"* from *"none"*.
 *
 * ## Cardinality entries are predicate-position, and that is derived
 *
 * `brain_predicate_cardinality` is keyed on a canonical PREDICATE key, so every
 * row in it is a predicate-position statement and takes the unscoped arm by the
 * same rule rather than by a second decision. What it does need is care about
 * the KEY: the table cannot address a row without naming `predicate_key`, and
 * `keys-not-on-the-wire.test.ts` forbids that key reaching a consumer. So this
 * module joins back to `brain_facts` and projects a representative SURFACE,
 * and {@link InForceCardinality} carries no key at all — the same prohibition
 * `PredicateCardinalityRecord` states for itself.
 */

import { createLogger } from "@atlas/api/lib/logger";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import { SLOT_POSITIONS, type SlotPosition } from "@atlas/api/lib/brain/identity";
import type { PredicateCardinality } from "@atlas/api/lib/brain/types";
import {
  logFailClosedHole,
  positionalScopeClause,
  visibleNormsSql,
  withheldCount,
  type PositionalDecision,
  type WithheldCount,
} from "@atlas/api/lib/brain/vocabulary-visibility";

const log = createLogger("brain-vocabulary-in-force");

/** The reader this module needs. Satisfied by the internal pool. */
export interface InForceReader {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: readonly unknown[] }>;
}

/**
 * Most entries one pane enumerates, per kind.
 *
 * Bounded for `BLAST_RADIUS_PAIR_MAX`'s reason and reported through
 * {@link InForceView.truncated} — a silent cap on a disclosure surface reads as
 * *"that is all there is"*, which is the one sentence this pane must never say
 * by accident.
 */
export const IN_FORCE_PAGE_MAX = 200;

/** One approved edge currently shaping identity. */
export interface InForceAliasEdge {
  readonly position: SlotPosition;
  readonly fromNorm: string;
  readonly toNorm: string;
  /**
   * The approving user id, `local-operator`, or `null` for an auto-approved
   * warehouse-derived edge. Migration 0189's three legal values, unflattened:
   * `approved_by IS NOT NULL` means "a human" BY CONSTRUCTION, and collapsing
   * the null into a sentinel here would destroy exactly that.
   */
  readonly approvedBy: string | null;
  readonly approvedAt: string;
  /**
   * The proposal row a removal stamps `rejected`.
   *
   * `null` when there is none — an edge written by the region importer, which
   * copies edges and not proposals (#5035's bundle scope classifies
   * `brain_vocabulary_proposal` as `stays`). Surfaced rather than hidden
   * because such an edge is removable only through a path that has no rejection
   * memory to write, and an approver deserves to know that before they press
   * the button rather than after the producer re-proposes it.
   */
  readonly proposalId: string | null;
}

/** One curated cardinality currently shaping supersession. */
export interface InForceCardinality {
  /**
   * A representative live surface for the canonical predicate.
   *
   * ⚠️ NOT the predicate key. See the module header — and note the surface may
   * be `null` when every claim that produced the key has since been retracted,
   * which is a real state and is reported rather than filtered away: an entry
   * still arming supersession for a predicate with no live claims is precisely
   * the thing an approver should be able to find and remove.
   */
  readonly predicateSurface: string | null;
  /**
   * NARROWED to the two-member vocabulary, not `string`.
   *
   * The wire type is a union and the producer was not, so `checked()` was the
   * only thing connecting them — and it connected them by taking the whole pane
   * down as a 500 when a drifted value arrived. Narrowing here means such a row
   * is counted as unreadable and logged, which is this module's stated contract
   * for every other column.
   */
  readonly cardinality: PredicateCardinality;
  readonly sourceClass: string;
  readonly proposedBy: string;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  /** Live claims at the predicate position currently in this slot. */
  readonly claims: number;
}

/** One position's disclosure accounting. */
export interface InForcePositionCounts extends WithheldCount {
  readonly position: SlotPosition;
  readonly decision: PositionalDecision;
}

export interface InForceView {
  readonly edges: readonly InForceAliasEdge[];
  /**
   * Per position, `total` (workspace-wide, content-free) vs `scoped` (what the
   * reader may see) vs `withheld`.
   *
   * ⚠️ Per POSITION rather than one aggregate, and the difference is the point:
   * the predicate arm is unscoped, so folding the three together would let a
   * withheld count of 0 across a workspace with many predicate edges hide a
   * fully-withheld entity population inside an apparently healthy total.
   */
  readonly counts: readonly InForcePositionCounts[];
  readonly cardinalities: readonly InForceCardinality[];
  /**
   * The same accounting the edges get, for curated predicates.
   *
   * ⚠️ Added because its absence let the empty state assert *"no curated
   * predicates are in force in this workspace"* on the strength of a read that
   * was DENIED. Cardinality entries are predicate-position and therefore
   * unscoped, so `withheld` is zero for every reader who can see the workspace
   * at all — but "zero because there are none" and "zero because you were
   * denied" are the two facts this whole surface exists to separate, and only a
   * count can.
   *
   * The total is workspace-wide and content-free, disclosable by exactly the
   * argument the edge totals rest on (ADR-0037 §6: the vocabulary is
   * workspace-global, so its SIZE is not a secret even when its contents are).
   */
  readonly cardinalityCounts: InForcePositionCounts;
  /** Any list was capped at {@link IN_FORCE_PAGE_MAX}. */
  readonly truncated: boolean;
}

/**
 * Everything currently in force, under the positional rule.
 *
 * Three KINDS of statement per load — the scoped edges, the unscoped
 * per-position totals, and the cardinality entries — six round trips in all
 * (one edge query per slot position, plus the edge totals, the cardinality
 * entries and their total). The first two kinds are what make
 * `withheld` sayable at all. They can straddle a concurrent write, which
 * {@link withheldCount} reports through `consistent` rather than clamping into
 * *"nothing is hidden from you"*.
 */
export async function loadInForceVocabulary(
  db: InForceReader,
  ctx: BrainPrincipalContext,
  opts: { readonly requestId?: string } = {},
): Promise<InForceView> {
  const workspaceId = ctx.workspaceId;

  const [edgeResults, totals, cardinalities] = await Promise.all([
    Promise.all(SLOT_POSITIONS.map((p) => loadPositionEdges(db, ctx, p, opts))),
    loadEdgeTotals(db, workspaceId),
    loadCardinalities(db, ctx, opts),
  ]);

  const edges: InForceAliasEdge[] = [];
  const counts: InForcePositionCounts[] = [];
  let truncated = cardinalities.truncated;

  for (const result of edgeResults) {
    edges.push(...result.edges);
    truncated = truncated || result.truncated;
    const total = totals.totals.get(result.position) ?? 0;
    // `scoped` is the SCOPED TOTAL, not `edges.length` — the list is capped at
    // `IN_FORCE_PAGE_MAX` and a page-sized `scoped` would turn a truncation into
    // a withheld count, which is exactly the conflation `BlastRadiusSide`
    // forbids ("truncation dressed as an ACL boundary").
    // ⚠️ `consistent` is AND-ed with both provenance flags, not just the
    // arithmetic. `withheldCount` can only see whether the two numbers disagree;
    // it cannot see that one of them was never read. A withheld count computed
    // from a stand-in is not a smaller number — it is a number with no meaning,
    // and reporting it as consistent is the "nothing is hidden from you" the
    // whole accounting exists to refuse.
    const arithmetic = withheldCount(total, result.scopedTotal);
    const positionCounts: WithheldCount = {
      ...arithmetic,
      // ⚠️ `totals.unreadable`, NOT `storedTotal !== undefined`.
      //
      // `loadEdgeTotals` is `GROUP BY slot_position`, so a position with ZERO
      // edges legitimately produces no row — and the earlier spelling could not
      // tell that from "the row did not narrow". The result was
      // `countsConsistent: false` on every empty position: three destructive
      // "counts disagreed" badges and a "reload to get a consistent pair"
      // paragraph on the day-one empty state, which no reload could ever clear,
      // plus three `logFailClosedHole` warns per page load — drowning the one
      // line ADR-0037 §6 requires be findable.
      //
      // The signal for the real case was already returned and never read. It is
      // WORKSPACE-WIDE rather than per-position on purpose: a row that would not
      // narrow cannot be attributed to a position, so it must taint all three
      // rather than none.
      consistent: arithmetic.consistent && result.scopedTotalKnown && totals.unreadable === 0,
    };
    counts.push({
      position: result.position,
      decision: result.decision,
      ...positionCounts,
    });
    logFailClosedHole({
      workspaceId,
      position: result.position,
      counts: positionCounts,
      decision: result.decision,
      aclDecision: result.aclDecision,
      userId: ctx.userId,
      ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
    });
  }

  // ⚠️ `cardinalities.scopedTotal`, NOT `cardinalities.rows.length`.
  //
  // The list is page-capped and drops rows that will not narrow, so the page
  // length is not "what this reader may see" — and using it reproduced, in the
  // code that fixed it for edges, the exact conflation the sibling path forbids
  // by name thirty lines up: 250 approved entries rendered `withheld: 50` at an
  // UNSCOPED position, where withheld must be zero by construction. A page cap
  // wearing an ACL boundary's face, on the surface whose entire purpose is that
  // those two are distinguishable.
  const cardinalityArithmetic = withheldCount(cardinalities.total, cardinalities.scopedTotal);
  const cardinalityCounts: InForcePositionCounts = {
    position: "predicate",
    decision: cardinalities.decision,
    ...cardinalityArithmetic,
    consistent:
      cardinalityArithmetic.consistent &&
      cardinalities.totalKnown &&
      cardinalities.scopedTotalKnown,
  };
  logFailClosedHole({
    workspaceId,
    position: "predicate",
    counts: cardinalityCounts,
    decision: cardinalities.decision,
    aclDecision: null,
    userId: ctx.userId,
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });

  return {
    edges,
    counts,
    cardinalities: cardinalities.rows,
    cardinalityCounts,
    truncated,
  };
}

interface PositionEdges {
  readonly position: SlotPosition;
  readonly edges: readonly InForceAliasEdge[];
  /** Edges this reader may see, BEFORE the page cap. */
  readonly scopedTotal: number;
  /**
   * Whether {@link scopedTotal} came from the query or is a stand-in.
   *
   * Its own field rather than a nullable `scopedTotal`, because every consumer
   * needs a number to render and only one needs to know whether to trust it —
   * and a nullable would make every caller handle the absence, which is how a
   * `?? 0` gets written at the call site instead.
   */
  readonly scopedTotalKnown: boolean;
  readonly truncated: boolean;
  readonly decision: PositionalDecision;
  readonly aclDecision: ReturnType<typeof positionalScopeClause>["aclDecision"];
}

/**
 * One position's visible edges.
 *
 * The both-sides test applies `visibleNormsSql`'s set to BOTH norms from a
 * single builder call — the seam's own subquery, spliced as one CTE and
 * referenced by two `EXISTS`, so the scan runs once and both sides ask the SAME
 * set. Two separate builder calls would bind the scope's params twice and,
 * worse, would be two places for the rule to be edited.
 *
 * `LEFT JOIN` onto the proposal row rather than an inner one: an edge the region
 * importer copied has no proposal (see {@link InForceAliasEdge.proposalId}), and
 * an inner join would make it VANISH from the pane — an approved edge shaping
 * identity that the surface silently denies exists, which is a strictly worse
 * disclosure failure than showing it with a null id.
 */
async function loadPositionEdges(
  db: InForceReader,
  ctx: BrainPrincipalContext,
  position: SlotPosition,
  opts: { readonly requestId?: string },
): Promise<PositionEdges> {
  const visible = visibleNormsSql(position, ctx, {
    paramIndex: 1,
    alias: "vf",
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });

  const empty: PositionEdges = {
    position,
    edges: [],
    scopedTotal: 0,
    // A denied reader genuinely sees zero — that is an answer, not a drift.
    scopedTotalKnown: true,
    truncated: false,
    decision: visible.decision,
    aclDecision: visible.aclDecision,
  };
  if (visible.decision === "deny-all") return empty;

  const params: unknown[] = [...visible.params, ctx.workspaceId, position, IN_FORCE_PAGE_MAX + 1];
  const wsParam = visible.nextParamIndex;
  const posParam = wsParam + 1;
  const limitParam = wsParam + 2;

  const { rows } = await db.query(
    `WITH visible_norms AS ${visible.sql}
     SELECT e.from_norm,
            e.to_norm,
            e.approved_by,
            e.approved_at::text AS approved_at,
            p.id::text AS proposal_id,
            COUNT(*) OVER ()::int AS scoped_total
       FROM brain_vocabulary_edge e
       LEFT JOIN brain_vocabulary_proposal p
         ON p.workspace_id = e.workspace_id
        AND p.slot_position = e.slot_position
        AND p.status = 'approved'
        AND p.pair_low = LEAST(e.from_norm, e.to_norm)
        AND p.pair_high = GREATEST(e.from_norm, e.to_norm)
      WHERE e.workspace_id = $${wsParam}
        AND e.slot_position = $${posParam}
        AND EXISTS (SELECT 1 FROM visible_norms v WHERE v.norm = e.from_norm)
        AND EXISTS (SELECT 1 FROM visible_norms v WHERE v.norm = e.to_norm)
      ORDER BY e.approved_at DESC, e.from_norm
      LIMIT $${limitParam}`,
    params,
  );

  const edges: InForceAliasEdge[] = [];
  let scopedTotal: number | null = null;
  let unreadable = 0;
  for (const raw of rows.slice(0, IN_FORCE_PAGE_MAX)) {
    if (typeof raw !== "object" || raw === null) {
      unreadable += 1;
      continue;
    }
    const row = raw as Record<string, unknown>;
    if (typeof row.from_norm !== "string" || typeof row.to_norm !== "string") {
      unreadable += 1;
      continue;
    }
    // ⚠️ `approved_at` is DROPPED rather than defaulted to `""`. An empty string
    // parses as a `string` on the wire and renders as an un-parseable date; the
    // row is unreadable, and this module's contract is that unreadable rows are
    // counted and logged, not smuggled through with a plausible-looking field.
    if (typeof row.approved_at !== "string" || row.approved_at === "") {
      unreadable += 1;
      continue;
    }
    if (typeof row.scoped_total === "number") scopedTotal = row.scoped_total;
    edges.push({
      position,
      fromNorm: row.from_norm,
      toNorm: row.to_norm,
      approvedBy: typeof row.approved_by === "string" ? row.approved_by : null,
      approvedAt: row.approved_at,
      proposalId: typeof row.proposal_id === "string" ? row.proposal_id : null,
    });
  }
  if (unreadable > 0) {
    log.warn(
      { workspaceId: ctx.workspaceId, position, unreadable, requestId: opts.requestId },
      "brain vocabulary in-force: edge rows would not narrow and were dropped — the pane shows fewer entries than are in force",
    );
  }

  // ⚠️ `null` means the window function's value never arrived, and it is NOT the
  // same as zero. The earlier spelling fell back to `edges.length` and claimed
  // `unreadable` reported it — but `unreadable` only counts rows that failed to
  // NARROW, and a row whose `scoped_total` drifts to a non-number narrows fine.
  // So with 500 visible edges the pane rendered `scoped: 200, withheld: 300,
  // countsConsistent: true`: a page cap presented to the approver as a hard ACL
  // fact, with no server-side trace. That is the "truncation dressed as an ACL
  // boundary" `BlastRadiusSide` forbids by name, produced here by its own
  // fallback.
  //
  // Now the drift is its OWN signal: logged, and reported through
  // `scopedTotalKnown` so `loadInForceVocabulary` can clear `countsConsistent`
  // rather than compute a withheld count against a number nobody read.
  if (scopedTotal === null && rows.length > 0) {
    log.warn(
      { workspaceId: ctx.workspaceId, position, rows: rows.length, requestId: opts.requestId },
      "brain vocabulary in-force: the scoped-total window value did not arrive — the withheld count for this position cannot be trusted and is reported inconsistent",
    );
  }

  return {
    position,
    edges,
    // From the window function, so it survives the page cap.
    scopedTotal: scopedTotal ?? edges.length,
    scopedTotalKnown: scopedTotal !== null || rows.length === 0,
    truncated: rows.length > IN_FORCE_PAGE_MAX || unreadable > 0,
    decision: visible.decision,
    aclDecision: visible.aclDecision,
  };
}

/**
 * Workspace-wide edge counts per position — content-free, and deliberately
 * UNSCOPED at every position including the entity ones.
 *
 * This is the half that makes `withheld` mean something. ADR-0037 §6: the
 * vocabulary is workspace-global, so its SIZE is not a secret even when its
 * contents are. A count carries no norm, no surface and no pair — it is the same
 * disclosure class `/oversight` already ships (#4825), which counts every fact
 * in the workspace regardless of reader precisely so an admin can tell a clean
 * queue from a hidden backlog.
 */
async function loadEdgeTotals(
  db: InForceReader,
  workspaceId: string,
): Promise<{ totals: Map<SlotPosition, number>; unreadable: number }> {
  const totals = new Map<SlotPosition, number>();
  if (!workspaceId) return { totals, unreadable: 0 };
  const { rows } = await db.query(
    `SELECT slot_position, COUNT(*)::int AS n
       FROM brain_vocabulary_edge
      WHERE workspace_id = $1
      GROUP BY slot_position`,
    [workspaceId],
  );
  let unreadable = 0;
  for (const raw of rows) {
    if (typeof raw !== "object" || raw === null) {
      unreadable += 1;
      continue;
    }
    const row = raw as Record<string, unknown>;
    const position = SLOT_POSITIONS.find((p) => p === row.slot_position);
    if (position === undefined || typeof row.n !== "number") {
      // ⚠️ COUNTED, not skipped. The consumer reads a missing total as `0`, and
      // for a reader scoped to no rows that yields `total: 0, scoped: 0,
      // withheld: 0, consistent: true` — the pane saying "nothing is withheld
      // from you" *because the count query's row did not narrow*, in the one
      // case where the withheld number is the whole point. The count survives
      // as unknown rather than as zero.
      unreadable += 1;
      continue;
    }
    totals.set(position, row.n);
  }
  if (unreadable > 0) {
    log.warn(
      { workspaceId, unreadable },
      "brain vocabulary in-force: workspace-wide edge totals would not narrow — the withheld counts they feed are reported inconsistent rather than as zero",
    );
  }
  return { totals, unreadable };
}

/**
 * The curated cardinalities, at the predicate position's unscoped arm.
 *
 * The surface is resolved through the SAME scope clause the picker and the edge
 * pane use, so "which claims count" has one answer across the whole surface.
 * `status = 'approved'` only: a pending row is a proposal and belongs to child
 * 3's queue, and showing one here would report a predicate as shaping identity
 * when `cardinalitySingleSql` — the one live read — filters it out.
 */
async function loadCardinalities(
  db: InForceReader,
  ctx: BrainPrincipalContext,
  opts: { readonly requestId?: string },
): Promise<{
  rows: readonly InForceCardinality[];
  truncated: boolean;
  total: number;
  totalKnown: boolean;
  /** Entries this reader may see, BEFORE the page cap. */
  scopedTotal: number;
  scopedTotalKnown: boolean;
  decision: PositionalDecision;
}> {
  const scope = positionalScopeClause("predicate", ctx, {
    paramIndex: 1,
    alias: "vf",
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  // The workspace-wide count runs even on the DENIED path, and that is the
  // point: it is content-free, and it is what lets the empty state say "there
  // are N you cannot see" instead of asserting the workspace has none.
  const total = await loadCardinalityTotal(db, ctx.workspaceId);
  if (scope.decision === "deny-all") {
    return {
      rows: [],
      truncated: false,
      total: total.n,
      totalKnown: total.known,
      // A denied reader genuinely sees zero — an answer, not a drift.
      scopedTotal: 0,
      scopedTotalKnown: true,
      decision: scope.decision,
    };
  }

  const params: unknown[] = [...scope.params, ctx.workspaceId, IN_FORCE_PAGE_MAX + 1];
  const wsParam = scope.nextParamIndex;
  const limitParam = wsParam + 1;

  const { rows } = await db.query(
    // The surface is read through a LATERAL over the scoped live set, keyed on
    // the cardinality row's predicate key. The key therefore stays inside the
    // join and never reaches the projection — `keys-not-on-the-wire.test.ts`
    // reads projection spans, and this statement's is surfaces and counts.
    `SELECT c.cardinality,
            c.source_class,
            c.proposed_by,
            c.reviewed_by,
            c.reviewed_at::text AS reviewed_at,
            s.predicate_surface,
            COALESCE(s.claims, 0)::int AS claims,
            COUNT(*) OVER ()::int AS scoped_total
       FROM brain_predicate_cardinality c
       LEFT JOIN LATERAL (
         SELECT mode() WITHIN GROUP (ORDER BY vf.predicate) AS predicate_surface,
                COUNT(*)::int AS claims
           FROM brain_facts vf
          WHERE ${scope.sql} AND vf.predicate_key = c.predicate_key
       ) s ON TRUE
      WHERE c.workspace_id = $${wsParam}
        AND c.status = 'approved'
      ORDER BY c.reviewed_at DESC NULLS LAST, c.cardinality
      LIMIT $${limitParam}`,
    params,
  );

  const out: InForceCardinality[] = [];
  let unreadable = 0;
  let scopedTotal: number | null = null;
  for (const raw of rows.slice(0, IN_FORCE_PAGE_MAX)) {
    if (typeof raw !== "object" || raw === null) {
      unreadable += 1;
      continue;
    }
    const row = raw as Record<string, unknown>;
    // Narrowed to the two-member vocabulary rather than to `string`. A drifted
    // value is COUNTED and logged like every other unreadable row in this
    // module — not allowed through to fail the wire schema, which would take the
    // whole pane down as a 500 over one bad row. `cardinality.ts` reads the same
    // value as `multi` with a warn; this is that posture, one layer up.
    if (row.cardinality !== "single" && row.cardinality !== "multi") {
      unreadable += 1;
      continue;
    }
    if (typeof row.scoped_total === "number") scopedTotal = row.scoped_total;
    out.push({
      predicateSurface:
        typeof row.predicate_surface === "string" ? row.predicate_surface : null,
      cardinality: row.cardinality,
      sourceClass: typeof row.source_class === "string" ? row.source_class : "",
      proposedBy: typeof row.proposed_by === "string" ? row.proposed_by : "",
      reviewedBy: typeof row.reviewed_by === "string" ? row.reviewed_by : null,
      reviewedAt: typeof row.reviewed_at === "string" ? row.reviewed_at : null,
      claims: typeof row.claims === "number" ? row.claims : 0,
    });
  }
  if (unreadable > 0) {
    // ⚠️ Its two sibling loaders in this module both count and log dropped rows;
    // this one did neither, and it is the one where a drop hurts most. A dropped
    // cardinality entry is a predicate curated `single` — arming retroactive
    // supersession for every future claim in its slot — that the pane denies
    // exists, and therefore that nobody can un-curate from the product.
    log.warn(
      { workspaceId: ctx.workspaceId, unreadable, requestId: opts.requestId },
      "brain vocabulary in-force: curated-cardinality rows would not narrow and were dropped — entries are arming supersession that this pane is not showing",
    );
  }
  if (scopedTotal === null && rows.length > 0) {
    log.warn(
      { workspaceId: ctx.workspaceId, rows: rows.length, requestId: opts.requestId },
      // Matches the sibling edge warn's wording. The earlier text said the count
      // was reported inconsistent "rather than computed against a page length" —
      // but it is BOTH: the fallback below is `out.length`. An operator reading
      // that would not go looking for the wrong number the badge is rendering.
      "brain vocabulary in-force: the curated-predicate scoped-total window value did not arrive — the withheld count for curated predicates cannot be trusted and is reported inconsistent",
    );
  }

  return {
    rows: out,
    truncated: rows.length > IN_FORCE_PAGE_MAX || unreadable > 0,
    total: total.n,
    totalKnown: total.known,
    scopedTotal: scopedTotal ?? out.length,
    scopedTotalKnown: scopedTotal !== null || rows.length === 0,
    decision: scope.decision,
  };
}

/**
 * Approved cardinality entries in the workspace — a count, never content.
 *
 * `/oversight`'s disclosure class (#4825): no predicate, no surface, no key.
 * `known` distinguishes "there are none" from "the count did not narrow", for
 * `loadEdgeTotals`' reason — a total silently read as zero produces the
 * "nothing is withheld from you" this accounting exists to refuse.
 */
async function loadCardinalityTotal(
  db: InForceReader,
  workspaceId: string,
): Promise<{ n: number; known: boolean }> {
  if (!workspaceId) return { n: 0, known: true };
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM brain_predicate_cardinality
      WHERE workspace_id = $1 AND status = 'approved'`,
    [workspaceId],
  );
  const raw = rows[0];
  const row: Record<string, unknown> | undefined =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : undefined;
  if (typeof row?.n !== "number") {
    log.warn(
      { workspaceId },
      "brain vocabulary in-force: the curated-predicate total did not narrow — reported as unknown rather than as zero",
    );
    return { n: 0, known: false };
  }
  return { n: row.n, known: true };
}

// ---------------------------------------------------------------------------
// The empty state's coverage numbers
// ---------------------------------------------------------------------------

/**
 * What the empty state needs to be a COVERAGE STATEMENT rather than a
 * congratulation.
 *
 * ⚠️ **Never "you're all caught up."** There is no caught-up state for a
 * vocabulary — only what has been decided and what has not yet been observed.
 * Empty is the PRIMARY state for a while, and it is empty for a reason the
 * surface can state exactly: `#5034`'s producer fires only on claims with a
 * non-null `object_cmp`, and *"on day one it returns zero rows"*. Cardinality
 * needs three corrections. Direct authoring works from day one and is, per T7
 * §6, the only route by which #5000's own entry is ever written.
 *
 * So *"No proposals — you're all caught up!"* would be **false in the way that
 * matters**: it reports nothing-to-do on the surface whose day-one job is the
 * thing only a human can do. Same failure mode as the M1 dogfood, where the sync
 * reported green because the flag was on and only a row count separated that
 * from a source never connected.
 *
 * {@link comparableFacts} is the number that turns a dead page into a legible
 * one — *"the structural proposer only fires on claims with comparable objects;
 * 0 of your 47 facts currently qualify."*
 */
export interface VocabularyCoverage {
  /** Live claims in the workspace, workspace-wide and content-free. */
  readonly liveFacts: number;
  /** Of those, how many carry a non-null `object_cmp` — the proposer's input. */
  readonly comparableFacts: number;
  /** Proposals awaiting a decision. Child 3 renders them; this counts them. */
  readonly pendingProposals: number;
  /** Cardinality proposals awaiting a decision. */
  readonly pendingCardinalities: number;
}

export async function loadVocabularyCoverage(
  db: InForceReader,
  workspaceId: string,
): Promise<VocabularyCoverage> {
  const zero: VocabularyCoverage = {
    liveFacts: 0,
    comparableFacts: 0,
    pendingProposals: 0,
    pendingCardinalities: 0,
  };
  if (!workspaceId) return zero;

  // Unscoped and content-free, `/oversight`'s class (#4825): counts only, no
  // claim, no episode, no provenance. An approver has to be able to tell an
  // empty queue from a hidden backlog before concluding there is nothing to do,
  // and that is the entire failure mode this surface's empty state exists to
  // avoid.
  const { rows } = await db.query(
    `SELECT
       (SELECT COUNT(*)::int FROM brain_facts
         WHERE workspace_id = $1 AND invalidated_at IS NULL AND valid_to IS NULL) AS live_facts,
       (SELECT COUNT(*)::int FROM brain_facts
         WHERE workspace_id = $1 AND invalidated_at IS NULL AND valid_to IS NULL
           AND object_cmp IS NOT NULL) AS comparable_facts,
       (SELECT COUNT(*)::int FROM brain_vocabulary_proposal
         WHERE workspace_id = $1 AND status = 'pending') AS pending_proposals,
       (SELECT COUNT(*)::int FROM brain_predicate_cardinality
         WHERE workspace_id = $1 AND status = 'pending') AS pending_cardinalities`,
    [workspaceId],
  );
  const raw = rows[0];
  if (typeof raw !== "object" || raw === null) {
    // REPORTED, not silently zeroed. Every number here is load-bearing prose on
    // the empty state, and "0 of your 0 facts qualify" is a sentence that reads
    // as an answer while meaning the query did not run.
    log.warn(
      { workspaceId },
      "brain vocabulary coverage: the count query returned no usable row — the empty state will understate what exists",
    );
    return zero;
  }
  const row = raw as Record<string, unknown>;
  // Per-COLUMN drift is logged too, not just the missing row. Every number here
  // is load-bearing prose on the empty state, and "0 of your 0 live claims
  // currently qualify" reads as an answer while meaning the query did not run —
  // which is the sentence the no-row branch above already refuses to produce
  // silently, reachable one column at a time.
  const unreadable = ["live_facts", "comparable_facts", "pending_proposals", "pending_cardinalities"]
    .filter((column) => typeof row[column] !== "number");
  if (unreadable.length > 0) {
    log.warn(
      { workspaceId, unreadable },
      "brain vocabulary coverage: some counts would not narrow and are reported as zero — the empty state will understate what exists",
    );
  }
  const n = (value: unknown): number => (typeof value === "number" ? value : 0);
  return {
    liveFacts: n(row.live_facts),
    comparableFacts: n(row.comparable_facts),
    pendingProposals: n(row.pending_proposals),
    pendingCardinalities: n(row.pending_cardinalities),
  };
}
