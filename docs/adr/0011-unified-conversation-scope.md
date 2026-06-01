# ADR-0011: Unified conversation scope — SQL routing + REST scope (exclude-set + REST-only focus)

**Status:** Accepted
**Date:** 2026-05-31
**Milestone:** v0.0.4 — Conversation Scope
**Supersedes:** the "Picker surface" consequence of [ADR-0010](./0010-rest-datasource-environment-scoping.md) (REST datasources as a read-only footer, "without rendering them as pickable"). ADR-0010's scoping model, resolver tri-state, and `catalog_id` discriminator are retained and extended.
**Builds on:** ADR-0010 (REST datasource environment scoping), #2518 (Auto/Pin/All routing), #3044 (persisted picker preference)
**Issue:** [#3063](https://github.com/AtlasDevHQ/atlas/issues/3063)

## Context

ADR-0010 made a pinned conversation's REST reach *explicit* but kept REST datasources out of the picker as a read-only footer. Dogfooding (#3063) surfaced two problems the footer didn't solve:

1. **No control.** The footer tells you Stripe answers in every environment but gives no way to *exclude* it from a conversation, or to ask a *REST-only* question.
2. **"Only postgres" mental-model gap.** With zero REST datasources installed the footer doesn't render, so the picker reads as "SQL environments only" and REST feels absent rather than workspace-global-and-default-on.

Separately, the picker's selection was never truly per-conversation: SQL routing is written to the `conversations` row but **never read back** into the picker when a conversation is opened, and the #3044 `localStorage` preference (meant to survive reload) loses to the default seed on a fresh mount — the single-pass seed/restore effect commits the default before the preference is honoured, and its `if (selectedConnectionId !== null) return` guard then locks that default in.

## Decision

**The env picker becomes the *scope picker* (`ChatScopePicker`) — a per-conversation control over Conversation scope, with two axes.** (Terminology: CONTEXT.md → *Conversation scope*. Umbrella = **Conversation scope**; axes = **SQL routing** / **REST scope**.)

1. **SQL routing** — unchanged: a connection group + Auto/Pin/All routing mode over its members (`executeSQL`).
2. **REST scope** — new, first-class, with two states:
   - **Default** — the workspace's REST datasources render as toggleable rows (default checked = in scope). Unchecking *excludes* a datasource. Persisted as an **exclude-set** `conversations.rest_excluded_datasource_ids text[] DEFAULT '{}'`. Default `{}` = all in scope, so a newly-added REST datasource is reachable by default — preserving ADR-0010's workspace-global-by-default. SQL routing stays active.
   - **Focused (REST-only)** — selecting a single REST datasource as the focus targets it exclusively and **suspends SQL** for the conversation (no `executeSQL`). Persisted as `conversations.rest_focus_datasource_id text` (nullable). When set, the exclude-set and SQL-routing fields are inert but retained, so clearing focus returns to the prior default-state scope.

**Scope is per-conversation and authoritative, with a sticky preference for new chats.** Every scope change stamps the full scope onto the `conversations` row (authoritative for that conversation) **and** updates a workspace-scoped `localStorage` preference (the *sticky last selection*). Opening a conversation restores its scope from the row; a brand-new chat seeds from the sticky preference, else the default seed. Precedence on load: **conversation row > sticky preference > default seed.** The reset-on-reload bug is fixed at this seam — the default seed must not pre-empt a restorable preference: gate the seed on preference-store hydration (`persist.hasHydrated()`) **and** a resolved workspace id, and track seed *provenance* (default-seeded vs explicit/restored) so a later-arriving matching preference can override a default-seeded value rather than being blocked by the guard.

**Resolver + agent loop.** `resolveWorkspaceRestDatasources(orgId, activeGroupId?, { excluded?, focus? })` filters by the conversation's REST scope: in *default* state, drop the exclude-set (after ADR-0010's group-scope filter and before credential resolution, preserving the never-rejects fail-soft contract); in *focused* state, resolve only the focus target. A focused conversation runs the agent **without `executeSQL`** (SQL suspended). The authorized confirm-replay path (`tools/rest-operation.ts` `resolveFromContext`, `activeGroupId === undefined`) ignores REST scope — a signed staged write replays regardless of picker state. ADR-0010's tri-state `activeGroupId` semantics and the `REST_DATASOURCE_CATALOG_IDS` discriminator are unchanged.

## Consequences

- **Migration.** Adds `conversations.rest_excluded_datasource_ids text[] DEFAULT '{}'` and `conversations.rest_focus_datasource_id text` (nullable) with matching Drizzle `schema.ts` mirrors in the same PR (schema-drift gate) + a real-Postgres migration smoke.
- **Published type.** `@useatlas/types` `Conversation` gains both fields; the dependent-package ref bump is sequenced *after* publish (0.0.x exact-pin rule).
- **Wire.** The chat request body and `GET /conversations/:id` carry the exclude-set + focus; `GET /me/connection-groups` already returns the workspace's REST datasources (ADR-0010). The sticky-preference store (`chat-routing-preference-store.ts`) gains the two REST fields.
- **Agent.** A focused conversation suspends `executeSQL`; the toolkit/prompt must reflect a REST-only turn.
- **Chip.** The scope chip distinguishes states — e.g. `Pin · apac-prod · 2/3 REST` (default) vs `Stripe only` (focused).
- **ADR-0010 retained except the picker surface.** The scoping model, resolver tri-state, and discriminator stand; only "REST is a read-only footer, not pickable" is superseded.
- **Out of scope (separate issue).** `conversationId` is in-memory `useState`, so a reload still lands in a blank chat rather than reopening the active conversation. Restoring the active conversation across reload (conversationId in URL state) is tracked separately.

## Alternatives considered

- **Keep footer-only (uphold ADR-0010).** Rejected in the #3063 grill — surfacing REST reach without control didn't solve the dogfooding pain.
- **Include-set instead of exclude-set.** Rejected: a newly-added REST datasource would silently fall out of scope, fighting workspace-global-by-default.
- **Exclude-set only, no REST-only focus.** Considered as the minimal model; rejected in favour of adding focus so a "REST-only" question (no SQL) is expressible directly rather than by unchecking every other datasource while SQL still runs.
- **Pure client UI preference for REST.** Rejected: a conversation's REST scope would differ per browser and not survive a device switch or a shared link; scope must be per-conversation authoritative like SQL routing already is.
- **"Reach" / "routing" as the umbrella term.** Rejected in favour of "Conversation scope" (CONTEXT.md).
