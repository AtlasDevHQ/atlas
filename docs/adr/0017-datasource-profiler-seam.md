# ADR-0017: Plugin datasource profiler seam (registry-resolved, capability-derived)

**Status:** Proposed — pending maintainer sign-off (#3620 HITL gate before the seam API freezes); flip to Accepted on merge
**Date:** 2026-06-14
**Context milestone:** v0.0.16 — In-Product Datasource Onboarding (Profiler Seam) (#66)
**Depends on:** [ADR-0013](./0013-db-stored-plugin-datasource-connections.md) (`createFromConfig` adapter seam), [ADR-0012](./0012-group-scoped-semantic-layer-directories.md) (group-scoped semantic layer)
**Implements:** PRD #3303 (spine), issue #3620

## Context

A datasource plugin (`@useatlas/clickhouse`, `@useatlas/snowflake`, `@useatlas/bigquery`, …) can be **connected** in-product on SaaS — ADR-0013 gave it `connection.createFromConfig`, and #3547/#3553 made it provisionable over MCP. But once connected, only Postgres and MySQL could be **onboarded** (profiled → semantic layer). Every other datasource hit *"Wizard profiling is currently supported for PostgreSQL and MySQL."* On hosted Atlas — where customers have no CLI — the loop **add datasource → generate semantic layer → ask questions** dead-ended at step 2 for every plugin datasource.

Two pieces of the foundation already shipped and must not be rebuilt:

1. **The consuming half — `SemanticGenerator` (#3506).** `effect/semantic-generator.ts` already exposes the exact injection point a seam needs: the `DatasourceProfiler` type, a `profileFn?` option, and `resolveProfiler` — Postgres/MySQL in-core, injected otherwise, with an explicit fail-closed `unsupported_db_type` outcome (never a silent skip). The engine that turns profiles into group-scoped entity/metric YAML is shared and already `dbType`-aware.

2. **The provisioning resolver — `resolveProvisionCapability` (#3553).** `lib/datasources/mcp-lifecycle.ts` classifies a catalog slug as `native | plugin | unsupported` from one predicate: *is it native pg/mysql, or does a registered datasource plugin implement `createFromConfig`?* The plugin lookup itself lives in one place — `findDatasourcePluginConnection(dbType)` (`datasource-registry-bridge.ts`), a structural `PluginRegistry.getAll()` match that core uses **without importing any plugin package** (the core↔plugin decoupling ADR-0013 established).

What was missing was the **source** side: nothing resolved a plugin's profiler off the registry to fill `SemanticGenerator`'s `profileFn`, and the SDK `connection` contract had no introspection surface to resolve.

The original PRD #3303 sketched this as a standalone `resolveDatasourceProfiler(dbType)` doing its **own** registry shape-match. After #3553 that is the wrong shape: it would be a second structural matcher that could drift from provisioning — a datasource provisionable over MCP but matched differently for profiling.

## Decision

**Add an optional introspection half (`listObjects` / `profile`) to the SDK `connection` contract, and resolve a plugin's `profile` off the registry with a capability resolver DERIVED from the provisioning one — so the plugin that provisions a datasource is the plugin that profiles it, by one shared predicate. Core never imports a plugin package; the profiler flows into `SemanticGenerator`'s existing injection point unchanged.**

Concretely:

- **SDK (`@useatlas/plugin-sdk`)** — `AtlasDatasourcePlugin["connection"]` gains optional `listObjects(options)` and `profile(options)`, alongside the existing build (`create` / `createFromConfig`) and guard (`validate` / `parserDialect` / `forbiddenPatterns`) capabilities. The profiler types (`PluginDatabaseObject`, `PluginTableProfile`, `PluginProfilingResult`, …) are **structural mirrors** of the canonical `@useatlas/types` profiler contracts, inlined the same way `PluginDBConnection` mirrors the core `DBConnection` — so the SDK stays free of a runtime dependency on `@useatlas/types`/`@atlas/api`. Both are **optional and additive**: a query-only datasource omits them and the host degrades to its explicit `unsupported_db_type` outcome. `validatePluginShape` enforces "function when provided." Published-contract change → `@useatlas/plugin-sdk` version bump under **publish-before-ref-bump** discipline (consumer refs bump in a follow-up PR after publish).

- **Profiler-options shape matches the injection point.** `profile(options)` takes `{ url, schema?, selectedTables?, prefetchedObjects?, progress?, logger? }` — field-for-field aligned with `SemanticGenerator`'s `DatasourceProfiler`, so the registry-resolved seam feeds a plugin's `profile` with **no impedance mismatch and no adapter**. `listObjects(options)` takes `{ url, schema? }` and returns the discovered objects (also usable as `prefetchedObjects` to avoid a second catalog round-trip).

- **Capability resolver — `resolveProfileCapability` (`mcp-lifecycle.ts`), derived from `resolveProvisionCapability`.** It calls the provisioning resolver, takes its `native | plugin | unsupported` classification verbatim, and for a `plugin` re-resolves the **same** plugin via the **same** `findDatasourcePluginConnection` lookup and checks for `connection.profile`. The native/plugin/unsupported decision is therefore one predicate, shared with provisioning — not a second matcher. Returns:
  - `native` — pg/mysql; `SemanticGenerator` profiles in-core, so no `profileFn`.
  - `plugin` — carries `profileFn` (the plugin's `profile`, structurally a `DatasourceProfiler`) for the caller to pass into `SemanticGenerator.profile({ profileFn })`.
  - `unsupported` — no plugin / unknown slug, **or** a plugin that is provisionable (`createFromConfig`) but does not implement `profile` yet. Explicit, actionable, fail-closed — mirroring `SemanticGenerator`'s `unsupported_db_type`, never a silent empty result.

- **Structural shape in core.** `DatasourceConnectionShape` (`datasource-registry-bridge.ts`) — the single home for "what a datasource plugin connection looks like to core" — gains optional `listObjects?` and `profile?: DatasourceProfiler`, matched structurally off the registry. No plugin import crosses into `@atlas/api`.

- **Profiling logic lives in the plugin package.** Each datasource's `listObjects`/`profile` lives in its plugin and is exposed on `connection`; the API consumes it via the registry-resolved capability, the CLI consumes the same export directly. **ClickHouse ships first as the tracer bullet** (`plugins/clickhouse/src/profiler.ts`), running every query through the connection's `readonly: 1` path so profiling honors the read-only posture and never echoes credentials.

- **Group scoping preserved (ADR-0012).** Generated entities for any `dbType` land in the Connection-group namespace via `SemanticGenerator.persist`'s `connectionGroupId` — unchanged by this seam.

## Alternatives considered

### Standalone `resolveDatasourceProfiler(dbType)` with its own shape-match (rejected)

The original PRD shape: a new resolver doing its own structural `PluginRegistry` match. **Rejected** — it is a second structural matcher parallel to `resolveProvisionCapability`/`findDatasourcePluginConnection`, so provisioning and profiling could drift (a type provisionable over MCP but resolved differently for profiling). Deriving from the provisioning resolver keeps "which plugin handles this dbType" in exactly one place.

### Config-record `profile(config, tableNames)` instead of url-based options (rejected for the spine)

The PRD sketched `profile(config)`. **Rejected for this spine** in favor of matching `SemanticGenerator`'s existing url-based `DatasourceProfiler` injection point exactly — so the resolved `profileFn` is a no-adapter pass-through and the CLI profilers (already url-based) port mechanically. Datasources whose connection is genuinely multi-field rather than a single URL (Snowflake account, BigQuery project + service-account JSON) are handled in their per-`dbType` slices, which may extend the options shape; the spine does not pre-build for them.

### Make `listObjects`/`profile` required on the contract (rejected)

**Rejected** — it would break every existing datasource plugin and forbid query-only datasources. Optional + additive preserves backward compatibility and lets the host degrade gracefully to the explicit unsupported outcome.

### Core dynamically `require()`s the plugin's profiler (rejected)

Same reasoning as ADR-0013's rejected core→plugin `require()` switch: it reintroduces the dependency direction the plugin extraction removed. Resolution stays structural off the registry.

## Consequences

- A plugin datasource that implements `connection.profile` is profilable through the shared engine wherever the seam is consumed; ClickHouse is the proven tracer. Snowflake, DuckDB, Salesforce, Elasticsearch, and net-new **BigQuery** are mechanical follow-up slices (each moves its profiler into the plugin + exposes it on `connection`).
- Provisioning and profiling cannot drift: both classify a datasource by the same predicate and the same `findDatasourcePluginConnection` lookup. A datasource provisionable over MCP is profiled by the same plugin or fails closed with an explicit reason.
- The published `@useatlas/plugin-sdk` contract grows (optional surface, version-bumped). Plugin authors now have one `connection` object describing a datasource's full capability surface: build + guard + introspect.
- Consuming the seam (wizard dispatch refactor, MCP profiling surface #3552, CLI profiler consolidation, web UI gate removal) is **out of scope here** — this ADR records the spine (SDK contract + registry-resolved source + ClickHouse tracer). Those land on top of it.
- `datasource-registry-bridge.ts` and `mcp-lifecycle.ts` take a type-only import of `DatasourceProfiler` from `effect/semantic-generator` (erased at runtime — no new runtime coupling or cycle).
- **The SDK profiler mirrors are hand-maintained, by design.** Because the SDK takes no dependency on `@useatlas/types` (or `@atlas/api`), there is deliberately no compile-time tie between `PluginProfilingResult` & co. and their canonical sources — a cross-package type assertion would reintroduce the very dependency the mirror exists to avoid. Parity is the cost of the decoupling: when a profiler type changes in `@useatlas/types` (e.g. a new `SemanticType` member), the SDK mirror must be updated in the same change. The seam tolerates this because the consuming boundary is structural — drift surfaces as a type error at the plugin that uses the new field, not as silent data loss.
