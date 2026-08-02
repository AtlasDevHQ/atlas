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
| 4 | #4907 | `botUserId` — Atlas's OAuth handler replaced the adapter's own callback (the field's only writer) and captured `bot_user_id` into `workspace_plugins.config` instead of `chat_cache` | `isMessageFromSelf` false for every self-post; Atlas answered its own messages in an unbounded prod loop |

Row 4 is the same shape as row 2, inverted: there, Atlas wrote a placeholder the adapter needed to be real; here, Atlas wrote the right value to the wrong store. Both come from Atlas owning a write path the adapter also owns — and in both, the adapter degraded silently rather than announcing the missing input. **When Atlas takes over one of the adapter's write paths, it inherits every field that path wrote, not just the ones Atlas reads — and it must write them where the adapter looks.** `bot_user_id` was never invisible; it was parsed and persisted the whole time, just into the Atlas-side store the adapter does not read. Capturing a field is not persisting it.

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

Citations are `path/file.ts:fn()` so refactors that shift line numbers don't silently invalidate the row. A line number is included when the cited symbol is a specific statement inside a larger function.

| Field | Owner | Legacy write site | New write site | Read sites | Fail-loud at read? | Status |
|---|---|---|---|---|---|---|
| `botToken` | chat-adapter | `packages/api/src/api/routes/slack.ts` legacy OAuth callback (route file removed in #2689) | `lib/integrations/install/slack-oauth-handler.ts:SlackOAuthInstallHandler.handleCallback()` (calls `saveInstallation`) — **sole writer**. (Corrected #4907: this row previously said `@chat-adapter/slack:setInstallation` also writes "on every event". At v4.23.0 `setInstallation` has exactly one caller, the adapter's own `handleOAuthCallback`, which Atlas bypasses.) | `lib/slack/store.ts:getInstallation()` (line 200) → `parseStoredInstallation()`; reached transitively from `lib/chat-plugin/executeQuery.ts` (interactive) and `lib/scheduler/delivery.ts` via `getBotToken()` (line 384) | ✓ — `parseStoredInstallation` warns + returns null on missing/undecryptable token; `executeQuery` throws on missing installation | ✓ verified |
| `botUserId` | chat-adapter | adapter-only (never written by Atlas) | `lib/slack/store.ts:saveInstallation()` from `oauth.v2.access`'s `bot_user_id` (#4907) — **Atlas is the sole writer in practice**; the adapter's only writer is its own `handleOAuthCallback`, which Atlas bypasses by running `SlackOAuthInstallHandler`. Omitted from the JSONB payload when absent so the merge preserves a stored id | `@chat-adapter/slack:resolveTokenForTeam()` → request-context `botUserId` → `isMessageFromSelf()`. Atlas itself does not read it | ⚠ — silent. A missing id makes `isMessageFromSelf` return false for every self-post; `plugins/chat/src/bridge.ts:recordReplyForBreaker()` is the backstop, and install logs a warning | ✓ verified |
| `teamName` | shared | `slack.ts` legacy OAuth callback (removed in #2689) | `lib/slack/store.ts:saveInstallation()` mirrors `workspaceName` into `teamName` — **sole writer**. (Corrected #4907: previously credited `setInstallation` "from `auth.test`"; the adapter sources it from `result.team.name` in `handleOAuthCallback`, which Atlas bypasses, and `auth.test` never writes it.) | `parseStoredInstallation()` (falls back to `workspaceName`) | lenient — both fields fall back to each other; missing both yields `workspace_name: null` (acceptable for display) | ✓ verified |
| `orgId` | **Atlas extension** | `slack.ts` legacy OAuth callback (removed in #2689) | `lib/slack/store.ts:saveInstallation()` — **sole writer**; preserved across `setInstallation` rewrites by the pg-adapter JSONB merge | `lib/slack/store.ts:getInstallationByOrg()` (line 247); `ee/src/proactive/workspace-id-resolver.ts:createSlackWorkspaceIdResolver()` (resolves `team_id` → `orgId`); `lib/chat-plugin/executeQuery.ts:executeChatPluginQuery()` (refuses on null, line 192); `ee/src/proactive/user-resolver.ts:defaultVerifyWorkspace()` (boolean) | ✓ — `executeQuery` throws (interactive path); `workspace-id-resolver` warns on row-exists-but-missing with per-teamId dedup (post-#2677, proactive path); `getInstallationByOrg` returns null backed by the partial-expression index | ✓ verified |
| `workspaceName` | **Atlas extension** | `slack.ts` legacy OAuth callback (removed in #2689) | `lib/slack/store.ts:saveInstallation()` — sole writer; preserved by pg-adapter JSONB merge | `parseStoredInstallation()` (display only) | n/a (display-only; admin UI tolerates null) | ✓ verified |
| `installedAt` | **Atlas extension** | `slack.ts` legacy OAuth callback (removed in #2689) | `lib/slack/store.ts:saveInstallation()` — sole writer; preserved by pg-adapter JSONB merge | `parseStoredInstallation()` (falls back to row's `created_at`) | n/a (display-only) | ✓ verified |

**Read-site responsibility split.** `parseStoredInstallation` is the structural parser — it warns on missing `botToken` (the field every consumer needs to decrypt) but coerces missing Atlas extensions to `null` so display-only callers tolerate legacy rows. The contextual fail-loud lives at each consumer:

- **Interactive (`executeQuery.ts`)** — refuses with a user-safe error message when `installation.org_id` is null. F-55 actor binding requires a known tenant.
- **Proactive (`workspace-id-resolver.ts`)** — warns with per-`teamId` dedup (5-minute window) when `installation.org_id` is null, then null-returns to silent-skip the event. Proactive can't refuse interactively because Slack already accepted the event; the warn is the only signal an operator gets.
- **Scheduler (`delivery.ts`)** — relies on `getBotToken()`'s null return; a missing tenant yields a `DeliveryError` from the calling `Effect.tryPromise`.

### Atlas-owned tables read by the chat plugin via host callbacks

These don't ride on `chat_cache` — Atlas owns the schema and the writers. They're audited here because a migration that drops a callback wiring breaks the chat-plugin's view of Atlas state.

| Table / column | Host callback wired in `chatPlugin({ proactive: { ... } })` | Atlas read site | Atlas write site(s) | Fail-loud? | Status |
|---|---|---|---|---|---|
| `workspace_proactive_config.enabled` | `isEnabled` (gate) | `ee/src/proactive/enabled-gate.ts:createProactiveEnabledGate()` | `routes/admin-proactive.ts` (`enable` / `disable` / `PATCH /admin/proactive` handlers) | ✓ — warn on read failure, treat as disabled | ✓ verified |
| `workspace_proactive_config` (full row) | `getWorkspaceConfig` | `ee/src/proactive/workspace-config-loader.ts:getWorkspaceProactiveConfig()` | `routes/admin-proactive.ts` (see above) | ✓ — warn + null return | ✓ verified |
| `channel_proactive_config.allow` | `getChannelConfigs` → `channelAllowed` decision | `ee/src/proactive/workspace-config-loader.ts:getChannelProactiveConfigs()` | `routes/admin-proactive.ts` (`PUT /admin/proactive/channels` / `DELETE`) | ✓ — warn + empty-array fallback (post-#2628; previously fell back to `ATLAS_PROACTIVE_CHANNELS` env var) | ✓ verified |
| `workspace_proactive_config.monthly_classifier_cap` | `getQuotaStatus` | `ee/src/proactive/quota.ts:getWorkspaceQuotaStatus()` (wraps the lower-level `getMonthlyClassifierCap()` in a fail-open envelope) | `routes/admin-proactive.ts` (cap UPDATE) | ✓ — `getWorkspaceQuotaStatus` returns `{ readFailed: true }` on DB error; the listener emits a `classify` meter row with `metadata.quotaReadFailed: true` | ✓ verified |
| `workspace_proactive_config.announcement_*` | `announcementCoordinator` (host-only — not exposed to the plugin) | `ee/src/proactive/announcement-coordinator.ts:announceActivation()` (probe block) | `ee/src/proactive/announcement-coordinator.ts:announceActivation()` (claim UPDATE) | ✓ — re-throws on write failure | ✓ verified |

### `workspace_plugins` — install metadata (Atlas-owned, no adapter writes)

| Column | Writer | Reader | Fail-loud? | Status |
|---|---|---|---|---|
| `workspace_id` + `catalog_id` + `enabled` + `installed_at` | `lib/integrations/install/slack-oauth-handler.ts:SlackOAuthInstallHandler.handleCallback()` (INSERT … ON CONFLICT … DO UPDATE) | `lib/plugins/validation.ts:validateWorkspacePluginConfigs()` (boot validation); admin UI via `routes/admin-integrations.ts` | ✓ — unique index `idx_workspace_plugins_unique` plus the boot-time stale-config validator | ✓ verified |
| `config` JSONB (`team_id`, `team_name`, `bot_user_id`, `scopes`, `app_id`) | same `handleCallback()` (`ON CONFLICT … DO UPDATE SET config = EXCLUDED.config`) | admin UI; `lib/plugins/validation.ts` parses against catalog schema at boot | ✓ — schema validation runs at boot; mismatches surface as warn rows | ✓ verified |

### Operator credential overlay — `ChatPluginConfig.resolveAdapterEnv` (#3704, #3735)

A host callback at the **top-level `chatPlugin({ ... })` config** boundary (not under
`proactive`): the plugin builds its per-platform adapters from a `process.env`-shaped
object, and `resolveAdapterEnv` lets Atlas overlay operator-tier credentials read from
the encrypted `operator_integration_credentials` store on top of that env before each
build/rebuild. This is what makes the operator app credentials (e.g. the Slack OAuth
app's `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` / `SLACK_SIGNING_SECRET` /
`SLACK_ENCRYPTION_KEY`) settable from the Admin console without a redeploy.

| Boundary field | Host wiring | Atlas resolver | Refresh trigger | Precedence | Status |
|---|---|---|---|---|---|
| `ChatPluginConfig.resolveAdapterEnv` | wired in `deploy/api/atlas.config.ts` → `resolveOperatorAdapterEnv()` | `lib/integrations/operator-credentials/resolver.ts:resolveOperatorAdapterEnv()` (returns a DB-only overlay; the plugin merges it as `{ ...process.env, ...overlay }`, so DB wins and unset keys fall through to env) | `PluginRegistry.refresh("chat-interaction")` — teardown + re-init the chat plugin so a console write/rotation applies with no process restart (called by `routes/admin-operator-integrations.ts` on every `PUT`/`DELETE`) | **DB row → operator env var → unset**, per field (`resolveOperatorFieldValue`) | ✓ verified |

**Boundary contract.** `resolveAdapterEnv` is **additive and host-optional**: the
plugin works unchanged when it's absent (self-host reads adapter env straight from
`process.env`). Atlas wires it only on the DB-backed deployments. The overlay is
**DB-only** — env passthrough is the merge's job, not the resolver's — so a decrypt /
corruption failure throws rather than silently dropping the platform to env-only (a
broken rotation must surface, not boot degraded). The managed-platform field set lives
in `operator-credentials/platforms.ts` (`OPERATOR_PLATFORMS`); each field's `envVar` is
both the bundle storage key and the `process.env` key the adapter builder reads, so env
stays the self-host fallback unchanged. ⚠ row to watch: any change to the shape of the
overlay (e.g. nesting, or a non-string value) breaks the `{ ...process.env, ...overlay }`
merge contract — the overlay must stay a flat `Record<string, string>`.

### Adapter identity — `SlackAdapterConfig.userName` / `Chat.userName` (#4909)

The bot's own handle at the `@chat-adapter/slack` construction boundary. Not
cosmetic: it is the **only** working input to `detectMention`, the fallback the
SDK uses when `isMention` wasn't set from the event type.

| Boundary field | Owner | Atlas wiring | Adapter behaviour without it | Status |
|---|---|---|---|---|
| `SlackAdapterConfig.userName` | chat-adapter | `plugins/chat/src/adapters/slack.ts` passes `DEFAULT_BOT_USER_NAME` (`config.ts`), overridable per deploy | defaults to the literal `"bot"`; replaced from `auth.test` **only** inside `initialize()`, which runs solely on the single-workspace `defaultBotToken` path | ✓ verified |
| `Chat.userName` | chat SDK | `bridge.ts` `new Chat({ userName: DEFAULT_BOT_USER_NAME })` — same constant | — | ✓ verified |

**Boundary contract.** `detectMention` resolves the handle as
`adapter.userName || chat.userName`. Because the adapter's default `"bot"` is
**truthy, it shadows `chat.userName`** — setting only the `Chat` side looks correct
and silently does nothing. Both must come from one constant, which is why
`DEFAULT_BOT_USER_NAME` exists rather than two literals.

The id-based patterns in `detectMention` are **not** a backstop here: the async
parse path runs `resolveInlineMentions`, which rewrites `<@U0BOT…>` to the bot's
display name, so no user id survives in `message.text`. (That rewrite is meant to be
suppressed for the bot itself via `skipSelfMention`, but that guard reads the
adapter's instance `_botUserId`, which is null in multi-workspace — see the
`botUserId` row above.) Name matching is the only route.

⚠ row to watch: this is **single-workspace-safe and multi-workspace-broken** by
default — the class that produced both #4907 and #4909. Anything that relies on
`initialize()` having populated adapter instance state is dead in SaaS/BYOT.

### Durable approval-park resume delivery — `ChatPluginConfig.onBridgeReady` + `chat:resume-pending:<conversationId>` (#3750)

Durable sessions (#3742 family) let an agent turn **park** on an approval rule and
resume later. For a turn initiated from a chat thread, #3750 closes the loop:
instead of a dead-end ":lock: approve via the console" reply, the thread posts a
"waiting on approval" notice and is **resumed in-place** once a reviewer resolves
the request — the continued answer (or a denial) is posted back in the original
thread. The mechanism rides two boundary points, both **host-side / Atlas-owned**:

| Boundary field | Host wiring | Atlas resolver / store | Fail-loud? | Status |
|---|---|---|---|---|
| `ChatPluginConfig.onBridgeReady` (top-level config callback; invoked with the narrow `ChatResumeBridge` after `initialize()`, and `null` on `teardown()`) | wired in `deploy/api/atlas.config.ts` → `registerChatResumeDeliverer(...)` / `clearChatResumeDeliverer()` | `lib/chat-plugin/resume-delivery-registry.ts` (process-local port, mirrors `proactive/announcer-registry.ts`; `NULL_RESUME_DELIVERER` fallback so self-host w/o chat never fails a review). Deliverer re-enters the loop via `lib/chat-plugin/resume-turn.ts:resumeChatTurn()` and posts via `ChatBridge.postToThread()` | ✓ — `onBridgeReady` throw is caught at init (warn, plugin still boots); the deliverer never throws (maps failures to a `failed` outcome the review handler logs at error) | ✓ verified |
| `ChatBridge.postToThread(platform, threadId, message)` (new bridge method; narrow subset exposed to the host as `ChatResumeBridge`) | bridge impl in `plugins/chat/src/bridge.ts` posts via `adapter.postMessage(threadId, …)` — the same adapter primitive the in-handler `thread.post()` wrapper ultimately calls | called by the registered deliverer (built by `buildChatResumeDeliverer`), wired in `deploy/api/atlas.config.ts` | ✓ — returns `null` (never throws) when the adapter is unconfigured or rejects the post; the deliverer treats `null` as a `failed` delivery | ✓ verified |
| `chat_cache.value` key `chat:resume-pending:<conversationId>` → `{ platform, threadId, orgId, externalId, externalUserId? }` (**Atlas-extension field**, category 1) | written at park by `lib/chat-plugin/executeQuery.ts` (the `pendingApproval` branch) via `lib/chat-plugin/resume-pending-store.ts:saveResumePending()` | read by `lib/chat-plugin/resume-delivery.ts:deliverChatResumeIfPending()` (`loadResumePending`), deleted on terminal delivery (`clearResumePending`); TTL = max-park window (`getMaxParkMinutes`) so a swept-to-`failed` parked run leaves no dangling row | ✓ — `saveResumePending` is fail-soft (returns false + warns; the turn still parks, just without auto-resume); `loadResumePending` null-returns + warns on a malformed row | ✓ verified |

**Why these are host-side (no `@chat-adapter/*` change).** The chat-adapter never reads
the `chat:resume-pending:*` key (only Atlas host code writes/reads/deletes it). `saveResumePending`'s
upsert does a full `value = EXCLUDED.value` overwrite — NOT the `value || EXCLUDED.value`
JSONB merge the `slack:installation:*` key uses — and Atlas owns both sides of this key,
so there is no cross-writer to preserve fields for. `onBridgeReady` is a top-level `chatPlugin({ ... })`
host callback in the same family as `announcementCoordinator` ("host-only — not exposed
to the plugin"): additive + host-optional (the plugin works unchanged when omitted —
self-host without durable resume). The security boundary lives in `resumeChatTurn`,
which re-resolves auth/connection/RLS **live** (rebuilds the original bot actor, re-runs
the billing gate, claims the single-resumer lease) before re-entering `runAgent({ resume })`
— a user who lost access while parked fails closed exactly as the web resume route does
(ADR-0020). ⚠ row to watch: any change to the `ChatResumeBridge` shape (a wider bridge
surface, or a non-string post payload) — keep it the minimal `postToThread` subset so the
host wires resume delivery without depending on the full `ChatBridge`.

**MCP note (no boundary):** the MCP surface needs no resume delivery — MCP has no agent
loop or durable run (each tool call is one synchronous dispatch; the MCP client is the
loop). A parked MCP `executeSQL`/`runMetric` call surfaces `approval_required` +
`approval_request_id` (already, pre-#3750) and "resumes" when the client **re-calls** the
identical tool after approval — the gate's `hasApprovedRequest` dedup lets the re-call
through, re-resolving auth/scoping live on that fresh dispatch. #3750 only adds an explicit
resume-hint string (`MCP_APPROVAL_RESUME_HINT`) to those results so the LLM client knows to
retry the same call. No MCP/chat-adapter boundary field changed.

### Company Brain chat webhook fast-path — `ChatPluginConfig.observeMessage` (#4967)

ADR-0036 §T6's freshness rule is "poll + reconcile universally, **plus** a webhook
fast-path for event-native chat". #4967 wires that fast-path as an **alternate writer
into the same idempotent episode store** the scheduled sync writes to, so a Slack message
becomes evidence in seconds rather than at the next sync tick. It rides one new boundary
point, host-side and Atlas-owned:

| Boundary field | Host wiring | Atlas resolver / store | Fail-loud? | Status |
|---|---|---|---|---|
| `ChatPluginConfig.observeMessage` (top-level config callback; invoked with `{ platform, message: Pick<Message, "id" \| "raw"> }` for every inbound message the bridge dispatches) | wired in `deploy/api/atlas.config.ts` → `createBrainChatMessageObserver()` | `lib/chat-plugin/brain-observer.ts` routes `platform === "slack"` to `lib/brain/ingest/slack/webhook.ts:ingestSlackWebhookMessage()`, which writes through the shared `ingestEpisodes` core. Non-Slack platforms are refused, not fallen through | ✓ — the writer never throws (every failure is a counted outcome + log), and `bridge.ts:buildObservedMessageHandler` wraps the host callback so a rejection cannot abort the remaining handlers for that message | ✓ verified |

**Why it takes `message.raw` and nothing else.** The writer reads Slack's own `channel`,
`ts`, `channel_type` and `subtype` off the raw event — none of which the SDK's normalised
`Message` carries. It gets no `Thread`, which is what keeps the seam one-way: an observer
cannot post, react, or subscribe, so it can never become a second author of chat behaviour.
Same `Pick<Message, "id" | "raw">` narrowing `ResolverEventLite` (proactive) already uses.

**Why it registers on three arms.** `Chat.dispatchToHandlers` is a router with early
returns — DM → subscribed → mention → pattern — so a pattern-only registration would miss
every @-mention and every subscribed-thread follow-up. The bridge registers the observer on
`onNewMention`, `onSubscribedMessage` **and** `onNewMessage(/[\s\S]/)` via
`registerMessageObserver`. The DM arm is deliberately skipped: 1:1 DMs are not admissible
channels for the brain's chat source. It registers **first**, because the SDK awaits
handlers sequentially and registering after the pillar handler would put the brain write
behind a full agent turn — the entire latency win, spent.

The proactive listener is the instructive contrast and is *not* pattern-only: it registers
the pattern arm **and** the DM arm (`proactive/listener.ts`), deliberately not
mention/subscribed, since it stays out of conversations Atlas is already in. The brain
observer inverts that exactly.

**The observer is deadline-bounded.** `buildObservedMessageHandler` races the host callback
against `OBSERVE_DEADLINE_MS` (2s). The try/catch bounds *errors*; only the deadline bounds
*duration*, and duration is the damaging one — the observer runs first, inline, while the
SDK holds the thread lock, and the host wires it to uncached internal-DB round trips whose
own connect timeout defaults to 10s. Three of those would exceed the SDK's 30s
`DEFAULT_LOCK_TTL_MS`, expiring the lock mid-handler.

**Poll stays the correctness floor — for top-level messages.** The knob
`ATLAS_BRAIN_CHAT_WEBHOOK_ENABLED` defaults **off**, and off is a fully-supported steady
state rather than a degraded one. The tee drops messages by design — the SDK's default
`drop` concurrency strategy discards a message whose thread lock is held, and
`@chat-adapter/slack`'s `ignoredSubtypes` filter drops `message_changed`/`message_deleted`
before dispatch.

⚠ **The lock is thread-scoped, so contention only ever drops thread replies** — and
`conversations.history` never returns replies, so those are lost rather than deferred. The
writer's not-stored outcomes carry `pollBackstopped` and the observer logs an unbacked loss
at warn. Do not restate the loose "anything dropped is stored next cycle" claim.

⚠ Row to watch: `handleMessageEvent`'s `ignoredSubtypes` set. If a future adapter version
stops filtering `message_changed`, the writer's edit handling (read `event.message.ts`,
never the envelope's `ts` or `edited.ts`) becomes a live path rather than a guard — it is
unit-tested either way.

⚠ Row to watch: the adapter's `team_id` envelope backfill in `processEventPayload`. Slack
puts `team_id` on the envelope, not inside `event`, and the fast path works only because
the adapter copies it down. If that stops, every event resolves to `unknown_workspace` and
the feature silently does nothing.

### Future platforms (post-1.5.2)

`plugins/chat/src/adapter-registry.ts` keeps catalog rows for Teams, Discord, gchat, Telegram, GitHub, Linear, WhatsApp. Telegram (#2748) is the first to ship a real `StaticBotInstallHandler` — the keystone slice for the remaining Phase D platforms. Each platform that gains an install flow gets a new section in this table — one row per Atlas-extension field. Track:

- Does the platform have a per-tenant credential store equivalent to `chat_cache:slack:installation:<teamId>`? (Static-bot platforms typically don't — the bot's auth lives operator-side and per-Workspace routing lives in `workspace_plugins.config` JSONB instead.)
- Does Atlas need to stamp `orgId` onto it? (Always yes when an Atlas-side resolver needs `team_id → orgId`.)
- Is the platform's state adapter doing a `SET value = EXCLUDED.value` overwrite, or a JSONB merge? (Must be merge if Atlas stamps extension fields.)

| Platform | Slot reserved | Issue | Status |
|---|---|---|---|
| Teams | yes | #2752 / #3142 | ✓ verified — **OAuth-shaped** install (like Discord) via `TeamsStaticBotInstallHandler`; per-Workspace `tenant_id` (Microsoft Entra ID tenant GUID, lowercased) in `workspace_plugins.config`; no per-Workspace credential store (operator-shared `TEAMS_APP_ID` + `TEAMS_APP_PASSWORD`, MultiTenant mode); the Azure AD admin-consent callback (`GET /api/v1/teams/callback`) returns the *verified* tenant id (ownership proof) and dispatches it into `confirmInstall` — cap-gated via `checkChatIntegrationLimitAndInstall` (the legacy uncapped `saveTeamsInstallation` write was removed); reachability re-verified via Microsoft OIDC discovery; the generic `/install-form` refuses Teams (`oauthShaped`); `@chat-adapter/teams` builder + `/webhooks/teams` receive route + executeQuery Teams branch (resolves `channelData.tenant.id` → workspace) wired in #3142 |
| Discord | yes | #2749 | ✓ verified — static-bot install via `DiscordStaticBotInstallHandler`; per-Workspace `guild_id` in `workspace_plugins.config`; no per-Workspace credential store; OAuth-shaped bot-install redirect at `/api/v1/integrations/discord/{install,callback}` (lives in `routes/integrations-discord.ts`); reachability verified via `GET /api/v10/guilds/{guild_id}` at install time |
| gchat | yes | #2754 | ✓ verified — static-bot install via `GchatStaticBotInstallHandler`; per-Workspace `workspace_id` (Google Workspace customer id) in `workspace_plugins.config`; no per-Workspace credential store; install triggered from the Google Workspace Marketplace listing; reachability verified via a Pub/Sub publish round-trip (operator-shared topic; `roles/pubsub.publisher` gate) before persisting |
| Telegram | yes | #2748 | ✓ verified — static-bot install via `TelegramStaticBotInstallHandler`; per-Workspace `chat_id` in `workspace_plugins.config`; no per-Workspace credential store; reachability verified via Bot API `getChat` at install time |
| GitHub | yes | #2662 | ○ pending — 1.5.3 |
| Linear | yes | #2662 | ○ pending — 1.5.3 |
| WhatsApp | yes | #2753 | ✓ verified — static-bot install via `WhatsAppStaticBotInstallHandler`; per-Workspace `phone_number_id` in `workspace_plugins.config`; no per-Workspace credential store (operator-shared `META_BUSINESS_ACCESS_TOKEN` does all sends + reads); reachability verified via Meta Graph API `GET /v21.0/{phone_number_id}` at install time |

## Structural prevention

Three options were considered (issue #2677 §"Structural prevention candidates"):

- **A — wrap chat-adapter writes via Atlas's helper.** Make Atlas's `saveInstallation` the sole writer of installation rows.
- **B — schema-level invariant.** A boot-time health check that scans `chat_cache` for `slack:installation:*` rows missing `orgId` under SaaS.
- **C — type-level invariant.** A `ChatCacheSlackInstallation` shape in `@useatlas/types` with `orgId` non-optional in SaaS mode.

**The chosen prevention is a refinement of A, already shipped in #2676 and audited here:**

> The pg-adapter (`plugins/chat/src/state/pg-adapter.ts:PgStateAdapter.set()`) JSONB-merges every write to a `slack:installation:*` key. Atlas's `saveInstallation` writes the full extension set; the chat-adapter's `setInstallation` rewrites only its own fields; the merge preserves both. All other `chat_cache` keys (`oauth:slack:*`, `__queue:*`, etc.) keep the standard `EXCLUDED.value` overwrite — semantic split tested at `plugins/chat/src/state/pg-adapter.test.ts` (`#2676` regression tests covering both branches).

A is the lightest prevention and lines up with [ADR-0003](../adr/0003-two-store-chat-install-metadata-credentials.md): Atlas owns the install-metadata writer (`workspace_plugins` + the credential write via `saveInstallation`); the adapter handles per-event credential reads/refreshes. The JSONB merge is the bridge that lets the adapter keep its existing state lifecycle without re-implementing Atlas extension awareness.

B and C are not implemented today. Reasons:

- **B (boot-time scan)** would catch retrospective drift but adds startup cost; the JSONB merge prevents the violation at write time, which is strictly better unless a new write path bypasses the pg-adapter. If a future platform adds a non-merging state backend (e.g. a future Redis state adapter), the bootstrap scan would be worth revisiting — file as a follow-up at that time.
- **C (type-level invariant)** would add a `@useatlas/types` shape that the chat-adapter's `setInstallation` couldn't satisfy directly (it writes a subset). Forcing the adapter to satisfy the full Atlas shape would couple the boundary in the wrong direction. The runtime read-site warn (this PR, `workspace-id-resolver.ts`) is the lighter mechanism and surfaces the same class of bug in logs.

### Read-side fail-loud invariant (added this PR)

`ee/src/proactive/workspace-id-resolver.ts` previously collapsed two distinct null cases into a silent null return:

1. **`installation === null`** — unknown tenant. Silent skip is correct.
2. **`installation` exists but `org_id` is null** — contract violation. This was the #2676 outage and was indistinguishable from case (1) in logs.

Post-#2677 the resolver distinguishes them: case (2) emits a `warn` with `teamId` so the audit catches a write-path that bypassed both `saveInstallation` AND the pg-adapter merge. The warn is rate-limited via a module-scoped `Map<teamId, lastWarnAt>` with a 5-minute dedup window — a stuck-orgId tenant emits one warn per 5 minutes, not one per Slack event. Operator-actionable on first occurrence; bounded log volume thereafter.

## Inbound webhook signature verification posture (#3350 audit, June 2026)

All signature verification is delegated to the out-of-repo `@chat-adapter/*`
packages (v4.23.0 at audit time). A read of the installed dist code confirmed
the following per-platform posture. "Fail-closed init" means the adapter
constructor throws when its secret is missing, so the AdapterRegistry never
wires it and the in-repo route 404s.

| Platform | Algorithm | Timing-safe compare | Fail-closed on missing secret | Replay protection |
|----------|-----------|--------------------|-------------------------------|-------------------|
| Slack | HMAC-SHA256 (`v0:ts:body`) | ✓ `timingSafeEqual` | ✓ throws at init | ✓ 300 s window |
| Discord | Ed25519 (`discord-interactions`) | ✓ | ✓ throws at init | platform-level |
| Teams | Bot Framework JWT (MS libs) | ✓ | ✓ throws at init | ✓ JWT claims |
| WhatsApp | HMAC-SHA256 (`X-Hub-Signature-256`) | ✓ | ✓ throws at init | — |
| GitHub | HMAC-SHA256 | ✓ | ✓ throws at init | delivery ids |
| Linear | HMAC-SHA256 | ✓ | ✓ throws at init | ✓ 5 min window |
| Telegram | secret-token header compare | ✓ | ⚠ adapter treats it as optional — **Atlas's `TELEGRAM_BUILDER` makes `TELEGRAM_WEBHOOK_SECRET` mandatory** (#3154 GAP 3), so the fail-open path is unreachable from this repo's wiring | — |
| Google Chat | Google OAuth2 JWT | ✓ | ⚠ adapter treats `googleChatProjectNumber` / `pubsubAudience` as optional and processes UNVERIFIED HTTP webhooks when both are absent — **the in-repo `/webhooks/gchat` route fails closed with 403 when neither `GCHAT_PROJECT_NUMBER` nor `GCHAT_PUBSUB_AUDIENCE` is set** (#3350) | ✓ JWT claims (when configured) |

Verification always runs against the raw request body before any payload
processing; no debug bypass flags were found. Upstream follow-up worth filing
against the chat-adapter packages: make the Telegram and Google Chat
constructors throw on missing verification config, matching the other six.
Re-audit this table whenever the pinned `@chat-adapter/*` version changes.

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

## Plugin MCP tool governance fields (#3571, ADR-0016)

Plugins that contribute MCP tools via `AtlasMcpTool.mcpTools()` can now declare
ADR-0016 governance fields that let Atlas's full gate pipeline (gates 1–4) enforce
per-workspace policies, RBAC, and approval workflows — parity with built-in tools.

### `AtlasMcpTool` — governance declaration fields

These optional fields live on the `AtlasMcpTool<TInput, TOutput>` type in
`@useatlas/plugin-sdk`. Absent fields receive safe defaults so existing plugins
remain fully backward-compatible.

| Field | Type | Default | Gate | Description |
|---|---|---|---|---|
| `actionCategory` | `"datasource" \| "integration" \| "policy"` | `"integration"` | Gate 1 | Per-workspace MCP action-policy kill-switch category. A workspace admin can disable a category; every tool in that category is blocked. |
| `minRole` | `"member" \| "admin" \| "owner"` | `"member"` | Gate 3 | Minimum RBAC role required on the bound actor at dispatch time (live-resolved, not session-cached). |
| `destructive` | `boolean` | `false` | Gate 4 | If `true`, the tool is routed through the approval gate (`origin=mcp`) before execution. A matching approval rule queues the action for review. |

### Gate wire-up

The MCP-side bridge (`packages/mcp/src/plugin-tools.ts`) injects the real
`runMcpDispatchGate` from `dispatch-gate.ts` into `registerPluginMcpTools` via
the `runDispatchGate` option. The gate clears all four ADR-0016 gates in order:
gate 1 (action policy) → gate 2 (mcp:write scope) → gate 3 (RBAC) → gate 4
(approval). Gate 2 (mcp:write) is keyed on `annotations.readOnlyHint` /
`annotations.destructiveHint` as before. For callers that do not inject a gate
runner (backward-compat), the inline gate-2 check fires instead (no change to
prior behavior for tools that do not inject `runDispatchGate`).

Status: **✓ verified** — gates 1/3/4 tested in `packages/api/src/__tests__/plugin-mcp-tools.test.ts` (`describe("registerPluginMcpTools — ADR-0016 gates 1/3/4 (#3571)")`).

## References

- ADR-0003 (two-store install metadata + credentials): `docs/adr/0003-two-store-chat-install-metadata-credentials.md`
- ADR-0004 (platform OAuth is not Better Auth): `docs/adr/0004-platform-oauth-is-not-better-auth.md`
- #2628 fix PR: `cb50a203` — `channelAllowed` from DB row, not env var
- #2630 fix PR: `a7679d0d` — drop SaaS botToken placeholder
- #2676 fix PR: `d6317d0f` — JSONB-merge `slack:installation:*` writes
- #2677 audit (this doc): `refactor/2677-chat-plugin-atlas-contract`
