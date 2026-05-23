# ADR-0003: Chat Workspace Connections use two stores by concern

**Status:** Accepted
**Date:** 2026-05-19
**Context milestone:** Multi-Adapter SaaS Readiness (forthcoming)
**Depends on:** [ADR-0002](./0002-catalog-seeded-from-config-at-boot.md)
**Related:** Closes the "two stores" question raised in #2634 (which consolidated bot tokens onto `chat_cache`)

## Context

A Workspace Connection (per CONTEXT.md: the OAuth-completed link between a single customer Workspace and a single Platform) carries two distinct kinds of data:

- **Install metadata** — when the Connection was created, by whom, what plan it counts under, per-workspace install configuration (channel allowlist, proactive enable flag, etc.). Changes infrequently, benefits from typed columns and explicit foreign keys.
- **Credentials** — the per-platform bot token, app token, refresh token, signing secret. Per-Platform-shaped (Slack token shape ≠ Teams token shape ≠ Discord token shape). Read every event, written rarely.

These concerns previously collided in `slack_installations` (a typed Postgres table) and `chat_cache:slack:installation:<teamId>` (JSONB key-value, populated by `@chat-adapter/slack`). PR #2634 consolidated *credentials* onto `chat_cache`. This ADR addresses the question that remained open: where does install *metadata* live?

## Decision

**Two stores, separated by concern:**

- **`workspace_plugins`** holds install metadata. One row per (Workspace × Platform) Connection. References `plugin_catalog.id` (the catalog entry being installed). Has typed columns: `workspace_id`, `catalog_id`, `enabled`, `installed_at`, `installed_by`, `config` JSONB.
- **`chat_cache`** holds credentials. Key prefix `<platform>:installation:<externalTeamId>`. Per-Platform-shaped JSONB value. Owned by the `@chat-adapter/<platform>` package's state adapter — Atlas doesn't touch the value shape.

The two stores are joined at runtime by an indirection: install metadata says "this Workspace has Slack installed"; credentials are resolved on demand by mapping `(platform, workspaceId)` → `chat_cache` key.

## What lives where

| Concern | Store | Why |
|---|---|---|
| "Does Workspace X have Slack installed?" | `workspace_plugins` (typed query) | Listener gate at event time; admin UI read |
| "What's the bot token for Slack team T?" | `chat_cache:slack:installation:<T>` | Per-event credential lookup; written by chat-adapter state |
| "Which Workspace owns Slack team T?" | Reverse lookup via either store | Today via `chat_cache.value.orgId` (post-#2634); could also be denormalized via a `workspace_chat_adapters` table if perf demands |
| "What channels has Workspace X allowlisted for proactive?" | `channel_proactive_config` (already exists) | Per-workspace per-channel config; layered on top of `workspace_plugins` |
| "Is proactive enabled for Workspace X?" | `workspace_proactive_config` (already exists) | Per-workspace toggle; gates `workspace_plugins` install when feature is off |

`workspace_plugins` is the **outermost gate**: no install row = no Connection exists = listener silently drops events for that workspace. `workspace_proactive_config` and `channel_proactive_config` are layered config *on top of* a present `workspace_plugins` row — they tune behavior, they don't gate existence.

## Alternatives considered

### Single store (collapse credentials into `workspace_plugins.config`)

Rejected because:
- Credentials are per-Platform-shaped; forcing them into one JSONB column makes typed access ugly and couples Atlas to every Platform's auth model
- `@chat-adapter/<platform>` already writes to its own state store; making Atlas the source of truth for credentials means re-implementing what every chat-adapter handles natively
- Encryption envelope (`SLACK_ENCRYPTION_KEY`) is already wired symmetrically across Atlas's OAuth write side and the adapter's per-event read side via `chat_cache` (post-#2634). Don't disturb working machinery.

### Single store (collapse metadata into `chat_cache`)

Rejected because:
- Metadata wants typed columns + FKs + indexes against `workspace_id`; `chat_cache` is intentionally schemaless key-value
- Plan gating and audit ("who installed this, when") want explicit columns; cramming into JSONB hides them
- `workspace_plugins` is the natural target for the `plugin_catalog` FK and the install-record audit trail

## Consequences

**For the listener gate** — at event time:
1. Resolve `(platform, externalTeamId) → workspaceId` from `chat_cache` (existing)
2. Confirm `workspace_plugins` row exists where `workspace_id = X AND catalog_id = '<platform>' AND enabled = true`
3. If yes: proceed. If no: silent skip (no classify, no meter, no rate-limit hit)
4. Per-platform features (proactive) layer additional gates: read `workspace_proactive_config` for global enable, `channel_proactive_config` for channel allowlist

**For OAuth callback** — on install success:
1. Resolve `workspace_id` from the OAuth state (Atlas-side session)
2. INSERT `workspace_plugins` row (catalog_id = '<platform>')
3. Adapter writes credentials to `chat_cache` (existing)
4. Both should succeed atomically — wrap in a transaction OR accept that a transient credential-write failure leaves an installable-but-broken Connection that the customer can re-trigger via "Reconnect"

**For uninstall** — on disconnect:
1. DELETE `chat_cache:<platform>:installation:<T>` for that team — credentials FIRST
2. DELETE `workspace_plugins` row — install metadata SECOND
3. Order is load-bearing: credentials must not outlive the install record. If `workspace_plugins` went first and the credential delete then failed, the bot token would still be sitting in `chat_cache` with no admin-visible UI to reach it. The reverse failure mode (install row dangles, credentials gone) is recoverable — the listener gate's downstream credential lookup fails on the next event and silently skips.

## References

- `workspace_plugins` schema: `packages/api/src/lib/db/schema.ts`
- `chat_cache` schema: `plugins/chat/src/state/pg-adapter.ts`
- Credential consolidation onto `chat_cache`: PR #2634
- Slack OAuth callback (current owner of install metadata writes): `packages/api/src/api/routes/slack.ts`
- See `CONTEXT.md` for canonical terminology (Workspace Connection, Adapter, Platform)
