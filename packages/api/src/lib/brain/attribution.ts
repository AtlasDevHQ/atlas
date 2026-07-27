/**
 * Whether a reader is entitled to a fact's provenance ATTRIBUTION — who stated
 * the claim first, where, and when (#4836, ADR-0036 §T5).
 *
 * ## The disclosure this closes
 *
 * #4823 publishes a draft fact with the union of its own grant and every
 * grammar-valid principal named by the episodes on its `provenance` edges. That
 * is right for the CLAIM: a reader gained by widening was, by construction,
 * already told the claim somewhere else.
 *
 * It is wrong for the fact's PROVENANCE. ADR-0036 §T5 has provenance ride the
 * fact's grant, and a fact's provenance names its FIRST episode — for Slack
 * `sourceId` is `<channelId>:<ts>`. So a claim first stated in a private
 * channel and later restated publicly publishes as
 * `{audience:chat-channel:slack:<id>, org}` and would then tell every org member who
 * said it first, in which private channel, and when. That is private-channel
 * membership, which is precisely what the `audience:` grant model exists to
 * protect, and it is not derivable from the claim the reader already had.
 *
 * This module is the whole narrowing. It answers ONE question, and the answer
 * is the third argument to `projectProvenance`.
 *
 * ## Why the ORIGINAL grant is the right predicate
 *
 * The readers entitled to attribution are exactly the readers who could see the
 * fact BEFORE it widened — for them nothing changed, and degrading attribution
 * for everyone would make the review surface worse for the people who actually
 * need it (#4836 refuses that explicitly). "Before it widened" is a fact about
 * the past, so it has to be read from the past: `brain_facts.pre_widening_visible_to`
 * (migration 0183), written by `WIDEN_AND_PROMOTE_FACTS_SQL` on the same UPDATE
 * that overwrites `visible_to`.
 *
 * Re-deriving it from today's evidence edges would be the obvious-looking
 * alternative and is wrong twice over: the widening UPDATE keeps the
 * `status = 'draft'` PREDICATE, so evidence arriving after publish never
 * re-opened the grant — a derivation would drift from what actually shipped — and
 * it would put a multi-row query on the retrieval hot path to answer a question
 * one column already answers.
 *
 * ## Three input states, and only one of them discloses
 *
 * **SQL NULL** means NEVER WIDENED and discloses. That is not a fallback: a
 * fact whose grant was never widened has no reader who gained access through
 * widening, so every reader of it is an original reader.
 *
 * **`undefined`** means the column was not in the SELECT — `pg` never produces
 * it for a column a query asked for. Entitlement is unknown, so it withholds
 * and logs. Keeping it distinct from NULL is the point: the required third
 * argument to `projectProvenance` forces a new read surface to ask the
 * question, but nothing forces it to select the column, and collapsing the two
 * would hand that surface silent full disclosure.
 *
 * **A non-array** is drift and withholds. The column is `text[]`, so this is
 * unreachable from the database; unknown entitlement on an ACL boundary is a
 * deny.
 *
 * ## One residual, stated rather than papered over
 *
 * A fact widened BEFORE migration 0183 has NULL here and discloses, because
 * its pre-widening grant was overwritten and is genuinely gone. That is an
 * accepted residual, not a correctness claim — see 0183's own header. It is
 * survivable only because brain extraction is staging-only today (#4836); once
 * a customer is onboarded there is no equivalent escape.
 *
 * ## What this deliberately does not model
 *
 * The audit override. {@link isVisibleTo} does not model it either (see its
 * comment), so an override read — none exists on any brain surface today —
 * would take the withheld arm. That is the safe direction and it is stated
 * rather than assumed: if an override read is ever added, disclosing
 * attribution under it is a decision to make HERE, deliberately, not a
 * behaviour to inherit by accident.
 */

import { isVisibleTo, isUnknownArray, type BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("brain-attribution");

/**
 * The single input `projectProvenance` takes for the ACL half of its work.
 *
 * A closed two-value union rather than a boolean, because `projectProvenance`
 * already takes a `string | null | undefined` and a `boolean` would sit next to
 * them unnamed at every call site — `projectProvenance(p, id, false)` reads as
 * plausibly "not complete" or "not provisional". `"withhold"` cannot.
 */
export type BrainAttributionDecision = "disclose" | "withhold";

/**
 * A fact row, in the DATABASE's vocabulary rather than the wire's.
 *
 * Snake_case on purpose. Both read surfaces already hold a row of exactly this
 * shape off `pg` (`FactRow` in `candidates.ts` and in `search.ts`), so taking
 * it structurally means the column is INTERPRETED once — here, in the module
 * that owns the decision. A per-call-site adapter would reintroduce the hazard
 * this shape prevents: `{ preWideningVisibleTo: row.visible_to }` type-checks,
 * and it discloses to everybody.
 *
 * Each read surface still has to NAME the column in its own SELECT and row
 * type. Nothing at compile time forces that — which is exactly what the
 * `undefined` arm of {@link attributionDecision} exists to catch.
 */
export interface AttributionRow {
  /** `brain_facts.id`, for the drift log lines. */
  readonly id: string;
  /**
   * `brain_facts.pre_widening_visible_to`.
   *
   * `null` is SQL NULL — never widened. `undefined` is a DIFFERENT fact about
   * the world: `pg` produces it only when the column was absent from the
   * SELECT, so it means the query drifted, not that the fact is unwidened.
   * The two are handled separately for that reason; see
   * {@link attributionDecision}.
   */
  readonly pre_widening_visible_to: unknown;
}

/**
 * May this reader see the fact's first-episode attribution?
 *
 * Adds no query — the caller already holds the row — which is what lets it sit
 * on the `searchBrain` hot path.
 *
 * ## Two things this does NOT do, stated because both look like they do
 *
 * **It is not tenant containment.** The row's workspace is taken from `ctx`,
 * so {@link isVisibleTo}'s cross-workspace arm is inert here and cannot fire.
 * Containment rests entirely on the caller: every row reaching this function
 * came back from a workspace-scoped, ACL-gated SELECT against `brain_facts`.
 * `isVisibleTo` is used for its GRANT-MATCH arm only — specifically so role
 * implication and audience matching agree byte-for-byte with the push-down
 * predicate rather than being re-derived here.
 *
 * **It is not pure.** It logs on both drift arms, and `isVisibleTo` logs on
 * three of its own four denies — the ordinary no-overlap deny is deliberately
 * silent, and from THIS caller only two of the logging arms are reachable at
 * all (`ctx.workspaceId` pre-empts the cross-workspace arm, the
 * `isUnknownArray` guard above pre-empts the non-array one). `acl.ts` warns that its zero-principal warn is
 * per-reader and would repeat per row in a loop; that is unreachable from the
 * two read surfaces, which throw `BrainReaderUnresolvedError` on `deny-all`
 * before any row is projected. The per-row cost is bounded for a second
 * reason: NULL short-circuits above, so only WIDENED facts — rare by
 * construction — reach `isVisibleTo` at all.
 */
export function attributionDecision(
  row: AttributionRow,
  ctx: BrainPrincipalContext,
  requestId?: string,
): BrainAttributionDecision {
  const grant = row.pre_widening_visible_to;

  // SQL NULL — the common case by a wide margin. Nothing widened, so nobody
  // reached this fact through widening.
  if (grant === null) return "disclose";

  // NOT the same as NULL, and conflating them was the fail-open this module
  // most had to avoid. `pg` never yields `undefined` for a column it selected,
  // so this means the column is missing from the projection — a new read
  // surface, a rewritten SELECT, a row object built by hand. The required
  // third argument to `projectProvenance` forces a new surface to ASK the
  // question; nothing forces it to select the column, so this is where that
  // omission has to be caught. Entitlement is unknown, so it is a deny.
  if (grant === undefined) {
    log.warn(
      { workspaceId: ctx.workspaceId, rowId: row.id, origin: ctx.origin, requestId },
      "brain attribution: `pre_widening_visible_to` absent from the row — the query does not select it, so a widened fact would read as never-widened; withholding provenance attribution",
    );
    return "withhold";
  }

  if (!isUnknownArray(grant)) {
    log.warn(
      {
        workspaceId: ctx.workspaceId,
        rowId: row.id,
        origin: ctx.origin,
        requestId,
        actualType: typeof grant,
      },
      "brain attribution: `pre_widening_visible_to` did not decode as an array — withholding provenance attribution rather than guessing entitlement",
    );
    return "withhold";
  }

  return isVisibleTo(
    { table: "brain_facts", workspaceId: ctx.workspaceId, visibleTo: grant },
    ctx,
  )
    ? "disclose"
    : "withhold";
}
