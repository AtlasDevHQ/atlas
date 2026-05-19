# ADR-0004: Platform integration OAuth is separate from User OAuth (Better Auth)

**Status:** Accepted
**Date:** 2026-05-19
**Context milestone:** Multi-Adapter SaaS Readiness (forthcoming)
**Related:** [ADR-0001](./0001-saas-uses-one-app-registration-per-platform.md), [ADR-0003](./0003-two-store-chat-install-metadata-credentials.md)

## Context

Atlas's auth surface has three OAuth-shaped flows. They use the same OAuth 2.0/2.1 grammar but represent fundamentally different concepts:

1. **User OAuth** — sign-in via Google / GitHub / enterprise SSO. The token represents a user identity. Owner: Better Auth (`packages/api/src/lib/auth/*`). Stored in Better Auth's `account` table keyed by user.
2. **Atlas-as-OAuth-server** — Atlas issues tokens to MCP clients via DCR + PKCE. Atlas is the OAuth provider, not the OAuth client. Owner: `@atlas/oauth-helper` (arch-win #51, extracted in #2203).
3. **Platform integration OAuth** — Atlas connects a Workspace to a third-party Platform as a bot. The token represents a Workspace-scoped bot capability. Today: hand-rolled in `packages/api/src/api/routes/slack.ts` calling `oauth.v2.access` directly.

When designing the Multi-Adapter SaaS Readiness milestone, the natural question arose: should Platform integration OAuth piggyback on Better Auth's existing infrastructure (`account` table, state management, social-provider plugin pattern)?

## Decision

**No. Platform integration OAuth is a separate subsystem from Better Auth's user OAuth.** It does not write to the `account` table. It does not register as a Better Auth social provider. It runs its own callback handlers and persists per-`workspace_plugins` + `chat_cache` per ADR-0003.

**Shared primitives may be reused.** `@atlas/oauth-helper` (which already factored out OAuth 2.1 state, PKCE, and DCR helpers for the MCP case) is the natural home for any low-level OAuth machinery that the new `PlatformOAuthHandler` module needs. Sharing primitives is fine; sharing storage models is not.

## Why not Better Auth

Better Auth's `account` table is shaped for **user identity** — `user_id`, `provider_id`, `account_id`, `access_token`, `refresh_token`. A user's GitHub OAuth token has exactly this shape: "user U has linked GitHub account A."

A Slack workspace bot token does not. It has a completely different shape:

- `team_id`, `enterprise_id`, `app_id`, `bot_user_id`, `scopes` (the OAuth scopes granted), `incoming_webhook` block, `is_enterprise_install`
- It is **scoped to a Workspace, not a User** — when admin Alice installs Slack for Workspace W, the bot token belongs to W, not to Alice. Alice could leave the company and the bot keeps working.
- It is consumed by a **per-platform adapter** (`@chat-adapter/slack`) that expects its own state shape

Forcing this into the `account` table would either:

- Pretend the bot is a user (broken — there's no Atlas user; the token doesn't authenticate request bearers)
- Add Slack-specific columns to a Better-Auth-managed table (breaking Better Auth's schema invariants)
- Stuff everything into JSONB and pretend it's typed (defeating the table's purpose)

The data shape mismatch is fundamental. Same OAuth grammar, incompatible storage models.

## What Platform OAuth actually needs

- **Per-Platform OAuth dance** — each Platform's OAuth has shape differences (Slack's `oauth.v2.access`, Teams' Bot Framework consent flow, Discord's Application install URL). Abstract behind a `PlatformOAuthHandler` interface; one implementation per Platform.
- **CSRF state management** — short-lived signed tokens keyed by `(workspaceId, catalogId)`. Reuse `@atlas/oauth-helper` machinery if it provides this; otherwise mint dedicated.
- **Per-Workspace credential persistence** — write to the adapter's native state store (`chat_cache` for chat Platforms; per-plugin store for lazy integrations like Salesforce).
- **Per-Workspace install record** — write to `workspace_plugins` per ADR-0003 with `catalog_id` reference to `plugin_catalog`.

None of these touch `auth/server.ts` or Better Auth's `account` table.

## Alternatives considered

### Use Better Auth's `genericOAuth` plugin

Better Auth has a `genericOAuth` plugin that lets you register arbitrary OAuth providers. Considered and rejected because:

- It assumes the OAuth result is a user identity (it creates a `user` row or links to an existing one)
- Workspace bot tokens are not user identities; forcing the mapping would either create ghost users or require disabling the plugin's user-link behavior, at which point you've reimplemented the dance anyway
- The lifecycle hooks (`signIn.before`, `signIn.after`) don't match the install/uninstall semantics

### Extend `account` table with Platform-bot rows

Add `provider_id = 'slack-workspace'` rows that hold the bot token. Rejected because:

- Conflates user-identity rows with workspace-bot rows in the same table; queries like "what accounts has this user linked" return nonsense
- Doesn't solve the storage-shape problem (the bot token shape is still Slack-specific JSONB)
- Better Auth's row-level operations (revoke, refresh) don't apply to bot tokens

## Consequences

- `PlatformOAuthHandler` is a new subsystem under `packages/api/src/lib/integrations/oauth/` (or similar). Per-Platform implementations live there.
- Existing Slack OAuth code in `slack.ts` is lifted out and becomes the first `PlatformOAuthHandler` implementation; the routes are renamed from `/api/v1/slack/{install,callback}` to `/api/v1/integrations/:platform/{install,callback}`.
- `auth/server.ts` is **not touched** by this milestone.
- If at some future point a Platform needs both user-identity OAuth (e.g. "sign in with Slack") AND workspace-bot OAuth, the user-identity side goes through Better Auth and the bot side goes through `PlatformOAuthHandler` — they are independent flows even if they target the same Platform vendor.

## References

- Better Auth user OAuth wiring: `packages/api/src/lib/auth/server.ts`, `oauth-claims.ts`
- Existing Slack integration OAuth: `packages/api/src/api/routes/slack.ts` (becomes the first `PlatformOAuthHandler`)
- Shared OAuth 2.1 primitives: `@atlas/oauth-helper` (PR #2203, arch-win #51)
- Storage separation: ADR-0003
