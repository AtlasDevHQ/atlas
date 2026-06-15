# ADR-0014: Salesforce datasource stays on the OAuth path (not the `createFromConfig` bridge)

**Status:** Accepted
**Date:** 2026-06-07
**Context milestone:** v0.0.13 — Elasticsearch/OpenSearch & Plugin Datasource Onboarding (#63) — #3302
**Depends on:** [ADR-0006](./0006-three-pillar-integration-taxonomy.md) (three-pillar taxonomy), [ADR-0007](./0007-unified-install-pipeline.md) (unified install pipeline / OAuth-token storage carve-out), [ADR-0013](./0013-db-stored-plugin-datasource-connections.md) (DB-stored plugin datasource connections via `createFromConfig`)

## Context

ADR-0013 added the datasource **bridge**: a DB-stored datasource (`workspace_plugins` row, `pillar='datasource'`, a `url` in `config`) is connected by looking the plugin up in the registry by `dbType` and calling its `connection.createFromConfig(decryptedConfig)`. ClickHouse / Snowflake / BigQuery / DuckDB / Elasticsearch all ride this seam: the customer fills a credential form, the url is encrypted into `config`, and `executeSQL` queries the bridge-built connection.

Salesforce is **not** wired this way, and ADR-0007 already said so. Per ADR-0007 §"Credential storage":

> OAuth-handler-managed credentials (Salesforce refresh token, Slack bot token) continue to live in their store-of-record … Action Target / Datasource OAuth tokens → `integration_credentials` … The unification is on the **install record + Form-shape credentials**, not on the OAuth-token storage.

Concretely, a per-workspace Salesforce datasource:

- **Installs via OAuth** — `SalesforceOAuthInstallHandler` writes a `workspace_plugins` row whose `config` carries `instance_url` / `scopes` / `status` (+ `org_id` / `org_user_id`) — all operator-visible, **no `url`** — and persists the access/refresh tokens, encrypted, in `integration_credentials` (ADR-0005). There is no credential form and no `url` to encrypt.
- **Is served via the `LazyPluginLoader`** — a per-workspace builder (`integrations/salesforce/lazy-builder.ts`, registered in `integrations/install/register.ts`) reads the OAuth bundle, builds a `jsforce` session from `instance_url` + `accessToken`, refreshes inline on `INVALID_SESSION_ID`, and exposes a `query(soql)` method. This is the SOQL path, **not** `executeSQL` / the generic SQL pipeline. (Note: the agent-facing tool that *consumes* this lazy instance — the analogue of `email-tool.ts` / `linear-tool.ts` — is not yet wired; that gap is tracked in #3311 and is orthogonal to this ADR's bridge decision.)

PR #3299 momentarily blurred this boundary: as part of the plugin-datasource onboarding work it gave the Salesforce plugin a `connection.createFromConfig` and registered an adapter-only `salesforcePlugin({})` in `deploy/api/atlas.config.ts` + `deploy/api-staging/atlas.config.ts`, as if Salesforce were a bridge datasource like ClickHouse. That registration is **inert**: the OAuth-installed `config` has no `url`, so feeding it to `createFromConfig` (which requires a `salesforce://…` url) throws. Worse, the boot loop (`loadSavedConnections`) selects Salesforce rows (`pillar='datasource'`, slug `salesforce`) and routes them through the bridge, so every Salesforce-connected workspace logged a per-boot `stage:"bridge"` warning — and removing the registration *without* a bridge change would swap that for an even more misleading "No datasource plugin registered for type salesforce — add the plugin to atlas.config.ts", directly inviting the next contributor to re-add the inert entry.

## Decision

**Salesforce stays on the OAuth path. It is a deliberate, documented exception to the `createFromConfig` bridge — not a bridge datasource.**

Concretely:

- **The bridge skips `salesforce`.** `datasource-registry-bridge.ts` defines `HANDLER_MANAGED_DATASOURCE_DBTYPES = {"salesforce"}` and `registerDatasourceInstall` returns `false` for those dbTypes *before* the plugin lookup. No `createFromConfig` call, no throw, no boot warning. This is the single choke point both callers (`loadSavedConnections`, `WorkspaceInstaller.installDatasource`) share, so the skip holds for boot and any future install-path call.
- **The inert `salesforcePlugin({})` registration is removed** from `deploy/api/atlas.config.ts` and `deploy/api-staging/atlas.config.ts` (import + array entry), with a comment at both the import block and the skip site explaining why, pointing here.
- **The Salesforce OAuth install handler + lazy builder are unchanged** — they are wired independently in `integrations/install/register.ts`, gated on `SALESFORCE_CLIENT_ID` / `SALESFORCE_CLIENT_SECRET`, and do not depend on the plugin being in the `plugins` array.
- **The plugin's `createFromConfig` + adapter-only mode are retained as a dormant SDK seam** (clearly documented as such in `plugins/salesforce/src/index.ts`), so a future credential-form Salesforce-datasource path (option a below) remains cheap to revive without re-litigating the SDK shape. They are simply never reached at runtime.

The result is that the bridge never builds a Salesforce connection, so it cannot stand up a **second** Salesforce datasource path competing with the OAuth / `LazyPluginLoader` one — pinned by a regression test in `datasource-registry-bridge.test.ts` (the bridge returns `false` and never calls `createFromConfig` for `salesforce`, whether a salesforce plugin is registered).

## Alternatives considered

### (a) Fold Salesforce onto the bridge via a credential-form install (rejected for now)

Add a Salesforce credential-form catalog row (a `salesforce://user:pass@host?token=…` url field) so an install builds the connection through `createFromConfig` and `executeSQL` queries it, uniform with ClickHouse et al. **Rejected:** it would create a *second* Salesforce install + query path competing with the existing OAuth one (OAuth is the better auth model — no long-lived password/security-token in `config`, refresh-token rotation, per-org `instance_url`), and SOQL is validated/handled outside the generic SQL (`node-sql-parser`) pipeline. ADR-0007 already designated Salesforce OAuth-managed. The `createFromConfig` seam is kept dormant so this option stays open if a username/password Salesforce datasource is ever wanted, but it is not wired today.

### Remove `createFromConfig` from the plugin entirely (rejected)

Revert #3299's plugin-side additions so the Salesforce plugin is static-config-only. **Rejected:** it widens the blast radius into the published `@useatlas/salesforce` package and its test suite for no runtime benefit — the bridge skip already makes `createFromConfig` unreachable, and keeping it (documented as dormant) preserves option (a) at near-zero cost.

### Exclude `salesforce` in the boot SQL query instead of the bridge (rejected)

Add `AND pc.slug != 'salesforce'` to `loadSavedConnections`'s SELECT. **Rejected:** it only covers the boot path (not `WorkspaceInstaller`) and scatters the "Salesforce is handler-managed" fact into a SQL string far from the bridge that owns the per-dbType registration convention. The bridge is the documented single place this decision belongs.

## Consequences

- No Salesforce-related boot warning; `loadSavedConnections` cleanly counts the row as not-registered.
- A contributor who re-adds `salesforcePlugin({})` to a deploy config gains nothing — the bridge still skips `salesforce` — and the comment + this ADR + the regression test explain why not to.
- If a credential-form Salesforce datasource (option a) is ever desired, it is a deliberate change: remove `salesforce` from `HANDLER_MANAGED_DATASOURCE_DBTYPES`, add the catalog `config_schema` url field, re-add the plugin registration, and reconcile the two query paths (or retire OAuth). The dormant `createFromConfig` is ready for it.
- The OAuth path (install handler + lazy builder) is untouched and remains the canonical, documented way to connect Salesforce as a datasource. (Completing the agent-facing query tool that consumes the lazy instance is tracked in #3311.)

## Note (#3667): Salesforce profiles over OAuth via the unified resolver — bridge skip preserved

Universal datasource profiling ([ADR-0017 § Amendment (#3667)](./0017-datasource-profiler-seam.md)) introduces one host-side `resolveLiveConnection(orgId, installId)` that profiling consumes across all transports. Salesforce is **the proof case** for honoring this ADR: the unified resolver routes `salesforce` (via `isHandlerManagedDatasourceDbType`) to the OAuth `LazyPluginLoader`, **not** the `createFromConfig` bridge. The lazy-built instance now exposes `listObjects`/`profile` as capabilities of the live OAuth connection (introspection runs over the `jsforce` session in `lib/integrations/salesforce/oauth-introspection.ts`, refresh-retried), so Salesforce profiles end-to-end over MCP — without a credential-form install, a `createFromConfig` call, or a registered pool. This is **not** option (a) above: there is still no second Salesforce datasource path; the bridge still skips `salesforce` (the `registerDatasourceInstall` returns-`false` regression test stays green), and core does not import the `@useatlas/salesforce` plugin (the OAuth introspection lives in core). Decrypted OAuth tokens never leave the lib layer / are never logged; a mid-profile `INVALID_SESSION_ID` refreshes once and, on permanent failure, surfaces an actionable reconnect-required.
