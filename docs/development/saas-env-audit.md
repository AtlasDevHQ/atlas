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
  vars) — non-secret; boot-blocks via `BillingConfigInvalidError`. Operator should
  set pricing in Admin without a deploy. Only the secret key + webhook secret stay env.
- **Rate-limit / abuse tuning** — `ATLAS_RATE_LIMIT_RPM_CHAT`, `_ADMIN`, the
  `ATLAS_ABUSE_*` family, `ATLAS_CONTACT_RATE_LIMIT_RPM`, `ATLAS_DEMO_RATE_LIMIT_RPM`.
  (Base `ATLAS_RATE_LIMIT_RPM` stays immutable — DDoS floor.) Relates to #3687.
- **OAuth / token TTLs** — `ATLAS_OAUTH_*_TTL_SECONDS`, MCP session caps.
- **Operator integration credentials** — Slack/Discord/Teams/Telegram/WhatsApp/
  gchat/Jira/Linear/GitHub-App/Salesforce env creds read at boot. Today **adding a
  chat platform or action target to a region requires a Railway deploy**. These
  should be operator-settable (encrypted) via an Admin → Platform Integrations
  surface, the same way *workspace* plugin creds already work.
- **Observability** — `OTEL_EXPORTER_OTLP_{ENDPOINT,HEADERS}` (today a per-service
  footgun: shared scope silently drops telemetry).

### Tier 2 — Move non-secret constants into `atlas.config.ts` (still a deploy, but maintained once)
For things that genuinely can't be runtime (boot-ordering) but are constant
across regions:
- `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` (keep `VERCEL_TOKEN` in env).
- Per-region origins (`ATLAS_PUBLIC_API_URL`, `ATLAS_CORS_ORIGIN`, `ATLAS_RPID`)
  derived from `ATLAS_API_REGION` + the `residency.regions[].apiUrl` map instead of
  stamped per service.

### Tier 3 — Delete redundant env vars
Already covered by `atlas.config.ts`, no behavior change to drop from SaaS env:
- `ATLAS_DEPLOY_MODE=saas` — config sets `deployMode: "saas"`; `config.ts` reads
  `process.env.ATLAS_DEPLOY_MODE ?? configFileValue`.
- `ATLAS_ENTERPRISE_ENABLED=true` — `isEnterpriseEnabledLocal` reads
  `config.enterprise?.enabled` first; config sets `enterprise.enabled: true`.
  (Verify no pre-config read path needs it.)
- `TWENTY_BASE_URL` — its default already *is* the SaaS hostname.

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

## Tracked work

See the umbrella issue and its children in `AtlasDevHQ/atlas` (search label
`area: deploy` + "SaaS-first env"). Each tier maps to one or more
independently-grabbable issues for the `/next` flow.
