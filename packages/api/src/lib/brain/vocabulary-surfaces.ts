/**
 * The authoring PICKER — what an approver may choose between, and the refusal
 * that keeps them from choosing something that does not exist (#5087,
 * ADR-0037 §6 + #5025's 2026-08-07 grill).
 *
 * ## Why authoring is a picker and never a norm text box
 *
 * An alias is a pair of NORMS, and `lexicalNorm` is ASCII-only case folding
 * with a specific separator class. A human typing `499 a month` vs `499 A Month`
 * vs `499-a-month` cannot reliably predict what the pipeline produced — and a
 * wrong guess authors an edge whose `from_norm` **no fact has ever produced**.
 *
 * That failure is not loud. The edge inserts cleanly (0189 enforces
 * non-emptiness and the 1-cycle, not normal form, and says so). The closure
 * recomputes. The drift re-key runs and moves zero rows, which
 * `rekeyDriftedFacts` logs as the ordinary case because a first alias in an
 * empty slot legitimately moves none. The blast-radius preview reads `0`. Every
 * signal the surface has says *success*.
 *
 * And it lands exactly where it hurts most. Per T7 §6, **#5000's own entry is
 * authored here and nowhere else** — the structural proposer provably cannot
 * propose it, and that zero is pinned by `alias-proposal-corpus.ts`'s
 * `prod-5000-pair` case (`proposes: []`), exercised by `alias-proposal-pg.test.ts`
 * and therefore SKIPPED without `TEST_DATABASE_URL`. (Not `alias-proposal.test.ts`
 * — that file uses the same norms as fixtures for proposals that DO fire.) So
 * the one path to closing the arc's originating bug is also the one whose
 * failure mode is indistinguishable from success.
 *
 * Two mechanisms, and they are different in kind rather than redundant:
 *
 *   1. {@link loadObservedSurfaces} offers only norms the corpus has actually
 *      produced, with the resolved norm DISPLAYED beside the surfaces that
 *      produced it, so the merge is visible before it is decided. Free text
 *      filters that list; it never supplies a value.
 *   2. {@link loadPairPopulation} re-asks the question server-side at the write.
 *      A picker is a UI affordance and the route takes JSON — the refusal is
 *      what makes the rule hold for a caller that never rendered a picker.
 *
 * ## The accepted cost, recorded rather than rediscovered
 *
 * You cannot pre-author an alias for a spelling you expect later. The grill
 * calls this *correct rather than merely tolerable*: a vocabulary decision with
 * no population is unfalsifiable and rots silently — nothing downstream will
 * ever disagree with it, so nothing will ever surface that it was wrong.
 *
 * ## Scoping
 *
 * Both reads go through `vocabulary-visibility.ts`'s
 * {@link positionalScopeClause}, which is the seam #5087 owns. That is not
 * merely reuse: it means the picker offers exactly the population the *In force*
 * pane will later scope by, so an approver cannot author an entity edge from
 * evidence they can see and then be unable to see the edge it produced.
 */

import { createLogger } from "@atlas/api/lib/logger";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import {
  SLOT_COLUMNS,
  lexicalNorm,
  lexicalNormSql,
  type SlotPosition,
} from "@atlas/api/lib/brain/identity";
import {
  positionalScopeClause,
  type PositionalDecision,
} from "@atlas/api/lib/brain/vocabulary-visibility";

const log = createLogger("brain-vocabulary-surfaces");

/** The reader this module needs. Satisfied by the internal pool. */
export interface VocabularySurfaceReader {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: readonly unknown[] }>;
}

/** Most norms one picker page offers. */
export const OBSERVED_SURFACE_PAGE_MAX = 100;

/** Longest `?q=` filter honoured. Matches `admin-brain-facts.ts`'s own bound. */
export const SURFACE_FILTER_MAX_CHARS = 200;

/**
 * One norm the corpus has actually produced at a position.
 *
 * ## Grouped by NORM, not by surface, and the count is the norm's
 *
 * The obvious shape is one row per distinct surface. It is wrong for the
 * decision being made: an alias merges NORMS, so `Priced At` and `priced at` are
 * already one choice, and offering them as two rows with two smaller counts
 * invites an approver to reason about a population that is not the one their
 * approval moves. Grouping by norm makes the count the number the blast radius
 * will be about.
 *
 * {@link variants} is what keeps the folding visible rather than merely
 * performed — *"3 spellings"* beside a norm is the evidence that `lexicalNorm`
 * did something, which is the whole reason the resolved norm is displayed.
 */
export interface ObservedSurface {
  /**
   * The norm — the value an authoring request must carry.
   *
   * ⚠️ Not a key. `keys-not-on-the-wire.test.ts` forbids projecting a key beside
   * its claim; a norm is what `brain_vocabulary_edge` has stored since 0189 and
   * what `approveAliasEdge` takes, because a reviewer approving a merge has to
   * be shown which two spellings merge. That distinction is settled design
   * (ADR-0037 §6) and `CONTEXT.md` pins surface / norm / key as three
   * non-interchangeable levels.
   */
  readonly norm: string;
  /**
   * The most common surface that produced it — what a human recognises.
   *
   * `mode()` rather than `min()`: an approver scanning the list should see the
   * spelling their corpus mostly uses, not the alphabetically first one, and the
   * two differ exactly when the folding is doing something interesting.
   */
  readonly exampleSurface: string;
  /** Live claims at this position whose surface norms to {@link norm}. */
  readonly claims: number;
  /** Distinct surfaces folding into it. `1` means the norm is the spelling. */
  readonly variants: number;
}

export interface ObservedSurfacePage {
  readonly position: SlotPosition;
  readonly surfaces: readonly ObservedSurface[];
  /**
   * The corpus has more norms than the page shows.
   *
   * Reported rather than silently cut, and it is the line that tells an
   * approver to type a filter instead of concluding their spelling is absent —
   * which is the conclusion that sends them looking for a text box.
   */
  readonly truncated: boolean;
  /** Which arm of the positional rule scoped this list. */
  readonly decision: PositionalDecision;
}

interface ObservedRow {
  readonly norm: string;
  readonly example_surface: string;
  readonly claims: number;
  readonly variants: number;
}

/**
 * The norms present at one position, most-used first.
 *
 * `filter` is matched against the SURFACE (case-insensitively) and against the
 * norm, because a human types what they remember reading. It narrows the list
 * and can never introduce a value: every row still comes from `brain_facts`.
 */
export async function loadObservedSurfaces(
  db: VocabularySurfaceReader,
  ctx: BrainPrincipalContext,
  request: {
    readonly position: SlotPosition;
    readonly filter?: string;
    readonly limit?: number;
    readonly requestId?: string;
  },
): Promise<ObservedSurfacePage> {
  const { position } = request;
  const scope = positionalScopeClause(position, ctx, {
    paramIndex: 1,
    alias: "vf",
    requestId: request.requestId,
  });
  if (scope.decision === "deny-all") {
    // Not a throw. A denied reader gets an EMPTY picker and the authoring
    // refusal below will then name the empty side — which is the honest pair of
    // answers. Throwing here would turn "you may not see this workspace's
    // claims" into a 500 on a page whose other half (the unscoped counts) is
    // still legitimately readable.
    return { position, surfaces: [], truncated: false, decision: scope.decision };
  }

  const params: unknown[] = [...scope.params];
  let next = scope.nextParamIndex;

  const { surface } = SLOT_COLUMNS[position];
  const normExpr = lexicalNormSql(`vf.${surface}`);

  // Bounded BEFORE it is bound. An unbounded `ILIKE` pattern is a scan the
  // reader controls the cost of, and `admin-brain-facts.ts` clamps its own `?q=`
  // for the same reason.
  const filter = (request.filter ?? "").trim().slice(0, SURFACE_FILTER_MAX_CHARS);
  let filterSql = "";
  if (filter !== "") {
    // `ILIKE` with the pattern's own metacharacters ESCAPED. Without this a `%`
    // typed into the box matches everything and a `_` matches any character —
    // which does not leak (the scope clause is already AND-ed) but does make the
    // filter silently mean something other than what was typed, on the one
    // control whose entire job is to narrow rather than to supply.
    const escaped = filter.replace(/([\\%_])/g, "\\$1");
    params.push(`%${escaped}%`);
    filterSql = ` AND (vf.${surface} ILIKE $${next} ESCAPE '\\' OR ${normExpr} ILIKE $${next} ESCAPE '\\')`;
    next += 1;
  }

  // `+ 1` so overrun is DETECTED rather than assumed — the page is sliced back
  // to `limit` below and `truncated` reports the difference.
  const limit = clampLimit(request.limit);
  params.push(limit + 1);
  const limitParam = next;

  const { rows } = await db.query(
    `WITH observed AS (
       SELECT vf.${surface} AS surface, ${normExpr} AS norm
         FROM brain_facts vf
        WHERE ${scope.sql}${filterSql}
     )
     SELECT norm,
            mode() WITHIN GROUP (ORDER BY surface) AS example_surface,
            COUNT(*)::int AS claims,
            COUNT(DISTINCT surface)::int AS variants
       FROM observed
      WHERE norm <> ''
      GROUP BY norm
      ORDER BY COUNT(*) DESC, norm
      LIMIT $${limitParam}`,
    params,
  );

  const surfaces: ObservedSurface[] = [];
  let unreadable = 0;
  for (const raw of rows.slice(0, limit)) {
    const row = narrowObserved(raw);
    if (row === undefined) {
      unreadable += 1;
      continue;
    }
    surfaces.push({
      norm: row.norm,
      exampleSurface: row.example_surface,
      claims: row.claims,
      variants: row.variants,
    });
  }
  if (unreadable > 0) {
    // DROPPED rows are logged, never absorbed. A norm silently missing from the
    // picker is a norm an approver concludes does not exist — and the conclusion
    // that follows is "I will type it", which is the exact affordance this
    // module removes.
    log.warn(
      { workspaceId: ctx.workspaceId, position, unreadable, requestId: request.requestId },
      "brain vocabulary picker: rows would not narrow and were dropped — the offered list is smaller than the corpus",
    );
  }

  return {
    position,
    surfaces,
    truncated: rows.length > limit || unreadable > 0,
    decision: scope.decision,
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return OBSERVED_SURFACE_PAGE_MAX;
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  return Math.min(floored, OBSERVED_SURFACE_PAGE_MAX);
}

/** Narrow one raw row, or `undefined` — never cast-and-dereference. */
function narrowObserved(raw: unknown): ObservedRow | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const row = raw as Record<string, unknown>;
  if (typeof row.norm !== "string" || row.norm === "") return undefined;
  // `mode()` returns NULL only for an empty group, which `GROUP BY` cannot
  // produce — so a non-string here means the projection drifted, not that the
  // corpus is odd.
  if (typeof row.example_surface !== "string") return undefined;
  if (typeof row.claims !== "number" || typeof row.variants !== "number") return undefined;
  return {
    norm: row.norm,
    example_surface: row.example_surface,
    claims: row.claims,
    variants: row.variants,
  };
}

/** One side's live population. */
export interface SidePopulation {
  readonly norm: string;
  readonly claims: number;
}

/**
 * Both sides of a proposed pair, from ONE statement.
 *
 * One statement, not two, and that is the same decision `loadClaimVocabulary`
 * records: two counting statements can straddle a concurrent write, so a pair
 * could be refused for an emptiness that never held at any single instant. Here
 * the two counts come from one snapshot by construction.
 */
export interface PairPopulation {
  readonly from: SidePopulation;
  readonly to: SidePopulation;
  readonly decision: PositionalDecision;
}

export async function loadPairPopulation(
  db: VocabularySurfaceReader,
  ctx: BrainPrincipalContext,
  request: {
    readonly position: SlotPosition;
    readonly fromNorm: string;
    readonly toNorm: string;
    readonly requestId?: string;
  },
): Promise<PairPopulation> {
  // Re-normed here too. Every other seam in this subsystem does it
  // (`approveAliasEdge`, `proposeAliasEdge`), and skipping it would make the
  // population check ask about a string the write path will not use — i.e. it
  // would answer confidently about the wrong norm, which is the failure this
  // whole module exists to prevent.
  const fromNorm = lexicalNorm(request.fromNorm);
  const toNorm = lexicalNorm(request.toNorm);

  const scope = positionalScopeClause(request.position, ctx, {
    paramIndex: 1,
    alias: "vf",
    requestId: request.requestId,
  });
  if (scope.decision === "deny-all") {
    return {
      from: { norm: fromNorm, claims: 0 },
      to: { norm: toNorm, claims: 0 },
      decision: scope.decision,
    };
  }

  const params: unknown[] = [...scope.params, fromNorm, toNorm];
  const fromParam = scope.nextParamIndex;
  const toParam = scope.nextParamIndex + 1;

  const { surface } = SLOT_COLUMNS[request.position];
  const normExpr = lexicalNormSql(`vf.${surface}`);

  const { rows } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE norm = $${fromParam})::int AS from_claims,
            COUNT(*) FILTER (WHERE norm = $${toParam})::int AS to_claims
       FROM (SELECT ${normExpr} AS norm FROM brain_facts vf WHERE ${scope.sql}) s`,
    params,
  );

  const raw = rows[0];
  const row: Record<string, unknown> | undefined =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : undefined;
  // NOT defaulted to zero on an unreadable row, and not defaulted to a
  // permissive number either. Zero REFUSES the authoring, which is the
  // fail-closed direction: a refusal an approver can retry costs a page load,
  // where an admitted edge whose population was never actually observed is the
  // silent-success failure this module exists to prevent.
  const fromReadable = typeof row?.from_claims === "number";
  const toReadable = typeof row?.to_claims === "number";
  const fromClaims = fromReadable ? (row!.from_claims as number) : 0;
  const toClaims = toReadable ? (row!.to_claims as number) : 0;
  // BOTH sides checked, not just `from_claims`. A drifted `to_claims` alone
  // silently yielded 0 — which drives `emptySide` to `"to"` and tells the
  // approver `"<toNorm>" has no live claim at this position` when the corpus was
  // never actually asked. The fail-closed direction is right; the SILENCE was
  // the defect, and naming which side was unreadable is what separates "your
  // corpus is missing this spelling" from "we could not read the answer".
  if (!fromReadable || !toReadable) {
    log.warn(
      {
        workspaceId: ctx.workspaceId,
        position: request.position,
        requestId: request.requestId,
        fromReadable,
        toReadable,
        rowPresent: row !== undefined,
      },
      "brain vocabulary: the pair-population count returned no usable value — reading the unreadable side(s) as EMPTY, which refuses the authoring",
    );
  }

  return {
    from: { norm: fromNorm, claims: fromClaims },
    to: { norm: toNorm, claims: toClaims },
    decision: scope.decision,
  };
}

/**
 * Which side (or sides) has no population — `null` when both are populated.
 *
 * Named separately from the count so the REFUSAL MESSAGE can say which, which
 * is the falsifiable half of the AC: *"the refusal names which side is empty."*
 * A refusal that said only *"one side is empty"* would send an approver to
 * re-check the side that was fine.
 */
export type EmptySide = "from" | "to" | "both";

export function emptySide(population: PairPopulation): EmptySide | null {
  const fromEmpty = population.from.claims <= 0;
  const toEmpty = population.to.claims <= 0;
  if (fromEmpty && toEmpty) return "both";
  if (fromEmpty) return "from";
  if (toEmpty) return "to";
  return null;
}
