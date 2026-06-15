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
import type { HealthCheckResult, DBType } from "@atlas/api/lib/db/connection";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import {
  catalogSlugToDbType,
  resolveDatasourcePoolConfig,
  type DatasourcePoolConfig,
} from "@atlas/api/lib/db/datasource-pool-resolver";
import {
  findDatasourcePluginConnection,
  probePluginDatasourceConnection,
  probeNativeDatasourceConnection,
} from "@atlas/api/lib/db/datasource-registry-bridge";
import type { DatasourceProfiler } from "@atlas/api/lib/effect/semantic-generator";
import { decryptSecretFields, parseConfigSchema } from "@atlas/api/lib/plugins/secrets";
import { errorMessage, causeToError } from "@atlas/api/lib/audit/error-scrub";
import { getInstallHandler } from "@atlas/api/lib/integrations/install/dispatch";
import { FormInstallValidationError } from "@atlas/api/lib/integrations/install/persist-form-install";
import { registerBuiltinInstallHandlers } from "@atlas/api/lib/integrations/install/register";
import { OPENAPI_GENERIC_SLUG } from "@atlas/api/lib/openapi/catalog";
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
 * Capability resolution for a candidate provisioning target — the single
 * predicate that decides whether (and how) a catalog slug can be provisioned
 * over MCP (#3547 AC #1). Replaces the hardcoded `MCP_NATIVE_DB_TYPES` gate so
 * provisioning and (future #3552) profiling stay in lockstep as types are
 * added: a type is provisionable iff it is native pg/mysql OR a datasource
 * plugin implementing `createFromConfig` is registered for its dbType.
 *
 *   - `native`      — pg/mysql: pre-flight via the `connections.register` →
 *                     `healthCheck` ephemeral probe.
 *   - `plugin`      — clickhouse/snowflake/…: pre-flight via the plugin-aware
 *                     `createFromConfig` → `SELECT 1` → close probe.
 *   - `unsupported` — no native handler and no registered plugin (or an unknown
 *                     slug). `message` is actionable, carries no secret.
 */
export type ProvisionCapability =
  | { readonly kind: "native"; readonly dbType: McpNativeDbType }
  | { readonly kind: "plugin"; readonly dbType: string }
  | { readonly kind: "unsupported"; readonly dbType: string; readonly message: string };

function unsupportedProvisionMessage(catalogSlug: string): string {
  return (
    `Provisioning "${catalogSlug}" datasources via MCP is not supported in this deployment. ` +
    `Supported types: ${MCP_PROVISIONABLE_CATALOG_SLUGS.join(", ")} (plugin types require the ` +
    `corresponding datasource plugin to be installed). Use the Atlas admin console for other types.`
  );
}

export async function resolveProvisionCapability(
  catalogSlug: string,
): Promise<ProvisionCapability> {
  // Native fast path — the catalog slug IS the dbType for pg/mysql (the
  // `demo-postgres` slug maps to postgres but is NOT MCP-provisionable, and
  // falls through to the plugin lookup below, which finds no plugin → unsupported).
  if (isMcpNativeDbType(catalogSlug)) {
    return { kind: "native", dbType: catalogSlug };
  }
  // Map slug → dbType; an unknown slug is `unsupported`, never a throw.
  let dbType: string;
  try {
    dbType = catalogSlugToDbType(catalogSlug);
  } catch {
    // intentionally ignored: an unrecognised slug is a normal "unsupported"
    // provisioning outcome, surfaced as an actionable envelope — not a 500.
    return { kind: "unsupported", dbType: catalogSlug, message: unsupportedProvisionMessage(catalogSlug) };
  }
  // Plugin-managed: provisionable iff a plugin implementing `createFromConfig`
  // is registered for this dbType (the same lookup the install/probe paths use).
  const conn = await findDatasourcePluginConnection(dbType);
  if (conn && typeof conn.createFromConfig === "function") {
    return { kind: "plugin", dbType };
  }
  return { kind: "unsupported", dbType, message: unsupportedProvisionMessage(catalogSlug) };
}

// ── Profiling capability (#3620 — ADR-0017) ──────────────────────────

/**
 * Profiling-capability resolution — the SOURCE side of the profiler seam
 * (ADR-0017) that feeds `SemanticGenerator`'s `profileFn` injection point
 * (`effect/semantic-generator.ts:108`). Deliberately DERIVED from
 * {@link resolveProvisionCapability}: native/plugin/unsupported classification
 * comes from the EXACT same predicate provisioning uses (the one shared lookup,
 * {@link findDatasourcePluginConnection}), so the plugin that provisions a
 * datasource is the plugin that profiles it — provisioning and profiling stay in
 * lockstep, never a divergent second structural matcher.
 *
 *   - `native`      — pg/mysql: `SemanticGenerator` profiles these in-core
 *                     (`resolveProfiler`), so no `profileFn` is supplied.
 *   - `plugin`      — a registered datasource plugin that ALSO implements the
 *                     introspection contract (`connection.profile`). Carries the
 *                     `profileFn` the caller passes straight into
 *                     `SemanticGenerator.profile({ profileFn })`. `profile` is
 *                     structurally the host `DatasourceProfiler`, so no adapter.
 *   - `unsupported` — no plugin / unknown slug, OR a plugin that is provisionable
 *                     (`createFromConfig`) but does not implement `profile` yet.
 *                     Explicit + actionable — mirrors `SemanticGenerator`'s
 *                     fail-closed `unsupported_db_type`, never a silent skip.
 */
export type ProfileCapability =
  | { readonly kind: "native"; readonly dbType: McpNativeDbType }
  | { readonly kind: "plugin"; readonly dbType: string; readonly profileFn: DatasourceProfiler }
  | { readonly kind: "unsupported"; readonly dbType: string; readonly message: string };

function notProfilableMessage(dbType: string): string {
  return (
    `Datasource type "${dbType}" cannot be profiled in this deployment. No registered plugin ` +
    `implements the profiling contract (connection.profile) for it. Install or upgrade the ` +
    `corresponding datasource plugin, or profile it with the Atlas CLI (atlas init).`
  );
}

export async function resolveProfileCapability(
  catalogSlug: string,
): Promise<ProfileCapability> {
  // Classify by the SAME predicate provisioning uses — never a second matcher.
  const provision = await resolveProvisionCapability(catalogSlug);
  if (provision.kind === "native") {
    return { kind: "native", dbType: provision.dbType };
  }
  if (provision.kind === "unsupported") {
    return { kind: "unsupported", dbType: provision.dbType, message: provision.message };
  }
  // provision.kind === "plugin" — re-resolve the SAME plugin via the shared
  // lookup and check for the introspection half of the contract.
  return resolveProfileCapabilityByDbType(provision.dbType);
}

/**
 * Profiling-capability resolution keyed by an already-resolved `dbType` rather
 * than a catalog slug — the seam the in-product **wizard** consumes (#3621). The
 * wizard resolves a connection's `dbType` directly off its decrypted URL/config
 * (`detectDBType`), so it has no catalog slug to feed {@link resolveProfileCapability}.
 *
 * Stays in lockstep with provisioning/profiling by using the SAME single plugin
 * lookup ({@link findDatasourcePluginConnection}) and the SAME native predicate
 * ({@link isMcpNativeDbType}) the slug-keyed resolver uses — it is NOT a second
 * structural matcher, just the dbType-keyed entry into the one shared lookup
 * (ADR-0017). Returns:
 *   - `native`      — pg/mysql; `SemanticGenerator` profiles in-core (no `profileFn`).
 *   - `plugin`      — a registered datasource plugin implementing `connection.profile`;
 *                     carries the `profileFn` for `SemanticGenerator.profile({ profileFn })`.
 *   - `unsupported` — no registered plugin for the dbType, OR a plugin that does
 *                     not implement `profile` yet. Explicit + actionable, fail-closed.
 */
export async function resolveProfileCapabilityByDbType(
  dbType: string,
): Promise<ProfileCapability> {
  if (isMcpNativeDbType(dbType)) {
    return { kind: "native", dbType };
  }
  const conn = await findDatasourcePluginConnection(dbType);
  if (conn && typeof conn.profile === "function") {
    return { kind: "plugin", dbType, profileFn: conn.profile };
  }
  // No plugin for the dbType, or a plugin without the profiling half of the
  // contract — fail-closed and explicit (mirrors SemanticGenerator's
  // `unsupported_db_type`, never a silent empty result).
  return { kind: "unsupported", dbType, message: notProfilableMessage(dbType) };
}

/**
 * A `config_schema` field surfaced to the MCP edge so `create_datasource` can
 * drive its masked elicitation form (#3547 AC #4). Carries only the metadata the
 * form needs — never a value. {@link NON_CREDENTIAL_CONFIG_KEYS} (UI label +
 * write-governance fields) are excluded: they are NOT connection credentials, so
 * a secure "enter your credentials" prompt is the wrong place for them. A label
 * (`description`/`display_name`) is collected as a plain tool argument instead so
 * the agent can set it; write-governance fields default to read-only and are
 * configured via the admin console. The remaining connection/auth fields —
 * secret AND non-secret (e.g. ES `url`, the apikey-header name) — are elicited so
 * the agent never sees connection details.
 */
export interface ProvisionConfigField {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly required: boolean;
  readonly secret: boolean;
  /** A closed value set (catalog `select`) — drives an enum/dropdown in the form. */
  readonly options?: readonly string[];
  /** The catalog default, surfaced + injected when the client returns empty. */
  readonly default?: string;
}

/**
 * Catalog `config_schema` keys that must NEVER appear in the masked credential
 * elicitation form, because they are not connection credentials:
 *   - `description` / `display_name` — a human label (collected as a tool arg);
 *   - `schema` — the optional Postgres/MySQL/ClickHouse search_path; a
 *     non-secret routing hint, set by the agent as a tool arg, not typed into a
 *     "secure credential" box;
 *   - `write_allowlist` / `side_effecting_operations` — REST write-governance
 *     (JSON allowlists); provisioning lands read-only by default and these are
 *     configured via the admin console, not typed into a "secure credential" box.
 * Everything else in a schema is treated as connection/auth and elicited.
 */
const NON_CREDENTIAL_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "description",
  "display_name",
  "schema",
  "write_allowlist",
  "side_effecting_operations",
]);

export type LoadProvisionConfigFieldsResult =
  | { readonly kind: "ok"; readonly fields: ProvisionConfigField[]; readonly secretKeys: string[] }
  /** No catalog row for the slug (shouldn't happen after a capability check passes). */
  | { readonly kind: "not_found" }
  /** The catalog `config_schema` is absent/corrupt — an operator misconfig, fail closed. */
  | { readonly kind: "schema_error" };

/**
 * Load the `config_schema` for a provisionable datasource and shape its fields
 * for the MCP masked-elicitation form. Reads the SAME catalog row the installer
 * validates + encrypts against, so the elicited field set and the secret-field
 * set stay schema-driven (a new auth field propagates with zero MCP changes).
 */
export async function loadProvisionConfigFields(
  catalogSlug: string,
): Promise<LoadProvisionConfigFieldsResult> {
  if (!hasInternalDB()) return { kind: "not_found" };
  const rows = await internalQuery<{ config_schema: unknown }>(
    `SELECT config_schema FROM plugin_catalog WHERE slug = $1 AND enabled = true LIMIT 1`,
    [catalogSlug],
  );
  if (rows.length === 0) return { kind: "not_found" };
  const schema = parseConfigSchema(rows[0].config_schema);
  if (schema.state !== "parsed") return { kind: "schema_error" };

  const fields: ProvisionConfigField[] = [];
  const secretKeys: string[] = [];
  for (const f of schema.fields) {
    if (NON_CREDENTIAL_CONFIG_KEYS.has(f.key)) continue; // label / governance, not a credential
    const secret = f.secret === true;
    if (secret) secretKeys.push(f.key);
    fields.push({
      key: f.key,
      label: f.label ?? f.key,
      ...(f.description !== undefined ? { description: f.description } : {}),
      required: f.required === true,
      secret,
      // Carry select options + default so the masked form renders a dropdown
      // (with its default) rather than collapsing every field to free text.
      ...(Array.isArray(f.options) && f.options.length > 0 ? { options: f.options } : {}),
      ...(typeof f.default === "string" ? { default: f.default } : {}),
    });
  }
  return { kind: "ok", fields, secretKeys };
}

/**
 * Input to {@link provisionDatasource}. `config` carries the full set of
 * `config_schema` field values collected via masked elicitation at the MCP edge
 * (the secret fields among them are listed in `secretKeys`). Secret fields are
 * encrypted at the installer boundary and NEVER round-trip back out (the
 * returned row carries only a `maskedUrl` / masked fields). The shape is
 * credential-agnostic so url-shaped (pg/mysql/clickhouse/snowflake), apiKey-
 * shaped (Elasticsearch), and multi-field (BigQuery) datasources all flow
 * through one path (#3547).
 */
export interface ProvisionDatasourceInput {
  readonly catalogSlug: string;
  readonly installId: string;
  /**
   * All `config_schema` field values (secret + non-secret) keyed by field key —
   * e.g. `{ url }`, `{ url, apiKey }`, `{ service_account_json, project_id }`.
   * Passed verbatim to the installer (which encrypts the `secret: true` fields)
   * and to the pre-flight probe.
   */
  readonly config: Readonly<Record<string, unknown>>;
  /** Keys of `config` that are `secret: true` — scrubbed from any surfaced error. */
  readonly secretKeys: readonly string[];
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
function scrubSecretsFromMessage(message: string, secrets: readonly string[]): string {
  let scrubbed = message;
  for (const secret of secrets) {
    if (secret) scrubbed = scrubbed.split(secret).join("[redacted]");
  }
  return errorMessage(scrubbed);
}

/**
 * The plaintext secret values in a config (the `secretKeys` subset), for
 * scrubbing. Takes `(config, secretKeys)` so both the SQL provision path
 * ({@link ProvisionDatasourceInput}) and the REST path (a bare `formData`) reuse
 * it — there is exactly one definition of "which values must be redacted".
 */
function secretValues(
  config: Readonly<Record<string, unknown>>,
  secretKeys: readonly string[],
): string[] {
  return secretKeys
    .map((k) => config[k])
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** Result of a validate-before-persist pre-flight; `message` is already scrubbed. */
type PreflightResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * The config the probe + installer both consume — `input.config` verbatim. Built
 * in one place so the pre-flight probe tests EXACTLY what the installer persists.
 */
function buildProvisionFormData(input: ProvisionDatasourceInput): Record<string, unknown> {
  return { ...input.config };
}

/**
 * Native pg/mysql pre-flight — a thin caller over the shared
 * {@link probeNativeDatasourceConnection} seam (the native counterpart to the
 * plugin probe, #3605), symmetric to {@link preflightPluginConnection}. The
 * seam owns the ephemeral-probe-id register → healthCheck → unregister-in-finally
 * mechanics (and the `degraded`-counts-as-failure rule); this caller owns only
 * the friendly wording + secret scrub, so "which values must be redacted" stays
 * here in one place.
 */
async function preflightNativeConnection(input: ProvisionDatasourceInput): Promise<PreflightResult> {
  const secrets = secretValues(input.config, input.secretKeys);
  const url = typeof input.config.url === "string" ? input.config.url : "";
  const schema = typeof input.config.schema === "string" ? input.config.schema : undefined;
  const description = typeof input.config.description === "string" ? input.config.description : undefined;
  const outcome = await probeNativeDatasourceConnection({
    url,
    ...(description !== undefined ? { description } : {}),
    ...(schema !== undefined ? { schema } : {}),
  });
  if (outcome.ok) return { ok: true };
  // `unhealthy` carries the registry's (already DSN-scrubbed) healthCheck
  // message verbatim; `connect_error` carries the raw thrown driver error and
  // gets the actionable wrapper. Both are then secret-scrubbed here.
  const friendly =
    outcome.reason === "connect_error"
      ? `Connection test failed: ${outcome.message}. Verify the host, port, database, and credentials, then retry.`
      : outcome.message;
  return { ok: false, message: scrubSecretsFromMessage(friendly, secrets) };
}

/**
 * Plugin-managed pre-flight (#3547) — builds a throwaway connection via the
 * registered plugin's `createFromConfig` and runs a `SELECT 1` probe through
 * the shared {@link probePluginDatasourceConnection} seam, which closes the
 * probe connection regardless of outcome. Tests exactly the config the
 * installer will persist (`buildProvisionFormData`). A missing plugin
 * (`no_plugin`) shouldn't normally reach here — `resolveProvisionCapability`
 * already gated it — but is handled defensively. The raw driver error is
 * scrubbed of every secret field value before it returns.
 */
async function preflightPluginConnection(
  dbType: string,
  input: ProvisionDatasourceInput,
): Promise<PreflightResult> {
  const outcome = await probePluginDatasourceConnection(dbType, buildProvisionFormData(input));
  if (outcome.ok) return { ok: true };
  const friendly =
    outcome.reason === "no_plugin"
      ? outcome.message
      : `Connection test failed: ${outcome.message}. Verify the connection details and credentials, then retry.`;
  return { ok: false, message: scrubSecretsFromMessage(friendly, secretValues(input.config, input.secretKeys)) };
}

/**
 * Provision a new datasource over MCP: validate the dbType is provisionable
 * → pre-flight health-check the candidate connection WITHOUT persisting →
 * on success install it as a `draft` (credential encrypted by the installer)
 * → return the masked row. On any failure nothing is persisted and the
 * ephemeral pool is rolled back.
 *
 * The secret fields in `input.config` only flow in here and into the
 * installer's encrypt-at-rest path; they are never returned, logged, or placed
 * in an error (every secret value is scrubbed from any surfaced message).
 */
export async function provisionDatasource(
  orgId: string,
  input: ProvisionDatasourceInput,
): Promise<ProvisionDatasourceOutcome> {
  // Capability-derived gate (#3547 AC #1) — native pg/mysql OR a plugin-managed
  // type with a registered `createFromConfig`. Anything else is an actionable
  // `unsupported` envelope (no secret).
  const capability = await resolveProvisionCapability(input.catalogSlug);
  if (capability.kind === "unsupported") {
    return { kind: "unsupported", message: capability.message };
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

  // Validate-before-persist pre-flight: native via the ephemeral
  // ConnectionRegistry probe, plugin via the plugin-aware
  // `createFromConfig → SELECT 1 → close` probe. Either way nothing is
  // persisted and no pool survives a failure (the credential never leaks — the
  // message is scrubbed before it returns).
  const preflight =
    capability.kind === "native"
      ? await preflightNativeConnection(input)
      : await preflightPluginConnection(capability.dbType, input);
  if (!preflight.ok) {
    return { kind: "health_error", message: preflight.message };
  }

  // Pre-flight OK → persist as draft. The installer re-registers idempotently
  // and encrypts the secret fields per the catalog config_schema.
  const formData = buildProvisionFormData(input);
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
      message: scrubSecretsFromMessage(outcome.message, secretValues(input.config, input.secretKeys)),
    };
  }
  return { kind: "ok", value: outcome.value };
}

// ── REST / OpenAPI provisioning (#3547) ───────────────────────────────
//
// REST datasources do NOT flow through the native/plugin `createFromConfig`
// path — they're the `openapi-generic` form-install handler, which PROBES the
// OpenAPI spec on install and caches a normalized snapshot (no separate
// pre-flight: a probe failure surfaces as a field validation error and persists
// nothing). So MCP REST provisioning calls the SAME form handler the admin
// `/install-form` route calls (ADR-0016 — the lib seam, not the route),
// `getInstallHandler(openapi-generic).validateConfig`, rather than
// `provisionDatasource`.

export type ProvisionRestOutcome =
  | { readonly kind: "ok"; readonly installId: string }
  /** Spec-probe / field validation failed — nothing persisted. `message` is secret-scrubbed. */
  | { readonly kind: "validation"; readonly message: string };

/**
 * Provision a generic OpenAPI/REST datasource over MCP. Routes the elicited
 * `formData` (openapi_url + auth fields, the credential among them) through the
 * `openapi-generic` form-install handler, which validates + probes the spec and
 * persists the snapshot as a new multi-instance install. A
 * {@link FormInstallValidationError} (bad URL, auth, or a failed probe) becomes
 * a typed `validation` outcome with the secret values scrubbed; any other throw
 * re-throws for the caller's `internal_error` path.
 */
export async function provisionRestDatasource(
  orgId: string,
  formData: Readonly<Record<string, unknown>>,
  secretKeys: readonly string[],
): Promise<ProvisionRestOutcome> {
  // Idempotent (latch-guarded) — ensures the openapi-generic form handler is
  // registered even in a process that didn't run the full app-boot wiring.
  registerBuiltinInstallHandlers();
  const handler = getInstallHandler({ slug: OPENAPI_GENERIC_SLUG, install_model: "form" });
  if (handler.kind !== "form") {
    // Registration drift — a non-form handler under a form slug. Re-throw so the
    // MCP caller surfaces an internal_error (parity with the admin route's 501).
    throw new Error(`openapi-generic install handler is misregistered (kind=${handler.kind}).`);
  }

  const secrets = secretValues(formData, secretKeys);

  try {
    const { installRecord } = await handler.validateConfig(orgId as WorkspaceId, formData);
    return { kind: "ok", installId: installRecord.id };
  } catch (err) {
    if (err instanceof FormInstallValidationError) {
      const parts = [
        ...err.formErrors,
        ...Object.entries(err.fieldErrors).map(([k, v]) => `${k}: ${v.join(", ")}`),
      ];
      const message = parts.length > 0 ? parts.join("; ") : "Invalid REST datasource configuration.";
      return { kind: "validation", message: scrubSecretsFromMessage(message, secrets) };
    }
    // Re-throw for the caller's internal_error path, but SCRUB the secret values
    // (auth_value, etc.) first — an unexpected handler error can echo the elicited
    // credential in its message, which the MCP dispatch logs + surfaces verbatim.
    // Deliberately do NOT attach `{ cause: err }`: the original error carries the
    // UNSCRUBBED message, and a cause chain is serialized by loggers — re-attaching
    // it would re-introduce the exact credential this scrub removes.
    const raw = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line preserve-caught-error -- attaching the raw cause would leak the scrubbed credential (see above)
    throw new Error(scrubSecretsFromMessage(raw, secrets));
  }
}

// ── Profiling / semantic-gen (#3512) ──────────────────────────────────

/** Resolved profiling target — internal use only; `url` is the decrypted secret. */
export interface DatasourceProfileTarget {
  readonly url: string;
  /**
   * The datasource dialect. Widened from the native pg/mysql set to the full
   * {@link DBType} (#3552): a plugin-managed type (clickhouse / snowflake / …)
   * is profilable too, via the injected {@link profileFn} below.
   */
  readonly dbType: DBType;
  readonly schema?: string;
  /**
   * The registry-resolved plugin profiler (#3552 / ADR-0017), or `undefined`
   * for native pg/mysql (which `SemanticGenerator` profiles in-core via
   * `resolveProfiler`). Resolved off the SAME predicate provisioning uses
   * (`resolveProfileCapability` → `findDatasourcePluginConnection`), so the
   * plugin that provisions a datasource is the plugin that profiles it. Passed
   * straight into `SemanticGenerator.profile({ profileFn })` — no adapter.
   */
  readonly profileFn?: DatasourceProfiler;
  /**
   * The install's connection-group scope (`workspace_plugins.config.group_id`),
   * or `null` for an ungrouped install. Carried so the persistence step
   * (#3546) lands the generated entities under the SAME `connection_group_id`
   * the whitelist loader reads — a group-of-one for a standalone MCP-created
   * datasource. This is metadata (a group name), never a secret.
   */
  readonly connectionGroupId: string | null;
  /**
   * The install's resolved, DECRYPTED connection config (ADR-0017 amendment).
   * Carried so the registry-resolved `profileFn` of a separate-field-credential
   * plugin (Elasticsearch — `apiKey`/`username`/`password`/SigV4 live in config
   * fields, NOT in the `url`) profiles with the TENANT's own credentials rather
   * than falling back to operator `ATLAS_ES_*` env (the per-tenant-creds rule).
   * Url-embedded plugin profilers (ClickHouse/Snowflake) and the native pg/mysql
   * profiler ignore it.
   *
   * SECURITY: like `url`, this is DECRYPTED secret material — internal use only,
   * it never leaves the lib layer / reaches the agent / is logged. The caller
   * passes it straight into `runSemanticProfile` → `SemanticGenerator.profile`.
   */
  readonly config: Readonly<Record<string, unknown>>;
}

export type LoadProfileTargetResult =
  | { readonly kind: "ok"; readonly target: DatasourceProfileTarget }
  | { readonly kind: "not_found" }
  | { readonly kind: "unsupported"; readonly dbType: string; readonly message: string };

/**
 * Resolve the `url` the profiler seam passes to the resolved `profileFn`.
 *
 * - URL-shaped pool configs (native pg/mysql, clickhouse/snowflake/elasticsearch)
 *   return their `url` directly.
 * - BigQuery is multi-field / non-url-shaped: its credentials live in SEPARATE
 *   config fields (`service_account_json`), never a connection string. The host
 *   carries the decrypted `config` (the ADR-0017 amendment), and the BigQuery
 *   profiler authenticates from it — but the seam contract is still
 *   `url: string`, so synthesize a `bigquery://<project>` identifier from the
 *   pool config. The synthetic url is a routing/identifier hint only; the
 *   profiler reads credentials from `config`, never from this url (#3664).
 * - Everything else with no url (duckdb file path, salesforce OAuth) returns
 *   `undefined` and stays fail-closed in its own slice.
 */
function resolveProfileUrl(poolConfig: DatasourcePoolConfig): string | undefined {
  if ("url" in poolConfig && typeof poolConfig.url === "string" && poolConfig.url.length > 0) {
    return poolConfig.url;
  }
  if (poolConfig.dbType === "bigquery" && poolConfig.projectId.length > 0) {
    return `bigquery://${encodeURIComponent(poolConfig.projectId)}`;
  }
  return undefined;
}

/**
 * Load + decrypt a datasource install's connection config and shape the
 * profiling target the semantic generator needs.
 *
 * Profilability is decided by the SAME capability predicate provisioning uses
 * — {@link resolveProfileCapability} (in lockstep, #3547 AC #1 / ADR-0017) —
 * NOT a hardcoded pg/mysql discriminant. Native pg/mysql profile in-core (no
 * `profileFn`); a plugin-managed type carries the registry-resolved `profileFn`;
 * anything with no plugin / no `connection.profile` resolves to `unsupported`
 * with an actionable message.
 *
 * Returns `not_found` for an unknown install. The decrypted `url` never leaves
 * the lib layer — the caller passes it straight to the profiler.
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

  // Profilability is driven by the SAME capability predicate provisioning uses
  // (the one shared `findDatasourcePluginConnection` lookup), so provisioning
  // and profiling stay in lockstep as types are added (#3547 AC #1 / ADR-0017).
  // Native pg/mysql → no profileFn (SemanticGenerator profiles in-core); a
  // plugin type → the registry-resolved profileFn; no plugin / no
  // `connection.profile` → an actionable `unsupported`.
  const capability = await resolveProfileCapability(row.catalog_slug);
  if (capability.kind === "unsupported") {
    return { kind: "unsupported", dbType: capability.dbType, message: capability.message };
  }

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
  // The profiler seam passes a `url: string` to the resolved `profileFn` (and to
  // the in-core pg/mysql profiler). Native pg/mysql and the url-bearing plugin
  // pool configs (clickhouse / snowflake / elasticsearch) carry one directly. A
  // multi-field-credential type (bigquery) carries its connection in SEPARATE
  // config fields, not a url — the host carries the decrypted `config` (the
  // ADR-0017 amendment that already lets ES authenticate from tenant config) and
  // the plugin profiler builds the connection from it; we synthesize a url so
  // the seam's `url: string` contract holds and logs/identifiers stay meaningful
  // (#3664). Types with neither a url nor a config-credential profiler path
  // (duckdb file path, salesforce OAuth) stay fail-closed in their own slices.
  const url = resolveProfileUrl(poolConfig);
  if (typeof url !== "string" || url.length === 0) {
    return {
      kind: "unsupported",
      dbType: poolConfig.dbType,
      message:
        `Profiling "${poolConfig.dbType}" datasources via MCP is not supported yet — its ` +
        `connection is not URL-shaped. Profile it with the Atlas CLI (atlas init), or use a ` +
        `URL-shaped datasource type.`,
    };
  }
  return {
    kind: "ok",
    target: {
      url,
      dbType: poolConfig.dbType,
      schema: "schema" in poolConfig ? poolConfig.schema : undefined,
      ...(capability.kind === "plugin" ? { profileFn: capability.profileFn } : {}),
      connectionGroupId,
      // Decrypted tenant config (ADR-0017 amendment): carried so a
      // separate-field-credential plugin profiler (ES) authenticates with the
      // tenant's own creds, not operator env. NEVER leaves the lib layer.
      config: decrypted,
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
  /**
   * Datasource dialect. Widened from the native pg/mysql set (#3552): a
   * plugin-managed type is profilable via the injected {@link profileFn}.
   */
  dbType: DBType;
  schema?: string;
  /**
   * Registry-resolved plugin profiler (#3552 / ADR-0017). Required for a
   * plugin dbType (core profiles only pg/mysql in-core); omit for native
   * pg/mysql. Passed straight into `SemanticGenerator.profile({ profileFn })`.
   */
  profileFn?: DatasourceProfiler;
  /**
   * The datasource's resolved, DECRYPTED connection config (ADR-0017 amendment).
   * Forwarded into `SemanticGenerator.profile({ config })` so a
   * separate-field-credential plugin profiler (Elasticsearch) authenticates with
   * the tenant's own creds rather than operator env. Ignored by native pg/mysql
   * and url-embedded plugin profilers (ClickHouse/Snowflake). SECURITY: decrypted
   * secret material — never logged or surfaced to the agent.
   */
  config?: Readonly<Record<string, unknown>>;
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
    // When persist will run, defer in-memory whitelist registration until AFTER
    // persist succeeds (#3589). A persist failure otherwise leaves the connection
    // queryable in-process (split-brain: executeSQL accepts it, but the entities
    // aren't durable and won't survive a restart). When there's nothing to persist
    // (no orgId / no internal DB) the in-memory whitelist IS the only durability
    // mechanism, so register immediately as before.
    const result = yield* gen.profileAndGenerate({
      url: opts.url,
      dbType: opts.dbType,
      ...(opts.schema !== undefined ? { schema: opts.schema } : {}),
      // Inject the registry-resolved plugin profiler (#3552). `resolveProfiler`
      // ignores it for pg/mysql (in-core), so passing `undefined` for native
      // types is a no-op; a plugin type requires it.
      ...(opts.profileFn !== undefined ? { profileFn: opts.profileFn } : {}),
      // Forward the decrypted tenant config (ADR-0017 amendment) so a
      // separate-field-credential / non-url-shaped plugin profiler (ES,
      // BigQuery — #3664) authenticates with the tenant's own creds, not
      // operator env. Native + url-embedded profilers ignore it. Never logged.
      ...(opts.config !== undefined ? { config: opts.config } : {}),
      connectionId: opts.connectionId,
      registerWhitelist: !shouldPersist,
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
      // Persist succeeded: now safe to register the in-memory whitelist so
      // subsequent in-process executeSQL calls are permitted (#3589).
      const connectionId = opts.connectionId ?? "default";
      gen.registerWhitelist(connectionId, result.entities);
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
