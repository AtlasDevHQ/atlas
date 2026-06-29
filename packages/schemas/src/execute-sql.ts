/**
 * Response schema for the raw-SQL REST endpoint (`POST /api/v1/execute-sql`,
 * #4047 / ADR-0027). Plain-zod validator the `atlas sql` CLI client
 * `.safeParse()`s; the route keeps its own local hono-`z` mirror
 * (`satisfies z.ZodType<ExecuteSqlRestResponse>`) because @useatlas/schemas
 * carries no `.openapi()` metadata. Both pin to the shared
 * {@link ExecuteSqlRestResponse} type so the two schemas cannot drift in shape.
 */
import { z } from "zod";
import type { ExecuteSqlRestResponse } from "@useatlas/types";

export const ExecuteSqlRestResponseSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number().int(),
  truncated: z.boolean(),
  executionMs: z.number(),
  executedAt: z.string(),
}) satisfies z.ZodType<ExecuteSqlRestResponse, unknown>;
