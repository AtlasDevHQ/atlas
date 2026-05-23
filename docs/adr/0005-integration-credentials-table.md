# ADR-0005: Lazy OAuth integrations use a dedicated credentials table

**Status:** Accepted
**Date:** 2026-05-22
**Context milestone:** Multi-Adapter SaaS Readiness (1.5.2)
**Depends on:** [ADR-0003](./0003-two-store-chat-install-metadata-credentials.md), [ADR-0004](./0004-platform-oauth-is-not-better-auth.md)
**Closes:** Open question in #2697 (Email form install) — "where do non-chat OAuth credentials go?"

## Context

ADR-0003 split chat Workspace Connections into two stores by concern: install metadata in `workspace_plugins` (typed Postgres columns), per-Platform bot tokens in `chat_cache` keyed by external team id. That split worked because the chat-adapter packages already owned `chat_cache` reads and writes for their per-event credential lookups.

The 1.5.2 release expands the catalog to **non-chat OAuth integrations** — Salesforce ships first (#2658); Jira follows. These integrations have shapes the chat-adapter pattern doesn't accommodate cleanly:

1. **No external "team id" to key the credential row on.** Salesforce's `instance_url` is per-tenant but the credential row's natural key is `(workspaceId, catalogId)`, not a platform-side identifier.
2. **Refresh tokens have their own lifecycle.** Access tokens expire; refresh tokens rotate on each refresh (sometimes); permanent refresh failure flips the install into a "reconnect needed" state. Mixing those writes into `chat_cache` would entangle two adapters' state.
3. **Hot-path credential read.** The agent's tool-call loop reads credentials on every Salesforce query. A typed Postgres table with a `(workspace_id, catalog_id)` unique index is cheaper than a JSONB lookup via `chat_cache.key`.
4. **Form-based install precedent points the other way.** Email (#2697) stuffs encrypted SMTP creds into `workspace_plugins.config` via `encryptSecretFields`. That works for opaque, rarely-rotated secrets but creaks for OAuth refresh tokens — every refresh would need a JSONB merge instead of a one-row UPDATE.

## Decision

**Lazy OAuth integrations get a dedicated `integration_credentials` table.** Migration `0089_integration_credentials.sql` creates it; the Salesforce install handler is the first writer.

```sql
CREATE TABLE integration_credentials (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             TEXT NOT NULL,
  catalog_id               TEXT NOT NULL REFERENCES plugin_catalog(id) ON DELETE CASCADE,
  credentials_encrypted    TEXT NOT NULL,
  credentials_key_version  INTEGER,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, catalog_id)
);
```

**Credential blob shape (JSON, AES-256-GCM encrypted via `db/secret-encryption.ts`):**

```ts
interface CredentialBundle {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;       // ms since epoch
  tokenType: string;
  scope: string;
  instanceUrl: string;             // Salesforce-specific must-have
  extra?: Record<string, unknown>; // per-Platform extension (id_token, etc.)
}
```

The whole bundle is JSON-stringified then encrypted. The dedicated table is registered in `INTEGRATION_TABLES` in `packages/api/src/lib/db/integration-tables.ts` so F-47 key rotation and the F-42 residue audit pick it up automatically.

## What lives where (post-1.5.2)

| Integration shape | Install metadata | Credentials | Example |
|---|---|---|---|
| Chat (`type: chat`, OAuth) | `workspace_plugins` (typed) | `chat_cache:<platform>:installation:<teamId>` (JSONB k/v, chat-adapter owned) | Slack |
| Chat (`type: chat`, static-bot) | `workspace_plugins` (typed) | Operator env — no per-Workspace row | Teams, Discord (1.5.3) |
| Integration (`type: integration`, OAuth) | `workspace_plugins` (typed) | **`integration_credentials`** (typed table, ADR-0005) | Salesforce, future Jira |
| Integration (`type: integration`, form) | `workspace_plugins.config` JSONB with `encryptSecretFields` | (Same — no separate store) | Email (#2697), future Webhook |

`workspace_plugins.config` carries operator-visible fields (`instance_url`, `status`, `scopes`) so admin-UI reads don't need a decrypt — the encrypted bundle stays untouched for queries that don't make API calls.

## Two-store teardown order (carried forward from ADR-0003)

The disconnect flow tears the two stores down in a specific order:

```
DELETE FROM integration_credentials WHERE workspace_id = ? AND catalog_id = ?;  -- FIRST
DELETE FROM workspace_plugins       WHERE workspace_id = ? AND catalog_id = ?;  -- SECOND
```

Credentials must never outlive the install record. The FK on `catalog_id` cascades from `plugin_catalog` deletion as a defensive backstop, not the primary cleanup path.

## Refresh-token rotation + reconnect_needed

Access tokens expire; the refresh flow in `packages/api/src/lib/integrations/install/salesforce-token-refresh.ts` calls `<loginUrl>/services/oauth2/token` with `grant_type=refresh_token`:

- **Refresh succeeded** — re-encrypt + UPDATE `integration_credentials` (bumps `updated_at` — also surfaces as "last refreshed" in admin UI); clear `workspace_plugins.config.status` back to `"ok"`.
- **Permanent failure** (Salesforce returns `invalid_grant`, `invalid_client`, `inactive_user`, `org_locked`, `inactive_org`, or `rate_limit_exceeded`) — flip `workspace_plugins.config.status` to `"reconnect_needed"` and throw `SalesforceReconnectRequiredError`. The admin UI's catalog card renders a "Reconnect needed" badge + Reconnect button.
- **Transient failure** (network, 5xx, unknown 4xx error code) — throw plain `Error`. The agent's next tool call retries. No `reconnect_needed` flip without evidence the install is broken.

The `reconnect_needed` field is part of `workspace_plugins.config`, not `integration_credentials`, because admin-UI reads need it without decrypting the credential bundle.

## LazyPluginLoader integration

On first Salesforce tool call per Workspace, `lazyPluginLoader.getOrInstantiate(workspaceId, "catalog:salesforce")` builds a per-Workspace plugin instance from:
- `workspace_plugins.config` (instance_url + status — refuses to build if `status === "reconnect_needed"`)
- decrypted `integration_credentials` (access_token + refresh_token)

Subsequent tool calls in the same Workspace hit the cache. On Salesforce `INVALID_SESSION_ID`, the `query` wrapper runs the refresh flow inline; on permanent refresh failure the cache is evicted and the next call rebuilds (and refuses, surfacing the Reconnect error).

## Alternatives considered

1. **Reuse `workspace_plugins.config` for OAuth too.** Rejected — every access-token refresh would be a JSONB merge, and the `(workspaceId, catalogId)` → encrypted-bundle index lookup is ~10× cheaper as a typed column. Also collides with the form-based integration shape (which legitimately wants the JSONB approach).
2. **Per-Platform tables (`salesforce_installations`, `jira_installations`).** Rejected — every new lazy OAuth integration would need a migration and rotation-script entry. The generic table is one row of `INTEGRATION_TABLES`, no new migration per Platform.
3. **Reuse `chat_cache`.** Rejected — that store is owned by chat-adapter packages; bolting non-chat credentials onto it would force the adapter's key-prefix convention onto an unrelated subsystem.

## Consequences

**For new lazy OAuth integrations (Jira, etc.):**
- One-line addition to `INTEGRATION_CREDENTIALS_SLUGS` in `api/routes/integrations.ts` (the disconnect dispatch).
- New `*-oauth-handler.ts` mirroring `salesforce-oauth-handler.ts`.
- New `*-token-refresh.ts` if the platform's refresh flow differs from Salesforce's (most OAuth platforms can share the generic shape with minor tweaks).
- New LazyPluginLoader builder if the platform needs per-Workspace plugin instantiation.
- No migration, no new credential table.

**For F-47 key rotation:**
- `integration_credentials` is in `INTEGRATION_TABLES`. The rotation script walks it generically (single-column PK `id`, `credentials_encrypted` column, `credentials_key_version` companion).

**For F-42 residue audit:**
- The `credentials_encrypted` column is `NOT NULL` per the migration. `integration_credentials` is in `NON_NULL_ENCRYPTED_TABLES` by inheritance; the audit asserts the invariant.

**For partial-failure recovery:**
- ADR-0003's "credential write fails → install row stays, credentialResult.written: false → admin sees Reconnect needed" model applies here verbatim. The OAuth callback writes both stores; a step-2 failure leaves the install row in place with `status: "ok"`, but no credential row exists — the agent's first tool call surfaces "integration_credentials row is missing for workspace X — disconnect + reinstall" and the admin UI shows the install card with no Reconnect affordance (since the install row doesn't carry `reconnect_needed` until a refresh has actually failed). A re-run of the OAuth dance UPSERTs both stores.

## References

- Migration: `packages/api/src/lib/db/migrations/0089_integration_credentials.sql`
- Schema mirror: `packages/api/src/lib/db/schema.ts` (`integrationCredentials`)
- Generic store: `packages/api/src/lib/integrations/credentials/store.ts`
- OAuth install handler: `packages/api/src/lib/integrations/install/salesforce-oauth-handler.ts`
- Refresh flow: `packages/api/src/lib/integrations/install/salesforce-token-refresh.ts`
- Lazy builder: `packages/api/src/lib/integrations/salesforce/lazy-builder.ts`
- Disconnect dispatch: `packages/api/src/api/routes/integrations.ts` (`INTEGRATION_CREDENTIALS_SLUGS`)
