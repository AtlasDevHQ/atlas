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
} from "@atlas/api/lib/db/datasource-pool-resolver";
import {
  findDatasourcePluginConnection,
  isHandlerManagedDatasourceDbType,
  probePluginDatasourceConnection,
  probeNativeDatasourceConnection,
} from "@atlas/api/lib/db/datasource-registry-bridge";
import type {
  DatasourceProfiler,
  LiveConnectionListOptions,
  LiveConnectionProfileOptions,
} from "@atlas/api/lib/effect/semantic-generator";
import {
  profilePostgres,
  profileMySQL,
  listPostgresObjects,
  listMySQLObjects,
} from "@atlas/api/lib/profiler";
import { lazyPluginLoader } from "@atlas/api/lib/plugins/lazy-loader";
import type { DatabaseObject, ProfilingResult } from "@useatlas/types";
import { decryptSecretFields, parseConfigSchema } from "@atlas/api/lib/plugins/secrets";
import { createLogger } from "@atlas/api/lib/logger";
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
import { ProfilingFailedError, IntegrationReconnectRequiredError } from "@atlas/api/lib/effect/errors";
import type { ProfileProgressCallbacks } from "@atlas/api/lib/profiler";

const log = createLogger("datasources:mcp-lifecycle");

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

// ── Profilability proxy (#3620 / #3667 — ADR-0017) ───────────────────

/**
 * Profilability classification for a `dbType` — a cheap (no connection build)
 * proxy for what `profile_datasource` accepts, used by the MCP `create_datasource`
 * success hint. Since profiling now rides the unified {@link resolveLiveConnection}
 * and introspection is a capability of the BUILT connection (#3667), "profilable"
 * is treated as "connectable": native pg/mysql, or a registered plugin that builds
 * a connection (`createFromConfig`).
 *
 * CAVEAT — this is a PROXY, not a guarantee. The SDK's `PluginDBConnection`
 * genuinely permits a connectable-but-not-profilable plugin (a query-only
 * datasource whose built connection omits `profile`/`listObjects`), so
 * "connectable ⇒ profilable" is NOT enforced by the type system here. It holds by
 * a runtime/test-enforced invariant instead: every SHIPPED plugin's built
 * connection exposes both introspection methods, and the enforcement tests
 * (`universal-profiling-enforcement.test.ts` positive,
 * `one-profiler-home.test.ts` negative) keep it that way. A hint computed from
 * this proxy could therefore over-promise for a hypothetical query-only plugin —
 * but {@link resolveLiveConnection} fails closed at profile time for that case, so
 * the worst outcome is an optimistic hint, never a silent bad profile. The
 * trade-off buys avoiding a throwaway connection build just to read a hint.
 *
 * Uses the SAME single plugin lookup ({@link findDatasourcePluginConnection}) and
 * native predicate ({@link isMcpNativeDbType}) provisioning uses, so the two can
 * never drift.
 */
export type ProfileCapability =
  | { readonly kind: "native"; readonly dbType: McpNativeDbType }
  | { readonly kind: "plugin"; readonly dbType: string }
  | { readonly kind: "unsupported"; readonly dbType: string; readonly message: string };

function notProfilableMessage(dbType: string): string {
  return (
    `Datasource type "${dbType}" cannot be profiled in this deployment. No registered plugin ` +
    `builds a connection for it. Install or upgrade the corresponding datasource plugin, ` +
    `or profile it with the Atlas CLI (atlas init).`
  );
}

/**
 * Resolve the profilability of an already-resolved `dbType`. Returns:
 *   - `native`      — pg/mysql; profiled in-core.
 *   - `plugin`      — a registered datasource plugin that builds a connection
 *                     (`createFromConfig`); its built connection carries the
 *                     introspection capability (#3667).
 *   - `unsupported` — no native handler and no registered plugin. Explicit +
 *                     actionable, fail-closed.
 */
export async function resolveProfileCapabilityByDbType(
  dbType: string,
): Promise<ProfileCapability> {
  if (isMcpNativeDbType(dbType)) {
    return { kind: "native", dbType };
  }
  const conn = await findDatasourcePluginConnection(dbType);
  if (conn && typeof conn.createFromConfig === "function") {
    return { kind: "plugin", dbType };
  }
  // No native handler and no registered plugin that builds a connection —
  // fail-closed and explicit (never a silent empty result).
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

// ── ONE RESOLVER: resolveLiveConnection (#3667) ───────────────────────
//
// The single host-side resolver that returns a LIVE, authenticated connection
// for a workspace datasource by dispatching across ALL transports/pillars using
// the SAME resolution querying uses:
//
//   - native pg/mysql       → ConnectionRegistry (`connections.getForOrg`)
//   - url/config plugins    → the plugin's `createFromConfig` (ClickHouse,
//                             Snowflake, BigQuery, Elasticsearch, …)
//   - OAuth integrations    → the `LazyPluginLoader` (Salesforce — ADR-0014,
//                             NO `createFromConfig`/pool registration)
//
// Introspection (`listObjects` / `profile`) is a CAPABILITY of the resolved
// connection (#3667), bound to whatever creds built it — the profiler consumes
// THIS connection instead of re-deriving its own narrower notion of "how do I
// reach this datasource" (the URL-shape gate that failed BigQuery #3664 and
// Salesforce #3663 closed). A new transport inherits profiling for free; there
// is no gate left to fail closed.

/**
 * A live, authenticated datasource connection with introspection as a
 * first-class capability. The query surface (`query`) and the introspection
 * surface (`listObjects` / `profile`) are both bound to the creds that resolved
 * the connection — neither re-resolves auth from a url/config.
 *
 * SECURITY: this is built from DECRYPTED credentials / OAuth tokens. The
 * connection object itself never leaves the lib layer and carries no plaintext
 * secret on its surface (the bound creds are captured in closures); its outputs
 * (columns/rows, profiles, object names) are non-secret.
 */
export interface LiveDatasourceConnection {
  readonly dbType: DBType;
  /** The install's connection-group scope (`null` for an ungrouped install). Metadata, never a secret. */
  readonly connectionGroupId: string | null;
  query(sql: string, timeoutMs?: number): Promise<{ columns: string[]; rows: Record<string, unknown>[] }>;
  listObjects(options?: LiveConnectionListOptions): Promise<DatabaseObject[]>;
  profile(options: LiveConnectionProfileOptions): Promise<ProfilingResult>;
  close(): Promise<void>;
}

export type ResolveLiveConnectionResult =
  | {
      readonly kind: "ok";
      readonly connection: LiveDatasourceConnection;
      /**
       * The connection's CONFIGURED schema/database/dataset scope — the
       * `workspace_plugins` config schema (`poolSchema`) — or `undefined` when
       * none was configured / it's not meaningful (MySQL, OAuth). This is the
       * configured scope, NOT the fully-resolved effective scope: the canonical
       * dialect default (Postgres → `"public"`) is applied DOWNSTREAM by the
       * consumer ({@link WizardConnectionContext}'s `effectiveSchema`), not baked
       * in here. Surfaced so the in-product wizard, which rides this same resolver
       * (one profiler home), can report the schema in its response without
       * re-deriving its own connection resolution. The MCP profiling path ignores
       * it. (Always present on the `ok` variant so every `ok` branch must decide.)
       */
      readonly defaultSchema: string | undefined;
    }
  | { readonly kind: "not_found" }
  /** No transport can build a live connection for this type (no plugin / no introspection / unknown). */
  | { readonly kind: "unsupported"; readonly dbType: string; readonly message: string }
  /** An OAuth datasource whose tokens are stale/revoked — actionable reconnect, not a silent failure. */
  | { readonly kind: "reconnect_required"; readonly dbType: string; readonly message: string };

/** Structural shape of an OAuth lazy instance that supports introspection (Salesforce — #3667 slice 5). */
interface ProfilableOAuthInstance {
  query(sql: string, timeoutMs?: number): Promise<{ columns: readonly string[]; rows: readonly Record<string, unknown>[] }>;
  listObjects?(options?: LiveConnectionListOptions): Promise<DatabaseObject[]>;
  profile?(options: LiveConnectionProfileOptions): Promise<ProfilingResult>;
  teardown?(): Promise<void>;
}

/**
 * Actionable prompt for an OAuth datasource whose tokens are stale/revoked.
 * Shared by both reconnect paths — connection resolution ({@link
 * resolveLiveConnection}, when the install is already marked reconnect_needed)
 * AND mid-profile ({@link profileLiveDatasource}, when the token is revoked
 * between resolution and the first introspection call) — so the agent sees the
 * identical reconnect guidance regardless of WHERE the token failure surfaces.
 */
function reconnectRequiredMessage(dbType: string): string {
  return (
    `The ${dbType} connection needs to be reconnected before it can be profiled. ` +
    `Reconnect it in Admin → Integrations, then retry.`
  );
}

function notProfilableLiveMessage(dbType: string): string {
  return (
    `Datasource type "${dbType}" cannot be profiled in this deployment. No registered plugin ` +
    `builds a live connection exposing the introspection capability (connection.profile + ` +
    `connection.listObjects) for it. ` +
    `Install or upgrade the corresponding datasource plugin, or profile it with the Atlas CLI (atlas init).`
  );
}

/**
 * Resolve a live, authenticated connection for `(orgId, installId)` across all
 * transports. Profiling (and any future capability) consumes this — it must NOT
 * re-derive its own connection resolution.
 *
 * Returns `not_found` for an unknown install, `unsupported` when no transport
 * can build a profilable connection (actionable, no secret), and
 * `reconnect_required` when an OAuth datasource's tokens are stale (the agent
 * surfaces a specific "reconnect" prompt rather than a silent failure).
 */
export async function resolveLiveConnection(
  orgId: string,
  installId: string,
): Promise<ResolveLiveConnectionResult> {
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
        -- An archived install is a per-workspace hide tombstone (0094 / #2744):
        -- it must read as not_found so neither the MCP profile_datasource tool
        -- nor the in-product wizard (both ride this one resolver) can profile a
        -- datasource the workspace removed. This restores the status-archived
        -- filter the pre-convergence wizard resolver carried; list_datasources
        -- excludes archived too, so an archived datasource being unprofilable is
        -- consistent end-to-end.
        AND wp.status != 'archived'
      LIMIT 1`,
    [orgId, installId],
  );
  if (rows.length === 0) return { kind: "not_found" };
  const row = rows[0];

  const schema = parseConfigSchema(row.config_schema);
  if (schema.state === "corrupt") {
    // Breadcrumb only — `decryptSecretFields` fails closed on a corrupt schema
    // (it attempts to decrypt every string value), so profiling can still
    // proceed, but a malformed `config_schema` (DB drift / SDK skew / manual
    // ops edit) is the kind of silent root cause that makes a profile-over-MCP
    // outage undiagnosable. Mirror the breadcrumb `loadProvisionConfigFields`
    // emits on the write path. No credential material is logged.
    log.error(
      { orgId, installId, catalogSlug: row.catalog_slug, reason: schema.reason },
      "resolveLiveConnection: catalog config_schema is corrupt — credential field mapping is degraded",
    );
  }
  const decrypted = decryptSecretFields(row.config ?? {}, schema);
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
  const dbType = poolConfig.dbType;
  const poolSchema = "schema" in poolConfig ? poolConfig.schema : undefined;
  const poolUrl = "url" in poolConfig && typeof poolConfig.url === "string" ? poolConfig.url : "";

  // ── OAuth / handler-managed (Salesforce) — the LazyPluginLoader path ──
  // ADR-0014: NO `createFromConfig` / pool registration. The connection is
  // built from `integration_credentials` tokens, refreshed inline.
  if (isHandlerManagedDatasourceDbType(dbType)) {
    let instance: ProfilableOAuthInstance;
    try {
      instance = (await lazyPluginLoader.getOrInstantiate(
        orgId,
        row.catalog_id,
      )) as unknown as ProfilableOAuthInstance;
    } catch (err) {
      // A stale/revoked OAuth install surfaces as a specific reconnect prompt
      // (the lazy builder throws IntegrationReconnectRequiredError when the
      // install is marked reconnect_needed). `IntegrationReconnectRequiredError`
      // is a core error class (lib/effect/errors), so `instanceof` is sturdier
      // than a `.name` string-match (a rename then fails at compile time, not
      // silently). NOTE: this only covers a token failure at RESOLUTION time;
      // a token revoked mid-profile is mapped by `profileLiveDatasource`.
      if (err instanceof IntegrationReconnectRequiredError) {
        return { kind: "reconnect_required", dbType, message: reconnectRequiredMessage(dbType) };
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (typeof instance.profile !== "function" || typeof instance.listObjects !== "function") {
      return { kind: "unsupported", dbType, message: notProfilableLiveMessage(dbType) };
    }
    const profile = instance.profile.bind(instance);
    const listObjects = instance.listObjects.bind(instance);
    return {
      kind: "ok",
      // OAuth datasources (Salesforce/SOQL) have no schema/database scope.
      defaultSchema: undefined,
      connection: {
        dbType,
        connectionGroupId,
        query: async (sql, timeoutMs) => {
          const { columns, rows: r } = await instance.query(sql, timeoutMs);
          return { columns: [...columns], rows: [...r] };
        },
        listObjects: (options) => Promise.resolve(listObjects(options)),
        profile: (options) => profile(options),
        close: async () => {
          if (typeof instance.teardown === "function") await instance.teardown();
        },
      },
    };
  }

  // ── Native pg/mysql — the ConnectionRegistry path ─────────────────────
  if (isMcpNativeDbType(dbType)) {
    const effectiveSchema = (opts?: { schema?: string }) =>
      opts?.schema ?? poolSchema ?? (dbType === "postgres" ? "public" : undefined);
    return {
      kind: "ok",
      defaultSchema: poolSchema,
      connection: {
        dbType,
        connectionGroupId,
        query: (sql, timeoutMs) => connections.getForOrg(orgId, installId).query(sql, timeoutMs),
        listObjects: (options) =>
          dbType === "mysql"
            ? listMySQLObjects({ url: poolUrl, logger: options?.logger })
            : listPostgresObjects({ url: poolUrl, schema: effectiveSchema(options), logger: options?.logger }),
        profile: (options) =>
          dbType === "mysql"
            ? profileMySQL({
                url: poolUrl,
                selectedTables: options.selectedTables,
                prefetchedObjects: options.prefetchedObjects,
                progress: options.progress,
                logger: options.logger,
              })
            : profilePostgres({
                url: poolUrl,
                schema: effectiveSchema(options),
                selectedTables: options.selectedTables,
                prefetchedObjects: options.prefetchedObjects,
                progress: options.progress,
                logger: options.logger,
              }),
        close: async () => {
          // Registry-managed pool — not torn down by the caller.
        },
      },
    };
  }

  // ── url/config plugins — the createFromConfig path ────────────────────
  const conn = await findDatasourcePluginConnection(dbType);
  if (!conn || typeof conn.createFromConfig !== "function") {
    return { kind: "unsupported", dbType, message: notProfilableLiveMessage(dbType) };
  }
  const built = await conn.createFromConfig(decrypted);

  // Introspection is a capability of the BUILT connection (#3667), bound to the
  // creds `createFromConfig` resolved — NO host shim re-resolving auth from a
  // url/config. Both halves of the introspection surface are required to be
  // profilable: `profile` (column/row analysis) AND `listObjects` (the table
  // picker's enumeration). A connection missing EITHER is fail-closed and
  // actionable — symmetric with the OAuth path above (which gates on both), and
  // never a silent empty table list (a `listObjects`-less connection would have
  // rendered "0 tables" in the wizard, reading as an empty database). `poolSchema`
  // provides the dialect-default scope (ClickHouse database, BigQuery dataset)
  // when the caller passes none.
  if (typeof built.profile !== "function" || typeof built.listObjects !== "function") {
    // The built connection is a real (lazy) client/pool — close it before
    // bailing so a query-only plugin doesn't leak a connection on every
    // profile attempt (the OK path closes via the caller's `finally`; this
    // early return has no caller-side close). Best-effort: a close failure
    // must not mask the actionable `unsupported` outcome.
    await built.close().catch(() => {
      // intentionally ignored: tearing down an unprofilable throwaway connection.
    });
    return { kind: "unsupported", dbType, message: notProfilableLiveMessage(dbType) };
  }
  const builtProfile = built.profile.bind(built);
  const builtListObjects = built.listObjects.bind(built);
  const profile = (o: LiveConnectionProfileOptions): Promise<ProfilingResult> =>
    builtProfile({ ...o, ...(o.schema === undefined && poolSchema !== undefined ? { schema: poolSchema } : {}) });
  const listObjects = (o?: LiveConnectionListOptions): Promise<DatabaseObject[]> =>
    Promise.resolve(
      builtListObjects({ ...(o?.schema !== undefined ? { schema: o.schema } : poolSchema !== undefined ? { schema: poolSchema } : {}) }),
    );

  return {
    kind: "ok",
    defaultSchema: poolSchema,
    connection: {
      dbType,
      connectionGroupId,
      query: async (sql, timeoutMs) => {
        const out = (await built.query(sql, timeoutMs)) as { columns: string[]; rows: Record<string, unknown>[] };
        return out;
      },
      listObjects,
      profile,
      close: () => built.close(),
    },
  };
}

// ── Profiling / semantic-gen (#3512, #3667) ──────────────────────────

export type RunSemanticProfileOutcome =
  | {
      readonly kind: "ok";
      readonly result: ProfileAndGenerateResult;
      /**
       * Durable-persistence counts (#3546). Present when an `orgId` was supplied
       * AND an internal DB is configured (entities upserted as drafts to
       * `semantic_entities`); `null` when persistence was skipped (the in-memory
       * whitelist is the only registration, e.g. a self-hosted stdio server).
       */
      readonly persisted: { readonly entities: number; readonly metrics: number } | null;
    }
  | { readonly kind: "error"; readonly reason: ProfilingFailedError["reason"]; readonly message: string }
  /**
   * An OAuth datasource (Salesforce) whose token was revoked / could not be
   * refreshed mid-profile (#3667). Surfaced as a distinct outcome — not a
   * generic `error` — so the MCP tool renders the SAME actionable reconnect
   * prompt the resolution-time `resolveLiveConnection` reconnect path does,
   * rather than a bare "Profiling failed".
   */
  | { readonly kind: "reconnect_required"; readonly dbType: string; readonly message: string };

/**
 * Profile a RESOLVED LIVE CONNECTION (#3667) and generate its semantic layer via
 * the #3506 `SemanticGenerator`, registering the generated entities into the
 * in-process table whitelist (so a subsequent in-process `executeSQL` is
 * permitted) and — when an `orgId` is supplied and an internal DB is configured —
 * DURABLY persisting the generated entities + metrics to the org semantic store
 * as drafts (#3546).
 *
 * The connection comes from {@link resolveLiveConnection}: the profiler RIDES the
 * query path's connection resolution rather than re-deriving its own (the bug
 * class that bit BigQuery #3664 and Salesforce #3663). The injected
 * `SemanticGenerator` profiler is a thin ADAPTER that delegates to the live
 * connection's bound `profile()` — its url/config args are inert because the
 * connection is already authenticated. So there is no `url`/`config`/`profileFn`
 * threading here, and no URL-shape gate: a connectable type is profilable by
 * construction.
 *
 * The caller owns the connection lifecycle (it `close()`s after profiling). A
 * tagged `ProfilingFailedError` is returned as a typed `error` outcome; an
 * unexpected defect re-throws for the caller's `internal_error` path.
 */
export async function profileLiveDatasource(opts: {
  connection: LiveDatasourceConnection;
  /**
   * Connection-group identifier — the whitelist key + entity `connection:` field.
   * The MCP `profile_datasource` tool passes the datasource install id.
   */
  connectionId: string;
  /** Optional profiling schema/database/dataset override. Omit for the connection's default. */
  schema?: string;
  /**
   * Workspace the generated rows belong to. When provided (and an internal DB is
   * configured) the generated layer is persisted as drafts; when omitted, only
   * the in-memory whitelist is populated.
   */
  orgId?: string;
  progress?: ProfileProgressCallbacks;
}): Promise<RunSemanticProfileOutcome> {
  const shouldPersist = opts.orgId !== undefined && hasInternalDB();
  const conn = opts.connection;

  // The seam (#3667): `SemanticGenerator`'s url-based `DatasourceProfiler`
  // injection point delegates to the resolved live connection's bound
  // `profile()`. The `url`/`config` args are ignored — the connection is already
  // authenticated and bound to its creds — so profiling consumes the connection
  // instead of re-resolving auth.
  const profileFn: DatasourceProfiler = (args) =>
    conn.profile({
      ...(args.schema !== undefined ? { schema: args.schema } : {}),
      ...(args.selectedTables !== undefined ? { selectedTables: args.selectedTables } : {}),
      ...(args.prefetchedObjects !== undefined ? { prefetchedObjects: args.prefetchedObjects } : {}),
      ...(args.progress !== undefined ? { progress: args.progress } : {}),
      ...(args.logger !== undefined ? { logger: args.logger } : {}),
    });

  const program = Effect.gen(function* () {
    const gen = yield* SemanticGenerator;
    // Defer in-memory whitelist registration until AFTER persist succeeds when
    // persisting (#3589) — a persist failure otherwise leaves the connection
    // queryable in-process but not durable (split-brain).
    const result = yield* gen.profileAndGenerate({
      // `url` is not load-bearing — the profiler adapter delegates to the bound
      // connection. Pass empty so the seam's `url: string` contract holds.
      url: "",
      dbType: conn.dbType,
      ...(opts.schema !== undefined ? { schema: opts.schema } : {}),
      profileFn,
      connectionId: opts.connectionId,
      registerWhitelist: !shouldPersist,
      ...(opts.progress !== undefined ? { progress: opts.progress } : {}),
    });

    if (shouldPersist && opts.orgId !== undefined) {
      const persisted = yield* gen.persist({
        orgId: opts.orgId,
        connectionGroupId: conn.connectionGroupId,
        entities: result.entities,
        metrics: result.metrics,
      });
      gen.registerWhitelist(opts.connectionId, result.entities);
      return { result, persisted };
    }
    return { result, persisted: null };
  });

  const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(SemanticGeneratorLive)));
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
  // #3667 — an OAuth token revoked mid-profile is surfaced by `profileImpl` as a
  // DEFECT (so its identity survives the generic `ProfilingFailedError` wrap),
  // recovered here via `causeToError`. Map it to `reconnect_required` so the
  // agent gets the actionable reconnect prompt rather than a bare "Profiling
  // failed" — the token's first API call lands here, not at connection
  // resolution, so this is the only place to catch the common revocation path.
  const original = causeToError(exit.cause);
  if (original instanceof IntegrationReconnectRequiredError) {
    return { kind: "reconnect_required", dbType: conn.dbType, message: reconnectRequiredMessage(conn.dbType) };
  }
  // Re-throw the ORIGINAL underlying error (not a wrapped one) so the MCP layer
  // can recognise an `OperationCancelledError` raised cooperatively from the
  // progress callback when the client cancels.
  throw original instanceof Error
    ? original
    : new Error(`SemanticGenerator profile failed: ${Cause.pretty(exit.cause)}`);
}
