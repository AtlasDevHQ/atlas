/**
 * Datasource lifecycle MCP tools (Tier 2 — PRD #3483, ADR-0016).
 *
 * This module owns EVERY datasource MCP tool. The Phase-1 lifecycle tools
 * land here first:
 *
 *   - `list_datasources`    — read; configured datasources, credential-free
 *   - `test_datasource`     — read; connection health-check
 *   - `archive_datasource`  — mutate (reversible); soft-archive an install
 *   - `restore_datasource`  — mutate (reversible); un-archive an install
 *   - `delete_datasource`   — mutate (DESTRUCTIVE); hard-delete, approval-gated
 *
 * (The Phase-2 provisioning/profiling tools — `create_datasource` #3511 /
 * `profile_datasource` #3512 — register here too once Session A's
 * elicitation #3499 + progress/cancel #3500 seams merge.)
 *
 * ── Lib-layer only (no loopback HTTP) ─────────────────────────────────
 * Every tool calls the lib seam in `@atlas/api/lib/datasources/mcp-lifecycle`,
 * which adapts the same `WorkspaceInstaller` facade + `connections` registry
 * the admin REST routes use to a context-free call shape. ADR-0016 forbids
 * an `origin=mcp` tool proxying its own product's HTTP API.
 *
 * ── Gate order (ADR-0016) ─────────────────────────────────────────────
 * Mutating tools route their dispatch through `runMcpDispatchGate` (#3508),
 * which enforces gates 2–4: `mcp:write` scope → RBAC(live role) →
 * approval(origin=mcp) for destructive actions. Gate 1 (the per-workspace
 * action-policy kill-switch, #3509) and gate 5 (inline confirm via
 * elicitation, #3497/#3499) prepend/append here once those seams merge —
 * see the `// GATE 1` / `// GATE 5` seams below. Read tools still pass
 * through the gate for RBAC (datasource metadata is an admin surface) but
 * declare `requiresWrite: false` so they don't demand `mcp:write`.
 *
 * Actor binding, OTel tracing, rate-limiting, and the typed
 * `AtlasMcpToolError` envelope mirror `semantic-tools.ts` exactly.
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AtlasUser, AtlasRole } from "@atlas/api/lib/auth/types";
import type { WorkspaceId } from "@useatlas/types";
import { withRequestContext } from "@atlas/api/lib/logger";
import { withErrorContract } from "@atlas/api/lib/tools/descriptions";
import {
  listDatasources,
  resolveDatasourceCatalogSlug,
  testDatasource,
  isDatasourceRegistered,
  runDatasourceInstaller,
  provisionDatasource,
  loadDatasourceProfileTarget,
  runSemanticProfile,
  MCP_PROVISIONABLE_CATALOG_SLUGS,
  type DatasourceInstallerOutcome,
} from "@atlas/api/lib/datasources/mcp-lifecycle";
import type { ProfileProgressCallbacks } from "@atlas/api/lib/profiler";
import {
  traceMcpToolCall,
  type McpTransport,
  type McpDeployMode,
} from "./telemetry.js";
import { envelope, toEnvelopeResult } from "./error-envelope.js";
import {
  runMcpDispatchGate,
  type McpDispatchGateContext,
  type McpDispatchGateRequirements,
} from "./dispatch-gate.js";
import { elicitMaskedField } from "./elicitation.js";
import { withProgressAndCancellation, OperationCancelledError } from "./progress.js";
import { enforceClientRateLimit } from "@atlas/api/lib/rate-limit/middleware";

// Every datasource tool is an admin surface — RBAC floor is `admin`.
const DATASOURCE_MIN_ROLE: AtlasRole = "admin";

// Bounds on free-text / identifier input — MCP clients (incl. hostile ones
// in BYOC SaaS) shouldn't drive megabyte strings into the lookups.
const MAX_FILTER_LEN = 1024;
const MAX_ID_LEN = 256;

// Install-id shape the datasource facade accepts: a lowercase-led slug, plus
// the two historical sentinels (`__demo__` backfilled by migration 0094;
// `default` the runtime-registered connection — valid as a TEST target even
// though the installer rejects it for archive/delete). Surfacing the
// constraint at the Zod boundary gives an immediate error instead of a
// downstream `unknown_entity`.
const INSTALL_ID_PATTERN = /^(?:[a-z][a-z0-9_-]*|__demo__|default)$/;

export interface RegisterDatasourceToolsOptions {
  /** Actor bound on every tool dispatch — see tools.ts / semantic-tools.ts. */
  actor: AtlasUser;
  /** OTel transport tag (#2029). */
  transport: McpTransport;
  /** Resolved workspace id for OTel attribution (`actor.activeOrganizationId` or `actor.id`). */
  workspaceId: string;
  /** Resolved `deployMode` for OTel attribution. */
  deployMode: McpDeployMode;
  /** Hosted-MCP OAuth client_id, surfaced into `audit_log.client_id` (#2067). */
  clientId?: string;
  /** #3504 — OAuth token scopes, threaded onto each dispatch's RequestContext. */
  scopes?: readonly string[];
}

function dispatchId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  const s = String(err);
  return s && s !== "[object Object]" ? s : fallback;
}

function toJsonContent(value: unknown): CallToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

/**
 * Bridge the profiler's per-table callbacks (#3506) to the MCP progress
 * reporter (#3500). `reporter.report` is async but progress notifications are
 * best-effort, so we fire-and-forget — a dropped notification must never
 * fail (or stall) the profiling work. No table data is sensitive; names are
 * already part of the generated whitelist the agent will query.
 */
function makeProfileProgress(reporter: {
  report(progress: number, opts?: { total?: number; message?: string }): Promise<void>;
}): ProfileProgressCallbacks {
  const fire = (progress: number, total: number, message: string) => {
    void reporter.report(progress, { total, message }).catch(() => {
      // intentionally ignored: progress is best-effort, never load-bearing.
    });
  };
  return {
    onStart: (total) => fire(0, total, `Profiling ${total} table${total === 1 ? "" : "s"}…`),
    onTableStart: () => {},
    onTableDone: (name, index, total) => fire(index + 1, total, `Profiled ${name}`),
    onTableError: (name, _error, index, total) =>
      fire(index + 1, total, `Skipped ${name} (profiling error)`),
    onComplete: () => {},
  };
}

/**
 * Per-OAuth-client rate-limit gate (#2071) — hosted threads `clientId`;
 * stdio leaves it undefined and is exempt. Identical to `semantic-tools.ts`.
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

/**
 * Map a `WorkspaceInstaller` error outcome onto a typed MCP envelope. The
 * facade's tagged errors collapse to two LLM-actionable codes: a 404
 * (catalog / install not found) becomes `unknown_entity` so the agent's
 * recovery is "call list_datasources"; a 400/409 (bad install id, schema
 * failure, already-archived conflict) becomes `validation_failed`. No
 * secret ever rides an installer error body.
 */
function installerErrorToEnvelope(
  outcome: Extract<DatasourceInstallerOutcome<unknown>, { kind: "error" }>,
  id: string,
): CallToolResult {
  if (outcome.status === 404) {
    return toEnvelopeResult(
      envelope("unknown_entity", outcome.message, {
        hint: `Datasource "${id}" was not found — call list_datasources to see configured datasources.`,
      }),
    );
  }
  return toEnvelopeResult(
    envelope("validation_failed", outcome.message, {
      hint: "Fix the datasource id or config and retry.",
    }),
  );
}

/**
 * Register every datasource lifecycle tool on the given MCP server.
 *
 * ── Registration handoff (Session A owns `server.ts`) ─────────────────
 * `createAtlasMcpServer` in `server.ts` wires this in with a single call,
 * mirroring the existing `registerTools(...)` line:
 *
 * ```ts
 * import { registerDatasourceTools } from "./datasource-tools.js";
 * // …after registerTools(server, …):
 * registerDatasourceTools(server, {
 *   actor, transport, ...(clientId && { clientId }), ...(scopes && { scopes }),
 *   workspaceId: actor.activeOrganizationId ?? actor.id,
 *   deployMode: getConfig()?.deployMode ?? "self-hosted",
 * });
 * ```
 *
 * That one line is the only edit outside this module — every tool handler,
 * lib call, and gate wiring lives here.
 */
export function registerDatasourceTools(
  server: McpServer,
  opts: RegisterDatasourceToolsOptions,
): void {
  const { actor, transport, workspaceId, deployMode, clientId, scopes } = opts;

  // #2067 — same actor shape as tools.ts / semantic-tools.ts so the
  // `mcp` actor_kind / clientId / toolName trail through the audit log.
  const mcpActor = (toolName: string) => ({
    kind: "mcp" as const,
    ...(clientId ? { clientId } : {}),
    toolName,
  });

  // Build the dispatch-gate context for a given dispatch. The bound actor's
  // live-resolved role (#3505) is gate 3's authority; orgId/requesterId drive
  // the approval attribution for destructive actions.
  const gateCtx = (requestId: string): McpDispatchGateContext => ({
    actor,
    ...(clientId ? { clientId } : {}),
    ...(scopes ? { scopes } : {}),
    orgId: actor.activeOrganizationId,
    requesterId: actor.id,
    requesterEmail: actor.label,
    requestId,
  });

  /**
   * Shared dispatch wrapper: OTel span → RequestContext → rate-limit → the
   * ADR-0016 gate order → the tool body. `reqs` declares the tool's gate
   * requirements (write/role/destructive). The body runs only after every
   * gate clears; a gate denial / approval-required short-circuit is returned
   * verbatim. Any throw becomes an `internal_error` envelope with the
   * dispatch's `request_id`.
   */
  async function dispatch(
    toolName: string,
    reqs: Omit<McpDispatchGateRequirements, "toolName">,
    body: (requestId: string) => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    return traceMcpToolCall(
      { toolName, workspaceId, transport, deployMode },
      () => {
        const requestId = dispatchId(`mcp-${toolName}`);
        return withRequestContext(
          {
            requestId,
            user: actor,
            actor: mcpActor(toolName),
            agentOrigin: "mcp",
            ...(scopes ? { scopes } : {}),
          },
          async () => {
            try {
              const limited = await rateLimitOrNull({
                clientId,
                orgId: workspaceId,
                userId: actor.id,
                toolName,
              });
              if (limited) return limited;

              // GATE 1 (action-policy kill-switch, #3509) — prepends here
              // once the per-workspace action policy merges: a workspace that
              // disables this action class blocks the tool outright before
              // any scope/RBAC work. Until then the merged pipeline (gates
              // 2–4) is the full enforced order.

              // GATES 2–4 (mcp:write → RBAC → approval) via the merged
              // dispatch pipeline (#3508 / ADR-0016).
              const gateBlock = await runMcpDispatchGate(gateCtx(requestId), {
                toolName,
                ...reqs,
              });
              if (gateBlock) return gateBlock;

              // GATE 5 (inline confirm via masked elicitation, #3497/#3499)
              // appends here for credential-bearing provisioning (Phase 2);
              // the lifecycle tools below have no inline-confirm step.

              return await body(requestId);
            } catch (err) {
              // Client-initiated cancellation (#3500) is not a tool failure —
              // the SDK already suppressed the response, so propagate it
              // rather than coercing it into an `internal_error` envelope.
              if (err instanceof OperationCancelledError) throw err;
              const message = errorMessage(err, `${toolName} tool failed`);
              process.stderr.write(`[atlas-mcp] ${toolName} threw: ${err}\n`);
              return toEnvelopeResult(
                envelope("internal_error", message, { request_id: requestId }),
              );
            }
          },
        );
      },
    );
  }

  // --- list_datasources (read) ---
  server.registerTool(
    "list_datasources",
    {
      title: "List Datasources",
      description: withErrorContract(LIST_DATASOURCES_DESCRIPTION, DATASOURCE_READ_ERROR_CODES),
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        include_archived: z
          .boolean()
          .optional()
          .describe(
            "Include archived datasources (default false). Set true to discover an archived datasource you intend to restore.",
          ),
        filter: z
          .string()
          .max(MAX_FILTER_LEN)
          .optional()
          .describe(
            "Optional case-insensitive substring matched against id, dbType, and description.",
          ),
      },
    },
    async ({ include_archived, filter }): Promise<CallToolResult> =>
      dispatch(
        "list_datasources",
        { requiresWrite: false, minRole: DATASOURCE_MIN_ROLE },
        async () => {
          // Published-mode view (external MCP clients are never developer-mode
          // admins). `include_archived` opts archived rows back in for restore
          // discovery — they're always credential-free.
          const all = await listDatasources(workspaceId, "published", {
            includeArchived: Boolean(include_archived),
          });
          const needle = filter?.toLowerCase().trim();
          const filtered = needle
            ? all.filter(
                (d) =>
                  d.id.toLowerCase().includes(needle) ||
                  d.dbType.toLowerCase().includes(needle) ||
                  (d.description?.toLowerCase().includes(needle) ?? false),
              )
            : all;
          return toJsonContent({ count: filtered.length, datasources: filtered });
        },
      ),
  );

  // --- test_datasource (read / health-check) ---
  server.registerTool(
    "test_datasource",
    {
      title: "Test Datasource Connection",
      description: withErrorContract(TEST_DATASOURCE_DESCRIPTION, DATASOURCE_READ_ERROR_CODES),
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        id: datasourceIdSchema(
          "Datasource id (connection id) to health-check. Call list_datasources to discover ids.",
        ),
      },
    },
    async ({ id }): Promise<CallToolResult> =>
      dispatch(
        "test_datasource",
        { requiresWrite: false, minRole: DATASOURCE_MIN_ROLE },
        async () => {
          if (!isDatasourceRegistered(id)) {
            return toEnvelopeResult(
              envelope(
                "unknown_entity",
                `Datasource "${id}" is not registered (it may not exist or may be archived).`,
                { hint: "Call list_datasources to see configured, queryable datasources." },
              ),
            );
          }
          const health = await testDatasource(id);
          return toJsonContent({
            id,
            status: health.status,
            latency_ms: health.latencyMs,
            // `message` is DSN-scrubbed by the registry — safe to surface.
            ...(health.message ? { message: health.message } : {}),
            checked_at: health.checkedAt.toISOString(),
          });
        },
      ),
  );

  // --- archive_datasource (mutate, reversible) ---
  server.registerTool(
    "archive_datasource",
    {
      title: "Archive Datasource",
      description: withErrorContract(ARCHIVE_DATASOURCE_DESCRIPTION, DATASOURCE_WRITE_ERROR_CODES),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        id: datasourceIdSchema(
          "Datasource id to archive. Reversible — restore with restore_datasource.",
        ),
      },
    },
    async ({ id }): Promise<CallToolResult> =>
      dispatch(
        "archive_datasource",
        { requiresWrite: true, minRole: DATASOURCE_MIN_ROLE, actionCategory: "datasource" },
        async () => archiveOrRestore(id, "archive"),
      ),
  );

  // --- restore_datasource (mutate, reversible) ---
  server.registerTool(
    "restore_datasource",
    {
      title: "Restore Datasource",
      description: withErrorContract(RESTORE_DATASOURCE_DESCRIPTION, DATASOURCE_WRITE_ERROR_CODES),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        id: datasourceIdSchema(
          "Archived datasource id to restore (un-archive). Call list_datasources with include_archived to discover ids.",
        ),
      },
    },
    async ({ id }): Promise<CallToolResult> =>
      dispatch(
        "restore_datasource",
        { requiresWrite: true, minRole: DATASOURCE_MIN_ROLE, actionCategory: "datasource" },
        async () => archiveOrRestore(id, "restore"),
      ),
  );

  // --- delete_datasource (mutate, DESTRUCTIVE → approval-gated) ---
  server.registerTool(
    "delete_datasource",
    {
      title: "Delete Datasource",
      description: withErrorContract(DELETE_DATASOURCE_DESCRIPTION, DATASOURCE_WRITE_ERROR_CODES),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      inputSchema: {
        id: datasourceIdSchema(
          "Datasource id to permanently delete. IRREVERSIBLE — prefer archive_datasource unless you intend a hard delete.",
        ),
      },
    },
    async ({ id }): Promise<CallToolResult> =>
      dispatch(
        "delete_datasource",
        {
          requiresWrite: true,
          minRole: DATASOURCE_MIN_ROLE,
          // Gate 1 (#3509): the datasource action-policy kill-switch blocks
          // this outright when the workspace disables datasource actions.
          actionCategory: "datasource",
          // Destructive → routes through the origin=mcp approval gate (#3508).
          // `resource` is the approval-matchable target; `description` is
          // stored on the queued request so a reviewer sees what was attempted.
          destructive: {
            resource: `datasource:${id}`,
            description: `Delete datasource "${id}" (hard delete via MCP)`,
          },
        },
        async () => {
          // Resolve the catalog slug first so a non-existent id returns a
          // clean `unknown_entity` rather than an installer defect. (The
          // approval gate already ran in `dispatch`; reaching here means the
          // requester is approved or no rule matched.)
          const catalogSlug = await resolveDatasourceCatalogSlug(workspaceId, id);
          if (catalogSlug === null) {
            return toEnvelopeResult(
              envelope("unknown_entity", `Datasource "${id}" not found.`, {
                hint: "Call list_datasources to see configured datasources.",
              }),
            );
          }
          // Hard delete (`hard: true`) — DELETEs the workspace_plugins row and
          // drains the pool. The reversible path is archive_datasource.
          const outcome = await runDatasourceInstaller((installer) =>
            installer.uninstallDatasource(
              workspaceId as WorkspaceId,
              catalogSlug,
              id,
              { hard: true },
            ),
          );
          if (outcome.kind === "error") return installerErrorToEnvelope(outcome, id);
          return toJsonContent({ id, deleted: true });
        },
      ),
  );

  // --- create_datasource (mutate; credential via masked elicitation) ---
  server.registerTool(
    "create_datasource",
    {
      title: "Create Datasource",
      description: withErrorContract(CREATE_DATASOURCE_DESCRIPTION, DATASOURCE_WRITE_ERROR_CODES),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      inputSchema: {
        db_type: z
          .enum(MCP_PROVISIONABLE_CATALOG_SLUGS as [string, ...string[]])
          .describe(
            `Datasource type. Provisionable via MCP today: ${MCP_PROVISIONABLE_CATALOG_SLUGS.join(", ")}.`,
          ),
        install_id: datasourceIdSchema(
          "New datasource id (lowercase-led slug, e.g. 'prod-us'). Must be unique in the workspace.",
        ),
        schema: z
          .string()
          .max(MAX_ID_LEN)
          .optional()
          .describe("Optional schema/search_path (Postgres). Defaults to the server default."),
        description: z
          .string()
          .max(MAX_FILTER_LEN)
          .optional()
          .describe("Optional human-readable description."),
        group_id: z
          .string()
          .max(MAX_ID_LEN)
          .optional()
          .describe("Optional environment-group binding."),
      },
    },
    async ({ db_type, install_id, schema, description, group_id }, extra): Promise<CallToolResult> =>
      dispatch(
        "create_datasource",
        // Gate 1 (#3509) datasource kill-switch + mcp:write + admin. NOT
        // approval-gated (provisioning is additive, lands draft); the
        // human-in-the-loop is the masked credential entry below.
        { requiresWrite: true, minRole: DATASOURCE_MIN_ROLE, actionCategory: "datasource" },
        async (requestId) => {
          const orgId = actor.activeOrganizationId;
          if (!orgId) {
            return toEnvelopeResult(
              envelope(
                "validation_failed",
                "This MCP session is not bound to a workspace; provisioning requires a bound workspace.",
                { hint: "Set ATLAS_MCP_ORG_ID (and ATLAS_MCP_USER_ID) for the MCP server." },
              ),
            );
          }

          // Collect the connection URL via MASKED form-mode elicitation
          // (#3499). The secret travels client→server only; it never enters
          // a tool argument, the agent/LLM context, this response, or a log.
          let elicited;
          try {
            elicited = await elicitMaskedField(server, {
              principal: orgId,
              message: `Enter the ${db_type} connection URL for "${install_id}". It is sent securely and never shared with the agent.`,
              field: {
                name: "url",
                title: `${db_type} connection URL`,
                description: "Entered securely; never shared with the agent or stored in plaintext.",
              },
              ...(extra.signal ? { signal: extra.signal } : {}),
            });
          } catch (err) {
            // Elicitation unsupported by the client, or a state/secret error.
            // Never include the (never-yet-received) credential; surface a
            // capability-shaped message.
            return toEnvelopeResult(
              envelope(
                "validation_failed",
                `Could not securely collect the connection credential: ${errorMessage(err, "elicitation failed")}.`,
                { hint: "Use an MCP client that supports masked form elicitation, or provision via the admin console." },
              ),
            );
          }
          if (elicited.action !== "accept") {
            return toEnvelopeResult(
              envelope(
                "validation_failed",
                `Datasource creation was ${elicited.action === "decline" ? "declined" : "cancelled"} — no credential was provided.`,
              ),
            );
          }
          // `url` is the secret — used only for the pre-flight probe + the
          // installer's encrypt-at-rest path. NEVER logged or returned.
          const url = elicited.value;

          const outcome = await provisionDatasource(orgId, {
            catalogSlug: db_type,
            installId: install_id,
            url,
            ...(schema !== undefined ? { schema } : {}),
            ...(description !== undefined ? { description } : {}),
            groupId: group_id ?? null,
          });

          switch (outcome.kind) {
            case "ok":
              // Only the masked URL is ever surfaced.
              return toJsonContent({
                id: outcome.value.installId,
                db_type: outcome.value.dbType,
                status: outcome.value.status,
                masked_url: outcome.value.maskedUrl,
                description: outcome.value.description,
                schema: outcome.value.schema,
                group_id: outcome.value.groupId,
                created: true,
                next: `Run profile_datasource with id "${outcome.value.installId}" to generate its semantic layer and make it queryable.`,
              });
            case "unsupported":
              return toEnvelopeResult(envelope("validation_failed", outcome.message));
            case "health_error":
              // Pre-flight failed — message is credential-scrubbed by the lib.
              return toEnvelopeResult(
                envelope("validation_failed", outcome.message, {
                  hint: "Verify the connection details and that the database is reachable, then retry.",
                }),
              );
            case "error":
              // Installer rejection (conflict / bad config) — agent-actionable.
              return toEnvelopeResult(
                envelope("validation_failed", outcome.message, { request_id: requestId }),
              );
          }
        },
      ),
  );

  // --- profile_datasource (mutate, long-running → progress + cancellable) ---
  server.registerTool(
    "profile_datasource",
    {
      title: "Profile Datasource & Generate Semantic Layer",
      description: withErrorContract(PROFILE_DATASOURCE_DESCRIPTION, DATASOURCE_WRITE_ERROR_CODES),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        id: datasourceIdSchema(
          "Datasource id to profile. Typically one just created with create_datasource.",
        ),
      },
    },
    async ({ id }, extra): Promise<CallToolResult> =>
      dispatch(
        "profile_datasource",
        { requiresWrite: true, minRole: DATASOURCE_MIN_ROLE, actionCategory: "datasource" },
        async () => {
          const target = await loadDatasourceProfileTarget(workspaceId, id);
          if (target.kind === "not_found") {
            return toEnvelopeResult(
              envelope("unknown_entity", `Datasource "${id}" not found.`, {
                hint: "Call list_datasources to see configured datasources.",
              }),
            );
          }
          if (target.kind === "unsupported") {
            return toEnvelopeResult(
              envelope(
                "validation_failed",
                `Profiling "${target.dbType}" datasources via MCP is not supported yet (only postgres and mysql).`,
              ),
            );
          }

          // Long-running: report per-table progress and honor client
          // cancellation (#3500). The decrypted URL stays inside the lib —
          // only the connectionId + progress counts surface here.
          const result = await withProgressAndCancellation(
            extra,
            { startMessage: `Profiling datasource "${id}"`, endMessage: "Semantic layer generated" },
            async (reporter) => {
              const progress = makeProfileProgress(reporter);
              return runSemanticProfile({
                url: target.target.url,
                dbType: target.target.dbType,
                ...(target.target.schema !== undefined ? { schema: target.target.schema } : {}),
                connectionId: id,
                progress,
              });
            },
          );

          if (result.kind === "error") {
            // Tagged ProfilingFailedError — an agent-actionable validation
            // outcome (no tables, too many failures), not a 500.
            return toEnvelopeResult(envelope("validation_failed", result.message));
          }

          const r = result.result;
          const tables = r.entities.map((e) => e.table);
          return toJsonContent({
            id,
            queryable: true,
            entities_generated: r.entities.length,
            metrics_generated: r.metrics.length,
            tables,
            profiling_errors: r.errors.length,
            elapsed_ms: r.elapsedMs,
          });
        },
      ),
  );

  /**
   * Shared archive/restore body — both route the same install through the
   * `WorkspaceInstaller`, differing only in the mutation:
   *   - archive  → `uninstallDatasource` (soft; status='archived', pool drained)
   *   - restore  → `updateDatasourceConfig({ status: 'published' })`
   * Resolves the catalog slug first for a clean not-found.
   */
  async function archiveOrRestore(
    id: string,
    action: "archive" | "restore",
  ): Promise<CallToolResult> {
    const catalogSlug = await resolveDatasourceCatalogSlug(workspaceId, id);
    if (catalogSlug === null) {
      return toEnvelopeResult(
        envelope("unknown_entity", `Datasource "${id}" not found.`, {
          hint:
            action === "restore"
              ? "Call list_datasources with include_archived to see archivable/restorable datasources."
              : "Call list_datasources to see configured datasources.",
        }),
      );
    }

    if (action === "archive") {
      const outcome = await runDatasourceInstaller((installer) =>
        installer.uninstallDatasource(workspaceId as WorkspaceId, catalogSlug, id),
      );
      if (outcome.kind === "error") return installerErrorToEnvelope(outcome, id);
      return toJsonContent({ id, status: "archived", archived: true });
    }

    const outcome = await runDatasourceInstaller((installer) =>
      installer.updateDatasourceConfig(workspaceId as WorkspaceId, catalogSlug, id, {
        status: "published",
      }),
    );
    if (outcome.kind === "error") return installerErrorToEnvelope(outcome, id);
    return toJsonContent({ id, status: outcome.value.status, restored: true });
  }
}

// ── Input schema helper ───────────────────────────────────────────────

function datasourceIdSchema(description: string) {
  return z
    .string()
    .min(1)
    .max(MAX_ID_LEN)
    .regex(
      INSTALL_ID_PATTERN,
      "Datasource id must be a lowercase-led slug (letters, digits, _ , -).",
    )
    .describe(description);
}

// ── LLM-facing descriptions + per-tool error catalogs ─────────────────
//
// Kept local to this module (not in the shared `lib/tools/descriptions.ts`)
// because every datasource tool lives here — there's no cross-package
// consumer of these strings. `withErrorContract` is the shared appender.

const LIST_DATASOURCES_DESCRIPTION = `List the datasources (database connections) configured for this workspace. Returns credential-free metadata only — \`{ id, dbType, description, status, groupId, health }\` per datasource; NEVER a connection URL, password, or any secret. Pass \`include_archived: true\` to also list archived datasources (for restore). Example response: \`{ "count": 2, "datasources": [{ "id": "prod-us", "dbType": "postgres", "status": "published", "groupId": "prod", "health": { "status": "healthy", "latencyMs": 12 } }] }\`.`;

const TEST_DATASOURCE_DESCRIPTION = `Run a connection health-check (a \`SELECT 1\` probe under a short timeout) against a configured datasource and report its status + latency. Read-only — does not mutate Atlas or the datasource. Example call: \`{ "id": "prod-us" }\`. Example response: \`{ "id": "prod-us", "status": "healthy", "latency_ms": 12, "checked_at": "..." }\`.`;

const ARCHIVE_DATASOURCE_DESCRIPTION = `Archive (soft-disable) a datasource: its pool is drained and it stops being queryable, but the configuration is retained so it can be restored. Reversible via restore_datasource. Requires the \`mcp:write\` scope and the admin role. Example call: \`{ "id": "prod-us" }\`. Example response: \`{ "id": "prod-us", "status": "archived", "archived": true }\`.`;

const RESTORE_DATASOURCE_DESCRIPTION = `Restore (un-archive) a previously archived datasource so it becomes queryable again. Requires the \`mcp:write\` scope and the admin role. Example call: \`{ "id": "prod-us" }\`. Example response: \`{ "id": "prod-us", "status": "published", "restored": true }\`.`;

const DELETE_DATASOURCE_DESCRIPTION = `Permanently delete a datasource — removes the configuration and drains the pool. IRREVERSIBLE (use archive_datasource for a recoverable disable). Destructive: requires the \`mcp:write\` scope and the admin role, and routes through the workspace approval flow when an origin=mcp approval rule requires it (the response then carries \`approval_required: true\` with an \`approval_request_id\` to follow up on). Example call: \`{ "id": "old-staging" }\`. Example success: \`{ "id": "old-staging", "deleted": true }\`.`;

const CREATE_DATASOURCE_DESCRIPTION = `Provision a NEW datasource (postgres or mysql) for this workspace. You supply only non-secret fields — \`db_type\`, \`install_id\`, optional \`schema\`/\`description\`/\`group_id\`. The connection URL (the credential) is collected SEPARATELY via a secure masked prompt to the user; it is never passed as a tool argument and never shared with you. The connection is health-checked BEFORE it is persisted (a failed probe persists nothing), and lands as a \`draft\` — run profile_datasource next to make it queryable. Requires the \`mcp:write\` scope and the admin role. Example call: \`{ "db_type": "postgres", "install_id": "prod-us" }\`. Example success: \`{ "id": "prod-us", "db_type": "postgres", "status": "draft", "masked_url": "postgres://***@…", "created": true }\`.`;

const PROFILE_DATASOURCE_DESCRIPTION = `Profile a datasource (introspect its tables) and generate its semantic layer — entities + the table whitelist — so the agent can query it with executeSQL. Long-running: emits progress per table and is cancellable. Typically run right after create_datasource. Requires the \`mcp:write\` scope and the admin role. Example call: \`{ "id": "prod-us" }\`. Example success: \`{ "id": "prod-us", "queryable": true, "entities_generated": 12, "tables": ["orders", "users"], "elapsed_ms": 1840 }\`.`;

// Read tools: not-found surfaces as `unknown_entity`; everything else as
// `internal_error`. RBAC denial (gate 3) surfaces as `forbidden`.
const DATASOURCE_READ_ERROR_CODES = [
  "unknown_entity",
  "forbidden",
  "rate_limited",
  "internal_error",
] as const;

// Write/destructive tools add `validation_failed` (bad id / installer
// rejection). The approval-required outcome is NOT an error code — it's a
// non-error JSON body the agent must surface, per the dispatch-gate contract.
const DATASOURCE_WRITE_ERROR_CODES = [
  "unknown_entity",
  "validation_failed",
  "forbidden",
  "rate_limited",
  "internal_error",
] as const;
