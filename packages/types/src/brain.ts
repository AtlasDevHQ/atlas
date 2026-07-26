/**
 * Wire shapes for the company brain — the fact review surface (#4772) and the
 * `searchBrain` fused read (#4773). ADR-0036.
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

// ---------------------------------------------------------------------------
// Admin oversight — counts without content (#4825, ADR-0036 §Access control)
// ---------------------------------------------------------------------------

/**
 * Which arm of the grant grammar an oversight bucket aggregates.
 *
 * One bucket is one stored grant TOKEN, so `malformed` names a token outside
 * the grammar (`everyone`, `ROLE:admin`, a NULL element) rather than a
 * principal. Such a token grants nobody anything — but a fact can carry a
 * usable token ALONGSIDE it, so a malformed bucket does NOT mean "invisible to
 * everyone". The entirely-unusable class is `lib/brain/grant-sweep.ts`'s remit
 * (#4797) and is not reported here.
 */
export type BrainFactOversightBucketKind = "org" | "audience" | "role" | "user" | "malformed";

/**
 * Whether this bucket's grant token may be shown to the admin, and why.
 *
 * THE RULE (#4825): **counts may be labelled with an audience the admin
 * CONFIGURED; a DISCOVERED audience gets an opaque handle.** An admin who typed
 * a Slack channel id into the install form learns nothing new from seeing it
 * back — the install config is already admin-readable. A source that discovers
 * its audiences instead (auto-join, a directory sync, M3's webhook fast-path)
 * would be disclosing the existence and activity level of a channel the admin
 * never named, which the existence of `#project-severance` makes sensitive even
 * with zero content attached.
 *
 * `intrinsic` is the third arm and exists so the rule is not stretched to cover
 * things it was not written for: `org` and `role:*` name a fixed, public
 * vocabulary that identifies no channel and no person, so they are neither
 * configured nor discovered. `user:*` is DISCOVERED — Atlas resolved that
 * person, the admin did not name them — which is why per-person fact counts
 * never carry a user id.
 */
export type BrainFactOversightLabelPolicy = "intrinsic" | "configured" | "discovered";

/** One audience's fact counts. Counts only — see {@link BrainFactOversight}. */
export interface BrainFactOversightBucket {
  /**
   * Display identity, stable for as long as the bucket set is.
   *
   * Equal to {@link label} when there is one; otherwise a positional handle
   * (`discovered-1`). It is NOT derived from the withheld token in any
   * recoverable way — an ordinal cannot be reversed, where a hash of a
   * ten-character Slack channel id salted with a workspace id the admin already
   * holds could be brute-forced.
   */
  readonly key: string;
  readonly kind: BrainFactOversightBucketKind;
  /** The grant token verbatim, or `null` when the label policy withholds it. */
  readonly label: string | null;
  readonly labelPolicy: BrainFactOversightLabelPolicy;
  /** Live drafts — `status = 'draft'`, not retracted. */
  readonly awaitingReview: number;
  readonly published: number;
  /** Retracted at any status — the `invalidated_at` tombstone axis. */
  readonly retracted: number;
  /** Of the live drafts, those whose entity resolution was provisional. */
  readonly provisional: number;
  /** Of the live drafts, those carrying an advisory `in-tension-with` edge. */
  readonly inTension: number;
}

/** Workspace-wide fact counts, deduplicated by fact. */
export interface BrainFactOversightTotals {
  readonly awaitingReview: number;
  readonly published: number;
  readonly retracted: number;
  readonly provisional: number;
  readonly inTension: number;
}

/**
 * The admin oversight view: where a workspace's facts really stand, as numbers,
 * with no claim, no evidence, and no provenance attached (#4825).
 *
 * ## Why this surface exists
 *
 * Publish is workspace-scoped and the review queue is reader-scoped, and both
 * are correct — see `docs/development/brain-slack-history.md` § Publish scope.
 * The consequence is that an admin outside a private channel's audience can
 * hold a clean queue and a hidden backlog and be unable to tell them apart.
 * This view ends that, WITHOUT widening what they may read: `role:platform_admin`
 * is refused by the grant grammar and a platform role confers no brain grant, so
 * Atlas must never become a way to read a Slack channel you were never in.
 * An admin learns that facts exist they cannot see — a number, never content.
 *
 * ## Reading the numbers
 *
 * A fact is counted in EVERY bucket its grant names, so the buckets overlap and
 * their sum is not {@link workspaceTotals}. That is why the totals are carried
 * rather than left to the client to add up.
 *
 * {@link reviewableAwaitingReview} is the same quantity as
 * `/api/v1/admin/brain-facts/summary`'s `draftTotal`, restated here so the two
 * halves of the disclosure come from ONE snapshot. Fetched separately they can
 * disagree under concurrent ingest, and a delta that flickers is worse than no
 * delta at all — this surface's entire content is
 * `workspaceTotals.awaitingReview - reviewableAwaitingReview`.
 */
export interface BrainFactOversight {
  readonly buckets: readonly BrainFactOversightBucket[];
  readonly workspaceTotals: BrainFactOversightTotals;
  /**
   * Live drafts THIS reader may open at `/admin/brain-facts` — reader-scoped.
   * Never larger than `workspaceTotals.awaitingReview`; the difference is the
   * backlog federated to somebody else.
   */
  readonly reviewableAwaitingReview: number;
  /**
   * True when more distinct grant tokens exist than this response carries.
   *
   * Never silent: a truncated bucket list renders as a complete account of
   * where the workspace's facts sit, which is the one thing an oversight
   * surface must not imply. {@link workspaceTotals} is unaffected — it is
   * computed per fact, not per bucket, so the top-line disclosure stays exact
   * even when the breakdown is clipped.
   */
  readonly bucketsTruncated: boolean;
}

// ---------------------------------------------------------------------------
// `searchBrain` — the fused, trust-labeled read (#4773, ADR-0036 §Retrieval)
// ---------------------------------------------------------------------------

/**
 * The result CLASS of one fused row — and the discriminant of
 * {@link BrainSearchResult}.
 *
 * Not the same axis as ADR-0036's numeric trust tiers, which is why both are
 * carried. `TRUST_TIERS` (`packages/api/src/lib/brain/types.ts`; warehouse 1 > fact 2 > episode 3) orders how
 * authoritative a TRUTH CLAIM is; tier 1 has no row representation anywhere
 * (warehouse facts resolve live through the semantic layer and are
 * `executeSQL`'s), so it can never appear here.
 *
 * (Not to be confused with the "two different axes" of `lib/knowledge/search.ts`,
 * which names what GATED a row — content-mode alone vs. content-mode + ACL.
 * That is a third, orthogonal distinction; the pairing here is result class vs.
 * trust ordering.)
 *
 * `document` is the class that separates result class from trust ordering: a KB document is
 * ADR-0028 descriptive prose, not a claim about the world, so it has no
 * position in a truth ordering at all. Its {@link BrainDocumentResult.trustTier}
 * is `null` rather than an invented 4 — a number would imply "less
 * authoritative than a raw episode", which is not what it is.
 *
 * `raw-episode` is spelled exactly as ADR-0036 commits it, including for
 * episodes that HAVE been extracted: the tier names what the row is (raw
 * source content), and {@link BrainEpisodeResult.extraction} carries whether a
 * pass has run over it.
 */
export type BrainResultTier = "fact" | "raw-episode" | "document";

/**
 * Whether an extraction pass has run over the episode backing this result.
 *
 * `pending` (`extracted_at IS NULL`) is a COMMITTED behavior, not a fallback:
 * the extraction fiber is default-OFF (`ATLAS_BRAIN_EXTRACTION_ENABLED`), so on
 * a fresh deployment a labeled raw episode is the ONLY thing the brain half of
 * `searchBrain` can return. ADR-0036: the extraction-lag window degrades to a
 * labeled raw answer, never a blocked read.
 */
export type BrainEpisodeExtractionState = "pending" | "complete";

/**
 * A claim in advisory tension with a fused fact result — an `in-tension-with`
 * edge, surfaced in BOTH directions and NEVER ranked.
 *
 * Arbitration is M2's. This slice reports the graph and stops: the agent is
 * told two claims conflict and neither is presented as the winner. Same rule
 * the review surface follows ({@link BrainFactTensionView}); this is the
 * lighter projection — no provenance, no corroboration, because a retrieval
 * caller needs to know a conflict EXISTS, and the review surface is where it
 * gets adjudicated.
 */
export type BrainSearchTensionView =
  | {
      readonly visible: true;
      readonly factId: string;
      readonly edgeDirection: BrainFactTensionDirection;
      readonly subject: string;
      readonly predicate: string;
      readonly object: string;
      /** Non-null when the counterpart has been withdrawn — see {@link BrainFactTensionVisible.invalidatedAt}. */
      readonly invalidatedAt: string | null;
    }
  /**
   * A conflicting claim this reader may not see. Reported rather than dropped:
   * "there is a rival you cannot see" is exactly what should stop an agent
   * asserting the claim as settled, and an omitted row reads as "nothing
   * contradicts this".
   */
  | {
      readonly visible: false;
      readonly factId: string;
      readonly edgeDirection: BrainFactTensionDirection;
    };

/** tier-2 — a reviewed claim. Authoritative for its class; yields to the warehouse. */
export interface BrainFactResult {
  readonly tier: "fact";
  /** `TRUST_TIERS.fact`. A literal, so a fact result cannot be built mislabeled. */
  readonly trustTier: 2;
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly predicateCardinality: "single" | "multi";
  /**
   * Always `published` for an ordinary read — the content-mode clause admits
   * drafts only in developer mode. Carried anyway so a developer-mode caller
   * can tell an unreviewed claim from a reviewed one.
   */
  readonly status: BrainFactReviewStatus;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly ingestedAt: string | null;
  /** `ts_headline` snippet when a lexical query ran, else null. */
  readonly snippet: string | null;
  readonly provenance: BrainFactProvenanceView;
  /** DISTINCT `provenance` edges backing the claim — see {@link BrainFactCandidate.corroborationCount}. */
  readonly corroborationCount: number;
  readonly tensions: readonly BrainSearchTensionView[];
}

/** tier-3 — raw source content. Source-of-truth for what was said, never for what is true. */
interface BrainEpisodeResultBase {
  readonly tier: "raw-episode";
  /** `TRUST_TIERS.episode`. */
  readonly trustTier: 3;
  readonly id: string;
  readonly source: string;
  /**
   * The source's own stable id. Committed alongside the `pending` label so a
   * caller can point at the underlying record while extraction is still
   * queued — ADR-0036 names the stable source-id as part of that behavior.
   */
  readonly sourceId: string;
  readonly sourceActor: string | null;
  /** Body XOR locator — by-value for chat, by-reference for warehouse/KB. */
  readonly body: string | null;
  /** True when `body` was clipped for transport; the full text is at rest. */
  readonly bodyTruncated: boolean;
  readonly locator: string | null;
  readonly occurredAt: string | null;
  readonly ingestedAt: string | null;
  readonly snippet: string | null;
}

/**
 * Whether an extraction pass has run — and its timestamp, as ONE value.
 *
 * A union rather than `{ extraction; extractedAt: string | null }` because the
 * two are fully derived from each other, and the flat pair makes
 * `{ extraction: "complete", extractedAt: null }` spellable. Today one producer
 * derives one from the other correctly; "an invariant enforced by a producer's
 * diligence" is exactly what this file refuses for episode visibility and
 * provenance, and the same treatment costs nothing here.
 */
export type BrainEpisodeExtraction =
  | { readonly extraction: "pending"; readonly extractedAt: null }
  | { readonly extraction: "complete"; readonly extractedAt: string };

export type BrainEpisodeResult = BrainEpisodeResultBase & BrainEpisodeExtraction;

/** Where a fused KB document came from. Mirrors the OKF `atlas:` provenance extension. */
export interface BrainDocumentProvenance {
  readonly type: string | null;
  readonly tags: readonly string[];
  readonly resource: string | null;
  /** How the document arrived — `upload`, `bundle-sync`, a connector. */
  readonly source: string | null;
  readonly ingestedAt: string | null;
  readonly timestamp: string | null;
  /** Content-mode status: `published` normally; `draft` only in developer mode. */
  readonly status: "draft" | "published" | "archived";
}

/**
 * A hosted OKF knowledge document (ADR-0028).
 *
 * `trustTier: null` is deliberate — see {@link BrainResultTier}. A document is
 * descriptive prose the agent must treat as data and never as instructions.
 */
export interface BrainDocumentResult {
  readonly tier: "document";
  readonly trustTier: null;
  readonly path: string;
  readonly collection: string;
  readonly title: string | null;
  readonly snippet: string | null;
  readonly provenance: BrainDocumentProvenance;
}

/**
 * A 1-hop neighbor of a matched document, along the KB link graph.
 *
 * Still a fully labeled {@link BrainDocumentResult} — an expansion result is
 * not a lesser class of row, and letting it skip the label is exactly how an
 * unlabeled row would reach a caller.
 */
export interface BrainDocumentNeighbor extends BrainDocumentResult {
  /** Seed document path(s) this neighbor is linked to/from. */
  readonly via: readonly string[];
  /** `outbound` (seed → neighbor) and/or `inbound` (neighbor → seed). */
  readonly direction: readonly string[];
  readonly anchors: readonly string[];
}

/**
 * One fused row.
 *
 * A DISCRIMINATED UNION, which is what "no unlabeled rows can be returned"
 * means structurally: there is no arm without a `tier`, and no way to spell a
 * result that carries the wrong `trustTier` for its class. A `tier?: string`
 * field on a flat row would have been a field somebody remembers to set.
 */
export type BrainSearchResult = BrainFactResult | BrainEpisodeResult | BrainDocumentResult;

/**
 * Per-store reporting for one fused read — what ran, what it found, what it
 * capped.
 *
 * A union rather than `queried: boolean` beside two always-present numbers,
 * because `{ queried: false, matched: 7 }` is representable in the flat shape
 * and means nothing. Consumers must narrow before reading `matched`, which is
 * correct: `matched: 0` on a store that was never queried is a number that
 * would be read as "this store had nothing".
 */
export type BrainSearchStoreReport =
  | { readonly queried: false }
  | {
      readonly queried: true;
      /** Rows the store contributed to the fused set, BEFORE the global limit. */
      readonly matched: number;
      /**
       * True when the store returned a full page and may hold more.
       *
       * Reported rather than implied: a fused read that silently truncates one
       * store reads as "that store had nothing else", which for a
       * conflict-bearing substrate is the same failure `tensionsTruncated`
       * exists to prevent.
       */
      readonly truncated: boolean;
    };

/**
 * Why a response is empty because the read could not RUN, as opposed to
 * running and matching nothing.
 *
 * Mirrors the tool-layer reason vocabulary, narrowed to the values that can
 * accompany a shaped result. Carried on the wire because a bare
 * `{ results: [] }` reads as "the brain knows nothing" — the single most likely
 * thing a caller will conclude, and the one this surface exists to prevent.
 */
export type BrainSearchUnavailable = "no_workspace";

export interface BrainSearchResponse {
  /** Fused across every queried store, relevance-ordered, every row labeled. */
  readonly results: readonly BrainSearchResult[];
  /** 1-hop KB link-graph expansion of the matched documents. Empty when `expand` is off. */
  readonly neighbors: readonly BrainDocumentNeighbor[];
  /**
   * Keyed by {@link BrainResultTier}, not by three hand-written names. Adding a
   * fourth result class then fails to compile HERE too, instead of being the
   * one place in the slice where "add a class" slips through — the tier tuple's
   * exhaustiveness pin and `resultKey`'s `never` arm already catch the rest.
   */
  readonly stores: Readonly<Record<BrainResultTier, BrainSearchStoreReport>>;
  /**
   * True when the `in-tension-with` fan-out cap bit, so some facts' `tensions`
   * are incomplete. See {@link BrainFactCandidateListResponse.tensionsTruncated}.
   */
  readonly tensionsTruncated: boolean;
  /**
   * Set when the brain could not be searched at all. Absent on a real read.
   *
   * Distinct from an empty `results`: one means "searched, matched nothing",
   * the other means "could not search". Reachable in practice — an unbound
   * stdio MCP actor has no workspace and takes this path on every call.
   */
  readonly unavailable?: BrainSearchUnavailable | null;
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
