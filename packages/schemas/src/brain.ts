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
  BrainFactCandidateListResponse,
  BrainFactCandidateSummary,
  BrainFactEpisodeView,
  BrainFactPromotionBlock,
  BrainFactProvenanceView,
  BrainFactRetractResponse,
  BrainFactReviewStatus,
  BrainFactTensionView,
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

export const BrainFactProvenanceViewSchema = z.object({
  source: z.string().nullable(),
  sourceId: z.string().nullable(),
  episodeId: z.string().nullable(),
  actor: z.string().nullable(),
  producer: z.string().nullable(),
  occurredAt: z.string().nullable(),
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
