# ADR-0017: Plugin datasource profiler seam (registry-resolved, capability-derived)

**Status:** Accepted (maintainer sign-off via PR #3638 merge — #3620 HITL gate)
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

- **Profiler-options shape matches the injection point.** `profile(options)` takes `{ url, schema?, selectedTables?, prefetchedObjects?, progress?, logger?, config? }` — field-for-field aligned with `SemanticGenerator`'s `DatasourceProfiler`, so the registry-resolved seam feeds a plugin's `profile` with **no impedance mismatch and no adapter**. `listObjects(options)` takes `{ url, schema? }` and returns the discovered objects (also usable as `prefetchedObjects` to avoid a second catalog round-trip). The `config` field is the **separate-field-credentials amendment** documented in *Amendment (#3552)* below.

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
- Consuming the seam (MCP profiling surface #3552, CLI profiler consolidation) is **out of scope here** — this ADR records the spine (SDK contract + registry-resolved source + ClickHouse tracer). Those land on top of it. The **in-product wizard dispatch refactor + web UI gate removal landed in #3621**: the wizard's `/profile`, `/generate`, and `/enrich` routes resolve a `dbType`'s profiler via `resolveProfileCapabilityByDbType` (the dbType-keyed sibling of `resolveProfileCapability`, in lockstep with the same `findDatasourcePluginConnection` lookup) behind the `lib/datasources/wizard-profiler.ts` helper. The "PostgreSQL and MySQL" gate is gone; the only remaining rejection is the actionable `not_profilable` state, surfaced verbatim in the wizard UI.
- `datasource-registry-bridge.ts` and `mcp-lifecycle.ts` take a type-only import of `DatasourceProfiler` from `effect/semantic-generator` (erased at runtime — no new runtime coupling or cycle).
- **The SDK profiler mirrors are hand-maintained, by design.** Because the SDK takes no dependency on `@useatlas/types` (or `@atlas/api`), there is deliberately no compile-time tie between `PluginProfilingResult` & co. and their canonical sources — a cross-package type assertion would reintroduce the very dependency the mirror exists to avoid. Parity is the cost of the decoupling: when a profiler type changes in `@useatlas/types` (e.g. a new `SemanticType` member), the SDK mirror must be updated in the same change. The seam tolerates this because the consuming boundary is structural — drift surfaces as a type error at the plugin that uses the new field, not as silent data loss.

## Amendment (#3552): the seam carries the datasource's decrypted connection config

**Status:** Accepted (#3552, #3647). Amends the *Profiler-options shape* decision above.

### Context

The original spine made the seam **url-only**: `profile(options)` took `{ url, schema?, … }`, matching `SemanticGenerator`'s `DatasourceProfiler` exactly. That is correct for datasources whose credentials are **embedded in the url** — Postgres/MySQL (native, in-core), and the url-bearing plugin types ClickHouse and Snowflake (their profilers parse user/password/account out of the connection string). It is **wrong** for a plugin that stores credentials in **separate config fields**. Elasticsearch is the motivating case: its `apiKey` / `username` / `password` / SigV4 fields (`awsRegion` & co.) live alongside the endpoint `url`, NOT inside it. With a url-only seam, `profileElasticsearchObjects` rebuilt its auth from the **operator** `ATLAS_ES_*` env contract — so over MCP it either failed (no env on the host) or, worse, authenticated against the **tenant's** datasource with the **operator's** credentials. That is a direct violation of the CLAUDE.md rule *"per-tenant plugin creds never fall back to operator env vars"* (#2850).

### Decision

**Extend the seam to carry the datasource's resolved, DECRYPTED connection config**, so a separate-field-credential plugin profiles with the tenant's own credentials.

- `DatasourceProfiler` (host, `effect/semantic-generator.ts`) and its SDK mirror `PluginProfileOptions` (`@useatlas/plugin-sdk`) both gain an optional `config?: Readonly<Record<string, unknown>>` — the decrypted plugin config (the same record `createFromConfig` receives). Published-contract change → `@useatlas/plugin-sdk` minor bump (0.0.10 → 0.0.11) under the publish-before-ref-bump discipline.
- **It is decrypted secret material.** Documented at every hop (SDK type, host `DatasourceProfiler`, `DatasourceProfileTarget.config`, `runSemanticProfile.config`) with the SAME "never leaves the lib layer / reaches the agent / is logged" discipline as the decrypted `url`. `loadDatasourceProfileTarget` already computes `decrypted`; it now carries it into `DatasourceProfileTarget.config`, `runSemanticProfile` forwards it into `SemanticGenerator.profile({ config })`, and `profileImpl` forwards it into the resolved `profileFn` args.
- **Behavior for url-embedded types is unchanged.** Native pg/mysql (in-core `resolveProfiler`) and the url-embedded plugin profilers (ClickHouse / Snowflake) simply ignore the new field — they read everything from `url`.
- **ES consumes the carried config; env fallback is scoped to the no-config path.** `profileElasticsearchObjects` builds the client via `resolveElasticsearchConfig({ url, ...config })` (the tenant's creds) when the seam supplies `config`, and falls back to `elasticsearchConfigFromEnv` **only** when no config is supplied — preserving the legitimate CLI `atlas init` path (operator's own shell). The tenant-config path also sets `allowAmbientAwsCreds: false`, so a tenant SigV4 datasource can't authenticate with the operator's ambient AWS env; the operator/CLI path keeps `true`.
- **Scope.** Only ES was decided here. `bigquery` / `duckdb` (multi-field, non-url-shaped) and `salesforce` (OAuth-managed) remain **fail-closed** behind `loadDatasourceProfileTarget`'s existing URL-shape gate — NOT expanded in this PR. ES already passes that gate (its `url` is the endpoint); the only change it needed was consuming the carried creds.

### Consequences

- A separate-field-credential plugin datasource profiles over MCP with the tenant's own credentials — closing the operator-env-fallback hole. The `config` flows through the **same** registry-resolved seam, no new coupling.
- **Mirror-drift cost (per the ADR above) now also applies to `config`.** The host `DatasourceProfiler` and the SDK `PluginProfileOptions` are hand-maintained mirrors; the new `config` field must stay in lockstep across both. Drift surfaces structurally — a plugin that reads `options.config` against an un-amended SDK is a type error at the plugin, not silent data loss.
- `listObjects` was intentionally **not** amended here — its options stayed `{ url, schema? }` — because the MCP profiling surface never calls it (it profiles a fixed set). **The wizard (#3621) is the first caller to exercise the plugin `listObjects`/`profile` seam, and it amends `listObjects` to carry `config` too** (see *Amendment (#3621)* below): the wizard's table-picker step calls `listObjects` separately, so a separate-field-credential plugin (ES) needs the tenant's creds there as well, not just on `profile`. The CLI/static discovery path still omits `config` and resolves auth from env.

## Amendment (#3621): the wizard threads decrypted config through BOTH `listObjects` and `profile`

**Status:** Accepted (#3621, #3648). Extends the #3552 amendment to the `listObjects` half and to the in-product wizard.

### Context

#3552 added `config` to `profile` only — correct for the MCP profiling surface, which never lists (it profiles a fixed table set). The **in-product wizard** (#3621), however, is the first caller to actually exercise the plugin `profile`/`listObjects` seam, and it calls `listObjects` **separately** for its table-picker step. With a url-only `listObjects` and a url-only wizard `resolveConnectionUrl` (which extracted only `config->>'url'`), an Elasticsearch datasource onboarded via the wizard fell back to operator `ATLAS_ES_*` env for BOTH enumeration and profiling — the same per-tenant-creds violation #3552 closed for MCP, but on the wizard path and for `listObjects`.

### Decision

**The wizard resolves the datasource's DECRYPTED connection config (the SAME `decryptSecretFields` + `config_schema` decrypt `loadDatasourceProfileTarget` uses) and threads it through BOTH halves of the seam.**

- `PluginListObjectsOptions` (SDK) gains the SAME optional `config?: Readonly<Record<string, unknown>>` field `PluginProfileOptions` already carries, with the identical SECURITY note (decrypted secret material — never logged / surfaced to the agent). Additive → `@useatlas/plugin-sdk` patch bump (0.0.11 → 0.0.12) under the publish-before-ref-bump discipline.
- The host's wizard seam (`lib/datasources/wizard-profiler.ts`, `lib/db/datasource-registry-bridge.ts`) threads `config` into the plugin's `listObjects` and `profile`. `wizard.ts` `resolveConnectionUrl` now returns the decrypted config alongside the `url`.
- ES `listElasticsearchObjects` consumes the carried config the SAME way `profileElasticsearchObjects` does (tenant config → `allowAmbientAwsCreds: false`; no-config CLI path → `elasticsearchConfigFromEnv`), via the shared `configForOptions` helper.
- **Schema default no longer leaks to plugin dbTypes.** The wizard defaulted a missing schema to `"public"` for ALL dbTypes; for a plugin dbType where `"public"` is meaningless (ClickHouse database, ES index) this could list zero objects. The wizard now defaults to `"public"` only for native Postgres; a plugin dbType passes the user-provided schema through, or `undefined` (the plugin uses its own default). `DatasourceProfiler.schema` / `DatasourceListObjects.schema` widened to optional accordingly.

### Consequences

- A separate-field-credential plugin onboarded via the in-product wizard enumerates AND profiles with the tenant's own credentials — closing the wizard's operator-env-fallback hole for both seam halves. Native pg/mysql and url-embedded plugins (ClickHouse/Snowflake) are unchanged (they ignore `config`).
- **Mirror-drift cost now also applies to `PluginListObjectsOptions.config`** — the SDK type and the host bridge shape (`DatasourceConnectionShape.listObjects`) are hand-maintained mirrors and must stay in lockstep.

## Amendment (#3664): BigQuery profiles over MCP from its multi-field config

**Status:** Accepted (#3664). Lifts the BigQuery fail-closed scope decision in *Decision* above.

### Context

The original scope (above) left `bigquery` **fail-closed** behind `loadDatasourceProfileTarget`'s URL-shape gate, because BigQuery is multi-field / non-url-shaped: its credentials live in a SEPARATE `service_account_json` config field, never in a connection string. But the milestone goal (#3664, #3552 AC #1) is that **every provisioning-supported type profiles over MCP** — and BigQuery is in `MCP_PROVISIONABLE_CATALOG_SLUGS`. The #3552/#3621 `config` amendment already carries the decrypted config through the seam; BigQuery just needed to pass the url-shape gate and consume it.

### Decision

**Synthesize a url for non-url-shaped config-credential types and have the profiler authenticate from the carried `config` — the same pattern ES uses.**

- `loadDatasourceProfileTarget` resolves the seam url via `resolveProfileUrl(poolConfig)`: url-bearing pool configs return their url; BigQuery synthesizes `bigquery://<project>` from its `projectId`. The synthetic url is an identifier/routing hint only — it carries NO credentials. Types still without a path (duckdb file, salesforce OAuth) return `undefined` and stay fail-closed in their own slices.
- The BigQuery profiler's `resolveConfig` builds the connection from `options.config` when present (the tenant's decrypted `service_account_json` → `credentials`, `project_id` → `projectId`, the generic `schema` routing hint → `dataset`), mirroring ES's `configForOptions`. It falls back to `parseBigQueryUrl(options.url)` for the CLI / static-config path (operator shell). No SDK contract change — `config` already exists on `PluginProfileOptions`/`PluginListObjectsOptions`.
- `BigQueryPoolConfig` gains an optional `schema` (the dataset routing hint) so a dataset set at `create_datasource` time flows through to the profiler. The credentials never leave the lib layer (the existing `config` SECURITY discipline).

### Consequences

- BigQuery onboards end-to-end over MCP (add datasource → `profile_datasource` → semantic layer), with the tenant's own service-account creds, closing the add-but-can't-onboard dead-end for BigQuery.
- The `resolveProfileUrl` seam is the extension point for the remaining non-url types: DuckDB (#3627) and Salesforce OAuth (#3663) plug in there rather than re-opening the gate.
