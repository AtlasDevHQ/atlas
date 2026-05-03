/**
 * Structured error envelope returned by every typed Atlas MCP tool.
 *
 * The MCP protocol surfaces tool failures as `{ isError: true, content: [...] }`
 * with a free-form text payload. A free-form string forces an LLM agent to
 * either pattern-match prose (brittle), blindly retry (DoS pattern), or give
 * up. Every Atlas MCP tool serializes this envelope as the JSON body of that
 * `text` content block so the agent can take the correct recovery action.
 *
 * Wire shape (snake_case): the envelope crosses an LLM/agent boundary, so
 * field names match the surrounding MCP/JSON-RPC convention. Do NOT rename
 * `request_id` or `retry_after` to camelCase — they are part of the wire
 * contract that `@useatlas/sdk` consumers parse, and the forthcoming eval
 * harness (#2025) is expected to assert on these exact keys. (The sibling
 * `ChatContextWarning` shape in `errors.ts` uses camelCase intentionally —
 * that one is consumed inside React, not over an LLM boundary, so the
 * convention divergence is deliberate.)
 */

/**
 * Closed set of error codes a typed MCP tool can return. Each code maps to a
 * single failure mode an agent can act on:
 *
 * - `validation_failed` — SQL guard rejected (regex, AST, whitelist). The
 *   query is permanently broken; the agent should rewrite it, not retry.
 * - `rls_denied` — row-level security rejected the query for the bound
 *   actor. Retrying with the same identity will not help; surface to user.
 * - `query_timeout` — `statement_timeout` fired. Suggest a simpler query
 *   or a tighter `LIMIT`. Not retryable as-is.
 * - `unknown_entity` — the requested entity is not in the semantic layer
 *   (also covers unregistered connection ids and missing datasource
 *   config — all "agent specified the wrong identifier" failures). The
 *   agent should call `listEntities` to discover what exists.
 * - `unknown_metric` — the metric id is not in `metrics/*.yml`. The agent
 *   should fall back to `executeSQL` or pick a different metric.
 * - `ambiguous_term` — a glossary entry has `status: ambiguous`. The agent
 *   MUST surface the ambiguity to the user with `possible_mappings` and
 *   ask which they meant — never silently pick. The forthcoming
 *   disambiguation eval (#2025) is expected to assert on this exact code.
 * - `rate_limited` — request rate, concurrency cap, or pool capacity hit.
 *   Includes `retry_after` (seconds) when the upstream knows it.
 * - `internal_error` — unexpected failure. Includes `request_id` so the
 *   user can quote it when filing a support ticket.
 *
 * When adding a code:
 *   1. Extend the union here.
 *   2. Append to `ATLAS_MCP_TOOL_ERROR_CODES` (the `_CodesArrayCovers`
 *      guard below makes that compile-checked in both directions; the
 *      pinned-length test in `__tests__/mcp.test.ts` catches a forgotten
 *      runtime-array update).
 *   3. Add a regex branch in `classifyExecuteSqlError` /
 *      `classifyExploreError` in `packages/mcp/src/error-envelope.ts` —
 *      these are if-chains, NOT switches, so missing this step is silent
 *      and the new failure mode will fall through to `internal_error`.
 *   4. Add the code to the per-tool catalog (`EXECUTE_SQL_ERROR_CODES`,
 *      `RUN_METRIC_ERROR_CODES`, etc.) so the LLM-facing description
 *      advertises it.
 */
export type AtlasMcpToolErrorCode =
  | "validation_failed"
  | "rls_denied"
  | "query_timeout"
  | "unknown_entity"
  | "unknown_metric"
  | "ambiguous_term"
  | "rate_limited"
  | "internal_error";

/**
 * Wire shape of a typed MCP tool failure. Agents/SDK consumers parse the
 * `text` content block of an `isError: true` MCP response as JSON and match
 * this shape — see `parseAtlasMcpToolError` for a runtime guard.
 */
export interface AtlasMcpToolError {
  /** Closed-set machine-readable code — the only field the agent should branch on. */
  readonly code: AtlasMcpToolErrorCode;
  /** Human + LLM readable message; safe to surface to an end user verbatim. */
  readonly message: string;
  /** Optional remediation hint (e.g. "call listEntities to see valid names"). */
  readonly hint?: string;
  /** Server-assigned request id; only set on `internal_error` so users can quote it. */
  readonly request_id?: string;
  /** Seconds to wait before retrying; only set on `rate_limited`. */
  readonly retry_after?: number;
}

/** Closed list of every code, useful for table-driven tests and the runtime guard. */
export const ATLAS_MCP_TOOL_ERROR_CODES = [
  "validation_failed",
  "rls_denied",
  "query_timeout",
  "unknown_entity",
  "unknown_metric",
  "ambiguous_term",
  "rate_limited",
  "internal_error",
] as const satisfies readonly AtlasMcpToolErrorCode[];

// Symmetric drift guard. The `satisfies` above ensures every entry in the
// array is a valid union member; this checks the reverse — every union
// member appears in the array. Without this, adding a code to the union
// without appending to the array compiles silently and SDK consumers
// iterating `ATLAS_MCP_TOOL_ERROR_CODES` will miss the new code at
// runtime. Triggers TS2322 if the two drift apart.
type _CodesArrayCoversUnion =
  AtlasMcpToolErrorCode extends (typeof ATLAS_MCP_TOOL_ERROR_CODES)[number]
    ? true
    : never;
const _atlasMcpCodesArrayCoversUnion: _CodesArrayCoversUnion = true;
// Reference the symbol so TS doesn't strip it as unused under noUnusedLocals.
void _atlasMcpCodesArrayCoversUnion;

/** Type guard — checks whether a string is a known `AtlasMcpToolErrorCode`. */
export function isAtlasMcpToolErrorCode(value: string): value is AtlasMcpToolErrorCode {
  return (ATLAS_MCP_TOOL_ERROR_CODES as ReadonlyArray<string>).includes(value);
}

/**
 * Validate that a runtime value matches the {@link AtlasMcpToolError} wire
 * shape. Returns the typed envelope when it matches; returns `null` when any
 * required field is missing or has the wrong type.
 *
 * Use this on the `text` payload of an `isError: true` MCP response — the
 * MCP SDK types tool result content as `unknown`, so a runtime guard is
 * required before trusting the shape.
 *
 * @example
 * ```ts
 * const result = await client.callTool({ name: "runMetric", arguments: { id: "x" } });
 * if (result.isError) {
 *   const envelope = parseAtlasMcpToolError(getContentText(result.content));
 *   if (envelope?.code === "ambiguous_term") {
 *     // ask the user which mapping they meant
 *   }
 * }
 * ```
 */
export function parseAtlasMcpToolError(value: unknown): AtlasMcpToolError | null {
  let candidate: unknown = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  const obj = candidate as Record<string, unknown>;
  if (typeof obj.code !== "string" || !isAtlasMcpToolErrorCode(obj.code)) return null;
  if (typeof obj.message !== "string") return null;

  const hint = typeof obj.hint === "string" ? obj.hint : undefined;
  const request_id = typeof obj.request_id === "string" ? obj.request_id : undefined;
  const retry_after = typeof obj.retry_after === "number" ? obj.retry_after : undefined;

  return {
    code: obj.code,
    message: obj.message,
    ...(hint !== undefined && { hint }),
    ...(request_id !== undefined && { request_id }),
    ...(retry_after !== undefined && { retry_after }),
  };
}
