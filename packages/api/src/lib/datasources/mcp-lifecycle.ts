/**
 * Datasource lifecycle helpers for the MCP datasource admin tools
 * (#3513 list/test/archive/restore, #3514 delete, and reused by the
 * Phase-2 provisioning/profiling tools #3511/#3512).
 *
 * These are the LIB-LAYER calls the MCP datasource tools dispatch to. The
 * MCP tools NEVER loop back through the `/admin/connections` HTTP routes
 * (ADR-0016 — origin=mcp must call the same lib seam the admin REST routes
 * call, not proxy them). Each helper mirrors the corresponding admin-route
 * behaviour but takes an explicit `(orgId, …)` tuple instead of a Hono
 * `Context`, because the MCP transport has no request context.
 *
 * The source of truth for the underlying mutations stays the
 * `WorkspaceInstaller` facade (`lib/effect/workspace-installer.ts`) and the
 * `connections` registry (`lib/db/connection.ts`); this module only adapts
 * them to a context-free, MCP-friendly call shape.
 *
 * ── Masking discipline ────────────────────────────────────────────────
 * `listDatasources` is built from `workspace_plugins` rows projecting ONLY
 * non-secret columns (`install_id`, `status`, `config->>'group_id'`) plus
 * `connections.describe()` (which carries no credentials — see
 * `ConnectionMetadata`). No path in this module decrypts or returns a
 * secret field, satisfying CLAUDE.md's "list never returns plaintext
 * credentials" rule. `connections.healthCheck` already scrubs DSN userinfo
 * from its `message`.
 */

import { Cause, Effect } from "effect";
import type { AtlasMode } from "@useatlas/types/auth";
import type { WorkspaceId } from "@useatlas/types";
import { CONTENT_MODE_TABLES, makeService } from "@atlas/api/lib/content-mode";
import { connections } from "@atlas/api/lib/db/connection";
import type { HealthCheckResult } from "@atlas/api/lib/db/connection";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import {
  catalogSlugToDbType,
  resolveDatasourcePoolConfig,
} from "@atlas/api/lib/db/datasource-pool-resolver";
import { decryptSecretFields, parseConfigSchema } from "@atlas/api/lib/plugins/secrets";
import { errorMessage, causeToError } from "@atlas/api/lib/audit/error-scrub";
import {
  MCP_PROVISIONABLE_CATALOG_SLUGS,
  isMcpNativeDbType,
  type McpNativeDbType,
} from "@atlas/api/lib/datasources/provisionable-types";
import {
  WorkspaceInstaller,
  WorkspaceInstallerLive,
  mapInstallError,
  type WorkspaceInstallerShape,
  type InstallError,
  type DatasourceInstallRow,
} from "@atlas/api/lib/effect/workspace-installer";
import {
  SemanticGenerator,
  SemanticGeneratorLive,
  type ProfileAndGenerateResult,
} from "@atlas/api/lib/effect/semantic-generator";
import { ProfilingFailedError } from "@atlas/api/lib/effect/errors";
import type { ProfileProgressCallbacks } from "@atlas/api/lib/profiler";

// Module-level synchronous content-mode registry — mirrors the one in
// `api/routes/admin-connections.ts`. `readFilter` is a pure function of the
// static `CONTENT_MODE_TABLES` tuple, so `Effect.runSync` is safe (no I/O).
const contentModeRegistry = makeService(CONTENT_MODE_TABLES);

// ── List ──────────────────────────────────────────────────────────────

/**
 * Credential-free summary of a configured datasource. Deliberately omits
 * every secret-bearing field — there is no `url`/`config` here, only the
 * masked-by-construction metadata an MCP client needs to pick a target for
 * test / archive / delete.
 */
export interface DatasourceSummary {
  /** User-facing connection id (`workspace_plugins.install_id`). */
  readonly id: string;
  /** Derived database type (`postgres`, `mysql`, `snowflake`, …). */
  readonly dbType: string;
  readonly description: string | null;
  readonly status: "draft" | "published" | "archived";
  /** Environment-group binding (`config.group_id`), or `null` when ungrouped. */
  readonly groupId: string | null;
  /**
   * Last-known health probe for the registered pool, or `null` when the
   * datasource isn't currently registered (e.g. archived → pool drained).
   * `checkedAt` is ISO-8601 for a stable wire shape.
   */
  readonly health: {
    readonly status: string;
    readonly latencyMs: number;
    readonly checkedAt: string;
  } | null;
}

export interface ListDatasourcesOptions {
  /**
   * Include `archived` installs (default `false`). Archived datasources are
   * hidden from the admin UI list but the MCP `restore_datasource` tool
   * needs them discoverable, so the list tool opts in.
   */
  readonly includeArchived?: boolean;
}

/**
 * List the datasources configured for a workspace. Mirrors the
 * `/admin/connections` GET visibility query (content-mode read filter on
 * `workspace_plugins`) but returns a credential-free {@link DatasourceSummary}
 * shaped for MCP. Returns `[]` when no internal DB is configured (the
 * connection-management surface requires `DATABASE_URL`).
 *
 * @param mode  Atlas mode — `published` sees published installs; `developer`
 *   additionally sees drafts. `archived` rows are gated by `includeArchived`.
 */
export async function listDatasources(
  orgId: string,
  mode: AtlasMode,
  options: ListDatasourcesOptions = {},
): Promise<DatasourceSummary[]> {
  if (!hasInternalDB()) return [];

  // Content-mode read filter — identical clause to
  // `getVisibleConnectionIds` in the admin route (segment key
  // "connections" overlays the `workspace_plugins` physical table). Alias
  // `wp` matches the FROM below.
  const statusClause = Effect.runSync(
    contentModeRegistry.readFilter("connections", mode, "wp"),
  );
  // `includeArchived` drops the status filter so archived installs surface
  // for restore; otherwise the content-mode clause keeps archived hidden.
  const whereStatus = options.includeArchived ? "TRUE" : statusClause;

  const rows = await internalQuery<{
    install_id: string;
    status: string;
    group_id: string | null;
    catalog_slug: string;
  }>(
    `SELECT wp.install_id,
            wp.status,
            wp.config->>'group_id' AS group_id,
            pc.slug AS catalog_slug
       FROM workspace_plugins wp
       JOIN plugin_catalog pc ON pc.id = wp.catalog_id
      WHERE wp.workspace_id = $1
        AND wp.pillar = 'datasource'
        AND ${whereStatus}
      ORDER BY wp.install_id`,
    [orgId],
  );

  // `connections.describe()` carries dbType + description + last health for
  // currently-registered pools (no secrets). Archived/unregistered rows
  // fall back to `catalogSlugToDbType` for the type and a null health.
  const described = new Map(connections.describe().map((c) => [c.id, c]));

  return rows.map((r): DatasourceSummary => {
    const meta = described.get(r.install_id);
    const dbType = meta?.dbType ?? safeDbType(r.catalog_slug);
    const health = meta?.health
      ? {
          status: meta.health.status,
          latencyMs: meta.health.latencyMs,
          checkedAt: meta.health.checkedAt.toISOString(),
        }
      : null;
    return {
      id: r.install_id,
      dbType,
      description: meta?.description ?? null,
      status: normalizeStatus(r.status),
      groupId: r.group_id && r.group_id.length > 0 ? r.group_id : null,
      health,
    };
  });
}

function normalizeStatus(raw: string): DatasourceSummary["status"] {
  return raw === "draft" || raw === "archived" ? raw : "published";
}

/**
 * Resolve a catalog-slug-derived dbType without throwing — an unknown slug
 * (corrupt row, catalog renamed out from under an install) degrades to
 * `"unknown"` rather than failing the whole list.
 */
function safeDbType(catalogSlug: string): string {
  try {
    return catalogSlugToDbType(catalogSlug);
  } catch {
    // intentionally ignored: an unrecognised slug is non-fatal for a
    // metadata listing — surface a placeholder type, not a 500.
    return "unknown";
  }
}

// ── Catalog-slug resolution (for installer-routed mutations) ───────────

/**
 * Resolve the catalog slug for a datasource install so the
 * `WorkspaceInstaller` can route an archive / restore / delete. Returns
 * `null` when no datasource install with that id exists in the workspace
 * (the caller maps that to a `not found` envelope). Returns
 * `{ catalogSlug: null }`-free — a missing internal DB also yields `null`.
 */
export async function resolveDatasourceCatalogSlug(
  orgId: string,
  installId: string,
): Promise<string | null> {
  if (!hasInternalDB()) return null;
  const rows = await internalQuery<{ catalog_slug: string }>(
    `SELECT pc.slug AS catalog_slug
       FROM workspace_plugins wp
       JOIN plugin_catalog pc ON pc.id = wp.catalog_id
      WHERE wp.workspace_id = $1
        AND wp.install_id = $2
        AND wp.pillar = 'datasource'
      LIMIT 1`,
    [orgId, installId],
  );
  return rows.length > 0 ? rows[0].catalog_slug : null;
}

// ── Health check (test) ───────────────────────────────────────────────

/**
 * Run a connection health-check against a registered datasource pool. Thin
 * pass-through to {@link connections.healthCheck} (the same call the
 * `/admin/connections/:id/test` route uses). `message` is already scrubbed
 * of DSN userinfo by the registry, so the result is safe to surface to an
 * MCP client verbatim.
 */
export function testDatasource(id: string): Promise<HealthCheckResult> {
  return connections.healthCheck(id);
}

/** Whether a datasource id is currently registered (queryable) at all. */
export function isDatasourceRegistered(id: string): boolean {
  return connections.has(id);
}

// ── WorkspaceInstaller bridge (context-free) ──────────────────────────

/**
 * Discriminated outcome of {@link runDatasourceInstaller}. Mirrors the
 * `InstallerResult` shape the admin route's `runInstaller` produces, minus
 * the Hono coupling — the MCP caller maps `error` onto an
 * `AtlasMcpToolError` envelope and `ok` onto a success body.
 */
export type DatasourceInstallerOutcome<A> =
  | { readonly kind: "ok"; readonly value: A }
  | {
      readonly kind: "error";
      readonly status: 400 | 404 | 409;
      readonly code: string;
      readonly message: string;
      readonly body: Readonly<Record<string, unknown>>;
    };

/**
 * Run a `WorkspaceInstaller`-using Effect from a context-free caller (the
 * MCP transport). Provides the live installer Layer and maps tagged
 * {@link InstallError} variants into a renderable `{ status, code, message }`
 * via {@link mapInstallError}.
 *
 * Defects (non-tagged Effect failures — DB outages, resolver throws) are
 * RE-THROWN so the MCP tool's outer try/catch surfaces them as an
 * `internal_error` envelope with a `request_id`. This matches the admin
 * route's posture: a defect is a 500, a tagged error is a typed 4xx.
 */
export async function runDatasourceInstaller<A>(
  body: (installer: WorkspaceInstallerShape) => Effect.Effect<A, InstallError>,
): Promise<DatasourceInstallerOutcome<A>> {
  const program = Effect.gen(function* () {
    const installer = yield* WorkspaceInstaller;
    return yield* body(installer);
  });

  const exit = await Effect.runPromiseExit(
    program.pipe(Effect.provide(WorkspaceInstallerLive)),
  );

  if (exit._tag === "Success") return { kind: "ok", value: exit.value };

  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "Some") {
    const mapping = mapInstallError(failure.value);
    return {
      kind: "error",
      status: mapping.status,
      code: mapping.code,
      message: mapping.message,
      body: mapping.body ?? {},
    };
  }
  // Defect — re-throw with the rendered Cause so the MCP tool's catch logs
  // it and returns an `internal_error` envelope (parity with the route's
  // `runInstaller`, which lets `runHandler` surface the 500).
  throw new Error(`WorkspaceInstaller program died: ${Cause.pretty(exit.cause)}`);
}

// ── Provisioning (#3511 create) ───────────────────────────────────────

// The native-dbType set + provisionable slugs live in the dependency-free
// `provisionable-types` module so the MCP layer can read the `db_type` enum at
// registration time without pulling this heavy graph. Re-exported here for
// existing consumers.
export {
  MCP_PROVISIONABLE_CATALOG_SLUGS,
  isMcpNativeDbType,
  type McpNativeDbType,
};

/**
 * Input to {@link provisionDatasource}. `url` is the credential collected
 * via masked elicitation at the MCP edge — it is encrypted at the installer
 * boundary and NEVER round-trips back out (the returned row carries only a
 * `maskedUrl`).
 */
export interface ProvisionDatasourceInput {
  readonly catalogSlug: string;
  readonly installId: string;
  /** The connection URL (secret). Encrypted by the installer per config_schema. */
  readonly url: string;
  readonly schema?: string;
  readonly description?: string;
  readonly groupId?: string | null;
}

export type ProvisionDatasourceOutcome =
  | { readonly kind: "ok"; readonly value: DatasourceInstallRow }
  /** Unsupported dbType — actionable, no secret. */
  | { readonly kind: "unsupported"; readonly message: string }
  /** Pre-flight connectivity failed — message is credential-scrubbed. */
  | { readonly kind: "health_error"; readonly message: string }
  /** Tagged installer error (validation / conflict / not-found). */
  | { readonly kind: "error"; readonly status: 400 | 404 | 409; readonly code: string; readonly message: string };

/**
 * Strip the secret URL out of an error message so a connection-failure
 * surfaced to the agent/client can never leak the credential. First removes
 * the exact `url` (handles a `@`-bearing password the userinfo regex below
 * can't), then defers to the canonical {@link errorMessage} scrubber for the
 * generic `scheme://user:pass@host` userinfo case + the 512-char truncation —
 * reusing the blessed seam (`lib/audit/error-scrub.ts`) rather than a
 * hand-rolled regex so a future hardening there covers this path too.
 */
function scrubSecretFromMessage(message: string, url: string): string {
  const exact = url ? message.split(url).join("[redacted]") : message;
  return errorMessage(exact);
}

/**
 * Provision a new datasource over MCP: validate the dbType is provisionable
 * → pre-flight health-check the candidate connection WITHOUT persisting →
 * on success install it as a `draft` (credential encrypted by the installer)
 * → return the masked row. On any failure nothing is persisted and the
 * ephemeral pool is rolled back.
 *
 * The credential (`input.url`) only flows in here and into the installer's
 * encrypt-at-rest path; it is never returned, logged, or placed in an error.
 */
export async function provisionDatasource(
  orgId: string,
  input: ProvisionDatasourceInput,
): Promise<ProvisionDatasourceOutcome> {
  if (!isMcpNativeDbType(input.catalogSlug)) {
    return {
      kind: "unsupported",
      message:
        `Provisioning "${input.catalogSlug}" datasources via MCP is not supported yet. ` +
        `Supported types: ${MCP_PROVISIONABLE_CATALOG_SLUGS.join(", ")}. ` +
        `Use the Atlas admin console for other datasource types.`,
    };
  }

  // Reject a duplicate id before touching the registry — a clean message
  // beats an installer `AlreadyInstalledError` deep in the Effect.
  if (await resolveDatasourceCatalogSlug(orgId, input.installId)) {
    return {
      kind: "error",
      status: 409,
      code: "conflict",
      message: `A datasource with id "${input.installId}" already exists in this workspace.`,
    };
  }

  // Pre-flight on an EPHEMERAL probe id — never the real install id. Using a
  // throwaway id (a) guarantees the probe tests THIS candidate `url`, not a
  // stale bare pool that might already exist under `installId` (e.g. a
  // sibling workspace's pool, the runtime `default`, or an un-drained
  // archived install), and (b) can't leave the install-id-keyed registry in a
  // split-brain state if persist later fails. Mirrors the admin route's
  // `_test_*` ephemeral test-connect (ADR-0007). The probe pool is ALWAYS
  // unregistered in `finally`.
  const probeId = `__mcp_preflight_${crypto.randomUUID()}`;
  connections.register(probeId, {
    url: input.url,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.schema !== undefined ? { schema: input.schema } : {}),
  });
  try {
    const health = await connections.healthCheck(probeId);
    // `healthCheck` only reports `unhealthy` after repeated failures over a
    // window; a brand-new pool's FIRST failed probe is `degraded`. So treat
    // anything that isn't `healthy` as a failed pre-flight — otherwise a
    // broken connection slips past validate-before-persist.
    if (health.status !== "healthy") {
      return {
        kind: "health_error",
        message: scrubSecretFromMessage(
          health.message ?? "Connection probe could not reach the datasource.",
          input.url,
        ),
      };
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return {
      kind: "health_error",
      message: scrubSecretFromMessage(
        `Connection test failed: ${raw}. Verify the host, port, database, and credentials, then retry.`,
        input.url,
      ),
    };
  } finally {
    // Always drain the probe pool — success persists via the installer's own
    // fresh registration, failure persists nothing.
    connections.unregister(probeId);
  }

  // Health OK → persist as draft. The installer re-registers idempotently and
  // encrypts the `url` per the catalog config_schema.
  const formData: Record<string, unknown> = {
    url: input.url,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.schema !== undefined && input.schema.length > 0 ? { schema: input.schema } : {}),
  };
  const outcome = await runDatasourceInstaller((installer) =>
    installer.installDatasource(orgId as WorkspaceId, input.catalogSlug, {
      installId: input.installId,
      formData,
      groupId: input.groupId ?? null,
      atlasMode: "draft",
    }),
  );
  if (outcome.kind === "error") {
    // Nothing to roll back: the probe pool was already drained in `finally`,
    // and `installDatasource` registers the real pool only as its final step
    // (after a successful persist), so a failed install left no pool behind.
    return {
      kind: "error",
      status: outcome.status,
      code: outcome.code,
      message: scrubSecretFromMessage(outcome.message, input.url),
    };
  }
  return { kind: "ok", value: outcome.value };
}

// ── Profiling / semantic-gen (#3512) ──────────────────────────────────

/** Resolved profiling target — internal use only; `url` is the decrypted secret. */
export interface DatasourceProfileTarget {
  readonly url: string;
  readonly dbType: McpNativeDbType;
  readonly schema?: string;
  /**
   * The install's connection-group scope (`workspace_plugins.config.group_id`),
   * or `null` for an ungrouped install. Carried so the persistence step
   * (#3546) lands the generated entities under the SAME `connection_group_id`
   * the whitelist loader reads — a group-of-one for a standalone MCP-created
   * datasource. This is metadata (a group name), never a secret.
   */
  readonly connectionGroupId: string | null;
}

export type LoadProfileTargetResult =
  | { readonly kind: "ok"; readonly target: DatasourceProfileTarget }
  | { readonly kind: "not_found" }
  | { readonly kind: "unsupported"; readonly dbType: string };

/**
 * Load + decrypt a datasource install's connection config and shape the
 * profiling target the semantic generator needs. Returns `not_found` for an
 * unknown install and `unsupported` for a dbType without a built-in profiler
 * (only postgres/mysql profile in-core; other types need an injected
 * `profileFn`, out of scope for the MCP flow). The decrypted `url` never
 * leaves the lib layer — the caller passes it straight to the profiler.
 */
export async function loadDatasourceProfileTarget(
  orgId: string,
  installId: string,
): Promise<LoadProfileTargetResult> {
  if (!hasInternalDB()) return { kind: "not_found" };
  const rows = await internalQuery<{
    catalog_id: string;
    catalog_slug: string;
    config: Record<string, unknown> | null;
    config_schema: unknown;
    group_id: string | null;
  }>(
    `SELECT wp.catalog_id, pc.slug AS catalog_slug, wp.config, pc.config_schema,
            wp.config->>'group_id' AS group_id
       FROM workspace_plugins wp
       JOIN plugin_catalog pc ON pc.id = wp.catalog_id
      WHERE wp.workspace_id = $1
        AND wp.install_id = $2
        AND wp.pillar = 'datasource'
      LIMIT 1`,
    [orgId, installId],
  );
  if (rows.length === 0) return { kind: "not_found" };
  const row = rows[0];
  const schema = parseConfigSchema(row.config_schema);
  const decrypted = decryptSecretFields(row.config ?? {}, schema);
  // Group scope for the persistence step — `null` when the install carries no
  // group binding (the flat default scope), matching the whitelist loader's
  // NULL-scope bucket.
  const connectionGroupId = row.group_id && row.group_id.length > 0 ? row.group_id : null;
  const poolConfig = resolveDatasourcePoolConfig(
    {
      workspaceId: orgId,
      catalogId: row.catalog_id,
      installId,
      pillar: "datasource",
      catalogSlug: row.catalog_slug,
    },
    decrypted,
  );
  // Discriminant check (not the `isMcpNativeDbType` string guard) so TS
  // narrows the `DatasourcePoolConfig` union to the postgres/mysql members
  // that carry `.url`. Same native set as `MCP_NATIVE_DB_TYPES`.
  if (poolConfig.dbType !== "postgres" && poolConfig.dbType !== "mysql") {
    return { kind: "unsupported", dbType: poolConfig.dbType };
  }
  return {
    kind: "ok",
    target: {
      url: poolConfig.url,
      dbType: poolConfig.dbType,
      schema: "schema" in poolConfig ? poolConfig.schema : undefined,
      connectionGroupId,
    },
  };
}

export type RunSemanticProfileOutcome =
  | {
      readonly kind: "ok";
      readonly result: ProfileAndGenerateResult;
      /**
       * Durable-persistence counts (#3546). Present when an `orgId` was
       * supplied AND an internal DB is configured (the generated entities were
       * upserted as drafts to `semantic_entities`); `null` when persistence was
       * skipped (no `orgId` / no internal DB — the in-memory whitelist is the
       * only registration, e.g. a self-hosted stdio server with no internal DB).
       */
      readonly persisted: { readonly entities: number; readonly metrics: number } | null;
    }
  | { readonly kind: "error"; readonly reason: ProfilingFailedError["reason"]; readonly message: string };

/**
 * Profile a connection and generate its semantic layer via the #3506
 * `SemanticGenerator` service, registering the generated entities into the
 * in-process table whitelist so a subsequent in-process `executeSQL` is
 * permitted, AND — when an `orgId` is supplied and an internal DB is
 * configured — DURABLY persisting the generated entities + metrics to the org
 * semantic store as drafts (#3546). Persistence is what makes the connection
 * queryable (a) after an MCP-server restart and (b) from the API process the
 * web `/chat` `executeSQL` runs in (a stdio MCP server is a different process,
 * so its in-memory whitelist alone is not cross-surface). `progress` bridges
 * the profiler's per-table callbacks to the MCP progress seam.
 *
 * A tagged `ProfilingFailedError` (no tables, threshold exceeded, persist
 * failure, …) is returned as a typed `error` outcome; an unexpected defect
 * re-throws for the caller's `internal_error` path.
 */
export async function runSemanticProfile(opts: {
  url: string;
  dbType: McpNativeDbType;
  schema?: string;
  connectionId: string;
  /**
   * Workspace the generated rows belong to. When provided (and an internal DB
   * is configured) the generated layer is persisted as drafts; when omitted,
   * only the in-memory whitelist is populated. The MCP `profile_datasource`
   * tool always passes the bound workspace.
   */
  orgId?: string;
  /**
   * Connection-group scope for the persisted rows — pass the value from
   * {@link DatasourceProfileTarget.connectionGroupId} so the rows land in the
   * same scope the whitelist loader reads. Ignored when `orgId` is omitted.
   */
  connectionGroupId?: string | null;
  progress?: ProfileProgressCallbacks;
}): Promise<RunSemanticProfileOutcome> {
  const shouldPersist = opts.orgId !== undefined && hasInternalDB();

  const program = Effect.gen(function* () {
    const gen = yield* SemanticGenerator;
    const result = yield* gen.profileAndGenerate({
      url: opts.url,
      dbType: opts.dbType,
      ...(opts.schema !== undefined ? { schema: opts.schema } : {}),
      connectionId: opts.connectionId,
      registerWhitelist: true,
      ...(opts.progress !== undefined ? { progress: opts.progress } : {}),
    });

    // Durably persist as drafts so the whitelist survives a restart and is
    // visible cross-process (#3546). A persist failure is a tagged
    // ProfilingFailedError (reason: "persist_error") — surfaced as a typed
    // `error` outcome below, not a silent success on a non-durable layer.
    if (shouldPersist && opts.orgId !== undefined) {
      const persisted = yield* gen.persist({
        orgId: opts.orgId,
        connectionGroupId: opts.connectionGroupId ?? null,
        entities: result.entities,
        metrics: result.metrics,
      });
      return { result, persisted };
    }
    return { result, persisted: null };
  });

  const exit = await Effect.runPromiseExit(
    program.pipe(Effect.provide(SemanticGeneratorLive)),
  );
  if (exit._tag === "Success") {
    return {
      kind: "ok",
      result: exit.value.result,
      persisted: exit.value.persisted
        ? { entities: exit.value.persisted.entitiesPersisted, metrics: exit.value.persisted.metricsPersisted }
        : null,
    };
  }

  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "Some" && failure.value instanceof ProfilingFailedError) {
    return { kind: "error", reason: failure.value.reason, message: failure.value.message };
  }
  // Re-throw the ORIGINAL underlying error (not a wrapped one) so the MCP
  // layer can recognise an `OperationCancelledError` raised cooperatively from
  // the progress callback when the client cancels — wrapping it in a fresh
  // `Error` would erase that identity and surface a spurious internal_error.
  const original = causeToError(exit.cause);
  throw original instanceof Error
    ? original
    : new Error(`SemanticGenerator profile failed: ${Cause.pretty(exit.cause)}`);
}
