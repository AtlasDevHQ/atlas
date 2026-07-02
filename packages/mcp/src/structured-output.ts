/**
 * Structured-output schemas for the MCP datasource-query tools (#3498,
 * spec 2025-11-25).
 *
 * `executeSQL`, `runMetric`, and `query` (#4094) declare an `outputSchema` and
 * return `structuredContent` so downstream clients/agents parse a typed result
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
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { PublishResult } from "@useatlas/types";

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
 * Validation guard for the payload {@link approvalRequiredResult} emits:
 * the approval branch of every declared tool output schema, with
 * `approval_required` pinned to `true`, `message` required (the resume hint
 * guarantees one), and tool-specific leading fields (`id`, `answer`, `sql`)
 * passed through via catchall.
 */
const approvalPayloadSchema = z
  .object({
    // Derived from the `approvalFields` SSOT so a loosen/rename there can't
    // drift the guard out of sync with the consuming output schemas; only the
    // two invariants this builder enforces are tightened on top.
    ...approvalFields,
    approval_required: z.literal(true),
    message: z.string(),
  })
  .catchall(z.unknown());

/**
 * Reserved keys the builder owns; stripped from caller-supplied `extra` before
 * the spread so a caller can't inject e.g. `approval_request_id` through the
 * passthrough and defeat the null-omission / `approval_required: true`
 * invariants this builder exists to enforce (#4199).
 */
const RESERVED_APPROVAL_KEYS: ReadonlySet<string> = new Set([
  "approval_required",
  "approval_request_id",
  "matched_rules",
  "message",
]);

function sanitizeExtra(
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!extra) return {};
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (!RESERVED_APPROVAL_KEYS.has(key)) clean[key] = value;
  }
  return clean;
}

/**
 * #4199 — the ONE validated builder for the non-error `approval_required`
 * governance payload. `executeSQL`, `runMetric`, `query`, and dispatch-gate
 * gate-4 all emit this shape; before this builder each site re-derived the
 * object and validation rigor had drifted (safeParse in tools.ts, none in
 * query-tool/semantic-tools, raw JSON.stringify in gate-4).
 *
 * Folds in:
 * - {@link withResumeHint} (#3750) — `message` always tells the MCP client
 *   to re-call the identical tool once approved (all consumers dedup the
 *   re-call via `hasApprovedRequest`, so the hint is accurate everywhere);
 * - the #3584 safeParse guard — malformed internal fields (non-string
 *   `approval_request_id`, non-array `matched_rules`) are stripped rather
 *   than allowed to throw in SDK output-schema validation, which would break
 *   the dispatch and lose the approval signal entirely. Valid fields survive;
 * - null/undefined request-id omission — a parked approval with no queued
 *   row must not emit `approval_request_id: null` (fails the declared
 *   output schemas).
 *
 * `extra` carries the tool-specific leading fields (`{ id }` for runMetric,
 * `{ answer, sql }` for query). `structured: false` drops
 * `structuredContent` for tools that declare no `outputSchema` (the
 * destructive tools gate-4 guards) — the MCP SDK rejects structuredContent
 * from a tool without one.
 */
export function approvalRequiredResult({
  approvalRequestId,
  matchedRules,
  message,
  extra,
  structured = true,
}: {
  approvalRequestId?: unknown;
  matchedRules?: unknown;
  message?: unknown;
  extra?: Record<string, unknown>;
  structured?: boolean;
}): CallToolResult {
  const hinted = withResumeHint(message);
  const safeExtra = sanitizeExtra(extra);
  const raw: Record<string, unknown> = {
    ...safeExtra,
    approval_required: true,
    ...(approvalRequestId !== undefined && approvalRequestId !== null
      ? { approval_request_id: approvalRequestId }
      : {}),
    ...(matchedRules !== undefined ? { matched_rules: matchedRules } : {}),
    message: hinted,
  };
  // Serialize `raw` itself when it validates (preserves the caller's field
  // order in the text block); rebuild field-by-field when it doesn't,
  // keeping every field whose runtime type matches the declared schema.
  const payload = approvalPayloadSchema.safeParse(raw).success
    ? raw
    : {
        ...safeExtra,
        approval_required: true as const,
        ...(typeof approvalRequestId === "string"
          ? { approval_request_id: approvalRequestId }
          : {}),
        ...(Array.isArray(matchedRules) ? { matched_rules: matchedRules } : {}),
        message: hinted,
      };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    ...(structured ? { structuredContent: payload } : {}),
  };
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

/**
 * `publish_datasources` output (#4126 / #4156). Unlike the query tools, publish
 * has a SINGLE non-error result — the atomic promotion always returns the same
 * shape (it is additive, never approval-gated, so there is no `approval_required`
 * branch) — so every field is required, not optional. `published` is the success
 * sentinel; `promoted` + `deleted` are the shared {@link PublishResult} core,
 * single-cased camelCase throughout (`deleted: { entities }`, never a snake
 * `deleted_entities`).
 */
export const publishDatasourcesOutputShape = {
  published: z.boolean(),
  promoted: z.object({
    connections: z.number().int().nonnegative(),
    entities: z.number().int().nonnegative(),
    prompts: z.number().int().nonnegative(),
    starterPrompts: z.number().int().nonnegative(),
    knowledgeDocuments: z.number().int().nonnegative(),
  }),
  deleted: z.object({ entities: z.number().int().nonnegative() }),
} as const;

/** Zod objects for validating a result against the declared output schema. */
export const executeSqlOutputSchema = z.object(executeSqlOutputShape);
export const runMetricOutputSchema = z.object(runMetricOutputShape);
export const queryOutputSchema = z.object(queryOutputShape);
export const publishDatasourcesOutputSchema = z.object(publishDatasourcesOutputShape);

// #4156 drift guard: the publish output's data fields conform to the shared
// PublishResult core (the `published` sentinel is MCP-only, alongside it). A
// rename/reshape of `promoted`/`deleted` here fails to compile against the SSOT
// type in `@useatlas/types`.
const _publishOutputConformsToShared = (
  o: z.infer<typeof publishDatasourcesOutputSchema>,
): PublishResult => ({ promoted: o.promoted, deleted: o.deleted });
