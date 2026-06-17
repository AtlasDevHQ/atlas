# ADR-0020: Plugin initialization moves into the Effect Layer boot DAG with a type-level Migration dependency

**Status:** Accepted
**Date:** 2026-06-17
**Context milestone:** Performance-aware Atlas follow-up — structural fix for #3741 (tracked in #3743)
**Depends on:** [ADR-0013](./0013-db-stored-plugin-datasource-connections.md) (DB-stored plugin datasource connections / `loadSavedConnections`)

## Context

Plugin lifecycle (`register → plugin-schema-migrate → initialize → wire datasources/actions/context/interactions → MCP tools → cache backend`) ran **imperatively in `server.ts` BEFORE** the Effect Layer DAG (`buildAppLayer`) that runs `MigrationLive`. A plugin's `initialize()` can read a core (migration-created) table — the chat adapter's operator-credential resolver reads `operator_integration_credentials` (migration 0140, #3704). On the *first* boot where new code and a new migration land together, plugin init raced ahead of the migration, hit a not-yet-created table, and aborted (one-shot, no retry), taking the chat adapter down across all prod regions while `/health` still returned 200. That was the #3741 incident, cutting `v0.0.17`.

The targeted fix (#3744) made the race non-fatal: an early idempotent `runBootMigrations()` call in `server.ts` before plugin init, plus a `42P01` (undefined-table) carve-out in the resolver. But ordering was still enforced **by hand** — a correctly-placed imperative call. Any refactor that moved or removed that call silently reintroduced the whole race class.

An audit of every plugin's `initialize()` and the boot guards confirmed the chat adapter is the only init-time core-table read; `wireDatasourcePlugins` itself is DB-free at wiring time (DB-stored connections load later in `ConnectionsHydrate`, which already gated on `Migration`).

## Decision

**Move plugin registration/init/wiring into the boot DAG as `makeWiredPluginRegistryLive`, gated at the TYPE LEVEL on the `Migration` Tag (and `ConnectionRegistry`). In the production boot DAG the compiler now guarantees core migrations run before any plugin `initialize()` — the race can no longer be reintroduced by moving an imperative call. (The stdio-MCP boot and the operator-credential `refresh()` path run plugin init outside this DAG; they remain covered by the resolver's `42P01` carve-out — see Consequences.)**

Concretely:

- **`Migration` Tag moves to `services.ts`** (from `layers.ts`) so the wired plugin layer can depend on it without importing the heavyweight boot module. `MigrationLive` (the implementation) stays in `layers.ts` and is re-exported.
- **`MigrationLive` now runs `runBootMigrations()` (schema only)**, not the full `migrateAuthTables()`. The post-schema bootstrap (`loadPluginSettings`, abuse restore, admin bootstrap, dev seed) is extracted to `runPostMigrationBootstrap()` and runs as **`AuthBootstrapLive`**, which depends on the wired plugin layer — so `loadPluginSettings`'s `registry.disable()` still runs AFTER plugin wiring, preserving the established order (wiring's `getByType` filters on `enabled`, so a DB-disabled datasource plugin stays wired-then-disabled exactly as before).
- **New ordering edges:** `ConnectionsHydrate` now also depends on `PluginRegistry` (DB-stored datasource plugins must be registered before `loadSavedConnections` builds their pools via the global registry); `PluginConfigGuardLive` gains the same edge (it validates stored configs against the registered registry); a new `PoolWarmupLive` replaces the imperative `connections.warmup()`, running after both config and DB-stored connections register.
- **Global singletons are wrapped, not replaced:** the wired layer registers into the global `plugins` (`createImpl: () => plugins`) and the `ConnectionRegistry` Tag binds the global `connections` (`makeConnectionRegistryLive(() => connections, { manageLifecycle: false })`). The rest of the app, `loadSavedConnections`, and the guards all read those globals, so a fresh instance would make plugin datasources invisible. `manageLifecycle: false` avoids double-forking the health fiber the global already starts in `initializeConfig` and double-running its shutdown.
- **`server.ts`** retains only the construction of the plugin context object + tool registry (the DAG inputs) and passes them as `buildAppLayer(config, pluginWiring)`. Plugin `teardownAll()` is now the wired layer's scope finalizer (the imperative call is removed; the 10s teardown timeout now guards the whole `runtime.dispose()`).

## Consequences

- The #3741 boot race cannot be reintroduced in the production boot DAG: `makeWiredPluginRegistryLive` cannot be constructed without a `Migration` dependency. A compile-time test (`@ts-expect-error`) pins the type edge.
- **The `Migration` Tag gates on outcome, not just ordering.** The wired layer reads `migration.error`: a core migration that was *attempted and failed* (half-applied schema) **fails the Layer fatally** so the supervisor restarts and retries migrations, rather than initializing plugins against a missing table and leaning on the resolver carve-out. `migrated: false` with **no** `error` (no `DATABASE_URL` — a stateless self-host boot) is a legitimate boot and proceeds to init. This mirrors `MigrationGuardLive`'s promote-soft-failure-to-fatal stance and makes the type-level edge back a real runtime guarantee in both deploy modes.
- The #3744 defenses are reconsidered: the early `runBootMigrations()` call is **removed** (subsumed by the type-level edge — it lived inside the retired imperative block); the resolver's **`42P01` carve-out is kept** as defense-in-depth, because the stdio-MCP boot (`plugins/mcp-boot.ts`, a separate process) and the operator-credential `refresh()` path do not go through this DAG.
- Plugin schema-migration failure stays **fatal** (the wired layer fails the Layer → server exits), matching the prior imperative `process.exit(1)`.
- A plugin health-check fiber now runs at boot (the wired layer's `buildPluginService`) — previously unused; this is the intended P5 behavior.
- Pool warmup now also warms DB-hydrated connections (it runs after `ConnectionsHydrate`) — strictly more complete than the pre-#3743 imperative call.
- **Out of scope:** `plugins/mcp-boot.ts` (stdio MCP) keeps its own lightweight init; it is a separate process, not the API boot DAG.
