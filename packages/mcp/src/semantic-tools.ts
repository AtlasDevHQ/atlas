/**
 * Typed semantic-layer MCP tools — `listEntities`, `describeEntity`,
 * `searchGlossary`, and `runMetric` — that wrap the existing semantic-
 * layer read paths so MCP clients can discover and use the catalog
 * without grepping YAML through the `explore` shell.
 *
 * Actor binding mirrors `tools.ts`: every dispatch is wrapped in
 * `withRequestContext({ user: actor, requestId })` so any downstream
 * approval/RLS gate sees a bound caller (#1858 — see tools.ts header).
 *
 * OTel coverage (#2029): every dispatch is also wrapped in
 * `traceMcpToolCall`, which emits the span / counter / latency histogram
 * and fires the per-workspace activation event. `runMetric` adds the
 * `metric.id` span attribute; the existing `atlas.sql.execute` span (see
 * `lib/tools/sql.ts`) nests under this dispatch's `atlas.mcp.tool.run`
 * via OTel context propagation through `withSpan`.
 *
 * Failure shape: every error path returns an `AtlasMcpToolError`
 * envelope (#2030) so an LLM agent can branch on `code` instead of
 * pattern-matching prose. `searchGlossary` upgrades the recommendation
 * to a hard `ambiguous_term` envelope when any matched term has
 * `status: ambiguous` — the forthcoming disambiguation eval (#2025) is
 * expected to assert on this code.
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
import { withRequestContext } from "@atlas/api/lib/logger";
import {
  listEntities,
  getEntityByName,
  searchGlossary,
  findMetricById,
} from "@atlas/api/lib/semantic/lookups";
import { executeSQL } from "@atlas/api/lib/tools/sql";
import {
  DESCRIBE_ENTITY_ERROR_CODES,
  DESCRIBE_ENTITY_TOOL_DESCRIPTION,
  LIST_ENTITIES_ERROR_CODES,
  LIST_ENTITIES_TOOL_DESCRIPTION,
  RUN_METRIC_ERROR_CODES,
  RUN_METRIC_TOOL_DESCRIPTION,
  SEARCH_GLOSSARY_ERROR_CODES,
  SEARCH_GLOSSARY_TOOL_DESCRIPTION,
  withErrorContract,
  type SemanticToolName,
} from "@atlas/api/lib/tools/descriptions";
import {
  traceMcpToolCall,
  type McpTransport,
  type McpDeployMode,
} from "./telemetry.js";
import {
  classifyExecuteSqlError,
  envelope,
  toEnvelopeResult,
} from "./error-envelope.js";
import { enforceClientRateLimit } from "@atlas/api/lib/rate-limit/middleware";

// Modest input bounds — MCP clients (including hostile ones in BYOC
// SaaS) shouldn't be able to drive megabyte strings into the catalog
// scanners or substring search. Identifiers stay short; free-text
// filter/term get a bit more headroom. Bumping these is fine if a real
// user need surfaces.
const MAX_IDENTIFIER_LEN = 256;
const MAX_FREE_TEXT_LEN = 1024;

// Mirrors the entity-name shape `isValidEntityName` accepts in
// `lib/semantic/files.ts` (no `/`, `\`, `..`, `\0`). Surfacing the
// constraint at the Zod boundary gives the MCP client an immediate
// error instead of an indistinguishable `{ found: false }`.
const ENTITY_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

export interface RegisterSemanticToolsOptions {
  /** Actor bound on every tool dispatch — see tools.ts. */
  actor: AtlasUser;
  /** OTel transport tag (#2029) — threaded from `bin/serve.ts` via `tools.ts`. */
  transport: McpTransport;
  /** Resolved workspace id for OTel attribution (`actor.activeOrganizationId` or `actor.id`). */
  workspaceId: string;
  /** Resolved `deployMode` for OTel attribution (`self-hosted` / `saas`). */
  deployMode: McpDeployMode;
  /** Hosted-MCP OAuth client_id, surfaced into `audit_log.client_id` (#2067). */
  clientId?: string;
}

function dispatchId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * Per-OAuth-client rate-limit gate (#2071). Hosted MCP threads `clientId`
 * through `registerSemanticTools`; stdio MCP leaves it undefined and
 * skips the limiter — the limiter scopes hosted-tenant abuse, not local
 * operator usage. Returns a tool result envelope (`code: rate_limited`)
 * when the bucket is empty, or `null` when the dispatch should proceed.
 */
async function rateLimitOrNull(args: {
  clientId: string | undefined;
  orgId: string;
  userId: string;
  toolName: string;
}): Promise<CallToolResult | null> {
  if (!args.clientId) return null;
  const outcome = await enforceClientRateLimit({
    orgId: args.orgId,
    clientId: args.clientId,
    userId: args.userId,
    toolName: args.toolName,
  });
  if (outcome.kind === "ok") return null;
  return toEnvelopeResult(outcome.envelope);
}

function toJsonContent(value: unknown): CallToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  // CLAUDE.md: `err instanceof Error ? err.message : String(err)`. The
  // fallback only kicks in for the truly opaque case (`String(err)` →
  // `""` or `"[object Object]"`) where preserving the original would
  // give the caller no signal anyway.
  const s = String(err);
  return s && s !== "[object Object]" ? s : fallback;
}

export function registerSemanticTools(
  server: McpServer,
  opts: RegisterSemanticToolsOptions,
): void {
  const { actor, transport, workspaceId, deployMode, clientId } = opts;
  // #2067 — wrap each dispatch with the same actor shape as tools.ts. The
  // `mcp` actor_kind / clientId / toolName trail through `logQueryAudit`
  // so admins can scope `audit_log` rows to a specific MCP tool/client.
  const mcpActor = (toolName: string) => ({
    kind: "mcp" as const,
    ...(clientId ? { clientId } : {}),
    toolName,
  });

  // --- listEntities ---
  server.registerTool(
    "listEntities" satisfies SemanticToolName,
    {
      title: "List Semantic Entities",
      description: withErrorContract(LIST_ENTITIES_TOOL_DESCRIPTION, LIST_ENTITIES_ERROR_CODES),
      inputSchema: {
        filter: z
          .string()
          .max(MAX_FREE_TEXT_LEN)
          .optional()
          .describe(
            "Optional case-insensitive substring matched against name, table, and description.",
          ),
      },
    },
    async ({ filter }): Promise<CallToolResult> =>
      traceMcpToolCall(
        { toolName: "listEntities", workspaceId, transport, deployMode },
        () => {
          const requestId = dispatchId("mcp-listEntities");
          return withRequestContext({ requestId, user: actor, actor: mcpActor("listEntities") }, async () => {
            try {
              // Rate-limit gate (#2071) lives INSIDE the try so any
              // limiter throw lands in the same catch as a tool throw
              // and produces an `internal_error` envelope with
              // `request_id` — preserving the #2030 contract.
              const limited = await rateLimitOrNull({
                clientId,
                orgId: workspaceId,
                userId: actor.id,
                toolName: "listEntities",
              });
              if (limited) return limited;
              const entities = listEntities({ filter });
              return toJsonContent({ count: entities.length, entities });
            } catch (err) {
              const message = errorMessage(err, "listEntities tool failed");
              process.stderr.write(`[atlas-mcp] listEntities threw: ${err}\n`);
              return toEnvelopeResult(
                envelope("internal_error", message, { request_id: requestId }),
              );
            }
          });
        },
      ),
  );

  // --- describeEntity ---
  server.registerTool(
    "describeEntity" satisfies SemanticToolName,
    {
      title: "Describe Semantic Entity",
      description: withErrorContract(DESCRIBE_ENTITY_TOOL_DESCRIPTION, DESCRIBE_ENTITY_ERROR_CODES),
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(MAX_IDENTIFIER_LEN)
          .regex(ENTITY_NAME_PATTERN)
          .describe(
            "Entity name (`name` field) or table name. Alphanumerics, `_`, `-`, `.` only — no path separators.",
          ),
      },
    },
    async ({ name }): Promise<CallToolResult> =>
      traceMcpToolCall(
        { toolName: "describeEntity", workspaceId, transport, deployMode },
        () => {
          const requestId = dispatchId("mcp-describeEntity");
          return withRequestContext({ requestId, user: actor, actor: mcpActor("describeEntity") }, async () => {
            try {
              const limited = await rateLimitOrNull({
                clientId,
                orgId: workspaceId,
                userId: actor.id,
                toolName: "describeEntity",
              });
              if (limited) return limited;
              const entity = getEntityByName(name);
              if (!entity) {
                // Unknown-entity isn't really a "tool failed" condition for
                // the agent — the agent's recovery is "call listEntities and
                // pick a known one." Emit it as a typed envelope so the
                // recovery is machine-readable, with a hint pointing the
                // agent at the right next call.
                return toEnvelopeResult(
                  envelope(
                    "unknown_entity",
                    `Entity "${name}" not found in the semantic layer.`,
                    { hint: "Call listEntities to discover available entities." },
                  ),
                );
              }
              return toJsonContent({ found: true, entity });
            } catch (err) {
              const message = errorMessage(err, "describeEntity tool failed");
              process.stderr.write(`[atlas-mcp] describeEntity threw: ${err}\n`);
              return toEnvelopeResult(
                envelope("internal_error", message, { request_id: requestId }),
              );
            }
          });
        },
      ),
  );

  // --- searchGlossary ---
  server.registerTool(
    "searchGlossary" satisfies SemanticToolName,
    {
      title: "Search Business Glossary",
      description: withErrorContract(SEARCH_GLOSSARY_TOOL_DESCRIPTION, SEARCH_GLOSSARY_ERROR_CODES),
      inputSchema: {
        term: z
          .string()
          .min(1)
          .max(MAX_FREE_TEXT_LEN)
          .describe(
            "Term, phrase, or substring to search across glossary entries.",
          ),
      },
    },
    async ({ term }): Promise<CallToolResult> =>
      traceMcpToolCall(
        { toolName: "searchGlossary", workspaceId, transport, deployMode },
        () => {
          const requestId = dispatchId("mcp-searchGlossary");
          return withRequestContext({ requestId, user: actor, actor: mcpActor("searchGlossary") }, async () => {
            try {
              const limited = await rateLimitOrNull({
                clientId,
                orgId: workspaceId,
                userId: actor.id,
                toolName: "searchGlossary",
              });
              if (limited) return limited;
              const matches = searchGlossary(term);

              // The disambiguation contract (#2020 + forthcoming #2025): when
              // ANY matched glossary entry has `status: ambiguous`, surface
              // it as a hard `ambiguous_term` envelope with the possible
              // mappings in the hint. The agent's correct recovery is to ask
              // the user which mapping they meant — never silently pick. The
              // forthcoming eval harness is expected to assert on
              // `code === "ambiguous_term"`.
              const ambiguous = matches.find((m) => m.status === "ambiguous");
              if (ambiguous) {
                const mappings =
                  ambiguous.possible_mappings.length > 0
                    ? ` Possible mappings: ${ambiguous.possible_mappings.join(", ")}.`
                    : "";
                // Note when other matches were dropped — the envelope contract
                // is "one ambiguous term blocks the call" so callers don't see
                // sibling defined terms that were in the same result set. Tell
                // the agent it can re-query for a more specific term to
                // recover the others.
                const otherCount = matches.length - 1;
                const otherSuffix =
                  otherCount > 0
                    ? ` ${otherCount} additional match${otherCount === 1 ? "" : "es"} omitted — re-call searchGlossary with a more specific term to retrieve them.`
                    : "";
                return toEnvelopeResult(
                  envelope(
                    "ambiguous_term",
                    `Glossary term "${ambiguous.term}" is ambiguous — ask the user which mapping they meant.${mappings}${otherSuffix}`,
                    {
                      hint: "Surface possible_mappings to the user and ask which they meant; do not silently pick a mapping.",
                    },
                  ),
                );
              }

              return toJsonContent({
                query: term,
                count: matches.length,
                matches,
              });
            } catch (err) {
              const message = errorMessage(err, "searchGlossary tool failed");
              process.stderr.write(`[atlas-mcp] searchGlossary threw: ${err}\n`);
              return toEnvelopeResult(
                envelope("internal_error", message, { request_id: requestId }),
              );
            }
          });
        },
      ),
  );

  // --- runMetric ---
  // The metric SQL goes through executeSQL.execute, inheriting all four
  // validation layers, plugin hooks, RLS injection, auto-LIMIT,
  // statement timeout, and audit logging. The existing `atlas.sql.execute`
  // span (see `lib/tools/sql.ts`) nests under this dispatch's
  // `atlas.mcp.tool.run` via OTel context propagation through `withSpan`.
  server.registerTool(
    "runMetric" satisfies SemanticToolName,
    {
      title: "Run Canonical Metric",
      description: withErrorContract(RUN_METRIC_TOOL_DESCRIPTION, RUN_METRIC_ERROR_CODES),
      inputSchema: {
        id: z
          .string()
          .min(1)
          .max(MAX_IDENTIFIER_LEN)
          .describe("Metric id from semantic/metrics/*.yml."),
        filters: z
          .record(
            z.string().max(MAX_IDENTIFIER_LEN),
            z.union([
              z.string().max(MAX_FREE_TEXT_LEN),
              z.number(),
              z.boolean(),
              z.null(),
            ]),
          )
          .optional()
          .describe(
            "Reserved for future filter pass-through. Empty/omitted today; passing a non-empty object returns an error.",
          ),
        connectionId: z
          .string()
          .max(MAX_IDENTIFIER_LEN)
          .optional()
          .describe(
            "Target connection id. Omit to use the default connection.",
          ),
      },
    },
    async ({ id, filters, connectionId }): Promise<CallToolResult> =>
      traceMcpToolCall(
        {
          toolName: "runMetric",
          workspaceId,
          transport,
          deployMode,
          attributes: { "metric.id": id },
        },
        () => {
          const requestId = dispatchId("mcp-runMetric");
          return withRequestContext({ requestId, user: actor, actor: mcpActor("runMetric") }, async () => {
            try {
              const limited = await rateLimitOrNull({
                clientId,
                orgId: workspaceId,
                userId: actor.id,
                toolName: "runMetric",
              });
              if (limited) return limited;
              if (filters && Object.keys(filters).length > 0) {
                return toEnvelopeResult(
                  envelope(
                    "validation_failed",
                    "runMetric `filters` pass-through is not yet supported. Use `executeSQL` with the metric's raw SQL to apply filters.",
                    {
                      hint: "Omit `filters` and re-run, or call executeSQL with a custom WHERE clause.",
                    },
                  ),
                );
              }

              const metric = findMetricById(id);
              if (!metric) {
                return toEnvelopeResult(
                  envelope("unknown_metric", `Metric "${id}" not found.`, {
                    hint: "Call listEntities or grep semantic/metrics/ to discover available metric ids.",
                  }),
                );
              }

              const explanation = metric.description
                ? `MCP runMetric ${metric.id}: ${metric.description}`
                : `MCP runMetric ${metric.id}`;

              const result = (await executeSQL.execute!(
                { sql: metric.sql, explanation, connectionId },
                { toolCallId: "mcp-runMetric", messages: [] },
              )) as Record<string, unknown>;

              if (result.success === false) {
                // Approval-required is a governance outcome, not a failure —
                // surface the approval_request_id + message intact so the
                // agent doesn't retry and silently duplicate the request.
                // Mirrors the same branch in tools.ts:executeSQL.
                if (result.approval_required === true) {
                  return toJsonContent({
                    id: metric.id,
                    approval_required: true,
                    approval_request_id: result.approval_request_id,
                    matched_rules: result.matched_rules,
                    message: result.message,
                  });
                }

                const rawError = String(
                  result.error ?? result.message ?? "Metric execution failed.",
                );
                const code = classifyExecuteSqlError(rawError);
                const extras: { request_id?: string; retry_after?: number } = {};
                if (code === "internal_error") extras.request_id = requestId;
                const retryAfterMs = result.retryAfterMs;
                if (code === "rate_limited" && typeof retryAfterMs === "number") {
                  extras.retry_after = Math.max(1, Math.round(retryAfterMs / 1000));
                }
                return toEnvelopeResult(
                  envelope(
                    code,
                    rawError,
                    Object.keys(extras).length ? extras : undefined,
                  ),
                );
              }

              const columns = Array.isArray(result.columns)
                ? (result.columns as string[])
                : [];
              const rows = Array.isArray(result.rows)
                ? (result.rows as Array<Record<string, unknown>>)
                : [];

              // Single column / single row → scalar value. Otherwise hand back
              // the rows so the caller can inspect — keeps the typed shape
              // honest for breakdown metrics without forcing a shape they don't
              // have.
              const value =
                columns.length === 1 && rows.length === 1
                  ? rows[0][columns[0]]
                  : rows;

              return toJsonContent({
                id: metric.id,
                label: metric.label,
                value,
                columns,
                rows,
                row_count: result.row_count ?? rows.length,
                truncated: Boolean(result.truncated),
                sql: metric.sql,
                executed_at: new Date().toISOString(),
              });
            } catch (err) {
              const message = errorMessage(err, "runMetric tool failed");
              process.stderr.write(`[atlas-mcp] runMetric threw: ${err}\n`);
              return toEnvelopeResult(
                envelope("internal_error", message, { request_id: requestId }),
              );
            }
          });
        },
      ),
  );
}
