/**
 * Structured-output schemas for the MCP datasource-query tools (#3498,
 * spec 2025-11-25).
 *
 * `executeSQL` and `runMetric` declare an `outputSchema` and return
 * `structuredContent` so downstream clients/agents parse a typed result
 * instead of re-parsing the stringified text block (which is retained for
 * backward compatibility).
 *
 * No wire shape for the `{ columns, rows, row_count, truncated }` result
 * exists in `@useatlas/schemas` today, so these live in the MCP package as
 * the single source of truth for the MCP tool-output shape. A future
 * consolidation could lift them into `@useatlas/schemas` for reuse by the
 * web/SDK clients.
 *
 * Why every field is optional: the MCP SDK requires `structuredContent` on
 * *every* non-error result once a tool declares an `outputSchema`, and a
 * tool has two disjoint non-error shapes — the data result and the
 * `approval_required` governance signal (origin=mcp, never an error). An MCP
 * `outputSchema` must be a single `type: object` schema, so the union of
 * those two shapes is expressed as one object with optional members rather
 * than a top-level `oneOf`. Tests validate a full data result against the
 * schema to keep the success contract honest.
 */

import { z } from "zod/v4";

/** A result row: a flat map of column name → cell value. */
const rowsField = z.array(z.record(z.string(), z.unknown()));
const columnsField = z.array(z.string());

/** Fields shared by the `approval_required` governance branch of both tools. */
const approvalFields = {
  approval_required: z.boolean().optional(),
  approval_request_id: z.string().optional(),
  matched_rules: z.array(z.unknown()).optional(),
  message: z.string().optional(),
} as const;

/**
 * `executeSQL` output. Data branch: `explanation` + the
 * `{ columns, rows, row_count, truncated }` result. Plus the approval
 * governance branch.
 */
export const executeSqlOutputShape = {
  explanation: z.string().optional(),
  row_count: z.number().int().nonnegative().optional(),
  columns: columnsField.optional(),
  rows: rowsField.optional(),
  truncated: z.boolean().optional(),
  ...approvalFields,
} as const;

/**
 * `runMetric` output. Data branch: the metric identity (`id`/`label`/`sql`),
 * the coerced `value` (scalar for single-cell results, rows otherwise), the
 * `{ columns, rows, row_count, truncated }` result, and `executed_at`. Plus
 * the approval governance branch.
 */
export const runMetricOutputShape = {
  id: z.string().optional(),
  label: z.string().optional(),
  value: z.unknown().optional(),
  columns: columnsField.optional(),
  rows: rowsField.optional(),
  row_count: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
  sql: z.string().optional(),
  executed_at: z.string().optional(),
  ...approvalFields,
} as const;

/** Zod objects for validating a result against the declared output schema. */
export const executeSqlOutputSchema = z.object(executeSqlOutputShape);
export const runMetricOutputSchema = z.object(runMetricOutputShape);
