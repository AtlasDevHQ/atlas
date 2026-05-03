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
 * `mcp.ts`: a new code requires (1) extending the union there, (2)
 * appending to `ATLAS_MCP_TOOL_ERROR_CODES` (the symmetric drift guard
 * in `mcp.ts` makes that compile-checked in both directions, and the
 * pinned-length test in `__tests__/mcp.test.ts` catches a forgotten
 * runtime-array update), and (3) adding a regex branch below — the
 * classifier is an if-chain rather than a switch, so missing the third
 * step is NOT compile-checked. Future work: replumb
 * `pipelineErrorToResponse` in `packages/api/src/lib/tools/sql.ts` to
 * carry the tagged-error `_tag` so this file can switch on tag.
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
 * after collapsing every `PipelineError` (8 tagged variants today: see
 * `sql.ts:PipelineError`) into one shape in `pipelineErrorToResponse`,
 * and `explore` returns `Error: ...` / `Error (exit N):` prose from the
 * sandbox backend. Replumbing both to surface tagged errors at the MCP
 * boundary is in scope for a follow-up; for now we map the actual
 * production strings.
 *
 * **Lossy by construction.** Every regex below is matched against a
 * *literal* substring from the upstream constructor (the `// → <tag>:`
 * comment names the source). Drift in the upstream message text will
 * silently demote that failure to `internal_error` — the test suite
 * pins the synthetic side by importing the same strings from the
 * upstream sources where possible.
 *
 * The catalog is closed: if `error` doesn't match a known shape we
 * return `internal_error` so the agent always gets a typed envelope.
 */
export function classifyExecuteSqlError(rawError: string): AtlasMcpToolErrorCode {
  // Empty / missing → treat as internal_error so the agent gets a code
  // at all instead of a bare envelope.
  if (!rawError) return "internal_error";

  // RLS — every constructor in `lib/tools/sql.ts:644-717` and
  // `lib/rls.ts:87-161` opens with one of: "Row-level security",
  // "Query could not be analyzed for row-level security",
  // "Query could not be processed for row-level security",
  // "RLS is enabled", or "RLS policy". The single anchored alternation
  // covers all six call sites.
  if (
    /\b(row-level\s+security|RLS\s+is\s+enabled|RLS\s+policy|RLS:\s|RLS\s+blocked)/i.test(
      rawError,
    ) ||
    /\b(analyzed|processed)\s+for\s+row-level\s+security/i.test(rawError)
  ) {
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

  // Rate limiting:
  //   - `RateLimitExceededError` (`db/source-rate-limit.ts:99`) →
  //     `Source "X" QPM limit reached (60/min)`
  //   - `ConcurrencyLimitError` (`db/source-rate-limit.ts:86`) →
  //     `Source "X" concurrency limit reached (...)`
  //   - `PoolExhaustedError` (`tools/sql.ts:555`) →
  //     `Connection pool capacity reached — the system is handling many concurrent tenants. Try again shortly.`
  //   - `RateLimitExceededError` audit prefix in sql.ts:1252 →
  //     `Rate limited: <message>`
  // Pool exhaustion is classified `rate_limited` rather than
  // `internal_error` because the agent's correct recovery is the same
  // (back off), not "file a bug."
  if (
    /\bQPM\s+limit\s+reached|\bconcurrency\s+limit\s+reached|\bconnection\s+pool\s+capacity\s+reached|\brate\s+limited:|\bremaining\s+connection\s+slots\s+are\s+reserved/i.test(
      rawError,
    )
  ) {
    return "rate_limited";
  }

  // Unknown table / connection:
  //   - Whitelist guard (`tools/sql.ts:393, 401`) →
  //     `Table "X" is not in the allowed list. Check catalog.yml for available tables.`
  //   - `ConnectionNotFoundError` (`tools/sql.ts:535-567`,
  //     `db/connection.ts`) → `Connection "X" is not registered.` /
  //     `Connection "X" failed to initialize: ...`
  //   - `NoDatasourceError` (`db/connection.ts:977`) →
  //     `No analytics datasource configured. ...`
  // All three are "agent specified the wrong identifier" failures —
  // recovery is "call listEntities or check the connection name", not
  // "retry."
  if (
    /\bis\s+not\s+in\s+the\s+allowed\s+list|\bis\s+not\s+registered|\bfailed\s+to\s+initialize|\bno\s+analytics\s+datasource\s+configured/i.test(
      rawError,
    )
  ) {
    return "unknown_entity";
  }

  // SQL validation rejections — the four canonical messages from
  // `validateSQL` in `tools/sql.ts`:
  //   - `Empty query` (line 268, 289)
  //   - `Forbidden SQL operation detected: <pattern>` (line 304)
  //   - `Multiple statements are not allowed` (line 322)
  //   - `Query could not be parsed.... Rewrite using standard SQL syntax.` (line 361)
  // Plus the plugin-rewrite arms:
  //   - `Plugin-rewritten SQL failed validation: ...` (line 1221)
  //   - `Query rejected by plugin: ...` (`PluginRejectedError`, line 1194)
  // And the custom-validator path:
  //   - `Query validation failed for connection "X": internal validator error`
  if (
    /\bempty\s+query\b|\bforbidden\s+sql\s+operation|\bmultiple\s+statements\s+are\s+not\s+allowed|\bcould\s+not\s+be\s+parsed|\brejected\s+by\s+plugin|\bplugin-?rewritten\s+sql\s+failed\s+validation|\bquery\s+validation\s+failed\s+for\s+connection|\bonly\s+SELECT\b|\bdisallowed\s+statement/i.test(
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
 *
 * Plugin command rejections (`Error: Command rejected by plugin: ...`,
 * `explore.ts:544`) get `validation_failed` — the agent's recovery is
 * "rewrite the command", not "retry." Backend init failures and
 * exit-coded backend output stay `internal_error`.
 */
export function classifyExploreError(rawError: string): AtlasMcpToolErrorCode {
  if (!rawError) return "internal_error";

  // Plugin/backend rate-limit signals — explore-side rate limiting
  // surfaces through plugin hook output today. Same QPM phrase covered
  // for symmetry with executeSQL.
  if (/\b(QPM\s+limit\s+reached|rate\s+limit|too\s+many\s+requests|pool\s+capacity\s+reached|pool\s+exhausted)/i.test(rawError)) {
    return "rate_limited";
  }

  // Plugin command rejections — the agent should rewrite the command.
  if (/\brejected\s+by\s+plugin\b/i.test(rawError)) {
    return "validation_failed";
  }

  // Backend / runtime initialization failures, sandbox errors, missing
  // files, command-not-found from the OverlayFs Bash. None of these are
  // "the agent did SQL wrong" — they're operator-side failures.
  return "internal_error";
}
