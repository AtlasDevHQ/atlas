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
import type {
  BrainEntityRole,
  BrainFactCandidate,
  BrainFactAttributionView,
  BrainFactCandidateListResponse,
  BrainFactCandidateSummary,
  BrainFactEpisodeView,
  BrainFactOversight,
  BrainFactOversightBucket,
  BrainFactOversightBucketKind,
  BrainFactOversightLabelPolicy,
  BrainFactOversightTotals,
  BrainFactPromotionBlock,
  BrainFactProvenanceView,
  BrainFactRetractResponse,
  BrainFactReviewStatus,
  BrainFactTensionView,
  BrainResultTier,
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
 * Ordered by ADR-0036's trust ordering (fact 2 → episode 3 → the
 * outside-the-ordering document class), which is ALSO the deterministic
 * tiebreak `fuseRankedLists` applies to equally-relevant rows. One list, so the
 * two cannot drift into disagreeing about which of two tied rows comes first.
 */
export const BRAIN_RESULT_TIERS = [
  "fact",
  "raw-episode",
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
  "fact",
  "raw-episode",
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
export const BrainFactAttributionViewSchema = z.discriminatedUnion("visible", [
  z.object({
    visible: z.literal(true),
    sourceId: z.string().nullable(),
    actor: z.string().nullable(),
    occurredAt: z.string().nullable(),
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

export const BrainFactTensionViewSchema = z.discriminatedUnion("visible", [
  z.object({
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
    corroborationCount: z.number().int().nonnegative(),
    provenance: BrainFactProvenanceViewSchema,
  }),
  z.strictObject({
    visible: z.literal(false),
    factId: z.string(),
    edgeDirection: BrainFactTensionDirectionSchema,
  }),
]) satisfies z.ZodType<BrainFactTensionView, unknown>;

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

export const BrainFactCandidateSchema = z.object({
  id: z.string(),
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
  status: z.enum(BRAIN_FACT_REVIEW_STATUSES),
  predicateCardinality: z.enum(["single", "multi"]),
  visibleTo: z.array(z.string()),
  malformedGrantIndices: z.array(z.number().int().nonnegative()),
  grantReadable: z.boolean(),
  corroborationCount: z.number().int().nonnegative(),
  provenance: BrainFactProvenanceViewSchema,
  episode: BrainFactEpisodeViewSchema.nullable(),
  tensions: z.array(BrainFactTensionViewSchema),
  promotionBlock: BrainFactPromotionBlockSchema.nullable(),
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

export const BrainFactRetractResponseSchema = z.object({
  id: z.string(),
  invalidatedAt: z.string(),
}) satisfies z.ZodType<BrainFactRetractResponse, unknown>;

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

const OVERSIGHT_ENVELOPE_FIELDS = {
  buckets: z.array(BrainFactOversightBucketSchema),
  workspaceTotals: BrainFactOversightTotalsSchema,
  reviewableAwaitingReview: z.number().int().nonnegative(),
  countsConsistent: z.boolean(),
  distinctAudiences: z.number().int().nonnegative(),
  bucketsTruncated: z.boolean(),
} as const;

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
  .strictObject(OVERSIGHT_ENVELOPE_FIELDS)
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
  }) satisfies z.ZodType<BrainFactOversight, unknown>;

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
export const BrainFactOversightClientSchema = z.object(
  OVERSIGHT_ENVELOPE_FIELDS,
) satisfies z.ZodType<BrainFactOversight, unknown>;
