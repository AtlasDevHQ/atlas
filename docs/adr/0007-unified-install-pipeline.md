# ADR-0007: Unified install pipeline via `workspace_plugins` for all pillars

**Status:** Accepted
**Date:** 2026-05-23
**Context milestone:** 1.5.3 — Multi-Platform Install Models
**Depends on:** [ADR-0002](./0002-catalog-seeded-from-config-at-boot.md), [ADR-0003](./0003-two-store-chat-install-metadata-credentials.md), [ADR-0005](./0005-integration-credentials-table.md), [ADR-0006](./0006-three-pillar-integration-taxonomy.md)
**Partially supersedes:** ADR-0002 (datasource catalog rows are built-in-seeded, not config-seeded — see "Consequences for ADR-0002" below)

## Context

ADR-0006 established the three-pillar taxonomy (Datasource / Chat Platform / Action Target) with a "one user-facing surface per pillar" rule. The current implementation has **two parallel install pipelines** that don't know about each other:

- **Datasource installs** live in the standalone `connections` table. Hand-rolled `<ConnectionFormDialog>` collects `{ url, dbType, schema, description }`, POSTs to `/api/v1/admin/connections`, writes the row directly. No catalog row, no `workspace_plugins` row, no install-handler dispatch, no `config_schema` validation. URL encrypted via `db/internal.ts` (URL-aware passthrough variant) into `connections.url`.
- **Integration installs** (Chat Platform + Action Target) live in `plugin_catalog` + `workspace_plugins` + `integration_credentials` (per ADR-0005) + `chat_cache` (per ADR-0003). Catalog handler dispatch by `installModel` (`OAuthPlatformInstallHandler` / `FormBasedInstallHandler` / `StaticBotInstallHandler`).

Salesforce is the canonical evidence the split is broken: its catalog row + OAuth handler live in the integrations pipeline (`integration_credentials` for the refresh token), but it also surfaces as a `dbType` on `/admin/connections` — a stub UI with no working install path because the Datasource pipeline doesn't know about OAuth. The user-facing pillar (Datasource) is severed from the install-handler infrastructure (integrations).

The clean-break window declared in CONTEXT.md ("pre-customer clean-break" with two internal Workspaces and no external customers) makes this the right moment to unify, before contracts lock.

## Decision

**One install pipeline. `workspace_plugins` is the universal install record for all three pillars.** The `connections` table is dropped. `ConnectionRegistry` reads its datasource pool definitions from `workspace_plugins` filtered by `pillar = 'datasource'`.

### Schema shape

`workspace_plugins` grows the following:

```sql
ALTER TABLE workspace_plugins
  ADD COLUMN install_id text NOT NULL,           -- per-instance identifier (datasource: user-facing id like 'prod-us'; chat/action: catalog_id or sentinel)
  ADD COLUMN pillar text NOT NULL CHECK (pillar IN ('datasource', 'chat', 'action'));

-- Drop the (workspace_id, catalog_id) unique constraint; replace with pillar-aware partial unique:
DROP INDEX workspace_plugins_workspace_catalog_unique;
CREATE UNIQUE INDEX workspace_plugins_singleton
  ON workspace_plugins (workspace_id, catalog_id)
  WHERE pillar IN ('chat', 'action');

-- Datasource installs are intentionally multi-instance per (workspace, catalog).
-- The composite primary key becomes (workspace_id, catalog_id, install_id).
```

Each row carries `config` JSONB validated against `plugin_catalog.config_schema`. For Datasources, `config` includes `{ url (secret), schema?, description?, group_id?, db_type }`. For Chat Platforms / Action Targets, `config` is whatever the install handler persists.

### Credential storage

Secrets in `workspace_plugins.config` are encrypted **inline via selective-field encryption** (`encryptSecretFields` / `decryptSecretFields` from `db/secret-encryption.ts`), keyed on the catalog's `config_schema` `secret: true` flag. This applies uniformly to Datasource URLs (Postgres, MySQL, ClickHouse, BigQuery service-account JSON, etc.), Form-installed Action Target credentials, and Static-bot routing identifiers.

OAuth-handler-managed credentials (Salesforce refresh token, Slack bot token) continue to live in their store-of-record per ADRs 0003 and 0005:

- Chat Platform OAuth tokens → `chat_cache` (per ADR-0003's two-store split)
- Action Target / Datasource OAuth tokens → `integration_credentials` (per ADR-0005)

The unification is on the **install record + Form-shape credentials**, not on the OAuth-token storage. Folding `chat_cache` and `integration_credentials` into a single `workspace_plugin_credentials` table is a deliberately deferred follow-up (would require migrating the chat SDK's state store, out of scope for 1.5.3).

### Catalog seeding for Datasources

The current code-hard-wired `DB_TYPES` array promotes to built-in `plugin_catalog` rows seeded by a boot-time migration: `postgres`, `mysql`, `snowflake`, `clickhouse`, `bigquery`, `duckdb`, `salesforce`, `demo-postgres`. Operators do *not* declare these in `atlas.config.ts` — they ship with Atlas. `atlas.config.ts` retains its role per ADR-0002 for eager-plugin declarations (chat plugin) and operator-specific catalog entries; built-in catalog rows are a code-seeded layer underneath.

A per-deploy override (`atlas.config.ts:overrideImplementationStatus`) exists for the self-host case where an operator ships their own handler for a row marked `coming_soon`.

### Demo connection

`__demo__` becomes a regular `workspace_plugins` install of the built-in `demo-postgres` catalog row, auto-seeded into every workspace at creation (and backfilled for existing workspaces) via a new `auto_install: true` flag on the catalog row. Per-workspace hide = archive the workspace's `workspace_plugins` row. No more special-case sentinel; no more shared-row + per-org tombstone overlay logic.

### Migration

Single migration:
1. Drop `connections` table after copying every row to `workspace_plugins` (re-encrypting URLs from `db/internal.ts` ciphertext to `db/secret-encryption.ts` selective-field encryption inside `config.url`).
2. Seed built-in Datasource catalog rows.
3. Auto-install `demo-postgres` row for every existing workspace.
4. `ConnectionRegistry` pivots to read from `workspace_plugins`.

The deployment posture (two internal Workspaces, no external customers) licenses dropping `connections` entirely in one migration, without a view-backed compat shim. The `@useatlas/sdk` consumers don't read this table directly — they hit the HTTP API, which is updated in lockstep.

## Alternatives considered

### Model 2 — Single install per `(workspace, catalog)`, datasource connections nested in JSONB (rejected)

Keep the existing `(workspace_id, catalog_id)` uniqueness. A workspace's Postgres install holds `config: { connections: [{id, url, …}, …] }` as a JSONB array; per-connection operations become array mutations.

Rejected because it doesn't actually unify — it renames the `connections` table to `workspace_plugins.config.connections[]` and inherits all the same multi-instance problems (per-connection audit, per-connection drain/test, per-connection environment membership) but now nested in JSONB where row-level operations don't reach. The existing `connection_groups` (environments) join becomes JSONB hell.

### Model 3 — Three-level catalog → install → instance (rejected)

Add a `workspace_plugin_instances` table. `workspace_plugins` stays single-install per (workspace, catalog); multi-instance pillars (Datasource) own N instance rows; single-instance pillars carry a degenerate single instance.

Rejected as overhead-for-no-observable-benefit: every Chat Platform / Action Target install would drag around a degenerate single-instance row forever. Joins everywhere. Conceptually correct ("install" = capability presence; "instance" = specific configuration) but in practice the only pillar that has multi-instance is Datasource, and the pillar-aware partial unique index expresses that cleanly without the third table.

### Credential storage Option B — Dedicated encrypted column on `workspace_plugins` for URL secrets (rejected)

Postgres/MySQL/etc. URLs land in a new `workspace_plugins.credential_encrypted` column using `db/internal.ts` URL-aware encryption; OAuth tokens stay in `integration_credentials`. Preserves env-seed plaintext convenience.

Rejected after auditing every production writer of `connections.url` (admin POST handler, onboarding flow, CLI seed, auth migration). All four already call `encryptSecret(url)` before INSERT. The URL-aware passthrough is dead code in practice; the only consumer that ever benefited from it was hand-written DB rows, which the unified pipeline eliminates entirely. The convenience the URL-aware passthrough provided is legacy artifact; the clean-break license retires it.

### Credential storage Option C — Single `workspace_plugin_credentials` table for everything (deferred)

Replace `chat_cache` (chat tokens) and `integration_credentials` (OAuth tokens) with one unified credentials table keyed by `workspace_plugins` PK. Architecturally correct, but `chat_cache` is the chat-SDK's state store, not just credentials — replacing it touches every install handler and the chat plugin. Real but out of scope for 1.5.3; tracked as a follow-up for a later milestone.

## Consequences

**For the schema:**
- New columns on `workspace_plugins`: `install_id`, `pillar`. Primary key changes to composite `(workspace_id, catalog_id, install_id)`. Singleton constraint expressed as partial unique index on `pillar IN ('chat', 'action')`.
- `connections` table dropped. `connection_groups` either dropped (if folded into config) or repointed to `workspace_plugins` via `install_id`.
- Drizzle schema mirror per CLAUDE.md's drift check.

**For `ConnectionRegistry`:**
- Reads pool definitions from `workspace_plugins WHERE pillar = 'datasource'`. The `getForOrg(orgId, connectionId)` lookup becomes a `(workspace_id, install_id)` query, not a `connections.id` lookup.
- The `default` connection (auto-initialized from `ATLAS_DATASOURCE_URL`) continues to be config-managed and not stored in `workspace_plugins` — that's a runtime artifact, not a per-workspace install. (Same exception as today.)

**For credential encryption (CLAUDE.md update needed):**
- The "use `db/internal.ts` when the column is a URL" rule narrows to "for the legacy non-`workspace_plugins` columns that still use it (`workspace_model_config`, `sso_providers`)." New Datasource credentials use selective-field encryption inside `config`.
- The `encryptUrl` / `decryptUrl` deprecated re-exports stay until 1.5.0 per existing schedule; no new call sites.

**For `/admin/connections`:**
- The "Add Connection" dialog renders per-catalog-row install models. URL-form for Postgres/MySQL/ClickHouse/etc., OAuth for Salesforce (delegating to the existing `SalesforceOAuthInstallHandler`), service-account-JSON form for BigQuery.
- Per-instance operations (test, drain, edit, archive) become row-level operations on `workspace_plugins`.

**For tests:**
- The roughly 50+ test files that grep for `INSERT INTO connections` need rewriting to expect `INSERT INTO workspace_plugins WHERE pillar = 'datasource'` (or the Drizzle equivalent). Real-Postgres migration smoke (`migrate-pg.test.ts`) catches the schema shift.

### Consequences for ADR-0002

ADR-0002 declared "`atlas.config.ts` is the canonical authoring surface; on each boot, an idempotent seed pass writes / updates `plugin_catalog` rows to match."

This ADR partially supersedes it for Datasources: built-in catalog rows for Datasources (Postgres, MySQL, …) are seeded by Atlas code itself at boot, not by `atlas.config.ts`. ADR-0002's principle remains accurate for eager plugins (chat) and operator-specific catalog entries; the "config is authoritative" claim is now narrowed to "for everything except built-in Atlas datasources." A status note on ADR-0002 cross-references here.

## References

- Three-pillar taxonomy: [ADR-0006](./0006-three-pillar-integration-taxonomy.md)
- Two-store chat credentials: [ADR-0003](./0003-two-store-chat-install-metadata-credentials.md)
- Integration credentials table: [ADR-0005](./0005-integration-credentials-table.md)
- Catalog seeding from config: [ADR-0002](./0002-catalog-seeded-from-config-at-boot.md) (partially superseded by this ADR for built-in Datasource rows)
- Encryption layer: `packages/api/src/lib/db/secret-encryption.ts`, `packages/api/src/lib/db/internal.ts`
- Current connection registry: `packages/api/src/lib/db/connection.ts`
- Current connections page: `packages/web/src/app/admin/connections/page.tsx`
