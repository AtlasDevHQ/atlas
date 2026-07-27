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
 * channel and later restated publicly published as
 * `{audience:chat-channel:slack:<id>, org}` and then told every org member who
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
 * alternative and is wrong twice over: the widening UPDATE keeps
 * `status = 'draft'`, so evidence arriving after publish never re-opened the
 * grant — a derivation would drift from the grant that actually shipped — and
 * it would put a multi-row query on the retrieval hot path to answer a question
 * one column already answers.
 *
 * ## Fail-closed, in the two directions that differ
 *
 * NULL means NEVER WIDENED and discloses. That is not a fallback: a fact whose
 * grant was never widened has no reader who gained access through widening, so
 * every reader of it is an original reader. It is also the pre-#4836 behaviour
 * for every already-published fact, which is correct for the same reason.
 *
 * A NON-NULL value that does not decode as an array is DRIFT, and withholds.
 * The column is `text[]`, so this is unreachable from the database; if it ever
 * happens the reader's entitlement is unknown, and unknown entitlement on an
 * ACL boundary is a deny.
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

/** A fact row's attribution inputs, as they arrive off `pg`. */
export interface AttributionRow {
  /** `brain_facts.id`, for the drift log line. */
  readonly factId: string;
  /** `brain_facts.pre_widening_visible_to` — `null` when never widened. */
  readonly preWideningVisibleTo: unknown;
}

/**
 * May this reader see the fact's first-episode attribution?
 *
 * Pure apart from one `log.warn` on the unreachable drift arm. The caller holds
 * the row already — this adds no query, which is why it can sit on the
 * `searchBrain` hot path.
 *
 * `ctx.workspaceId` is the containment boundary and is passed through to
 * {@link isVisibleTo} verbatim: the row came back from a workspace-scoped,
 * ACL-gated SELECT against `brain_facts`, so it is the reader's workspace by
 * construction, and `isVisibleTo` denies (and logs) if that ever stops being
 * true.
 */
export function attributionDecision(
  row: AttributionRow,
  ctx: BrainPrincipalContext,
): BrainAttributionDecision {
  const grant = row.preWideningVisibleTo;
  // The common case by a wide margin: nothing widened, so nobody reached this
  // fact through widening.
  if (grant === null || grant === undefined) return "disclose";

  if (!isUnknownArray(grant)) {
    log.warn(
      {
        workspaceId: ctx.workspaceId,
        rowId: row.factId,
        origin: ctx.origin,
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
