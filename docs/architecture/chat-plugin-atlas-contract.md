# Chat-plugin × Atlas extension contract

**Status:** Active — keep current with every PR that touches the boundary.
**Owner:** the PR that changes the boundary owns the matching row update here.
**Related:** [ADR-0003](../adr/0003-two-store-chat-install-metadata-credentials.md), [ADR-0004](../adr/0004-platform-oauth-is-not-better-auth.md).

## How we got here

The 1.5.2 chat-plugin migration (#2607 trail: #2613 → #2617 → #2618 → #2619 → #2621 → #2625 → #2626 → #2629) replaced the legacy `packages/api/src/api/routes/slack.ts` paths with `plugins/chat/src/...` routes. Three hotfixes in three weeks shared one root cause — the migration ported the happy path while silently dropping an Atlas-side state contract that the legacy code owned:

| # | Hotfix PR | What was dropped | Symptom |
|---|---|---|---|
| 1 | #2628 | `channelAllowed` read from `channel_proactive_config` — new code-path read a legacy env-var instead | Proactive 🤖 didn't fire even when the channel row had `allow = true` |
| 2 | #2630 | `botToken` placeholder forced single-workspace mode; multi-tenant chat-adapter couldn't look up real tokens | Token lookups in multi-tenant Slack flow degraded silently |
| 3 | #2676 | `orgId` field in `chat_cache` — chat-adapter's `setInstallation` rewrote the row without it on every event | `resolveWorkspaceId` returned null, every event silently skipped as "unknown tenant" |

Each fix was correct in isolation. This audit is the response to the recurring class — a deliberate enumeration of every Atlas extension that rides alongside the chat-plugin / `@chat-adapter/*` boundary, plus the structural prevention that stops the next instance from reaching production.

## The boundary

`@useatlas/chat` (in `plugins/chat/`) and the per-platform `@chat-adapter/*` packages are intentionally Atlas-agnostic. They implement a generic chat protocol. Atlas extensions (`orgId`, proactive config schema, the listener callbacks, etc.) ride alongside via:

1. **Extension fields on shared rows** — Atlas writes additional keys into `chat_cache.value`. The chat-adapter reads the same row for its own fields and tolerates unknown keys.
2. **Atlas-owned tables read via callbacks** — `workspace_proactive_config`, `channel_proactive_config`, and the proactive quota / answer-flow callbacks. The chat-plugin holds no reference to Atlas's schema; the host wires fetchers under `chatPlugin({ proactive: { ... } })`.
3. **Atlas-owned write paths that produce chat-plugin-readable state** — `SlackOAuthInstallHandler` writes `workspace_plugins` (install metadata, Atlas-only) AND `chat_cache:slack:installation:<teamId>` (credentials, Atlas + adapter shared, per [ADR-0003](../adr/0003-two-store-chat-install-metadata-credentials.md)).

The contract is fragile in category (1) because writes from BOTH sides can land on the same row. Categories (2) and (3) are safer — Atlas owns the schema and the writers — but they still need the audit because a migration can drop a callback wiring or a write path.

## Contract table

Status legend: **✓ verified** (write + read + fail-loud confirmed at PR-merge time) · **⚠ partial** (write or read site has a known gap, tracked by issue) · **○ pending** (post-1.5.2 platform — slot reserved).

### `chat_cache.value` — Slack installation row (key `slack:installation:<teamId>`)

| Field | Owner | Legacy write site | New write site | Read sites | Fail-loud at read? | Status |
|---|---|---|---|---|---|---|
| `botToken` | chat-adapter | `packages/api/src/api/routes/slack.ts` (pre-#2682 OAuth callback → `saveInstallation`) | `lib/integrations/install/slack-oauth-handler.ts:258` (`saveInstallation`) + `@chat-adapter/slack:setInstallation` on every event (JSONB-merged) | `lib/slack/store.ts:200` (`getInstallation`), `lib/chat-plugin/executeQuery.ts:182`, `lib/scheduler/delivery.ts:156` | ✓ — `parseStoredInstallation` warns + returns null on missing/undecryptable token; `executeQuery` throws on missing installation | ✓ verified |
| `botUserId` | chat-adapter | adapter-only (never written by Atlas) | `@chat-adapter/slack:setInstallation` only — preserved across re-writes by the pg-adapter JSONB merge (#2676) | adapter-internal; Atlas does not read this field | n/a (adapter-internal) | ✓ verified |
| `teamName` | shared | `slack.ts` legacy OAuth callback | `lib/slack/store.ts:310` (`saveInstallation` mirrors `workspaceName` into `teamName`); `@chat-adapter/slack:setInstallation` (adapter sets it from `auth.test`) | `parseStoredInstallation` (falls back to `workspaceName`) | partial — both fields fall back to each other, missing both yields `workspace_name: null` (acceptable for display) | ✓ verified |
| `orgId` | **Atlas extension** | `slack.ts` legacy OAuth callback | `lib/slack/store.ts:311` (`saveInstallation`) — **sole writer**; preserved across `setInstallation` rewrites by the pg-adapter JSONB merge | `lib/slack/store.ts:268` (`getInstallationByOrg`), `lib/proactive/workspace-id-resolver.ts:102` (resolves `team_id` → `orgId`), `lib/chat-plugin/executeQuery.ts:192` (refuses on null), `lib/proactive/user-resolver.ts:202` (boolean `verifyWorkspace`) | ✓ — `executeQuery` throws; `workspace-id-resolver` warns on row-exists-but-missing (post-#2677); `getInstallationByOrg` returns null with the partial-expression index | ✓ verified |
| `workspaceName` | **Atlas extension** | `slack.ts` legacy OAuth callback | `lib/slack/store.ts:310` (`saveInstallation`) — sole writer; preserved by pg-adapter JSONB merge | `parseStoredInstallation` (display only) | n/a (display-only; admin UI tolerates null) | ✓ verified |
| `installedAt` | **Atlas extension** | `slack.ts` legacy OAuth callback | `lib/slack/store.ts:312` (`saveInstallation`) — sole writer; preserved by pg-adapter JSONB merge | `parseStoredInstallation` (falls back to row's `created_at`) | n/a (display-only) | ✓ verified |

### Atlas-owned tables read by the chat plugin via host callbacks

These don't ride on `chat_cache` — Atlas owns the schema and the writers. They're audited here because a migration that drops a callback wiring breaks the chat-plugin's view of Atlas state.

| Table / column | Host callback wired in `chatPlugin({ proactive: { ... } })` | Atlas read site | Atlas write site(s) | Fail-loud? | Status |
|---|---|---|---|---|---|
| `workspace_proactive_config.enabled` | `isEnabled` (gate) | `lib/proactive/enabled-gate.ts:243` | `routes/admin-proactive.ts:338` / `:378` / `:431` | ✓ — warn on read failure, treat as disabled | ✓ verified |
| `workspace_proactive_config` (full row) | `getWorkspaceConfig` | `lib/proactive/workspace-config-loader.ts:140` | `routes/admin-proactive.ts` (see above) | ✓ — warn + null return | ✓ verified |
| `channel_proactive_config.allow` | `getChannelConfigs` → `channelAllowed` decision | `lib/proactive/workspace-config-loader.ts:189` | `routes/admin-proactive.ts:557` / `:607` | ✓ — warn + empty-array fallback (post-#2628; previously fell back to `ATLAS_PROACTIVE_CHANNELS` env var) | ✓ verified |
| `workspace_proactive_config.monthly_classifier_cap` | `getQuotaStatus` | `lib/proactive/quota.ts:101` | `routes/admin-proactive.ts` (cap UPDATE) | ✓ — fail-open with `metadata.quotaReadFailed: true` meter tag | ✓ verified |
| `workspace_proactive_config.announcement_*` | `announcementCoordinator` (host-only — not exposed to the plugin) | `lib/proactive/announcement-coordinator.ts:203` | `lib/proactive/announcement-coordinator.ts:167` | ✓ — re-throws on write failure | ✓ verified |

### `workspace_plugins` — install metadata (Atlas-owned, no adapter writes)

| Column | Writer | Reader | Fail-loud? | Status |
|---|---|---|---|---|
| `workspace_id` + `catalog_id` + `enabled` + `installed_at` | `lib/integrations/install/slack-oauth-handler.ts:227` | `lib/plugins/validation.ts:106` (boot validation); admin UI via `routes/admin-integrations.ts` | ✓ — unique index `idx_workspace_plugins_unique` plus the boot-time stale-config validator | ✓ verified |
| `config` JSONB (`team_id`, `team_name`, `bot_user_id`, `scopes`, `app_id`) | `slack-oauth-handler.ts:227` (`ON CONFLICT … DO UPDATE SET config = EXCLUDED.config`) | admin UI; `lib/plugins/validation.ts` parses against catalog schema at boot | ✓ — schema validation runs at boot; mismatches surface as warn rows | ✓ verified |

### Future platforms (post-1.5.2)

`plugins/chat/src/adapter-registry.ts:74` keeps `enabled: false` catalog placeholders for Teams, Discord, gchat, Telegram, GitHub, Linear, WhatsApp. Their event-loop wiring lands in 1.5.3 alongside `StaticBotInstallHandler` (#2662). Each platform that gains an OAuth flow gets a new section in this table — one row per Atlas-extension field. Track:

- Does the platform have a per-tenant credential store equivalent to `chat_cache:slack:installation:<teamId>`?
- Does Atlas need to stamp `orgId` onto it? (Always yes when an Atlas-side resolver needs `team_id → orgId`.)
- Is the platform's state adapter doing a `SET value = EXCLUDED.value` overwrite, or a JSONB merge? (Must be merge if Atlas stamps extension fields.)

| Platform | Slot reserved | Issue | Status |
|---|---|---|---|
| Teams | yes (catalog placeholder) | #2662 | ○ pending — 1.5.3 |
| Discord | yes | #2662 | ○ pending — 1.5.3 |
| gchat | yes | #2662 | ○ pending — 1.5.3 |
| Telegram | yes | #2662 | ○ pending — 1.5.3 |
| GitHub | yes | #2662 | ○ pending — 1.5.3 |
| Linear | yes | #2662 | ○ pending — 1.5.3 |
| WhatsApp | yes | #2662 | ○ pending — 1.5.3 |

## Structural prevention

Three options were considered (issue #2677 §"Structural prevention candidates"):

- **A — wrap chat-adapter writes via Atlas's helper.** Make Atlas's `saveInstallation` the sole writer of installation rows.
- **B — schema-level invariant.** A boot-time health check that scans `chat_cache` for `slack:installation:*` rows missing `orgId` under SaaS.
- **C — type-level invariant.** A `ChatCacheSlackInstallation` shape in `@useatlas/types` with `orgId` non-optional in SaaS mode.

**The chosen prevention is a refinement of A, already shipped in #2676 and audited here:**

> The pg-adapter (`plugins/chat/src/state/pg-adapter.ts:163-203`) JSONB-merges every write to a `slack:installation:*` key. Atlas's `saveInstallation` writes the full extension set; the chat-adapter's `setInstallation` rewrites only its own fields; the merge preserves both. All other `chat_cache` keys (`oauth:slack:*`, `__queue:*`, etc.) keep the standard `EXCLUDED.value` overwrite — semantic split tested at `plugins/chat/src/state/pg-adapter.test.ts:343-383` (`#2676` regression tests).

A is the lightest prevention and lines up with [ADR-0003](../adr/0003-two-store-chat-install-metadata-credentials.md): Atlas owns the install-metadata writer (`workspace_plugins` + the credential write via `saveInstallation`); the adapter handles per-event credential reads/refreshes. The JSONB merge is the bridge that lets the adapter keep its existing state lifecycle without re-implementing Atlas extension awareness.

B and C are not implemented today. Reasons:

- **B (boot-time scan)** would catch retrospective drift but adds startup cost; the JSONB merge prevents the violation at write time, which is strictly better unless a new write path bypasses the pg-adapter. If a future platform adds a non-merging state backend (e.g. a future Redis state adapter), the bootstrap scan would be worth revisiting — file as a follow-up at that time.
- **C (type-level invariant)** would add a `@useatlas/types` shape that the chat-adapter's `setInstallation` couldn't satisfy directly (it writes a subset). Forcing the adapter to satisfy the full Atlas shape would couple the boundary in the wrong direction. The runtime read-site warn (this PR, `workspace-id-resolver.ts`) is the lighter mechanism and surfaces the same class of bug in logs.

### Read-side fail-loud invariant (added this PR)

`lib/proactive/workspace-id-resolver.ts` previously collapsed two distinct null cases into a silent null return:

1. **`installation === null`** — unknown tenant. Silent skip is correct.
2. **`installation` exists but `org_id` is null** — contract violation. This was the #2676 outage and was indistinguishable from case (1) in logs.

Post-#2677 the resolver distinguishes them: case (2) emits a `warn` with `teamId` so the audit catches a write-path that bypassed both `saveInstallation` AND the pg-adapter merge. The warn is bounded (one row per affected `team_id` per Slack event) and operator-actionable.

## How to update this doc

Any PR that touches the chat-plugin × Atlas boundary updates the table above. The CLAUDE.md checklist enforces this. Concretely:

- Adding an Atlas-extension field to `chat_cache.value` → add a row to §"Chat installation row".
- Adding a host callback (`chatPlugin({ proactive: { ... } })` or future `chatPlugin({ ... })` slots) → add a row to §"Atlas-owned tables read by the chat plugin".
- Adding a new platform's OAuth → flip the platform's pending row to verified and add per-field rows.
- Changing a read site's fail-loud behaviour → update the "Fail-loud at read?" column for affected rows.

A row's **Status** flips to ⚠ partial the moment a known gap is identified, and stays ⚠ until a follow-up issue closes. Open ⚠ rows are blockers for marking the milestone closeout complete.

## Closeout verification — would the audit have caught the three antecedents?

The audit is only useful if it surfaces the failure modes that caused #2628, #2630, and #2676. Walking each through the contract table:

- **#2628** — `channelAllowed` read from env var instead of `channel_proactive_config.allow`. The table row in §"Atlas-owned tables read by the chat plugin" pins the read site to `workspace-config-loader.ts:189` and notes the post-#2628 env-var fallback. A PR that re-routed the read back to env would diff against this row and require a status flip — auditor catches it. ✓
- **#2630** — `defaultBotToken` placeholder in `deploy/api/atlas.config.ts` forced the chat-adapter into single-workspace mode. The audit captures the contract under §"chat installation row" for `botToken`: the adapter reads per-tenant from `chat_cache:slack:installation:<teamId>` on every event. A deploy-config that sets `defaultBotToken` to a placeholder contradicts that contract — the audit comparison surfaces "adapter is meant to look up per-tenant tokens, but `defaultBotToken` is set" as a direct mismatch. The contract row would have forced the reviewer to ask "why does the adapter need a default token if multi-tenant lookups go through `chat_cache`?" ✓
- **#2676** — chat-adapter's `setInstallation` overwrote the row and dropped `orgId`. The table row marks `lib/slack/store.ts:311 (saveInstallation)` as the **sole writer** of `orgId`. Reads from `workspace-id-resolver.ts:102` resolve `team_id → orgId`. A `SET value = EXCLUDED.value` write path from the adapter contradicts "sole writer + preserved across rewrites" — the audit row would have read as a direct contradiction. Post-fix, the row's "preserved across `setInstallation` rewrites by the pg-adapter JSONB merge" annotation locks in the prevention. ✓

In each case, the audit table contains a single row whose contents are inconsistent with the broken migration — i.e. the auditor would have had to either update the row (and reviewers would push back on the contract change) or refuse the migration. The CLAUDE.md checklist enforces the first.

## References

- ADR-0003 (two-store install metadata + credentials): `docs/adr/0003-two-store-chat-install-metadata-credentials.md`
- ADR-0004 (platform OAuth is not Better Auth): `docs/adr/0004-platform-oauth-is-not-better-auth.md`
- #2628 fix PR: `cb50a203` — `channelAllowed` from DB row, not env var
- #2630 fix PR: `a7679d0d` — drop SaaS botToken placeholder
- #2676 fix PR: `d6317d0f` — JSONB-merge `slack:installation:*` writes
- #2677 audit (this doc): `refactor/2677-chat-plugin-atlas-contract`
