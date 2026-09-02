/**
 * Company-brain review-surface wire schemas (#4772, ADR-0036).
 *
 * Single source of truth for `/api/v1/admin/brain-facts` — shared by the
 * route's `@hono/zod-openapi` response contract and the web layer's
 * `useServerDataTable` / `useAdminFetch` runtime parsing, so a rename on one
 * side is a compile error rather than a silently empty queue.
 *
 * `satisfies z.ZodType<T, unknown>` (never `as`) ties each schema to its
 * `@useatlas/types` counterpart, so dropping or renaming a field there fails
 * here. The second type argument is what lets a `readonly T[]` field in the
 * type accept `z.array(...)`'s mutable output — the same spelling
 * `PublishRefusedDraftSchema` uses in `mode.ts`.
 *
 * The enum TUPLES live in this package rather than in `@useatlas/types`: the
 * scaffold installs `@useatlas/types` from the registry, so a new value export
 * there forces a publish-first merge dance on every consuming PR (CLAUDE.md
 * § Publishing). `@useatlas/schemas` is private, so a tuple here costs nothing.
 *
 * `_BrainFactStatusesCovered` below is what keeps the tuple honest: `satisfies
 * readonly T[]` proves each element is a MEMBER of the union, never that the
 * tuple is COMPLETE — so without the exhaustiveness pin, adding a fourth status
 * to `BrainFactReviewStatus` would compile here and then reject the whole page
 * at the browser's `.parse()`.
 */
import { z } from "zod";
import type { WithLooseOptionals } from "./exact-optional";
import type {
  BrainCorrectionVerb,
  BrainEntityRole,
  BrainFactCandidate,
  BrainActorIdentityEraseResponse,
  BrainActorIdentityView,
  BrainFactAttributionView,
  BrainFactDecayLevel,
  BrainFactDecayView,
  BrainFactCandidateListResponse,
  BrainFactRetirableListResponse,
  BrainFactRetirableObservation,
  BrainFactCandidateSummary,
  BrainFactCorrectionResponse,
  BrainFactEpisodeView,
  BrainCoverage,
  BrainCoverageClass,
  BrainCoverageClassAvailable,
  BrainCoverageFreshness,
  BrainCoverageFreshnessCounts,
  BrainCoverageLabelClause,
  BrainCoverageMapEdge,
  BrainCoverageNamedUnit,
  BrainCoverageRatio,
  BrainCoverageSourceClass,
  BrainCoverageTriage,
  BrainCoverageUnitOrigin,
  BrainCoverageUnverifiedReason,
  BrainFactOversight,
  BrainFactOversightBucket,
  BrainEnrollmentCandidateKind,
  BrainEnrollmentDimensionOption,
  BrainEnrollmentDimensionsResponse,
  BrainEnrollmentEntitiesResponse,
  BrainEnrollmentEntityOption,
  BrainEnrollmentEntry,
  BrainEnrollmentListResponse,
  BrainEnrollmentNamingResponse,
  BrainEnrollmentWriteResponse,
  BrainFactOversightBucketKind,
  BrainFactOversightLabelPolicy,
  BrainFactOversightTotals,
  BrainFactPromotionBlock,
  BrainFactProvenanceView,
  BrainFactRetractResponse,
  BrainFactReviewStatus,
  BrainFactTensionForecastRequest,
  BrainFactTensionForecastResponse,
  BrainFactTensionSweepResponse,
  BrainFactTensionView,
  BrainFactWillSupersede,
  BrainFactWillSupersedePair,
  BrainFactWillWiden,
  BrainFactGateAnalytics,
  BrainFactWillWidenEntry,
  BrainResultTier,
  BrainSearchTensionView,
  BrainFactChangeAgent,
  BrainFactPriorVersion,
  BrainFactHistoryView,
  BrainTriageBacklogBucket,
  BrainTriageBacklogResponse,
  BrainTriageRequeueRequest,
  BrainTriageRequeueResponse,
  BrainTriageRuleDescriptor,
  BrainVocabularyAgreementExample,
  BrainVocabularyAliasEvidence,
  BrainVocabularyAuthorResponse,
  BrainVocabularyBlastRadius,
  BrainVocabularyBlastRadiusSide,
  BrainVocabularyCardinalityEntry,
  BrainVocabularyCardinalityWriteResponse,
  BrainVocabularyCorrectionEvidence,
  BrainVocabularyCorrectionExample,
  BrainVocabularyCoverage,
  BrainVocabularyDecideOutcome,
  BrainVocabularyDecideResponse,
  BrainVocabularyEdgeEntry,
  BrainVocabularyInForceResponse,
  BrainVocabularyObjectPair,
  BrainVocabularyObjectRadiusSide,
  BrainVocabularyPendingEntry,
  BrainVocabularyPendingKind,
  BrainVocabularyPendingResponse,
  BrainVocabularyPositionCounts,
  BrainVocabularyPreviewResponse,
  BrainVocabularyRemoveResponse,
  BrainVocabularyCardinality,
  BrainVocabularyScope,
  BrainVocabularySlotPosition,
  BrainVocabularyStructurallyEmptyReason,
  BrainVocabularySurfaceList,
  BrainVocabularySurfaceOption,
  BrainVocabularyTargetCardinality,
} from "@useatlas/types";

/** Mirrors `BRAIN_FACT_STATUSES` in `packages/api/src/lib/brain/types.ts`. */
export const BRAIN_FACT_REVIEW_STATUSES = [
  "draft",
  "published",
  "archived",
] as const satisfies readonly BrainFactReviewStatus[];

/** Compile error if a status is added to the union without joining the tuple. */
type _BrainFactStatusesCovered = [
  Exclude<BrainFactReviewStatus, (typeof BRAIN_FACT_REVIEW_STATUSES)[number]>,
] extends [never]
  ? true
  : never;
const _brainFactStatusesCovered: _BrainFactStatusesCovered = true;
void _brainFactStatusesCovered;

export const BRAIN_ENTITY_ROLES = [
  "subject",
  "object",
] as const satisfies readonly BrainEntityRole[];

/**
 * The `searchBrain` result classes (#4773) — the runtime half of
 * {@link BrainResultTier}.
 *
 * Here rather than in `@useatlas/types` for the reason stated in the module
 * header: a value export there forces a publish-first merge dance. This tuple
 * is what an `include` filter validates against, so it has to exist at runtime.
 *
 * Ordered by ADR-0036's trust ordering (attested 2 → on-record 3 → the
 * outside-the-ordering document class; ADR-0038 Layer 2 wire spellings, #5469), which is ALSO the deterministic
 * tiebreak `fuseRankedLists` applies to equally-relevant rows. One list, so the
 * two cannot drift into disagreeing about which of two tied rows comes first.
 */
export const BRAIN_RESULT_TIERS = [
  "attested",
  "on-record",
  "document",
] as const satisfies readonly BrainResultTier[];

/** Compile error if a class joins the union without joining the tuple. */
type _BrainResultTiersCovered = [
  Exclude<BrainResultTier, (typeof BRAIN_RESULT_TIERS)[number]>,
] extends [never]
  ? true
  : never;
const _brainResultTiersCovered: _BrainResultTiersCovered = true;
void _brainResultTiersCovered;

/**
 * Compile error if the tuple's ORDER or arity changes.
 *
 * Membership and completeness are pinned above; sequence is not, and sequence
 * is load-bearing — `tierRank` in `lib/brain/search.ts` reads the fused
 * tiebreak straight off this array. Alphabetizing the tuple would leave every
 * other gate green while silently making documents win every tie against a
 * reviewed fact. Reordering is a real decision; make it here, deliberately.
 */
type _BrainResultTierOrder = typeof BRAIN_RESULT_TIERS extends readonly [
  "attested",
  "on-record",
  "document",
]
  ? true
  : never;
const _brainResultTierOrder: _BrainResultTierOrder = true;
void _brainResultTierOrder;

/** Narrow an untrusted `include[]` element to the shared vocabulary. */
export function isBrainResultTier(value: unknown): value is BrainResultTier {
  return typeof value === "string" && (BRAIN_RESULT_TIERS as readonly string[]).includes(value);
}

/**
 * The read-time decay vocabulary (#4914) — the runtime half of
 * {@link BrainFactDecayLevel}, in this package for the module header's reason.
 */
export const BRAIN_FACT_DECAY_LEVELS = [
  "fresh",
  "aging",
  "stale",
  "unknown",
] as const satisfies readonly BrainFactDecayLevel[];

/** Compile error if a level joins the union without joining the tuple. */
type _BrainDecayLevelsCovered = [
  Exclude<BrainFactDecayLevel, (typeof BRAIN_FACT_DECAY_LEVELS)[number]>,
] extends [never]
  ? true
  : never;
const _brainDecayLevelsCovered: _BrainDecayLevelsCovered = true;
void _brainDecayLevelsCovered;

/**
 * Review-queue status filter. `all` is a QUERY value only — it is not a fact
 * status and never appears on a row, so it lives here rather than widening the
 * status union.
 *
 * THE single vocabulary: the route validates against it, the web URL parser
 * clamps to it, and the read model's option type is derived from it. Three
 * copies of this list is how a `?status=` the UI can produce and the route
 * rejects gets shipped.
 */
export const BRAIN_FACT_STATUS_FILTERS = [
  ...BRAIN_FACT_REVIEW_STATUSES,
  "all",
] as const;
export type BrainFactStatusFilter = (typeof BRAIN_FACT_STATUS_FILTERS)[number];

/** Narrow an untrusted `?status=` to the shared vocabulary. */
export function isBrainFactStatusFilter(value: unknown): value is BrainFactStatusFilter {
  return (
    typeof value === "string" &&
    (BRAIN_FACT_STATUS_FILTERS as readonly string[]).includes(value)
  );
}

/**
 * `provenance.producer` value stamped by the `proposeFact` entry point
 * (#5482, #5483 — ADR-0036 §T9).
 *
 * The one producer value the review surface branches on: a claim carrying it
 * arrived as a human's own proposal through the agent's confirm flow, not from
 * a connector's extraction pass, and §T9's review-gate-to-exit lock says a
 * reviewer must be able to tell the two apart at a glance. Here rather than in
 * `@atlas/api` because both sides of that label need it — the API writer
 * (`lib/brain/proposal.ts`) and the web queue's origin badge — and the frontend
 * may not import `@atlas/api`, so a second spelling in the browser is how the
 * badge and the writer would drift.
 *
 * `producer` stays `string | null` on the wire: this is not a closed
 * vocabulary, merely the one member two packages must agree on.
 */
export const BRAIN_PROPOSAL_PRODUCER = "proposal";

/**
 * `provenance.producer` value stamped by the autonomous suggester
 * (#5488 — ADR-0036 §T9 lock 1's permitted autonomy).
 *
 * The second producer value the review surface branches on, and the line it
 * draws is the one the issue's acceptance criteria name outright: a reviewer
 * must be able to tell a machine's guess from a person's testimony. A claim
 * carrying {@link BRAIN_PROPOSAL_PRODUCER} is a human's own words, confirmed by
 * that human; a claim carrying this value was inferred by a model from a
 * conversation nobody asked it to mine — same `human`-class session evidence,
 * opposite epistemic standing. `provenance.source` cannot draw that line
 * (both are `human`), which is the same reason the proposal constant exists.
 *
 * Lives here for that constant's exact reason: the API writer
 * (`lib/brain/suggester.ts`) and the web queue's origin badge both need it,
 * and the frontend may not import `@atlas/api`.
 */
export const BRAIN_SUGGESTER_PRODUCER = "suggester";

/**
 * Discriminated on `visible`, for {@link BrainFactEpisodeViewSchema}'s reason
 * and with the same `z.strictObject` on the withheld arm — this is an ACL
 * boundary (#4836), so the withheld shape must be incapable of carrying
 * `sourceId` / `actor` / `occurredAt`, and a producer that started attaching
 * them anyway must fail the response check rather than ship them.
 *
 * A fact's provenance names its FIRST episode; a Slack `sourceId` is
 * `<channelId>:<ts>`. Publish-time grant widening (#4823) can therefore hand a
 * reader who only ever saw the claim restated in public the identity of whoever
 * said it first in private, and when. That triple travels together because it
 * is one disclosure, so it is withheld together.
 *
 * SCOPE, because "fails the response check" is easy to over-read: this schema
 * runs on the REST surface, where `admin-brain-facts.ts` pipes every response
 * through `checked()`. `searchBrain` — the path that reaches agent chat — has
 * no response parse at all, so on that side the guarantee is the discriminated
 * union plus `projectProvenance` being the single constructor, not a runtime
 * check. Both are covered by test; only one is covered by Zod.
 */
/**
 * WHO the claim's `actor` handle is, in the three states ADR-0036 T5's
 * `Amendment (2026-08-25, #5440)` settles on plus the `machine` arm
 * `Amendment (2026-08-26, #5454)` adds.
 *
 * Discriminated on `state` for the same reason `visible` discriminates the
 * arms above: the three carry genuinely different payloads, and a flat object
 * of nullables would let a caller read a `directory` snapshot's stale name off
 * a row that actually resolves LIVE. Each arm is `z.strictObject` so a producer
 * that attached a snapshot to the `atlas` arm - the one case where a snapshot
 * is strictly worse than the live join - fails the response check rather than
 * shipping a name that can never be re-derived.
 *
 * WARNING: this schema is only ever reached through the `visible: true` arm of
 * {@link BrainFactAttributionViewSchema}. That nesting is the ACL property
 * (#4836): a name is a strictly more identifying rendering of `actor`, so it
 * must be withheld under exactly the same predicate, and the withheld arm's
 * `z.strictObject` is what makes carrying one there a parse error.
 */
export const BrainActorIdentityViewSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("atlas"),
    userId: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
  }),
  z.strictObject({
    state: z.literal("directory"),
    displayName: z.string().nullable(),
    realName: z.string().nullable(),
    email: z.string().nullable(),
    snapshotAt: z.string(),
  }),
  // No fields at all, and `strictObject` is what enforces it. A machine has no
  // display name, no snapshot and no erasure question - WHAT produced the claim
  // is already on the wire beside this, verbatim, in `actor`. A future field
  // here would be a second, worse spelling of that handle (#5454).
  z.strictObject({
    state: z.literal("machine"),
  }),
  z.strictObject({
    state: z.literal("opaque"),
    erased: z.boolean(),
  }),
]) satisfies z.ZodType<BrainActorIdentityView, unknown>;

export const BrainFactAttributionViewSchema = z.discriminatedUnion("visible", [
  z.object({
    visible: z.literal(true),
    sourceId: z.string().nullable(),
    actor: z.string().nullable(),
    occurredAt: z.string().nullable(),
    // Null IFF `actor` is null - no author, no identity question. An author
    // Atlas cannot name is the `opaque` arm, which says so out loud.
    actorIdentity: BrainActorIdentityViewSchema.nullable(),
  }),
  z.strictObject({
    visible: z.literal(false),
  }),
]) satisfies z.ZodType<BrainFactAttributionView, unknown>;

export const BrainFactProvenanceViewSchema = z.object({
  source: z.string().nullable(),
  episodeId: z.string().nullable(),
  producer: z.string().nullable(),
  attribution: BrainFactAttributionViewSchema,
  extractedAt: z.string().nullable(),
  reconciledAt: z.string().nullable(),
  provisional: z.boolean(),
  unresolved: z.array(z.enum(BRAIN_ENTITY_ROLES)),
  payloadComplete: z.boolean(),
}) satisfies z.ZodType<BrainFactProvenanceView, unknown>;

/**
 * Discriminated on `visible`, not a boolean beside a row of nullables.
 *
 * This is an ACL boundary: the withheld arm must be structurally incapable of
 * carrying the withheld payload, so that "a second producer forgot to null the
 * body" is a compile error rather than a leak nobody notices. `z.strictObject`
 * on the withheld arm makes it a PARSE error too, on both sides: the route runs
 * every response through `checked()` before it goes out, and the browser parses
 * it again on arrival.
 */
export const BrainFactEpisodeViewSchema = z.discriminatedUnion("visible", [
  z.object({
    visible: z.literal(true),
    id: z.string(),
    source: z.string().nullable(),
    sourceId: z.string().nullable(),
    sourceActor: z.string().nullable(),
    body: z.string().nullable(),
    bodyTruncated: z.boolean(),
    locator: z.string().nullable(),
    occurredAt: z.string().nullable(),
    ingestedAt: z.string().nullable(),
  }),
  z.strictObject({
    visible: z.literal(false),
    id: z.string(),
  }),
]) satisfies z.ZodType<BrainFactEpisodeView, unknown>;

const BrainFactTensionDirectionSchema = z.enum(["from", "to"]);

/**
 * The visible counterpart arm — one schema behind BOTH tension unions, because
 * `BrainFactTensionVisible` is the one type behind both: the review queue and
 * `searchBrain` project the same conflict cluster (#4913,
 * `lib/brain/tensions.ts`) and differ only in their withheld arm.
 */
const BrainFactTensionVisibleSchema = z.object({
  visible: z.literal(true),
  factId: z.string(),
  edgeDirection: BrainFactTensionDirectionSchema,
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
  status: z.enum(BRAIN_FACT_REVIEW_STATUSES),
  validFrom: z.string().nullable(),
  ingestedAt: z.string().nullable(),
  invalidatedAt: z.string().nullable(),
  validTo: z.string().nullable(),
  corroborationCount: z.number().int().nonnegative(),
  provenance: BrainFactProvenanceViewSchema,
});

export const BrainFactTensionViewSchema = z.discriminatedUnion("visible", [
  BrainFactTensionVisibleSchema,
  z.strictObject({
    visible: z.literal(false),
    factId: z.string(),
    edgeDirection: BrainFactTensionDirectionSchema,
  }),
]) satisfies z.ZodType<BrainFactTensionView, unknown>;

/**
 * `searchBrain`'s cluster entry (#4913): the same visible counterpart, but the
 * withheld arm is an aggregated COUNT — the review surface hands a human
 * per-rival opaque handles; the search surface hands an LLM the one number
 * that matters. `z.strictObject` keeps the withheld arm structurally incapable
 * of carrying the claim payload, per the M1 ACL-boundary rule.
 *
 * SCOPE, same as {@link BrainFactAttributionViewSchema}'s note: `searchBrain`
 * has no runtime response parse today, so this schema's job is the
 * compile-time pin against `BrainSearchTensionView` (a drifted field fails the
 * `satisfies` below) and the enforcement seam for any parser that is added
 * later. The runtime guarantee on that path is the discriminated union plus
 * `loadTensions` in `lib/brain/search.ts` being the single constructor.
 */
export const BrainSearchTensionViewSchema = z.discriminatedUnion("visible", [
  BrainFactTensionVisibleSchema,
  z.strictObject({
    visible: z.literal(false),
    withheldCount: z.number().int().positive(),
  }),
]) satisfies z.ZodType<BrainSearchTensionView, unknown>;

/**
 * Who retired the predecessor (#5461, PRD finish condition 5).
 *
 * A discriminated union on `kind`, and the discriminant is the whole ACL- and
 * honesty-bearing property: the `promotion` arm is `z.strictObject`, so a
 * producer that attached an actor to a gate-written supersession fails the
 * `satisfies` here rather than shipping. On that path the replacement's actor
 * is whoever the NEWER claim was extracted from — a person who never touched
 * the old claim — so an actor on that arm is not a missing field, it is an
 * accusation the record does not support.
 */
const BrainFactChangeAgentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("correction"),
    actor: z.string().nullable(),
    actorIdentity: BrainActorIdentityViewSchema.nullable(),
    at: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal("promotion"),
    at: z.string().nullable(),
  }),
]) satisfies z.ZodType<BrainFactChangeAgent, unknown>;

/**
 * The previous answer, or a marker that this reader may not read it (#5461).
 *
 * `z.strictObject` on the withheld arm, per the M1 ACL-boundary rule and for
 * {@link BrainFactAttributionViewSchema}'s exact reason: every field of a prior
 * answer is CONTENT, so the withheld arm has nothing it could carry, and a
 * producer that attached the claim to it must fail this gate rather than
 * disclose it.
 */
export const BrainFactPriorVersionSchema = z.discriminatedUnion("visible", [
  z.object({
    visible: z.literal(true),
    factId: z.string(),
    object: z.string(),
    validFrom: z.string().nullable(),
    validTo: z.string().nullable(),
  }),
  z.strictObject({ visible: z.literal(false) }),
]) satisfies z.ZodType<BrainFactPriorVersion, unknown>;

/**
 * What a claim replaced (#5461, PRD finish condition 5).
 *
 * SCOPE, the same note {@link BrainSearchTensionViewSchema} carries and for the
 * same reason: `searchBrain` has no runtime response parse today, so this
 * schema's job is the compile-time pin against `BrainFactHistoryView` (a
 * drifted field fails the `satisfies` below) and the enforcement seam for any
 * parser added later. The runtime guarantee on that path is the discriminated
 * unions above plus `toHistoryView` in `lib/brain/history.ts` being the single
 * constructor.
 *
 * ⚠️ The refinements are the cross-field backstop, and the first one is a
 * DISCLOSURE boundary rather than a tidiness rule. `priorCount` counts
 * non-retracted ancestors only — a retracted predecessor is excluded from the
 * content AND the count, because `retract` is the GDPR-erasure path (#4916) and
 * a count that survived an erasure would re-disclose it. So a `priorCount`
 * above zero beside a null `prior` is not a variant this surface has; it is the
 * shape an erasure leak would take, and it must be unrepresentable.
 */
export const BrainFactHistoryViewSchema = z
  .object({
    prior: BrainFactPriorVersionSchema.nullable(),
    priorCount: z.number().int().nonnegative(),
    changedBy: BrainFactChangeAgentSchema.nullable(),
    truncated: z.boolean(),
  })
  .refine((v) => (v.prior === null) === (v.priorCount === 0), {
    message:
      "a claim with no previous answer counts none, and a counted ancestor has a previous answer — a count beside a null `prior` is the shape a retracted-predecessor leak would take",
  })
  .refine((v) => (v.prior === null) === (v.changedBy === null), {
    message: "`changedBy` is set if and only if `prior` is — nothing changed it if nothing changed",
  }) satisfies z.ZodType<BrainFactHistoryView, unknown>;

/**
 * `reasons` is `z.string()`, not an enum over the refusal vocabulary. That
 * vocabulary (`FACT_REFUSAL_REASONS`) is closed inside `@atlas/api` on purpose
 * — `@atlas/web` may never import it — and every refusal carries the prose
 * `detail` a surface renders instead of branching on a code. Modelling it as an
 * enum here would mint a second copy of the vocabulary whose only job would be
 * to drift.
 */
export const BrainFactPromotionBlockSchema = z.object({
  reasons: z.array(z.string()),
  detail: z.string(),
}) satisfies z.ZodType<BrainFactPromotionBlock, unknown>;

/**
 * The advisory decay signal (#4914). A plain nullable-fields object rather
 * than a discriminated union: unlike attribution, the withheld-observation and
 * nothing-decoded arms deliberately share one wire shape (a level with null
 * numbers) — while a fact with no observation but a decodable fallback anchor
 * keeps `ageDays` — so there is no discriminant on the wire and no payload a
 * variant would have to be structurally incapable of carrying.
 * `computeDecaySignal` is the single constructor and owns the entitlement
 * decision.
 *
 * The refinements are the cross-field backstop that role otherwise loses:
 * attribution's withheld arm gets `z.strictObject`, so a second producer that
 * attached the withheld payload fails `checked()` on the REST surface — and a
 * decay view carrying numbers the constructor forbids must fail the same gate.
 * (`searchBrain` has no response parse, so on the agent path the constructor
 * stays the only guarantee — the same honest limit the attribution schema
 * documents.)
 */
export const BrainFactDecayViewSchema = z
  .object({
    level: z.enum(BRAIN_FACT_DECAY_LEVELS),
    ageDays: z.number().int().nonnegative().nullable(),
    lastObservedAt: z.string().nullable(),
  })
  .refine((v) => v.level !== "unknown" || (v.ageDays === null && v.lastObservedAt === null), {
    message: "an unknown decay level carries no numbers — an age beside it fabricates a reading",
  })
  .refine((v) => v.lastObservedAt === null || v.ageDays !== null, {
    message: "an observation timestamp never ships without its age — the constructor sets both or neither",
  }) satisfies z.ZodType<BrainFactDecayView, unknown>;

export const BrainFactCandidateSchema = z.object({
  id: z.string(),
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
  status: z.enum(BRAIN_FACT_REVIEW_STATUSES),
  visibleTo: z.array(z.string()),
  malformedGrantIndices: z.array(z.number().int().nonnegative()),
  grantReadable: z.boolean(),
  corroborationCount: z.number().int().nonnegative(),
  provenance: BrainFactProvenanceViewSchema,
  episode: BrainFactEpisodeViewSchema.nullable(),
  tensions: z.array(BrainFactTensionViewSchema),
  promotionBlock: BrainFactPromotionBlockSchema.nullable(),
  decay: BrainFactDecayViewSchema,
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  extractedAt: z.string().nullable(),
  ingestedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
}) satisfies z.ZodType<BrainFactCandidate, unknown>;

export const BrainFactCandidateListResponseSchema = z.object({
  candidates: z.array(BrainFactCandidateSchema),
  total: z.number().int().nonnegative(),
  tensionsTruncated: z.boolean(),
}) satisfies z.ZodType<BrainFactCandidateListResponse, unknown>;

export const BrainFactCandidateSummarySchema = z.object({
  draftTotal: z.number().int().nonnegative(),
  provisionalTotal: z.number().int().nonnegative(),
  inTensionTotal: z.number().int().nonnegative(),
  publishedTotal: z.number().int().nonnegative(),
}) satisfies z.ZodType<BrainFactCandidateSummary, unknown>;

/**
 * `/retract` runs the `retract` correction VERB, so it discloses what that
 * verb produces (#4939): the correction episode and the flagged dependents.
 * Both were reaching `logAdminAction` metadata only, which left the console
 * reviewer — the one who pressed the button — told nothing, while the docs
 * said the flags "come back in `flaggedForReReview`".
 */
export const BrainFactRetractResponseSchema = z.object({
  id: z.string(),
  invalidatedAt: z.string(),
  correctionEpisodeId: z.string(),
  flaggedForReReview: z.array(z.string()),
}) satisfies z.ZodType<BrainFactRetractResponse, unknown>;

/**
 * The tension sweep's report (#5029).
 *
 * `z.strictObject`, unlike its neighbours above: this response is
 * WORKSPACE-WIDE, so the reader-scoping every other write on this router relies
 * on does not apply to it. A future producer attaching the pairs it minted —
 * the obvious next feature request, and the obvious way to answer *"in tension
 * with what?"* — would be disclosing claims across every grant in the
 * workspace. Strict makes that fail here, at the ACL boundary, rather than in a
 * browser. The `/oversight` route's `z.strictObject` withholds are the
 * precedent.
 */
/**
 * The actor-identity erasure's report (#5440).
 *
 * `z.strictObject` for `BrainFactTensionSweepResponseSchema`'s reason, one
 * domain over: the obvious next thing a producer would attach is the list of
 * claims that just went opaque, and that list is this person's whole presence
 * in the record - across every grant in the workspace, to a caller who asked
 * only to remove a name. Strict makes attaching it a parse failure at the ACL
 * boundary rather than a disclosure in a browser.
 */
export const BrainActorIdentityEraseResponseSchema = z.strictObject({
  erased: z.literal(true),
  actor: z.string(),
}) satisfies z.ZodType<BrainActorIdentityEraseResponse, unknown>;

export const BrainFactTensionSweepResponseSchema = z.strictObject({
  minted: z.number().int().nonnegative(),
  truncated: z.boolean(),
}) satisfies z.ZodType<BrainFactTensionSweepResponse, unknown>;

/**
 * Longest predicate surface a forecast will accept.
 *
 * The same bound the correction verbs put on an SPO column: this is a
 * predicate, not a document, and an unbounded string reaching `lexicalNorm` is
 * a request-shaped way to spend a pooled connection's CPU.
 */
export const BRAIN_TENSION_FORECAST_SURFACE_MAX_CHARS = 2_000;

export const BrainFactTensionForecastRequestSchema = z.strictObject({
  predicateSurface: z.string().min(1).max(BRAIN_TENSION_FORECAST_SURFACE_MAX_CHARS).optional(),
}) satisfies z.ZodType<WithLooseOptionals<BrainFactTensionForecastRequest>, unknown>;

/**
 * ⚠️ A `discriminatedUnion`, not a record with a nullable count — see
 * `BrainFactTensionForecastResponse`. `z.strictObject` on BOTH arms for
 * `BrainFactTensionSweepResponseSchema`'s reason, and the obvious next thing a
 * producer would attach here is the PAIRS it counted: that is a workspace-wide
 * projection of claims on a router where every other read is scoped to the
 * caller's own grants, and strict makes attaching it a parse failure at the ACL
 * boundary rather than a disclosure in a browser.
 */
export const BrainFactTensionForecastResponseSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("forecast"),
    wouldMint: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("unkeyable-surface") }),
]) satisfies z.ZodType<BrainFactTensionForecastResponse, unknown>;

// ---------------------------------------------------------------------------
// Correction verbs — `correct_fact` (#4915)
// ---------------------------------------------------------------------------

/** Mirrors `CORRECTION_VERBS` in `packages/api/src/lib/brain/correction.ts`. */
export const BRAIN_CORRECTION_VERBS = [
  "retract",
  "supersede",
  "re-authority",
  "pin",
] as const satisfies readonly BrainCorrectionVerb[];

/** Compile error if a verb joins the union without joining the tuple. */
type _BrainCorrectionVerbsCovered = [
  Exclude<BrainCorrectionVerb, (typeof BRAIN_CORRECTION_VERBS)[number]>,
] extends [never]
  ? true
  : never;
const _brainCorrectionVerbsCovered: _BrainCorrectionVerbsCovered = true;
void _brainCorrectionVerbsCovered;

/** Narrow an untrusted verb string to the shared vocabulary. */
export function isBrainCorrectionVerb(value: unknown): value is BrainCorrectionVerb {
  return (
    typeof value === "string" && (BRAIN_CORRECTION_VERBS as readonly string[]).includes(value)
  );
}

/** Longest free-text `reason` accepted — recorded verbatim in the episode body. */
export const BRAIN_CORRECTION_REASON_MAX_CHARS = 2_000;

/** Longest replacement object accepted — an SPO column, not a document. */
export const BRAIN_CORRECTION_OBJECT_MAX_CHARS = 2_000;

/**
 * The `POST /api/v1/admin/brain-facts/{id}/correct` request body. The target
 * fact id travels in the path; `replacement` is required for `supersede`
 * (enforced in the verb machinery, where the refusal carries actionable
 * prose) and ignored elsewhere.
 */
export const BrainFactCorrectRequestSchema = z.object({
  verb: z.enum(BRAIN_CORRECTION_VERBS),
  reason: z.string().max(BRAIN_CORRECTION_REASON_MAX_CHARS).optional(),
  replacement: z
    .object({
      object: z.string().min(1).max(BRAIN_CORRECTION_OBJECT_MAX_CHARS),
      /**
       * When the corrected value began to hold. Validated as ISO-8601 HERE —
       * a 400 with a field path, not a silent degrade: this is a human's
       * stated temporal boundary on a supersession, and discarding a
       * malformed one quietly would bake the wrong `valid_from` into an
       * immutable published fact. (`offset` admits `+02:00` spellings, not
       * just `Z` — a correction is typed by a person, not a serializer.)
       */
      validFrom: z.string().datetime({ offset: true }).optional(),
    })
    .optional(),
});
export type BrainFactCorrectRequest = z.infer<typeof BrainFactCorrectRequestSchema>;

export const BrainFactCorrectionResponseSchema = z.object({
  verb: z.enum(BRAIN_CORRECTION_VERBS),
  factId: z.string(),
  correctionEpisodeId: z.string(),
  invalidatedAt: z.string().nullable(),
  flaggedForReReview: z.array(z.string()),
  supersededBy: z.string().nullable(),
  validTo: z.string().nullable(),
}) satisfies z.ZodType<BrainFactCorrectionResponse, unknown>;

// ---------------------------------------------------------------------------
// proposeFact — the net-new claim verb (#5482, ADR-0036 §T7)
// ---------------------------------------------------------------------------

/**
 * Longest subject / predicate / object surface a proposal accepts.
 *
 * Equal to {@link BRAIN_CORRECTION_OBJECT_MAX_CHARS} and deliberately a
 * SEPARATE constant rather than an alias of it. Both bound `brain_facts`' SPO
 * columns and so land on the same number today, but they bound different write
 * paths with different authority bars — an alias would make a future decision to
 * loosen or tighten one silently move the other, which is the drift the
 * correction constants exist to prevent within their own path.
 *
 * One constant for all three positions, not three: they are the same column
 * family, and a per-position cap would be a distinction the schema does not
 * make.
 */
export const BRAIN_PROPOSAL_SURFACE_MAX_CHARS = 2_000;

/** Longest free-text `reason` a proposal accepts — recorded verbatim in the episode body. */
export const BRAIN_PROPOSAL_REASON_MAX_CHARS = 2_000;

/**
 * The claim a `proposeFact` call asserts — the ONE declaration of its five
 * fields, shared by the agent tool's `inputSchema` and the confirm endpoint's
 * request body.
 *
 * Shared rather than restated on each side, and that is a correctness property
 * rather than tidiness. The confirm token binds a canonical hash of exactly
 * these fields: the tool mints over what IT accepted and the endpoint verifies
 * over what IT accepted, so two independently-maintained validators on one write
 * path can drift into a state where a payload the tool staged is one the
 * endpoint rejects — or, worse, where a field one side coerces and the other
 * does not hashes differently on the two sides and every proposal carrying it
 * fails its own confirm. `BRAIN_CORRECTION_*_MAX_CHARS` exists for the weaker
 * version of the same hazard (three copies of one bound); this is the whole
 * shape.
 *
 * ⚠️ The field descriptions are load-bearing on the TOOL side — they are what
 * the model reads when deciding how to phrase a claim — and they are carried
 * here rather than added at the tool so the two sides cannot diverge on what a
 * subject or predicate is supposed to look like. They read as ordinary API
 * guidance on the endpoint side, which is why sharing them costs nothing.
 *
 * Deliberately NOT extended with `token`: that is the confirm endpoint's
 * concern, added at the route (`api/routes/brain-proposals.ts`), and a tool
 * `inputSchema` that advertised a token field would invite the model to invent
 * one.
 */
export const BrainProposalClaimSchema = z.object({
  subject: z
    .string()
    .min(1)
    .max(BRAIN_PROPOSAL_SURFACE_MAX_CHARS)
    .describe("What the claim is about — a person, team, product, or account. Short and literal."),
  predicate: z
    .string()
    .min(1)
    .max(BRAIN_PROPOSAL_SURFACE_MAX_CHARS)
    .describe(
      'The relationship, phrased as a verb clause: "is the DRI for", "reports to", "is priced at".',
    ),
  object: z
    .string()
    .min(1)
    .max(BRAIN_PROPOSAL_SURFACE_MAX_CHARS)
    .describe("The asserted value — what the subject and predicate resolve to."),
  validFrom: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe("ISO-8601 timestamp: when the claim began to hold. Defaults to now."),
  reason: z
    .string()
    .max(BRAIN_PROPOSAL_REASON_MAX_CHARS)
    .optional()
    .describe(
      "Why the user believes this — recorded verbatim in the proposal episode and shown to the reviewer.",
    ),
});
export type BrainProposalClaim = z.infer<typeof BrainProposalClaimSchema>;

// ---------------------------------------------------------------------------
// Admin oversight — counts without content (#4825)
// ---------------------------------------------------------------------------

export const BRAIN_FACT_OVERSIGHT_BUCKET_KINDS = [
  "org",
  "audience",
  "role",
  "user",
  "malformed",
] as const satisfies readonly BrainFactOversightBucketKind[];

/** Compile error if a kind joins the union without joining the tuple. */
type _BrainOversightKindsCovered = [
  Exclude<BrainFactOversightBucketKind, (typeof BRAIN_FACT_OVERSIGHT_BUCKET_KINDS)[number]>,
] extends [never]
  ? true
  : never;
const _brainOversightKindsCovered: _BrainOversightKindsCovered = true;
void _brainOversightKindsCovered;

export const BRAIN_FACT_OVERSIGHT_LABEL_POLICIES = [
  "intrinsic",
  "configured",
  "discovered",
] as const satisfies readonly BrainFactOversightLabelPolicy[];

/** Compile error if a policy joins the union without joining the tuple. */
type _BrainOversightPoliciesCovered = [
  Exclude<BrainFactOversightLabelPolicy, (typeof BRAIN_FACT_OVERSIGHT_LABEL_POLICIES)[number]>,
] extends [never]
  ? true
  : never;
const _brainOversightPoliciesCovered: _BrainOversightPoliciesCovered = true;
void _brainOversightPoliciesCovered;

/** The five state counters, spelled once — mirrors the type's own `extends`. */
const OVERSIGHT_COUNTER_FIELDS = {
  awaitingReview: z.number().int().nonnegative(),
  published: z.number().int().nonnegative(),
  retracted: z.number().int().nonnegative(),
  provisional: z.number().int().nonnegative(),
  inTension: z.number().int().nonnegative(),
} as const;

export const BrainFactOversightTotalsSchema = z.strictObject({
  ...OVERSIGHT_COUNTER_FIELDS,
}) satisfies z.ZodType<BrainFactOversightTotals, unknown>;

/**
 * A DISCRIMINATED UNION on `labelPolicy`, and that is the enforcement rather
 * than a convention — exactly the treatment {@link BrainFactEpisodeViewSchema}
 * gets, for exactly the same reason.
 *
 * This is the surface whose whole contract is COUNTS AND NO CONTENT, and the
 * `discovered` arm is an ACL boundary: it is `z.strictObject` with NO `label`
 * key, so a producer that attached the withheld channel id fails HERE — at the
 * boundary, in both directions, since the route runs every response through
 * `checked()` and the browser parses it again on arrival. The first cut typed
 * this as a flat `label: string | null`, under which
 * `{ kind: "user", labelPolicy: "configured", label: "user:usr_abc" }`
 * type-checked, parsed, and rendered.
 *
 * Both arms are strict, so an extra key is REFUSED rather than stripped. The
 * envelope schemas elsewhere in this file are `z.object`, which strips — that
 * would ship a response quietly dropping an attached `subject` in one direction
 * and carrying it the day somebody widened the type.
 *
 * `key` and `label` are the TWO free-text fields, and on the disclosable arms
 * they carry the same value — the grant token (`org`,
 * `audience:chat-channel:slack:C0…`). On the withheld arm `label` is gone and
 * `key` is a positional handle (`discovered-1`). Saying "label is the only one"
 * would send an auditor to check one field and miss the one that stays a plain
 * string in both arms. Everything else here is a number or a closed enum. The
 * no-content property is pinned by test, because a schema cannot tell a channel
 * id from a sentence.
 */
export const BrainFactOversightBucketSchema = z.discriminatedUnion("labelPolicy", [
  z.strictObject({
    labelPolicy: z.literal("intrinsic"),
    key: z.string(),
    kind: z.enum(BRAIN_FACT_OVERSIGHT_BUCKET_KINDS),
    label: z.string(),
    ...OVERSIGHT_COUNTER_FIELDS,
  }),
  z.strictObject({
    labelPolicy: z.literal("configured"),
    key: z.string(),
    kind: z.enum(BRAIN_FACT_OVERSIGHT_BUCKET_KINDS),
    label: z.string(),
    ...OVERSIGHT_COUNTER_FIELDS,
  }),
  z.strictObject({
    labelPolicy: z.literal("discovered"),
    key: z.string(),
    kind: z.enum(BRAIN_FACT_OVERSIGHT_BUCKET_KINDS),
    ...OVERSIGHT_COUNTER_FIELDS,
  }),
]) satisfies z.ZodType<BrainFactOversightBucket, unknown>;

/**
 * One supersession the next publish will perform (#4912). Strict on both arms'
 * behalf: unlike the oversight buckets this DOES carry content (both SPO
 * claims), which is legitimate — the list is reader-ACL-scoped, per the type —
 * but exactly because content is allowed here, an extra key must be refused
 * rather than stripped: this is the one object in the oversight envelope where
 * "somebody attached the provenance payload" would otherwise ship.
 */
export const BrainFactWillSupersedePairSchema = z.strictObject({
  draftId: z.string(),
  draftLabel: z.string(),
  supersededId: z.string(),
  supersededLabel: z.string(),
}) satisfies z.ZodType<BrainFactWillSupersedePair, unknown>;

export const BrainFactWillSupersedeSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  pairs: z.array(BrainFactWillSupersedePairSchema),
  withheld: z.number().int().nonnegative(),
  truncated: z.boolean(),
}) satisfies z.ZodType<BrainFactWillSupersede, unknown>;

/**
 * One grant the next publish will widen (#5032). Strict for
 * {@link BrainFactWillSupersedePairSchema}'s reason verbatim: this object
 * carries CONTENT (the SPO label) legitimately, because the list is
 * reader-ACL-scoped — and exactly because content is allowed, an extra key must
 * be refused rather than stripped.
 *
 * `added` is NON-EMPTY, which is the disclosure's design restated at the wire:
 * widening fires on legitimate corroboration too, so a notice that could carry
 * an empty `added` would be universal, and the reviewer learns to click through
 * it.
 *
 * ⚠️ It is spelled as a one-plus-rest TUPLE and NOT as `.nonempty()`, and the
 * difference is the whole enforcement — see the note on the field. Zod v4 infers
 * `string[]` from `.nonempty()`, so under that spelling
 * `satisfies z.ZodType<BrainFactWillWidenEntry, unknown>` passes on this axis
 * whatever the type says; the tuple is what makes the `satisfies` actually check
 * it. Two guards, not one: the TYPE (`readonly [string, ...string[]]`, which
 * `widenGrantFromEvidence` already produces) and this line checking itself
 * against it.
 */
export const BrainFactWillWidenEntrySchema = z.strictObject({
  factId: z.string(),
  label: z.string(),
  // `z.tuple([z.string()], z.string())` — one required element plus a rest —
  // and NOT `z.array(z.string()).nonempty()`. The two accept the identical set
  // of values at runtime; only this one INFERS `[string, ...string[]]`, which is
  // what makes the `satisfies` below check non-emptiness instead of passing
  // vacuously. (Measured: with `.nonempty()` the type is `string[]`, and
  // tightening `BrainFactWillWidenEntry.added` to a tuple made this line a
  // compile error — which is the guard working.)
  added: z.tuple([z.string()], z.string()),
}) satisfies z.ZodType<BrainFactWillWidenEntry, unknown>;

/**
 * The envelope WITHOUT the cross-check, which is what the client gets.
 *
 * Split out in #5032's panel round 4. The refinement below is right on the
 * server and wrong on the client, for the reason stated 60 lines down about
 * `countsConsistent` — and until the split it rode onto the client anyway via
 * `.optional()`, which defends the field being ABSENT and does nothing about the
 * field being present and failing a refinement.
 *
 * The consequence was specific: a producer-side arithmetic bug — the thing the
 * refinement exists to catch — made `safeParse` fail on the whole oversight
 * envelope, and `useAdminFetch` hard-throws `schema_mismatch` on that. So a
 * headline that would have UNDER-stated a widening instead took down the
 * hidden-backlog alert, the supersession preview and the widening notice at
 * once, in one request. Failing the entire surface closed over somebody else's
 * already-shipped bug is the trade this codebase declines everywhere else.
 *
 * Still `strictObject`: unknown-key rejection is a leak guard, not a
 * cross-check, and it is the half the client should keep.
 */
const BrainFactWillWidenEnvelopeSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  entries: z.array(BrainFactWillWidenEntrySchema),
  truncated: z.boolean(),
  incomplete: z.boolean(),
});

export const BrainFactWillWidenSchema = BrainFactWillWidenEnvelopeSchema
  .superRefine((value, ctx) => {
    // `total` is taken BEFORE the cap, so it can never be smaller than the list
    // it summarizes. A producer that got this wrong would render a headline
    // UNDER-stating a visible list of ACL changes, which is the one direction
    // this surface must not fail in — so it is a 500 with a requestId rather
    // than something the panel has to defend against with a `Math.max`.
    if (value.entries.length > value.total) {
      ctx.addIssue({
        code: "custom",
        path: ["total"],
        message:
          "the will-widen total is below the number of entries shipped — the headline would understate a list of ACL changes the reader can see",
      });
    }
  }) satisfies z.ZodType<BrainFactWillWiden, unknown>;

const OVERSIGHT_ENVELOPE_FIELDS = {
  buckets: z.array(BrainFactOversightBucketSchema),
  workspaceTotals: BrainFactOversightTotalsSchema,
  reviewableAwaitingReview: z.number().int().nonnegative(),
  countsConsistent: z.boolean(),
  distinctAudiences: z.number().int().nonnegative(),
  bucketsTruncated: z.boolean(),
} as const;

/**
 * The review gate's decision counts (#5335), reader-scoped.
 *
 * `approvalRate` is `.nullable()` and NOT defaulted to 0 — "nothing decided
 * yet" and "every claim rejected" are different states, and a schema that
 * collapsed the first into the second would make the panel report an alarming
 * reviewer where there is simply a new workspace. The refinement pins the
 * arithmetic rather than trusting the producer: a rate that disagrees with the
 * counts beside it is a producer bug whose only symptom would otherwise be a
 * number an admin acts on.
 */
export const BrainFactGateAnalyticsSchema = z
  .strictObject({
    positives: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    approvalRate: z.number().min(0).max(1).nullable(),
  })
  .superRefine((value, ctx) => {
    const decided = value.positives + value.rejected;
    if (decided === 0 && value.approvalRate !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["approvalRate"],
        message:
          "approvalRate is a number with nothing decided — an unstarted queue must read null, not a rate",
      });
      return;
    }
    if (decided > 0 && value.approvalRate === null) {
      ctx.addIssue({
        code: "custom",
        path: ["approvalRate"],
        message:
          "approvalRate is null with decided claims present — the rate this panel exists to show would render as 'no decisions yet'",
      });
    }
  }) satisfies z.ZodType<BrainFactGateAnalytics, unknown>;

/**
 * The strict server-side contract. `admin-brain-facts.ts` parses every response
 * through this before it goes out, so a producer that broke the no-content rule
 * gets a 500 with a requestId instead of shipping.
 *
 * ## The refinements, and why only the server gets them
 *
 * `countsConsistent` and `distinctAudiences` are CROSS-CHECKS whose own operands
 * are on the wire beside them, so each admits a state where the flag and the
 * numbers contradict each other — and the panel trusts the flag while computing
 * the delta from the numbers, which would render a NEGATIVE hidden backlog. The
 * refinements make a producer that got either wrong a 500 with a requestId,
 * which is the posture the rest of this surface keeps.
 *
 * They are deliberately absent from the client schema. There, a contradiction
 * is somebody else's already-shipped bug, and refusing to render would take the
 * hidden-backlog alert down over it — failing closed for consistency at the
 * cost of failing open for the disclosure.
 */
export const BrainFactOversightSchema = z
  .strictObject({
    ...OVERSIGHT_ENVELOPE_FIELDS,
    // REQUIRED server-side even though the TYPE marks it optional: the
    // optionality exists for the CLIENT's deploy-skew window, and a server
    // that stopped emitting it would silently retire the will-supersede
    // disclosure — the "no silent supersession" rule enforced as a parse.
    willSupersede: BrainFactWillSupersedeSchema,
    // Required server-side on the identical argument (#5032): a server that
    // stopped emitting this retires the review-gate widening notice, which is
    // the only thing standing between an unresolvable subject homonym and a
    // private claim's body reaching a public audience.
    willWiden: BrainFactWillWidenSchema,
    // Required server-side on `willSupersede`'s argument (#5335): a server that
    // stopped emitting this silently retires the gate-decision panel, which is
    // the only thing this ticket ships before any model work exists.
    gateAnalytics: BrainFactGateAnalyticsSchema,
  })
  .superRefine((value, ctx) => {
    if (
      value.countsConsistent &&
      value.reviewableAwaitingReview > value.workspaceTotals.awaitingReview
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["countsConsistent"],
        message:
          "countsConsistent is true but the reader-scoped draft count exceeds the workspace count — the delta this surface exists to report would render negative",
      });
    }
    if (value.distinctAudiences < value.buckets.length) {
      ctx.addIssue({
        code: "custom",
        path: ["distinctAudiences"],
        message:
          "distinctAudiences is below the number of buckets shipped — the buckets are a subset of the distinct tokens, so this understates a cardinality the client renders as exact",
      });
    }
  }) satisfies z.ZodType<WithLooseOptionals<BrainFactOversight>, unknown>;

/**
 * The BROWSER's parser. Same fields, additive-tolerant at the envelope.
 *
 * Strict is right on the server, where a violation must be a 500. On the client
 * it would turn any ADDITIVE API field into a total panel failure during an
 * api/web deploy skew — and the thing that disappears is the hidden-backlog
 * alert itself, so failing closed for confidentiality would mean failing OPEN
 * for the disclosure. `useAdminFetch` hard-throws `schema_mismatch` on a parse
 * failure, so this is not theoretical.
 *
 * The BUCKETS stay strict. A bucket arm is the ACL boundary, and a browser that
 * passed an unexpected `subject` through to the DOM is the leak; an admin
 * losing the breakdown during a deploy window is not. Different failure costs,
 * different postures — the same reason `publish-modal.tsx` types
 * `brainFactsWithheld` optional.
 *
 * The honest limit of the split: an additive field INSIDE a bucket still fails
 * the whole parse, so the tolerance buys envelope growth only. That outcome is
 * a loud error Alert rather than a false all-clear, so it is the right way to
 * fail — just narrower than "additive changes are safe".
 */
export const BrainFactOversightClientSchema = z.object({
  ...OVERSIGHT_ENVELOPE_FIELDS,
  // Optional HERE and only here: an older API omits the field during a deploy
  // window, and the panel then renders no supersession notice — the pre-#4912
  // behaviour — rather than losing the whole oversight surface. The pair
  // objects themselves stay strict for the bucket-arm reason above.
  willSupersede: BrainFactWillSupersedeSchema.optional(),
  // Optional HERE and only here, for `willSupersede`'s reason: during a deploy
  // window an older API omits it and the panel renders no widening notice —
  // the pre-#5032 behaviour — rather than losing the whole oversight surface
  // and with it the hidden-backlog alert.
  //
  // ⚠️ And the UN-refined envelope, which is the other half of that same
  // sentence. `.optional()` alone covers the field being absent; it does nothing
  // when the field is present and trips a cross-check, which would fail the
  // whole envelope for a producer bug that can only ever under-state one
  // headline. The refinements are server-side on purpose — see
  // `BrainFactWillWidenEnvelopeSchema`.
  willWiden: BrainFactWillWidenEnvelopeSchema.optional(),
  // Optional HERE and only here, for `willSupersede`'s reason: during a deploy
  // window an older API omits it and the panel renders no gate-decision block
  // rather than losing the whole oversight surface — and with it the
  // hidden-backlog alert, which is the costlier loss.
  gateAnalytics: BrainFactGateAnalyticsSchema.optional(),
}) satisfies z.ZodType<WithLooseOptionals<BrainFactOversight>, unknown>;


// ---------------------------------------------------------------------------
// The Coverage Surface — the availability arm (#5214/#5215, ADR-0041)
// ---------------------------------------------------------------------------

/**
 * The class axis, as a parse-time enum.
 *
 * The tuple is the THIRD copy of this list — `sources.ts`'s
 * `EPISODE_SOURCE_CLASSES` is the declaration, `BrainCoverageSourceClass` is the
 * published mirror, and this is the runtime one. Two pins keep the three the
 * same set: `coverage.ts`'s `_COVERAGE_CLASS_AXIS_IN_SYNC` binds the first two,
 * and the `satisfies` plus `_BrainCoverageClassesCovered` below bind the second
 * to this one in both directions.
 *
 * It matters more here than for the other enums in this file, because
 * {@link BrainCoverageSchema}'s `availability` object is BUILT from this tuple:
 * a class missing from it is a key the parse would not require, and an absent
 * key would render as a class with nothing to say — the opposite statement from
 * a class that has nothing to say.
 */
export const BRAIN_COVERAGE_SOURCE_CLASSES = [
  "chat",
  "transcript",
  "email",
  "warehouse",
  "human",
] as const satisfies readonly BrainCoverageSourceClass[];

/** Compile error if a class joins the union without joining the tuple. */
type _BrainCoverageClassesCovered = [
  Exclude<BrainCoverageSourceClass, (typeof BRAIN_COVERAGE_SOURCE_CLASSES)[number]>,
] extends [never]
  ? true
  : never;
const _brainCoverageClassesCovered: _BrainCoverageClassesCovered = true;
void _brainCoverageClassesCovered;

/**
 * The unit vocabulary — and the reason no client can spell a blended
 * percentage.
 *
 * Closed at the parse rather than left as `z.string()`, unlike most unions in
 * this file: the resilience argument (a new API value should not blank an old
 * page) inverts here. A unit slug this bundle does not know is a ratio whose
 * denominator caption it cannot write, and the caption — *"of what Atlas's
 * credentials can see"*, per unit — is the honesty rule. Rendering the number
 * with no caption is the failure ADR-0041 exists to prevent, so refusing is the
 * correct direction.
 */
export const BRAIN_COVERAGE_UNIT_ORIGINS = [
  "chat-channel-roster",
  "granted-recording-scopes",
  "mailbox-list",
  "semantic-layer-enrollment",
] as const satisfies readonly BrainCoverageUnitOrigin[];

/** Compile error if a unit joins the union without joining the tuple. */
type _BrainCoverageUnitsCovered = [
  Exclude<BrainCoverageUnitOrigin, (typeof BRAIN_COVERAGE_UNIT_ORIGINS)[number]>,
] extends [never]
  ? true
  : never;
const _brainCoverageUnitsCovered: _BrainCoverageUnitsCovered = true;
void _brainCoverageUnitsCovered;

/**
 * The map edges — state 3, as marks.
 *
 * ⚠️ The drift direction here is the FLATTERING one, which is why the enum is
 * closed and pinned rather than tolerant: an arm the parser drops is a mark that
 * vanishes, and an empty `mapEdges` is the one place this surface says *"the map
 * of what these credentials can see is complete"*. A tolerant `z.string()` that
 * let an unknown arm through would be rendered as a mark with no sentence, which
 * is the same disclosure failing differently.
 */
export const BRAIN_COVERAGE_MAP_EDGES = [
  "chat-public-roster-unreadable",
  "chat-public-roster-truncated",
  "chat-activity-unreadable",
  "chat-unit-ids-unrecognised",
  "warehouse-entity-bound-reached",
  "warehouse-entity-unreadable",
] as const satisfies readonly BrainCoverageMapEdge[];

/** Compile error if a map edge joins the union without joining the tuple. */
type _BrainCoverageMapEdgesCovered = [
  Exclude<BrainCoverageMapEdge, (typeof BRAIN_COVERAGE_MAP_EDGES)[number]>,
] extends [never]
  ? true
  : never;
const _brainCoverageMapEdgesCovered: _BrainCoverageMapEdgesCovered = true;
void _brainCoverageMapEdgesCovered;

/** Which of ADR-0041's two clauses admitted a label. */
export const BRAIN_COVERAGE_LABEL_CLAUSES = [
  "deliberate-act",
  "vendor-public",
] as const satisfies readonly BrainCoverageLabelClause[];

/** Compile error if a clause joins the union without joining the tuple. */
type _BrainCoverageClausesCovered = [
  Exclude<BrainCoverageLabelClause, (typeof BRAIN_COVERAGE_LABEL_CLAUSES)[number]>,
] extends [never]
  ? true
  : never;
const _brainCoverageClausesCovered: _BrainCoverageClausesCovered = true;
void _brainCoverageClausesCovered;

/** Why a unit carries no measured lag — six reasons, one sentence. */
export const BRAIN_COVERAGE_UNVERIFIED_REASONS = [
  "no-activity-metadata",
  "not-probed",
  "enumeration-unavailable",
  "reading-expired",
  "unreadable-reading",
  "unresolvable-class",
] as const satisfies readonly BrainCoverageUnverifiedReason[];

/** Compile error if a reason joins the union without joining the tuple. */
type _BrainCoverageReasonsCovered = [
  Exclude<BrainCoverageUnverifiedReason, (typeof BRAIN_COVERAGE_UNVERIFIED_REASONS)[number]>,
] extends [never]
  ? true
  : never;
const _brainCoverageReasonsCovered: _BrainCoverageReasonsCovered = true;
void _brainCoverageReasonsCovered;

/**
 * One surveyed unit's freshness. Every arm is `z.strictObject`, and that is what
 * keeps *stale* a measurement rather than a badge: the `stale` arm cannot be
 * spelled without both instants and the threshold, and no arm can carry a stray
 * key a renderer might prefer to the arithmetic.
 *
 * The `unverified-since` arm's `since` is `.nullable()` and deliberately NOT
 * defaulted: `null` is the class that has never established anything, and a
 * client that substituted `now` would turn "we have never looked" into "we
 * looked just now".
 */
export const BrainCoverageFreshnessSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("current"),
    checkedAt: z.string(),
  }),
  z.strictObject({
    kind: z.literal("stale"),
    vendorActivityAt: z.string(),
    newestEvidenceAt: z.string(),
    lagMs: z.number().int().nonnegative(),
    cadenceMs: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("unverified-since"),
    since: z.string().nullable(),
    reason: z.enum(BRAIN_COVERAGE_UNVERIFIED_REASONS),
  }),
]) satisfies z.ZodType<BrainCoverageFreshness, unknown>;

export const BrainCoverageFreshnessCountsSchema = z.strictObject({
  current: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  unverified: z.number().int().nonnegative(),
}) satisfies z.ZodType<BrainCoverageFreshnessCounts, unknown>;

/**
 * One class's ratio.
 *
 * `unit` is the field that makes a blend unspellable, so it is `z.enum` over the
 * pinned tuple rather than a free string — see {@link BRAIN_COVERAGE_UNIT_ORIGINS}.
 * The `enumerable === surveyed + enumerated` identity is checked at the envelope
 * ({@link BrainCoverageSchema}), where a violation can carry the class name.
 */
export const BrainCoverageRatioSchema = z.strictObject({
  surveyed: z.number().int().nonnegative(),
  enumerated: z.number().int().nonnegative(),
  enumerable: z.number().int().nonnegative(),
  inPerimeterWithoutEvidence: z.number().int().nonnegative(),
  unit: z.enum(BRAIN_COVERAGE_UNIT_ORIGINS),
}) satisfies z.ZodType<BrainCoverageRatio, unknown>;

/**
 * A NAMABLE survey unit — the ACL boundary of this surface, and strict in both
 * directions for `BrainFactOversightBucketSchema`'s reason.
 *
 * The withheld units are not here wearing an opaque handle; they are not here at
 * all. So the enforcement this schema adds is the converse: the `enumerated` arm
 * has NO `freshness` and NO `newestEvidenceAt` key, so a producer cannot attach a
 * `current` verdict to a unit Atlas has never read, and `z.strictObject` makes
 * that a parse failure rather than a stripped field in one direction and a
 * rendered all-clear in the other.
 */
export const BrainCoverageNamedUnitSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("surveyed"),
    unitId: z.string(),
    label: z.string(),
    clause: z.enum(BRAIN_COVERAGE_LABEL_CLAUSES),
    newestEvidenceAt: z.string(),
    freshness: BrainCoverageFreshnessSchema,
  }),
  z.strictObject({
    state: z.literal("enumerated"),
    unitId: z.string(),
    label: z.string(),
    clause: z.enum(BRAIN_COVERAGE_LABEL_CLAUSES),
    inPerimeter: z.boolean(),
  }),
]) satisfies z.ZodType<BrainCoverageNamedUnit, unknown>;

export const BrainCoverageClassAvailableSchema = z.strictObject({
  state: z.literal("enumerated"),
  asOf: z.string(),
  ratio: BrainCoverageRatioSchema,
  freshness: BrainCoverageFreshnessCountsSchema,
  units: z.array(BrainCoverageNamedUnitSchema),
  unitsWithheld: z.number().int().nonnegative(),
  unitsTruncated: z.boolean(),
  mapEdges: z.array(z.enum(BRAIN_COVERAGE_MAP_EDGES)),
  unavailable: z.strictObject({ since: z.string(), reason: z.string() }).nullable(),
}) satisfies z.ZodType<BrainCoverageClassAvailable, unknown>;

/**
 * One class's answer — a discriminated union on `state`, because the arms that
 * carry no counts must be structurally incapable of carrying a zero.
 *
 * Every arm is strict, which is what makes that true at the parse as well as in
 * the type: `{ state: "never-enumerated", surveyed: 0 }` is refused here rather
 * than stripped and rendered as an empty roster somebody measured.
 */
export const BrainCoverageClassSchema = z.discriminatedUnion("state", [
  BrainCoverageClassAvailableSchema,
  z.strictObject({
    state: z.literal("not-surveyable"),
    reason: z.literal("non-surveyable-class"),
  }),
  z.strictObject({
    state: z.literal("cannot-establish"),
    reason: z.literal("unresolvable-class"),
  }),
  z.strictObject({
    state: z.literal("never-enumerated"),
    reason: z.enum(["no-cycle-recorded", "no-successful-cycle"]),
    lastAttemptAt: z.string().nullable(),
    unavailableReason: z.string().nullable(),
  }),
]) satisfies z.ZodType<BrainCoverageClass, unknown>;

/**
 * `availability`, built FROM the pinned class tuple rather than hand-listed.
 *
 * `z.record` would have accepted an object missing a class, and the missing key
 * is the failure mode the `Record<EpisodeSourceClass, …>` typing exists to
 * prevent — so the totality that is a compile error on the producer is a parse
 * error at the boundary, from the same list.
 */
const COVERAGE_AVAILABILITY_FIELDS = Object.fromEntries(
  BRAIN_COVERAGE_SOURCE_CLASSES.map((cls) => [cls, BrainCoverageClassSchema]),
) as Record<BrainCoverageSourceClass, typeof BrainCoverageClassSchema>;

/**
 * ## Why `authority` is the CLIENT oversight schema on both sides
 *
 * Not an oversight, and not the tolerant-by-accident choice it looks like.
 * {@link BrainFactOversightSchema} REQUIRES `willSupersede` and `willWiden`, and
 * `loadCoverage` composes `loadFactOversight` alone — the two previews are
 * merged in by `GET /brain-facts/oversight`'s handler, one surface over, and
 * this response has no publish button to disclose them for. Putting the strict
 * schema here would 500 every coverage request on a field the loader is not
 * supposed to produce.
 *
 * ⚠️ What that costs is the strict schema's two CROSS-CHECKS, which are about
 * the counters this response very much does carry — and losing them silently is
 * the failure {@link checkCoverageArithmetic} exists to close: it re-applies
 * both against the authority arm, so the server refuses the same payloads
 * `/oversight` refuses, without demanding the previews.
 */
/**
 * The triage arm (#5338 AC 8) — the count of what extraction was told not to
 * look at, and what is known about what that costs.
 *
 * `recall` is a discriminated union rather than a nullable rate, and the
 * discriminant is the point: `{ measured: false }` and `{ observedRecall: 0 }`
 * are opposite statements — nobody has measured this versus this drops
 * everything — and a nullable number lets a renderer spell the second when it
 * means the first. `z.strictObject` on both arms keeps the unmeasured arm
 * structurally incapable of carrying a rate, so a producer cannot ship a number
 * flagged as absent.
 *
 * `rule` stays `z.string()`, unlike the closed enums elsewhere on this surface.
 * The direction of drift is the opposite one here: a mark left by a retired
 * rule is a real bucket of held episodes, and refusing to parse it would
 * DISAPPEAR those episodes from a count whose whole job is to say they exist.
 * `known` is what tells a client the id is not one of today's.
 */
const BrainCoverageTriageSchema = z.strictObject({
  withheldEpisodes: z.number().int().nonnegative(),
  byRule: z.array(
    z.strictObject({
      rule: z.string(),
      episodes: z.number().int().nonnegative(),
      known: z.boolean(),
    }),
  ),
  recall: z.discriminatedUnion("measured", [
    z.strictObject({ measured: z.literal(false) }),
    z.strictObject({
      measured: z.literal(true),
      setId: z.string(),
      measuredAt: z.string(),
      observedRecall: z.number().min(0).max(1),
      recallLowerBound: z.number().min(0).max(1),
      positives: z.number().int().nonnegative(),
      passed: z.boolean(),
    }),
  ]),
}) satisfies z.ZodType<BrainCoverageTriage, unknown>;

const COVERAGE_ENVELOPE_FIELDS = {
  authority: BrainFactOversightClientSchema,
  triage: BrainCoverageTriageSchema,
  countsConsistent: z.boolean(),
} as const;

/**
 * The cross-checks, applied SERVER-SIDE ONLY —
 * `BrainFactOversightSchema`'s split, one arm over and for its reason.
 *
 * Each of these is an identity whose operands are both on the wire, so each
 * admits a state where the numbers contradict each other and a renderer picks
 * the flattering one. On the server that is a producer bug and belongs in a 500
 * with a requestId. On the client it is somebody else's already-shipped bug, and
 * refusing to parse would take down the whole Coverage Surface — including the
 * map edges and the "cannot establish" arms, which are the parts that exist to
 * be seen when things are wrong.
 */
function checkCoverageArithmetic(
  // The loose view, not `BrainCoverage`: `.superRefine` hands this callback the
  // schema's own inferred output, which carries Zod's `| undefined` on optional
  // fields (#4955 — see exact-optional.ts).
  value: WithLooseOptionals<BrainCoverage>,
  ctx: z.RefinementCtx,
): void {
  // ── The AUTHORITY arm's own cross-checks, re-applied ─────────────────────
  //
  // `BrainFactOversightSchema` carries these and cannot be used as the field
  // above (see COVERAGE_ENVELOPE_FIELDS), so they are restated against the same
  // operands. Without them this route would serve 200 for a payload
  // `/brain-facts/oversight` 500s on — and the symptom is specific and silent:
  // a reader total above the workspace total makes the hidden backlog compute
  // NEGATIVE, which `hiddenBacklogSentence` then drops on its `<= 0` guard. The
  // one disclosure this page was built to make would simply not be there, with
  // no requestId anywhere.
  const authority = value.authority;
  if (
    authority.countsConsistent &&
    authority.reviewableAwaitingReview > authority.workspaceTotals.awaitingReview
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["authority", "countsConsistent"],
      message:
        "countsConsistent is true but the reader-scoped draft count exceeds the workspace count — the hidden backlog this page states would compute negative and be silently dropped",
    });
  }
  if (authority.distinctAudiences < authority.buckets.length) {
    ctx.addIssue({
      code: "custom",
      path: ["authority", "distinctAudiences"],
      message:
        "distinctAudiences is below the number of buckets shipped — the buckets are a subset of the distinct tokens, so this understates a cardinality the client renders as exact",
    });
  }

  for (const cls of BRAIN_COVERAGE_SOURCE_CLASSES) {
    const arm = value.availability[cls];
    if (arm.state !== "enumerated") continue;
    const { ratio, freshness, units, unitsWithheld, unitsTruncated } = arm;

    if (ratio.enumerable !== ratio.surveyed + ratio.enumerated) {
      ctx.addIssue({
        code: "custom",
        path: ["availability", cls, "ratio", "enumerable"],
        message:
          "the denominator is not its own two states — a page that printed it would show a ratio whose parts do not make up its whole",
      });
    }
    if (ratio.inPerimeterWithoutEvidence > ratio.enumerated) {
      ctx.addIssue({
        code: "custom",
        path: ["availability", cls, "ratio", "inPerimeterWithoutEvidence"],
        message:
          "more units are in the perimeter without evidence than are unsurveyed — the M1 count is a subset of `enumerated`, never an addition to it",
      });
    }
    // Gated on `countsConsistent` for the oversight refinement's reason: the
    // composer's documented behaviour when this identity fails is to CLEAR the
    // flag, so refusing unconditionally would turn a reported degradation into a
    // 500 and hide the arms that reported it.
    if (
      value.countsConsistent &&
      freshness.current + freshness.stale + freshness.unverified !== ratio.surveyed
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["availability", cls, "freshness"],
        message:
          "the freshness tally does not sum to the surveyed count — this is where a WITHHELD unit's staleness is disclosed, so a short tally under-reports how much of the class is stale",
      });
    }
    if (!unitsTruncated && units.length + unitsWithheld !== ratio.enumerable) {
      ctx.addIssue({
        code: "custom",
        path: ["availability", cls, "unitsWithheld"],
        message:
          "the named units plus the withheld count do not make up the roster — an under-count here hides that units were withheld at all, which is the disclosure the counts-always rule turns on",
      });
    }
    for (const [index, unit] of units.entries()) {
      if (unit.state !== "surveyed" || unit.freshness.kind !== "stale") continue;
      if (unit.freshness.lagMs <= unit.freshness.cadenceMs) {
        ctx.addIssue({
          code: "custom",
          path: ["availability", cls, "units", index, "freshness", "lagMs"],
          message:
            "a stale verdict whose lag does not beat the class cadence is a badge wearing a measurement's clothes — ADR-0041 admits stale only as a measured divergence",
        });
      }
    }
  }

  // ── The TRIAGE arm (#5338 AC 8) ──────────────────────────────────────────
  //
  // `loadTriageBacklog` accumulates the total from the same buckets it returns,
  // so the identity holds even when it drops a bucket it cannot name. A payload
  // where it does NOT hold is a producer that assembled the two halves from
  // different reads, and the symptom is the flattering one: a headline smaller
  // than the rules beneath it, on the count that says what Atlas did not look
  // at.
  const triage = value.triage;
  const ruleSum = triage.byRule.reduce((sum, bucket) => sum + bucket.episodes, 0);
  if (ruleSum !== triage.withheldEpisodes) {
    ctx.addIssue({
      code: "custom",
      path: ["triage", "withheldEpisodes"],
      message:
        "the triaged-out total does not equal the sum of its per-rule buckets — the two halves came from different reads, and a headline smaller than its own parts under-states what extraction never looked at",
    });
  }
  // A rate can only exceed its own lower bound. Inverted, it is a hand-edited
  // record or a bound computed against a different denominator, and the
  // reassuring direction is the one that survives: a reader looking for
  // confidence reads the LOWER bound, so an inflated one is the number that
  // makes an unmeasurable set look decisive.
  if (triage.recall.measured && triage.recall.recallLowerBound > triage.recall.observedRecall) {
    ctx.addIssue({
      code: "custom",
      path: ["triage", "recall", "recallLowerBound"],
      message:
        "the Wilson lower bound on triage recall exceeds the observed rate — a bound above its own point estimate cannot come from the set it claims to describe",
    });
  }
  // A rate over zero positives is not a rate. #5338's first real cut is the
  // cautionary case in the other direction (9 positives, a perfect 1.0000), and
  // zero is that failure with nothing left to notice: the arithmetic would
  // produce 0/0 and any value rendered from it is invented.
  if (triage.recall.measured && triage.recall.positives === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["triage", "recall", "positives"],
      message:
        "a measured triage recall over zero positives has no denominator — report it unmeasured rather than as a rate nothing was counted for",
    });
  }
}

/**
 * The strict server-side contract. `admin-brain-coverage.ts` parses every
 * response through this before it goes out, so a producer that broke one of the
 * honesty identities gets a 500 with a requestId instead of shipping a page
 * whose parts disagree.
 */
export const BrainCoverageSchema = z
  .strictObject({
    availability: z.strictObject(COVERAGE_AVAILABILITY_FIELDS),
    ...COVERAGE_ENVELOPE_FIELDS,
  })
  .superRefine(checkCoverageArithmetic) satisfies z.ZodType<WithLooseOptionals<BrainCoverage>, unknown>;

/**
 * The BROWSER's parser. Same fields, additive-tolerant at the envelope and
 * WITHOUT the cross-checks — `BrainFactOversightClientSchema`'s split verbatim.
 *
 * The inner arms stay strict, including the named-unit arms: those are the ACL
 * boundary, and a browser that passed an unexpected key through to the DOM is
 * the leak this surface refuses. An admin losing the availability arm during a
 * deploy window is not.
 */
export const BrainCoverageClientSchema = z.object({
  // ⚠️ `z.object`, not `z.strictObject`, and ONLY here. Every known class stays
  // REQUIRED — a class the client knows about and the response omitted is still
  // a refusal, because that is the missing-row failure the whole shape is keyed
  // against. What this tolerates is the opposite skew: an API that has learned a
  // NEW class before this bundle has. Strict there would blank the entire
  // Coverage Surface during a deploy window — taking the map edges and the
  // "cannot establish" arms down with it, which are precisely the parts that
  // exist to be seen when something is wrong. Rendering the five classes this
  // bundle knows is a smaller failure than rendering none, and it resolves
  // itself on the next web deploy.
  availability: z.object(COVERAGE_AVAILABILITY_FIELDS),
  ...COVERAGE_ENVELOPE_FIELDS,
}) satisfies z.ZodType<WithLooseOptionals<BrainCoverage>, unknown>;

// ---------------------------------------------------------------------------
// The Claim Vocabulary surface (#5087, ADR-0037 §6)
// ---------------------------------------------------------------------------

/**
 * The three slot positions, as a request enum.
 *
 * The tuple lives HERE rather than in `@useatlas/types` because that package is
 * types-only (see its header: a value export forces a publish-first merge
 * dance). `_VocabularySlotPositionsCoverTheWire` below is what keeps the tuple
 * and the union the same set — the same shape `_BrainFactStatusesCovered` uses,
 * and the reason a hand-kept enum here is affordable at all.
 */
export const BRAIN_VOCABULARY_SLOT_POSITIONS = [
  "subject",
  "predicate",
  "object",
] as const satisfies readonly BrainVocabularySlotPosition[];

/** Pin: the tuple above covers the wire union, so neither can shrink alone. */
type _VocabularySlotPositionsCoverTheWire = [
  Exclude<BrainVocabularySlotPosition, (typeof BRAIN_VOCABULARY_SLOT_POSITIONS)[number]>,
] extends [never]
  ? true
  : never;
const _vocabularySlotPositionsCoverTheWire: _VocabularySlotPositionsCoverTheWire = true;
void _vocabularySlotPositionsCoverTheWire;

/**
 * ⚠️ `satisfies` and the `Exclude` pin are BOTH required, and the reason is a
 * measured property of Zod rather than belt-and-braces.
 *
 * A schema whose enum is NARROWER than the wire union satisfies
 * `z.ZodType<T, unknown>` **vacuously** — only a WIDER one is rejected
 * (measured against zod 4.4.3). So the missing-member direction, which is
 * exactly the direction that produces a runtime parse failure on a live pane, is
 * the direction `satisfies` cannot see. `_VocabularySlotPositionsCoverTheWire`
 * above exists for the same reason; this tuple was simply missed.
 */
export const BRAIN_VOCABULARY_SCOPES = [
  "unscoped",
  "reader-scoped",
  "deny-all",
] as const satisfies readonly BrainVocabularyScope[];

/** Pin: the tuple covers the wire union, so neither can shrink alone. */
type _VocabularyScopesCoverTheWire = [
  Exclude<BrainVocabularyScope, (typeof BRAIN_VOCABULARY_SCOPES)[number]>,
] extends [never]
  ? true
  : never;
const _vocabularyScopesCoverTheWire: _VocabularyScopesCoverTheWire = true;
void _vocabularyScopesCoverTheWire;

export const BRAIN_VOCABULARY_CARDINALITIES = [
  "single",
  "multi",
] as const satisfies readonly BrainVocabularyCardinality[];

type _VocabularyCardinalitiesCoverTheWire = [
  Exclude<BrainVocabularyCardinality, (typeof BRAIN_VOCABULARY_CARDINALITIES)[number]>,
] extends [never]
  ? true
  : never;
const _vocabularyCardinalitiesCoverTheWire: _VocabularyCardinalitiesCoverTheWire = true;
void _vocabularyCardinalitiesCoverTheWire;

export const BRAIN_VOCABULARY_STRUCTURALLY_EMPTY_REASONS = [
  "object-position",
  "already-single",
  "not-curated",
  "unkeyable-surface",
  "no-such-edge",
] as const satisfies readonly BrainVocabularyStructurallyEmptyReason[];

type _VocabularyReasonsCoverTheWire = [
  Exclude<
    BrainVocabularyStructurallyEmptyReason,
    (typeof BRAIN_VOCABULARY_STRUCTURALLY_EMPTY_REASONS)[number]
  >,
] extends [never]
  ? true
  : never;
const _vocabularyReasonsCoverTheWire: _VocabularyReasonsCoverTheWire = true;
void _vocabularyReasonsCoverTheWire;

/**
 * One picker row. **Strict**, and for `BrainFactWillSupersedePairSchema`'s
 * reason applied one level up: this object legitimately carries CONTENT (a
 * surface), because the list is scoped by the positional rule — and exactly
 * because content is allowed, an extra key must be REFUSED rather than
 * stripped. The extra key this guards against is a `predicateKey` / `norm`-key
 * confusion reaching the browser, which ADR-0037 §6 forbids outright.
 */
export const BrainVocabularySurfaceOptionSchema = z.strictObject({
  norm: z.string(),
  exampleSurface: z.string(),
  claims: z.number().int().nonnegative(),
  variants: z.number().int().nonnegative(),
}) satisfies z.ZodType<BrainVocabularySurfaceOption, unknown>;

export const BrainVocabularySurfaceListSchema = z.strictObject({
  position: z.enum(BRAIN_VOCABULARY_SLOT_POSITIONS),
  surfaces: z.array(BrainVocabularySurfaceOptionSchema),
  truncated: z.boolean(),
  scope: z.enum(BRAIN_VOCABULARY_SCOPES),
}) satisfies z.ZodType<BrainVocabularySurfaceList, unknown>;

export const BrainVocabularyEdgeEntrySchema = z.strictObject({
  position: z.enum(BRAIN_VOCABULARY_SLOT_POSITIONS),
  fromNorm: z.string(),
  toNorm: z.string(),
  approvedBy: z.string().nullable(),
  approvedAt: z.string(),
  hasRejectionMemory: z.boolean(),
}) satisfies z.ZodType<BrainVocabularyEdgeEntry, unknown>;

export const BrainVocabularyPositionCountsSchema = z.strictObject({
  position: z.enum(BRAIN_VOCABULARY_SLOT_POSITIONS),
  scope: z.enum(BRAIN_VOCABULARY_SCOPES),
  total: z.number().int().nonnegative(),
  scoped: z.number().int().nonnegative(),
  withheld: z.number().int().nonnegative(),
  countsConsistent: z.boolean(),
}) satisfies z.ZodType<BrainVocabularyPositionCounts, unknown>;

export const BrainVocabularyCardinalityEntrySchema = z.strictObject({
  predicateSurface: z.string().nullable(),
  cardinality: z.enum(BRAIN_VOCABULARY_CARDINALITIES),
  sourceClass: z.string(),
  proposedBy: z.string(),
  reviewedBy: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  claims: z.number().int().nonnegative(),
}) satisfies z.ZodType<BrainVocabularyCardinalityEntry, unknown>;

export const BrainVocabularyCoverageSchema = z.strictObject({
  liveFacts: z.number().int().nonnegative(),
  comparableFacts: z.number().int().nonnegative(),
  pendingProposals: z.number().int().nonnegative(),
  pendingCardinalities: z.number().int().nonnegative(),
}) satisfies z.ZodType<BrainVocabularyCoverage, unknown>;

export const BrainVocabularyInForceResponseSchema = z.strictObject({
  edges: z.array(BrainVocabularyEdgeEntrySchema),
  counts: z.array(BrainVocabularyPositionCountsSchema),
  cardinalities: z.array(BrainVocabularyCardinalityEntrySchema),
  cardinalityCounts: BrainVocabularyPositionCountsSchema,
  coverage: BrainVocabularyCoverageSchema,
  truncated: z.boolean(),
}) satisfies z.ZodType<BrainVocabularyInForceResponse, unknown>;

export const BrainVocabularyObjectPairSchema = z.strictObject({
  leftId: z.string(),
  leftLabel: z.string(),
  rightId: z.string(),
  rightLabel: z.string(),
}) satisfies z.ZodType<BrainVocabularyObjectPair, unknown>;

export const BrainVocabularyObjectRadiusSideSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  pairs: z.array(BrainVocabularyObjectPairSchema),
  withheld: z.number().int().nonnegative(),
  truncated: z.boolean(),
  countsConsistent: z.boolean(),
}) satisfies z.ZodType<BrainVocabularyObjectRadiusSide, unknown>;

export const BrainVocabularyBlastRadiusSideSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  pairs: z.array(BrainFactWillSupersedePairSchema),
  withheld: z.number().int().nonnegative(),
  truncated: z.boolean(),
  countsConsistent: z.boolean(),
}) satisfies z.ZodType<BrainVocabularyBlastRadiusSide, unknown>;

/**
 * The compound blast radius, as a DISCRIMINATED union on the wire.
 *
 * ⚠️ `targetPredicate` is on the `curated-single` arm ALONE, and a `z.union` of
 * strict objects is what makes that unreadable elsewhere at runtime as well as
 * in the type. Flattened to `{curatedSingle: boolean, targetPredicate: string |
 * null}` a client would render *"the target predicate is not curated"* for a
 * subject alias, which is a confident answer to a question nobody asked.
 */
export const BrainVocabularyTargetCardinalitySchema = z.union([
  z.strictObject({ kind: z.literal("not-asked") }),
  z.strictObject({ kind: z.literal("uncurated") }),
  z.strictObject({ kind: z.literal("curated-single"), targetPredicate: z.string() }),
]) satisfies z.ZodType<BrainVocabularyTargetCardinality, unknown>;

/**
 * The counterfactual, as a DISCRIMINATED union on the wire.
 *
 * ⚠️ A union rather than one record with a nullable reason, because the engine's
 * own type is one and flattening it here would undo the fix. `BlastRadius`'s
 * docstring records what the flat shape produced: a renderer that read `floor`
 * before checking `structurallyEmpty` said *"at least 0 today, and every future
 * claim in this slot"* for an object-position alias — false, and the exact
 * confident all-clear the preview exists to prevent. A `z.union` is what makes
 * the numbers UNREADABLE on the branch where they are meaningless.
 */
export const BrainVocabularyBlastRadiusSchema = z.union([
  z.strictObject({
    kind: z.literal("structurally-empty"),
    reason: z.enum(BRAIN_VOCABULARY_STRUCTURALLY_EMPTY_REASONS),
  }),
  z.strictObject({
    kind: z.literal("object-position"),
    corroborating: BrainVocabularyObjectRadiusSideSchema,
    separating: BrainVocabularyObjectRadiusSideSchema,
    tension: BrainVocabularyObjectRadiusSideSchema,
    staleEdgesPersist: z.literal(true),
    floor: z.literal(true),
    subtreeTruncated: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("computed"),
    arming: BrainVocabularyBlastRadiusSideSchema,
    disarming: BrainVocabularyBlastRadiusSideSchema,
    targetCardinality: BrainVocabularyTargetCardinalitySchema,
    floor: z.literal(true),
    subtreeTruncated: z.boolean(),
  }),
]) satisfies z.ZodType<BrainVocabularyBlastRadius, unknown>;

export const BrainVocabularyPreviewResponseSchema = z.strictObject({
  radius: BrainVocabularyBlastRadiusSchema,
}) satisfies z.ZodType<BrainVocabularyPreviewResponse, unknown>;

export const BrainVocabularyAuthorResponseSchema = z.union([
  z.strictObject({
    outcome: z.literal("authored"),
    proposalId: z.string(),
    convergedOnProposal: z.boolean(),
  }),
  z.strictObject({
    outcome: z.literal("already_approved"),
    proposalId: z.string(),
  }),
]) satisfies z.ZodType<BrainVocabularyAuthorResponse, unknown>;

export const BrainVocabularyRemoveResponseSchema = z.union([
  z.strictObject({
    outcome: z.literal("removed"),
    proposalId: z.string(),
    memoryCreated: z.boolean(),
  }),
  z.strictObject({
    outcome: z.literal("already_removed"),
    proposalId: z.string(),
  }),
]) satisfies z.ZodType<BrainVocabularyRemoveResponse, unknown>;

/**
 * ⚠️ ARM-COVERAGE pins for the three tagged response unions.
 *
 * `satisfies z.ZodType<T, unknown>` is blind in the same direction here as it is
 * for the enums above, and for the same reason: DROPPING an arm leaves the
 * inferred output still assignable to the wire type, so the check passes
 * vacuously and the missing arm fails at runtime — `/author` 500s on the
 * double-submit path, `/preview` on an object-position alias. These close it by
 * comparing the DISCRIMINANTS, which is the part an arm carries with it.
 */
type _AuthorArmsCovered = [
  Exclude<
    BrainVocabularyAuthorResponse["outcome"],
    z.infer<typeof BrainVocabularyAuthorResponseSchema>["outcome"]
  >,
] extends [never]
  ? true
  : never;
const _authorArmsCovered: _AuthorArmsCovered = true;
void _authorArmsCovered;

type _RemoveArmsCovered = [
  Exclude<
    BrainVocabularyRemoveResponse["outcome"],
    z.infer<typeof BrainVocabularyRemoveResponseSchema>["outcome"]
  >,
] extends [never]
  ? true
  : never;
const _removeArmsCovered: _RemoveArmsCovered = true;
void _removeArmsCovered;

type _BlastRadiusArmsCovered = [
  Exclude<
    BrainVocabularyBlastRadius["kind"],
    z.infer<typeof BrainVocabularyBlastRadiusSchema>["kind"]
  >,
] extends [never]
  ? true
  : never;
const _blastRadiusArmsCovered: _BlastRadiusArmsCovered = true;
void _blastRadiusArmsCovered;

/**
 * Pin: every target-cardinality arm has a schema arm — `_BlastRadiusArmsCovered`'s
 * reason, applied to the union NESTED inside the `computed` arm.
 *
 * It needs its own pin rather than riding the one above, which compares only the
 * OUTER discriminant: dropping `curated-single` here leaves `kind: "computed"`
 * covered, so the outer pin still passes and `/preview` 500s on exactly the
 * decision this field was added to disclose.
 */
type _TargetCardinalityArmsCovered = [
  Exclude<
    BrainVocabularyTargetCardinality["kind"],
    z.infer<typeof BrainVocabularyTargetCardinalitySchema>["kind"]
  >,
] extends [never]
  ? true
  : never;
const _targetCardinalityArmsCovered: _TargetCardinalityArmsCovered = true;
void _targetCardinalityArmsCovered;

export const BrainVocabularyCardinalityWriteResponseSchema = z.strictObject({
  cardinality: z.enum(BRAIN_VOCABULARY_CARDINALITIES),
}) satisfies z.ZodType<BrainVocabularyCardinalityWriteResponse, unknown>;

/**
 * The authoring request. `position` is an enum and both norms are picked
 * values, so a client that never rendered a picker still cannot smuggle a
 * position the store does not know.
 *
 * The norms are NOT bounded to a picker's contents here — that check needs the
 * corpus and lives server-side in `authorAliasEdge`'s population refusal, which
 * is the arm that holds for a caller posting JSON directly. A schema-level
 * allowlist would be a second, weaker copy of it.
 */
export const BrainVocabularyAuthorRequestSchema = z.strictObject({
  position: z.enum(BRAIN_VOCABULARY_SLOT_POSITIONS),
  fromNorm: z.string().min(1).max(500),
  toNorm: z.string().min(1).max(500),
});

export const BrainVocabularyRemoveRequestSchema = BrainVocabularyAuthorRequestSchema;

/**
 * A preview request — the four counterfactual kinds child 1's engine answers.
 *
 * `predicateSurface`, never a predicate key. `BlastRadiusRequest`'s own
 * docstring makes that a prohibition: *"a request type that accepted a key would
 * be the seam through which one reaches a route body"*, and this schema is
 * literally that route body.
 */
export const BrainVocabularyPreviewRequestSchema = z.union([
  z.strictObject({
    kind: z.literal("alias-approval"),
    position: z.enum(BRAIN_VOCABULARY_SLOT_POSITIONS),
    fromNorm: z.string().min(1).max(500),
    toNorm: z.string().min(1).max(500),
  }),
  z.strictObject({
    kind: z.literal("alias-removal"),
    position: z.enum(BRAIN_VOCABULARY_SLOT_POSITIONS),
    fromNorm: z.string().min(1).max(500),
  }),
  z.strictObject({
    kind: z.literal("cardinality-flip"),
    predicateSurface: z.string().min(1).max(500),
  }),
  z.strictObject({
    kind: z.literal("cardinality-removal"),
    predicateSurface: z.string().min(1).max(500),
  }),
]);

/**
 * Curating or un-curating a predicate — both directions, one body. `single` arms
 * retroactive supersession; `multi` is the adjudicated record that values
 * coexist.
 */
export const BrainVocabularyCardinalityRequestSchema = z.strictObject({
  predicateSurface: z.string().min(1).max(500),
  cardinality: z.enum(BRAIN_VOCABULARY_CARDINALITIES),
});

// ---------------------------------------------------------------------------
// The Pending queue (#5088)
// ---------------------------------------------------------------------------

export const BRAIN_VOCABULARY_PENDING_KINDS = [
  "alias",
  "cardinality",
] as const satisfies readonly BrainVocabularyPendingKind[];

/** Pin: the tuple covers the wire union, for `BRAIN_VOCABULARY_SCOPES`' reason. */
type _VocabularyPendingKindsCoverTheWire = [
  Exclude<BrainVocabularyPendingKind, (typeof BRAIN_VOCABULARY_PENDING_KINDS)[number]>,
] extends [never]
  ? true
  : never;
const _vocabularyPendingKindsCoverTheWire: _VocabularyPendingKindsCoverTheWire = true;
void _vocabularyPendingKindsCoverTheWire;

export const BrainVocabularyAgreementExampleSchema = z.strictObject({
  subject: z.string(),
  object: z.string(),
  fromPredicate: z.string(),
  toPredicate: z.string(),
}) satisfies z.ZodType<BrainVocabularyAgreementExample, unknown>;

/**
 * ⚠️ A union, mirroring the engine's. Flattened into one record with a nullable
 * count, a client would render *"0 subjects agree"* for a warehouse-key proposal
 * at an entity position — where the structural question cannot be asked at all,
 * and the proposal's evidence is a primary key.
 */
export const BrainVocabularyAliasEvidenceSchema = z.union([
  z.strictObject({
    kind: z.literal("structural"),
    subjects: z.number().int().nonnegative(),
    scopedSubjects: z.number().int().nonnegative(),
    withheld: z.number().int().nonnegative(),
    examples: z.array(BrainVocabularyAgreementExampleSchema),
    threshold: z.number().int().nonnegative(),
    countsConsistent: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("not-applicable"),
    reason: z.literal("entity-position"),
  }),
  z.strictObject({ kind: z.literal("unreadable") }),
]) satisfies z.ZodType<BrainVocabularyAliasEvidence, unknown>;

/** Pin: every alias-evidence arm has a schema arm — `_BlastRadiusArmsCovered`'s reason. */
type _AliasEvidenceArmsCovered = [
  Exclude<
    BrainVocabularyAliasEvidence["kind"],
    z.infer<typeof BrainVocabularyAliasEvidenceSchema>["kind"]
  >,
] extends [never]
  ? true
  : never;
const _aliasEvidenceArmsCovered: _AliasEvidenceArmsCovered = true;
void _aliasEvidenceArmsCovered;

export const BrainVocabularyCorrectionExampleSchema = z.strictObject({
  subject: z.string(),
  fromObject: z.string(),
  toObject: z.string(),
  factId: z.string(),
  at: z.string(),
}) satisfies z.ZodType<BrainVocabularyCorrectionExample, unknown>;

export const BrainVocabularyCorrectionEvidenceSchema = z.union([
  z.strictObject({
    kind: z.literal("behavioral"),
    subjects: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
    scopedSubjects: z.number().int().nonnegative(),
    withheld: z.number().int().nonnegative(),
    examples: z.array(BrainVocabularyCorrectionExampleSchema),
    threshold: z.number().int().nonnegative(),
    countsConsistent: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("unreadable") }),
]) satisfies z.ZodType<BrainVocabularyCorrectionEvidence, unknown>;

/** Pin: every correction-evidence arm has a schema arm. */
type _CorrectionEvidenceArmsCovered = [
  Exclude<
    BrainVocabularyCorrectionEvidence["kind"],
    z.infer<typeof BrainVocabularyCorrectionEvidenceSchema>["kind"]
  >,
] extends [never]
  ? true
  : never;
const _correctionEvidenceArmsCovered: _CorrectionEvidenceArmsCovered = true;
void _correctionEvidenceArmsCovered;

export const BrainVocabularyPendingEntrySchema = z.union([
  z.strictObject({
    kind: z.literal("alias"),
    id: z.string(),
    position: z.enum(BRAIN_VOCABULARY_SLOT_POSITIONS),
    // A TUPLE, not `z.array(z.string())`. The pair is exactly two norms, and a
    // three-element array reaching a renderer that destructures two would drop
    // one silently.
    pair: z.tuple([z.string(), z.string()]),
    direction: z
      .strictObject({ fromNorm: z.string(), toNorm: z.string() })
      .nullable(),
    sourceClass: z.string(),
    proposedBy: z.string(),
    proposedAt: z.string(),
    rank: z.number(),
    evidence: BrainVocabularyAliasEvidenceSchema,
  }),
  z.strictObject({
    kind: z.literal("cardinality"),
    predicateSurface: z.string().nullable(),
    cardinality: z.enum(BRAIN_VOCABULARY_CARDINALITIES),
    sourceClass: z.string(),
    proposedBy: z.string(),
    proposedAt: z.string(),
    claims: z.number().int().nonnegative(),
    evidence: BrainVocabularyCorrectionEvidenceSchema,
  }),
]) satisfies z.ZodType<BrainVocabularyPendingEntry, unknown>;

/** Pin: both queue kinds have a schema arm — `_BlastRadiusArmsCovered`'s reason. */
type _PendingEntryArmsCovered = [
  Exclude<
    BrainVocabularyPendingEntry["kind"],
    z.infer<typeof BrainVocabularyPendingEntrySchema>["kind"]
  >,
] extends [never]
  ? true
  : never;
const _pendingEntryArmsCovered: _PendingEntryArmsCovered = true;
void _pendingEntryArmsCovered;

export const BrainVocabularyPendingResponseSchema = z.strictObject({
  entries: z.array(BrainVocabularyPendingEntrySchema),
  aliasCounts: z.array(BrainVocabularyPositionCountsSchema),
  cardinalityCounts: BrainVocabularyPositionCountsSchema.nullable(),
  truncated: z.boolean(),
  incomplete: z.boolean(),
}) satisfies z.ZodType<BrainVocabularyPendingResponse, unknown>;

/**
 * One decision, both kinds, one body.
 *
 * ⚠️ **`direction` is on the ALIAS arm only, and it is optional there rather
 * than defaulted.** The seam refuses an undirected approval that supplies none
 * (`direction-required`) rather than picking, and a schema `.default()` here
 * would satisfy the refusal with a value nobody chose — which is the silent
 * workspace-wide re-key the whole surface exists to put a human in front of.
 *
 * ⚠️ It is also absent from the REJECT shape. A direction is meaningless on a
 * rejection, and `AliasDecisionRequest` makes the same split at the type: *a
 * field that is representable-and-ignored is a field a caller will eventually
 * believe in.*
 */
export const BrainVocabularyDecideRequestSchema = z.union([
  z.strictObject({
    kind: z.literal("alias"),
    proposalId: z.string().min(1).max(200),
    decision: z.literal("approved"),
    direction: z
      .strictObject({
        fromNorm: z.string().min(1).max(500),
        toNorm: z.string().min(1).max(500),
      })
      .optional(),
  }),
  z.strictObject({
    kind: z.literal("alias"),
    proposalId: z.string().min(1).max(200),
    decision: z.literal("rejected"),
  }),
  z.strictObject({
    kind: z.literal("cardinality"),
    /** The ADDRESS. A predicate key never reaches this body (ADR-0037 §6). */
    predicateSurface: z.string().min(1).max(500),
    decision: z.enum(["approved", "rejected"]),
  }),
]);

export const BRAIN_VOCABULARY_DECIDE_OUTCOMES = [
  "approved",
  "rejected",
  "nothing_to_decide",
] as const satisfies readonly BrainVocabularyDecideOutcome[];

/** Pin: the tuple covers the wire union — `BRAIN_VOCABULARY_SCOPES`' reason. */
type _VocabularyDecideOutcomesCoverTheWire = [
  Exclude<BrainVocabularyDecideOutcome, (typeof BRAIN_VOCABULARY_DECIDE_OUTCOMES)[number]>,
] extends [never]
  ? true
  : never;
const _vocabularyDecideOutcomesCoverTheWire: _VocabularyDecideOutcomesCoverTheWire = true;
void _vocabularyDecideOutcomesCoverTheWire;

/**
 * ⚠️ A union, mirroring the wire type. `removedEdge` exists only on the
 * `rejected` arm, so the route cannot invent it on an approval or on a lost
 * race — which is what the flat shape forced it to do on three of four paths.
 */
export const BrainVocabularyDecideResponseSchema = z.union([
  z.strictObject({
    outcome: z.literal("approved"),
    proposalId: z.string().nullable(),
  }),
  z.strictObject({
    outcome: z.literal("rejected"),
    proposalId: z.string().nullable(),
    removedEdge: z.boolean(),
  }),
  z.strictObject({
    outcome: z.literal("nothing_to_decide"),
    proposalId: z.string().nullable(),
  }),
]) satisfies z.ZodType<BrainVocabularyDecideResponse, unknown>;

/** Pin: every decide arm has a schema arm — `_BlastRadiusArmsCovered`'s reason. */
type _DecideArmsCovered = [
  Exclude<
    BrainVocabularyDecideResponse["outcome"],
    z.infer<typeof BrainVocabularyDecideResponseSchema>["outcome"]
  >,
] extends [never]
  ? true
  : never;
const _decideArmsCovered: _DecideArmsCovered = true;
void _decideArmsCovered;

/**
 * `GET /api/v1/admin/brain-slack/channels` — the Slack ingest-scope surface
 * (#5203). The console's vitals strip reads this subset; the full channel
 * rows also carry exclusion attribution and per-channel probe detail for the
 * channel-manager surface when it is built. No `@useatlas/types` pin,
 * deliberately: `/api/v1/admin/*` carries no frozen contract (#5149) and the
 * route's own zod owns the shape — this mirrors exactly the fields the
 * console consumes.
 */
export const BrainSlackSyncStatusSchema = z.object({
  lastSyncAt: z.string().nullable(),
  status: z.enum(["success", "error"]),
  error: z.string().nullable(),
  coverageIncomplete: z.boolean(),
});

export const BrainSlackScopeVitalsSchema = z.object({
  scopeMode: z.enum(["membership", "legacy-pending"]),
  inScopeCount: z.number().int().nonnegative(),
  /** Null until the first sync attempt has been recorded for the workspace. */
  sync: BrainSlackSyncStatusSchema.nullable(),
  // Unknown per-channel keys are stripped — the vitals read needs only the
  // probe verdict, and the manager surface will own the rest.
  channels: z.array(z.object({ health: z.enum(["ok", "error"]).nullable() })),
});

// ---------------------------------------------------------------------------
// Enrollment — the warehouse producer's reach (#5196, ADR-0039)
// ---------------------------------------------------------------------------

/**
 * Length bound on either half of a pair.
 *
 * **The only DECLARATION.** `lib/brain/enrollment.ts` re-exports it as
 * `ENROLLMENT_NAME_MAX` rather than declaring its own — the forbidden direction
 * is `@useatlas/schemas` → `@atlas/api`, and the one used here is the reverse,
 * which `lib/` already takes in a dozen places.
 *
 * An earlier cut declared the number twice and claimed a test pinned them
 * together; no such test existed. Its only other appearance was a literal inside
 * a `mock.module()` factory replacing the real module — a fixture that agrees by
 * construction and can never disagree — and that copy now imports this constant
 * too. "Declaration" rather than "spelling" is deliberate: a mock is free to
 * state a DIFFERENT bound on purpose, and this comment should not read as a
 * promise that no test ever will.
 */
export const BRAIN_ENROLLMENT_NAME_MAX = 200;

export const BRAIN_ENROLLMENT_CANDIDATE_KINDS = [
  "dimension",
  "measure",
] as const satisfies readonly BrainEnrollmentCandidateKind[];

/**
 * Compile error if a kind is added to the union without joining the tuple.
 *
 * The load-bearing pin, not decoration: `satisfies z.ZodType<T, unknown>` below
 * is covariant in the output type, so a schema enum that is a strict SUBSET of
 * the wire union still compiles — and then throws at the route's response parse.
 */
type _BrainEnrollmentKindsCovered = [
  Exclude<BrainEnrollmentCandidateKind, (typeof BRAIN_ENROLLMENT_CANDIDATE_KINDS)[number]>,
] extends [never]
  ? true
  : never;
const _brainEnrollmentKindsCovered: _BrainEnrollmentKindsCovered = true;
void _brainEnrollmentKindsCovered;

export const BrainEnrollmentEntrySchema = z.strictObject({
  entity: z.string(),
  group: z.string().nullable(),
  dimension: z.string(),
  enrolledAt: z.string(),
  enrolledBy: z.string(),
  note: z.string().nullable(),
  naming: z.boolean(),
}) satisfies z.ZodType<BrainEnrollmentEntry, unknown>;

export const BrainEnrollmentListResponseSchema = z.strictObject({
  enrollments: z.array(BrainEnrollmentEntrySchema),
  entityCount: z.number().int().nonnegative(),
}) satisfies z.ZodType<BrainEnrollmentListResponse, unknown>;

export const BrainEnrollmentEntityOptionSchema = z.strictObject({
  name: z.string(),
  group: z.string().nullable(),
  table: z.string(),
  description: z.string().nullable(),
}) satisfies z.ZodType<BrainEnrollmentEntityOption, unknown>;

export const BrainEnrollmentEntitiesResponseSchema = z.strictObject({
  entities: z.array(BrainEnrollmentEntityOptionSchema),
}) satisfies z.ZodType<BrainEnrollmentEntitiesResponse, unknown>;

export const BrainEnrollmentDimensionOptionSchema = z.strictObject({
  name: z.string(),
  kind: z.enum(BRAIN_ENROLLMENT_CANDIDATE_KINDS),
  type: z.string().nullable(),
  description: z.string().nullable(),
  enrolled: z.boolean(),
  naming: z.boolean(),
}) satisfies z.ZodType<BrainEnrollmentDimensionOption, unknown>;

export const BrainEnrollmentDimensionsResponseSchema = z.strictObject({
  entity: z.string(),
  group: z.string().nullable(),
  dimensions: z.array(BrainEnrollmentDimensionOptionSchema),
}) satisfies z.ZodType<BrainEnrollmentDimensionsResponse, unknown>;

/**
 * The enroll/un-enroll request body.
 *
 * `min(1)` on both halves, and it is the schema's real work rather than
 * boilerplate: `''` is a pair the producer can never match, so a tolerated empty
 * half would store an enrollment that sits in the list looking live and reaches
 * nothing. The destination's `ck_brain_enrollment_names_present` refuses it too,
 * as a 500 with a Postgres message.
 */
export const BrainEnrollmentWriteRequestSchema = z.strictObject({
  entity: z.string().min(1).max(BRAIN_ENROLLMENT_NAME_MAX),
  /**
   * Which of the entity's connection groups this pair names — `null` for the
   * flat scope (#5286).
   *
   * ⚠️ `.nullable()`, deliberately NOT `.nullish()`, and the difference is the
   * whole fix. Optional, an omitted group would silently mean "flat scope" — so
   * a client that had a group and forgot to send it would write a pair in the
   * wrong scope, which stores cleanly and reaches nothing. That is exactly the
   * failure this column was added to end, so the field is REQUIRED and the flat
   * scope has to be stated as an explicit `null`.
   */
  group: z.string().max(BRAIN_ENROLLMENT_NAME_MAX).nullable(),
  dimension: z.string().min(1).max(BRAIN_ENROLLMENT_NAME_MAX),
  /** Why this pair is worth holding claims about. Absent on the un-enroll verb. */
  note: z.string().max(500).nullish(),
});

/**
 * The un-enroll body — the same pair, and deliberately NO `note`.
 *
 * `strictObject` makes the omission a 422 rather than a silent discard. An
 * earlier cut shared one schema across both verbs, so un-enrolling with a
 * reason was accepted and the reason thrown away — which reads as "Atlas
 * recorded why I stopped this" and is the one thing this table does not store.
 * Un-enrolment leaves no row behind to carry a note, by design (migration
 * 0199's header), so the honest answer is to refuse the field.
 */
export const BrainEnrollmentUnenrollRequestSchema = z.strictObject({
  entity: z.string().min(1).max(BRAIN_ENROLLMENT_NAME_MAX),
  /**
   * Required for the enroll verb's reason, and one sharper. A DELETE that
   * defaulted to the flat scope on an omitted field would not merely miss — the
   * pre-#5286 statement matched every group's copy of a pair, and reporting
   * `changed: true` for "I removed all of them" is a narrowing nobody asked for.
   */
  group: z.string().max(BRAIN_ENROLLMENT_NAME_MAX).nullable(),
  dimension: z.string().min(1).max(BRAIN_ENROLLMENT_NAME_MAX),
});

export const BrainEnrollmentWriteResponseSchema = z.strictObject({
  entity: z.string(),
  group: z.string().nullable(),
  dimension: z.string(),
  changed: z.boolean(),
}) satisfies z.ZodType<BrainEnrollmentWriteResponse, unknown>;

/**
 * The naming-dimension body (#5043).
 *
 * `dimension` is NULLABLE and the null is the clear verb — it is what un-names an
 * entity's canonical surface, after which the entity store holds no entry for it.
 * Spelled as one nullable field rather than two verbs because the underlying
 * write is one statement either way (at most one naming row per entity), and two
 * routes would be two chances for the partial unique index to be the thing that
 * discovers a caller set two.
 *
 * `.nullable()` and NOT `.nullish()`: on a `strictObject` an omitted field and an
 * explicit `null` would then mean the same thing, and "clear the naming
 * dimension" is too destructive a default for a body that forgot a field. It
 * re-keys every fact about that entity workspace-wide.
 */
export const BrainEnrollmentNamingRequestSchema = z.strictObject({
  entity: z.string().min(1).max(BRAIN_ENROLLMENT_NAME_MAX),
  /**
   * Which group's copy of the entity is being named (#5286).
   *
   * `uq_brain_enrollment_naming` is scoped per group, so this is not a filter on
   * the write — it IS the write's subject. Defaulted, naming one group's copy
   * would un-name another's, and the un-naming half clears that entity's
   * entity-store entries.
   */
  group: z.string().max(BRAIN_ENROLLMENT_NAME_MAX).nullable(),
  dimension: z.string().min(1).max(BRAIN_ENROLLMENT_NAME_MAX).nullable(),
});

export const BrainEnrollmentNamingResponseSchema = z.strictObject({
  entity: z.string(),
  group: z.string().nullable(),
  dimension: z.string().nullable(),
  changed: z.boolean(),
}) satisfies z.ZodType<BrainEnrollmentNamingResponse, unknown>;

// ---------------------------------------------------------------------------
// The warehouse producer's run report (#5042, ADR-0037 §4)
// ---------------------------------------------------------------------------

/**
 * Why one enrolled pair produced nothing on a run.
 *
 * **The only DECLARATION** — `lib/brain/warehouse-producer.ts` derives
 * `WarehouseRefusalReason` from this tuple rather than spelling the union a
 * second time, on `BRAIN_ENROLLMENT_NAME_MAX`'s precedent and for its reason: the
 * forbidden dependency direction is `@useatlas/schemas` → `@atlas/api`, and this
 * one is the reverse. Two spellings would let the wire enum and the producer's
 * own arms drift, and the failure is a 500 on the response parse rather than a
 * red build.
 *
 * Each arm:
 *
 *   - `entity-not-published` — enrolled, but not in the published semantic layer.
 *   - `entity-unreadable` — the entity IS published and still could not be read:
 *     its name resolves in more than one connection group, or its YAML declares no
 *     `table:`. Split from `entity-not-published` because that arm's remedy is
 *     *publish the entity*, which is a no-op advice for an entity that is already
 *     published — the admin follows it, nothing changes, and the real defect is
 *     never named.
 *   - `no-primary-key` / `composite-primary-key` — nothing identifies one row, so
 *     a subject would have to be guessed, and a guessed subject is a homonym.
 *   - `dimension-not-found` — the entity is published and declares no such name.
 *   - `measure-not-per-row` — the name is a MEASURE, an aggregate over rows,
 *     where every claim the producer emits is about one row.
 *   - `ambiguous-dimension` — ADR-0037 §4's fail-closed rule: the name is enrolled
 *     on two entities at once, so one predicate would carry two meanings.
 *   - `row-cap-exceeded` — the table is larger than one review queue, and an
 *     arbitrary subset would look at rest like a complete reading of it.
 *   - `snapshot-rejected` — the query the producer would run does not pass Atlas's
 *     SELECT-only, single-statement, whitelist-scoped gate. **Permanent**: the
 *     table is outside the whitelist or a `sql:` expression is malformed, and
 *     re-running changes nothing.
 *   - `snapshot-failed` — the run could not complete for this entity: the
 *     datasource read failed, the SQL gate threw rather than answering, the
 *     entity's transaction rolled back, or Atlas could not confirm the gate's
 *     verdict was about the statement it was going to run (#5230). Nothing was
 *     stamped. The last of the four is an Atlas wiring fault rather than an
 *     environment one, and its message says so and carries the request id. Of the
 *     other three, two name a remedy — fix the entity YAML, or drain the review
 *     queue before re-running — and the gate-throw arm names none, because its cause
 *     is not visible from the wire. Retryable, but not
 *     always usefully so — a dropped table fails the same way forever, and after a
 *     rolled-back transaction earlier entities have already COMMITTED, so that
 *     message tells the operator to drain the review queue before re-running. Split
 *     from `snapshot-rejected` because one message cannot carry both *"retry"* and
 *     *"retrying will never work"*.
 *   - `snapshot-already-recorded` — this exact snapshot instant is already in
 *     `brain_episodes`, so its claims are too and the entity was skipped. Reported
 *     rather than omitted: an entity that vanishes from BOTH lists is the silence
 *     this response exists to remove.
 */
export const BRAIN_WAREHOUSE_REFUSAL_REASONS = [
  "ambiguous-dimension",
  "entity-not-published",
  "entity-unreadable",
  "dimension-not-found",
  "measure-not-per-row",
  "no-primary-key",
  "composite-primary-key",
  "row-cap-exceeded",
  "snapshot-rejected",
  "snapshot-failed",
  "snapshot-already-recorded",
  /**
   * The entity's NAMING dimension (#5043) was itself refused — it went ambiguous
   * across two entities, or left the semantic layer. The pair's own refusal sits
   * beside this one and says which.
   *
   * Its own arm rather than folding into that refusal, because the CONSEQUENCE is
   * different in kind and worse: the producer clears the entity's store entries,
   * so claims about its rows stop matching what people call them. Left silent it
   * reported as `entitiesStored: 0`, which is byte-identical to "this entity was
   * never named" while the enrollment surface still showed it as named.
   */
  "naming-dimension-refused",
  /**
   * Atlas could not establish which datasource the entity's snapshot should read
   * (#5284). Its name resolves under more than one connection group, its group did
   * not resolve to a visible primary, or it is absent from the DB-backed published
   * catalog the workspace was resolved against.
   *
   * ⚠️ **A REFUSAL rather than a fallback, and that is the whole point of the arm.**
   * The producer previously answered this question from the entity YAML's
   * `connection:` hint alone and read its absence as *"the deployment's default
   * datasource"*. On a DB-backed semantic layer that hint is null for every entity,
   * so every group-scoped workspace silently sent every snapshot to the default —
   * on a stock SaaS deploy, the demo database. Defaulting when the answer is
   * UNKNOWN is what made that invisible: a wrong-datasource read is
   * indistinguishable from a correct one until someone reads the claims.
   *
   * So an unplaceable entity produces nothing and says so. The cost is a refusal an
   * admin has to act on; the alternative is drafts about the customer's company
   * built from another database's rows, filed under the enrolled entity's
   * provenance.
   */
  "connection-unresolved",
  /**
   * One entity NAME is enrolled under MORE THAN ONE connection group (#5286), so
   * every pair naming it is refused — both sides, on `ambiguous-dimension`'s
   * rule and for its reason.
   *
   * Enrollment became group-scoped in 0205, so this is a state an admin can now
   * reach deliberately: two published `test_orders`, two enrollments, two
   * different databases. What it cannot survive is what the producer WRITES
   * about them. `brain_entity.entity_id` hashes `(workspace, entity, primary
   * key)`, the fact subject surface carries the entity name, the vocabulary edge
   * is keyed on it, and the coverage evidence join recovers it from
   * `warehouse:<entity>@<instant>` — not one of those carries the group. So two
   * groups' rows would land in one identity space, and two rows that are merely
   * same-numbered would read as the same subject.
   *
   * ⚠️ That is a FALSE `same` at the publish gate, which `brain_entity`'s own
   * header calls the one direction with no inverse — strictly worse than the
   * missing warehouse fact a refusal costs. So the producer refuses both and
   * names the groups, exactly as ADR-0037 §4 refuses a dimension ambiguous
   * across two entities. Enrolling the pair in ONE group produces normally.
   */
  "enrolled-in-two-groups",
  /**
   * Two MEMBERS of one connection group hold a row with the same primary key
   * for this entity, so the union Atlas reads has two rows with one identity
   * (#5326).
   *
   * A group's members are its environments (`connection_groups`, whose UI copy
   * says "environment"), and since #5326 the producer reads EVERY member rather
   * than the alphabetically-first one — a sharded group's answer to *"how many
   * organizations do we have"* is the union, and one shard's rows asserted as
   * the company's is the defect that arm was written for.
   *
   * ⚠️ **The union is only sound while the members' keys are disjoint, and this
   * is the arm for when they are not.** `brain_entity.entity_id` hashes
   * `(workspace, entity, primary key)` and the fact subject surface carries the
   * entity name — neither carries the MEMBER. So two shards keyed by per-shard
   * sequential integers put two different customers' rows under one subject:
   * a false `same` at the publish gate, the one direction with no inverse. It
   * is `enrolled-in-two-groups`' argument one scope down, and
   * `buildWarehouseClaims`' first-writer-wins arm is the same rule one scope
   * further in.
   *
   * The whole entity is refused rather than the colliding rows dropped. Within
   * one member a collision is a data-quality note about a declared key — the
   * surviving rows still describe that table. Across members it says the
   * premise of the union is false, and the rows that did NOT collide are then
   * an arbitrary subset of two populations, which at rest reads exactly like a
   * complete reading of one. The message names the MEMBERS and how many subjects
   * collide — never a colliding key itself, which is a primary key read out of a
   * customer's warehouse and stays off the wire like every other row value.
   */
  "subject-collides-across-members",
] as const;

export const BrainWarehouseRefusalSchema = z.strictObject({
  entity: z.string(),
  dimension: z.string(),
  reason: z.enum(BRAIN_WAREHOUSE_REFUSAL_REASONS),
  message: z.string(),
});

export const BrainWarehouseEntityOutcomeSchema = z.strictObject({
  entity: z.string(),
  rows: z.number().int().nonnegative(),
  candidates: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  corroborated: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  /**
   * Created facts carrying a non-null **`object_cmp`** — `ReconcileReport.comparable`,
   * passed through unchanged.
   *
   * ⚠️ NOT `subject_cmp`, which is the column this producer is the first thing able
   * to fill. An earlier version of this comment said it was, which is a claim a
   * reader would have used to conclude the producer was doing nothing: warehouse
   * objects are mostly unparseable strings, so this number is legitimately 0 on runs
   * that populated `subject_cmp` for every row. `warehouse-producer-pg.test.ts`
   * asserts the two independently, at different values, so they cannot be conflated
   * again.
   */
  comparable: z.number().int().nonnegative(),
  unidentifiedRows: z.number().int().nonnegative(),
  collidingSubjectRows: z.number().int().nonnegative(),
  /**
   * Cells that held a value no claim surface can be made of — a `jsonb`, a `bytea`,
   * an array, a `NaN`.
   *
   * Counted apart from a SQL `NULL`, which is not counted at all. A NULL asserts
   * nothing and is the ordinary case; an unsurfaceable cell is an ENROLLMENT
   * MISTAKE (the surface offers every dimension regardless of type), and folding
   * the two together makes a pair that can never produce anything look exactly like
   * a column that happens to be empty.
   */
  unsurfaceableCells: z.number().int().nonnegative(),
  /**
   * Rows whose PRIMARY KEY held such a value — the same distinction at the subject
   * position. Separate from {@link unsurfaceableCells} because it is categorically
   * worse: a bad cell costs one claim, a bad key column means NOTHING about that
   * entity can ever be emitted.
   */
  unsurfaceableKeyRows: z.number().int().nonnegative(),
  /**
   * Cells that were ABSENT — NULL, blank, or otherwise nothing a claim can be made
   * of (#5349). Reported, never refused: most cells are legitimately empty most of
   * the time, so a refusal per absent cell would be worse than the silence this
   * replaced.
   *
   * ⚠️ **Read it beside `rows`.** The case this exists for is a freshly enrolled
   * pair whose column is NULL on every row: it emitted nothing, filed no refusal
   * and logged nothing, and `created: 0` is indistinguishable from "nothing changed
   * since the last run" — the healthy steady state on a static workspace. With this
   * number, "0 of 900 cells had a value" and "the pair was never read" stop being
   * the same observation.
   */
  absentCells: z.number().int().nonnegative(),
  cardinalityProposed: z.array(z.string()).readonly(),
  /**
   * Entity-store entries written for this entity (#5043).
   *
   * ⚠️ **On the wire even when it is 0, and 0 is the number that matters.** An
   * entity with no naming dimension writes no entries, resolves nothing, and is
   * otherwise byte-identical in this report to one whose store is working —
   * ADR-0039's *"an empty store and a correctly-working store are
   * indistinguishable from inside the code."* This field is what makes them
   * distinguishable from OUTSIDE it, and it is the number #5197 verifies on prod.
   */
  entitiesStored: z.number().int().nonnegative(),
  /**
   * Rows that produced claims but no entity-store entry, because the naming
   * dimension held nothing usable for them.
   *
   * Always 0 when the entity has no naming dimension at all — that case is a
   * `entitiesStored: 0` with no `unnamedRows`, because *"nobody named a surface"*
   * and *"the surface column is empty for these rows"* have different remedies.
   */
  unnamedRows: z.number().int().nonnegative(),
});

/**
 * What the entity-edge producer did with a run's edges (#5043).
 *
 * The counters sum to MORE than the proposals offered, deliberately: an eligible
 * row whose auto-approval the vocabulary refused is counted under BOTH `queued`
 * and `refused`, because it IS queued for a human and the auto-approval DID fail.
 *
 * ⚠️ `rejected` is the counter to read on a re-run — a producer whose second pass
 * reports zero there is one whose human removals did not stick.
 */
export const BrainAliasProducerCountersSchema = z.strictObject({
  queued: z.number().int().nonnegative(),
  autoApproved: z.number().int().nonnegative(),
  deduped: z.number().int().nonnegative(),
  alreadyApproved: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  refused: z.number().int().nonnegative(),
});

/** A wire count: whole, never negative. */
const nonNegativeInt = () => z.number().int().nonnegative();

/**
 * The three reasons an entry earns NO edge — the list, and the single source both
 * the field set and the partition sum are built from.
 *
 * ⚠️ **Derived rather than written twice, on `42dbeac72`'s precedent** (deriving
 * `HardDeleteCounts` from the purge registry). A fourth refusal reason added to the
 * field list while `checkCensus` went on summing three would leave the partition
 * check silently under-counting, so every real run carrying the new reason would
 * pass while being unaccounted for — a guard that stops guarding without failing.
 */
const CENSUS_REFUSALS = ["ambiguous", "selfEdges", "unmintedIds"] as const;

/**
 * The counts every reason an entry produced no edge — disjoint by construction in
 * `entity-store.ts`, and therefore only meaningful together.
 */
const entityEdgeCensusFields = {
  /** Entries in the persisted, workspace-wide store the pass read. */
  entries: nonNegativeInt(),
  /**
   * Refused because the name is shared with another entity — two `Acme` accounts,
   * and neither resolves by name. Ordinary data with a permanent consequence.
   */
  ambiguous: nonNegativeInt(),
  /** A natural-key table: the name and the key are already one. Nothing to do. */
  selfEdges: nonNegativeInt(),
  /**
   * Ids no producer could have minted — a hand-edited or downgraded bundle. These
   * resolve NOTHING, ever, and the remedy is a re-import rather than a warehouse
   * edit, which is why they are counted apart from `ambiguous`.
   */
  unmintedIds: nonNegativeInt(),
} as const;

/** How far the entity-edge pass got before it threw. See `EntityEdgeProgress`. */
export const BrainEntityEdgeProgressSchema = z.discriminatedUnion("phase", [
  /**
   * No store was obtained — the read threw, OR it answered a shape that is not a
   * store. NOTHING is known, and no count is reported because none was taken.
   *
   * ⚠️ Not simply "the read threw", which is what this line used to say: the
   * non-array guard lands here too, and there the read RETURNED.
   */
  z.strictObject({ phase: z.literal("store-read") }),
  /** The store was read; planning threw. Nothing was submitted, so nothing was committed. */
  z.strictObject({ phase: z.literal("planning"), entries: nonNegativeInt() }),
  /**
   * The batch was HANDED TO the vocabulary seam, and the seam threw part-way.
   *
   * ⚠️ "Handed to", not "submitted to the database". The seam does a dynamic
   * `import()` before its first write, so a module-resolution failure lands here
   * having written nothing — which is why `proposalsAttempted` is documented as an
   * upper bound on the blast radius rather than as a count of commits.
   *
   * ⚠️ **`positive()`, not `nonNegativeInt()`** — this phase's definition is that a
   * batch was handed over, so `proposalsAttempted: 0` is unconstructible; the pass
   * returns `nothing-to-propose` before it ever advances here. Zero on this arm was
   * one of the illegal states the reshape claimed to remove, surviving as a count
   * instead of as a `null`. {@link checkCensus} closes the rest of the range.
   */
  z
    .strictObject({
      phase: z.literal("proposing"),
      ...entityEdgeCensusFields,
      proposalsAttempted: z.number().int().positive(),
    })
    .superRefine(checkCensus),
]);

/** One census, plus whatever its arm carries. See {@link checkCensus}. */
type CensusBearing = Record<(typeof CENSUS_REFUSALS)[number] | "entries", number> &
  ({ readonly kind: string } | { readonly phase: string; readonly proposalsAttempted: number });

/** The distinct refusals this check can raise, so a test can name WHICH one fired. */
export const BRAIN_CENSUS_ISSUES = {
  overCounted:
    "more store entries were refused an edge than the store holds — the counts are disjoint " +
    "partitions of `entries`, so their sum can never exceed it",
  allRefusedYetProposed:
    "a batch was submitted from a store in which every entry was refused an edge — if nothing " +
    "earned one there was nothing to propose",
  unaccountedYetIdle:
    "nothing was proposed, yet some entries are unaccounted for — an entry that was neither " +
    "ambiguous, a self-edge nor unminted earns an edge, so it would have been",
  tooFewProposals:
    "fewer proposals were submitted than there were entries to propose for — every entry that " +
    "earns an edge submits at least one",
} as const;

/**
 * The census's cross-field invariants, enforced AT THE BOUNDARY.
 *
 * ⚠️ **The counts are disjoint partitions of `entries`, and until this existed that
 * was a sentence in a docstring rather than a check.** `entityEdgeProposals` puts
 * every entry down exactly one of four paths, so the refusals can never exceed
 * `entries` — yet bare non-negative integers spell `{entries: 0, ambiguous: 5}`,
 * "counted five in a store that held nothing". That is one of the illegal states
 * this union was reshaped to remove, reached by arithmetic instead of by a `null`.
 *
 * TypeScript cannot express a sum relation, so the TS union genuinely could not hold
 * this; Zod can, the report IS parsed here, and two siblings in this file
 * (`BrainFactWillWidenSchema`, `BrainFactOversightSchema`) already argue that a
 * cross-check whose operands ride the wire together belongs at the boundary rather
 * than trusted to the producer.
 *
 * ⚠️ **The arm decides the rule STRUCTURALLY — there is no flag to get wrong.** The
 * first cut took an `earnedAnEdge: boolean` re-derived by hand at three call sites,
 * with nothing checking the derivation; passing the wrong literal type-checked
 * silently. The discriminant is already in `value`, so it is read from there.
 *
 * ⚠️ **The branches are NOT mutually exclusive by accident, and the first cut's were
 * mutually MASKING.** An over-count on an idle arm satisfied both the first and the
 * third branch, so either could be deleted alone with every test green — and the
 * first branch is the only thing refusing an over-count on the arms that DID
 * propose. Each branch now returns after firing only where the remaining ones are
 * genuinely inapplicable, and `packages/schemas/src/__tests__/brain.test.ts` names
 * each message so one deletion cannot hide behind another.
 */
function checkCensus(value: CensusBearing, ctx: z.RefinementCtx): void {
  const earnedAnEdge = !("kind" in value && value.kind === "nothing-to-propose");
  const accountedFor = CENSUS_REFUSALS.reduce((sum, key) => sum + value[key], 0);
  const earners = value.entries - accountedFor;
  const raise = (message: string) => ctx.addIssue({ code: "custom", path: ["entries"], message });

  if (accountedFor > value.entries) {
    raise(BRAIN_CENSUS_ISSUES.overCounted);
    return;
  }
  if (earnedAnEdge && earners === 0) {
    raise(BRAIN_CENSUS_ISSUES.allRefusedYetProposed);
    return;
  }
  if (!earnedAnEdge && earners !== 0) {
    raise(BRAIN_CENSUS_ISSUES.unaccountedYetIdle);
    return;
  }
  // ⚠️ Every earner submits AT LEAST ONE proposal (`entity-store.ts` pushes one per
  // edge position, and there is always at least one position), so a submitted batch
  // smaller than the number of earners is unconstructible. `positive()` alone closed
  // only `0` and left every other wrong count — including a fixture in this very
  // diff that claimed 4 submissions for 7 earners under a comment asserting it was
  // arithmetically possible.
  //
  // ⚠️ The relation is `>=`, deliberately NOT the exact `earners × positions`. The
  // position count is a producer implementation detail in another package; encoding
  // it here would make every historical report invalid the day a third position is
  // added, which is not a property a wire schema should have.
  if ("proposalsAttempted" in value && value.proposalsAttempted < earners) {
    raise(BRAIN_CENSUS_ISSUES.tooFewProposals);
  }
}

/**
 * What the entity-edge pass did — the wire half of `EntityEdgeOutcome` (#5277).
 *
 * ⚠️ **Pinned EXACTLY against its TypeScript counterpart by `_reportMatchesWireSchema`
 * in `api/routes/admin-brain-enrollment.ts`** — a mutual-`extends` `ExactShape`, which
 * is stronger than the one-way `satisfies` used elsewhere in this file and catches a
 * dropped arm, a widened discriminant, and an optionality or nullability flip in BOTH
 * directions, structurally through the nested union. Named here because that pin lives
 * in a third file: editing either definition alone reds a route, and nothing in either
 * definition said so.
 *
 * What the pin structurally CANNOT see: `strictObject` vs `object`, `.int()`/
 * `.nonnegative()` refinements, `superRefine` checks, and `readonly` PROPERTY
 * modifiers. It DOES see `readonly` on arrays — `readonly T[]` and `T[]` are not
 * mutually assignable — which is why `entities`/`refusals` carry `.readonly()`.
 * Measured: dropping `.readonly()` from `entities` reds the pin with
 * `Type 'true' is not assignable to type 'never'`, which is also the cheapest proof
 * that the pin is alive at all.
 *
 * ⚠️ **ONE discriminated union replacing three parallel fields**, because
 * `entityEdges: counters | null`, `entityEdgesFailed: string | null` and
 * `entityEdgesAmbiguous: number` could spell combinations that were never a run
 * (counters AND a failure message) while collapsing four real outcomes onto one
 * value — nothing named, everything already snapshotted, every proposal refused,
 * and *the pass threw*. Only the last is a run an operator must act on, and under
 * the old shape a vocabulary lock timeout read as "nobody has named anything" to
 * the admin whose next action was to go name something.
 *
 * ⚠️ **The `failed` arm makes PARTIAL PROGRESS representable, which is the state
 * the old shape could not spell at all.** The producer commits per proposal and an
 * auto-approved entity edge re-keys the corpus, so "threw before proposing
 * anything" and "threw after committing 900 edges" are materially different runs
 * that used to be the same two wire values.
 *
 * ⚠️ **NOTHING IS NULLABLE, and the first cut of this schema had two.** Nullable
 * counts beside a non-nullable `proposalsAttempted` admit three shapes that are
 * not runs — a count from a store never read, a submission without a read, a
 * submission before planning. What varies is HOW FAR THE PASS GOT, so that is
 * spelled once, as {@link BrainEntityEdgeProgressSchema}, and each phase carries
 * exactly the numbers it established.
 *
 * ⚠️ The counts travel TOGETHER wherever they are known. `entityEdgeProposals`
 * returns THREE disjoint reasons an entry earns no edge, and only `ambiguous` used to
 * reach the report — so 500 rows carrying ids no producer could have minted were
 * byte-identical to 500 healthy natural-key rows. One resolves every surface; the
 * other resolves nothing, ever, and wants a re-import rather than a warehouse edit.
 * Their arithmetic is enforced by {@link checkCensus}, because TypeScript cannot.
 */
export const BrainEntityEdgeOutcomeSchema = z.discriminatedUnion("kind", [
  /**
   * The pass ran and had nothing to propose. All four reasons are carried, because
   * `entries` separates only empty from non-empty — and they must ACCOUNT for every
   * entry, since an entry that fell into none of them would have earned an edge.
   */
  z
    .strictObject({
      kind: z.literal("nothing-to-propose"),
      ...entityEdgeCensusFields,
    })
    .superRefine(checkCensus),
  /**
   * The batch ran to completion.
   *
   * ⚠️ `counters.rejected` is the number to read on a re-run — a producer whose
   * second pass reports zero there is one whose human removals did not stick.
   */
  z
    .strictObject({
      kind: z.literal("proposed"),
      ...entityEdgeCensusFields,
      counters: BrainAliasProducerCountersSchema,
    })
    .superRefine(checkCensus),
  /**
   * The pass threw. Every fact and store entry is still committed.
   *
   * ⚠️ `message` is a FIXED sentence plus the request id, never the caught error's
   * message: both throw sources are internal-DB-backed, so the raw text would put
   * a host and a role in a 200 body. `.min(1)` because a message with no
   * correlation handle makes "go read the log" a dead end.
   */
  z.strictObject({
    kind: z.literal("failed"),
    reached: BrainEntityEdgeProgressSchema,
    message: z.string().min(1),
  }),
]);

/**
 * The producer's run report — what `runWarehouseProducer` returns.
 *
 * `enrolled` and `refusals` are both on it deliberately: a run that emitted
 * nothing because the reach is empty and a run that emitted nothing because every
 * pair was refused are the same silence in `brain_facts`, and ADR-0039 names that
 * indistinguishability as the milestone's central invisibility. The two numbers are
 * what separate them.
 */
export const BrainWarehouseRunReportSchema = z.strictObject({
  workspaceId: z.string(),
  snapshotAt: z.string(),
  enrolled: z.number().int().nonnegative(),
  entities: z.array(BrainWarehouseEntityOutcomeSchema).readonly(),
  refusals: z.array(BrainWarehouseRefusalSchema).readonly(),
  created: z.number().int().nonnegative(),
  corroborated: z.number().int().nonnegative(),
  /** What the entity-edge pass did (#5043, #5277). */
  entityEdges: BrainEntityEdgeOutcomeSchema,
});

/**
 * `POST /api/v1/admin/brain-enrollment/produce`.
 *
 * ⚠️ **A UNION, because the degraded branch must not be able to SAY anything about
 * the run.** The route's response is built after N transactions have committed, so
 * a serialization failure there cannot report "failed" — the drafts are in the
 * queue and the retry files another round. The first cut absorbed it by returning
 * the counts with `entities: []` and `refusals: []`, which is worse than the 500 it
 * replaced: `{enrolled: 8, created: 0, refusals: []}` is a confident all-clear for a
 * run that may have refused every pair, handed to the one operator whose next
 * action is to press Run again. That is exactly the pair-of-numbers argument above,
 * defeated by the branch that has established neither number.
 *
 * So the unavailable arm carries ONLY route-known facts — the workspace, the
 * request id, and a sentence — and no field of the report at all. A caller cannot
 * mistake it for a result, and cannot read a zero out of it.
 *
 * The same shape three siblings in this file already use (`BrainFactEpisodeView`,
 * `BrainFactAttributionView`, `BrainVocabularyBlastRadius`): a withheld arm is what
 * makes the numbers UNREADABLE on the branch where they are meaningless, rather
 * than readable and wrong. Two of those three use `z.discriminatedUnion` and so
 * does this — a plain `z.union` reports a failure as ONE `invalid_union` issue at
 * `path: []`, which collapses every consumer's diagnostic to nothing.
 *
 * ⚠️ That diagnostic argument is the whole argument. An earlier version added
 * "…and renders as `anyOf` with no discriminator for every generated client",
 * which overstates what the generator gives you: `apps/docs/openapi.json` contains
 * ZERO `"discriminator"` keys, and a `discriminatedUnion` emits a bare `oneOf`
 * exactly as a plain union would. Measured, not reasoned — the choice is worth
 * making for the zod issue paths alone.
 */
export const BrainWarehouseRunResponseSchema = z.discriminatedUnion("reportComplete", [
  BrainWarehouseRunReportSchema.extend({ reportComplete: z.literal(true) }),
  z.strictObject({
    reportComplete: z.literal(false),
    workspaceId: z.string(),
    requestId: z.string(),
    message: z.string(),
  }),
]);

/**
 * The retirement surface's row (#5403) — a published warehouse-derived fact,
 * with the id that `POST /{id}/retract` consumes.
 *
 * Deliberately a DIFFERENT schema from `BrainFactCandidateSchema` rather than a
 * `.pick()` of it. The two surfaces answer different questions and must be free
 * to diverge: sharing a projection is exactly how the review queue and the
 * retirement listing would drift back into one thing, which is the failure
 * `#5403` exists to prevent and the reason its acceptance criteria pin both
 * surfaces with one test.
 */
export const BrainFactRetirableObservationSchema = z.object({
  id: z.string(),
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
  source: z.string().nullable(),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  ingestedAt: z.string().nullable(),
}) satisfies z.ZodType<BrainFactRetirableObservation, unknown>;

export const BrainFactRetirableListResponseSchema = z.object({
  observations: z.array(BrainFactRetirableObservationSchema),
  total: z.number().int().nonnegative(),
}) satisfies z.ZodType<BrainFactRetirableListResponse, unknown>;

// ---------------------------------------------------------------------------
// Stage-0 triage: the backlog, and the verb that clears it (#5534)
// ---------------------------------------------------------------------------

/**
 * Longest `rule` the re-queue will accept.
 *
 * `BRAIN_TENSION_FORECAST_SURFACE_MAX_CHARS`' reason, one surface over: this is
 * a rule id from a closed vocabulary of short tokens, and an unbounded string
 * reaching a `text` comparison on a pooled connection is a request-shaped way
 * to spend CPU. The route ALSO checks membership against the vocabulary it
 * evaluates — this bound is what stops a megabyte from reaching that check.
 */
export const BRAIN_TRIAGE_RULE_MAX_CHARS = 64;

/**
 * ⚠️ `rule` is `z.string()`, not an enum over the rule ids.
 *
 * The vocabulary lives in `packages/api/src/lib/brain/triage.ts`, and #5336
 * requires it enumerable in ONE place. A tuple here would be a second copy that
 * the compiler cannot tie back to the first — `@useatlas/schemas` does not
 * import from `@atlas/api` — so it would drift silently and reject a rule the
 * server had just added.
 *
 * It is also the WRONG shape for a read of what is at rest, independently of
 * drift: `triage_reason` holds whatever a past deploy wrote, so a rule retired
 * from the vocabulary still has marks on rows. An enum here would reject the
 * response describing exactly the backlog an admin most needs to see. `known`
 * is how a client tells a live rule from a retired one without holding a copy
 * of the list.
 */
export const BrainTriageBacklogBucketSchema = z.strictObject({
  rule: z.string(),
  episodes: z.number().int().nonnegative(),
  known: z.boolean(),
}) satisfies z.ZodType<BrainTriageBacklogBucket, unknown>;

export const BrainTriageRuleDescriptorSchema = z.strictObject({
  id: z.string(),
  rationale: z.string(),
}) satisfies z.ZodType<BrainTriageRuleDescriptor, unknown>;

/**
 * `z.strictObject` for `BrainFactTensionSweepResponseSchema`'s reason, one
 * domain over: the obvious next thing a producer would attach to a triage
 * backlog is a SAMPLE of the held episodes, and an episode body is the rawest
 * content in the system — ungated by any claim-level review, carrying whatever
 * a chat channel said. Strict makes attaching one a parse failure at the
 * boundary rather than a disclosure in a browser.
 */
export const BrainTriageBacklogResponseSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  byRule: z.array(BrainTriageBacklogBucketSchema),
  rules: z.array(BrainTriageRuleDescriptorSchema),
  enabled: z.boolean(),
}) satisfies z.ZodType<BrainTriageBacklogResponse, unknown>;

/**
 * `rule` absent, or explicitly `null`, means EVERY rule.
 *
 * Both spellings are admitted deliberately. A console that binds a select to
 * this field sends `null` for "all"; a script that omits the key entirely means
 * the same thing, and making one of them a 400 would be a distinction with no
 * meaning behind it. The route folds both to the statement's NULL parameter.
 */
export const BrainTriageRequeueRequestSchema = z.strictObject({
  rule: z.string().min(1).max(BRAIN_TRIAGE_RULE_MAX_CHARS).nullish(),
}) satisfies z.ZodType<WithLooseOptionals<BrainTriageRequeueRequest>, unknown>;

/**
 * `z.strictObject`, and here it guards something specific: the ids of the
 * episodes that moved. Attaching them would name which rows a rule had held —
 * a workspace-wide episode projection on a surface whose whole justification is
 * that it discloses counts and rule ids only.
 */
export const BrainTriageRequeueResponseSchema = z.strictObject({
  requeued: z.number().int().nonnegative(),
  rule: z.string().nullable(),
}) satisfies z.ZodType<BrainTriageRequeueResponse, unknown>;
