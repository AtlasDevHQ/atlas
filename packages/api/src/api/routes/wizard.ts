/**
 * Semantic layer setup wizard API routes.
 *
 * Mounted at /api/v1/wizard. Requires admin role.
 * Powers the guided semantic layer setup UI — a web replacement for `atlas init`.
 *
 * Flow: profile → generate → preview → save
 *
 * 1. POST /profile — List tables/views from a connected datasource
 * 2. POST /generate — Profile selected tables + generate entity YAML
 * 3. POST /preview — Preview agent behavior with generated entities
 * 4. POST /save — Persist entities to org-scoped semantic layer
 */

import * as fs from "fs";
import * as path from "path";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext, AuthContext, ModelRouter } from "@atlas/api/lib/effect/services";
import { runEnterprise } from "@atlas/api/lib/effect/enterprise-layer";
import { HTTPException } from "hono/http-exception";
import { createLogger } from "@atlas/api/lib/logger";
import { validationHook } from "./validation-hook";
import { connections } from "@atlas/api/lib/db/connection";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { _resetWhitelists, invalidateOrgWhitelist } from "@atlas/api/lib/semantic";
import {
  bulkUpsertEntities,
  resolveGroupIdForConnection,
  upsertProfileStatus,
} from "@atlas/api/lib/semantic/entities";
import { syncEntityToDisk } from "@atlas/api/lib/semantic/sync";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { adminAuth, requestContext, type AuthEnv } from "./middleware";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import {
  type ProfilingResult,
  OBJECT_TYPES,
  FK_SOURCES,
  PARTITION_STRATEGIES,
  SEMANTIC_TYPES,
  outputDirForGroup,
} from "@atlas/api/lib/profiler";
// One profiler home (#3657, ADR-0017 §Amendment(#3667)): the wizard resolves a
// LIVE connection via the SAME resolver MCP uses — `resolveLiveConnection`,
// surfaced as `resolveProfilingConnection` (shared with the agent's
// `profileTable` tool since #4197). Introspection
// (`listObjects` / `profile`) is a capability OF that connection, bound to the
// creds that built it — there is no second profiler seam, no url/config
// threading, and no per-call native signature adaptation. The only rejections
// are the actionable not-found / not-profilable / reconnect-required states.
import { resolveProfilingConnection } from "@atlas/api/lib/datasources/profiling-connection";
// Mechanical generation runs through the shared semantic engine (issue #3233)
// so the wizard and the CLI emit identical YAML. Both the `/generate` entity
// YAML and the `/save` catalog/glossary/metric assembly delegate to
// `generateSemanticLayer` (#3529) — the same shared core the CLI and the
// `SemanticGenerator` service use (#3506) — so the three can't drift.
import {
  analyzeTableProfiles,
  generateSemanticLayer,
} from "@atlas/api/lib/semantic/generate";
import { SAFE_TABLE_NAME, safeSemanticRowName } from "@atlas/api/lib/semantic/shapes";
// Phase-2 enrichment is the same shared engine (issue #3236, § D); the in-memory
// variant lets the wizard enrich a YAML string per table without touching disk.
import { enrichEntityYaml } from "@atlas/api/lib/semantic/enrich";
import { refreshGroupAutoDescription } from "@atlas/api/lib/source-catalog/lookup";
// #3437 / #4489 — the wizard's Phase-2 enrich spends platform LLM tokens, so it
// consults the same shared billing gate as every other agent surface before the
// spend and meters the result against the workspace token budget afterwards.
import { checkAgentBillingGate } from "@atlas/api/lib/billing/agent-gate";
import { logUsageEvent } from "@atlas/api/lib/metering";
import { toOutputEquivalentTokens } from "@atlas/api/lib/billing/token-weighting";
import {
  getModel,
  getMissingModelConfig,
  getModelFromWorkspaceConfig,
} from "@atlas/api/lib/providers";

const log = createLogger("wizard");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ProfileRequestSchema = z.object({
  connectionId: z.string().min(1),
});

const ProfileResponseSchema = z.object({
  connectionId: z.string(),
  dbType: z.string(),
  schema: z.string(),
  tables: z.array(z.record(z.string(), z.unknown())),
});

const GenerateRequestSchema = z.object({
  connectionId: z.string().min(1),
  tables: z.array(z.string()).min(1),
});

const WizardEntityColumnSchema = z.object({
  name: z.string(),
  type: z.string(),
  mappedType: z.string().optional(),
  nullable: z.boolean(),
  isPrimaryKey: z.boolean(),
  isForeignKey: z.boolean(),
  isEnumLike: z.boolean(),
  semanticType: z.enum(SEMANTIC_TYPES).optional(),
  sampleValues: z.array(z.string()),
  uniqueCount: z.number().nullable(),
  nullCount: z.number().nullable(),
});

const WizardForeignKeySchema = z.object({
  fromColumn: z.string(),
  toTable: z.string(),
  toColumn: z.string(),
  source: z.enum(FK_SOURCES),
});

const WizardInferredForeignKeySchema = z.object({
  fromColumn: z.string(),
  toTable: z.string(),
  toColumn: z.string(),
});

const WizardEntityResultSchema = z.object({
  tableName: z.string(),
  objectType: z.enum(OBJECT_TYPES),
  rowCount: z.number(),
  columnCount: z.number(),
  yaml: z.string(),
  profile: z.object({
    columns: z.array(WizardEntityColumnSchema),
    primaryKeys: z.array(z.string()),
    foreignKeys: z.array(WizardForeignKeySchema),
    inferredForeignKeys: z.array(WizardInferredForeignKeySchema),
    flags: z.object({
      possiblyAbandoned: z.boolean(),
      possiblyDenormalized: z.boolean(),
    }),
    notes: z.array(z.string()),
  }),
});

const GenerateResponseSchema = z.object({
  connectionId: z.string(),
  dbType: z.string(),
  schema: z.string(),
  entities: z.array(WizardEntityResultSchema),
  errors: z.array(z.object({ table: z.string(), error: z.string() })),
});

// Phase-2 enrichment is per-table (issue #3236): the frontend fires one request
// per chosen table so results stream in and upgrade each row in place. `yaml` is
// the current (baseline or hand-edited) YAML the LLM enriches and merges into.
const EnrichRequestSchema = z.object({
  connectionId: z.string().min(1),
  tableName: z.string().min(1),
  yaml: z.string().min(1),
});

const EnrichResponseSchema = z.object({
  tableName: z.string(),
  // The enriched YAML, or the unchanged baseline when the model returned an
  // unusable response (`enriched: false`). Either way it's safe to save.
  yaml: z.string(),
  enriched: z.boolean(),
});

const PreviewRequestSchema = z.object({
  question: z.string().min(1),
  entities: z.array(z.object({ tableName: z.string(), yaml: z.string() })).min(1),
});

const PreviewResponseSchema = z.record(z.string(), z.unknown());

/**
 * Zod schema for a column profile (snake_case wire format).
 * Keep in sync with ColumnProfile from @useatlas/types.
 */
const ColumnProfileSchema = z.object({
  name: z.string(),
  type: z.string(),
  nullable: z.boolean(),
  unique_count: z.number().nullable(),
  null_count: z.number().nullable(),
  sample_values: z.array(z.string()),
  is_primary_key: z.boolean(),
  is_foreign_key: z.boolean(),
  fk_target_table: z.string().nullable(),
  fk_target_column: z.string().nullable(),
  is_enum_like: z.boolean(),
  semantic_type: z.enum(SEMANTIC_TYPES).optional(),
  profiler_notes: z.array(z.string()),
}).refine(
  (col) => !col.is_foreign_key || (col.fk_target_table !== null && col.fk_target_column !== null),
  { message: "fk_target_table and fk_target_column must be non-null when is_foreign_key is true" },
);

/**
 * Zod schema for a foreign key.
 * Keep in sync with ForeignKey from @useatlas/types.
 */
const ForeignKeySchema = z.object({
  from_column: z.string().min(1),
  to_table: z.string().min(1),
  to_column: z.string().min(1),
  source: z.enum(FK_SOURCES),
});

/**
 * Zod schema for a table profile (snake_case wire format).
 * Derived from const tuples in @useatlas/types — no manual enum sync needed.
 */
const TableProfileSchema = z.object({
  table_name: z.string(),
  object_type: z.enum(OBJECT_TYPES),
  row_count: z.number(),
  columns: z.array(ColumnProfileSchema),
  primary_key_columns: z.array(z.string()),
  foreign_keys: z.array(ForeignKeySchema),
  inferred_foreign_keys: z.array(ForeignKeySchema),
  profiler_notes: z.array(z.string()),
  table_flags: z.object({
    possibly_abandoned: z.boolean(),
    possibly_denormalized: z.boolean(),
  }),
  matview_populated: z.boolean().optional(),
  partition_info: z.object({
    strategy: z.enum(PARTITION_STRATEGIES),
    key: z.string(),
    children: z.array(z.string()),
  }).optional(),
});

const SaveRequestSchema = z.object({
  connectionId: z.string().min(1),
  entities: z.array(z.object({ tableName: z.string(), yaml: z.string() })).min(1),
  schema: z.string().optional(),
  // Datasource dbType for the server-side metric branch (raw `profiles`
  // submissions). Drives dbType-aware `main` qualification so metric `FROM`
  // matches the pre-generated entity `table:` (issue #3252). Omitted by the
  // wizard frontend, which never sends `profiles`; defaults to "postgres".
  dbType: z.string().optional(),
  profiles: z.array(TableProfileSchema).optional(),
  // #3682 — the per-table profiling failures the `/generate` step returned, plus
  // the total tables ATTEMPTED. Forwarded by the wizard so a sub-threshold
  // partial profile is durably marked incomplete (`semantic_profile_status`),
  // visible to the publish flow. Optional: a client that omits them skips the
  // marker (no behaviour change). An empty `failedTables` records completeness,
  // which CLEARS a prior partial marker after a clean re-profile.
  failedTables: z.array(z.object({ table: z.string(), error: z.string() })).optional(),
  totalTables: z.number().int().nonnegative().optional(),
});

const SaveResponseSchema = z.object({
  saved: z.boolean(),
  orgId: z.string().nullable(),
  connectionId: z.string(),
  entityCount: z.number(),
  files: z.array(z.string()),
  warnings: z
    .array(
      z.object({
        kind: z.enum(["disk_sync_failed"]),
        tableName: z.string(),
        reason: z.string(),
      }),
    )
    .optional(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const profileRoute = createRoute({
  method: "post",
  path: "/profile",
  tags: ["Wizard"],
  summary: "List tables from a connected datasource",
  description:
    "Discovers tables, views, and materialized views in a connected database for the wizard table selection step. " +
    "Supports PostgreSQL and MySQL natively, plus any datasource whose plugin implements the profiling contract " +
    "(connection.listObjects). Requires admin role.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: ProfileRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Table list from the connected datasource",
      content: { "application/json": { schema: ProfileResponseSchema } },
    },
    400: {
      description: "Invalid request (missing connectionId, or the datasource's plugin doesn't implement profiling)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Connection not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Connection resolution or profiling failed",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const generateRoute = createRoute({
  method: "post",
  path: "/generate",
  tags: ["Wizard"],
  summary: "Profile tables and generate entity YAML",
  description:
    "Profiles selected tables from a connected datasource and generates entity YAML definitions " +
    "with dimensions, measures, joins, query patterns, and heuristic flags. Requires admin role.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: GenerateRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Generated entity YAML definitions with profiling metadata",
      content: { "application/json": { schema: GenerateResponseSchema } },
    },
    400: {
      description: "Invalid request (missing connectionId, empty tables, or the datasource's plugin doesn't implement profiling)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Connection not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Profiling or generation failed",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const enrichRoute = createRoute({
  method: "post",
  path: "/enrich",
  tags: ["Wizard"],
  summary: "LLM-enrich a single table's entity YAML",
  description:
    "Phase 2 of two-phase generate (issue #3236): re-profiles one table for fresh DB grounding, " +
    "then runs an LLM over its mechanical baseline YAML to add business descriptions, use cases, " +
    "query patterns, and virtual dimensions. Per-table by design so the wizard can stream results " +
    "in and upgrade each row in place. Never fires automatically — the UI gates it behind an explicit " +
    "Enrich all / Enrich selected action. Requires admin role and a configured LLM provider.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: EnrichRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Enriched entity YAML (or the unchanged baseline if the model returned no usable output)",
      content: { "application/json": { schema: EnrichResponseSchema } },
    },
    400: {
      description: "Invalid request (missing fields, or the datasource's plugin doesn't implement profiling)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description:
        "Forbidden — admin role required, or blocked by billing enforcement " +
        "(#3437/#4489 — workspace suspended/deleted, trial expired, or subscription ended)",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Connection not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description:
        "Rate limit exceeded, or blocked by billing enforcement " +
        "(#3437/#4489 — plan token budget exceeded, or abuse throttle carrying Retry-After)",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    503: {
      description:
        "Enrichment unavailable — no LLM provider configured, or billing enforcement " +
        "could not verify billing/workspace status (fail-closed, retryable)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Profiling or enrichment failed",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const previewRoute = createRoute({
  method: "post",
  path: "/preview",
  tags: ["Wizard"],
  summary: "Preview agent behavior with entities",
  description:
    "Shows how the agent would interpret the semantic layer when answering a question, " +
    "given a set of candidate entity YAML definitions. Requires admin role.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: PreviewRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Preview of how the agent would see the semantic layer",
      content: { "application/json": { schema: PreviewResponseSchema } },
    },
    400: {
      description: "Invalid request (missing question or entities)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const saveRoute = createRoute({
  method: "post",
  path: "/save",
  tags: ["Wizard"],
  summary: "Save entities to org-scoped semantic layer",
  description:
    "Persists generated entity YAML files to the organization's semantic layer directory on disk. " +
    "Validates table names for path traversal, syncs to the internal database if available, " +
    "and resets the semantic whitelist cache. Requires admin role and an active organization.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: SaveRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Entities saved to disk",
      content: { "application/json": { schema: SaveResponseSchema } },
    },
    400: {
      description: "Invalid request (missing connectionId, empty entities, invalid table name, or no active organization)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Failed to save entities",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const wizard = new OpenAPIHono<AuthEnv>({
  defaultHook: validationHook,
});

wizard.use(adminAuth);
wizard.use(requestContext);

wizard.onError((err, c) => {
  if (err instanceof HTTPException) {
    // Middleware-thrown HTTPExceptions carry a JSON Response
    if (err.res) return err.res;
    // Framework 400 for malformed JSON
    if (err.status === 400) {
      return c.json({ error: "invalid_request", message: "Invalid JSON body." }, 400);
    }
  }
  throw err;
});

// ---------------------------------------------------------------------------
// POST /profile — List tables/views from a connected datasource
// ---------------------------------------------------------------------------

wizard.openapi(profileRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    const { connectionId } = c.req.valid("json");

    // One resolver, shared with MCP: resolve a LIVE connection whose
    // introspection is bound to its creds. Throws only on infrastructure errors.
    const ctxResult = yield* Effect.tryPromise({
      try: () => resolveProfilingConnection(connectionId, user?.activeOrganizationId),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(Effect.either);

    if (ctxResult._tag === "Left") {
      const err = ctxResult.left;
      log.error({ err, requestId, connectionId }, "Failed to resolve connection");
      return c.json({
        error: "connection_resolution_failed",
        message: "Failed to resolve connection. Check server logs for details.",
        requestId,
      }, 500);
    }
    const ctx = ctxResult.right;
    if (ctx.kind === "not_found") {
      return c.json({ error: "not_found", message: `Connection "${connectionId}" not found.` }, 404);
    }
    if (ctx.kind === "unsupported") {
      return c.json({ error: "not_profilable", message: ctx.message }, 400);
    }
    if (ctx.kind === "reconnect_required") {
      return c.json({ error: "reconnect_required", message: ctx.message }, 400);
    }

    const { connection, dbType, querySchema } = ctx;

    const profileResult = yield* Effect.tryPromise({
      try: async () => {
        try {
          // Introspection rides the resolved connection — bound to its creds, so
          // a separate-field-credential plugin (ES) enumerates with the tenant's
          // own creds with no url/config threading. `querySchema` scopes the
          // enumeration (pg → "public"; plugin → its own default when undefined).
          const objects = await connection.listObjects({
            ...(querySchema !== undefined ? { schema: querySchema } : {}),
            logger: log,
          });
          return { ok: true as const, objects };
        } finally {
          // The built connection holds a real (lazy) pool — close it after
          // enumeration. Native pg/mysql + registry-managed pools no-op.
          // A close failure can't fail the request (enumeration already
          // settled), but it mustn't be swallowed silently either: log it so a
          // pool leak during onboarding is visible (CLAUDE.md: no empty catch).
          await connection.close().catch((closeErr) =>
            log.warn(
              { err: closeErr instanceof Error ? closeErr.message : String(closeErr), requestId, connectionId },
              "Wizard profile: connection close after enumeration failed",
            ),
          );
        }
      },
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(Effect.either);

    if (profileResult._tag === "Left") {
      const err = profileResult.left;
      // Keep the raw driver error in the logs; the client gets a sanitized
      // message + requestId. The converged resolver routes EVERY datasource
      // type (ClickHouse, Snowflake, BigQuery, ES, Salesforce, native pg/mysql)
      // through here, and a driver connection error can embed host/port or DSN
      // userinfo — never echo `err.message` to the client (CLAUDE.md: no
      // connection strings / stack traces in responses), mirroring the MCP
      // path's secret-scrubbing and the /enrich route below.
      log.error({ err, requestId, connectionId }, "Wizard profile failed");
      return c.json({
        error: "profile_failed",
        message: "Failed to list tables. Please retry; if it persists, check the connection settings and server logs.",
        requestId,
      }, 500);
    }

    const profileData = profileResult.right;

    log.info({ requestId, connectionId, dbType, tableCount: profileData.objects.length }, "Wizard profile complete");

    return c.json({
      connectionId,
      dbType,
      // Stable wire shape: surface the effective schema, falling back to "public"
      // for a plugin with no configured schema (placeholder only — enumeration
      // above used `undefined` so the plugin applied its own default).
      schema: querySchema ?? "public",
      tables: profileData.objects.map((o) => ({
        name: o.name,
        type: o.type,
      })),
    }, 200);
  }), { label: "wizard profile" });
});

// ---------------------------------------------------------------------------
// POST /generate — Profile selected tables and generate entity YAML
// ---------------------------------------------------------------------------

wizard.openapi(generateRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    const { connectionId, tables: tableNames } = c.req.valid("json");

    const ctxResult = yield* Effect.tryPromise({
      try: () => resolveProfilingConnection(connectionId, user?.activeOrganizationId),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(Effect.either);

    if (ctxResult._tag === "Left") {
      const err = ctxResult.left;
      log.error({ err, requestId, connectionId }, "Failed to resolve connection");
      return c.json({
        error: "connection_resolution_failed",
        message: "Failed to resolve connection. Check server logs for details.",
        requestId,
      }, 500);
    }
    const ctx = ctxResult.right;
    if (ctx.kind === "not_found") {
      return c.json({ error: "not_found", message: `Connection "${connectionId}" not found.` }, 404);
    }
    if (ctx.kind === "unsupported") {
      return c.json({ error: "not_profilable", message: ctx.message }, 400);
    }
    if (ctx.kind === "reconnect_required") {
      return c.json({ error: "reconnect_required", message: ctx.message }, 400);
    }

    const { connection, dbType, querySchema } = ctx;

    const genResult = yield* Effect.tryPromise({
      try: async () => {
        // Profile through the resolved live connection — introspection bound to
        // its creds, so a separate-field-credential plugin (ES) profiles with the
        // tenant's own creds with no url/config threading. `querySchema` scopes
        // it (pg → "public"; plugin → its own default when undefined).
        let result: ProfilingResult;
        try {
          result = await connection.profile({
            ...(querySchema !== undefined ? { schema: querySchema } : {}),
            selectedTables: tableNames,
            logger: log,
          });
        } finally {
          // Profiling is done; generation below is pure. Release the built
          // connection's pool now (native pg/mysql + registry pools no-op).
          // Log (don't swallow) a close failure so a pool leak is visible
          // without failing the request (CLAUDE.md: no empty catch).
          await connection.close().catch((closeErr) =>
            log.warn(
              { err: closeErr instanceof Error ? closeErr.message : String(closeErr), requestId, connectionId },
              "Wizard generate: connection close after profiling failed",
            ),
          );
        }

        // Run heuristics (returns new array — no mutation)
        const analyzedProfiles = analyzeTableProfiles(result.profiles);

        // Scope the generated YAML by the Connection group the connection
        // belongs to (ADR-0012 / #3234), not the raw connectionId — so the
        // emitted group field matches the groups/<group>/ directory the
        // matching /save writes into. A standalone datasource is a
        // group-of-one; the default/unknown connection resolves to the NULL
        // default group, which emits no group field (flat root). Best-effort:
        // /generate is a preview, so a group-lookup hiccup degrades to no
        // group field rather than failing the whole generate (/save resolves
        // the group authoritatively and fails closed there).
        let connectionGroupId: string | null = null;
        if (user?.activeOrganizationId) {
          try {
            connectionGroupId = await resolveGroupIdForConnection(user.activeOrganizationId, connectionId);
          } catch (err) {
            log.warn(
              { err: err instanceof Error ? err.message : String(err), requestId, connectionId },
              "Wizard generate: connection-group resolution failed — previewing without a group field",
            );
          }
        }
        const sourceId = connectionGroupId ?? undefined;

        // Entity YAML goes through the shared engine (#3529) so the wizard
        // preview, the CLI, and the SemanticGenerator service emit identical
        // YAML — only the preview-metadata wrapper below stays wizard-local.
        // Pair the returned artifact to its profile by table name rather than by
        // position: `generateSemanticLayer` emits one entity per profile today,
        // but keying on `table` keeps the wrapper correct even if the engine
        // ever reorders or filters artifacts (as it already does for metrics),
        // instead of silently mis-pairing YAML with the wrong metadata.
        const generated = generateSemanticLayer(analyzedProfiles, {
          dbType,
          ...(querySchema !== undefined ? { schema: querySchema } : {}),
          sourceId,
        });
        const entityYamlByTable = new Map(generated.entities.map((e) => [e.table, e.yaml]));
        const entities = analyzedProfiles.map((profile) => {
          const entityYaml = entityYamlByTable.get(profile.table_name);
          if (entityYaml === undefined) {
            // The shared core guarantees an entity per profile; a miss means its
            // contract changed under us. Fail loud (→ 500 generate_failed with a
            // requestId) rather than emit a preview row with empty/wrong YAML.
            throw new Error(
              `Shared semantic engine produced no entity YAML for table "${profile.table_name}"`,
            );
          }
          return {
            tableName: profile.table_name,
            objectType: profile.object_type,
            rowCount: profile.row_count,
            columnCount: profile.columns.length,
            yaml: entityYaml,
            profile: {
              columns: profile.columns.map((col) => ({
                name: col.name,
                type: col.type,
                mappedType: col.is_enum_like ? "enum" : undefined,
                nullable: col.nullable,
                isPrimaryKey: col.is_primary_key,
                isForeignKey: col.is_foreign_key,
                isEnumLike: col.is_enum_like,
                semanticType: col.semantic_type,
                sampleValues: col.sample_values.slice(0, 5),
                uniqueCount: col.unique_count,
                nullCount: col.null_count,
              })),
              primaryKeys: profile.primary_key_columns,
              foreignKeys: profile.foreign_keys.map((fk) => ({
                fromColumn: fk.from_column,
                toTable: fk.to_table,
                toColumn: fk.to_column,
                source: fk.source,
              })),
              inferredForeignKeys: profile.inferred_foreign_keys.map((fk) => ({
                fromColumn: fk.from_column,
                toTable: fk.to_table,
                toColumn: fk.to_column,
              })),
              flags: {
                possiblyAbandoned: profile.table_flags.possibly_abandoned,
                possiblyDenormalized: profile.table_flags.possibly_denormalized,
              },
              notes: profile.profiler_notes,
            },
          };
        });

        return { ok: true as const, analyzedProfiles, entities, errors: result.errors };
      },
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(Effect.either);

    if (genResult._tag === "Left") {
      const err = genResult.left;
      // Sanitized client message + requestId; raw driver detail stays in the
      // logs. Same reasoning as /profile above — the converged resolver routes
      // every datasource type through here and driver errors can embed
      // host/port/DSN userinfo (CLAUDE.md: no connection strings in responses).
      log.error({ err, requestId, connectionId }, "Wizard generate failed");
      return c.json({
        error: "generate_failed",
        message: "Failed to profile tables. Please retry; if it persists, check the connection settings and server logs.",
        requestId,
      }, 500);
    }

    const genData = genResult.right;

    log.info({
      requestId,
      connectionId,
      dbType,
      profiledCount: genData.analyzedProfiles.length,
      errorCount: genData.errors.length,
    }, "Wizard generate complete");

    return c.json({
      connectionId,
      dbType,
      // Stable wire shape: the effective schema, "public" placeholder for a
      // plugin with no configured schema (the YAML/enumeration used the
      // plugin's own default).
      schema: querySchema ?? "public",
      entities: genData.entities,
      errors: genData.errors,
    }, 200);
  }), { label: "wizard generate" });
});

// ---------------------------------------------------------------------------
// POST /enrich — LLM-enrich one table's entity YAML (Phase 2, issue #3236)
// ---------------------------------------------------------------------------

wizard.openapi(enrichRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    const { connectionId, tableName, yaml: baselineYaml } = c.req.valid("json");

    const orgId = user?.activeOrganizationId;

    // #3437 / #4489 — billing enforcement BEFORE any LLM spend, mirroring the
    // semantic-improve chat route (admin-semantic-improve.ts). The per-table
    // enrich runs `generateText` on platform tokens metered against the
    // workspace budget (below), so the run must pass the shared gate
    // (workspace status → abuse → plan limits, #3419/#3420) first. Admin
    // maintenance is intentionally NOT exempt: an admin of a suspended /
    // trial-expired / over-budget workspace resolves billing before enriching.
    // Runs ahead of model + connection resolution so a blocked workspace never
    // reaches the provider. `checkAgentBillingGate` fails closed by RETURNING a
    // block on a lookup error (a 503 `workspace_check_failed` or `billing_check_failed`,
    // depending on which sub-check's lookup failed) rather than throwing, and is a
    // no-op when there is no workspace (self-hosted / no orgId).
    // An UNEXPECTED throw (contract violation) is caught here and surfaced as
    // the same shaped, retry-guided 503 — never a generic 500, never a bypass.
    const gateResult = yield* Effect.tryPromise({
      try: () => checkAgentBillingGate(orgId),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }).pipe(Effect.either);
    if (gateResult._tag === "Left") {
      log.error(
        { err: gateResult.left, requestId, orgId },
        "Wizard enrich: billing gate threw unexpectedly — failing closed",
      );
      return c.json({
        error: "billing_check_failed",
        message: "Unable to verify billing status. Please try again.",
        retryable: true,
        requestId,
      }, 503);
    }
    const gateCheck = gateResult.right;
    if (!gateCheck.allowed) {
      log.warn(
        { requestId, orgId, errorCode: gateCheck.errorCode },
        "Wizard enrich blocked by billing enforcement",
      );
      const blockBody = {
        error: gateCheck.errorCode,
        message: gateCheck.errorMessage,
        retryable: gateCheck.retryable,
        requestId,
        ...(gateCheck.retryAfterSeconds !== undefined && { retryAfterSeconds: gateCheck.retryAfterSeconds }),
        ...(gateCheck.usage && { usage: gateCheck.usage }),
      };
      if (gateCheck.retryAfterSeconds !== undefined) {
        return c.json(blockBody, {
          status: gateCheck.httpStatus,
          headers: { "Retry-After": String(gateCheck.retryAfterSeconds) },
        });
      }
      return c.json(blockBody, gateCheck.httpStatus);
    }

    // Resolve the enrichment model up front (workspace BYOT → platform env), so
    // the UI surfaces ONE actionable 503 banner when nothing is configured
    // instead of every per-table enrich hitting the same provider-auth error.
    const modelResolution = yield* Effect.tryPromise({
      try: () => resolveEnrichModel(orgId),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }).pipe(Effect.either);
    if (modelResolution._tag === "Left") {
      log.error({ err: modelResolution.left, requestId }, "Wizard enrich: model resolution failed");
      return c.json({
        error: "enrich_failed",
        message: "Failed to resolve the enrichment model. Check server logs and retry.",
        requestId,
      }, 500);
    }
    const modelChoice = modelResolution.right;
    if (modelChoice.kind === "unavailable") {
      log.warn({ requestId }, "Wizard enrich: enrichment unavailable — no model configured");
      return c.json({
        error: "enrichment_unavailable",
        message: modelChoice.message,
        requestId,
      }, 503);
    }
    const model = modelChoice.model;

    const ctxResult = yield* Effect.tryPromise({
      try: () => resolveProfilingConnection(connectionId, orgId),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(Effect.either);

    if (ctxResult._tag === "Left") {
      const err = ctxResult.left;
      log.error({ err, requestId, connectionId }, "Failed to resolve connection");
      return c.json({
        error: "connection_resolution_failed",
        message: "Failed to resolve connection. Check server logs for details.",
        requestId,
      }, 500);
    }
    const ctx = ctxResult.right;
    if (ctx.kind === "not_found") {
      return c.json({ error: "not_found", message: `Connection "${connectionId}" not found.` }, 404);
    }
    if (ctx.kind === "unsupported") {
      return c.json({ error: "not_profilable", message: ctx.message }, 400);
    }
    if (ctx.kind === "reconnect_required") {
      return c.json({ error: "reconnect_required", message: ctx.message }, 400);
    }

    const { connection, dbType, querySchema } = ctx;

    const enrichResult = yield* Effect.tryPromise({
      try: async () => {
        // Re-profile JUST this table so the LLM is grounded in fresh DB
        // samples/distributions (semantic-onboarding § D: enrichment "receives
        // the table profile AND read-only access to the DB" — the profiler IS
        // that read-only access). Introspection rides the resolved connection,
        // bound to its creds — a separate-field-credential plugin (ES)
        // re-profiles with the tenant's own creds with no url/config threading.
        let result: ProfilingResult;
        try {
          result = await connection.profile({
            ...(querySchema !== undefined ? { schema: querySchema } : {}),
            selectedTables: [tableName],
            logger: log,
          });
        } finally {
          // Log (don't swallow) a close failure so a pool leak is visible
          // without failing the request (CLAUDE.md: no empty catch).
          await connection.close().catch((closeErr) =>
            log.warn(
              { err: closeErr instanceof Error ? closeErr.message : String(closeErr), requestId, connectionId, tableName },
              "Wizard enrich: connection close after re-profile failed",
            ),
          );
        }
        const profile =
          result.profiles.find((p) => p.table_name === tableName) ?? result.profiles[0];
        if (!profile) {
          return { error: "no_profile" as const };
        }
        // Pass dbType so the prompt emits query_patterns in the datasource's
        // dialect (PostgreSQL vs MySQL), not always PostgreSQL.
        const enriched = await enrichEntityYaml(baselineYaml, profile, model, undefined, dbType);
        return { ok: true as const, enriched };
      },
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }).pipe(Effect.either);

    if (enrichResult._tag === "Left") {
      const err = enrichResult.left;
      // Keep driver/provider detail in the logs; the client gets a sanitized,
      // actionable message + requestId (CLAUDE.md: no stack traces to the user).
      log.error({ err, requestId, connectionId, tableName }, "Wizard enrich failed");
      return c.json({
        error: "enrich_failed",
        message: `Failed to enrich "${tableName}". Please retry; if it persists, check the provider configuration and server logs.`,
        requestId,
      }, 500);
    }

    const data = enrichResult.right;
    if ("error" in data) {
      // no_profile — the table vanished between generate and enrich.
      return c.json({
        error: "not_found",
        message: `Table "${tableName}" was not found while profiling for enrichment.`,
        requestId,
      }, 404);
    }

    // #4489 — meter the enrichment's token spend against the workspace budget.
    // The `generateText` call ran on platform tokens, so its usage must count
    // toward the same per-period token budget the gate above enforces
    // (usage_events → getCurrentPeriodUsage → checkPlanLimits). Fire-and-forget
    // and a no-op when there is no internal DB (self-hosted, CLI); a run with an
    // internal DB but no workspace still records a null-workspace row. Only the
    // budget-relevant `token` event is emitted — an admin maintenance enrich is
    // not an end-user "query", so it is intentionally left out of query_count.
    // Weighted the same way as an agent turn (`toOutputEquivalentTokens`) so the
    // output-equivalent budget denominator stays consistent across surfaces.
    const usage = data.enriched.usage;
    const totalTokens = usage.inputTokens + usage.outputTokens;
    if (totalTokens > 0) {
      const modelId = typeof model === "string" ? model : model.modelId;
      logUsageEvent({
        workspaceId: orgId ?? null,
        userId: user?.id ?? null,
        eventType: "token",
        quantity: totalTokens,
        weightedQuantity: toOutputEquivalentTokens(usage, modelId),
        metadata: {
          source: "wizard_enrich",
          tableName,
          model: modelId,
          input: usage.inputTokens,
          output: usage.outputTokens,
        },
      });
    }

    log.info(
      { requestId, connectionId, tableName, enriched: data.enriched.enriched },
      "Wizard enrich complete",
    );

    return c.json(
      {
        tableName,
        yaml: data.enriched.yaml,
        enriched: data.enriched.enriched,
      },
      200,
    );
  }), { label: "wizard enrich" });
});

// ---------------------------------------------------------------------------
// POST /preview — Preview agent behavior with generated entities
// ---------------------------------------------------------------------------

wizard.openapi(previewRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    const { question, entities } = c.req.valid("json");

    // Build a semantic context summary from the provided entity YAMLs
    // (Zod already validated that entities are { tableName: string; yaml: string }[])
    const entitySummaries = entities
      .map((e) => `--- ${e.tableName} ---\n${e.yaml}`)
      .join("\n\n");
  
    // Generate a preview response showing what the agent would see
    const preview = {
      question,
      semanticContext: `The agent would see ${entities.length} entity definitions when answering this question.`,
      availableTables: entities.map((e) => e.tableName),
      entityCount: entities.length,
      sampleEntityYaml: entitySummaries.slice(0, 2000),
    };
  
    log.info({ requestId, question, entityCount: entities.length }, "Wizard preview generated");
  
    return c.json(preview, 200);
  }), { label: "wizard preview" });
});

// ---------------------------------------------------------------------------
// POST /save — Save entities to org-scoped semantic layer
// ---------------------------------------------------------------------------

wizard.openapi(saveRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    const orgId = user?.activeOrganizationId;
    if (!orgId) {
      return c.json({ error: "no_organization", message: "No active organization. Create a workspace first." }, 400);
    }
  
    const body = c.req.valid("json");
    const { connectionId, entities } = body;
  
    // Path traversal protection: validate all table names before writing any files
    for (const entity of entities) {
      if (!SAFE_TABLE_NAME.test(entity.tableName) || entity.tableName.includes("..")) {
        return c.json({
          error: "invalid_request",
          message: `Invalid table name: "${entity.tableName}". Only letters, digits, underscores, hyphens, and dots are allowed.`,
        }, 400);
      }
    }
  
    // Scope every saved entity by the Connection group the connection belongs
    // to (ADR-0012 / #3234), not the raw connectionId. A standalone datasource
    // is a group-of-one; the default/unknown connection resolves to the NULL
    // default group (flat root). Both the DB rows (connection_group_id) and the
    // on-disk groups/<group>/ namespace key on this, so adding a MEMBER to an
    // already-populated group upserts the shared group rows instead of writing a
    // second copy. Resolved up front so a lookup failure fails the whole save
    // (no partial write to the wrong group) rather than silently misscoping.
    const groupResult = yield* Effect.tryPromise({
      try: () => resolveGroupIdForConnection(orgId, connectionId),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }).pipe(Effect.either);
    if (groupResult._tag === "Left") {
      log.error(
        { err: groupResult.left, requestId, orgId, connectionId },
        "Wizard save: failed to resolve connection group",
      );
      return c.json({
        error: "save_failed",
        message: "Failed to resolve the connection group. Check server logs for details.",
        requestId,
      }, 500);
    }
    const connectionGroupId = groupResult.right;

    try {
      // Disk + DB are not transactional. Run DB first so a failure leaves
      // the disk untouched — disk-orphan recovery is harder than DB-only
      // retry. (#2141 + #2142.)
      const dbEntities = entities.map((e) => ({
        entityType: "entity" as const,
        name: path.basename(e.tableName),
        yamlContent: e.yaml,
        connectionGroupId,
      }));
      if (hasInternalDB()) {
        const upserted = yield* Effect.tryPromise({
          try: () => bulkUpsertEntities(orgId, dbEntities),
          catch: (err) => err instanceof Error ? err : new Error(String(err)),
        }).pipe(Effect.catchAll((err) => {
          log.error(
            { err: err.message, requestId, orgId, connectionId },
            "Wizard save: bulkUpsertEntities threw — no rows persisted",
          );
          return Effect.succeed(null as number | null);
        }));
        if (upserted === null) {
          return c.json({
            error: "db_persist_failed",
            message:
              "Failed to register entities for queries. SQL execution will reject these tables until this is resolved. Retry the wizard.",
            requestId,
          }, 500);
        }
        if (upserted < dbEntities.length) {
          // bulkUpsertEntities swallows per-entity errors and returns a
          // success count. Returning 201 here would silently recreate the
          // exact #2142 failure mode for the rows that didn't land.
          log.error(
            { requestId, orgId, attempted: dbEntities.length, upserted },
            "Wizard save: partial entity upsert — failing loud rather than 201ing a half-persisted state",
          );
          invalidateOrgWhitelist(orgId);
          return c.json({
            error: "db_partial_persist",
            message: `Registered ${upserted} of ${dbEntities.length} entities. Retry the wizard.`,
            requestId,
            attempted: dbEntities.length,
            succeeded: upserted,
          }, 500);
        }
        invalidateOrgWhitelist(orgId);

        // #3894 — refresh the group's auto-generated Source-catalog description
        // (ADR-0022 §4) from the entities just saved. Only for a real group
        // (the NULL flat-default group has no key to store under). Best-effort:
        // the entities ARE persisted, and the catalog falls back to an
        // entity-name summary, so a description hiccup must never fail the save.
        // `upsertAutoGroupDescription` (inside) never clobbers a manual edit.
        if (connectionGroupId) {
          yield* Effect.tryPromise({
            try: () =>
              refreshGroupAutoDescription(
                orgId,
                connectionGroupId,
                entities.map((e) => ({ name: e.tableName, yaml: e.yaml })),
              ),
            catch: (err) => (err instanceof Error ? err : new Error(String(err))),
          }).pipe(
            Effect.catchAll((err) => {
              log.warn(
                { err: err.message, requestId, orgId, connectionGroupId },
                "Wizard save: failed to refresh group auto-description — " +
                  "entities persisted, catalog falls back to entity-name summary",
              );
              return Effect.void;
            }),
          );
        }

        // #3682 — record the durable partial-profile marker when the wizard
        // forwarded the `/generate` failures. The wizard path persists via
        // `bulkUpsertEntities` (not `SemanticGenerator.persist`), so it writes
        // the marker here directly. Best-effort: the entities ARE persisted, so
        // a marker-write failure must not fail the save — log and continue.
        if (body.failedTables !== undefined) {
          const failedTables = body.failedTables;
          yield* Effect.tryPromise({
            try: () =>
              upsertProfileStatus(orgId, connectionGroupId, {
                totalTables: body.totalTables ?? entities.length + failedTables.length,
                failedTables,
              }),
            catch: (err) => (err instanceof Error ? err : new Error(String(err))),
          }).pipe(
            Effect.catchAll((err) => {
              log.error(
                { err: err.message, requestId, orgId, connectionId, failedCount: failedTables.length },
                "Wizard save: failed to record durable partial-profile marker — " +
                  "entities persisted, marker skipped",
              );
              return Effect.void;
            }),
          );
        }
      }

      // Disk writes happen after DB success. Output dir is org-scoped and
      // group-scoped: the canonical groups/<group>/ namespace (ADR-0012), or
      // the flat default root for the NULL default group.
      const outputBase = outputDirForGroup(connectionGroupId, orgId);
      const entitiesDir = path.join(outputBase, "entities");
      const metricsDir = path.join(outputBase, "metrics");

      fs.mkdirSync(entitiesDir, { recursive: true });
      fs.mkdirSync(metricsDir, { recursive: true });

      const savedFiles: string[] = [];
      const warnings: Array<{ kind: "disk_sync_failed"; tableName: string; reason: string }> = [];

      for (const entity of entities) {
        const safeName = path.basename(entity.tableName);
        const filePath = path.join(entitiesDir, `${safeName}.yml`);
        fs.writeFileSync(filePath, entity.yaml, "utf-8");
        savedFiles.push(`entities/${safeName}.yml`);

        // Org-scoped semantic dir feeds the explore tool. Failures here
        // mean the agent can't read the entity even though the DB has it
        // — surface the specific tableName so the operator can see which
        // entities are split rather than just a log line.
        if (hasInternalDB()) {
          const syncResult = yield* Effect.tryPromise({
            try: () => syncEntityToDisk(orgId, entity.tableName, "entity", entity.yaml, connectionGroupId),
            catch: (err) => err instanceof Error ? err : new Error(String(err)),
          }).pipe(Effect.catchAll((err) => {
            log.warn(
              { err: err.message, requestId, orgId, tableName: entity.tableName },
              "Disk sync after wizard save failed",
            );
            return Effect.succeed({ tableName: entity.tableName, reason: err.message });
          }));
          if (syncResult && typeof syncResult === "object" && "tableName" in syncResult) {
            warnings.push({ kind: "disk_sync_failed", ...syncResult });
          }
        }
      }

      // Catalog/glossary/metrics from raw profile data. The wizard frontend
      // sends pre-generated entity YAML via { connectionId, entities }; this
      // branch is for callers (e.g. future CLI integrations) that submit
      // raw TableProfile[] for server-side generation.
      const { schema: bodySchema, dbType: bodyDbType, profiles: profileData } = body;
      if (profileData && profileData.length > 0) {
        const profiles = profileData;
        const resolvedSchema = bodySchema ?? "public";
        // Keep metric `FROM` qualification in lockstep with the entity
        // `table:` the frontend already generated (issue #3252). Defaults to
        // "postgres" — the only dbType where a custom schema named `main` is
        // reachable; "main" stays unqualified for DuckDB/SQLite callers that
        // pass dbType explicitly.
        const resolvedDbType = bodyDbType ?? "postgres";

        // Assemble through the shared engine (#3506) so the wizard, the CLI,
        // and the SemanticGenerator service can't drift. Entities are supplied
        // by the frontend, so only the catalog/glossary/metric artifacts are
        // consumed here.
        const generated = generateSemanticLayer(profiles, {
          dbType: resolvedDbType,
          schema: resolvedSchema,
        });

        const catalogPath = path.join(outputBase, "catalog.yml");
        fs.writeFileSync(catalogPath, generated.catalog, "utf-8");
        savedFiles.push("catalog.yml");

        const glossaryPath = path.join(outputBase, "glossary.yml");
        fs.writeFileSync(glossaryPath, generated.glossary, "utf-8");
        savedFiles.push("glossary.yml");

        // DECISION (#3550): metrics land in `semantic_entities` (DB), which is
        // the source of truth for queryability — converging with
        // `SemanticGenerator.persist` (the MCP path), which already persists
        // entities AND metrics to the DB. Pre-#3550 the wizard wrote metrics to
        // disk only, so wizard- vs MCP-onboarded workspaces had different metric
        // durability guarantees. Both paths now persist metrics as drafts
        // (promoted via the atomic `/api/v1/admin/publish` endpoint) and key
        // rows through the shared `safeSemanticRowName`, so the two can't drift
        // again. The disk write below is RETAINED as a derived legibility
        // artifact (it is also re-read by boot reconciliation / disk sync), but
        // the DB is the source of truth for queryability — so a disk-write
        // failure is surfaced as a non-fatal warning rather than 500ing an
        // already-committed persist, mirroring the entity disk-sync path.
        //
        // Untrusted HTTP profiles still pass the path-traversal guard:
        // `safeSemanticRowName` strips path segments and rejects unsafe names
        // (skipped + logged, never silently swallowed), and the same name keys
        // both the DB row and the disk filename so the two can't disagree on
        // which metrics landed.
        const metricArtifacts = generated.metrics
          .map((metric) => {
            const name = safeSemanticRowName(metric.table);
            if (name === null) {
              log.warn(
                { requestId, orgId, table: metric.table },
                "Wizard save: skipping generated metric — table name is not path-safe",
              );
              return null;
            }
            return { name, yaml: metric.yaml };
          })
          .filter((m): m is { name: string; yaml: string } => m !== null);

        // DB-first (mirrors the entity write above): persist metrics, fail loud
        // on a short count, THEN write to disk so a partial DB persist never
        // 201s a half-queryable state (#2142 class, now for metrics too). Same
        // `db_persist_failed` / `db_partial_persist` contract as entities.
        if (hasInternalDB() && metricArtifacts.length > 0) {
          const metricRows = metricArtifacts.map((m) => ({
            entityType: "metric" as const,
            name: m.name,
            yamlContent: m.yaml,
            connectionGroupId,
          }));
          const upsertedMetrics = yield* Effect.tryPromise({
            try: () => bulkUpsertEntities(orgId, metricRows),
            catch: (err) => (err instanceof Error ? err : new Error(String(err))),
          }).pipe(Effect.catchAll((err) => {
            log.error(
              { err: err.message, requestId, orgId, connectionId },
              "Wizard save: bulkUpsertEntities threw persisting metrics — no metric rows persisted",
            );
            return Effect.succeed(null as number | null);
          }));
          if (upsertedMetrics === null) {
            return c.json({
              error: "db_persist_failed",
              message:
                "Failed to register metrics for queries. SQL execution will reject these metrics until this is resolved. Retry the wizard.",
              requestId,
            }, 500);
          }
          if (upsertedMetrics < metricRows.length) {
            // bulkUpsertEntities swallows per-row errors and returns the count
            // that succeeded — returning 201 would silently drop the rows that
            // didn't land, exactly the #2142 failure mode for metrics.
            log.error(
              { requestId, orgId, attempted: metricRows.length, upserted: upsertedMetrics },
              "Wizard save: partial metric upsert — failing loud rather than 201ing a half-persisted state",
            );
            invalidateOrgWhitelist(orgId);
            return c.json({
              error: "db_partial_persist",
              message: `Registered ${upsertedMetrics} of ${metricRows.length} metrics. Retry the wizard.`,
              requestId,
              attempted: metricRows.length,
              succeeded: upsertedMetrics,
            }, 500);
          }
          invalidateOrgWhitelist(orgId);
        }

        for (const metric of metricArtifacts) {
          const filePath = path.join(metricsDir, `${metric.name}.yml`);
          try {
            fs.writeFileSync(filePath, metric.yaml, "utf-8");
            savedFiles.push(`metrics/${metric.name}.yml`);
          } catch (err) {
            // DB persist above is authoritative and already committed; the disk
            // copy is derived. Don't escalate a disk failure to a 500 that would
            // misreport a successful persist as a save failure — surface it as a
            // warning, the same contract `syncEntityToDisk` uses for entities.
            const reason = err instanceof Error ? err.message : String(err);
            log.warn(
              { requestId, orgId, table: metric.name, reason },
              "Wizard save: metric disk write failed (DB persist already succeeded)",
            );
            warnings.push({ kind: "disk_sync_failed", tableName: metric.name, reason });
          }
        }
      }

      _resetWhitelists();

      log.info({
        requestId,
        orgId,
        connectionId,
        entityCount: entities.length,
        fileCount: savedFiles.length,
        warningCount: warnings.length,
      }, "Wizard save complete");

      // F-34 (#1789): the wizard is the primary UI onboarding flow for a
      // datasource. Emit `connection.create` with the canonical
      // `{ name, dbType }` metadata shape — identical to `admin-connections`
      // POST — so compliance queries filtering `action_type = 'connection.create'`
      // see datasource additions regardless of entry path. The row is
      // emitted AFTER the disk write + whitelist reset so the audit trail
      // only signals a successful onboarding (failures earlier short-circuit
      // into the catch branch below without audit). The wizard exposes no
      // probe endpoint of its own — admin-connections' `POST /test` is the
      // privileged probe surface and emits `connection.probe` there.
      const registryEntry = connections.describe().find((conn) => conn.id === connectionId);
      const resolvedDbType = registryEntry?.dbType ?? "unknown";
      logAdminAction({
        actionType: ADMIN_ACTIONS.connection.create,
        targetType: "connection",
        targetId: connectionId,
        ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
        metadata: { name: connectionId, dbType: resolvedDbType },
      });

      return c.json({
        saved: true,
        orgId,
        connectionId,
        entityCount: entities.length,
        files: savedFiles,
        ...(warnings.length > 0 ? { warnings } : {}),
      }, 201);
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Wizard save failed");
      return c.json({
        error: "save_failed",
        message: `Failed to save entities: ${err instanceof Error ? err.message : String(err)}`,
        requestId,
      }, 500);
    }
  }), { label: "wizard save" });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EnrichModelResolution =
  | { kind: "ok"; model: ReturnType<typeof getModel> }
  | { kind: "unavailable"; message: string };

/**
 * Resolve the model the wizard's Phase-2 enrichment should use, or report why
 * it can't run. Mirrors the agent loop (`lib/agent.ts`): honor an
 * admin-configured per-workspace provider (BYOT via `ModelRouter`, EE) FIRST,
 * so a workspace whose provider lives in settings rather than the platform env
 * can still enrich — otherwise the "Configure a provider in admin" guidance the
 * 503 surfaces would be self-contradictory. Self-hosted / no-EE sees the no-op
 * ModelRouter (returns null) and falls through to the platform env provider,
 * matching the shared engine + CLI `getModel()`. Returns `unavailable` (→ 503)
 * only when NEITHER a workspace key NOR a platform provider is configured.
 */
async function resolveEnrichModel(
  orgId: string | null | undefined,
): Promise<EnrichModelResolution> {
  if (orgId && hasInternalDB()) {
    const { ModelConfigDecryptError } = await import("@atlas/api/lib/model-routing/errors");
    const program = Effect.gen(function* () {
      const router = yield* ModelRouter;
      return yield* router.getWorkspaceModelConfigRaw(orgId);
    });
    try {
      const workspaceConfig = await runEnterprise(program);
      if (workspaceConfig) {
        return { kind: "ok", model: getModelFromWorkspaceConfig(workspaceConfig) };
      }
    } catch (err) {
      if (err instanceof ModelConfigDecryptError) {
        return {
          kind: "unavailable",
          message:
            "Your workspace's API key could not be decrypted. Re-enter it on the AI Provider settings page, then retry enrichment.",
        };
      }
      log.warn(
        { orgId, err: err instanceof Error ? err.message : String(err) },
        "Wizard enrich: workspace model config unavailable — falling back to platform default",
      );
    }
  }

  const { provider, missing } = getMissingModelConfig();
  if (missing.length > 0) {
    return {
      kind: "unavailable",
      message:
        `Enrichment needs a configured LLM provider (${provider} is missing ${missing.join(", ")}). ` +
        "Configure a provider in admin, or save the mechanical baseline as-is.",
    };
  }
  return { kind: "ok", model: getModel() };
}

export { wizard };
