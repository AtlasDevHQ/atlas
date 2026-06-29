/**
 * Schemas for the datasource-profiling NDJSON stream
 * (`POST /api/v1/datasources/{id}/profile`, #4052 / ADR-0027). The `atlas
 * datasource profile` CLI client `.safeParse()`s each stream line against
 * {@link DatasourceProfileStreamEventSchema} and resolves with the terminal
 * `result` event ({@link DatasourceProfileResultSchema}). Both pin to the
 * shared types so the stream's machine-checkable contract lives once.
 *
 * The terminal-error code enum is INLINED (not value-imported from
 * `@useatlas/types`) and `satisfies readonly DatasourceProfileErrorCode[]`:
 * this module is scaffold-bound, and a value import of a symbol absent from the
 * pinned-published `@useatlas/types` would break the scaffold build + trip
 * `check-published-symbols`. The `satisfies` keeps it drift-safe at compile
 * time. See `feedback_useatlas_types_scaffold_gotcha`.
 */
import { z } from "zod";
import type {
  DatasourceProfileErrorCode,
  DatasourceProfileResult,
  DatasourceProfileStreamEvent,
} from "@useatlas/types";

const PROFILE_ERROR_CODES = [
  "reconnect_required",
  "profiling_failed",
  "internal_error",
] as const satisfies readonly DatasourceProfileErrorCode[];

/** The fields of the terminal `result` payload, shared by the result schema and the `result` stream member. */
const profileResultFields = {
  id: z.string(),
  queryable: z.boolean(),
  persisted: z.boolean(),
  persistedStatus: z.string().optional(),
  entitiesGenerated: z.number().int(),
  metricsGenerated: z.number().int(),
  tables: z.array(z.string()),
  profilingErrors: z.number().int(),
  incomplete: z.boolean(),
  incompleteTables: z.array(z.string()).optional(),
  elapsedMs: z.number(),
} as const;

export const DatasourceProfileResultSchema = z.object(
  profileResultFields,
) satisfies z.ZodType<DatasourceProfileResult, unknown>;

// Discriminated union over the four NDJSON event shapes. `satisfies` pins it to
// the shared SSOT at compile time.
const profileStreamUnion = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), total: z.number().int() }),
  z.object({
    type: z.literal("table"),
    name: z.string(),
    index: z.number().int(),
    total: z.number().int(),
    status: z.enum(["done", "error"]),
    error: z.string().optional(),
  }),
  z.object({ type: z.literal("result"), ...profileResultFields }),
  z.object({
    type: z.literal("error"),
    error: z.enum(PROFILE_ERROR_CODES),
    message: z.string(),
    requestId: z.string().optional(),
  }),
]) satisfies z.ZodType<DatasourceProfileStreamEvent>;

/**
 * Validate one raw NDJSON line against the profile stream-event union, returning
 * the typed {@link DatasourceProfileStreamEvent} or `null` for a line that
 * doesn't match a known event (a malformed line, or a forward-compat event type
 * a newer server added — the CLI skips those).
 *
 * Exposed as a function rather than the raw schema because a `z.discriminatedUnion`
 * types `.safeParse`'s argument to its own members, so an `unknown` stream line
 * isn't assignable at the call site — and zod's generic arity resolves
 * inconsistently across this repo's toolchains. Admitting the `unknown` input
 * behind this single `z.ZodTypeAny` boundary keeps every consumer (and every
 * toolchain) honest without leaking the cast to call sites.
 */
export function parseDatasourceProfileStreamEvent(
  line: unknown,
): DatasourceProfileStreamEvent | null {
  const result = (profileStreamUnion as z.ZodTypeAny).safeParse(line);
  return result.success ? (result.data as DatasourceProfileStreamEvent) : null;
}
