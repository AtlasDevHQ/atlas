/**
 * MCP tool bridge — exposes Atlas's AI SDK tools as MCP tools.
 *
 * Each MCP tool calls the corresponding AI SDK tool's `execute` function
 * directly, preserving all security guarantees (SQL validation, whitelist,
 * timeout, sandboxing, audit logging).
 *
 * #1858 — every tool dispatch is wrapped in `withRequestContext({ user,
 * requestId })` so the approval gate inside `executeSQL` sees a bound
 * actor. Mirrors the F-54 (scheduler) / F-55 (Slack) binding pattern from
 * PR #1860. The actor is resolved once at server boot by `resolveMcpActor`
 * and threaded through `registerTools(server, { actor, transport })`.
 *
 * #2029 — every dispatch is also wrapped in `traceMcpToolCall`, which
 * emits an OTel span, increments the tool-call counter, records the latency
 * histogram, and fires a one-time activation event per workspace. The
 * `transport` arg flows from `bin/serve.ts` to keep the span attribute
 * accurate without re-detecting transport per request.
 *
 * #2030 — every failure path returns an `AtlasMcpToolError` envelope (JSON
 * body of an `isError: true` MCP response) so an LLM agent can branch on
 * `code` instead of pattern-matching prose. See `error-envelope.ts`.
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { explore } from "@atlas/api/lib/tools/explore";
import { executeSQL } from "@atlas/api/lib/tools/sql";
import {
  EXECUTE_SQL_ERROR_CODES,
  EXPLORE_ERROR_CODES,
  withErrorContract,
} from "@atlas/api/lib/tools/descriptions";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
import { getConfig } from "@atlas/api/lib/config";
import { writeScopeDenied } from "@atlas/api/lib/mcp/dispatch-gate-contract";
import { registerSemanticTools } from "./semantic-tools.js";
import { type McpTransport, type McpDeployMode } from "./telemetry.js";
import {
  classifyExecuteSqlError,
  classifyExploreError,
  envelope,
  toEnvelopeResult,
} from "./error-envelope.js";
import { createMcpDispatch } from "./mcp-dispatch.js";
import { executeSqlOutputShape } from "./structured-output.js";
import { withProgressAndCancellation } from "./progress.js";

export interface RegisterToolsOptions {
  /**
   * Actor bound on every tool dispatch. Resolved once at server boot by
   * `resolveMcpActor()`. The approval gate keys on
   * `RequestContext.user.activeOrganizationId`; an unbound dispatch falls
   * through to the defensive `identityMissing` branch and fails closed
   * with a chat-app-shaped error that doesn't apply to MCP. See #1858.
   */
  actor: AtlasUser;
  /**
   * Carrier transport in use for this MCP server instance. Set once at
   * boot by `bin/serve.ts` and threaded through to every `registerTool`
   * dispatch so OTel spans / counters tag the right transport without
   * re-detecting it per request. Optional for backwards compat; defaults
   * to `stdio`. See #2029.
   */
  transport?: McpTransport;
  /**
   * Hosted-MCP OAuth client_id, surfaced into `audit_log.client_id` via
   * `RequestContext.actor.clientId` so the admin audit filter can scope
   * by registered OAuth client (#2067). Stdio MCP leaves this undefined.
   */
  clientId?: string;
  /**
   * #3504 — OAuth token scopes for this hosted-MCP session (from the JWT
   * `scope` claim, extracted by `verifyMcpBearer`). Threaded onto every
   * dispatch's `RequestContext` so write-gated tools can enforce
   * `mcp:write` via {@link writeScopeOrNull}. Undefined for stdio MCP,
   * which is exempt (trusted local operator).
   */
  scopes?: readonly string[];
}

/**
 * `mcp:write` enforcement gate (#3504 / ADR-0016 gate 2). Used by
 * `runMcpDispatchGate` for every mutating tool; exported here because that's
 * the historical home and `write-scope-gate.test.ts` pins it.
 *
 * The pure decision lives in the shared {@link writeScopeDenied} primitive
 * (#3599) so the dispatch-gate composer and the plugin fallback share ONE
 * source of truth:
 * - **stdio MCP** (`clientId` undefined) is exempt — it runs in-process in the
 *   operator's own deployment, not behind OAuth.
 * - **hosted MCP** must present a bearer carrying the `mcp:write` scope. Fails
 *   CLOSED: a hosted dispatch whose `scopes` weren't threaded (or that lacks
 *   `mcp:write`) is denied with a `forbidden` envelope rather than silently
 *   allowed.
 *
 * Returns `null` when the dispatch may proceed; a `forbidden` tool-result
 * envelope when it must be blocked.
 */
export function writeScopeOrNull(args: {
  clientId: string | undefined;
  scopes: readonly string[] | undefined;
}): CallToolResult | null {
  if (!writeScopeDenied(args)) return null;
  return toEnvelopeResult(
    envelope(
      "forbidden",
      "This tool mutates data and requires the 'mcp:write' OAuth scope, which this token does not carry.",
      {
        hint: "Re-authorize the MCP client with the mcp:write scope (the workspace admin controls which scopes a client may request).",
      },
    ),
  );
}

/**
 * Resolve the workspace id for OTel span / counter attribution. In
 * trusted-transport mode the actor is `system:mcp` with no
 * `activeOrganizationId`; falling back to the actor id keeps the
 * attribute non-empty (collectors strip empty-string label values
 * inconsistently across vendors). See `actor.ts`.
 */
function workspaceIdOf(actor: AtlasUser): string {
  return actor.activeOrganizationId ?? actor.id;
}

function deployModeOf(): McpDeployMode {
  return getConfig()?.deployMode ?? "self-hosted";
}

export function registerTools(server: McpServer, opts: RegisterToolsOptions): void {
  const { actor, transport = "stdio", clientId, scopes } = opts;
  const workspaceId = workspaceIdOf(actor);
  const deployMode = deployModeOf();

  // Shared dispatch wrapper (#3602): OTel span → RequestContext (actor bind,
  // #1858/#2067) → rate-limit (#2071) → ADR-0016 gate order (0 billing → 1
  // action-policy → 2 scope → 3 RBAC → 4 approval, #3508/#3601) → tool body →
  // typed error envelope (#2030). The contract lives once in `mcp-dispatch.ts`;
  // every tool routes through `dispatch(...)`. `explore` is a metadata read
  // (no billing); `executeSQL` reaches a datasource so it declares
  // `checksBilling`. Both are member-callable reads (`requiresWrite: false`).
  const { dispatch } = createMcpDispatch({
    actor,
    transport,
    workspaceId,
    deployMode,
    ...(clientId ? { clientId } : {}),
    ...(scopes ? { scopes } : {}),
  });

  // --- explore ---
  server.registerTool(
    "explore",
    {
      title: "Explore Semantic Layer",
      description: withErrorContract(explore.description ?? "", EXPLORE_ERROR_CODES),
      inputSchema: {
        command: z
          .string()
          .describe(
            'A bash command to run against the semantic layer, e.g. \'cat catalog.yml\', \'grep -r revenue entities/\'',
          ),
      },
      // Read-only over a closed, local domain: explore only ever runs
      // read commands (ls/cat/grep/find) against the semantic directory —
      // no datasource, no mutations. A client must not prompt for a confirm.
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ command }): Promise<CallToolResult> =>
      dispatch(
        "explore",
        { requiresWrite: false, requiresBoundOrg: false, minRole: "member" },
        async (requestId) => {
          const result = await explore.execute!(
            { command },
            { toolCallId: "mcp-explore", messages: [] },
          );
          const text = typeof result === "string" ? result : JSON.stringify(result);
          // explore today returns prose strings prefixed with `Error:` or
          // `Error (exit N):` on failure rather than throwing. Lift those into
          // the typed envelope so the agent doesn't have to scrape. (A genuine
          // throw is caught by the shared dispatch → `internal_error`.)
          if (text.startsWith("Error:") || text.startsWith("Error (exit")) {
            const code = classifyExploreError(text);
            const message =
              text.replace(/^Error(\s\(exit\s\d+\))?:\s*/i, "").trim() || text;
            return toEnvelopeResult(
              envelope(
                code,
                message,
                code === "internal_error" ? { request_id: requestId } : undefined,
              ),
            );
          }
          return { content: [{ type: "text" as const, text }] };
        },
      ),
  );

  // --- executeSQL ---
  server.registerTool(
    "executeSQL",
    {
      title: "Execute SQL Query",
      description: withErrorContract(executeSQL.description ?? "", EXECUTE_SQL_ERROR_CODES),
      inputSchema: {
        sql: z.string().describe("The SELECT query to execute"),
        explanation: z
          .string()
          .describe("Brief explanation of what this query does and why"),
        connectionId: z
          .string()
          .optional()
          .describe(
            "Target connection ID. Omit for the default connection.",
          ),
      },
      // SELECT-only (DML/DDL is rejected by the 4-layer SQL validator), so
      // the query never modifies the datasource — read-only. It does reach
      // an external database, so the world is open (openWorldHint true).
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
      // #3498 — typed result so agents parse columns/rows instead of
      // re-parsing the text block (which is retained below).
      outputSchema: executeSqlOutputShape,
    },
    async ({ sql, explanation, connectionId }, extra): Promise<CallToolResult> =>
      dispatch(
        "executeSQL",
        // Reaches a datasource → gate-0 billing (#3437/#3601). SELECT-only
        // (the 4-layer validator rejects DML/DDL) so it is read-only — no
        // mcp:write — and member-callable.
        { requiresWrite: false, requiresBoundOrg: false, minRole: "member", checksBilling: true },
        async (requestId) => {
          // #3500 — progress + cancellation around the query work.
          // #3575 — `executeSQL.execute` does not read `abortSignal` from the
          // tool-call extra (sql.ts destructures only sql/explanation/
          // connectionId/scope). Passing a signal would be dead code and imply
          // the query is abortable at the driver level, which it is not. The
          // statement-timeout (`ATLAS_QUERY_TIMEOUT`, default 30s) is the sole
          // cancellation mechanism for the datasource side; a client cancel cuts
          // the dispatch loose at the MCP boundary (the shared dispatch re-throws
          // the cancellation) and the DB-side query drains within that window.
          const result = await withProgressAndCancellation(
            extra,
            { startMessage: "Running query", endMessage: "Query complete" },
            async (_reporter, _signal) =>
              executeSQL.execute!(
                { sql, explanation, connectionId },
                { toolCallId: "mcp-executeSQL", messages: [] },
              ),
          );

          // executeSQL collapses every PipelineError (8 tagged variants today:
          // see sql.ts:PipelineError) into { success: false, error } in
          // pipelineErrorToResponse. Lift the string back up into a typed
          // envelope here.
          const obj = result as Record<string, unknown>;
          if (obj.success === false) {
            // Approval-required is NOT a tool failure — it's a governance
            // outcome that already produced an approval_request_id the user
            // must follow up on. Surfacing it as `internal_error` would (a)
            // lose the request id and matched rule names, and (b) prompt the
            // agent to retry, which silently re-creates duplicate approval
            // requests. Pass it through as a non-error JSON body so the agent
            // + user see the full payload.
            if (obj.approval_required === true) {
              // Non-error governance branch — still carries structuredContent
              // (#3498) since the declared outputSchema makes the SDK require it
              // on every non-error result. #3584 — narrow each field against the
              // declared outputSchema types before assigning to structuredContent
              // so SDK output-schema validation can't throw on a malformed
              // internal payload (e.g. non-string approval_request_id).
              const { executeSqlOutputSchema: schema, withResumeHint } = await import(
                "./structured-output.js"
              );
              const raw = {
                approval_required: true,
                approval_request_id: obj.approval_request_id,
                matched_rules: obj.matched_rules,
                // #3750 — tell the MCP client how to resume: re-call the
                // identical tool once approved (the executeSQL gate's
                // hasApprovedRequest dedup lets the re-call through).
                message: withResumeHint(obj.message),
              };
              const parsed = schema.safeParse(raw);
              const approval = parsed.success ? parsed.data : {
                approval_required: true as const,
                ...(typeof obj.approval_request_id === "string"
                  ? { approval_request_id: obj.approval_request_id }
                  : {}),
                // Resume hint is always present (withResumeHint tolerates a
                // missing upstream message) so even the fallback shape tells
                // the client how to continue.
                message: withResumeHint(obj.message),
              };
              return {
                content: [
                  { type: "text" as const, text: JSON.stringify(approval, null, 2) },
                ],
                structuredContent: approval,
              };
            }

            const rawError = String(obj.error ?? obj.message ?? "");
            const code = classifyExecuteSqlError(rawError);
            const extras: { request_id?: string; retry_after?: number } = {};
            if (code === "internal_error") extras.request_id = requestId;
            const retryAfterMs = obj.retryAfterMs;
            if (code === "rate_limited" && typeof retryAfterMs === "number") {
              extras.retry_after = Math.max(1, Math.round(retryAfterMs / 1000));
            }
            return toEnvelopeResult(
              envelope(
                code,
                rawError || "Query failed",
                Object.keys(extras).length ? extras : undefined,
              ),
            );
          }

          // #3498 — typed result + retained text block. Both are built from the
          // same object so they can never drift.
          const structured: Record<string, unknown> = {
            explanation: obj.explanation,
            row_count: obj.row_count,
            columns: obj.columns,
            rows: obj.rows,
            truncated: obj.truncated,
          };
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(structured, null, 2) },
            ],
            structuredContent: structured,
          };
        },
      ),
  );

  // --- typed semantic-layer tools ---
  registerSemanticTools(server, { actor, transport, workspaceId, deployMode, clientId, scopes });
}
