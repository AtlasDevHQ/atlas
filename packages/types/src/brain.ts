/**
 * Wire shapes for the company-brain fact review surface (#4772, ADR-0036).
 *
 * TYPES ONLY — no value exports. `@useatlas/types` is installed from the
 * registry by the `create-atlas` scaffold, so a new value export forces a
 * publish-first merge dance on every PR that uses it (see CLAUDE.md
 * § Publishing). The enum tuples these unions are built from stay in
 * `@useatlas/schemas`, which is private.
 *
 * These are a PROJECTION of the substrate types in
 * `packages/api/src/lib/brain/types.ts`, not a mirror of them. Three
 * differences are deliberate and load-bearing:
 *
 *   1. Every timestamp is an ISO-8601 `string`, not a `Date`.
 *   2. Provenance is FLATTENED and fully nullable. At rest it is `jsonb` with
 *      one writer and a named shape (`BrainFactProvenance`), but nothing
 *      enforces that shape in the database — so a reader that types it
 *      optimistically renders a blank field when a key is renamed. Nullable
 *      fields plus {@link BrainFactProvenanceView.payloadComplete} make the
 *      degradation visible instead.
 *   3. Anything the reader is not entitled to see is a DISCRIMINATED VARIANT
 *      that structurally cannot carry the payload, rather than an omitted
 *      field. Omission is indistinguishable from "the producer never wrote
 *      this"; the `visible: false` arm says "this exists and is being withheld
 *      from you", which is what a reviewer needs in order to abstain rather
 *      than approve blind. Making it a union rather than a boolean beside a row
 *      of nullables is the point: this is an ACL boundary, and the withheld
 *      shape must be incapable of holding the withheld data.
 */

import type { PublishRefusedDraft } from "./mode";

/** Which side of a subject-predicate-object claim an entity sits on. */
export type BrainEntityRole = "subject" | "object";

/** Content-mode lifecycle of a fact. Mirrors `BRAIN_FACT_STATUSES`. */
export type BrainFactReviewStatus = "draft" | "published" | "archived";

/**
 * The evidence trail attached to one claim, flattened for rendering.
 *
 * Sourced from `brain_facts.provenance`. `provisional` is written at rest ONLY
 * when true (so a reviewer's filter keys off presence, not value); here it is
 * a plain boolean because the wire has already done that narrowing.
 */
export interface BrainFactProvenanceView {
  /** Connector class of the evidence — `slack`, `warehouse`, `human`. */
  readonly source: string | null;
  /** The source's own stable id for the evidence. */
  readonly sourceId: string | null;
  readonly episodeId: string | null;
  /** The principal that asserted the claim. */
  readonly actor: string | null;
  /** What produced the candidate — `extraction:v1`, `write-back`, `human`. */
  readonly producer: string | null;
  readonly occurredAt: string | null;
  readonly extractedAt: string | null;
  readonly reconciledAt: string | null;
  /**
   * An entity resolver could not pin one or both sides of the claim, so it was
   * recorded against a provisional entity. THE quality queue — block-class
   * failures (no provenance, no usable grant, unattributable actor, malformed
   * claim) never reach this surface at all; they were refused upstream.
   *
   * Always true when {@link unresolved} is non-empty: at rest the flag and the
   * side-list are written together, but the flag is derived here rather than
   * trusted, so a payload carrying one without the other cannot present as
   * "resolved, but here are the unresolved sides".
   */
  readonly provisional: boolean;
  /** Which sides were left unresolved. Empty unless `provisional`. */
  readonly unresolved: readonly BrainEntityRole[];
  /**
   * False when the stored payload was missing a structural key, carried the
   * wrong type for one, or held an unparseable timestamp. The claim is still
   * reviewable — but a reviewer seeing an empty "Producer" needs to know
   * whether the producer wrote nothing or the payload drifted.
   */
  readonly payloadComplete: boolean;
}

/**
 * The episode a claim was extracted from — the bottom of the provenance chain,
 * when the reader is entitled to it.
 *
 * ## Entitlement here is NOT the fact's
 *
 * `brain_episodes` is ACL-gated in its own right, and its grant is derived
 * independently of the fact's. A claim extracted from a private channel can be
 * granted `org` while its evidence stays restricted to that channel's audience,
 * so a reviewer entitled to the CLAIM may not be entitled to the EVIDENCE.
 */
export interface BrainFactEpisodeVisible {
  readonly visible: true;
  readonly id: string;
  readonly source: string | null;
  readonly sourceId: string | null;
  readonly sourceActor: string | null;
  /** Body XOR locator — by-value for chat, by-reference for warehouse/KB. */
  readonly body: string | null;
  /** True when `body` was clipped for transport; the full text is at rest. */
  readonly bodyTruncated: boolean;
  readonly locator: string | null;
  readonly occurredAt: string | null;
  readonly ingestedAt: string | null;
}

/**
 * The evidence exists and is being withheld from this reader.
 *
 * Carries the id and nothing else — not as a convention the producer follows,
 * but because the variant has no other fields to carry.
 */
export interface BrainFactEpisodeWithheld {
  readonly visible: false;
  readonly id: string;
}

export type BrainFactEpisodeView = BrainFactEpisodeVisible | BrainFactEpisodeWithheld;

/**
 * Which end of the `in-tension-with` edge the counterpart sat on.
 *
 * `to` — the counterpart is the edge's target, i.e. THIS candidate was the
 * newer claim and the edge was written pointing at the counterpart.
 * `from` — the reverse: the counterpart is the newer claim.
 *
 * Reports the graph, not a verdict. Do not sort, rank, or style by it.
 */
export type BrainFactTensionDirection = "from" | "to";


/**
 * A claim this candidate is in advisory tension with — an `in-tension-with`
 * edge, written only for `single`-cardinality predicates.
 *
 * ADVISORY AND UNRANKED, by design. Nothing here says which side is right:
 * refusing to auto-arbitrate is the point, and arbitration is M2's (ADR-0036
 * §Temporal — supersession is not deletion).
 */
export interface BrainFactTensionVisible {
  readonly visible: true;
  readonly factId: string;
  readonly edgeDirection: BrainFactTensionDirection;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly status: BrainFactReviewStatus;
  readonly validFrom: string | null;
  readonly ingestedAt: string | null;
  /**
   * Set when the counterpart has been WITHDRAWN.
   *
   * Load-bearing: retraction never writes `status`, so a retracted rival still
   * reports whatever status it held before withdrawal — `draft` for a queue
   * candidate, `published` for one already promoted. Without this field the
   * reviewer cannot tell a live conflict from one somebody already resolved by
   * rejecting the other side. Retracted counterparts are still listed — a rival
   * that was withdrawn is still why this claim was contested — but they must be
   * labelled.
   */
  readonly invalidatedAt: string | null;
  readonly corroborationCount: number;
  readonly provenance: BrainFactProvenanceView;
}

/**
 * A conflicting claim this reader may not see.
 *
 * Reported rather than dropped: "this claim has a rival you cannot see" is
 * exactly the signal that should stop a reviewer approving it, and an omitted
 * row reads as "nothing contradicts this".
 */
export interface BrainFactTensionWithheld {
  readonly visible: false;
  readonly factId: string;
  readonly edgeDirection: BrainFactTensionDirection;
}

export type BrainFactTensionView = BrainFactTensionVisible | BrainFactTensionWithheld;

/**
 * A structural rule the atomic publish endpoint would refuse this claim on.
 *
 * A PRE-FLIGHT of `classifyFactForPromotion`, computed on read so the queue can
 * show the verdict before the reviewer publishes rather than after. `detail` is
 * the API's own actionable prose and is rendered verbatim — the reason
 * vocabulary can grow without a matching copy change in any surface.
 *
 * Derived from {@link PublishRefusedDraft} rather than restated, because it IS
 * that refusal seen one step earlier. #4156 exists because publish surfaces
 * that each invented their own spelling drifted; a fourth copy here would be
 * the same mistake. `id` / `surface` are dropped: the candidate already knows
 * which row and which table it is.
 *
 * `null` on a promotable candidate.
 */
export type BrainFactPromotionBlock = Pick<PublishRefusedDraft, "reasons" | "detail">;

/** One reviewable claim, with everything the reconcile stage attached. */
export interface BrainFactCandidate {
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly status: BrainFactReviewStatus;
  /** `single` supersedes on conflict; `multi` coexists and corroborates. */
  readonly predicateCardinality: "single" | "multi";
  /**
   * The derived grant, verbatim. A grant is never empty at rest, so `[]` here
   * means the column did not decode as an array — see {@link grantReadable}.
   */
  readonly visibleTo: readonly string[];
  /**
   * Indices into {@link visibleTo} whose token is outside the grant grammar
   * (`org`, `role:*`, `user:*`, `audience:*`). They grant nobody access.
   *
   * INDICES, not values. `parseGrant` normalizes every non-string element to
   * `""`, so matching by value would fail to highlight a `NULL` element — which
   * renders as the plausible-looking token `null` and is exactly the one a
   * reviewer must not mistake for a real grant.
   */
  readonly malformedGrantIndices: readonly number[];
  /**
   * False when `visible_to` did not arrive as an array at all — query drift,
   * not tenant data. Distinguished because an empty grant list otherwise reads
   * as "visible to nobody", which a reviewer would treat as harmless when the
   * claim may in fact be org-wide.
   */
  readonly grantReadable: boolean;
  /**
   * DISTINCT `provenance` edges (fact → episode) — how many separate pieces of
   * evidence back this claim. Re-observation strengthens a claim by adding an
   * edge, never by duplicating the fact, so this is the corroboration signal
   * and not a row count.
   */
  readonly corroborationCount: number;
  readonly provenance: BrainFactProvenanceView;
  readonly episode: BrainFactEpisodeView | null;
  readonly tensions: readonly BrainFactTensionView[];
  /**
   * Why publish would refuse this claim, or `null` if it would promote.
   *
   * Meaningful for a DRAFT. A published fact can carry a block and that is not
   * a contradiction: a region import writes `status` verbatim, so a workspace
   * can legitimately arrive holding an already-published fact this classifier
   * would refuse. `GRANT_UNUSABLE` is an invariant of the promotion PATH, not
   * of published facts.
   */
  readonly promotionBlock: BrainFactPromotionBlock | null;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly extractedAt: string | null;
  readonly ingestedAt: string | null;
  readonly updatedAt: string | null;
}

export interface BrainFactCandidateListResponse {
  readonly candidates: readonly BrainFactCandidate[];
  /** Grand total matching the filters, for server-side pagination. */
  readonly total: number;
  /**
   * True when this page hit the contradiction fan-out cap, so some candidates'
   * `tensions` are incomplete.
   *
   * Not cosmetic. A truncated contradiction list renders as "nothing further
   * conflicts with this claim", which is the single most dangerous thing this
   * surface can imply — and the truncation is BIASED: edges are taken in
   * endpoint-fact-id order, so loss concentrates at the tail, and a candidate
   * can lose every hint it originated while keeping the ones pointed at it. The
   * flag exists so the UI can say it out loud.
   */
  readonly tensionsTruncated: boolean;
}

/** Queue vitals for the review surface's stats bar. */
export interface BrainFactCandidateSummary {
  /**
   * Live drafts awaiting review, SCOPED TO THIS READER'S GRANTS.
   *
   * May be smaller than `/api/v1/mode` `draftCounts.brainFacts`, which counts
   * every draft in the workspace regardless of who is looking. Both are
   * correct: the mode chip answers "does this workspace have unpublished
   * work", this answers "how much of it can I review".
   */
  readonly draftTotal: number;
  /** Drafts whose entity resolution was provisional — the quality queue. */
  readonly provisionalTotal: number;
  /** Drafts carrying at least one advisory `in-tension-with` edge. */
  readonly inTensionTotal: number;
  readonly publishedTotal: number;
}

/**
 * Result of retracting (rejecting) a candidate.
 *
 * Rejection stamps `invalidated_at`; it never writes `status`. A fact is never
 * deleted and never demoted by status (ADR-0036: supersession is not deletion),
 * and `brain_facts.status` has exactly one writer — the atomic publish
 * endpoint. Retracted rows drop out of the review queue, the publish preview,
 * and `draftCounts` because all three exclude `invalidated_at IS NOT NULL`.
 */
export interface BrainFactRetractResponse {
  readonly id: string;
  readonly invalidatedAt: string;
}
