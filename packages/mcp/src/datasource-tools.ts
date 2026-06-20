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
import { withErrorContract } from "@atlas/api/lib/tools/descriptions";
// Registration-time value: the light, dependency-free provisionable-slugs const
// (used by the `db_type` enum). The create_datasource success hint's profilable
// check is resolved LAZILY via `lib.resolveProfileCapabilityByDbType` (#3667) —
// now an accurate proxy for what `profile_datasource` accepts because the
// URL-shape gate is gone (profiling rides the unified `resolveLiveConnection`).
// Everything else from `mcp-lifecycle` is loaded LAZILY (below) so registering
// these tools doesn't drag the installer / semantic-gen / Effect-startup graph
// into MCP server boot — see `lifecycle()`.
import { MCP_PROVISIONABLE_CATALOG_SLUGS } from "@atlas/api/lib/datasources/provisionable-types";
import type { DatasourceInstallerOutcome } from "@atlas/api/lib/datasources/mcp-lifecycle";
import type { ProfileProgressCallbacks } from "@atlas/api/lib/profiler";
import type { McpTransport, McpDeployMode } from "./telemetry.js";
import { envelope, toEnvelopeResult, toJsonContent } from "./error-envelope.js";
import { createMcpDispatch, errorMessage } from "./mcp-dispatch.js";
import { elicitMaskedForm } from "./elicitation.js";
import { withProgressAndCancellation, OperationCancelledError } from "./progress.js";

// ── Lazy heavy-module loaders ─────────────────────────────────────────
//
// The datasource lib (`mcp-lifecycle`) and the dispatch gate transitively pull
// the WorkspaceInstaller, the #3506 SemanticGenerator, the enterprise/approval
// services, and the Effect startup layers. Importing those at module load would
// couple MCP server *registration* (which only needs tool metadata) to that
// whole graph — bloating boot and breaking any host that boots the server with
// a partial `db/internal` mock. So load them on first tool *invocation* and
// cache the module promise (ESM caches anyway; this just avoids re-awaiting).

type LifecycleModule = typeof import("@atlas/api/lib/datasources/mcp-lifecycle");
let lifecycleModule: Promise<LifecycleModule> | null = null;
const lifecycle = (): Promise<LifecycleModule> =>
  (lifecycleModule ??= import("@atlas/api/lib/datasources/mcp-lifecycle"));

// Every datasource tool is an admin surface — RBAC floor is `admin`.
const DATASOURCE_MIN_ROLE: AtlasRole = "admin";

// Catalog slug for the generic OpenAPI/REST datasource. A string literal (not an
// import from `@atlas/api/lib/openapi/catalog`) so registering these tools stays
// off the heavy openapi graph — the lib seam resolves it at invocation time.
const REST_CATALOG_SLUG = "openapi-generic";

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

/**
 * Bridge the profiler's per-table callbacks (#3506) to the MCP progress
 * reporter (#3500). `reporter.report` is async but progress notifications are
 * best-effort, so we fire-and-forget — a dropped notification must never
 * fail (or stall) the profiling work. No table data is sensitive; names are
 * already part of the generated whitelist the agent will query.
 *
 * The profiler has no native `AbortSignal`, so cancellation is COOPERATIVE:
 * `onTableStart` runs before each table (outside the profiler's per-table
 * try/catch), so throwing there when `signal` is aborted unwinds the profiling
 * loop and stops further work + the open connection — rather than letting it
 * run to completion in the background after the client cancelled.
 */
function makeProfileProgress(
  reporter: {
    report(progress: number, opts?: { total?: number; message?: string }): Promise<void>;
  },
  signal?: AbortSignal,
): ProfileProgressCallbacks {
  const fire = (progress: number, total: number, message: string) => {
    void reporter.report(progress, { total, message }).catch(() => {
      // intentionally ignored: progress is best-effort, never load-bearing.
    });
  };
  return {
    onStart: (total) => fire(0, total, `Profiling ${total} table${total === 1 ? "" : "s"}…`),
    onTableStart: () => {
      if (signal?.aborted) throw new OperationCancelledError();
    },
    onTableDone: (name, index, total) => fire(index + 1, total, `Profiled ${name}`),
    onTableError: (name, _error, index, total) =>
      fire(index + 1, total, `Skipped ${name} (profiling error)`),
    onComplete: () => {},
  };
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

  // Shared dispatch wrapper (#3602): OTel span → RequestContext (actor bind) →
  // rate-limit → the ADR-0016 gate order (0 billing → 1 action-policy → 2 scope
  // → 3 RBAC → 4 approval) → the tool body → typed error envelope. Identical
  // wiring to tools.ts / semantic-tools.ts — the contract lives once in
  // `mcp-dispatch.ts`. Gate 5 (inline confirm) for credential-bearing
  // provisioning is the masked-elicitation step inside `create_datasource`'s
  // body (#3499) — it needs the resolved workspace + tool args, so it lives in
  // the tool, not the wrapper.
  const { dispatch } = createMcpDispatch({
    actor,
    transport,
    workspaceId,
    deployMode,
    ...(clientId ? { clientId } : {}),
    ...(scopes ? { scopes } : {}),
  });

  // The bound workspace for governance + mutations. Unlike `workspaceId`
  // (which falls back to `actor.id` purely for OTel attribution when no org is
  // bound), this is the REAL workspace the dispatch gate keys on — so every
  // mutation operates on the same id the gate (and gate-1 kill-switch /
  // approval) evaluated. Mutating tools declare `requiresBoundOrg: true`, which
  // the dispatcher enforces ONCE (#3609) — a no-org session is refused with a
  // `forbidden` envelope before any mutating body runs, rather than silently
  // keyed on `actor.id`.
  const boundOrgId = actor.activeOrganizationId;

  /**
   * The bound workspace for a MUTATING tool body. The `requiresBoundOrg: true`
   * dispatch requirement (enforced once in `mcp-dispatch.ts`, #3609) guarantees
   * a bound workspace before the body runs, so this never throws in practice —
   * the throw is a defensive backstop for a future mutating tool that forgets to
   * declare `requiresBoundOrg`, and it keeps mutations and the dispatch gate on
   * ONE workspace identity (`actor.activeOrganizationId`).
   */
  function boundOrg(): string {
    if (!boundOrgId) {
      throw new Error(
        "Mutating datasource tool reached its body without a bound workspace — the requiresBoundOrg dispatch requirement is missing.",
      );
    }
    return boundOrgId;
  }

  /**
   * Shared masked-credential collection for the two create tools (#3547): run a
   * schema-driven masked form, map a client failure / decline to a typed block,
   * and defensively enforce required-field presence. The entered values travel
   * client→server only — they never enter a tool argument, the agent/LLM
   * context, a response, or a log. Returns the collected values or a renderable
   * block; the caller assembles the provision config from `values`.
   */
  type ProvisionFormField = {
    key: string;
    label: string;
    description?: string;
    required: boolean;
    secret: boolean;
    options?: readonly string[];
    default?: string;
  };
  async function collectMaskedConfig(
    orgId: string,
    fields: readonly ProvisionFormField[],
    message: string,
    signal: AbortSignal | undefined,
  ): Promise<{ ok: true; values: Record<string, string> } | { ok: false; block: CallToolResult }> {
    let elicited;
    try {
      elicited = await elicitMaskedForm(server, {
        principal: orgId,
        message,
        fields: fields.map((f) => ({
          name: f.key,
          title: f.label,
          ...(f.description ? { description: f.description } : {}),
          required: f.required,
          secret: f.secret,
          ...(f.options ? { options: f.options } : {}),
          ...(f.default !== undefined ? { default: f.default } : {}),
        })),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      // Elicitation unsupported by the client, or a state/secret error. Never
      // include any (never-yet-received) credential; surface a capability-shaped
      // message.
      return {
        ok: false,
        block: toEnvelopeResult(
          envelope(
            "validation_failed",
            `Could not securely collect the connection credentials: ${errorMessage(err, "elicitation failed")}.`,
            { hint: "Use an MCP client that supports masked form elicitation, or provision via the admin console." },
          ),
        ),
      };
    }
    if (elicited.action !== "accept") {
      return {
        ok: false,
        block: toEnvelopeResult(
          envelope(
            "validation_failed",
            `Datasource creation was ${elicited.action === "decline" ? "declined" : "cancelled"} — no configuration was provided.`,
          ),
        ),
      };
    }
    // Defense-in-depth: a non-spec-compliant client could `accept` with a
    // required field left blank, which would otherwise surface as a confusing
    // pre-flight "could not reach" error. Reject with an actionable,
    // field-named message instead. The compliant path is already covered —
    // `elicitMaskedForm` drops whitespace-only values (so absent keys are
    // caught by `!(f.key in values)`); the `.trim()` clause additionally
    // catches a present-but-empty string a non-compliant client may inject.
    const values = elicited.values;
    const missing = fields
      .filter((f) => f.required && (!(f.key in values) || values[f.key].trim().length === 0))
      .map((f) => f.label);
    if (missing.length > 0) {
      return {
        ok: false,
        block: toEnvelopeResult(
          envelope(
            "validation_failed",
            `Missing required field${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`,
            { hint: "Provide every required field in the secure prompt, then retry." },
          ),
        ),
      };
    }
    return { ok: true, values };
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
        { checksBilling: true, requiresWrite: false, requiresBoundOrg: false, minRole: DATASOURCE_MIN_ROLE },
        async () => {
          // Developer-mode view: these are admin tools (gate-3 requires admin),
          // and create_datasource lands a datasource as `draft` — a published
          // filter would hide it from the very tool the agent is told to use to
          // find it next. So surface drafts + published; `include_archived`
          // opts archived rows back in for restore discovery. All rows are
          // credential-free regardless of status.
          const all = await (await lifecycle()).listDatasources(workspaceId, "developer", {
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
        { checksBilling: true, requiresWrite: false, requiresBoundOrg: false, minRole: DATASOURCE_MIN_ROLE },
        async () => {
          if (!(await lifecycle()).isDatasourceRegistered(id)) {
            return toEnvelopeResult(
              envelope(
                "unknown_entity",
                `Datasource "${id}" is not registered (it may not exist or may be archived).`,
                { hint: "Call list_datasources to see configured, queryable datasources." },
              ),
            );
          }
          const health = await (await lifecycle()).testDatasource(id);
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
        {
          checksBilling: true,
          requiresWrite: true,
          requiresBoundOrg: true,
          minRole: DATASOURCE_MIN_ROLE,
          actionCategory: "datasource",
        },
        async () => archiveOrRestore(boundOrg(), id, "archive"),
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
        {
          checksBilling: true,
          requiresWrite: true,
          requiresBoundOrg: true,
          minRole: DATASOURCE_MIN_ROLE,
          actionCategory: "datasource",
        },
        async () => archiveOrRestore(boundOrg(), id, "restore"),
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
          checksBilling: true,
          requiresWrite: true,
          requiresBoundOrg: true,
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
          const orgId = boundOrg();
          // Resolve the catalog slug first so a non-existent id returns a
          // clean `unknown_entity` rather than an installer defect. (The
          // approval gate already ran in `dispatch`; reaching here means the
          // requester is approved or no rule matched.)
          const catalogSlug = await (await lifecycle()).resolveDatasourceCatalogSlug(orgId, id);
          if (catalogSlug === null) {
            return toEnvelopeResult(
              envelope("unknown_entity", `Datasource "${id}" not found.`, {
                hint: "Call list_datasources to see configured datasources.",
              }),
            );
          }
          // Hard delete (`hard: true`) — DELETEs the workspace_plugins row and
          // drains the pool. The reversible path is archive_datasource.
          const outcome = await (await lifecycle()).runDatasourceInstaller((installer) =>
            installer.uninstallDatasource(
              orgId as WorkspaceId,
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
            `Datasource type. Provisionable via MCP: ${MCP_PROVISIONABLE_CATALOG_SLUGS.join(", ")}. ` +
              `Connection details (URL / API key / service-account JSON, etc.) are collected separately via a secure masked prompt — never as tool arguments.`,
          ),
        install_id: datasourceIdSchema(
          "New datasource id (lowercase-led slug, e.g. 'prod-us'). Must be unique in the workspace.",
        ),
        description: z
          .string()
          .max(MAX_FILTER_LEN)
          .optional()
          .describe("Optional human-readable description (shown in the agent system prompt)."),
        schema: z
          .string()
          .max(MAX_ID_LEN)
          .optional()
          .describe(
            "Optional schema / search_path for SQL datasources (postgres/mysql/clickhouse). Non-secret routing hint — set here, not in the secure prompt.",
          ),
        group_id: z
          .string()
          .max(MAX_ID_LEN)
          .optional()
          .describe("Optional environment-group binding."),
      },
    },
    async ({ db_type, install_id, description, schema, group_id }, extra): Promise<CallToolResult> =>
      dispatch(
        "create_datasource",
        // Gate 0 billing + gate 1 (#3509) datasource kill-switch + mcp:write +
        // admin. NOT approval-gated (provisioning is additive, lands draft);
        // the human-in-the-loop is the masked credential entry below.
        {
          checksBilling: true,
          requiresWrite: true,
          requiresBoundOrg: true,
          minRole: DATASOURCE_MIN_ROLE,
          actionCategory: "datasource",
        },
        async (requestId) => {
          const orgId = boundOrg();
          const lib = await lifecycle();

          // Capability check BEFORE prompting for credentials — don't ask the
          // user for a connection we can't provision (unknown type, or a plugin
          // type with no plugin installed).
          const capability = await lib.resolveProvisionCapability(db_type);
          if (capability.kind === "unsupported") {
            return toEnvelopeResult(envelope("validation_failed", capability.message));
          }

          // Resolve the per-type credential field set from the catalog
          // config_schema (#3547 AC #4) so the masked form is schema-driven —
          // url-shaped (pg/mysql/clickhouse/snowflake), apiKey-shaped (ES), and
          // multi-field (BigQuery) all collect the right fields with zero
          // per-type code here.
          const fieldsResult = await lib.loadProvisionConfigFields(db_type);
          if (fieldsResult.kind !== "ok") {
            return toEnvelopeResult(
              envelope(
                "validation_failed",
                fieldsResult.kind === "not_found"
                  ? `Datasource type "${db_type}" is not configured in this workspace's catalog.`
                  : `The "${db_type}" datasource catalog is misconfigured; provisioning is unavailable. Use the admin console.`,
              ),
            );
          }

          // Collect every config field via MASKED form-mode elicitation (#3499),
          // schema-driven + required-field-checked by the shared helper.
          const collected = await collectMaskedConfig(
            orgId,
            fieldsResult.fields,
            `Enter the connection details for the ${db_type} datasource "${install_id}". They are sent securely and never shared with the agent.`,
            extra.signal,
          );
          if (!collected.ok) return collected.block;

          // `config` holds the secret + non-secret connection fields — used only
          // for the pre-flight probe + the installer's encrypt-at-rest path,
          // NEVER logged or returned. `description` (label) and `schema`
          // (search_path) are non-secret agent-set fields — they're tool args,
          // NOT elicited in the secure prompt — merged in here. `secretKeys`
          // drives the lib's error-scrub.
          const config: Record<string, unknown> = {
            ...collected.values,
            ...(description !== undefined ? { description } : {}),
            ...(schema !== undefined ? { schema } : {}),
          };

          const outcome = await lib.provisionDatasource(orgId, {
            catalogSlug: db_type,
            installId: install_id,
            config,
            secretKeys: fieldsResult.secretKeys,
            groupId: group_id ?? null,
          });

          switch (outcome.kind) {
            case "ok": {
              // Only masked (never plaintext) credential material is surfaced.
              // #3587 / #3552 / #3667 — the success hint must be CONDITIONAL on
              // whether `profile_datasource` can actually make the type queryable.
              // Since the URL-shape gate is gone (#3667 — profiling now rides the
              // unified `resolveLiveConnection`, so a connectable type is profilable
              // by construction), the capability predicate is a cheap (no connection
              // build) proxy for what `profile_datasource` accepts: native pg/mysql,
              // or a registered plugin that implements the profiling contract (incl.
              // non-url-shaped config-credential types like bigquery). NOTE: this
              // resolver checks the registry-level `connection.profile`, whereas
              // profile_datasource builds the connection and checks the BUILT
              // connection's `profile` — for every shipped plugin both are present,
              // so they agree; a (hypothetical) plugin exposing only one would let
              // the hint over-advertise. The four MCP plugins keep them in lockstep.
              // (OAuth datasources like Salesforce don't arrive via create_datasource.)
              const profileCap = await lib.resolveProfileCapabilityByDbType(outcome.value.dbType);
              const profilable = profileCap.kind !== "unsupported";
              return toJsonContent({
                id: outcome.value.installId,
                db_type: outcome.value.dbType,
                status: outcome.value.status,
                ...(outcome.value.maskedUrl ? { masked_url: outcome.value.maskedUrl } : {}),
                description: outcome.value.description,
                schema: outcome.value.schema,
                group_id: outcome.value.groupId,
                created: true,
                next: profilable
                  ? `Run profile_datasource with id "${outcome.value.installId}" to generate its semantic layer and make it queryable.`
                  : `Datasource "${outcome.value.installId}" is connected, but semantic-layer profiling for ${outcome.value.dbType} is not available in this deployment (no registered plugin implements the profiling contract). Install or upgrade the corresponding datasource plugin, or profile it with the Atlas CLI; the datasource will not be queryable until its semantic layer is generated.`,
              });
            }
            case "unsupported":
              return toEnvelopeResult(envelope("validation_failed", outcome.message));
            case "health_error":
              // Pre-flight failed — message is credential-scrubbed by the lib.
              return toEnvelopeResult(
                envelope("validation_failed", outcome.message, {
                  hint: "Verify the connection details and that the datasource is reachable, then retry.",
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

  // --- create_rest_datasource (mutate; OpenAPI spec + auth via masked form) ---
  server.registerTool(
    "create_rest_datasource",
    {
      title: "Create REST (OpenAPI) Datasource",
      description: withErrorContract(CREATE_REST_DATASOURCE_DESCRIPTION, DATASOURCE_WRITE_ERROR_CODES),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      inputSchema: {
        display_name: z
          .string()
          .max(MAX_FILTER_LEN)
          .optional()
          .describe("Optional friendly name shown in the connections UI (non-secret; set by you, not collected in the secure prompt)."),
      },
    },
    async ({ display_name }, extra): Promise<CallToolResult> =>
      dispatch(
        "create_rest_datasource",
        // Gate 0 billing + gate 1 kill-switch + mcp:write + admin. NOT
        // approval-gated — additive, the human-in-the-loop is the masked
        // spec-URL/credential entry below.
        {
          checksBilling: true,
          requiresWrite: true,
          requiresBoundOrg: true,
          minRole: DATASOURCE_MIN_ROLE,
          actionCategory: "datasource",
        },
        async (requestId) => {
          const orgId = boundOrg();
          const lib = await lifecycle();

          // The openapi-generic config_schema (spec URL + auth_kind + auth_value
          // + …) drives the masked form, exactly like the SQL types. Non-credential
          // fields (display_name, write_allowlist, …) are excluded from the secure
          // prompt by loadProvisionConfigFields; display_name comes from the arg.
          const fieldsResult = await lib.loadProvisionConfigFields(REST_CATALOG_SLUG);
          if (fieldsResult.kind !== "ok") {
            return toEnvelopeResult(
              envelope(
                "validation_failed",
                fieldsResult.kind === "not_found"
                  ? "The generic REST (OpenAPI) datasource is not available in this workspace's catalog."
                  : "The REST datasource catalog is misconfigured; provisioning is unavailable. Use the admin console.",
              ),
            );
          }

          // Collect spec URL + auth (the credential among them) via the masked
          // form — values travel client→server only, never into agent context.
          const collected = await collectMaskedConfig(
            orgId,
            fieldsResult.fields,
            `Enter the OpenAPI spec URL and authentication for the new REST datasource. Sent securely and never shared with the agent.`,
            extra.signal,
          );
          if (!collected.ok) return collected.block;

          // The handler probes the spec on install (no separate pre-flight): a
          // bad URL / auth / unreachable spec comes back as `validation`,
          // secret-scrubbed, with nothing persisted. `display_name` is the
          // agent-set label (non-secret), merged in alongside the elicited config.
          const outcome = await lib.provisionRestDatasource(
            orgId,
            { ...collected.values, ...(display_name !== undefined ? { display_name } : {}) },
            fieldsResult.secretKeys,
          );
          if (outcome.kind === "validation") {
            return toEnvelopeResult(
              envelope("validation_failed", outcome.message, {
                hint: "Check the OpenAPI spec URL, the auth type/credential, and that the spec is reachable, then retry.",
                request_id: requestId,
              }),
            );
          }
          return toJsonContent({
            id: outcome.installId,
            created: true,
            kind: "rest",
            next: "The REST datasource is installed and its operations are available to the agent. It is read-only by default; configure any write allowlist via the admin console.",
          });
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
        {
          checksBilling: true,
          requiresWrite: true,
          requiresBoundOrg: true,
          minRole: DATASOURCE_MIN_ROLE,
          actionCategory: "datasource",
        },
        async () => {
          const orgId = boundOrg();
          // #3667 — ONE RESOLVER. Profiling rides the SAME connection resolution
          // querying uses (registry / createFromConfig / OAuth LazyPluginLoader);
          // there is no URL-shape gate to fail closed. The live connection carries
          // its own creds — only the connectionId + progress counts surface here.
          const resolved = await (await lifecycle()).resolveLiveConnection(orgId, id);
          if (resolved.kind === "not_found") {
            return toEnvelopeResult(
              envelope("unknown_entity", `Datasource "${id}" not found.`, {
                hint: "Call list_datasources to see configured datasources.",
              }),
            );
          }
          if (resolved.kind === "unsupported") {
            // No transport builds a profilable live connection for this type (no
            // plugin / no `connection.profile`). `message` is actionable + secret-free.
            return toEnvelopeResult(envelope("validation_failed", resolved.message));
          }
          if (resolved.kind === "reconnect_required") {
            // An OAuth datasource (Salesforce) whose tokens are stale/revoked —
            // surface the specific reconnect prompt, not a silent failure (#3667).
            return toEnvelopeResult(envelope("validation_failed", resolved.message));
          }

          const connection = resolved.connection;
          // Long-running: report per-table progress and honor client cancellation
          // (#3500). The profiler has no native AbortSignal, so cancellation is
          // cooperative: the progress bridge checks `signal` between tables and
          // aborts the loop, while `withProgressAndCancellation` also severs the
          // await immediately on the client's cancel. We own the connection
          // lifecycle — close it once profiling settles (a throwaway plugin
          // connection is torn down; a registry/OAuth connection close is a no-op).
          let result: Awaited<ReturnType<LifecycleModule["profileLiveDatasource"]>>;
          try {
            result = await withProgressAndCancellation(
              extra,
              { startMessage: `Profiling datasource "${id}"`, endMessage: "Semantic layer generated" },
              async (reporter, signal) => {
                const progress = makeProfileProgress(reporter, signal);
                return (await lifecycle()).profileLiveDatasource({
                  connection,
                  connectionId: id,
                  // #3546 — persist the generated layer to the org store as drafts
                  // so the whitelist survives a restart and is visible to the API
                  // process (web `/chat`), not just this MCP process.
                  orgId,
                  progress,
                });
              },
            );
          } finally {
            await connection.close().catch(() => {
              // intentionally ignored: best-effort teardown of the profiling
              // connection — a close failure must not mask the profile result.
            });
          }

          if (result.kind === "reconnect_required") {
            // #3667 — an OAuth token (Salesforce) revoked mid-profile, after the
            // connection resolved. Surface the SAME actionable reconnect prompt
            // the resolution-time reconnect path does, not a bare "Profiling
            // failed" — never a silent failure.
            return toEnvelopeResult(envelope("validation_failed", result.message));
          }
          if (result.kind === "error") {
            // Tagged ProfilingFailedError — an agent-actionable validation
            // outcome (no tables, too many failures, persist failure), not a 500.
            return toEnvelopeResult(envelope("validation_failed", result.message));
          }

          const r = result.result;
          const tables = r.entities.map((e) => e.table);
          // `persisted` is non-null when the layer was durably written (org
          // bound + internal DB). Drafts are queryable in developer mode now and
          // go live to published `/chat` when an admin runs the publish flow.
          const persisted = result.persisted !== null;
          return toJsonContent({
            id,
            queryable: true,
            persisted,
            ...(persisted
              ? {
                  persisted_status: "draft",
                  publish_hint:
                    "Generated entities are saved as drafts. Run the admin publish flow to make them queryable from the published /chat surface; they are queryable now in developer mode.",
                }
              : {}),
            entities_generated: r.entities.length,
            metrics_generated: r.metrics.length,
            tables,
            profiling_errors: r.errors.length,
            // Honest partial-success signal: some tables failed introspection
            // but stayed under the fatal threshold, so the layer persisted with
            // those tables ABSENT. `profiling_errors` alone reads as a side
            // note next to an unconditional success; `incomplete` makes the
            // degraded layer unmissable to the MCP client before it publishes.
            // When persisted, this transient flag is also recorded DURABLY in
            // `semantic_profile_status` (#3682) so the publish flow surfaces it
            // even after a restart / from the web `/chat` process.
            incomplete: r.errors.length > 0,
            // The specific tables that are NOT queryable — name them so the
            // client/agent can tell the user exactly what is missing rather than
            // just a count. Errors are DSN-scrubbed upstream.
            ...(r.errors.length > 0
              ? { incomplete_tables: r.errors.map((e) => e.table) }
              : {}),
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
    orgId: string,
    id: string,
    action: "archive" | "restore",
  ): Promise<CallToolResult> {
    const catalogSlug = await (await lifecycle()).resolveDatasourceCatalogSlug(orgId, id);
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
      const outcome = await (await lifecycle()).runDatasourceInstaller((installer) =>
        installer.uninstallDatasource(orgId as WorkspaceId, catalogSlug, id),
      );
      if (outcome.kind === "error") return installerErrorToEnvelope(outcome, id);
      return toJsonContent({ id, status: "archived", archived: true });
    }

    // Revive to "draft" mirroring the admin route (admin-connections.ts
    // #944-960, #2177): the restored connection must still go through the
    // atomic publish endpoint before it is queryable from /chat. Setting
    // "published" here bypasses the content-mode gate (CLAUDE.md rule).
    const outcome = await (await lifecycle()).runDatasourceInstaller((installer) =>
      installer.updateDatasourceConfig(orgId as WorkspaceId, catalogSlug, id, {
        status: "draft",
        atlasMode: "draft",
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

const RESTORE_DATASOURCE_DESCRIPTION = `Restore (un-archive) a previously archived datasource. The connection is revived as a \`draft\` (same as a freshly-created datasource) so an admin can review it before it becomes queryable via the atomic publish endpoint (\`/api/v1/admin/publish\`). Requires the \`mcp:write\` scope and the admin role. Example call: \`{ "id": "prod-us" }\`. Example response: \`{ "id": "prod-us", "status": "draft", "restored": true }\`.`;

const DELETE_DATASOURCE_DESCRIPTION = `Permanently delete a datasource — removes the configuration and drains the pool. IRREVERSIBLE (use archive_datasource for a recoverable disable). Destructive: requires the \`mcp:write\` scope and the admin role, and routes through the workspace approval flow when an origin=mcp approval rule requires it (the response then carries \`approval_required: true\` with an \`approval_request_id\` to follow up on). Example call: \`{ "id": "old-staging" }\`. Example success: \`{ "id": "old-staging", "deleted": true }\`.`;

const CREATE_DATASOURCE_DESCRIPTION = `Provision a NEW datasource for this workspace. Supported types: postgres, mysql, clickhouse, snowflake, bigquery, elasticsearch/opensearch (plugin types require the corresponding datasource plugin to be installed). You supply only non-secret fields — \`db_type\`, \`install_id\`, optional \`description\`/\`group_id\`. ALL connection details (URL, API key, service-account JSON, etc.) are collected SEPARATELY via a secure masked prompt to the user; they are never passed as tool arguments and never shared with you. The connection is tested BEFORE it is persisted (a failed probe persists nothing), and lands as a \`draft\` — run profile_datasource next to make it queryable. Requires the \`mcp:write\` scope and the admin role. Example call: \`{ "db_type": "clickhouse", "install_id": "prod-us" }\`. Example success: \`{ "id": "prod-us", "db_type": "clickhouse", "status": "draft", "masked_url": "clickhouse://***@…", "created": true }\`.`;

const CREATE_REST_DATASOURCE_DESCRIPTION = `Provision a NEW generic REST datasource from an OpenAPI 3.x spec for this workspace. You may pass an optional non-secret \`display_name\`; the spec URL, authentication type, and credential are ALL collected via a secure masked prompt to the user — they are never passed as tool arguments and never shared with you. The spec is fetched + validated BEFORE anything is persisted (a failed probe persists nothing). On success the API's operations become available to the agent; it is read-only by default (any write allowlist is configured via the admin console). Use this instead of create_datasource for HTTP/REST APIs (Stripe, GitHub, an internal service); use create_datasource for SQL databases. Requires the \`mcp:write\` scope and the admin role. Example success: \`{ "id": "<install-id>", "created": true, "kind": "rest" }\`.`;

const PROFILE_DATASOURCE_DESCRIPTION = `Profile a datasource (introspect its tables) and generate its semantic layer — entities + the table whitelist — so the agent can query it with executeSQL. Long-running: emits progress per table and is cancellable. Typically run right after create_datasource. Requires the \`mcp:write\` scope and the admin role. Example call: \`{ "id": "prod-us" }\`. Example success: \`{ "id": "prod-us", "queryable": true, "entities_generated": 12, "tables": ["orders", "users"], "elapsed_ms": 1840 }\`.`;

// Read tools: not-found surfaces as `unknown_entity`; everything else as
// `internal_error`. RBAC denial (gate 3) surfaces as `forbidden`.
const DATASOURCE_READ_ERROR_CODES = [
  "unknown_entity",
  "forbidden",
  "rate_limited",
  "internal_error",
] as const;

// Write/destructive tools advertise the read codes PLUS `validation_failed`
// (bad id / installer rejection / pre-flight health failure / declined
// elicitation) — derived from the read set so a new baseline code can't be
// added to one and forgotten on the other. The approval-required outcome is
// NOT an error code — it's a non-error JSON body the agent must surface, per
// the dispatch-gate contract.
const DATASOURCE_WRITE_ERROR_CODES = [
  ...DATASOURCE_READ_ERROR_CODES,
  "validation_failed",
] as const;
