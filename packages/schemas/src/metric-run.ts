/**
 * Response schema for the canonical metric-run REST endpoint
 * (`POST /api/v1/metrics/{id}/run`, #4048 / ADR-0027). Plain-zod validator the
 * `atlas metric run` CLI client `.safeParse()`s; the route keeps its own local
 * hono-`z` mirror (`satisfies z.ZodType<RunMetricRestResponse>`). Both pin to
 * the shared {@link RunMetricRestResponse} type.
 */
import { z } from "zod";
import type { RunMetricRestResponse } from "@useatlas/types";

export const RunMetricRestResponseSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  value: z.unknown(),
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number().int(),
  truncated: z.boolean(),
  sql: z.string(),
  executedAt: z.string(),
}) satisfies z.ZodType<RunMetricRestResponse, unknown>;
