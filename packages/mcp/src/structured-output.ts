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
 * #3750 — MCP "resume" hint appended to an `approval_required` message.
 *
 * MCP has no agent loop or durable run: each tool call is a single
 * synchronous dispatch and the MCP CLIENT (Claude Desktop, etc.) is the
 * loop. So the resume mechanism for a parked MCP tool call is to RE-CALL
 * the same tool once the request is approved — the executeSQL approval gate
 * recognises the prior approval via `hasApprovedRequest` (keyed on the same
 * org/requester/SQL/connection) and lets the re-call through, re-resolving
 * auth/whitelist/RLS live on that fresh dispatch (the same fail-closed
 * guarantee as the web resume path). The hint makes that protocol explicit
 * so the LLM client knows to retry the identical call rather than mutate it
 * (a mutated call would not match the approved request and would re-park).
 *
 * Kept as a string appended to `message` (not a new structured field) so the
 * `approval_required` output schema stays unchanged.
 */
export const MCP_APPROVAL_RESUME_HINT =
  "To resume once approved, re-run this exact call (same arguments). " +
  "Atlas recognises the prior approval and continues; changing the arguments starts a new approval.";

/**
 * Append {@link MCP_APPROVAL_RESUME_HINT} to an `approval_required` message,
 * tolerating a missing/non-string upstream message. Idempotent — never
 * double-appends if the hint is already present.
 */
export function withResumeHint(message: unknown): string {
  const base = typeof message === "string" && message.length > 0 ? message : "";
  if (base.includes(MCP_APPROVAL_RESUME_HINT)) return base;
  return base ? `${base} ${MCP_APPROVAL_RESUME_HINT}` : MCP_APPROVAL_RESUME_HINT;
}

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

/**
 * A single agent result set — the `{ columns, rows }` pair the NL-agent
 * `query` tool surfaces once per SELECT the agent ran. The agent can run
 * several queries per turn, so `query`'s `data` is an ARRAY of these (one
 * per `executeSQL` step), unlike `executeSQL`/`runMetric` which return one.
 */
const dataSetField = z.array(z.object({ columns: columnsField, rows: rowsField }));

/**
 * `query` (Shape-A NL agent) output — #4094. Data branch: the agent's prose
 * `answer`, the `sql` statements it ran, the `data` result sets, the agent
 * `steps` count, and Atlas-plan token `usage` (Shape A burns Atlas tokens, so
 * the double-billing cost is surfaced back). Plus the same `approval_required`
 * governance branch every datasource tool carries — a SELECT the agent tried
 * hit an approval rule and was parked rather than run.
 */
export const queryOutputShape = {
  answer: z.string().optional(),
  sql: z.array(z.string()).optional(),
  data: dataSetField.optional(),
  steps: z.number().int().nonnegative().optional(),
  usage: z.object({ total_tokens: z.number().int().nonnegative() }).optional(),
  ...approvalFields,
} as const;

/** Zod objects for validating a result against the declared output schema. */
export const executeSqlOutputSchema = z.object(executeSqlOutputShape);
export const runMetricOutputSchema = z.object(runMetricOutputShape);
export const queryOutputSchema = z.object(queryOutputShape);
