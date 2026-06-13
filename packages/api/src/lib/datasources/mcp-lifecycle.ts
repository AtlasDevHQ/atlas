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
import { CONTENT_MODE_TABLES, makeService } from "@atlas/api/lib/content-mode";
import { connections } from "@atlas/api/lib/db/connection";
import type { HealthCheckResult } from "@atlas/api/lib/db/connection";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { catalogSlugToDbType } from "@atlas/api/lib/db/datasource-pool-resolver";
import {
  WorkspaceInstaller,
  WorkspaceInstallerLive,
  mapInstallError,
  type WorkspaceInstallerShape,
  type InstallError,
} from "@atlas/api/lib/effect/workspace-installer";

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
