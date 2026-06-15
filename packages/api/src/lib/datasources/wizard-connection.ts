/**
 * One profiler home for the in-product onboarding wizard (#3657, ADR-0017
 * §Amendment(#3667)).
 *
 * The wizard's `/wizard/profile`, `/wizard/generate`, and `/wizard/enrich`
 * routes used to each re-derive their OWN connection resolution
 * (`resolveConnectionUrl` → `{ url, dbType, schema, config }`) and then their own
 * profiler seam (`resolveWizardProfiler` → native positional shims OR the
 * plugins' `connection`-namespace `listObjects`/`profile` exports, threading
 * url/config by hand). That was the SECOND profiling home — a parallel resolver +
 * a parallel introspection surface from the one MCP converged onto in #3670.
 *
 * This module collapses that prologue into ONE context resolver built on the
 * SAME connection resolution MCP uses ({@link resolveLiveConnection}): a SaaS
 * datasource resolves to a live, authenticated connection whose
 * `listObjects`/`profile` are a capability OF the connection, bound to the creds
 * that built it. `/profile` reads `listObjects`, `/generate` + `/enrich` read
 * `profile` — straight off the resolved connection, no url/config threading and
 * no per-call native signature adaptation.
 *
 * SaaS is the primary path. The env-var (`ATLAS_DATASOURCE_URL`) `default` /
 * `__demo__` fast path is a self-hosted/dev BYPRODUCT — those identities have no
 * `workspace_plugins` row, so {@link resolveLiveConnection} returns `not_found`
 * for them and the clearly-labeled byproduct fallback below builds an equivalent
 * live connection from the env URL. The core SaaS + MCP resolver stays pristine.
 *
 * Lives in `lib/` (not a route) so `lib/ must not import api/routes/` holds:
 * `api/routes/wizard.ts` imports DOWN into this helper.
 */

import { detectDBType, connections, type DBType } from "@atlas/api/lib/db/connection";
import {
  listPostgresObjects,
  listMySQLObjects,
  profilePostgres,
  profileMySQL,
} from "@atlas/api/lib/profiler";
import { DEMO_CONNECTION_ID } from "@atlas/api/lib/semantic/entities";
import type { LiveDatasourceConnection } from "@atlas/api/lib/datasources/mcp-lifecycle";

/**
 * Resolved wizard profiling context — a live connection (introspection bound to
 * its creds) plus the metadata the routes' responses need. The route reads
 * `connection.listObjects` (`/profile`) or `connection.profile` (`/generate`,
 * `/enrich`) off this; it never threads a url/config or adapts a native
 * signature.
 */
export type WizardConnectionContext =
  | {
      readonly kind: "ok";
      readonly connection: LiveDatasourceConnection;
      readonly dbType: DBType;
      /**
       * The effective schema for the response wire shape (`schema:
       * querySchema ?? "public"`). Native Postgres → configured schema or
       * `"public"`; a plugin dbType (ClickHouse database, ES index) → configured
       * schema or `undefined` (the plugin applies its own default rather than a
       * literal `"public"`). MySQL ignores schema either way.
       */
      readonly querySchema: string | undefined;
    }
  | { readonly kind: "not_found" }
  | { readonly kind: "unsupported"; readonly message: string }
  | { readonly kind: "reconnect_required"; readonly message: string };

/**
 * Apply the dbType-specific schema default for the wizard response wire shape.
 * Native Postgres defaults a missing schema to `"public"` (its canonical default
 * search-path). A plugin dbType where `"public"` is meaningless passes the
 * configured schema through, or `undefined` when none was set, so the plugin
 * uses its OWN default. MySQL ignores schema either way (#3621 review).
 */
function effectiveSchema(dbType: DBType, schema: string | null | undefined): string | undefined {
  if (dbType === "postgres") return schema ?? "public";
  return schema ?? undefined;
}

/**
 * Resolve the wizard's profiling context for a connection. SaaS-first: rides
 * {@link resolveLiveConnection} (workspace-scoped, then the global config row),
 * falling back to the env-var byproduct only when neither matches.
 */
export async function resolveWizardConnection(
  connectionId: string,
  orgId: string | null | undefined,
): Promise<WizardConnectionContext> {
  // ── SaaS primary: the workspace_plugins → live-connection spine ───────
  // Lazy-import the resolver so the heavy `mcp-lifecycle` graph (workspace-
  // installer, semantic-generator, Effect layers) stays OUT of the wizard route's
  // static module-load path — mirroring how the prior `resolveWizardProfiler`
  // lazy-imported it. Keeps partial-`mock.module` route tests loading cleanly.
  const { resolveLiveConnection } = await import("@atlas/api/lib/datasources/mcp-lifecycle");

  // Workspace-scoped first, then the global (`__global__`) config row — the
  // same priority `resolveConnectionUrl` used (workspace wins over global).
  for (const scope of orgId ? [orgId, "__global__"] : ["__global__"]) {
    const live = await resolveLiveConnection(scope, connectionId);
    if (live.kind === "ok") {
      return {
        kind: "ok",
        connection: live.connection,
        dbType: live.connection.dbType,
        querySchema: effectiveSchema(live.connection.dbType, live.defaultSchema),
      };
    }
    if (live.kind === "unsupported") return { kind: "unsupported", message: live.message };
    if (live.kind === "reconnect_required") return { kind: "reconnect_required", message: live.message };
    // `not_found` for this scope — try the next (or fall through to env-var).
  }

  // ── Byproduct (self-hosted/dev): the ATLAS_DATASOURCE_URL fast path ───
  // `default` (config-managed) and `__demo__` (#1474) are seeded onboarding
  // identities with NO workspace_plugins row. Build an equivalent live
  // connection from the env URL so the dev demo keeps profiling. Gated on
  // `connections.has` (the registry hydrated the identity at boot) — the SAME
  // gate the pre-convergence env-var fallback used, so a hand-crafted id can't
  // profile ATLAS_DATASOURCE_URL on a server that never seeded the demo. Other
  // underscore-prefixed ids are intentionally excluded (the wizard frontend
  // filters them out; the backend mirrors that).
  if (
    (connectionId === "default" || connectionId === DEMO_CONNECTION_ID) &&
    process.env.ATLAS_DATASOURCE_URL &&
    connections.has(connectionId)
  ) {
    return buildEnvVarLiveConnection(connectionId, process.env.ATLAS_DATASOURCE_URL);
  }

  return { kind: "not_found" };
}

/**
 * BYPRODUCT: build a live connection from a bare env-var URL. Core
 * {@link detectDBType} resolves `ATLAS_DATASOURCE_URL` to pg/mysql only — every
 * other scheme is a plugin that installs through Admin → Connections (a
 * `workspace_plugins` row the SaaS path above already serves), so this env-var
 * fast path is native-only by construction (unchanged from the pre-convergence
 * `resolveConnectionUrl` env-var branch, which called `detectDBType` identically).
 */
function buildEnvVarLiveConnection(
  connectionId: string,
  url: string,
): WizardConnectionContext {
  let dbType: DBType;
  try {
    dbType = detectDBType(url);
  } catch (err) {
    // Non-pg/mysql ATLAS_DATASOURCE_URL — surface detectDBType's actionable,
    // secret-free remediation (install the plugin / connect via the admin console).
    return {
      kind: "unsupported",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // The wizard never queries through the resolved connection (it only lists /
  // profiles); route `query` to the registry pool for this id so the surface is
  // still correct if a future caller uses it.
  const connection: LiveDatasourceConnection = {
    dbType,
    connectionGroupId: null,
    query: (sql, timeoutMs) => connections.get(connectionId).query(sql, timeoutMs),
    listObjects: (o) =>
      dbType === "mysql"
        ? listMySQLObjects({ url, logger: o?.logger })
        : listPostgresObjects({ url, schema: o?.schema ?? "public", logger: o?.logger }),
    profile: (o) =>
      dbType === "mysql"
        ? profileMySQL({ url, selectedTables: o.selectedTables, prefetchedObjects: o.prefetchedObjects, progress: o.progress, logger: o.logger })
        : profilePostgres({ url, schema: o.schema ?? "public", selectedTables: o.selectedTables, prefetchedObjects: o.prefetchedObjects, progress: o.progress, logger: o.logger }),
    close: async () => {
      // Native profilers own their own throwaway pools; nothing to tear down.
    },
  };
  return { kind: "ok", connection, dbType, querySchema: dbType === "postgres" ? "public" : undefined };
}
