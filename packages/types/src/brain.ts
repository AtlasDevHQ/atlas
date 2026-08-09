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
 *   2. Provenance is FLATTENED and fully nullable, EXCEPT where point 3
 *      applies — the attribution triple is nested behind a discriminated
 *      variant because it is an ACL boundary. At rest it is `jsonb` with
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
import type { ExportedVocabularySlotPosition } from "./migration";

/** Which side of a subject-predicate-object claim an entity sits on. */
export type BrainEntityRole = "subject" | "object";

/** Content-mode lifecycle of a fact. Mirrors `BRAIN_FACT_STATUSES`. */
export type BrainFactReviewStatus = "draft" | "published" | "archived";

/**
 * WHO said the claim first, WHERE, and WHEN — the three provenance fields that
 * name a person and a place, split out from the rest so they can be withheld
 * as a unit.
 *
 * ## Why these three and not the whole payload
 *
 * A fact's provenance names its FIRST episode, and for Slack `sourceId` is
 * `<channelId>:<ts>`. Together with `actor` and `occurredAt` that is *who said
 * it first, in which channel, and when* — private-channel MEMBERSHIP, which is
 * exactly what the `audience:` grant model exists to protect (#4836).
 *
 * The rest of {@link BrainFactProvenanceView} stays disclosed because none of
 * it names a principal or a place: `source` is a connector CLASS (`slack`),
 * `producer` a pipeline stage (`extraction:v1`), `episodeId` an opaque uuid
 * whose row is ACL-gated in its own right (same reasoning that lets
 * {@link BrainFactEpisodeWithheld} carry an id), and `extractedAt` /
 * `reconciledAt` are Atlas's own batch-scheduled pipeline clocks, not the
 * moment anything was said.
 */
export interface BrainFactAttributionVisible {
  readonly visible: true;
  /** The source's own stable id for the evidence. Slack: `<channelId>:<ts>`. */
  readonly sourceId: string | null;
  /** The principal that asserted the claim. */
  readonly actor: string | null;
  /** When the claim was asserted at the source. */
  readonly occurredAt: string | null;
}

/**
 * The reader can see this fact ONLY because publish-time grant widening
 * (#4823) added a principal they hold, so its first episode's attribution is
 * withheld from them.
 *
 * Carries nothing at all — and unlike {@link BrainFactEpisodeWithheld}, which
 * keeps an `id`, there is nothing it COULD keep. That asymmetry is the honest
 * reading of the two: an episode id is an opaque uuid whose row is separately
 * ACL-gated, so handing it over costs nothing and gives a reviewer a handle.
 * Attribution has no equivalent non-identifying half — every field in it names
 * a person, a place, or a moment — so the withheld arm is empty.
 *
 * The emptiness is enforced, not merely intended: the mirror in
 * `@useatlas/schemas` uses `z.strictObject`, so a producer that attached the
 * triple to a `visible: false` variant fails the response check with a 500
 * rather than shipping it. TypeScript's excess-property check is the first
 * line of defence and covers object literals only — a spread or a widened
 * variable slips past it, which is why the schema is the one that counts.
 *
 * This is the THIRD reason an attribution field can be absent, and it had to be
 * nameable rather than folded into either of the first two.
 * {@link BrainFactProvenanceView.payloadComplete} already separates "the
 * producer recorded nothing" (`true`, field `null`) from "Atlas lost track of
 * it" (`false`) — and withheld-by-ACL is neither. Collapsing it into the first
 * would tell a reviewer the evidence has no author; into the second, that Atlas
 * has a data-integrity problem. Both are false, and both are exactly the kind
 * of thing a reviewer acts on.
 */
export interface BrainFactAttributionWithheld {
  readonly visible: false;
}

export type BrainFactAttributionView =
  | BrainFactAttributionVisible
  | BrainFactAttributionWithheld;

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
  readonly episodeId: string | null;
  /** What produced the candidate — `extraction:v1`, `write-back`, `human`. */
  readonly producer: string | null;
  /**
   * Who asserted the claim first, where, and when — or a marker that the reader
   * is not entitled to that, because they reach this fact only through #4823's
   * publish-time widening. See {@link BrainFactAttributionWithheld}.
   */
  readonly attribution: BrainFactAttributionView;
  readonly extractedAt: string | null;
  readonly reconciledAt: string | null;
  /**
   * The entity store did not ANSWER when this claim was recorded — it threw, was
   * unavailable, or broke its contract — so the row carries no comparison value.
   * It can still MATCH an identical claim by identity key; what it can never do
   * is prove it DIFFERS from one, which is what superseding would need. THE
   * quality queue: block-class failures (no
   * provenance, no usable grant, unattributable actor, malformed claim) never
   * reach this surface at all; they were refused upstream.
   *
   * ⚠️ Since #5031 this is NOT "the store had no entry for this entity". That
   * outcome is honest, is already represented by an absent comparison, and is
   * deliberately unflagged — flagging it would set this on every entity-valued
   * object forever, which is precisely what defeats a filter on its presence.
   * A reader must not present it as "Atlas looked and could not pin the entity".
   *
   * Always true when {@link unresolved} is non-empty: at rest the flag and the
   * side-list are written together, but the flag is derived here rather than
   * trusted, so a payload carrying one without the other cannot present as
   * "resolved, but here are the unresolved sides".
   */
  readonly provisional: boolean;
  /**
   * Which sides were left unresolved. Empty unless `provisional`.
   *
   * Since #5031 a flagged row names BOTH sides: one batched call covers both
   * positions, so a failure has no per-role granularity, and a reader should not
   * build copy around which side it was. (Before #5031 the two positions were
   * resolved separately and could fail apart, but the only resolver ever shipped
   * was the passthrough, which never produced this flag — so there are no
   * one-sided rows in any corpus.)
   */
  readonly unresolved: readonly BrainEntityRole[];
  /**
   * False when the stored payload was missing a structural key, carried the
   * wrong type for one, or held an unparseable timestamp. The claim is still
   * reviewable — but a reviewer seeing an empty "Producer" needs to know
   * whether the producer wrote nothing or the payload drifted.
   *
   * Reports the payload AT REST and is therefore unaffected by
   * {@link attribution} being withheld. Deliberate: withholding is an
   * entitlement fact about the reader, and letting it flip this flag would
   * report an ACL decision as data corruption to every reader outside the
   * original grant.
   *
   * The accepted consequence, stated so nobody "closes" it later: a withheld
   * reader can infer from `payloadComplete: true` that an `actor` key exists
   * and that `occurredAt` parses. That is the one place the withheld arm is
   * not information-free, and it is the right trade — the alternative reports
   * a healthy record as corrupt to precisely the readers who cannot check.
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
  /**
   * The end of the counterpart's own validity window — the supersession axis,
   * peer to {@link BrainFactTensionVisible.invalidatedAt}'s retraction axis.
   * This is the canonical statement of why both labels exist; other surfaces
   * point here rather than restating it.
   *
   * Load-bearing for the same reason, and reached with no human action on the
   * counterpart at all: the publish gate stamps `validTo` on the claim it
   * retires and leaves that row's `status` untouched, while nothing deletes
   * the `in-tension-with` edge written at ingest. So the winner permanently
   * carries its loser as a counterpart, and without this field that
   * counterpart reads `status: "published", invalidatedAt: null` — a conflict
   * a human already arbitrated, presented as live and unresolved.
   *
   * PAST vs FUTURE matters. Non-null does not mean retired: the database's own
   * liveness predicate is `valid_to IS NULL OR valid_to > now()`, so a
   * future-dated stamp (a region import can carry one) is a LIVE rival whose
   * end is merely scheduled. Derive any "superseded" label from `validTo` in
   * the PAST; labelling a future window would suppress a real conflict.
   *
   * Both axes can be stamped on one rival — supersede-then-retract is
   * reachable, the reverse is not: every correction verb reads its target
   * through `invalidated_at IS NULL` (`correctionTargetSql`), so a tombstoned
   * fact answers not-found rather than being refused.
   *
   * A LABEL, never a ranking. It reports a lifecycle transition that already
   * happened; it is not a signal to compute a winner FROM. Do not sort or rank
   * counterparts by it.
   */
  readonly validTo: string | null;
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
 * Advisory staleness bucket of one claim, derived at read time (#4914,
 * ADR-0036 §Temporal — decay only surfaces, never auto-demotes).
 *
 * `unknown` is the honest arm for a row none of whose temporal anchors
 * decoded: claiming any of the other three would fabricate an age.
 */
export type BrainFactDecayLevel = "fresh" | "aging" | "stale" | "unknown";

/**
 * The read-time decay signal attached to every primary fact view — the review
 * queue row, the fact detail, and `searchBrain` results. Tension counterparts
 * deliberately carry none: they are context for a conflict, not a claim being
 * aged on its own card.
 *
 * ADVISORY ONLY, and computed at read time from the claim's newest observation
 * (its corroborating episodes' `occurred_at`, each falling back to that
 * episode's own ingest time), falling back to `validFrom`,
 * then `ingestedAt`. There is no stored score, no expiry, and no write path
 * from this signal to a fact row: a stale fact keeps its status, its trust
 * tier, and its place in every read. What decay may do is SURFACE — the review
 * queue floats stale claims for a human's attention, and the agent is told to
 * present a fact's age rather than assert a stale claim as current.
 */
export interface BrainFactDecayView {
  readonly level: BrainFactDecayLevel;
  /**
   * Days since the newest temporal anchor. `null` when the level is `unknown`
   * — or when the anchor is an observation and this reader's provenance
   * attribution is withheld (#4836): a day-precision age restates the withheld
   * "when" as arithmetic, so a widened-in reader gets the coarse level only.
   */
  readonly ageDays: number | null;
  /**
   * The newest observation itself, ISO-8601. `null` when no observation
   * decoded (the age, if any, is anchored on `validFrom` / `ingestedAt`) or
   * when it is withheld for the reason {@link ageDays} states.
   */
  readonly lastObservedAt: string | null;
}

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
  /**
   * ⚠️ **VESTIGIAL since #5027 (ADR-0037 §3) — do not branch on it.**
   *
   * It used to mean *`single` supersedes on conflict; `multi` coexists*. It no
   * longer decides either: cardinality is a property of the CANONICAL PREDICATE,
   * curated in `brain_predicate_cardinality` and read live at the publish gate.
   * The row column stopped being written, so a fact ingested since the migration
   * reports `multi` whatever its predicate is curated as, and one ingested
   * before it carries the extractor's stale LLM guess.
   *
   * Still on the wire only because removing a field from a published type is a
   * breaking change, and #5028 — which drops the column — owns it. Rendering a
   * supersession claim from this field is a lie in both directions;
   * `candidate-detail.tsx` deleted the one that existed.
   */
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
  /** Read-time staleness signal — advisory, never a demotion. See {@link BrainFactDecayView}. */
  readonly decay: BrainFactDecayView;
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
   * True when this page's contradiction lists are INCOMPLETE — the fan-out cap
   * bit, or an edge row was dropped as unusable. One flag for both because
   * readers act on the same thing: some candidates' `tensions` cannot be
   * trusted to be the whole story.
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

/**
 * The five state counters, declared ONCE.
 *
 * {@link BrainFactOversightBucket} extends this rather than restating the
 * fields, so a sixth counter cannot be added to the workspace totals and
 * forgotten on the per-audience breakdown — which would render as a column the
 * totals row has and the buckets do not.
 */
export interface BrainFactOversightTotals {
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

/** Fields every bucket carries whether or not its token may be named. */
interface BrainFactOversightBucketBase extends BrainFactOversightTotals {
  /**
   * Display identity, stable for as long as the bucket set is.
   *
   * Equal to `label` when there is one; otherwise a positional handle
   * (`discovered-1`). It is NOT derived from the withheld token in any
   * recoverable way — an ordinal cannot be reversed, where a hash of a
   * ten-character Slack channel id salted with a workspace id the admin already
   * holds could be brute-forced.
   */
  readonly key: string;
  readonly kind: BrainFactOversightBucketKind;
}

/**
 * One audience's fact counts. Counts only — see {@link BrainFactOversight}.
 *
 * ## A DISCRIMINATED UNION, for the same reason `BrainFactEpisodeView` is one
 *
 * This is an ACL boundary, so the withheld arm must be structurally incapable
 * of carrying the withheld value: the `discovered` arm has **no `label` field
 * at all**, rather than a `label: null` a producer could forget to null. The
 * flat shape made `{ kind: "user", labelPolicy: "configured", label:
 * "user:usr_abc" }` constructible — a resolved person's id, type-checking,
 * schema-parsing, and rendering straight through.
 *
 * The counter-argument is that the withheld arm drops one field here where the
 * episode view drops eight. That is the wrong measure: the value of the union
 * is proportional to the CONSEQUENCE of forgetting, and forgetting here
 * discloses the existence of a private channel — precisely what #4825 says the
 * counts alone must not do.
 *
 * `kind` is deliberately NOT folded into the discriminant. It would buy
 * "`user` implies withheld" at the cost of five arms and a chunkier client
 * switch; that implication is pinned by test instead.
 */
export type BrainFactOversightBucket =
  | (BrainFactOversightBucketBase & {
      readonly labelPolicy: Exclude<BrainFactOversightLabelPolicy, "discovered">;
      /** The grant token verbatim. */
      readonly label: string;
    })
  | (BrainFactOversightBucketBase & {
      readonly labelPolicy: "discovered";
    });

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
 * halves of the disclosure come from ONE REQUEST — deliberately not "one
 * snapshot": the three statements run through a pool with no enclosing
 * transaction, so they land on different connections at different LSNs. That
 * narrows the window in which the two halves disagree; it does not close it,
 * which is exactly why {@link countsConsistent} exists.
 */
export interface BrainFactOversight {
  readonly buckets: readonly BrainFactOversightBucket[];
  readonly workspaceTotals: BrainFactOversightTotals;
  /**
   * Live drafts THIS reader may open at `/admin/brain/facts` — reader-scoped.
   * Normally no larger than `workspaceTotals.awaitingReview`; the difference is
   * the backlog federated to somebody else. When it IS larger,
   * {@link countsConsistent} is false and the difference means nothing.
   */
  readonly reviewableAwaitingReview: number;
  /**
   * False when the reader-scoped count came back LARGER than the unscoped one.
   *
   * The scoped count is a subset of the unscoped one by construction, so this
   * says two statements disagreed about the same workspace — a `workspace_id`
   * mismatch, a mis-bound placeholder, a widened ACL clause. It is on the wire
   * rather than only in the log because the alternative is what the first cut
   * did: the client clamped the negative delta to zero and rendered "nothing is
   * hidden from you", which is the pre-#4825 defect reproduced by its own fix.
   * A surface whose entire content is a delta must be able to say the delta is
   * not trustworthy.
   */
  readonly countsConsistent: boolean;
  /**
   * Distinct grant tokens in the workspace — the TRUE audience cardinality,
   * uncapped, even when {@link buckets} is clipped.
   *
   * Carried because `buckets.length` reads as this number and stops being it
   * the moment truncation bites. The client must never infer cardinality from a
   * capped array: "across 200 audiences" presented as fact, with the correction
   * behind a disclosure triangle, is the "a clipped breakdown reads as a
   * complete account" failure this surface exists to avoid.
   */
  readonly distinctAudiences: number;
  /**
   * True when more distinct grant tokens exist than this response carries.
   *
   * Never silent: a clipped breakdown WOULD read as a complete account of where
   * the workspace's facts sit, which is the one thing an oversight surface must
   * not imply. {@link workspaceTotals} and {@link distinctAudiences} are
   * unaffected — both are computed independently of the cap, so the top-line
   * disclosure stays exact even when the breakdown is clipped.
   */
  readonly bucketsTruncated: boolean;
  /**
   * What the next publish will SUPERSEDE (#4912) — the disclosure that makes
   * "no silent supersession" true before the admin confirms.
   *
   * Optional on the TYPE for deploy-skew tolerance only (an older API omits
   * it, and the panel then simply renders no supersession notice — the
   * pre-#4912 behaviour, when there was nothing to disclose). The current API
   * always emits it; the server-side wire schema requires it.
   */
  readonly willSupersede?: BrainFactWillSupersede;
  /**
   * What the next publish will make VISIBLE TO MORE PEOPLE (#5032) — the
   * disclosure that makes publish-time grant widening (#4823) something a
   * reviewer is told about rather than something they discover afterwards.
   *
   * Optional on the TYPE for {@link willSupersede}'s deploy-skew reason, and
   * required by the server-side wire schema for the same one.
   */
  readonly willWiden?: BrainFactWillWiden;
}

/**
 * One supersession the next publish will perform (#4912): promoting `draft`
 * stamps `superseded`'s `valid_to` and writes a `supersedes` edge, in the same
 * transaction. Both claims are rendered because the pair IS the disclosure —
 * "X replaces Y" is what the admin is confirming.
 *
 * Unlike the oversight buckets this is CONTENT, so it is reader-scoped: a pair
 * appears here only when the reader's own fail-closed ACL predicate admits
 * BOTH rows. Everything else is a number in
 * {@link BrainFactWillSupersede.withheld} — never a placeholder row, for
 * the publish preview's stated reason: a row carrying only a fact id would
 * disclose which facts exist without disclosing what they say.
 */
export interface BrainFactWillSupersedePair {
  /** The draft whose promotion supersedes. */
  readonly draftId: string;
  /** The draft's SPO claim, `subject predicate object`. */
  readonly draftLabel: string;
  /** The published fact whose `valid_to` the promotion will stamp. */
  readonly supersededId: string;
  readonly supersededLabel: string;
}

/**
 * The will-supersede disclosure (#4912). `pairs` is reader-scoped and capped;
 * `withheld` counts the pairs the reader may not read (either side); the two
 * never overlap, so `pairs.length + withheld` understates only when
 * {@link truncated} is set.
 */
export interface BrainFactWillSupersede {
  /**
   * How many supersessions the next publish will perform, workspace-wide and
   * uncapped — the headline number. Carried explicitly because
   * `pairs.length + withheld` stops being it the moment {@link truncated}
   * bites, for `distinctAudiences`' reason: the client must never infer a
   * cardinality from a capped array.
   */
  readonly total: number;
  readonly pairs: readonly BrainFactWillSupersedePair[];
  /**
   * Supersessions the next publish will perform that this reader may NOT see —
   * a count, never content, mirroring the publish preview's
   * `brainFactsWithheld`. Publish is workspace-scoped, so these happen
   * regardless of who presses the button; the count is what keeps that from
   * being silent.
   */
  readonly withheld: number;
  /**
   * True when `pairs` is clipped at the response cap — or when the producer
   * dropped a drifted row, which is the same statement to the reader: you were
   * entitled to more than is listed. The missing remainder is NOT folded into
   * {@link withheld} in either case — that number means "hidden from you by
   * ACL", and a truncation dressed as an ACL boundary would send the admin
   * looking for private channels that do not exist.
   */
  readonly truncated: boolean;
}

/**
 * One grant the next publish will WIDEN (#5032, ADR-0037 §5).
 *
 * Publishing a draft unions in the grant of every episode already recorded as
 * evidence for it (#4823, `widenGrantFromEvidence`), so a claim first seen in a
 * private channel and restated in a public one stops being served only to the
 * private one. That is usually right. It is not right when two different
 * entities share a name: corroboration matches on identity keys derived from the
 * SURFACE, so a public episode about one `Acme Corp` can become evidence for a
 * private fact about another — and this widening then discloses the private
 * claim's body. That is the case this notice exists for.
 *
 * CONTENT, and therefore reader-scoped exactly like
 * {@link BrainFactWillSupersedePair}: an entry appears only where the reader's
 * own fail-closed ACL predicate admits the draft.
 */
export interface BrainFactWillWidenEntry {
  /** The draft whose published grant will be wider than its stored one. */
  readonly factId: string;
  /** The draft's SPO claim, `subject predicate object` — the thing being disclosed. */
  readonly label: string;
  /**
   * The grant tokens the evidence adds, in the order the evidence arrived —
   * the same list the post-publish `PromotionReport.widened` reports.
   *
   * ⚠️ A SYNTACTIC upper bound on readers gained, never a reader count: role
   * matching is monotone, so `role:owner` added to a fact already granted
   * `role:member` appears here and admits nobody new. Over-stating is the
   * deliberate direction — the opposite error is a silent ACL change.
   *
   * A NON-EMPTY tuple, and the type is the enforcement. An entry exists only
   * where the widening was not a no-op — that is what keeps this notice from
   * firing on every ordinary corroboration — and `EvidenceWidenedGrant.added`
   * already carries the guarantee, so widening it back to `readonly string[]`
   * here would discard a property the producer has. ⚠️ The schema mirrors this
   * as `z.tuple([z.string()], z.string())` rather than
   * `z.array(z.string()).nonempty()`, and deliberately: zod v4 infers `string[]`
   * from `.nonempty()`, so under that spelling the schema's
   * `satisfies z.ZodType<…>` passes vacuously on this axis and the two sides
   * stop checking each other. The tuple is what keeps them in lockstep.
   */
  readonly added: readonly [string, ...string[]];
}

/**
 * The will-widen disclosure (#5032) — what publishing will make visible to more
 * people, shown BEFORE the admin confirms.
 *
 * ⚠️ **Reader-scoped with NO `withheld` counterpart**, and the asymmetry with
 * {@link BrainFactWillSupersede} is deliberate rather than an omission. Counting
 * the widenings a reader cannot see means running the grant grammar over other
 * readers' episode grants, which the oversight module's no-unscoped-content rule
 * forbids and which no issue has decided. So an empty `entries` means *"none
 * that you can see"*, never *"none"* — the post-publish record
 * (`PromotionReport.widened`) is what covers the rest, one moment too late to be
 * notice.
 */
export interface BrainFactWillWiden {
  /**
   * How many reader-visible drafts will widen — the real cardinality, taken
   * before the cap, so the client never infers it from a clipped array.
   */
  readonly total: number;
  readonly entries: readonly BrainFactWillWidenEntry[];
  /**
   * True when `entries` is clipped at the response cap — the list is short, the
   * remainder exists, and `total` counts it.
   *
   * ⚠️ Deliberately NOT the drift signal. Those are two different facts with two
   * different remedies (paginate vs. diff the query), and one boolean carrying
   * both forces the UI to state one of them unconditionally — which is a
   * confident, specific, wrong explanation on the surface whose entire product
   * is honest notice. See {@link incomplete}.
   */
  readonly truncated: boolean;
  /**
   * True when Atlas could not EVALUATE some drafts — a row came back with a
   * column it could not read, so that draft is missing from `entries` **and**
   * from {@link total}.
   *
   * The distinction from {@link truncated} is the whole reason this field
   * exists: a truncated list understates itself by a known amount that `total`
   * still reports, while an incomplete one understates `total` as well. A reader
   * seeing `incomplete` should treat publishing as widening MORE than is listed;
   * a reader seeing `truncated` should not.
   *
   * Both are `false` on the ordinary path, and a client that only understands
   * `truncated` degrades to the pre-#5032 reading rather than to a false
   * all-clear.
   */
  readonly incomplete: boolean;
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
 * The counterparts this reader may NOT see, as one aggregated entry (#4913).
 *
 * A COUNT rather than one `visible: false` row per rival, and that asymmetry
 * with {@link BrainFactTensionWithheld} is deliberate: the review surface hands
 * a human per-rival opaque handles worth keeping distinct (an id names a row a
 * differently-entitled reviewer can resolve); `searchBrain` feeds an LLM
 * context window, where N identical "you cannot see this" rows spend tokens
 * without adding information. The COUNT is the whole
 * signal — "two rivals exist that you cannot see" is exactly what should stop
 * an agent asserting the claim as settled, and an omitted conflict reads as
 * "nothing contradicts this" (the M1 rule).
 *
 * `z.strictObject` on the schema mirror keeps this arm structurally incapable
 * of carrying the claim payload — the same enforcement every withheld arm in
 * this file gets, because this is an ACL boundary.
 */
export interface BrainSearchTensionWithheld {
  readonly visible: false;
  /** How many conflicting claims exist that this reader may not see. ≥ 1. */
  readonly withheldCount: number;
}

/**
 * One entry of a fused fact's conflict cluster — an `in-tension-with` edge,
 * surfaced in BOTH directions and NEVER ranked (#4913, ADR-0036 §Temporal).
 *
 * Genuine coexisting tension is surfaced-both-with-provenance, never arbitrated:
 * each ACL-visible counterpart is the FULL {@link BrainFactTensionVisible}
 * projection — claim, provenance (attribution decided per counterpart row),
 * corroboration, and recency — so the agent can present both sides with their
 * evidence. Source authority and recency are surfacing hints for the READER;
 * nothing in the ordering or the shape names a winner: entries are sorted by
 * `factId` alone, with the withheld aggregate last. Arbitration belongs to the
 * human gate (`/admin/brain/facts`, composing with supersession — #4912).
 */
export type BrainSearchTensionView = BrainFactTensionVisible | BrainSearchTensionWithheld;

/** tier-2 — a reviewed claim. Authoritative for its class; yields to the warehouse. */
export interface BrainFactResult {
  readonly tier: "fact";
  /** `TRUST_TIERS.fact`. A literal, so a fact result cannot be built mislabeled. */
  readonly trustTier: 2;
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  /**
   * ⚠️ **VESTIGIAL since #5027 (ADR-0037 §3) — do not branch on it.**
   *
   * It used to mean *`single` supersedes on conflict; `multi` coexists*. It no
   * longer decides either: cardinality is a property of the CANONICAL PREDICATE,
   * curated in `brain_predicate_cardinality` and read live at the publish gate.
   * The row column stopped being written, so a fact ingested since the migration
   * reports `multi` whatever its predicate is curated as, and one ingested
   * before it carries the extractor's stale LLM guess.
   *
   * Still on the wire only because removing a field from a published type is a
   * breaking change, and #5028 — which drops the column — owns it. Rendering a
   * supersession claim from this field is a lie in both directions;
   * `candidate-detail.tsx` deleted the one that existed.
   */
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
  /**
   * Read-time staleness signal (#4914) — advisory temporal metadata, carried
   * so the agent can present a fact's age instead of asserting a stale claim
   * as current. Never a demotion: `trustTier` and `status` are unaffected by
   * it, and fusion never ranks by it.
   */
  readonly decay: BrainFactDecayView;
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
   * True when some facts' `tensions` are incomplete — the `in-tension-with`
   * fan-out cap bit, or an edge row was dropped as unusable.
   * See {@link BrainFactCandidateListResponse.tensionsTruncated}.
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
  /**
   * The bi-temporal point-read instant this page answered for (#4916), echoed
   * back normalized to ISO-8601. Present ONLY on an as-of read — an as-of-now
   * page omits it, so its absence is the statement "these are current beliefs".
   * Carried because a historical fact page read WITHOUT this framing is
   * indistinguishable from current belief, which is exactly the confusion a
   * trust-labeled surface must not permit.
   */
  readonly asOf?: string;
}

/**
 * Result of retracting (rejecting) a candidate.
 *
 * Rejection stamps `invalidated_at`; it never writes `status`. A fact is never
 * deleted and never demoted by status (ADR-0036: supersession is not deletion),
 * and `brain_facts.status` has exactly one writer — the atomic publish
 * endpoint. Retracted rows drop out of the review queue, the publish preview,
 * and `draftCounts` because all three exclude `invalidated_at IS NOT NULL`.
 *
 * The route runs the `retract` CORRECTION verb (#4915), so it produces the
 * same two disclosures {@link BrainFactCorrectionResponse} carries — the
 * correction episode and the flagged dependents. Both are echoed here (#4939):
 * while they reached only `logAdminAction` metadata, the console reviewer who
 * triggered the retraction was the one party told nothing, and
 * `brain-corrections.mdx` documented the opposite. `id` rather than `factId`
 * is the pre-existing spelling of the same value, kept so the addition stays
 * purely additive for an existing client.
 */
export interface BrainFactRetractResponse {
  readonly id: string;
  readonly invalidatedAt: string;
  /** The immutable human-authored correction episode recording the retraction. */
  readonly correctionEpisodeId: string;
  /**
   * Live facts holding a `derives-from` edge onto the retracted one, flagged
   * for human re-review. Opaque ids — never claims — and never a cascade.
   *
   * Ids here and a COUNT on the agent path, and the reason is narrower than
   * "the reviewer is entitled to these": org role does not confer blanket read
   * on brain facts (`lib/brain/acl.ts` matches per grant, and the owner/admin
   * bypass is an opt-in audit override that is not in play here), so an admin
   * whose grants miss a dependent does receive that dependent's id. What
   * justifies it is that the id is an opaque workspace-scoped UUID carrying no
   * claim text, and the recipient is the human who has to act on the flag —
   * an LLM is neither, which is why `lib/tools/correct-fact.ts` reports the
   * count. The split is about what the MODEL may see; it is not about where
   * the record lives, since #4934 the `admin_action_log` row carries the ids
   * on every entry point including the tool's.
   *
   * No surface links these yet — the console renders the count. See
   * `MERGE_PROVENANCE_MARKER_SQL`'s header for why that is bounded.
   *
   * Deliberately UNCAPPED, unlike the analogous `refusedDrafts[]` (which stops
   * at 100 beside an uncapped `refusedDraftTotal`). The producer is bounded by
   * construction today — no in-region path mints the fact→fact `derives-from`
   * edge this reads — so a cap would be a wire change with no producer to
   * protect against. The M5 write-back producer is the moment to adopt the
   * cap-plus-total pattern, and it should be decided then rather than
   * discovered.
   */
  readonly flaggedForReReview: readonly string[];
}

/**
 * The four correction verbs (#4915, ADR-0036 §Temporal, conflict &
 * provenance) — T4's second human-authoritative entry point beside the review
 * gate. `retract` is the ONLY tombstone path (and the GDPR-erasure verb);
 * `supersede` stamps `valid_to` + the `supersedes` edge through #4912's
 * publish-gate machinery; `re-authority` and `pin` re-anchor a claim on the
 * correcting human as fresh evidence. The runtime tuple lives in
 * `@useatlas/schemas` (`BRAIN_CORRECTION_VERBS`) for the usual
 * no-value-exports-here reason.
 */
export type BrainCorrectionVerb = "retract" | "supersede" | "re-authority" | "pin";

/**
 * Result of applying one correction verb.
 *
 * Every correction materializes an immutable human-authored episode
 * (`correctionEpisodeId`) and lands authoritative immediately — no draft
 * queue. The verb-specific fields are `null` / empty on the verbs they do not
 * belong to, rather than a discriminated union, because every consumer today
 * renders the shared triple and treats the rest as annotations.
 */
export interface BrainFactCorrectionResponse {
  readonly verb: BrainCorrectionVerb;
  /** The corrected (target) fact. */
  readonly factId: string;
  /** The immutable human-authored correction episode recording the verb. */
  readonly correctionEpisodeId: string;
  /** `retract` only: the tombstone timestamp. */
  readonly invalidatedAt: string | null;
  /**
   * `retract` only: live facts holding a `derives-from` edge onto the
   * retracted one, flagged for human re-review. Opaque ids — never claims —
   * and never a cascade: nothing about the flagged rows' own lifecycle
   * changed.
   */
  readonly flaggedForReReview: readonly string[];
  /** `supersede` only: the fact now serving as the current belief. */
  readonly supersededBy: string | null;
  /** `supersede` only: the `valid_to` stamped on the superseded fact. */
  readonly validTo: string | null;
}

// ---------------------------------------------------------------------------
// The Claim Vocabulary surface (#5087, ADR-0037 §6)
// ---------------------------------------------------------------------------

/**
 * A claim's three slots, on the wire.
 *
 * An ALIAS of the region bundle's spelling, never a fourth copy of the union.
 * `identity.ts` already pins its internal `SlotPosition` against
 * `ExportedVocabularySlotPosition` in both directions, so aliasing here means
 * this surface cannot drift from either — where a hand-written
 * `"subject" | "predicate" | "object"` would be a third set to keep in step.
 * The name differs because "exported" is the bundle's vocabulary and means
 * nothing on a REST surface.
 */
export type BrainVocabularySlotPosition = ExportedVocabularySlotPosition;

/**
 * Which arm of the positional-visibility rule scoped a read.
 *
 * On the wire so the client can SAY which — *"predicate entries are shown to
 * every approver"* vs *"entity entries are scoped to what you can read"* — and
 * so a withheld count of zero is legible rather than merely reassuring. A client
 * that could not tell the two apart would render the same "nothing hidden"
 * sentence for both.
 */
export type BrainVocabularyScope = "unscoped" | "reader-scoped" | "deny-all";

/**
 * Whether a canonical predicate holds one value at a time.
 *
 * ⚠️ A union, not `string`, and the asymmetry it fixes was live: the REQUEST
 * schema for this field was already `z.enum(["single", "multi"])` while the
 * RESPONSE carried `string`, in the same file. The admin pane branches on
 * `=== "single"` to decide whether to warn that every future claim in the slot
 * can supersede an earlier one — so a typo or a future third value dropped that
 * warning with no compile signal at all.
 */
export type BrainVocabularyCardinality = "single" | "multi";

/**
 * Why a blast-radius counterfactual can produce no pairs BY CONSTRUCTION.
 *
 * ⚠️ Mirrors the engine's `StructurallyEmptyReason` deliberately, because this
 * is the branch whose ENTIRE PURPOSE is saying which. The union's discriminant
 * survived the wire; its payload did not, and `blast-radius.tsx` re-enumerated
 * all five members as bare strings with nothing connecting the two lists — so a
 * renamed engine reason shipped silently into the client's "a reason this page
 * does not recognise" fallback, which is the one branch that must stay rare
 * enough to be believed.
 *
 * The client keeps its `default:` arm — forward compatibility still needs one —
 * but with a typed field that arm is provably about an API newer than the page
 * rather than about a typo.
 */
export type BrainVocabularyStructurallyEmptyReason =
  | "object-position"
  | "already-single"
  | "not-curated"
  | "unkeyable-surface"
  | "no-such-edge";

/**
 * One norm the corpus has actually produced at a slot position — the authoring
 * picker's row.
 *
 * ⚠️ **A norm, never a key.** ADR-0037 §6 forbids projecting a claim's identity
 * KEY (`keys-not-on-the-wire.test.ts` is the guard); norms are what
 * `brain_vocabulary_edge` has stored since migration 0189 and what a reviewer
 * approving a merge has to be shown. `CONTEXT.md` pins surface / norm / key as
 * three non-interchangeable levels, and this is the middle one.
 */
export interface BrainVocabularySurfaceOption {
  /** The value an authoring request carries. Picked, never typed. */
  readonly norm: string;
  /** The most common surface folding into it — what a human recognises. */
  readonly exampleSurface: string;
  /** Live claims at this position whose surface norms to {@link norm}. */
  readonly claims: number;
  /** Distinct surfaces folding into it. `1` means the norm IS the spelling. */
  readonly variants: number;
}

export interface BrainVocabularySurfaceList {
  readonly position: BrainVocabularySlotPosition;
  readonly surfaces: readonly BrainVocabularySurfaceOption[];
  /**
   * The corpus has more norms than this page carries.
   *
   * The line that tells an approver to filter rather than conclude their
   * spelling is absent — which is the conclusion that sends them looking for a
   * text box, and the text box is what this whole surface exists to remove.
   */
  readonly truncated: boolean;
  readonly scope: BrainVocabularyScope;
}

/** One approved edge currently shaping identity. */
export interface BrainVocabularyEdgeEntry {
  readonly position: BrainVocabularySlotPosition;
  readonly fromNorm: string;
  readonly toNorm: string;
  /**
   * The approving user id, `local-operator`, or `null` for an auto-approved
   * warehouse-derived edge — migration 0189's three legal values, unflattened.
   * `approvedBy !== null` means "a human" by construction.
   */
  readonly approvedBy: string | null;
  readonly approvedAt: string;
  /**
   * Whether a removal will leave rejection memory on a row that already exists,
   * or has to create one.
   *
   * `true` for every edge this product's own seams wrote. `false` for an edge
   * the region importer copied, which travels without its proposal (#5035) —
   * surfaced so an approver knows the removal is doing slightly more than it
   * looks like, rather than discovering it in the audit trail.
   */
  readonly hasRejectionMemory: boolean;
}

/** One position's disclosure accounting. */
export interface BrainVocabularyPositionCounts {
  readonly position: BrainVocabularySlotPosition;
  readonly scope: BrainVocabularyScope;
  /** Workspace-wide, content-free. The vocabulary's SIZE is not a secret. */
  readonly total: number;
  /** How many of those this reader may see. */
  readonly scoped: number;
  /**
   * `total − scoped` — entries in force that this reader cannot see.
   *
   * ADR-0037 §6: **a withheld count, never a silent omission.** An approver must
   * be able to tell *"12 entity edges you cannot see"* from *"none"*; a scoped
   * `SELECT` renders those two identically.
   */
  readonly withheld: number;
  /**
   * False when the two statements behind the numbers disagreed and the delta
   * was clamped.
   *
   * `loadFactOversight`'s reason: silently clamping renders as *"nothing is
   * hidden from you"*, which is the pre-#4825 defect reproduced by its own fix.
   */
  readonly countsConsistent: boolean;
}

/** One curated cardinality currently arming supersession. */
export interface BrainVocabularyCardinalityEntry {
  /**
   * A representative live surface for the canonical predicate.
   *
   * ⚠️ NOT the predicate key — `PredicateCardinalityRecord` states the same
   * prohibition for itself. `null` when every claim that produced the key has
   * since been retracted, which is a real state worth finding: an entry still
   * arming supersession for a predicate with no live claims is exactly what an
   * approver should be able to remove.
   */
  readonly predicateSurface: string | null;
  readonly cardinality: BrainVocabularyCardinality;
  readonly sourceClass: string;
  readonly proposedBy: string;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly claims: number;
}

/**
 * What the empty state needs to be a COVERAGE STATEMENT rather than a
 * congratulation.
 *
 * ⚠️ There is no caught-up state for a vocabulary — only what has been decided
 * and what has not yet been observed. {@link comparableFacts} is the number that
 * lets the surface say *why* Pending is empty specifically: the structural
 * proposer fires only on claims with comparable objects.
 */
export interface BrainVocabularyCoverage {
  readonly liveFacts: number;
  readonly comparableFacts: number;
  readonly pendingProposals: number;
  readonly pendingCardinalities: number;
}

export interface BrainVocabularyInForceResponse {
  readonly edges: readonly BrainVocabularyEdgeEntry[];
  readonly counts: readonly BrainVocabularyPositionCounts[];
  readonly cardinalities: readonly BrainVocabularyCardinalityEntry[];
  /**
   * The same disclosure accounting the alias edges get, for curated predicates.
   *
   * ⚠️ Without it the empty state asserted *"no curated predicates are in force
   * in this workspace"* from a read that had been DENIED — a workspace-wide
   * claim made on the strength of seeing nothing.
   */
  readonly cardinalityCounts: BrainVocabularyPositionCounts;
  readonly coverage: BrainVocabularyCoverage;
  readonly truncated: boolean;
}

/**
 * One pair of live claims an OBJECT merge would relate.
 *
 * ⚠️ Symmetric field names, deliberately not `BrainFactWillSupersedePair`'s
 * `draft`/`superseded`. Neither claim replaces the other, and a client reading
 * `supersededLabel` on a corroboration pair would conclude exactly the thing the
 * object-position arm exists to stop it concluding.
 */
export interface BrainVocabularyObjectPair {
  readonly leftId: string;
  readonly leftLabel: string;
  readonly rightId: string;
  readonly rightLabel: string;
}

/**
 * One side of the object-position radius.
 *
 * Same disclosure contract as {@link BrainVocabularyBlastRadiusSide} — unscoped
 * `total`, reader-scoped `pairs`, `withheld` as their difference, `truncated`
 * for the page cap and `countsConsistent` for two statements disagreeing. A
 * separate type because its `pairs` are a different relation, not because its
 * accounting differs.
 */
export interface BrainVocabularyObjectRadiusSide {
  readonly total: number;
  readonly pairs: readonly BrainVocabularyObjectPair[];
  readonly withheld: number;
  readonly truncated: boolean;
  readonly countsConsistent: boolean;
}

/** One side of a blast-radius delta, as the preview discloses it. */
export interface BrainVocabularyBlastRadiusSide {
  readonly total: number;
  readonly pairs: readonly BrainFactWillSupersedePair[];
  readonly withheld: number;
  readonly truncated: boolean;
  readonly countsConsistent: boolean;
}

/**
 * Whether the predicate slot this decision moves a population INTO is curated
 * `single` — the COMPOUND blast radius, said rather than merely counted.
 *
 * ## Why the count alone was not the disclosure
 *
 * A predicate-position alias moves a claim's `predicate_key`, and the
 * cardinality gate is a lookup ON that key. The engine already follows it, so
 * the arming total is right: approving `is priced at → priced at` into a
 * curated-single `priced at` reports the pairs the merge newly arms. What an
 * approver sees is a LARGER NUMBER WITH NO EXPLANATION OF WHERE IT CAME FROM —
 * *"a number gives magnitude but not kind"*, which is the failure this whole
 * preview surface exists to prevent. ADR-0037 §6's amendment states the
 * mechanism (*supersession is now armed for claims that were safe a moment
 * earlier*) and neither preview alone discloses the consequence.
 *
 * ## Three arms, because "not asked" and "asked, no" are opposite facts
 *
 * A nullable boolean collapses them, and a `false` where the question does not
 * arise is a fabricated zero of the kind
 * {@link BrainVocabularyStructurallyEmptyReason} exists to refuse. Same shape,
 * same reason, as {@link BrainVocabularyAliasEvidence}'s `not-applicable` arm.
 *
 * ⚠️ `targetPredicate` lives ONLY on the answered-yes arm, so a client cannot
 * name a slot on a branch where none was resolved.
 */
export type BrainVocabularyTargetCardinality =
  /**
   * The decision moves no population under a cardinality gate, so the question
   * does not arise: a SUBJECT-position alias (the gate reads `predicate_key`,
   * which a subject alias does not move) and both cardinality verbs (they move
   * the gate itself, and {@link BrainVocabularyStructurallyEmptyReason}'s
   * `already-single` / `not-curated` are that question's answers).
   *
   * The object position never reaches this type at all — it takes its own
   * radius arm.
   */
  | { readonly kind: "not-asked" }
  /** Asked, and the slot the population lands in carries no approved `single` entry. */
  | { readonly kind: "uncurated" }
  /**
   * Asked, and the answer is yes: the population lands in a slot where
   * supersession is ALREADY armed.
   *
   * `targetPredicate` is the norm the counterfactual actually substitutes —
   * `to`'s CURRENT effective target for an approval (not `to` as typed; an
   * existing `to → z` lands the merged population on `z`), and the re-rooted
   * norm itself for a removal. A norm, never a key projection: the same class
   * of value `BrainVocabularyEdgeEntry.toNorm` already carries.
   */
  | { readonly kind: "curated-single"; readonly targetPredicate: string };

/**
 * The counterfactual's answer — a discriminated union, mirroring the engine's.
 *
 * ⚠️ The discrimination is the point and it must survive the wire. Flattened
 * into one record with a nullable reason, a client that read `floor` before
 * checking the reason would render *"at least 0 today, and every future claim in
 * this slot"* for an object-position alias — a sentence that is false (no future
 * claim in that slot can supersede) and is precisely the confident false
 * all-clear the preview exists to prevent.
 */
export type BrainVocabularyBlastRadius =
  | {
      readonly kind: "structurally-empty";
      readonly reason: BrainVocabularyStructurallyEmptyReason;
    }
  | {
      /**
       * An OBJECT-position alias decision — a different KIND of blast radius.
       *
       * ⚠️ Its own arm rather than a `computed` with relabelled sides. The
       * collision rule never reads the object's identity, so an object alias
       * cannot arm or disarm supersession at all; what it changes is what
       * CORROBORATES and what is flagged as contested. Those are different
       * relations, and `BrainVocabularyBlastRadiusSide`'s pair fields
       * (`draftLabel`, `supersededLabel`) would be false statements here.
       */
      readonly kind: "object-position";
      /** Live claim pairs that do not agree about the object today and would after. */
      readonly corroborating: BrainVocabularyObjectRadiusSide;
      /**
       * Pairs that DO agree today and would not after — the removal's half.
       *
       * ⚠️ Its own field rather than one whose meaning depends on the verb.
       * Empty for every approval (a merge only creates agreement) and empty for
       * `corroborating` on every removal, so a client renders whichever is
       * non-empty without having to know which button was pressed.
       */
      readonly separating: BrainVocabularyObjectRadiusSide;
      /**
       * `in-tension-with` edges that already exist between pairs the decision
       * would stop treating as rivals.
       *
       * ⚠️ NOT edges that would be removed — see {@link staleEdgesPersist}.
       */
      readonly tension: BrainVocabularyObjectRadiusSide;
      /**
       * Always true: approving the alias rewrites `object_key` and nothing else,
       * so every advisory edge in {@link tension} survives and becomes a
       * contradiction Atlas still flags between two claims it now treats as
       * agreeing. The surface has to say that, and a literal type is what makes
       * the sentence assertable.
       */
      readonly staleEdgesPersist: true;
      readonly floor: true;
      readonly subtreeTruncated: boolean;
    }
  | {
      readonly kind: "computed";
      readonly arming: BrainVocabularyBlastRadiusSide;
      readonly disarming: BrainVocabularyBlastRadiusSide;
      /**
       * Whether the slot this decision moves a population INTO is curated
       * `single`. A DISCLOSURE of where {@link arming}'s number came from,
       * never a second computation of it — see the type.
       */
      readonly targetCardinality: BrainVocabularyTargetCardinality;
      /** Always true — the count is a FLOOR, and the surface must say so. */
      readonly floor: true;
      readonly subtreeTruncated: boolean;
    };

export interface BrainVocabularyPreviewResponse {
  readonly radius: BrainVocabularyBlastRadius;
}

// ---------------------------------------------------------------------------
// The Pending queue (#5088)
// ---------------------------------------------------------------------------

/**
 * The two kinds sharing one queue.
 *
 * ⚠️ DERIVED from {@link BrainVocabularyPendingEntry}, not hand-written beside
 * it. Independently spelled, a third entry arm would grow the schema union, keep
 * `_PendingEntryArmsCovered` satisfied, keep the tuple pin satisfied — and the
 * `/pending?kind=` filter would silently be unable to select the new kind. This
 * makes the existing tuple pin load-bearing for free.
 */
export type BrainVocabularyPendingKind = BrainVocabularyPendingEntry["kind"];

/** One live claim pair exhibiting the agreement an alias proposal rests on. */
export interface BrainVocabularyAgreementExample {
  readonly subject: string;
  readonly object: string;
  readonly fromPredicate: string;
  readonly toPredicate: string;
}

/**
 * What the corpus says about an alias pair right now.
 *
 * ⚠️ A discriminated union. The structural producer holds two claims in ONE
 * subject slot and compares their predicates, so at an entity position the
 * agreement question is unaskable rather than merely unanswered — and *"0
 * subjects agree"* would tell an approver a warehouse-key proposal is
 * unsupported when its support is of a different kind entirely.
 */
export type BrainVocabularyAliasEvidence =
  | {
      readonly kind: "structural";
      /** Distinct subjects whose live claims exhibit the pair agreeing. Unscoped. */
      readonly subjects: number;
      readonly scopedSubjects: number;
      /** `subjects − scopedSubjects`. Never a silent omission. */
      readonly withheld: number;
      readonly examples: readonly BrainVocabularyAgreementExample[];
      /**
       * The gate that raised the proposal, carried rather than assumed.
       *
       * The count is re-derived at read time and the corpus moves, so an entry
       * can read BELOW its own threshold. A client that hard-coded the number
       * could not say *"this no longer meets the bar that raised it"*.
       */
      readonly threshold: number;
      readonly countsConsistent: boolean;
    }
  | { readonly kind: "not-applicable"; readonly reason: "entity-position" }
  | {
      /**
       * The evidence query drifted — the numbers were never read.
       *
       * ⚠️ Its own arm rather than zeros beside `countsConsistent: false`, and
       * it is `not-applicable`'s argument applied one level down. Flat, a client
       * rendered *"0 distinct subjects have claims that agree (Atlas raises a
       * proposal at 2 — this now reads below the bar that raised it, because the
       * count is re-derived from the corpus as it stands)"* — a confident,
       * specific, WRONG causal explanation for a count nobody read, softened
       * only by a trailing "these counts disagreed". "0 agree", "unaskable" and
       * "unread" are one number and three opposite facts.
       */
      readonly kind: "unreadable";
    };

/** One correction behind a cardinality proposal — the *link* half. */
export interface BrainVocabularyCorrectionExample {
  readonly subject: string;
  readonly fromObject: string;
  readonly toObject: string;
  readonly factId: string;
  readonly at: string;
}

/**
 * A workspace's own correction history at one predicate.
 *
 * ⚠️ TWO numbers on purpose. The repeat gate counts DISTINCT SUBJECTS, not
 * corrections — so {@link subjects} is what crossed the threshold and
 * {@link events} is how many supersessions produced it. Rendering only the
 * second would show a number no gate reads.
 */
export type BrainVocabularyCorrectionEvidence =
  | {
      readonly kind: "behavioral";
      readonly subjects: number;
      readonly events: number;
      readonly scopedSubjects: number;
      readonly withheld: number;
      readonly examples: readonly BrainVocabularyCorrectionExample[];
      readonly threshold: number;
      readonly countsConsistent: boolean;
    }
  | {
      /**
       * The evidence query drifted — see
       * {@link BrainVocabularyAliasEvidence}'s `unreadable` arm. A flat record
       * had the client explaining a zero it never read, and inventing a
       * retraction history to do it.
       */
      readonly kind: "unreadable";
    };

/** The direction a producer claimed, when it could claim one. */
export interface BrainVocabularyPendingDirection {
  readonly fromNorm: string;
  readonly toNorm: string;
}

/** One pending alias proposal. */
export interface BrainVocabularyPendingAlias {
  readonly kind: "alias";
  readonly id: string;
  readonly position: BrainVocabularySlotPosition;
  /**
   * The pair, in the order the row stores it.
   *
   * ⚠️ NOT a direction. For an undirected proposal this is the pair in the order
   * it arrived, and treating that order as a default is the *"implicit first
   * norm wins"* the approval seam refuses.
   */
  readonly pair: readonly [string, string];
  /**
   * The producer's direction, or `null` — and `null` is the COMMON case.
   *
   * ⚠️ A client must never prefill from it or from anything else. Direction
   * reads a positive warehouse allowlist and never the negation of a guard, so
   * unclassifiable, neither-warehouse and both-warehouse all yield undirected —
   * which on a workspace with no warehouse producer is every proposal. A default
   * would launder a deliberate abstention into a machine opinion.
   */
  readonly direction: BrainVocabularyPendingDirection | null;
  readonly sourceClass: string;
  readonly proposedBy: string;
  readonly proposedAt: string;
  /**
   * The producer's rank — structural confidence plus any extractor-hint bonus.
   *
   * ⚠️ A RANK, not a probability. Its only job is to order a queue.
   */
  readonly rank: number;
  readonly evidence: BrainVocabularyAliasEvidence;
}

/** One pending cardinality proposal. */
export interface BrainVocabularyPendingCardinality {
  readonly kind: "cardinality";
  /**
   * A representative live surface for the canonical predicate — and the ADDRESS
   * a decide request uses. Never the predicate key (ADR-0037 §6).
   *
   * ⚠️ `null` means every claim that produced the key has been retracted, so the
   * entry has NO address and cannot be decided from this surface. A client must
   * narrow on `predicateSurface !== null` before offering a decide button.
   *
   * ⚠️ **There is deliberately no `decidable` boolean beside this.** There was,
   * and it was fully derived from this field — so the pair admitted
   * `{ predicateSurface: null, decidable: true }`, which renders exactly the
   * Approve button that 400s: the state the flag was added to prevent, made
   * spellable by the flag. `BrainEpisodeExtraction` states the same rule for the
   * same shape. One field, narrowed at the use site.
   */
  readonly predicateSurface: string | null;
  readonly cardinality: BrainVocabularyCardinality;
  readonly sourceClass: string;
  readonly proposedBy: string;
  readonly proposedAt: string;
  readonly claims: number;
  readonly evidence: BrainVocabularyCorrectionEvidence;
}

export type BrainVocabularyPendingEntry =
  | BrainVocabularyPendingAlias
  | BrainVocabularyPendingCardinality;

export interface BrainVocabularyPendingResponse {
  /** Both kinds, ONE list, newest first. */
  readonly entries: readonly BrainVocabularyPendingEntry[];
  readonly aliasCounts: readonly BrainVocabularyPositionCounts[];
  /**
   * `null` when this queue never asked the cardinality question.
   *
   * ⚠️ TWO causes. The caller filtered the cardinality kind out, **or** filtered
   * to an ENTITY position, where a cardinality proposal cannot exist — it is a
   * predicate-position statement, so the question is skipped rather than asked
   * and answered empty. Neither is "asked and withheld": a client that renders
   * `null` as an ACL boundary tells an approver a grant is hiding rows that
   * cannot exist.
   *
   * ⚠️ Nullable rather than zeroed. A question that was never asked has no
   * answer, and `{ total: 0, scoped: 0, withheld: 0, countsConsistent: true }`
   * renders as a fact — on a queue whose whole purpose is what is awaiting a
   * decision.
   */
  readonly cardinalityCounts: BrainVocabularyPositionCounts | null;
  /** A list was CAPPED. The remedy is to filter. */
  readonly truncated: boolean;
  /**
   * Rows were DROPPED because they would not narrow — no filter reaches them.
   *
   * ⚠️ Separate from {@link truncated} because the two have different remedies
   * and one boolean made the client state the wrong one confidently.
   */
  readonly incomplete: boolean;
}

/** What a decision did. No refusal arm — refusals leave as 4xx. */
export type BrainVocabularyDecideOutcome = "approved" | "rejected" | "nothing_to_decide";

/**
 * ⚠️ DISCRIMINATED on `outcome`, for {@link BrainVocabularyAuthorResponse}'s
 * reason applied verbatim: a field that is meaningless on a branch must not be
 * READABLE on it.
 *
 * Flat, this type forced the route to invent facts on three of its four paths —
 * `removedEdge: false` on an approval and on a lost race, `proposalId: null` on
 * every cardinality decision. `removedEdge` is meaningful only on a rejection
 * (it is what separates *"this pair was refused"* from *"an approved edge was
 * dropped and the corpus re-keyed back"*), and a client could not tell
 * `proposalId: null` *because cardinality* from `null` *because there was
 * nothing to decide*.
 */
export type BrainVocabularyDecideResponse =
  | {
      readonly outcome: Extract<BrainVocabularyDecideOutcome, "approved">;
      /** `null` for a cardinality decision — that table is keyed on a key. */
      readonly proposalId: string | null;
    }
  | {
      readonly outcome: Extract<BrainVocabularyDecideOutcome, "rejected">;
      readonly proposalId: string | null;
      /**
       * A rejection on an APPROVED alias row is a REMOVAL: it dropped the edge,
       * recomputed the closure and re-keyed the corpus. `false` for a plain
       * `pending → rejected`.
       *
       * On this arm only — an approval cannot remove an edge, and a lost race
       * wrote nothing at all, so on those branches the field has no value to
       * report rather than a false one.
       */
      readonly removedEdge: boolean;
    }
  | {
      /**
       * The row was absent, already decided, or another reviewer won the race.
       * Truthful, and never retried into a second apply.
       */
      readonly outcome: Extract<BrainVocabularyDecideOutcome, "nothing_to_decide">;
      readonly proposalId: string | null;
    };

/**
 * A direct authoring attempt that SUCCEEDED.
 *
 * ⚠️ There is no `refused` arm, and its absence is the decision. Refusals leave
 * as 4xx with the seam's own prose in `ErrorSchema.message` and its machine
 * code in `ErrorSchema.error` — the house pattern (`refusalStatus` in
 * `admin-brain-facts.ts`). A `200 { outcome: "refused" }` would put a failed
 * write behind a success status, which every generic client — retry middleware,
 * the admin mutation hook, an SDK — reads as "it worked".
 */
export type BrainVocabularyAuthorOutcome = "authored" | "already_approved";

/**
 * ⚠️ DISCRIMINATED on `outcome`, for `BrainVocabularyBlastRadius`'s reason
 * applied verbatim: a field that is meaningless on a branch must not be
 * READABLE on it.
 *
 * Flat, this type forced the route to invent a fact. `convergedOnProposal` is
 * carried only by the engine's `authored` arm, so the `already_approved` arm had
 * to supply something — and it supplied `true`, which is FALSE whenever the
 * pre-existing approved row was itself hand-authored. That is the common
 * double-submit case, and the field's own docstring says the value decides what
 * the audit trail will read as.
 */
export type BrainVocabularyAuthorResponse =
  | {
      readonly outcome: "authored";
      /** The proposal row behind the edge — written, or converged on. */
      readonly proposalId: string;
      /**
       * The human's decision landed on a proposal a producer had already queued.
       *
       * Worth surfacing rather than flattening: it means the row keeps the
       * producer's `source_class`, so the audit trail will say `seam` where the
       * approver remembers authoring — and 0190's unordered-pair constraint
       * makes converging the only legal outcome, not a choice this seam made.
       */
      readonly convergedOnProposal: boolean;
    }
  | {
      /** The pair was already an approved edge. Nothing was written. */
      readonly outcome: Extract<BrainVocabularyAuthorOutcome, "already_approved">;
      readonly proposalId: string;
    };

export type BrainVocabularyRemoveOutcome = "removed" | "already_removed";

/** Discriminated on `outcome`, for {@link BrainVocabularyAuthorResponse}'s reason. */
export type BrainVocabularyRemoveResponse =
  | {
      readonly outcome: Extract<BrainVocabularyRemoveOutcome, "removed">;
      readonly proposalId: string;
      /**
       * The removal had to CREATE the rejection memory an imported edge lacked.
       *
       * `true` only for an edge the region importer copied without its proposal
       * (#5035). Surfaced because it is the one case where a removal writes a
       * row the approver never saw — and without that row the next producer run
       * would re-propose the pair they just deleted.
       */
      readonly memoryCreated: boolean;
    }
  | {
      /** The pair was already removed. Idempotent, not a failure. */
      readonly outcome: Extract<BrainVocabularyRemoveOutcome, "already_removed">;
      readonly proposalId: string;
    };

/**
 * Curating or un-curating a predicate — the adjudicated record of whether values
 * coexist in a slot.
 *
 * No refusal arm, for {@link BrainVocabularyAuthorResponse}'s reason.
 */
export interface BrainVocabularyCardinalityWriteResponse {
  readonly cardinality: BrainVocabularyCardinality;
}
