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
import { BRAIN_TOOL_REASONS, searchBrain } from "@atlas/api/lib/tools/search-brain";
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from "@atlas/api/lib/brain/search";
import {
  EXECUTE_SQL_ERROR_CODES,
  EXPLORE_ERROR_CODES,
  SEARCH_BRAIN_ERROR_CODES,
  withErrorContract,
} from "@atlas/api/lib/tools/descriptions";
import { BRAIN_RESULT_TIERS } from "@useatlas/schemas";
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
import { approvalRequiredResult, executeSqlOutputShape } from "./structured-output.js";
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
  const dispatcher = createMcpDispatch({
    actor,
    transport,
    workspaceId,
    deployMode,
    ...(clientId ? { clientId } : {}),
    ...(scopes ? { scopes } : {}),
  });
  const dispatch: typeof dispatcher.dispatch = (...args) =>
    dispatcher.dispatch(...args);

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
        // mcp:write — and member-callable. `actionCategory: "raw_sql"` opts it
        // into the gate-1 per-workspace kill-switch (#4095): a workspace admin
        // can disable raw SQL over MCP/CLI, restricting members to the NL
        // `atlas query` path. Default is enabled (no `blocked` row), so this is
        // a no-op until an admin flips it — the agent loop / chat are unaffected
        // (they never route through this tool).
        {
          requiresWrite: false,
          requiresBoundOrg: false,
          minRole: "member",
          checksBilling: true,
          actionCategory: "raw_sql",
        },
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
              // (#3498) since the declared outputSchema makes the SDK require
              // it on every non-error result. #4199 — the shared builder folds
              // in the #3584 safeParse guard (malformed internal fields are
              // stripped, never thrown) and the #3750 resume hint (re-call the
              // identical tool once approved; the executeSQL gate's
              // hasApprovedRequest dedup lets the re-call through).
              return approvalRequiredResult({
                approvalRequestId: obj.approval_request_id,
                matchedRules: obj.matched_rules,
                message: obj.message,
              });
            }

            const rawError = String((obj.error ?? obj.message ?? "") as string);
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

  // --- searchBrain ---
  //
  // #4773 — ADDITIVE on this surface. Its predecessor `searchKnowledge` was
  // only ever an agent-registry tool and was never exposed over MCP, so nothing
  // is removed here and the frozen-tool-name rule in
  // `shared/reference/stability.mdx` is untouched: this is a new tool, which
  // that contract explicitly permits within `v0.x`.
  server.registerTool(
    "searchBrain",
    {
      title: "Search the Company Brain",
      description: withErrorContract(searchBrain.description ?? "", SEARCH_BRAIN_ERROR_CODES),
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Free-text search across reviewed claims, raw source records, and knowledge documents. Omit to browse the most recent entries.",
          ),
        include: z
          .array(z.enum(BRAIN_RESULT_TIERS))
          .optional()
          .describe(
            `Restrict to specific result classes (${BRAIN_RESULT_TIERS.join(", ")}). Omit to search all three.`,
          ),
        type: z.string().optional().describe("Documents only: one OKF document type, e.g. 'Runbook'."),
        tags: z
          .array(z.string())
          .optional()
          .describe("Documents only: documents carrying ALL of these OKF tags."),
        collection: z
          .string()
          .optional()
          .describe("Documents only: a single knowledge collection (install slug)."),
        since: z
          .string()
          .optional()
          .describe("Documents only: ISO-8601 date; documents at or after this timestamp."),
        asOf: z
          .string()
          .optional()
          .describe(
            "Facts only: ISO-8601 instant for a historical point read — the reviewed facts valid at that moment (superseded versions included; retracted never). Must be in the past. Omit for current beliefs.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_SEARCH_LIMIT)
          .optional()
          .describe(`Max fused results (default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}).`),
        expand: z
          .boolean()
          .optional()
          .describe("Include 1-hop linked neighbors of matched documents (default true)."),
      },
      // Reads the INTERNAL database only — no writes anywhere, and no reach
      // outside this deployment, so the world is closed. Same posture as
      // `explore`, and deliberately narrower than `executeSQL`, which does
      // touch an external datasource.
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (input): Promise<CallToolResult> =>
      dispatch(
        "searchBrain",
        // Internal-DB read: no datasource, so no gate-0 billing. Member-callable
        // and read-only, so no `mcp:write`. Per-fact ACL is enforced INSIDE the
        // tool against the bound actor's principal set — the dispatch gate's
        // `minRole` is workspace admission, not row visibility, and the two must
        // not be confused for each other.
        //
        // `requiresBoundOrg: false` matches the sibling reads, but note the
        // consequence, which is specific to this tool: an unbound trusted-
        // transport actor (`system:mcp`, no `activeOrganizationId`) reaches the
        // body and the body has no workspace to search. It answers with
        // `unavailable: "no_workspace"` rather than a bare empty page — see the
        // degraded-path table on `search-brain.ts` — so the caller can tell
        // "cannot search" from "searched, found nothing".
        { requiresWrite: false, requiresBoundOrg: false, minRole: "member" },
        async (requestId) => {
          const result = await searchBrain.execute!(input, {
            toolCallId: "mcp-searchBrain",
            messages: [],
          });

          // The tool returns `{ error, reason }` for its degraded paths rather
          // than throwing (the AI SDK surface wants a value the agent can read).
          // Lift that into the typed envelope here so an MCP agent branches on
          // `code` instead of scraping the sentence — and so an identity refusal
          // reaches it as `forbidden`, never as an empty page.
          //
          // Branching on `reason`, NOT on the prose: an earlier cut prefix-
          // matched the English message across this package boundary, so a copy
          // edit to user-facing text would have silently demoted every ACL
          // refusal to `internal_error` with nothing catching it.
          const obj = result as Record<string, unknown>;
          if (typeof obj.error === "string") {
            // `reader_unresolved` is the ACL boundary; `invalid_as_of` (#4916)
            // is the caller's own argument refused — `validation_failed`, so an
            // agent fixes the timestamp instead of retrying an "internal"
            // fault. Everything else is an Atlas-side fault. `request_id` rides
            // on ALL of them — the refusal is documented as an upstream defect
            // deserving log correlation, and dropping the id there would leave
            // an operator with nothing to grep for the one failure this
            // surface most wants reported.
            const code =
              obj.reason === BRAIN_TOOL_REASONS.readerUnresolved
                ? "forbidden"
                : obj.reason === BRAIN_TOOL_REASONS.invalidAsOf
                  ? "validation_failed"
                  : "internal_error";
            return toEnvelopeResult(
              envelope(code, obj.error, {
                request_id: requestId,
              }),
            );
          }
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        },
      ),
  );

  // --- typed semantic-layer tools ---
  registerSemanticTools(server, { actor, transport, workspaceId, deployMode, clientId, scopes });
}
