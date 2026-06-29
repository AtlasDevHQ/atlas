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
import { listEntities } from "@atlas/api/lib/semantic/entities";
import {
  getEntityByName,
  searchGlossary,
  findMetricById,
} from "@atlas/api/lib/semantic/lookups";
import { executeSQL } from "@atlas/api/lib/tools/sql";
import { loadGroupRoutingContext } from "@atlas/api/lib/env-routing/lookup";
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
import { type McpTransport, type McpDeployMode } from "./telemetry.js";
import {
  classifyExecuteSqlError,
  envelope,
  toEnvelopeResult,
  toJsonContent,
  toStructuredContent,
} from "./error-envelope.js";
import { createMcpDispatch } from "./mcp-dispatch.js";
import { runMetricOutputShape, withResumeHint } from "./structured-output.js";
import { withProgressAndCancellation } from "./progress.js";

// Modest input bounds — MCP clients (including hostile ones in BYOC
// SaaS) shouldn't be able to drive megabyte strings into the catalog
// scanners or substring search. Identifiers stay short; free-text
// filter/term get a bit more headroom. Bumping these is fine if a real
// user need surfaces.
const MAX_IDENTIFIER_LEN = 256;
const MAX_FREE_TEXT_LEN = 1024;

// Upper bound on a single batched `describeEntity` call. Generous enough to
// cover any realistic multi-entity join (the whole catalog is typically a few
// dozen entities) while capping the payload a hostile client can force into
// one round-trip.
const MAX_DESCRIBE_BATCH = 50;

// Mirrors the entity-name shape `isValidEntityName` accepts in
// `lib/semantic/files.ts` (no `/`, `\`, `..`, `\0`). Surfacing the
// constraint at the Zod boundary gives the MCP client an immediate
// error instead of an indistinguishable `{ found: false }`.
const ENTITY_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

// The flat-root semantic group, mirroring the `group: "default"` the scanner
// stamps for the default layout (`lib/semantic/scanner.ts:getGroupDirs`). A
// metric whose resolved `source` is this group runs against the default
// connection; any other value is a connection-group id (#3274).
const DEFAULT_SEMANTIC_GROUP = "default";

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
  /** #3504 — OAuth token scopes, threaded onto each dispatch's RequestContext. */
  scopes?: readonly string[];
}

export function registerSemanticTools(
  server: McpServer,
  opts: RegisterSemanticToolsOptions,
): void {
  const { actor, transport, workspaceId, deployMode, clientId, scopes } = opts;

  // Shared dispatch wrapper (#3602) — identical contract to tools.ts /
  // datasource-tools.ts (OTel → actor bind → rate-limit → ADR-0016 gate order
  // → body → typed error envelope), defined once in `mcp-dispatch.ts`. The
  // three metadata tools (listEntities / describeEntity / searchGlossary) read
  // semantic YAML — no billing; `runMetric` executes datasource SQL so it
  // declares `checksBilling`. All are member-callable reads.
  const { dispatch } = createMcpDispatch({
    actor,
    transport,
    workspaceId,
    deployMode,
    ...(clientId ? { clientId } : {}),
    ...(scopes ? { scopes } : {}),
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
      // Read-only over the local semantic catalog (closed world).
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ filter }): Promise<CallToolResult> =>
      dispatch(
        "listEntities",
        { requiresWrite: false, requiresBoundOrg: false, minRole: "member" },
        async () => {
          // Bind orgId + published mode so MCP discovery reads the same
          // universe `executeSQL`'s published-mode whitelist sees. External MCP
          // clients never run as developer-mode admins, so a draft entity
          // surfacing here would be uncallable.
          const entities = await listEntities({
            orgId: workspaceId,
            mode: "published",
            filter,
          });
          return toJsonContent({ count: entities.length, entities });
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
          .optional()
          .describe(
            "Single entity name (`name` field) or table name. Alphanumerics, `_`, `-`, `.` only — no path separators. Mutually exclusive with `names`.",
          ),
        names: z
          .array(
            z.string().min(1).max(MAX_IDENTIFIER_LEN).regex(ENTITY_NAME_PATTERN),
          )
          .min(1)
          .max(MAX_DESCRIBE_BATCH)
          .optional()
          .describe(
            `Batch of entity/table names to describe in a single call (up to ${MAX_DESCRIBE_BATCH}). Prefer this over repeated single calls when a query spans multiple entities. Duplicate names are de-duplicated, so \`count\` may be smaller than the number of names sent. Mutually exclusive with \`name\`.`,
          ),
      },
      // Read-only over the local semantic catalog (closed world).
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ name, names }): Promise<CallToolResult> =>
      dispatch(
        "describeEntity",
        { requiresWrite: false, requiresBoundOrg: false, minRole: "member" },
        async () => {
          // The MCP raw-shape inputSchema can't express a cross-field
          // "exactly one of" refinement, so enforce it here. Both-or-neither
          // is a client mistake, not a catalog miss — return `validation_failed`
          // with a hint rather than guessing which arg was intended.
          if ((name !== undefined) === (names !== undefined)) {
            return toEnvelopeResult(
              envelope(
                "validation_failed",
                "Provide exactly one of `name` (single entity) or `names` (batch).",
                {
                  hint: "Pass `name` to describe one entity, or `names` to describe several in one call.",
                },
              ),
            );
          }

          // Single-name path — wire shape unchanged for existing clients.
          if (name !== undefined) {
            const entity = getEntityByName(name);
            if (!entity) {
              // Unknown-entity isn't really a "tool failed" condition for the
              // agent — the agent's recovery is "call listEntities and pick a
              // known one." Emit it as a typed envelope so the recovery is
              // machine-readable, with a hint pointing the agent at the right
              // next call.
              return toEnvelopeResult(
                envelope(
                  "unknown_entity",
                  `Entity "${name}" not found in the semantic layer.`,
                  { hint: "Call listEntities to discover available entities." },
                ),
              );
            }
            return toJsonContent({ found: true, entity });
          }

          // Batch path — dedupe (preserving first-seen order) and resolve each.
          // A miss is not a tool failure here: resolved entities come back in
          // `entities`, misses in `notFound`, so the agent recovers per-name
          // instead of losing the whole batch to one bad name.
          const requested = names ?? [];
          const seen = new Set<string>();
          const ordered: string[] = [];
          for (const n of requested) {
            if (!seen.has(n)) {
              seen.add(n);
              ordered.push(n);
            }
          }

          const entities: NonNullable<ReturnType<typeof getEntityByName>>[] = [];
          const notFound: string[] = [];
          for (const n of ordered) {
            const entity = getEntityByName(n);
            if (entity) entities.push(entity);
            else notFound.push(n);
          }

          return toJsonContent({
            count: entities.length,
            entities,
            notFound,
            ...(notFound.length > 0
              ? {
                  hint: "Unrecognized names are listed in `notFound`; call listEntities to discover valid names.",
                }
              : {}),
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
      // Read-only over the local business glossary (closed world).
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ term }): Promise<CallToolResult> =>
      dispatch(
        "searchGlossary",
        { requiresWrite: false, requiresBoundOrg: false, minRole: "member" },
        async () => {
          const matches = searchGlossary(term);

          // The disambiguation contract (#2020 + forthcoming #2025): when ANY
          // matched glossary entry has `status: ambiguous`, surface it as a hard
          // `ambiguous_term` envelope with the possible mappings in the hint.
          // The agent's correct recovery is to ask the user which mapping they
          // meant — never silently pick. The forthcoming eval harness is
          // expected to assert on `code === "ambiguous_term"`.
          const ambiguous = matches.find((m) => m.status === "ambiguous");
          if (ambiguous) {
            const mappings =
              ambiguous.possible_mappings.length > 0
                ? ` Possible mappings: ${ambiguous.possible_mappings.join(", ")}.`
                : "";
            // Note when other matches were dropped — the envelope contract is
            // "one ambiguous term blocks the call" so callers don't see sibling
            // defined terms that were in the same result set. Tell the agent it
            // can re-query for a more specific term to recover the others.
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

          return toJsonContent({ query: term, count: matches.length, matches });
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
          .min(1)
          .max(MAX_IDENTIFIER_LEN)
          .optional()
          .describe(
            "Target connection id. Omit to run the metric against its own group — a metric defined under `groups/<group>/` runs against `<group>`, an ungrouped metric against the default connection. Passing a connection id that does not match the metric's group is rejected.",
          ),
      },
      // Runs the metric's authoritative SELECT through the same validated
      // executeSQL path — read-only, but against an external database
      // (openWorldHint true), like executeSQL.
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
      // #3498 — typed result so agents parse value/columns/rows instead of
      // re-parsing the text block (which is retained below).
      outputSchema: runMetricOutputShape,
    },
    async ({ id, filters, connectionId }, extra): Promise<CallToolResult> =>
      dispatch(
        "runMetric",
        // runMetric executes datasource SQL via executeSQL.execute → gate-0
        // billing (#3437/#3601), like executeSQL. Metadata-only tools above are
        // deliberately not billing-gated. Member-callable read.
        { requiresWrite: false, requiresBoundOrg: false, minRole: "member", checksBilling: true },
        async (requestId) => {
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

          // #3274 — route a group-scoped metric to its own connection.
          // `metric.source` is the metric's resolved semantic group (#3240);
          // search.ts surfaces a grouped entity's `connection` field as that
          // same group, so the group IS the connection id executeSQL routes on.
          // The default group (`"default"`) maps to the default connection —
          // passed through as an unset connectionId so executeSQL keeps its
          // existing default-routing behavior. A `groups/<group>/metrics/`
          // metric resolves to its group, so omitting connectionId runs it
          // against `<group>` instead of the default datasource (which would
          // return silently-wrong rows for overlapping table names, or an
          // avoidable whitelist miss for non-overlapping ones).
          const groupConnectionId =
            metric.source === DEFAULT_SEMANTIC_GROUP ? undefined : metric.source;
          // Canonical connection token for the metric's group — `"default"`
          // (not unset) for the default group — so an explicit connectionId can
          // be matched against it directly.
          const metricConnectionId =
            metric.source === DEFAULT_SEMANTIC_GROUP ? "default" : metric.source;
          // Reject an explicit connectionId that targets a different group:
          // running the metric's authoritative SQL against the wrong datasource
          // is the silently-wrong-results failure mode #3274 exists to prevent.
          // An explicit match against the group id itself (including the literal
          // `"default"` for a default-group metric) is honored as-is.
          if (connectionId !== undefined && connectionId !== metricConnectionId) {
            // #3281 — the connectionId isn't the group id itself, but for a
            // multi-member group it may be a legitimate MEMBER: a group `prod`
            // with members `us-prod`/`eu-prod` registers each member under its
            // own install id, none equal to the group id. Resolve the passed
            // connection's group and accept iff it matches the metric's group,
            // then route to that specific member.
            //
            // A default-source (ungrouped) metric has no members: its canonical
            // SQL is defined only against the default connection, so any
            // explicit non-default connectionId is rejected. Running a canonical
            // metric against an arbitrary sibling connection is intentionally
            // out of scope — model it as a grouped metric and pass a member id
            // instead (decision recorded for #3281).
            let isGroupMember = false;
            if (metric.source !== DEFAULT_SEMANTIC_GROUP) {
              const routing = await loadGroupRoutingContext(workspaceId, connectionId);
              if (routing.degraded) {
                // #4109 — the internal-DB routing lookup faulted, so the
                // `groupId: undefined` it returned is the ABSENCE of an answer,
                // not a definitive "not a member". `validation_failed` is a
                // terminal client error the agent won't retry, so emitting it
                // here would masquerade a transient server fault as a confident
                // wrong-datasource verdict. Mirror the REST route's
                // `routing_unavailable` → 503 and surface a retryable
                // `internal_error` carrying the request_id instead (CLAUDE.md
                // "prefer errors over silent fallbacks").
                return toEnvelopeResult(
                  envelope(
                    "internal_error",
                    "Could not verify the connection's group membership right now (a transient internal error). Please retry shortly.",
                    { request_id: requestId, retry_after: 2 },
                  ),
                );
              }
              isGroupMember = routing.groupId === metric.source;
            }
            if (!isGroupMember) {
              return toEnvelopeResult(
                envelope(
                  "validation_failed",
                  `Metric "${metric.id}" belongs to the "${metric.source}" group, but connectionId "${connectionId}" targets a different datasource. Running it there would query the wrong data.`,
                  {
                    hint: `Omit connectionId to run "${metric.id}" against its own group, or pass the group id "${metricConnectionId}" or one of its member connections.`,
                  },
                ),
              );
            }
          }
          const targetConnectionId = connectionId ?? groupConnectionId;

          const explanation = metric.description
            ? `MCP runMetric ${metric.id}: ${metric.description}`
            : `MCP runMetric ${metric.id}`;

          // #3500 — progress + cancellation around the metric query.
          // #3575 — `executeSQL.execute` does not read `abortSignal` from the
          // tool-call extra (sql.ts destructures only sql/explanation/
          // connectionId/scope). Passing a signal would be dead code and imply
          // the query is abortable at the driver level, which it is not. The
          // statement-timeout (`ATLAS_QUERY_TIMEOUT`, default 30s) is the sole
          // cancellation mechanism for the datasource side; a client cancel cuts
          // the dispatch loose at the MCP boundary (the shared dispatch
          // re-throws the cancellation) and the DB-side query drains within that
          // window.
          const result = (await withProgressAndCancellation(
            extra,
            { startMessage: "Running metric", endMessage: "Metric complete" },
            async (_reporter, _signal) =>
              executeSQL.execute!(
                { sql: metric.sql, explanation, connectionId: targetConnectionId },
                { toolCallId: "mcp-runMetric", messages: [] },
              ),
          )) as Record<string, unknown>;

          if (result.success === false) {
            // Approval-required is a governance outcome, not a failure —
            // surface the approval_request_id + message intact so the agent
            // doesn't retry and silently duplicate the request. Mirrors the
            // same branch in tools.ts:executeSQL.
            if (result.approval_required === true) {
              return toStructuredContent({
                id: metric.id,
                approval_required: true,
                approval_request_id: result.approval_request_id,
                matched_rules: result.matched_rules,
                // #3750 — resume hint: re-run this exact runMetric call once
                // approved (parity with executeSQL's approval branch).
                message: withResumeHint(result.message),
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

          // Single column / single row → scalar value. Otherwise hand back the
          // rows so the caller can inspect — keeps the typed shape honest for
          // breakdown metrics without forcing a shape they don't have.
          const value =
            columns.length === 1 && rows.length === 1 ? rows[0][columns[0]] : rows;

          return toStructuredContent({
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
        },
        { "metric.id": id },
      ),
  );
}
