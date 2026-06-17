# SaaS environment-variable audit

**Date:** 2026-06-16
**Status:** Audit + reduction backlog (tracked in GitHub issues)
**Principle owner:** see CLAUDE.md → *SaaS-first configuration*

## The principle

> **A SaaS operator or workspace admin should never have to deploy to change
> configuration. Environment variables are reserved for (a) secrets and (b)
> inputs the process needs before the internal database exists. Everything else
> is a runtime-controllable setting in the registry (`lib/settings.ts`), changed
> from the Admin console with no redeploy.**

"SaaS-first, self-deploy as a by-product" means the *default* home for a new knob
is the settings registry (platform- or workspace-scoped), **not** a new env var.
An env var is the exception, justified only by secrecy or boot-ordering.

## Why the env surface is large today

`.env.example` declares ~250 variables. That number is misleading on two axes:

1. **Most are optional, well-defaulted self-host knobs** (cache TTLs, pool
   warmup, nsjail limits, every integration's creds). They cost SaaS nothing
   operationally — we never set them — but they bury the ~22 vars a hosted region
   actually requires. The SaaS boot contract is already enumerated with
   compile-time exhaustiveness in `packages/api/src/lib/effect/saas-env.ts`
   (`SAAS_ENV_KEYS`); the operator reference
   (`apps/docs/.../platform-ops/saas-environment-variables.mdx`) is derived from it.

2. **Some are non-secret constants stamped per-service** that belong in
   `deploy/api/atlas.config.ts` (code, maintained once) or — better, per the
   principle — in the settings registry (runtime, no deploy). These are the real
   maintenance tax: the same value set on `api`, `api-eu`, `api-apac`,
   `api-staging`, ×N.

The mechanisms to fix this **already exist and work**:

- **`lib/settings.ts`** — ~40 settings already runtime-controllable. Precedence
  `workspace override > platform override > env > default`; SaaS hot-reloads within
  ~30s; Admin UI at `/admin/settings` (+ specialized surfaces). `SAAS_IMMUTABLE_KEYS`
  locks the few boot-guard-dependent keys from runtime mutation.
- **`env-profile.ts`** (`ATLAS_DEPLOY_ENV`) — collapses per-env non-secret toggles
  behind one switch with a typed table.
- **`atlas.config.ts`** — bakes application config (deployMode, enterprise, tools,
  catalog, sandbox, pool, scheduler, cache, residency) into versioned code.

The reduction work is mostly **promoting env vars into the registry**, plus a few
"delete the redundant env var" and "move the constant into config" cleanups.

## Tiers

### Tier 0 — Irreducible deploy-time floor (keep as env)
Secrets + pre-DB boot inputs. See the operator reference for the full table.
`DATABASE_URL` (+ region URLs), `ATLAS_ENCRYPTION_KEYS`, `BETTER_AUTH_SECRET`,
`AI_GATEWAY_API_KEY`/provider key, `RESEND_API_KEY`, the Slack app secrets,
`ATLAS_API_REGION`, `BETTER_AUTH_URL`/`_TRUSTED_ORIGINS`, `ATLAS_DEPLOY_ENV`, and
the genuine secrets of Stripe/Turnstile/Twenty/Vercel.

### Tier 1 — Promote to the settings registry (env → runtime, no deploy)
The headline of the principle. Candidates, by area:

- **Stripe price IDs** (`STRIPE_{STARTER,PRO,BUSINESS}{,_ANNUAL}_PRICE_ID`, 6
  vars) — ✅ **done (#3703).** Promoted to platform-scoped, hot-reloadable
  settings (env is now only a fallback tier); `getStripePlans()` /
  `resolvePlanTierFromPriceId()` read them via `getSettingAuto` per checkout, and
  `BillingConfigGuardLive` warns (no longer boot-blocks) on a missing price ID.
  Only the secret key + webhook secret stay env.
- **Rate-limit / abuse tuning** — ✅ **done (#3705).** The per-user / chat / admin RPM trio
  (`ATLAS_RATE_LIMIT_RPM`, `_RPM_CHAT`, `_RPM_ADMIN`) was **already** in the registry
  (`_RPM` itself is immutable on SaaS — DDoS floor). #3705 promoted the remaining env-only
  knobs to platform-scoped, hot-reloadable settings (env is now only a fallback tier):
  `ATLAS_CONTACT_RATE_LIMIT_RPM`, `ATLAS_DEMO_RATE_LIMIT_RPM`, `ATLAS_DEMO_MAX_STEPS`, and
  the `ATLAS_ABUSE_*` family (`getContactRpmLimit` / `getDemoRpmLimit` / `getDemoMaxSteps` /
  `getAbuseConfig` read via `getSettingAuto` per request/event). Platform scope is
  load-bearing — a tenant must never weaken the abuse thresholds that defend the region
  against it. Relates to #3687.
- **OAuth / token TTLs** — ✅ **done (#3705).** `ATLAS_OAUTH_ACCESS_TOKEN_TTL_SECONDS` /
  `ATLAS_OAUTH_REFRESH_TOKEN_TTL_SECONDS` are platform-scoped `requiresRestart` settings
  (baked into the Better Auth instance at boot; the resolvers prefer a DB override over the
  injected env via `getSettingOverride`). `ATLAS_OAUTH_STATE_TTL_SECONDS` (the install-flow
  state token — the issue mis-named it `*_STATE_TOKEN_TTL_SECONDS`) is hot-reloadable
  (read per-mint). The MCP knobs `ATLAS_BYOT_CATALOG_TTL_MS`, `ATLAS_MCP_SESSION_IDLE_TIMEOUT_MS`,
  `ATLAS_MCP_MAX_HELD_STREAM_AGE_MS`, and `ATLAS_MCP_RATE_LIMIT_MAX_KEYS` are likewise
  platform-scoped + hot-reloadable (the hosted MCP transport mounts on the per-region API
  server, which runs the settings-refresh fiber). `ATLAS_MCP_MAX_SESSIONS` stays
  env-profile-centralized (not registry).
- **Operator integration credentials** — Slack/Discord/Teams/Telegram/WhatsApp/
  gchat/Jira/Linear/GitHub-App/Salesforce env creds read at boot. Today **adding a
  chat platform or action target to a region requires a Railway deploy**. These
  should be operator-settable (encrypted) via an Admin → Platform Integrations
  surface, the same way *workspace* plugin creds already work. **Backend seam
  shipped (#3704); Slack Admin surface + docs shipped (#3735)** — see
  [Operator integration credentials](#operator-integration-credentials-3704-3735)
  below for precedence + the remaining-platforms checklist.
- **Observability** — `OTEL_EXPORTER_OTLP_{ENDPOINT,HEADERS}` — ⚠️ **consciously LEFT as env
  (#3705).** Evaluated for promotion and deliberately kept env-only: `TelemetryLive` is the
  *first* layer in `buildAppLayer` (so it can trace the rest of boot) and has no dependency
  edge to `SettingsLive`, so the settings DB cache is provably cold at telemetry init on
  every boot — a DB-backed OTEL value could never apply at boot, even after a restart, and a
  silently-ignored override is worse than an env var (CLAUDE.md: "prefer errors over silent
  fallbacks"; the OTel SDK also reads `OTEL_EXPORTER_OTLP_HEADERS` directly from the process
  env). This is exactly the documented carve-out for "the process needs the value before the
  internal DB exists." The per-service footgun (shared scope silently drops telemetry) is
  better solved by setting it once as a region-constant via shared platform config, not the
  runtime registry. `ATLAS_HEALTH_PLUGIN_CACHE_TTL_MS` (plugin-liveness cache) *was* promoted
  — it is read per health-probe, not at boot.

### Tier 2 — Move non-secret constants into `atlas.config.ts` ✅ shipped (#3706)
For things that genuinely can't be runtime (boot-ordering) but are constant
across regions. No behavior change across us/eu/apac/staging — explicit env
still overrides every derivation.
- `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` → `sandbox.vercel` in `atlas.config.ts`
  (`vercelSandboxAccess()` reads config, env overrides). `VERCEL_TOKEN` stays env.
- `ATLAS_PUBLIC_API_URL` → derived from `ATLAS_API_REGION` +
  `residency.regions[].apiUrl` (`resolvePublicApiUrl()`); the region's `apiUrl`
  is exactly the API host, so OAuth redirect URIs are unchanged.
- `ATLAS_RPID` + the `ATLAS_CORS_ORIGIN` *default* → derived from the same region
  web origin (`getWebOrigin()` gains a region fallback; the API host's first DNS
  label is swapped `api` → `app`, folding `api-eu` / `api-apac` onto the single
  `app.useatlas.dev` web service). `ATLAS_CORS_ORIGIN` stays a registry setting —
  not re-introduced as an env var.

### Tier 3 — Delete redundant env vars ✅ shipped (#3702)
Already covered by `atlas.config.ts`, no behavior change to drop from SaaS env. The two
boot-contract vars (`ATLAS_DEPLOY_MODE`, `ATLAS_ENTERPRISE_ENABLED`) left
`SAAS_ENV_KEYS`/the boot-smoke fixture (which now proves a region boots green with them
unset, relying on `atlas.config.ts`); `TWENTY_BASE_URL` was never part of the typed boot
contract and is dropped from the Railway services only:
- `ATLAS_DEPLOY_MODE=saas` — config sets `deployMode: "saas"`; `config.ts` reads
  `process.env.ATLAS_DEPLOY_MODE ?? configFileValue`. `EnterpriseGuardLive` now reads
  the raw `process.env` directly (footgun probe, not a SaaS-required input).
- `ATLAS_ENTERPRISE_ENABLED=true` — `isEnterpriseEnabledLocal` reads
  `config.enterprise?.enabled` first; config sets `enterprise.enabled: true`. Confirmed
  no pre-config read path needs it.
- `TWENTY_BASE_URL` — its default already *is* the SaaS hostname (`crm.useatlas.dev`).
  Never in `SAAS_ENV_KEYS`/the boot-smoke fixture — a Railway-only var removal.

### Tier 4 — Documentation hygiene
- `.env.example` (718 lines) stays the self-host reference, but should be clearly
  framed as such; the SaaS operator surface is the short derived page.
- Auto-generate + drift-check the SaaS operator reference from `SAAS_ENV_KEYS`
  (the SSOT already has compile-time exhaustiveness; the doc should not drift).

## Bottom line

The irreducible SaaS env surface is **~10–12 secrets + per-region identity**.
Operators maintain far more because non-secret constants and operator-tunable
knobs never got promoted into the registry. Closing that gap makes hosted Atlas
configurable from the Admin console, reserves deploys for actual code changes, and
leaves self-host exactly as flexible as it is now (the env var remains the
fallback at the bottom of the precedence chain).

## Completeness review (2026-06-16)

A repo-wide `process.env` sweep (246 distinct vars) against `.env.example`, the
settings registry, and `SAAS_ENV_KEYS` produced two corrections and one new gap:

- **Already runtime-controllable** (do not "promote" — they're registry settings
  today): `ATLAS_RATE_LIMIT_RPM_CHAT`, `ATLAS_RATE_LIMIT_RPM_ADMIN`,
  `ATLAS_CORS_ORIGIN`. The registry holds ~39 settings total; reconcile any future
  Tier-1 candidate against `SETTINGS_REGISTRY` in `lib/settings.ts` before filing.
- **Undocumented env vars (re-baselined to 15 on 2026-06-17 — the headline "9"
  under-counted the list below, which already enumerated 10 vars, and predates
  findings 8 & 9 added during the milestone review)** read in code but absent from
  `.env.example` — most notably the **SSRF-class security flag
  `ATLAS_WEBHOOK_ALLOW_INTERNAL_CALLBACKS`** (the webhook twin of the documented
  `ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS` — must be documented as *never-on-SaaS*), and
  **`GCHAT_PROJECT_NUMBER` / `GCHAT_PUBSUB_AUDIENCE`**, read by the Google Chat adapter
  that already ships in the SaaS catalog. Also `ATLAS_WEBHOOK_REPLAY_LEGACY`,
  `WEBHOOK_SECRET`, `WEBHOOK_SIGNING_SECRET`, `E2B_API_KEY`, `DAYTONA_API_KEY`,
  `OBSIDIAN_API_KEY`, `AWS_SESSION_TOKEN`, plus an `ES_API_KEY` vs documented
  `ATLAS_ES_API_KEY` naming split. All documented (and the ES naming reconciled to
  `ATLAS_ES_API_KEY`) in #3710.
- **`ATLAS_REGION_{US,EU,APAC}_DB_URL`** are in `SAAS_ENV_KEYS` but not in
  `.env.example` (the new operator reference does cover them).

## Milestone review (2026-06-17)

A re-sweep during the env-var milestone review found the 2026-06-16 sweep
("246 distinct vars") **under-counted**. Two corrections fold into existing
children rather than new issues:

- **Three env-only tuning knobs the sweep missed** — `ATLAS_DASHBOARD_EXPORT_TIMEOUT_MS`
  (`lib/dashboard-screenshot.ts`), `ATLAS_HEALTH_PLUGIN_CACHE_TTL_MS`
  (`lib/plugins/registry.ts`), `ATLAS_MCP_MAX_HELD_STREAM_AGE_MS`
  (`packages/mcp/src/session-store.ts`). None are in the registry or boot-ordering-dependent,
  so they were Tier-1 promote candidates (added to #3705) and Tier-4 doc gaps (added to #3710).
  ✅ **All three promoted in #3705** — platform-scoped, hot-reloadable settings read per
  export / per probe / per sweep; env stays the fallback tier.
- **Two registry-backed learn knobs landed after the audit** (#3636) —
  `ATLAS_LEARN_PROMOTE_DECAY_ENABLED` / `ATLAS_LEARN_PROMOTE_DECAY_INTERVAL_HOURS`.
  These are correctly registry-backed (`settings.ts:654/667`) so the principle held;
  they're only missing from `.env.example` (the sibling `ATLAS_LEARN_*` knobs are
  documented there), so they're a Tier-4 doc gap (added to #3710).

No new chat-platform or datasource integration landed since the audit, so #3704's
operator-credential scope is unchanged. The "9 undocumented" count in #3710 is
re-baselined to **15** to include findings 8 & 9 (the original headline under-counted
the 2026-06-16 list, which already named 10 vars): the 10 from the 2026-06-16 sweep
(`ATLAS_WEBHOOK_ALLOW_INTERNAL_CALLBACKS`, `GCHAT_PROJECT_NUMBER`, `GCHAT_PUBSUB_AUDIENCE`,
`ATLAS_WEBHOOK_REPLAY_LEGACY`, `WEBHOOK_SECRET`, `WEBHOOK_SIGNING_SECRET`, `E2B_API_KEY`,
`DAYTONA_API_KEY`, `OBSIDIAN_API_KEY`, `AWS_SESSION_TOKEN`) + finding 8's three tuning
knobs + finding 9's two learn knobs. The `ATLAS_ES_API_KEY` naming split (a reconcile,
not a new doc) and the three `ATLAS_REGION_*_DB_URL` boot-contract vars (their own
2026-06-16 bullet) are tracked alongside but counted separately. All closed in #3710.

## Operator integration credentials (#3704, #3735)

The operator/platform tier — Atlas's **own** integration app registrations,
operator-shared across every workspace — moved off boot-time env onto an
encrypted, Admin-settable store. This is the highest-leverage Tier-1 item against
the "no deploy for a config change" principle.

### What shipped

- **#3704 (backend seam)** — `operator_integration_credentials` table (migration
  0140, encrypted at rest, `INTEGRATION_TABLES` participant for F-47 rotation /
  F-42 audit); `lib/integrations/operator-credentials/` (`store.ts`,
  `platforms.ts` registry, `resolver.ts`); the boot guard `ChatAdapterEnvGuardLive`
  converted from env-only to DB-or-env presence; the runtime rebuild seam
  (`ChatPluginConfig.resolveAdapterEnv` + `PluginRegistry.refresh(pluginId)`,
  wired in `deploy/api/atlas.config.ts`).
- **#3735 (Slack Admin surface + docs)** — the platform-admin route
  (`api/routes/admin-operator-integrations.ts`, mounted at
  `/api/v1/platform/operator-integrations`, `platform_admin` + MFA) and the
  **Admin → Platform → Operator Integrations** page.

### Precedence

Decided in one place (`operator-credentials/resolver.ts`), per field:

```
DB row (set in the Admin console) → operator env var → unset
```

A field set in the console wins; a blank field falls through to its env var; a
field set in neither is unset. Self-host with no internal database resolves every
field straight from env — unchanged. The resolver NEVER reads any workspace-tier
store, and the workspace-tier resolver never reads this one — the isolation is
structural and pinned by `__tests__/operator-credential-isolation.test.ts`.

The masked status read (`getOperatorPlatformStatus`) reports per-field presence +
source only; the route never echoes a secret value. Writes (`PUT`) merge non-empty
fields over the stored bundle (blank = preserve), then call
`plugins.refresh("chat-interaction")` so the rotation applies with no restart; the
audit row records `hasSecret: true` + the env-var names written, never the raw
value.

### Remaining-platforms migration checklist

`OPERATOR_PLATFORMS` in `lib/integrations/operator-credentials/platforms.ts` is the
reusable one-entry seam — the resolver, boot guard, Admin route, and Admin page all
iterate it with **no per-platform branches**. Adding a platform is one registry
entry:

1. **Add an `OperatorPlatformSpec` to `OPERATOR_PLATFORMS`.** Set `platform` (the
   credential-table slug), `label`, and `catalogSlug` (the chat-catalog slug for a
   chat platform, or `null` for a non-chat action target).
2. **Enumerate the credential `fields`**, one per operator env var the adapter
   builder reads. For each: `envVar` (the existing env-var name — it doubles as the
   bundle storage key *and* the `process.env` key, so env stays the self-host
   fallback unchanged), `label`, `hint`, `secret` (client IDs are not secret;
   client/signing/encryption secrets are), `required` (must mirror the adapter
   builder's `requiredEnv` set — the drift test below enforces this), and
   `destructiveRotation: true` on any key whose rotation invalidates downstream
   data (forces re-authorization; the Admin UI warns before such a write).
3. **For a chat platform**, the `required` fields must equal
   `getChatAdapterRequiredEnv(catalogSlug)` from `@useatlas/chat` — pinned by
   `__tests__/platforms.test.ts` so an adapter-side `requiredEnv` change can't drift
   the registry silently.
4. **Nothing else changes.** The Admin page (`app/platform/operator-integrations/`)
   renders every managed platform from the list endpoint; the route's `GET` / `PUT`
   / `DELETE` are platform-agnostic. No new migration, route, or UI code.

Pilot: **Slack** (`#3704`/`#3735`). Remaining chat platforms: **Discord, Teams,
Telegram, WhatsApp, Google Chat**. Remaining action targets: **Jira, Linear,
GitHub App, Salesforce** (set `catalogSlug: null`). Each is an independent,
one-entry follow-up.

## Tracked work

See the umbrella issue and its children in `AtlasDevHQ/atlas` (search label
`area: deploy` + "SaaS-first env"). Each tier maps to one or more
independently-grabbable issues for the `/next` flow.
