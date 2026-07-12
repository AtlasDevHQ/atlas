/**
 * Learned-pattern wire-format schemas.
 *
 * Single source of truth for the admin learned-patterns surface
 * (`/api/v1/admin/learned-patterns`) — shared by the route-layer
 * `@hono/zod-openapi` response contract (the compile-time-typed `c.json`
 * shape + generated OpenAPI doc) and the web-layer `useServerDataTable` /
 * `useAdminFetch` runtime response parsing, so a rename on one side can't
 * silently drift from the other.
 *
 * Before #4579 the route hand-rolled this shape inline with hardcoded enum
 * literals (no tie to the `LEARNED_PATTERN_*` tuples, no `satisfies
 * z.ZodType`), while the cockpit page consumed the endpoint through the
 * unvalidated `useServerDataTable` variant with an `as` cast — so a wire
 * rename surfaced as a silently empty "No learned patterns" table instead of
 * a `schema_mismatch` banner. Centralizing here closes that gap.
 *
 * The enum tuples come from `@useatlas/types` so a new status/source/type
 * propagates without a second edit. `satisfies z.ZodType<T>` (not `as`) makes
 * a field rename in `@useatlas/types` a compile error here instead of passing
 * through to runtime.
 */
import { z } from "zod";
import {
  LEARNED_PATTERN_STATUSES,
  LEARNED_PATTERN_SOURCES,
  LEARNED_PATTERN_TYPES,
  AMENDMENT_TYPES,
  type AmendmentPayload,
  type LearnedPattern,
} from "@useatlas/types";

/** Result of running an amendment's test query (nested in AmendmentPayload). */
const AmendmentTestResultSchema = z.object({
  success: z.boolean(),
  rowCount: z.number(),
  sampleRows: z.array(z.record(z.string(), z.unknown())),
  error: z.string().optional(),
  deferred: z.boolean().optional(),
});

/**
 * Structured payload for `type = 'semantic_amendment'` proposals. The
 * learned-patterns route is query-pattern-only (#4569), so this is always
 * `null` on that surface — but the wire type carries it, so the schema models
 * it faithfully rather than relaxing to an untyped record.
 */
export const AmendmentPayloadSchema = z.object({
  entityName: z.string(),
  amendmentType: z.enum(AMENDMENT_TYPES),
  amendment: z.record(z.string(), z.unknown()),
  rationale: z.string(),
  diff: z.string(),
  testQuery: z.string().optional(),
  testResult: AmendmentTestResultSchema.optional(),
  confidence: z.number(),
}) satisfies z.ZodType<AmendmentPayload>;

/** One learned-pattern row as served on the wire. */
export const LearnedPatternSchema = z.object({
  id: z.string(),
  orgId: z.string().nullable(),
  patternSql: z.string(),
  description: z.string().nullable(),
  sourceEntity: z.string().nullable(),
  sourceQueries: z.array(z.string()).nullable(),
  confidence: z.number(),
  repetitionCount: z.number(),
  status: z.enum(LEARNED_PATTERN_STATUSES),
  proposedBy: z.enum(LEARNED_PATTERN_SOURCES).nullable(),
  reviewedBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  reviewedAt: z.string().nullable(),
  type: z.enum(LEARNED_PATTERN_TYPES),
  amendmentPayload: AmendmentPayloadSchema.nullable(),
  autoPromoted: z.boolean(),
  avgDurationMs: z.number().nullable(),
}) satisfies z.ZodType<LearnedPattern>;

/**
 * Whitelisted sort fields for `GET /api/v1/admin/learned-patterns` — the wire
 * vocabulary shared by the route (which maps each key to a real DB column and
 * rejects anything else with a 400) and the cockpit (which maps its sortable
 * TanStack column ids onto these keys). Kept here, next to the other wire
 * contracts (#4579), so the two sides can't drift: the route's column map is
 * `satisfies Record<LearnedPatternSortKey, string>` (exhaustive) and the web
 * map's values are typed `LearnedPatternSortKey` (a typo is a compile error).
 */
export const LEARNED_PATTERN_SORT_KEYS = ["confidence", "repetition", "latency", "created"] as const;
export type LearnedPatternSortKey = (typeof LEARNED_PATTERN_SORT_KEYS)[number];

/** Sort directions accepted by the same endpoint (`?dir=`). */
export const LEARNED_PATTERN_SORT_DIRECTIONS = ["asc", "desc"] as const;
export type LearnedPatternSortDirection = (typeof LEARNED_PATTERN_SORT_DIRECTIONS)[number];

/**
 * Paginated list envelope for `GET /api/v1/admin/learned-patterns`
 * (`{ patterns, total, limit, offset }`). The route types its response against
 * this and the cockpit page runtime-parses the same schema, so the list shape
 * can't drift between the two.
 */
export const LearnedPatternsListResponseSchema = z.object({
  patterns: z.array(LearnedPatternSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});
