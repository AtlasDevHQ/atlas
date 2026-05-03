/**
 * Helpers that build the structured MCP error envelope (#2030) and map
 * Atlas's two upstream failure shapes — the executeSQL pipeline's
 * `{ success: false, error }` plus the explore tool's `Error: ...` /
 * `Error (exit N):` prose — into the closed catalog of
 * {@link AtlasMcpToolErrorCode} codes.
 *
 * The envelope is serialized as the JSON body of an `isError: true` MCP
 * tool response so an LLM agent can branch on `code` instead of pattern-
 * matching prose. Keep this file in lockstep with `@useatlas/types`'s
 * `mcp.ts`: when a new code is added, the compiler will flag every
 * non-exhaustive switch in this module.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  AtlasMcpToolError,
  AtlasMcpToolErrorCode,
} from "@useatlas/types/mcp";

export type { AtlasMcpToolError, AtlasMcpToolErrorCode };

/**
 * Build a structured error envelope and return it as an `isError: true`
 * MCP `CallToolResult` whose first `text` content block is the JSON body.
 *
 * The MCP SDK's `client.callTool()` round-trips `content[0].text` as
 * a string, so callers must `JSON.parse(text)` (or use
 * `parseAtlasMcpToolError` from `@useatlas/types`) to recover the typed
 * envelope.
 */
export function toEnvelopeResult(error: AtlasMcpToolError): CallToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(error) }],
    isError: true,
  };
}

/**
 * Convenience constructor — assemble an envelope from positional args
 * without forcing every call site to spell out the object literal. Empty
 * `hint` / `request_id` / `retry_after` arguments are omitted from the
 * wire payload (rather than serialized as `null`/`undefined`) so the JSON
 * shape stays minimal — agents that branch on key presence don't see
 * spurious nullable fields.
 */
export function envelope(
  code: AtlasMcpToolErrorCode,
  message: string,
  extras?: { hint?: string; request_id?: string; retry_after?: number },
): AtlasMcpToolError {
  return {
    code,
    message,
    ...(extras?.hint !== undefined && { hint: extras.hint }),
    ...(extras?.request_id !== undefined && { request_id: extras.request_id }),
    ...(extras?.retry_after !== undefined && { retry_after: extras.retry_after }),
  };
}

/**
 * Lift a raw error string out of the executeSQL pipeline (and explore's
 * `Error:` prose) into a typed code.
 *
 * Why string matching? The two upstream surfaces are deliberately string-
 * shaped today — `executeSQL` returns `{ success: false, error: <string> }`
 * after collapsing 7+ tagged pipeline errors in `pipelineErrorToResponse`,
 * and `explore` returns `Error: ...` / `Error (exit N):` prose from the
 * sandbox backend. Replumbing both to surface tagged errors at the MCP
 * boundary is in scope for a follow-up; for now we map the shapes we ship
 * today, with each pattern carrying a comment pointing at the source so
 * drift is detectable.
 *
 * The catalog is closed: if `error` doesn't match a known shape we return
 * `internal_error` so the agent always gets a typed envelope.
 */
export function classifyExecuteSqlError(rawError: string): AtlasMcpToolErrorCode {
  // Empty / missing → treat as internal_error so the agent gets a code at
  // all instead of a bare envelope.
  if (!rawError) return "internal_error";

  // RLS — sql.ts:RLSError messages and pipeline rejections start with
  // "RLS check failed" or "RLS rejected" depending on the path.
  if (/RLS\s+(check\s+failed|rejected|denied)/i.test(rawError)) {
    return "rls_denied";
  }

  // Statement timeout — Postgres "canceling statement due to statement
  // timeout" / "query timeout" / MySQL "Query execution was interrupted".
  if (
    /statement\s+timeout|query\s+timeout|canceling\s+statement|execution\s+was\s+interrupted/i.test(
      rawError,
    )
  ) {
    return "query_timeout";
  }

  // Rate limiting — RateLimitExceededError + ConcurrencyLimitError both
  // surface as "rate limit" / "concurrency limit" in the message. Pool
  // exhaustion gets the same code (transient back-off is the right call).
  if (
    /rate\s+limit|concurrency\s+limit|too\s+many\s+(clients|connections|requests)|pool\s+exhausted/i.test(
      rawError,
    )
  ) {
    return "rate_limited";
  }

  // Unknown entity / table — semantic-layer whitelist rejections from
  // sql.ts read "Table 'X' is not whitelisted in the semantic layer" and
  // sibling "Unknown table".
  if (
    /not\s+whitelisted|not\s+in\s+the\s+semantic\s+layer|unknown\s+table|table\s+\S+\s+(does\s+not\s+exist|not\s+found)/i.test(
      rawError,
    )
  ) {
    return "unknown_entity";
  }

  // SQL validation rejections — covers the regex/AST/whitelist guards in
  // validateSQL and the "Plugin-rewritten SQL failed validation" arm.
  if (
    /forbidden\s+sql|sql\s+(validation|guard|parse)|invalid\s+sql|only\s+SELECT|failed\s+validation|disallowed\s+statement/i.test(
      rawError,
    )
  ) {
    return "validation_failed";
  }

  return "internal_error";
}

/**
 * Map a raw explore-tool string (which today returns `Error:` / `Error
 * (exit N):` prose, never an envelope) onto a code. Same string-matching
 * caveat as {@link classifyExecuteSqlError}.
 */
export function classifyExploreError(rawError: string): AtlasMcpToolErrorCode {
  if (!rawError) return "internal_error";

  // Plugin/backend rate-limit signals.
  if (/rate\s+limit|too\s+many\s+requests|pool\s+exhausted/i.test(rawError)) {
    return "rate_limited";
  }

  // Backend / runtime initialization failures, sandbox errors, missing
  // files, command-not-found from the OverlayFs Bash. None of these are
  // "the agent did SQL wrong" — they're operator-side failures.
  return "internal_error";
}
