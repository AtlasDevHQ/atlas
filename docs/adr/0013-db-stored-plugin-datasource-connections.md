# ADR-0013: DB-stored plugin datasource connections via `createFromConfig`

**Status:** Accepted
**Date:** 2026-06-06
**Context milestone:** Staging Environment (#57) — staging datasource matrix (#3253)
**Depends on:** [ADR-0006](./0006-three-pillar-integration-taxonomy.md) (three-pillar datasource taxonomy), [ADR-0007](./0007-unified-install-pipeline.md) (datasource pillar / `workspace_plugins`)

## Context

Datasource adapters beyond the two core engines (Postgres, MySQL) were extracted into plugins (`@useatlas/clickhouse`, `@useatlas/snowflake`, `@useatlas/bigquery`, `@useatlas/duckdb`, `@useatlas/salesforce`, `@useatlas/elasticsearch`). That package extraction is its own refactor (not formally ADR'd); ADR-0006 established the datasource pillar those plugins live under. Core `@atlas/api` deliberately does **not** import those packages — `db/connection.ts`'s `detectDBType` / `createConnection` switch on postgres/mysql only and throw "this adapter is now a plugin" for anything else (`connection.test.ts:124` codifies that boundary).

A plugin datasource could be wired two ways, but only one worked:

1. **Static, config-defined** — `clickhousePlugin({ url })` in `atlas.config.ts` → boot-time `wireDatasourcePlugins()` calls the plugin's nullary `connection.create()` (closing over the config-time url) and registers one connection via `connections.registerDirect()`. **Worked.**
2. **DB-stored, admin-UI-registered** — a `workspace_plugins` row (`pillar='datasource'`, `db_type='clickhouse'`, encrypted url). At boot `loadSavedConnections()` and at install time `WorkspaceInstaller.installDatasource()` both route through `datasource-registry-bridge.ts`, which resolved + validated the row and then **`return false`'d for any dbType that wasn't postgres/mysql** (`registerDatasourceInstall`). The row persisted but no connection was ever registered, so `executeSQL` fell through to the core `createConnection` switch and threw `Unsupported database URL scheme "clickhouse://"`. **Broken — silently.**

So the admin UI offered ClickHouse/Snowflake/etc. as connectable datasource types (catalog rows seeded by migration 0093), customers could fill in the form and save, but every query failed. The runtime seam between a DB-stored plugin row and the plugin's connection factory was never built.

The blocker surfaced while provisioning a multi-engine datasource matrix in staging (#3253): a ClickHouse instance was deployed and seeded, but connecting it through the admin UI failed with the scheme error.

## Decision

**Datasource plugins gain an optional `connection.createFromConfig(config)` factory; the bridge looks the plugin up in the registry by `dbType` and builds a per-(workspace, install_id) connection from the DB-stored config. Core stays decoupled from the plugin packages — the lookup goes through the `PluginRegistry`, not a core import.**

Concretely:

- **SDK (`@useatlas/plugin-sdk`)** — `AtlasDatasourcePlugin["connection"]` gains an optional
  `createFromConfig(config: Readonly<Record<string, unknown>>): Promise<PluginDBConnection> | PluginDBConnection`.
  Purely additive — `create()` (the static, config-time factory) is unchanged and still required, so existing plugins compile untouched. Unlike `create()` (nullary, closes over config-time config), `createFromConfig` accepts the decrypted per-install config and re-validates it with the plugin's own schema.
- **Plugins** — each datasource plugin implements `createFromConfig` by re-parsing the runtime config through its existing `configSchema` and delegating to its existing connection factory (e.g. `createClickHouseConnection`). ClickHouse ships first (tracer); the other five follow.
- **Core `ConnectionRegistry`** — a new `workspacePluginEntries` map holds a live connection per (workspace, install_id) for plugin dbTypes (they can't be cloned by the core `createConnection` switch the way native configs are). New methods `registerDirectForWorkspace` / `hasDirectForWorkspace` / `unregisterDirectForWorkspace`; `getForWorkspace` and the metadata getters (`getDBType` / `getTargetHost` / `getValidator` / `getParserDialect` / `getForbiddenPatterns`) consult plugin entries first. The plugin's validator / parser dialect / forbidden patterns ride on the entry so SQL validation stays correct per dialect.
- **Bridge (`datasource-registry-bridge.ts`)** — for plugin dbTypes, `registerDatasourceInstall` (now async) lazy-imports the `PluginRegistry`, finds the registered datasource plugin whose `connection.dbType` matches, calls `createFromConfig(decryptedConfig)`, and registers the result via `registerDirectForWorkspace`. If no plugin is registered for the dbType (or it lacks `createFromConfig`) it throws a clear "add the plugin to atlas.config.ts" error — caught + logged per-row at boot, surfaced to the admin on the install path.
- **Deploy config** — registering the plugin in `atlas.config.ts`'s `plugins` array is what makes its adapter available to the bridge. Staging registers `clickhousePlugin({ url })` conditionally on a staging env var (`ATLAS_STAGING_CLICKHOUSE_URL`); an unset env never trips the plugin's required-url schema, and prod is unaffected.

## Alternatives considered

### Core dbType→factory switch that `require()`s the plugin packages (rejected)

A `plugin-connection-factory.ts` in core with a `switch (dbType)` that dynamically `require()`s `@useatlas/clickhouse/connection` etc. Smallest diff (no SDK change), and the packages are present in the deploy image. **Rejected:** it reintroduces a core→plugin dependency direction that the adapter-to-plugin extraction deliberately removed and that `connection.test.ts:124` codifies. The registry-based seam keeps `config.plugins` as the contract ("add it to the plugins array", which the error message already promised) and lets the operator gate which datasource types are enabled.

### Make `connection.create()` accept a runtime config (rejected)

Overload the existing nullary `create()` to optionally take a config. **Rejected:** muddies the two distinct call sites (static boot wiring vs. DB-driven per-install) and is a more disruptive change to the existing `create()` contract than adding a separate optional method.

### url-optional `configSchema` so `clickhousePlugin()` registers adapter-only (deferred)

The cleanest "every plugin in config, no static url" shape, but it requires changing every plugin's `configSchema` (url → optional) and teaching `wireDatasourcePlugins` to skip adapter-only instances. Deferred as a follow-up — staging has real connection URLs, so the conditional-static-url wiring above suffices for now. Generalizing to prod / no-static-instance hosts is tracked separately.

## Consequences

- DB-stored (admin-UI-registered) plugin datasources connect end-to-end once the plugin is in `config.plugins`. ClickHouse first; Snowflake / BigQuery / DuckDB / Salesforce / Elasticsearch are mechanical follow-up slices (each implements `createFromConfig` + gets wired into the deploy config).
- `registerDatasourceInstall` is now async; both callers (`loadSavedConnections`, `WorkspaceInstaller`) await it (the Effect callers bridge via `Effect.tryPromise`).
- Multi-tenant routing holds: two workspaces sharing an install_id get independent plugin connections keyed by (workspace, install_id).
- A plugin row whose adapter isn't registered fails loud (clear error) instead of silently — boot logs per-row; the admin install path surfaces it.
- The admin UI offering a datasource type whose plugin isn't deployed remains a separate UX gap (the type picker is catalog-driven, independent of `config.plugins`) — out of scope here, worth a follow-up.
