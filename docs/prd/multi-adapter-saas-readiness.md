# PRD: Multi-Adapter SaaS Readiness

**Milestone target:** 1.5.2 — Multi-Adapter SaaS Readiness
**Status:** Draft → ready-for-agent on filing
**Owner:** maintainer
**Posture:** pre-customer (two internal Workspaces only); clean breaks allowed. Precedent: #2620 / #2626 / #2634 / #2641.

Read alongside:
- `/CONTEXT.md` — canonical glossary (Platform, Adapter, App Registration, Workspace Connection, Plugin Catalog, Workspace Install, Eager/Lazy plugins, Operator vs Customer)
- `/docs/adr/0001-saas-uses-one-app-registration-per-platform.md`
- `/docs/adr/0002-catalog-seeded-from-config-at-boot.md`
- `/docs/adr/0003-two-store-chat-install-metadata-credentials.md`
- `/docs/adr/0004-platform-oauth-is-not-better-auth.md`

---

## Problem Statement

A SaaS customer who wants to connect Slack — or any other chat Platform — to their Workspace cannot do it themselves today. The chat plugin's adapter wiring lives in `deploy/api/atlas.config.ts`, which is operator-only code, deploy-time-only configuration. Slack is the one Platform configured today. Adding a second Platform (Teams, Discord, gchat, etc.) requires the operator to edit `atlas.config.ts`, set new env vars in every region, and ship a deploy — for each new platform, once.

Even after the operator has done that, the customer admin still has no clean surface for opting their Workspace in or out of any specific Platform: today the chat plugin sees a Workspace as connected as soon as it has a bot token in `chat_cache`, with no separation between "this Workspace has Slack installed (with intent)" and "this Workspace happens to have a stale token from a prior OAuth round."

Beneath the chat case, the same anti-pattern shows up for integration plugins (Salesforce, Jira, Email, Webhook, Obsidian): their wiring path is "operator adds them to `atlas.config.ts:plugins[]` if they should exist on the deployment," which means none of them are available on SaaS today, and the customer admin has no surface to install one. The `plugin_catalog` + `workspace_plugins` tables exist in the schema with a richer install-record shape (catalog id, plan tier, enabled flag, install metadata) but are not consistently populated by these wiring paths.

The deeper read: Atlas was designed plugin-driven self-host first. On self-host, the operator and the customer are the same party, so a config-file-as-source-of-truth shape works. On SaaS, the operator and the customer are different parties, and the same shape leaks: customer-level activation concerns end up routed through operator-only files.

## Solution

Establish a clean operator-vs-customer seam, applied to chat Platforms and integration plugins:

- **Operator surface (`atlas.config.ts`)** declares **capability** — the set of Platforms and integrations that an Atlas deployment knows how to do, plus per-Platform credentials (App Registration for OAuth Platforms, operator-shared bot credentials for static-bot Platforms) sourced from env vars.
- **Plugin Catalog** is the runtime registry. Seeded from `atlas.config.ts` on every boot in an idempotent pass. Holds plan-tier gating (`min_plan`), runtime enable/disable (`enabled`), config schema, and `install_model` per entry.
- **Customer surface (`/admin/integrations` page)** is where Workspace admins install / disconnect Platforms and integrations. The install flow varies by `install_model` (see CONTEXT.md "Install models" section): OAuth, form-based, or static-bot. Each install creates a `workspace_plugins` row referencing the catalog entry; per-Platform credentials persist to the adapter's native store (e.g. `chat_cache` for chat Platforms; per-plugin store for lazy integrations; routing identifiers in `workspace_plugins.config` for static-bot).
- **Per-event listener gate** checks `workspace_plugins` presence before classifying / answering for a given Workspace × Platform. Existing per-Workspace config tables (`workspace_proactive_config`, `channel_proactive_config`) remain as layered configuration on top of the catalog install.

After this milestone, adding a new instance of a *supported* Platform type for a customer becomes a self-serve admin action. Adding a new Platform *type* to the deployment is a one-time operator task (App Registration / static-bot credential setup + env vars + catalog entry in `atlas.config.ts`), done once per Platform per deployment forever.

### Install-model spectrum

Different Platforms have meaningfully different install models. This milestone delivers the foundation + the OAuth shape (Slack as the canonical chat Platform; Salesforce + Jira as canonical integration plugins) + the form-based shape (Email + Webhook + Obsidian). The static-bot shape — required by Teams, Discord, gchat, Telegram, WhatsApp — is **deferred to a follow-up milestone** because each Platform's static-bot install has Platform-specific subtleties (Teams manifest upload, Discord guild-id routing, Telegram chat-id capture, etc.). The 7 non-Slack chat adapters that exist in `plugins/chat/src/adapters/` get catalog entries marked as future-availability placeholders in this milestone; their install flows ship in the follow-up.

## User Stories

### Customer admin — chat Platforms

1. As a Workspace admin, I want to see the chat Platforms available on my plan, so that I know what I can install.
2. As a Workspace admin, I want to click "Connect Slack" and complete OAuth in one flow, so that my Workspace can receive Slack events without any code changes on the Atlas operator's side.
3. As a Workspace admin, I want to see which chat Platforms I have connected, who connected each, and when, so that I understand my Workspace's integration footprint.
4. As a Workspace admin, I want to disconnect a chat Platform with one click, so that I can revoke its access without ticketing the operator.
5. As a Workspace admin, I want connecting a Platform to be plan-gated, so that I'm shown an upsell rather than a hard failure when I try to install something my plan doesn't cover.
6. As a Workspace admin, I want my chat Platform Connection to survive a failed OAuth callback by letting me retry the OAuth dance, so that a transient network failure doesn't leave my Workspace in a half-installed state.
7. As a Workspace admin, I want to install the same chat Platform type on different Workspaces I administer with independent OAuth Connections per Workspace, so that my Workspaces stay isolated.
8. As a Workspace admin, I want layered configuration (proactive enable, channel allowlist) to persist independently from the install record, so that disconnecting and reconnecting Slack does not lose my channel allowlist.

### Customer admin — integration plugins

9. As a Workspace admin, I want Salesforce and Jira to appear in the same `/admin/integrations` surface as chat Platforms, so that all my Workspace integrations live in one place.
10. As a Workspace admin, I want to install an integration plugin without the agent loop having to load any code until I (or my users) actually trigger a query against it, so that idle integrations cost nothing.
11. As a Workspace admin, I want to disconnect an integration plugin and have its credentials and config disappear from my Workspace, so that I can manage data lifecycle responsibly.

### Customer admin — listener behavior

12. As a Workspace admin, when I have not installed Slack, I want the Atlas proactive listener to silently skip events from any Slack workspace where my org is not connected, so that there is no leakage between tenants.
13. As a Workspace admin, when I disconnect Slack, I want all subsequent events from that Slack workspace to be silently skipped immediately, without any per-event classification or metering.

### Operator — adding a new Platform type

14. As an Atlas operator, I want to add support for a new chat Platform (Teams, Discord) by editing `atlas.config.ts` once and setting per-Platform credential env vars per region, so that I never have to edit code per-customer.
15. As an Atlas operator, I want the `atlas.config.ts` declaration of available Platforms to be processed at boot in an idempotent seed pass that upserts `plugin_catalog` rows, so that I don't have to write data migrations to manage the catalog.
16. As an Atlas operator, I want to emergency-disable a Platform across all Workspaces in a region without a deploy, by flipping `plugin_catalog.enabled = false`, so that I can react to upstream incidents (rate limits, security advisories) quickly.
17. As an Atlas operator, I want the per-region OAuth redirect URI to be derivable from a per-region env var (`ATLAS_PUBLIC_API_URL`), so that the same code runs in us / eu / apac without per-region branching.
18. As an Atlas operator, I want the catalog seed pass to be observable (log lines with what was upserted / changed / preserved), so that I can debug deployment-time configuration drift.

### Operator — App Registration

19. As an Atlas operator, I want to register one App Registration per Platform per Atlas deployment (not per-customer), so that customer onboarding is purely self-serve OAuth.
20. As an Atlas operator, I want per-Platform credentials (client_id, client_secret, signing_secret, encryption key) to be sourced from per-region env vars, so that secrets stay out of code and per-region rotation is independent.

### Developer — implementation

21. As an Atlas developer, I want a single `PlatformOAuthHandler` interface that each chat Platform implements, so that adding a new Platform type means writing one implementation against a stable shape rather than a bespoke OAuth route per Platform.
22. As an Atlas developer, I want the proactive listener to read `workspace_plugins` as the outermost gate before classification, so that "is this Workspace connected to this Platform?" is one consistent question regardless of which Platform's event arrived.
23. As an Atlas developer, I want a `WorkspaceInstallGate` module with a per-event cache, so that repeated install-check reads inside one event handler cost one DB roundtrip, mirroring the existing `getWorkspaceConfig` per-event cache pattern.
24. As an Atlas developer, I want Platform integration OAuth to remain separate from Better Auth's user OAuth (per ADR-0004), so that user-identity and workspace-bot tokens never conflate.
25. As an Atlas developer, I want eager vs lazy plugin lifecycles to be explicit, so that the chat plugin's boot-time registration and Salesforce/Jira's per-Workspace lazy load don't share a one-size-fits-all wiring path.
26. As an Atlas developer, I want OAuth callback state tokens to be CSRF-safe (signed, short-lived, keyed by `(workspaceId, catalogId)`), so that an attacker cannot bind an OAuth code to a Workspace they don't own.

### Migration / cleanup

27. As an Atlas developer, I want the existing Slack OAuth path in `slack.ts` to be lifted into the first `PlatformOAuthHandler` implementation under generalized `/api/v1/integrations/:platform/{install,callback}` routes, so that there is one OAuth subsystem rather than two.
28. As an Atlas developer, I want the chat plugin's current `adapters: { slack: { ... } }` config shape to be replaced with catalog-driven adapter registration, so that the plugin reads from one source of truth.
29. As an Atlas developer, I want the existing internal Workspaces (maintainer's team + demo team) to be migrated atomically as part of this milestone, accepting clean-break semantics, so that no compatibility shim survives into the post-customer window.

## Implementation Decisions

### Modules

- **`CatalogSeeder` (new, deep)** — Pure function `seedCatalogFromConfig(config, env) → CatalogRow[]` plus a thin upsert driver invoked by the existing `buildAppLayer` startup composition. Idempotent: same `(config, env)` produces identical catalog rows. Respects ops-side manual disables (do not reset `enabled = false` rows back to `true` blindly — log a warn if config wants enabled but DB has disabled, leave DB).
- **`WorkspaceInstallGate` (new, deep)** — `isWorkspaceInstallActive(workspaceId, catalogId) → boolean`. Reads `workspace_plugins` joined to `plugin_catalog`, applies plan-tier check, returns boolean. Per-event cache keyed by `(workspaceId, catalogId)`, lifetime of a single event handler invocation, mirroring the existing `getWorkspaceConfig` cache pattern.
- **`PlatformInstallHandler` interface family (new)** — three concrete handler types, each with their own interface shape under `packages/api/src/lib/integrations/install/`:
  - **`OAuthPlatformInstallHandler`** — `startInstall(workspaceId): { redirectUrl, stateToken }` / `handleCallback(code, stateToken): { installRecord, credentialWritten }`. Used by Slack (chat) and Salesforce / Jira (integrations). Implementations live in `oauth/<platform>.ts`.
  - **`FormBasedInstallHandler`** — `validateConfig(workspaceId, formData): { installRecord, credentialWritten }`. Used by Email / Webhook / Obsidian. Form submitted directly, no OAuth dance. Implementations in `form/<plugin>.ts`.
  - **`StaticBotInstallHandler` (deferred to 1.5.3 follow-up)** — `confirmInstall(workspaceId, routingIdentifier, verificationProof): { installRecord }`. Customer admin provides a per-Workspace routing identifier (Discord guild_id, Telegram chat_id, Teams tenant_id, etc.) via form; bot itself is operator-shared. Catalog entries for Telegram/Discord/Teams/gchat/WhatsApp are scaffolded in this milestone but not installable.

The Slack `OAuthPlatformInstallHandler` implementation is the lift of the current `slack.ts` OAuth path. The interface is sized to make adding more OAuth Platforms a 1-day PR each post-milestone.
- **`AdapterRegistry` (new inside the chat plugin)** — Replaces the conditional `if (config.adapters.slack) { ... }` chain in `plugins/chat/src/index.ts`. Reads supported Platforms from the catalog at boot; per-Platform credentials from env vars (`SLACK_CLIENT_ID` + `SLACK_CLIENT_SECRET` + `SLACK_SIGNING_SECRET` + `SLACK_ENCRYPTION_KEY`, with the equivalent set per Platform). Instantiates the corresponding adapter classes for Platforms that have both a catalog entry and complete credentials.
- **`OAuthStateToken` (new, deep)** — `mint(workspaceId, catalogId) → token` / `verify(token) → { workspaceId, catalogId }`. Signed, short-lived (5–10 min default), tampering-resistant. Likely reuses primitives from `@atlas/oauth-helper` (PR #2203) — at minimum it shares the signing key derivation pattern.
- **`LazyPluginLoader` (new, deep)** — For integration plugins (Salesforce, Jira, etc.). `getOrInstantiate(workspaceId, catalogId) → PluginInstance`. First-call instantiation with config drawn from `workspace_plugins.config`; subsequent calls return process-cached instance. Per-Workspace isolation.

### Modules being modified

- **Chat plugin (`plugins/chat/src/index.ts`)** — `adapters: { slack: {...} }` config shape is replaced with catalog-driven adapter registration via `AdapterRegistry`. The plugin remains an eager plugin (registers listener at boot). Its plugin signature simplifies — operators no longer pass per-Platform credentials through the chat plugin; they set env vars and let the catalog seed handle the rest.
- **Proactive listener (`plugins/chat/src/proactive/listener.ts`)** — gates on `WorkspaceInstallGate` per event before classify. Existing `workspace_proactive_config` / `channel_proactive_config` reads layer on top — they continue to gate proactive-specific behavior, but the install gate is now the outermost check.
- **`atlas.config.ts` schema** — capability declaration (Platforms supported, integration plugins available) lives in a new top-level field (likely `catalog: { platforms: [...], integrations: [...] }` or similar — exact shape decided at implementation time). The `plugins: [chatPlugin({...})]` entry remains for the chat plugin's eager-registration concern, but its `adapters` slot is gone (replaced by env-var-driven runtime registration).
- **Slack OAuth routes (`packages/api/src/api/routes/slack.ts`)** — install/callback paths are lifted into `PlatformOAuthHandler<Slack>` and registered at the generalized `/api/v1/integrations/:platform/{install,callback}` endpoints. Slash-command / interactions / events endpoints remain in `slack.ts` for now (they belong to the adapter, not the OAuth lifecycle).
- **Admin web (`packages/web/src/app/admin/`)** — new `/admin/integrations` page added. Reads `plugin_catalog` via `useAdminFetch` (new endpoint `/api/v1/admin/integrations/catalog`); renders cards per catalog entry; Connect / Manage / Disconnect actions.

### Schema decisions

- `plugin_catalog` and `workspace_plugins` already exist with the right shape. No new tables expected.
- `workspace_plugins.config` JSONB is the per-Workspace per-catalog-entry install configuration. Each Platform / integration plugin defines its own config schema; the catalog row's `config_schema` JSONB drives admin-UI form generation.
- No expected drops or column changes. If the implementation discovers a missing column, follow CLAUDE.md schema drift rules: migration + `pgTable` mirror + real-PG smoke in the same PR.
- The existing `slack_installations` table is already dropped (PR #2634, migration 0086). No further consolidation needed.
- `workspace_proactive_config` and `channel_proactive_config` are unchanged — they layer on top of `workspace_plugins`, gating proactive-specific behavior atop install presence.

### API contracts

- **New:** `GET /api/v1/integrations/catalog` — Workspace admin reads the available catalog filtered by plan. Returns `[{ id, slug, name, description, iconUrl, minPlan, configSchema, installed: boolean, installedAt, installedBy }]`.
- **New:** `POST /api/v1/integrations/:platform/install` — Workspace admin initiates OAuth. Returns `{ redirectUrl }`.
- **New:** `GET /api/v1/integrations/:platform/callback` — OAuth callback. Verifies state, exchanges code, writes `workspace_plugins` + per-platform credential store.
- **New:** `DELETE /api/v1/integrations/:platform` — Workspace admin disconnects. Deletes `workspace_plugins` row + per-platform credentials.
- **Existing routes lifted:** the current `/api/v1/slack/install` and `/api/v1/slack/callback` are replaced by the generalized routes above. Slack-adapter-internal routes (`/api/v1/slack/commands`, `/interactions`, `/events`) stay put — they're Slack-protocol-specific.

### OAuth flow contract

1. Workspace admin clicks "Connect Slack" → web POSTs to `/api/v1/integrations/slack/install` with current workspace context
2. API mints `OAuthStateToken(workspaceId, catalogId='slack')`, builds Slack authorize URL with operator-owned `client_id` (from env), returns `redirectUrl`
3. Browser redirects to Slack authorize URL; admin grants consent
4. Slack redirects to `{ATLAS_PUBLIC_API_URL}/api/v1/integrations/slack/callback?code=…&state=…`
5. API verifies state token (CSRF-safe), exchanges `code` via `oauth.v2.access`, gets bot token + team metadata
6. API writes `workspace_plugins` row (catalog_id='slack', workspace_id from state, config from Slack response) + writes `chat_cache:slack:installation:<teamId>` (per-platform credential store)
7. API redirects browser back to `/admin/integrations?slack=connected`

### Atomicity at install/uninstall

Per ADR-0003: install is two writes (`workspace_plugins` + `chat_cache`). Accepted trade-off: do not wrap in a single DB transaction (the `chat_cache` write goes through `@chat-adapter/slack`'s state adapter, which doesn't expose transaction handles cleanly). Instead, write `workspace_plugins` first; if `chat_cache` write fails, the install record exists but credentials don't — admin sees "Reconnect needed" state and can retry. Inverse for uninstall: delete `chat_cache` first, then `workspace_plugins` (so a partial-failure leaves the workspace effectively disconnected — install record gone, credentials gone, just the per-platform reverse-lookup dangling, which is harmless).

### Catalog seed semantics

Run at boot in `buildAppLayer`. For each declared Platform / integration in `atlas.config.ts`:
- If catalog row absent → INSERT
- If catalog row present and matches declared properties → no-op (log debug "preserved")
- If catalog row present but differs from declared properties → UPDATE the declared columns (`name`, `description`, `icon_url`, `config_schema`, `min_plan`), preserve `enabled` (do not reset to true if ops has set it false), log warn if `enabled` differs from declaration
- If a catalog row exists with a slug not in declarations → log warn "orphan catalog row" but do not DELETE (manual ops cleanup)

The orphan-row "warn, don't delete" semantics preserves ops's ability to add catalog rows out of band (e.g. for a future community plugin marketplace) without the seed reaping them.

### Sequencing

- **Slice 0 — Prereq:** #2623 item 1 (discriminated unions on `ProactiveListenerConfig`). First issue of this milestone. Lands before any other slice.
- **Slice 1 — Foundation:** CatalogSeeder + WorkspaceInstallGate + OAuthStateToken + PlatformOAuthHandler interface (no implementations yet). Establishes the seam.
- **Slice 2 — Chat Platforms vertical:** AdapterRegistry; Slack lifted into first PlatformOAuthHandler implementation; chat plugin restructured; `/admin/integrations` page (initial version, Slack only); per-event listener gate via WorkspaceInstallGate.
- **Slice 3 — Integration plugins vertical:** LazyPluginLoader; Salesforce/Jira/Email/Webhook/Obsidian catalog entries; admin UI extended to render integration cards alongside chat cards; install/disconnect flows generalize per-PlatformOAuthHandler.

After milestone closes, adding a new chat Platform (Teams, Discord, etc.) is a 1-day PR: one PlatformOAuthHandler implementation + env vars + catalog entry. Out of scope for this milestone.

## Testing Decisions

A good test in this milestone validates external behavior — given an `atlas.config.ts` declaration and a set of env vars, the catalog reflects the right state; given a Workspace's install state, the gate returns the right answer; given an OAuth callback, the right install record and credential land in their respective stores. Implementation details (cache key shape, specific column orderings, SQL fragments) are not pinned in tests.

Strong test candidates (all four foundation modules will be unit-tested):

- **CatalogSeeder tests** — idempotency (same input → same upserts), env-var presence matrix (missing creds → catalog row omitted), preservation of ops-disabled rows on re-seed, orphan-row warn semantics, plan-tier propagation from config to catalog row. Prior art: `packages/api/src/lib/db/__tests__/migrate.test.ts` for the boot-pass shape; `__tests__/backfill-plugin-config.test.ts` for upsert semantics.
- **WorkspaceInstallGate tests** — present + enabled → true, present + disabled → false, absent → false, catalog row disabled at the catalog level → false regardless of install, plan mismatch → false, per-event cache returns identical result on second call without a second DB read. Prior art: existing `getWorkspaceConfig` per-event cache test in `plugins/chat/src/proactive/__tests__/listener.test.ts`.
- **PlatformOAuthHandler (Slack first)** — happy-path callback writes both stores, mismatched state token rejected, expired state token rejected, `oauth.v2.access` error from Slack surfaces as actionable user error, install record + credential stores end in consistent state on partial failure (`workspace_plugins` present, `chat_cache` write failed → admin sees "Reconnect needed"). Prior art: existing Slack OAuth tests in `packages/api/src/api/routes/__tests__/slack.test.ts`.
- **OAuthStateToken tests** — sign/verify roundtrip, tampered token rejected, expired token rejected, key rotation safe (versioned key derivation if reusing `@atlas/oauth-helper` patterns). Prior art: `packages/api/src/lib/auth/__tests__/` for cryptographic helper tests.

Medium-priority candidates (covered by integration tests; unit tests if time):

- **AdapterRegistry** — env-var presence fixtures: full creds → adapter registered; missing one var → adapter not registered + warn logged.
- **LazyPluginLoader** — first call instantiates, second call returns cache; per-Workspace isolation (two Workspaces with same plugin get separate instances).

Lower priority (covered elsewhere):

- `/admin/integrations` page rendering and click-through — covered by browser e2e tests under `e2e/browser/`.
- Chat plugin restructure end-to-end — covered by existing proactive listener integration tests and a new e2e surface (catalog-driven Slack install → @mention event arrives → listener gates correctly).

Migrations (if any land — none expected, but if `plugin_catalog` needs columns): real-PG smoke per CLAUDE.md drift rule via `migrate-pg.test.ts`.

## Out of Scope

- **Non-Slack chat Platform install flows.** Teams, Discord, gchat, Telegram, GitHub, Linear, WhatsApp adapters exist as code in `plugins/chat/src/adapters/`. Their install models are NOT uniformly OAuth (see CONTEXT.md "Install models"): Linear has an OAuth mode (close to Slack), but Teams uses Azure AD + manifest upload, Discord uses an operator-shared bot with per-guild routing, Telegram and WhatsApp use static operator-owned bot tokens, gchat uses a Google service account + Workspace Marketplace. These each need bespoke install-handler implementations. Catalog entries for these Platforms ship with `enabled: false` (or an explicit `coming-soon` placeholder) in this milestone; their install flows ship in a follow-up milestone (1.5.3 — Multi-Platform Install Models, scope TBD).
- **Per-Platform billing / metering changes.** The existing meter machinery (`proactive_meter_events` and friends) is already per-Workspace and works against any adapter. No billing-layer changes in this milestone.
- **Custom plugin marketplace UX beyond connect/disconnect.** The `/admin/integrations` page will support install / view / disconnect. Anything richer (in-product plugin authoring, third-party plugin submissions, ratings) is 1.6.x+ territory.
- **Per-Workspace tool gating (`tools: ["explore", "executeSQL"]`).** Filed as a separate Architecture Backlog tracking issue.
- **Datasource plugin plan-tier gating via catalog.** Filed as a separate Architecture Backlog tracking issue.
- **Scheduler delivery channel sourcing via catalog.** Filed as a separate Architecture Backlog tracking issue.
- **User-identity OAuth changes (Better Auth, SSO, social providers).** Strictly off-limits this milestone per ADR-0004.
- **Self-host UX changes.** Self-host operators continue to point `atlas.config.ts` at their own App Registration credentials. The catalog seed pattern works identically for them; no admin-UI changes are required (they own the deploy).

## Further Notes

### Catalog row shape (pin in slice 2)

Flat list with `type` and `install_model` as orthogonal fields, not nested by type:

```ts
catalog: [
  { slug: "slack",         type: "chat",        install_model: "oauth",      min_plan: "starter", enabled: true },
  { slug: "salesforce",    type: "integration", install_model: "oauth",      min_plan: "team",    enabled: true },
  { slug: "jira",          type: "integration", install_model: "oauth",      min_plan: "team",    enabled: true },
  { slug: "email",         type: "integration", install_model: "form",       min_plan: "starter", enabled: true },
  { slug: "webhook",       type: "integration", install_model: "form",       min_plan: "starter", enabled: true },
  { slug: "obsidian",      type: "integration", install_model: "form",       min_plan: "starter", enabled: true },
  // 1.5.3 placeholders — enabled: false in 1.5.2
  { slug: "telegram",      type: "chat",        install_model: "static-bot", enabled: false },
  { slug: "discord",       type: "chat",        install_model: "static-bot", enabled: false },
  // ... etc.
]
```

Admin UI groups by `type` for display; backend dispatches by `install_model` for the handler factory.

### Multi-mode Platforms

Per CONTEXT.md "Multi-mode Platforms," Linear and GitHub each support multiple install models. They land as **separate catalog rows per mode** (not one row with a toggle). All Linear and GitHub flavors are deferred to 1.5.3; this milestone's catalog placeholder strategy seeds them with `enabled: false` placeholders following the per-mode naming convention (`linear`, `linear-apikey`, `github`, `github-pat`, etc.).

### SaaS-vs-self-host catalog eligibility

GitHub PAT mode is unsafe on SaaS (single-user-token failure mode) — it should never appear in the SaaS catalog. The catalog row carries a `saas_eligible` flag (or `deploy_modes: ["self-host"]` equivalent) that gates visibility per CONTEXT.md "SaaS-vs-self-host eligibility." Slice 2's seed pass honors this flag. The same flag also lets self-host operators expose dev-friendly modes (Linear API key, GitHub PAT) without exposing them to SaaS customers.

### Credential rotation per install_model

Each install handler interface documents rotation semantics in its docstring:

- OAuth handlers auto-refresh; re-prompt customer admin on refresh failure
- Form handlers surface "credential expired" as an actionable error; no auto-refresh
- Static-bot handlers have no per-Workspace credential to rotate; operator rotates env vars

### Dispatch shape pinned in 1.5.2

Slice 4 (`PlatformInstallHandler` interface family) registers a dispatch keyed on `install_model`. Even though `StaticBotInstallHandler` ships in 1.5.3, the 1.5.2 dispatch must already cover all three branches — with `StaticBotInstallHandler` registered as a stub that throws `EnterpriseError("install_model 'static-bot' not implemented until 1.5.3")` (or similar). This pins the registration shape so 1.5.3 lands as a single import + stub-removal change, not a dispatch-mechanism design call.

Landed (slice 4 / PR #2652) calls worth pinning so 1.5.3 doesn't re-litigate them:

- **Stub error type** — plain `Error` (not `EnterpriseError`). The static-bot stub is a "not implemented yet" deferral, not an EE feature gate; mapping it to a 403 "Requires Enterprise" response would mislead the admin UI. Slice 5 / #2660 callers can assert on the message substring `"not implemented until 1.5.3"`.
- **`OAuthStateToken` shape** — compact JWT-ish three-part wire format `base64url(header).base64url(payload).base64url(hmacSha256)`. Header `{ alg: "HS256", kid: <int>, typ: "AtlasOAuthState" }`; payload `{ workspaceId, catalogId, exp }` (unix seconds). Format is local — `@atlas/oauth-helper` doesn't currently expose an HMAC signer and editing the helper is out of scope for the foundation slice.
- **`kid` = active key version** — the `kid` integer is the `version` field of the entry in `ATLAS_ENCRYPTION_KEYS` that signed the token. Always the *highest* version at mint time; on verify, any version still present in the keyset is accepted. This lets an operator rotate keys (promote v2 to active, keep v1 readable for a window) without bulk-invalidating in-flight install dances.
- **Default TTL** — 10 minutes. Env override `ATLAS_OAUTH_STATE_TTL_SECONDS` clamped to [60, 3600]; per-call override on `mint()` is for tests only.
- **Verify policy** — `verify()` returns `null` on every failure path (malformed, tampered, expired, unknown kid, no key configured). Never throws — callers must not introspect which check tripped.
- **Mint when no key is configured** — throws, does not fall back. Unlike opaque-secret encryption (which has a dev-friendly plaintext passthrough), CSRF state cannot degrade silently. Self-host operators must set at least `BETTER_AUTH_SECRET`; SaaS deploys must set `ATLAS_ENCRYPTION_KEYS`.

### Per-Workspace platform identifiers

Some Platforms with OAuth install still need per-Workspace platform-specific identifiers persisted alongside the credential:

- Salesforce: `instance_url` (each Connected App OAuth grant returns the customer's specific Salesforce instance hostname)
- Jira: `cloudid` (Atlassian's 3LO returns the cloud instance identifier; one Atlas Workspace = one Atlassian Cloud)
- GitHub Apps multi-tenant (1.5.3): `installation_id` per org
- Linear OAuth (1.5.3): per-Workspace token + Linear org id

These identifiers persist in `workspace_plugins.config` (the install-record JSONB) alongside any non-credential install metadata. The credential itself (bot token, refresh token) goes to the platform-native credential store per ADR-0003.

### Self-host symmetry

On self-host, the operator is the customer. For OAuth Platforms, the self-host operator brings their own App Registration credentials (no Atlas-owned operator-shared App Registration applies). For static-bot Platforms, the operator owns the bot. For form-based, identical to SaaS. The catalog seed pattern works without modification — the operator-vs-customer boundary collapses naturally because both parties are the same person. Future-readers question "but does this work on self-host?" → yes, the seam at workspace-id resolution handles it; no bifurcation needed.

### Pre-customer posture

Atlas SaaS today serves the maintainer's internal team and an internal demo team — no external customers. Clean breaks are permitted; no deprecation shims, no v2-route fallbacks. The existing two Workspaces will be migrated atomically as part of slice 2 / slice 3. This posture ends the moment the first external customer onboards; everything in flight at that point will need to lock contracts.
- **`#2623` item 1 is the prereq.** Discriminated unions on `ProactiveListenerConfig`. Files first; the catalog seed pattern's type contract benefits from the tightened listener config shape (avoids re-litigating union shape mid-milestone).
- **`@atlas/oauth-helper` reuse.** The OAuth 2.1 + PKCE helper extracted in PR #2203 (arch-win #51) is the natural home for shared OAuth machinery. `OAuthStateToken` should either live alongside it or borrow its key-derivation pattern.
- **Per-region OAuth redirect URIs.** Each region (us / eu / apac) has its own `ATLAS_PUBLIC_API_URL`. The Atlas App Registration with each Platform vendor needs all three redirect URIs whitelisted. One-time operator setup per Platform per region.
- **Plan-tier wiring.** `plugin_catalog.min_plan` already exists. The plan-check in `WorkspaceInstallGate` and the admin-UI filter will compare against the Workspace's current plan (resolved via existing billing layer). No new plan-resolution code expected.
- **Architecture-wins candidates after this milestone.** Several modules listed above are deep modules worth recording in `architecture-wins.md` once they land — particularly `CatalogSeeder`, `WorkspaceInstallGate`, and `PlatformOAuthHandler` as an interface/implementation seam.
