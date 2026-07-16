# Staging environment — operator runbook

Staging is the **soak environment** that sits between `main` and a tag-gated prod
deploy. Every merge to `main` deploys to staging automatically; prod only moves
when a release tag is cut (see [release-process.md](./release-process.md) and
[ADR-0008](../adr/0008-versioning-and-release-tags.md)). Staging is where we
dogfood a change against production-shaped infrastructure before it can reach
customers.

This document is the **end-to-end operator runbook**: it should be followable by
someone who has never seen the staging design. It assumes you have admin access
to the Railway project, the DNS zone for `useatlas.dev`, and the provider
consoles (Slack, Linear, GitHub, Google, Twenty, Stripe, Resend). The design
rationale lives in the [staging PRD](../prd/staging-environment.md) ([#2893](https://github.com/AtlasDevHQ/atlas/issues/2893));
this runbook is the **how**, the PRD is the **why**.

> **Status (slice 11 of 22 — [milestone #57](https://github.com/AtlasDevHQ/atlas/milestone/57)).**
> **All code-side slices are landed** (DeployRegion type, ResidencyResolver
> staging arm, `StagingClamp` + email-delivery wiring, `StagingSeed` + boot
> wiring, and the web staging banner). **api-staging builds from the shared
> `deploy/api/atlas.config.ts`** (the once-planned `deploy/api-staging/atlas.config.ts`
> variant was **retired in [#3958](https://github.com/AtlasDevHQ/atlas/issues/3958)** —
> shared-config-+-env-vars, max soak fidelity). The **human-in-the-loop (HITL)
> infrastructure slices are still open** —
> Railway environment + services, managed Postgres, CNAMEs, the seven provider
> OAuth apps, env-var population, and the prod cutover — along with the
> smoke-test workflow (slice 10). Each step below that depends on an unlanded
> slice is marked **`pending slice NN (#issue)`**. Until those land, treat those
> sections as the intended procedure, not a record of what exists.

### Slice map

| Slice | Issue | What it delivers | State |
| ----- | ----- | ---------------- | ----- |
| 1 | [#2897](https://github.com/AtlasDevHQ/atlas/issues/2897) | `DeployRegion` union gains `staging` | ✅ landed |
| 2 | [#2908](https://github.com/AtlasDevHQ/atlas/issues/2908) | `ResidencyResolver` staging no-op arm | ✅ landed |
| 3 | [#2909](https://github.com/AtlasDevHQ/atlas/issues/2909) | `/api/v1/mode` exposes `deployRegion` | ✅ landed |
| 4 | [#2910](https://github.com/AtlasDevHQ/atlas/issues/2910) | `StagingClamp` deep module | ✅ landed |
| 5 | [#2913](https://github.com/AtlasDevHQ/atlas/issues/2913) | wire `StagingClamp` into `email/delivery.ts` | ✅ landed |
| 6 | [#2911](https://github.com/AtlasDevHQ/atlas/issues/2911) | `StagingSeed` deep module | ✅ landed |
| 7 | [#2914](https://github.com/AtlasDevHQ/atlas/issues/2914) | wire `ensureStagingSeed` into `lib/startup.ts` | ✅ landed |
| 8 | [#2912](https://github.com/AtlasDevHQ/atlas/issues/2912) | ~~`deploy/api-staging/atlas.config.ts` variant~~ — **retired [#3958](https://github.com/AtlasDevHQ/atlas/issues/3958)**; api-staging runs the shared `deploy/api/atlas.config.ts` | ✅ superseded |
| 9 | [#2915](https://github.com/AtlasDevHQ/atlas/issues/2915) | web staging banner | ✅ landed |
| 10 | [#2898](https://github.com/AtlasDevHQ/atlas/issues/2898) | `.github/workflows/staging-smoke.yml` | ⏳ pending |
| 11 | [#2899](https://github.com/AtlasDevHQ/atlas/issues/2899) | this runbook | ✅ in progress |
| 12 | [#2900](https://github.com/AtlasDevHQ/atlas/issues/2900) | Slack `atlas-staging` OAuth app (HITL) | ⏳ pending |
| 13 | [#2901](https://github.com/AtlasDevHQ/atlas/issues/2901) | Linear staging OAuth app (HITL) | ⏳ pending |
| 14 | [#2902](https://github.com/AtlasDevHQ/atlas/issues/2902) | GitHub staging App (HITL) | ⏳ pending |
| 15 | [#2903](https://github.com/AtlasDevHQ/atlas/issues/2903) | Google staging OAuth client (HITL) | ⏳ pending |
| 16 | [#2904](https://github.com/AtlasDevHQ/atlas/issues/2904) | Twenty Cloud staging workspace + key (HITL) | ⏳ pending |
| 17 | [#2905](https://github.com/AtlasDevHQ/atlas/issues/2905) | Stripe test-mode webhook endpoint (HITL) | ⏳ pending |
| 18 | [#2906](https://github.com/AtlasDevHQ/atlas/issues/2906) | Resend staging API key + sender domain (HITL) | ⏳ pending |
| 19 | [#2907](https://github.com/AtlasDevHQ/atlas/issues/2907) | Railway staging env + managed Postgres (HITL) | ⏳ pending |
| 20 | [#2916](https://github.com/AtlasDevHQ/atlas/issues/2916) | Railway api/web/www-staging services + CNAMEs (HITL) | ⏳ pending |
| 21 | [#2917](https://github.com/AtlasDevHQ/atlas/issues/2917) | populate Railway staging env vars (HITL) | ⏳ pending |
| 22 | [#2918](https://github.com/AtlasDevHQ/atlas/issues/2918) | cutover prod services to the tag pattern (HITL) | ⏳ pending |

---

## Architecture at a glance

### URLs

| Surface | Staging                      | Prod                  |
| ------- | ---------------------------- | --------------------- |
| App     | `app.staging.useatlas.dev`   | `app.useatlas.dev`    |
| API     | `api.staging.useatlas.dev`   | `api.useatlas.dev`    |
| Landing | — *(no staging twin — `www` deploys direct from `main`, like `docs`)* | `www.useatlas.dev` |

> **Subdomain order matters.** It is `api.staging.useatlas.dev`, not
> `staging.api.useatlas.dev`. The transposed form was a real bug
> ([#2969](https://github.com/AtlasDevHQ/atlas/issues/2969)). Both staging
> hosts (`api.staging` + `app.staging`) share the `.staging.useatlas.dev` parent
> so their session cookies stay isolated from prod's `.useatlas.dev` namespace.

### How you know you're on staging

The web app shell renders a full-width **amber "Staging environment" banner** on
every page (including pre-sign-in) whenever the API reports it is the staging
deploy. It is driven by `StagingBanner`
(`packages/web/src/ui/components/staging-banner.tsx`), which reads `region` from
the public `GET /api/health` response:

- The API stamps `region: "staging"` when `ATLAS_API_REGION=staging` (resolved by
  `getApiRegion()` in `packages/api/src/lib/residency/misrouting.ts`, surfaced in
  `health.ts`).
- The banner renders nothing on production regions (`us` | `eu` | `apac`) and on
  self-hosted/dev deploys (no region), so there is no layout shift outside
  staging.
- The same region is also exposed (auth-gated) on `GET /api/v1/mode` as
  `deployRegion` (slice 3, [#2909](https://github.com/AtlasDevHQ/atlas/issues/2909)).
  `/api/health` is the canonical pre-auth signal; `/api/v1/mode` is for the
  in-app developer-mode UX.

If you ever see a tab with **no** amber banner that you *think* is staging, treat
it as production until proven otherwise — check `GET /api/health` directly.

### Outbound mail is clamped to a sink

Staging runs the **real** email-delivery code against real providers (Resend,
etc.), so without a guard a soak could email real-looking customer addresses and
burn sender reputation. Every outbound email is therefore redirected to a single
sink before the provider send (**slice 5, [#2913](https://github.com/AtlasDevHQ/atlas/issues/2913) —
landed**):

- `sendEmail` (`packages/api/src/lib/email/delivery.ts`) routes every message
  through `clampOutbound` (`packages/api/src/lib/staging/clamp.ts`), which
  rewrites the recipient to `STAGING_MAIL_SINK` (default
  `staging-mail@useatlas.dev`). Subject, body, and headers are preserved.
- The clamp is **fail-closed** ([#2985](https://github.com/AtlasDevHQ/atlas/issues/2985)):
  it keys off `ATLAS_DEPLOY_ENV=staging` (the authoritative soak-box signal), so
  a misconfigured or fat-fingered `ATLAS_API_REGION` — even a *valid* prod value
  like `us` — cannot silently disable it. On a staging-shaped deploy, mail is
  **always** clamped.
- Boot **hard-fails** if a staging deploy doesn't also stamp
  `ATLAS_API_REGION=staging` (`assertStagingMailRegion`, wired into
  `StagingSeedLive`). A mislabeled staging box never serves — it exits non-zero
  at boot rather than risk real mail.
- If a staging box ever sends an email while `ATLAS_API_REGION` has drifted from
  `staging`, the wiring layer logs a warn (keys only — no recipient/body) so the
  drift is visible; fix it by setting `ATLAS_API_REGION=staging` on the service.

> **Every recipient field is redirected** — `to`, `cc`, `bcc`, and `replyTo` all
> land on the sink ([#2984](https://github.com/AtlasDevHQ/atlas/issues/2984), landed).
> Today's `EmailMessage` only carries `to`, but the clamp redirects the whole
> recipient set up front so a future field-add (or the nodemailer
> `SendMailOptions` payload on the per-workspace SMTP agent path —
> [#3095](https://github.com/AtlasDevHQ/atlas/issues/3095)) can't ride a real
> address through unredirected.
>
> The per-workspace SMTP **agent** email tool (`lib/integrations/email-tool.ts`)
> is a parallel outbound path that bypasses `delivery.ts`; it applies the same
> clamp at its transport boundary
> ([#3095](https://github.com/AtlasDevHQ/atlas/issues/3095), landed), so an agent
> on a staging soak can't email a real recipient either.

### Deploy trigger model

| Branch / ref          | Target                                     | Trigger                                        |
| --------------------- | ------------------------------------------ | ---------------------------------------------- |
| `main`                | staging (api / app)                        | every merge, automatically                     |
| `v*.*.*` tag → `prod` | prod (api / api-eu / api-apac / web)        | `/release` fast-forwards `prod` to the tag SHA |
| `main` (direct)       | docs.useatlas.dev, www.useatlas.dev        | direct from `main` (static `output: export`, no runtime to gate) |

The `prod` branch is a Railway-tracking artifact advanced only by `/release`
(`git push origin <tag-sha>^{}:prod --force-with-lease`). No PRs target `prod`.
See [release-process.md § Mental model](./release-process.md#mental-model).

### Railway topology (target shape)

Same Railway project (`satisfied-creation`), new environment `staging`, three new
resources:

- `api-staging` — Hono API service
- `web-staging` — Next.js service
- `staging-postgres` — Railway-managed Postgres (Atlas internal DB)

There is **no** staging `docs` **or `www`** service (both deploy direct from
`main` to prod — static `output: export`, no runtime surface to gate) and
**no** staging sandbox sidecar — staging shares the prod Vercel Sandbox, which is
a per-request Firecracker microVM with `networkPolicy: "deny-all"`, so cross-env
contamination is structurally impossible.

---

## 1. Railway setup

> References slices 19 ([#2907](https://github.com/AtlasDevHQ/atlas/issues/2907)),
> 20 ([#2916](https://github.com/AtlasDevHQ/atlas/issues/2916)), and
> 21 ([#2917](https://github.com/AtlasDevHQ/atlas/issues/2917)) — all **HITL,
> pending**. Run these in order; each depends on the previous.

### 1a. Create the `staging` environment — *pending slice 19 (#2907)*

1. Open the `satisfied-creation` project in the [Railway dashboard](https://railway.app/dashboard).
2. **New Environment** → name it `staging`. Do **not** fork from `production` if
   that would copy prod secrets — staging credentials are a hard wall (see
   [§3](#3-env-var-checklist)). Start from an empty environment and populate vars
   explicitly.
3. Confirm the environment selector shows `staging` before creating any service.

> 📸 _Screenshot placeholder: Railway project → New Environment dialog with name `staging`._

### 1b. Provision the managed Postgres — *pending slice 19 (#2907)*

1. In the `staging` environment, **New** → **Database** → **Add PostgreSQL**.
   Name it `staging-postgres`.
2. Railway exposes `DATABASE_URL` as a service variable. Reference it from
   `api-staging` (see [§3](#3-env-var-checklist)) — do **not** hardcode the
   connection string.
3. This Postgres is the Atlas **internal** DB only (auth, audit, settings). The
   **analytics** datasource is the shared `__demo__` NovaMart connection
   (`ATLAS_DATASOURCE_URL`) — staging does not get its own analytics DB.

> 📸 _Screenshot placeholder: Railway staging env with the `staging-postgres` service provisioned._

### 1c. Clone the two runtime services — *pending slice 20 (#2916)*

Create `api-staging` and `web-staging` from the same GitHub repo as their prod
counterparts (`api`, `web`). There is **no** `www-staging` — `www` deploys direct
from `main` to prod (static `output: export`, like `docs`), so it has no staging twin:

1. **New** → **GitHub Repo** → `AtlasDevHQ/atlas`.
2. For each service set:
   - **Root directory / Dockerfile** — match the prod service's build config
     (the `deploy/<service>` layout). `api-staging` builds from the **shared
     prod config** `deploy/api/atlas.config.ts` (`RAILWAY_DOCKERFILE_PATH=deploy/api/Dockerfile`)
     and only differs by env vars — chiefly `ATLAS_API_REGION=staging` +
     `ATLAS_DEPLOY_ENV=staging` + the staging DB/OAuth secrets. The separate
     `deploy/api-staging/atlas.config.ts` was **retired in
     [#3958](https://github.com/AtlasDevHQ/atlas/issues/3958)** (shared-config
     model = max soak fidelity). Pointing `api-staging` at the shared config is
     safe even though it declares `eu`/`apac` arms: a region's `databaseUrl` is
     `z.string().optional()`, so the unset `ATLAS_REGION_EU_DB_URL` /
     `ATLAS_REGION_APAC_DB_URL` simply leave those arms' URLs `undefined`, and
     `RegionGuardLive` only boot-validates the **claimed** region
     (`ATLAS_API_REGION=staging` → `DATABASE_URL`). The login + signup funnels
     then collapse to the lone `staging` home arm (`selectDeployRegionEntries`,
     `lib/residency/picker.ts`), so staging never advertises or routes to the
     prod arms.
   - **Watch branch** — `main` (this is what makes every merge auto-deploy to
     staging). Prod services watch `prod`; staging services watch `main`.
   - **Wait for CI** — optional; staging is the soak, so deploying ahead of CI is
     acceptable.
3. Populate each service's env vars per [§3](#3-env-var-checklist) before the
   first successful boot — `api-staging` boots loud on missing required secrets.

> 📸 _Screenshot placeholder: Railway `api-staging` service settings → Source → branch `main`._

### 1d. Wire the CNAMEs — *pending slice 20 (#2916)*

For each staging service, add a custom domain in Railway and a matching CNAME in
the `useatlas.dev` DNS zone:

| Host                       | Railway service | DNS record                              |
| -------------------------- | --------------- | --------------------------------------- |
| `api.staging.useatlas.dev` | `api-staging`   | CNAME → Railway-provided target         |
| `app.staging.useatlas.dev` | `web-staging`   | CNAME → Railway-provided target         |

1. In Railway: service → **Settings** → **Networking** → **Custom Domain** →
   enter the host. Railway returns a CNAME target.
2. In DNS: add the CNAME pointing at Railway's target. Wait for propagation +
   Railway's TLS issuance to go green.
3. Verify: `curl -I https://api.staging.useatlas.dev/api/health` returns `200`.

> 📸 _Screenshot placeholder: Railway Custom Domain panel showing `api.staging.useatlas.dev` issued, alongside the DNS provider's CNAME record._

> **Peer symmetry.** `api.staging.useatlas.dev` is peer-symmetric with
> `api.useatlas.dev` / `api-eu.useatlas.dev` / `api-apac.useatlas.dev`. Keeping
> the shape identical is what lets OAuth callback URLs and CORS allow-lists be
> derived the same way across regions.

---

## 2. OAuth & provider apps

> References slices 12–18 ([#2900](https://github.com/AtlasDevHQ/atlas/issues/2900)–[#2906](https://github.com/AtlasDevHQ/atlas/issues/2906)),
> all **HITL, pending**. Each provider gets a **separate staging app** — never
> reuse prod credentials. Every callback URL points at
> `api.staging.useatlas.dev`. After creating each app, record its secrets and
> set them in the `api-staging` Railway service ([§3](#3-env-var-checklist)).

The integration OAuth callback path convention is
`https://api.staging.useatlas.dev/api/v1/integrations/<slug>/callback`, where
`<slug>` is the **catalog slug** (e.g. `github-data`, not `github`). The
Better Auth **social-login** callback convention is
`https://api.staging.useatlas.dev/api/auth/callback/<provider>` (Google, GitHub
social sign-in). Confirm the exact path against each handler before submitting it
to the provider.

> **`ATLAS_PUBLIC_API_URL` must be set for any of these OAuth handlers to
> register.** `resolvePublicApiUrl()` in `register.ts` builds every redirect URI
> from `ATLAS_PUBLIC_API_URL`; when it is unset, the Slack/Linear/Salesforce/GitHub
> handlers log "not registered" at boot and their install routes return 501.
> `ATLAS_CORS_ORIGIN` is intentionally **not** a fallback (it's the web origin,
> which mismatches the provider redirect URI in split-origin deploys). Set
> `ATLAS_PUBLIC_API_URL=https://api.staging.useatlas.dev` on `api-staging` — see
> [§3](#3-env-var-checklist).

### 2a. Slack — *pending slice 12 (#2900)*

- **Console:** <https://api.slack.com/apps> → **Create New App** → **From an app
  manifest**. Clone the prod `atlas` app's manifest, rename to `atlas-staging`.
- **Docs:** [Slack OAuth v2](https://api.slack.com/authentication/oauth-v2) ·
  [App manifests](https://api.slack.com/reference/manifests)
- **Redirect URL:** `https://api.staging.useatlas.dev/api/v1/integrations/slack/callback`
- **Env vars produced:** `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`,
  `SLACK_SIGNING_SECRET`, and a fresh 32-byte `SLACK_ENCRYPTION_KEY` (encrypts
  bot tokens in `chat_cache`; generate with `openssl rand -hex 32`).

> 📸 _Screenshot placeholder: Slack app → OAuth & Permissions → Redirect URLs showing the staging callback._

### 2b. Linear — *pending slice 13 (#2901)*

- **Console:** <https://linear.app/settings/api> → **OAuth Applications** → **New
  OAuth Application** named `atlas-staging`.
- **Docs:** [Linear OAuth 2.0 authentication](https://developers.linear.app/docs/oauth/authentication)
- **Scopes:** at minimum `read`, `write`, `issues:create`.
- **Redirect URL:** `https://api.staging.useatlas.dev/api/v1/integrations/linear/callback`
- **Env vars produced:** `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`.

> 📸 _Screenshot placeholder: Linear OAuth Application form with the staging callback and scopes._

### 2c. GitHub — *pending slice 14 (#2902)*

Atlas uses GitHub in two distinct ways; staging may need either or both:

1. **GitHub App** — backs **both** the `github` action integration **and** the
   `github-data` OAuth datasource (they reuse the same `GITHUB_APP_*`
   registration). Create a **separate** GitHub App named `atlas-staging` with its
   own webhook URL.
   - **Console:** <https://github.com/settings/apps> → **New GitHub App**
   - **Docs:** [Creating GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)
   - **Callback URLs — register *both* on the App** (the handlers build distinct
     redirect URIs per slug in `register.ts`, so a single callback won't serve
     both):
     - `https://api.staging.useatlas.dev/api/v1/integrations/github-data/callback`
       — the **datasource** install handler (slug `github-data`).
     - `https://api.staging.useatlas.dev/api/v1/integrations/github/callback`
       — the **action integration** handler (slug `github`).
   - **Env vars produced:** `GITHUB_APP_ID`, `GITHUB_APP_SLUG`,
     `GITHUB_APP_PRIVATE_KEY` (the `.pem` contents), `GITHUB_APP_CLIENT_ID`,
     `GITHUB_APP_CLIENT_SECRET`. All five are required, and `ATLAS_PUBLIC_API_URL`
     must be set (the redirect URI is resolved from it — see [§3](#3-env-var-checklist));
     otherwise the handlers log "not registered" and the install routes return
     501.
     > These `GITHUB_APP_*` vars are documented in `.env.example` (the **GitHub
     > Data integration** block) and in the env-var reference docs page
     > (`apps/docs/content/shared/reference/environment-variables.mdx` → GitHub
     > Integration) ([#3088](https://github.com/AtlasDevHQ/atlas/issues/3088), landed).
2. **GitHub social login** (Better Auth sign-in). A separate OAuth App
   (not GitHub App).
   - **Console:** <https://github.com/settings/developers> → **OAuth Apps** →
     **New OAuth App**
   - **Authorization callback URL:** `https://api.staging.useatlas.dev/api/auth/callback/github`
   - **Env vars produced:** `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`.

> 📸 _Screenshot placeholder: GitHub App settings → Identifying information (App ID) and the webhook/callback URL._

### 2d. Google — *pending slice 15 (#2903)*

- **Console:** [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
  → use the **same GCP project as prod**, create a **separate OAuth 2.0 Client
  ID** for staging.
- **Docs:** [Setting up OAuth 2.0](https://support.google.com/cloud/answer/6158849) ·
  [Using OAuth 2.0](https://developers.google.com/identity/protocols/oauth2)
- **Authorized redirect URI:** `https://api.staging.useatlas.dev/api/auth/callback/google`
- **Env vars produced:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

> 📸 _Screenshot placeholder: GCP Credentials → OAuth client → Authorized redirect URIs with the staging URI._

### 2e. Twenty CRM — *pending slice 16 (#2904)*

- **Console:** [Twenty Cloud](https://twenty.com/) → create a **separate
  workspace** for staging (do not share the prod `crm.useatlas.dev` workspace) →
  **Settings → API & Webhooks → Generate API Key**.
- **Docs:** [Twenty developers / REST API](https://twenty.com/developers)
- **Required schema:** the Twenty `Person` object must have the custom fields
  `atlasFirstSource` **and** `atlasLastSource` (verified at Atlas boot).
- **Env vars produced:** `TWENTY_API_KEY`, `TWENTY_BASE_URL` (the staging
  workspace REST base URL). The boot-time `StagingSeed` Twenty install and the
  smoke harness read the parallel `STAGING_TWENTY_API_KEY` /
  `STAGING_TWENTY_BASE_URL` (see [§4](#4-smoke-test-webhook-wiring) and
  [§7](#7-incidental-findings)).

> 📸 _Screenshot placeholder: Twenty Settings → API & Webhooks → API key generation, and the Person object's custom fields._

### 2f. Stripe — *pending slice 17 (#2905)*

- **Console:** [Stripe Dashboard](https://dashboard.stripe.com/) — toggle **Test
  mode**. Register a **test-mode webhook endpoint** pointing at the staging API.
- **Docs:** [Stripe webhooks](https://docs.stripe.com/webhooks) ·
  [Test mode](https://docs.stripe.com/test-mode)
- **Webhook endpoint URL:** the Better Auth Stripe plugin mounts the webhook
  under the auth namespace (`https://api.staging.useatlas.dev/api/auth/stripe/webhook`).
  Confirm the exact path against the `@better-auth/stripe` plugin mount in
  `packages/api/src/lib/auth/server.ts` before registering.
- **Env vars produced:** `STRIPE_SECRET_KEY` (`sk_test_…`),
  `STRIPE_WEBHOOK_SECRET` (`whsec_…` for the staging endpoint), and the
  **test-mode** price IDs `STRIPE_STARTER_PRICE_ID`,
  `STRIPE_STARTER_ANNUAL_PRICE_ID`, `STRIPE_PRO_PRICE_ID`,
  `STRIPE_PRO_ANNUAL_PRICE_ID`, `STRIPE_BUSINESS_PRICE_ID`,
  `STRIPE_BUSINESS_ANNUAL_PRICE_ID`.

> 📸 _Screenshot placeholder: Stripe → Developers → Webhooks (Test mode) showing the staging endpoint + signing secret._

### 2g. Resend — *pending slice 18 (#2906)*

- **Console:** [Resend Dashboard](https://resend.com/) → create a **separate API
  key** for staging and verify the sender domain `staging.useatlas.dev`.
- **Docs:** [Resend domains](https://resend.com/docs/dashboard/domains/introduction) ·
  [Resend API keys](https://resend.com/docs/dashboard/api-keys/introduction)
- **Env vars produced:** `RESEND_API_KEY`. Pair with `ATLAS_EMAIL_FROM` set to a
  `staging.useatlas.dev` sender.
- **Safety net:** `StagingClamp` is wired into email delivery (**slice 5,
  [#2913](https://github.com/AtlasDevHQ/atlas/issues/2913) — landed**), so every
  outbound email's `to` is rewritten to `STAGING_MAIL_SINK` (default
  `staging-mail@useatlas.dev`) before it reaches Resend — staging cannot email
  real recipients even if a test seeds a real address. See
  [Outbound mail is clamped to a sink](#outbound-mail-is-clamped-to-a-sink).

> 📸 _Screenshot placeholder: Resend → Domains showing `staging.useatlas.dev` verified, and the staging API key._

---

## 3. Env var checklist

Set these on the `api-staging` (and where noted, `web-staging`) Railway service
([§3](#3-env-var-checklist) of slice 21, [#2917](https://github.com/AtlasDevHQ/atlas/issues/2917) —
**pending**). The list below is **exhaustive against `.env.example`** — every
entry in that file is accounted for here. Legend:

- 🔒 **Per-env secret (hard wall)** — generate/obtain a **distinct** staging
  value; never copy prod.
- ♻️ **Share with prod** — the same value as prod is acceptable (no tenant data
  risk).
- 🟦 **Staging-specific value** — a non-secret set to a staging-shaped value
  (URLs, region, cookie prefix).
- ⚪ **Default / unset** — leave at the documented default or unset in staging.

### Core runtime & datasource

| Var(s) | Class | Staging value source |
| ------ | ----- | -------------------- |
| `DATABASE_URL` | 🟦 | Reference `staging-postgres`'s Railway-provided URL. |
| `ATLAS_DATASOURCE_URL` | ♻️ | The shared `__demo__` NovaMart connection (same analytics data as prod's demo). |

### LLM provider

| Var(s) | Class | Staging value source |
| ------ | ----- | -------------------- |
| `ATLAS_PROVIDER`, `ATLAS_MODEL` | ♻️ | Same provider + model as prod. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `AI_GATEWAY_API_KEY` | ♻️ | Same key as prod (model calls carry no customer data risk in staging). A separate key is fine if you want isolated billing/quota. |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | ⚪ | Only if `ATLAS_PROVIDER=bedrock`; otherwise unset. |
| `OLLAMA_BASE_URL`, `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY` | ⚪ | Only for self-host provider modes; unset on SaaS staging. |

### Authentication & Better Auth

| Var(s) | Class | Staging value source |
| ------ | ----- | -------------------- |
| `BETTER_AUTH_SECRET` | 🔒 | Distinct 32-byte random (`openssl rand -base64 32`). Doubles as the at-rest key fallback — keep it off prod's value. |
| `BETTER_AUTH_URL` | 🟦 | `https://api.staging.useatlas.dev`. |
| `BETTER_AUTH_TRUSTED_ORIGINS` | 🟦 | `https://app.staging.useatlas.dev`. (No `www.staging` origin — `www` has no staging deploy.) |
| `ATLAS_ADMIN_EMAIL` | 🟦 | The deterministic staging admin (e.g. `admin@staging.useatlas.dev`). Note `StagingSeed` separately seeds an admin at the **fixed constant** `admin@staging.useatlas.dev` (`STAGING_ADMIN_EMAIL` in `seed.ts` — not an env var), reading only `STAGING_ADMIN_PASSWORD` from the environment (see [§7](#7-incidental-findings)). |
| `ATLAS_ALLOW_FIRST_SIGNUP_ADMIN` | ⚪ | Leave unset (`ATLAS_ADMIN_EMAIL` is set). |
| `ATLAS_AUTH_MODE` | ⚪ | Unset — auto-detected to `managed` (matches prod SaaS). |
| `ATLAS_API_KEY`, `ATLAS_AUTH_JWKS_URL`, `ATLAS_AUTH_ISSUER`, `ATLAS_AUTH_AUDIENCE`, `ATLAS_AUTH_ROLE_CLAIM`, `ATLAS_API_KEY_ROLE` | ⚪ | API-key / BYOT auth modes — unset on SaaS staging. |
| `ATLAS_RATE_LIMIT_RPM`, `ATLAS_RATE_LIMIT_RPM_CHAT`, `ATLAS_RATE_LIMIT_RPM_ADMIN` | ♻️ | Mirror prod values so rate-limit behavior soaks identically. |
| `ATLAS_TRUST_PROXY` | 🟦 | `true` (behind Railway's proxy, same as prod). |
| `ATLAS_REQUIRE_EMAIL_VERIFICATION` | ⚪ | Leave unset — `ATLAS_DEPLOY_ENV=staging` defaults it **off** (see Deploy mode below). |
| `ATLAS_AUTH_RATE_LIMIT_ENABLED`, `ATLAS_AUTH_RATE_LIMIT_WINDOW`, `ATLAS_AUTH_RATE_LIMIT_MAX` | ♻️ | Mirror prod (defaults are fine). |
| `ATLAS_MFA_ISSUER`, `ATLAS_RPNAME` | ⚪ | Default `Atlas`. |
| `ATLAS_RPID` | 🟦 | Set explicitly to `app.staging.useatlas.dev` (do **not** let it derive to the prod domain — [#3045](https://github.com/AtlasDevHQ/atlas/issues/3045)). |
| `ATLAS_ABUSE_QUERY_RATE`, `ATLAS_ABUSE_WINDOW_SECONDS`, `ATLAS_ABUSE_ERROR_RATE`, `ATLAS_ABUSE_UNIQUE_TABLES`, `ATLAS_ABUSE_THROTTLE_DELAY_MS`, `ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS` | ♻️ | Mirror prod (abuse detection runs because `ATLAS_DEPLOY_MODE=saas`). |
| `ATLAS_SESSION_IDLE_TIMEOUT`, `ATLAS_SESSION_ABSOLUTE_TIMEOUT`, `ATLAS_SESSION_COOKIE_CACHE_MAX_AGE_SEC` | ♻️ | Mirror prod (defaults fine). |
| `ATLAS_SEMANTIC_ROOT` | ⚪ | Unset — production uses `atlas.config.ts` `semanticLayer`. |
| `ATLAS_SEMANTIC_INDEX_ENABLED` | ⚪ | Default `true`. |

### Social login

| Var(s) | Class | Staging value source |
| ------ | ----- | -------------------- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | 🔒 | Staging Google OAuth client ([§2d](#2d-google--pending-slice-15-2903)). |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | 🔒 | Staging GitHub social-login OAuth app ([§2c](#2c-github--pending-slice-14-2902)). |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID` | ⚪ | Only if Microsoft social login is enabled; otherwise unset. |

### MCP & OAuth provider (DCR)

| Var(s) | Class | Staging value source |
| ------ | ----- | -------------------- |
| `ATLAS_MCP_USER_ID`, `ATLAS_MCP_ORG_ID` | ⚪ | MCP actor binding — unset unless staging runs a governed MCP transport. |
| `ATLAS_OAUTH_VALID_AUDIENCES` | ⚪ | Unset — derives from `BETTER_AUTH_URL`/public API URL (`/mcp`). |
| `ATLAS_OAUTH_ALLOW_UNAUTH_DCR`, `ATLAS_OAUTH_ACCESS_TOKEN_TTL_SECONDS`, `ATLAS_OAUTH_REFRESH_TOKEN_TTL_SECONDS`, `ATLAS_OAUTH_STATE_TTL_SECONDS` | ♻️ | Mirror prod (defaults fine). |

### Agent

| Var(s) | Class | Staging value source |
| ------ | ----- | -------------------- |
| `ATLAS_AGENT_MAX_STEPS`, `ATLAS_BYOT_CATALOG_TTL_MS`, `ATLAS_CONVERSATION_STEP_CAP`, `ATLAS_DASHBOARD_DRAFT_RETENTION_DAYS` | ♻️ | Mirror prod (defaults fine). |

### Semantic expert

| Var(s) | Class | Staging value source |
| ------ | ----- | -------------------- |
| `ATLAS_EXPERT_SCHEDULER_ENABLED`, `ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS`, `ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD`, `ATLAS_EXPERT_AUTO_APPROVE_TYPES` | ⚪ | Default (scheduler off) unless you're specifically soaking expert runs. |

### SQL security & pooling

| Var(s) | Class | Staging value source |
| ------ | ----- | -------------------- |
| `ATLAS_TABLE_WHITELIST`, `ATLAS_ROW_LIMIT`, `ATLAS_QUERY_TIMEOUT`, `ATLAS_SCHEMA` | ♻️ | Mirror prod (defaults fine). |
| `ATLAS_POOL_WARMUP`, `ATLAS_POOL_DRAIN_THRESHOLD` | ♻️ | Mirror prod (defaults fine). |

### RLS, cache, learning, starter prompts

| Var(s) | Class | Staging value source |
| ------ | ----- | -------------------- |
| `ATLAS_RLS_ENABLED`, `ATLAS_RLS_COLUMN`, `ATLAS_RLS_CLAIM` | ⚪ | Default (RLS off) unless soaking RLS. |
| `ATLAS_CACHE_ENABLED`, `ATLAS_CACHE_TTL`, `ATLAS_CACHE_MAX_SIZE` | ♻️ | Mirror prod (defaults fine). |
| `ATLAS_LEARN_CONFIDENCE_THRESHOLD` | ♻️ | Default `0.7`. |
| `ATLAS_STARTER_PROMPT_COLD_WINDOW_DAYS`, `ATLAS_STARTER_PROMPT_AUTO_PROMOTE_CLICKS`, `ATLAS_STARTER_PROMPT_MAX_FAVORITES` | ♻️ | Mirror prod (defaults fine). |

### Demo data & demo mode

| Var(s) | Class | Staging value source |
| ------ | ----- | -------------------- |
| `ATLAS_DEMO_DATA` | ⚪ | Unset — staging uses the shared `__demo__` connection via `ATLAS_DATASOURCE_URL`, not the internal-DB-as-datasource shortcut. |
| `ATLAS_DEMO_ENABLED`, `ATLAS_DEMO_RATE_LIMIT_RPM`, `ATLAS_DEMO_MAX_STEPS`, `ATLAS_DEMO_INDUSTRY` | ⚪ | Default (public `/demo` off) unless soaking demo mode. |

### Encryption

| Var(s) | Class | Staging value source |
| ------ | ----- | -------------------- |
| `ATLAS_ENCRYPTION_KEYS` | 🔒 | **Distinct** versioned keyset from prod — so a staging DB dump can't decrypt prod-shape integration credentials. Required on SaaS. |
| `ATLAS_ENCRYPTION_KEY` | ⚪ | Legacy single-key form — leave unset, use `ATLAS_ENCRYPTION_KEYS`. |
| `ATLAS_STRICT_PLUGIN_SECRETS` | 🟦 | `true` (SaaS regions opt in). |

### Email

| Var(s) | Class | Staging value source |
| ------ | ----- | -------------------- |
| `ATLAS_EMAIL_PROVIDER` | 🟦 | `resend`. |
| `RESEND_API_KEY` | 🔒 | Staging Resend key ([§2g](#2g-resend--pending-slice-18-2906)). |
| `SENDGRID_API_KEY`, `POSTMARK_SERVER_TOKEN`, `ATLAS_SMTP_URL` | ⚪ | Alternate providers — unset. |
| `ATLAS_EMAIL_ALLOWED_RECIPIENT_DOMAINS` | ⚪ | Optional; `StagingClamp` already clamps recipients. (`ATLAS_EMAIL_ALLOWED_DOMAINS` is deprecated per #4479 — one-release fallback.) |
| `ATLAS_EMAIL_FROM` | 🟦 | A `staging.useatlas.dev` sender (e.g. `Atlas Staging <noreply@staging.useatlas.dev>`). |
| `ATLAS_ONBOARDING_EMAILS_ENABLED` | ⚪ | Leave unset — `ATLAS_DEPLOY_ENV=staging` defaults it **off**. |
| `ATLAS_UNSUBSCRIBE_TOKEN_TTL_MS` | ♻️ | Default (30 days). |
| `ATLAS_EMAIL_OUTBOX_TICK_SECONDS`, `ATLAS_EMAIL_OUTBOX_WARN_THRESHOLD`, `ATLAS_EMAIL_OUTBOX_FLUSHER_ENABLED` | ♻️ | Mirror prod (flusher on — staging has an internal DB). |

### Twenty CRM

| Var(s) | Class | Staging value source |
| ------ | ----- | -------------------- |
| `TWENTY_BASE_URL` | 🟦 | The staging Twenty workspace REST base URL. |
| `TWENTY_API_KEY` | 🔒 | Staging Twenty workspace key ([§2e](#2e-twenty-crm--pending-slice-16-2904)). |
| `ATLAS_CRM_OUTBOX_WARN_THRESHOLD`, `ATLAS_CRM_OUTBOX_FLUSHER_ENABLED` | ♻️ | Mirror prod (single-region staging → flusher on). |

### Talk-to-sales form

| Var(s) | Class | Staging value source |
| ------ | ----- | -------------------- |
| `TURNSTILE_SECRET_KEY` | 🔒 | Staging Cloudflare Turnstile secret (paired with the site key). |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | 🟦 | Staging Turnstile site key (set on `web-staging`). |
| `ATLAS_CONTACT_RATE_LIMIT_RPM` | ♻️ | Default `5`. |

### Python tool & OpenAPI/REST datasources

| Var(s) | Class | Staging value source |
| ------ | ----- | -------------------- |
| `ATLAS_PYTHON_ENABLED`, `ATLAS_PYTHON_TIMEOUT` | ♻️ | Mirror prod (Python tool config). |
| `ATLAS_OPENAPI_TIMEOUT`, `ATLAS_OPENAPI_CONFIRM_TTL_SECONDS`, `ATLAS_OPENAPI_SHARED_SPEC_TTL_MS`, `ATLAS_OPENAPI_SPEC_REFRESH_INTERVAL_HOURS`, `ATLAS_OPENAPI_REDISCOVER_INTERVAL_HOURS` | ♻️ | Mirror prod (defaults fine). |
| `ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS` | 🟦 | `false` — never enable the SSRF bypass on a SaaS staging host. |

### Appearance, multi-tenancy, settings

| Var(s) | Class | Staging value source |
| ------ | ----- | -------------------- |
| `ATLAS_BRAND_COLOR` | ♻️ | Default brand color. |
| `ATLAS_ORG_ID` | ⚪ | CLI-only; unset on the service. |
| `ATLAS_SETTINGS_REFRESH_INTERVAL` | ♻️ | Default `30000`. |

### Scheduler

| Var(s) | Class | Staging value source |
| ------ | ----- | -------------------- |
| `ATLAS_SCHEDULER_ENABLED` | ♻️ | Match prod (on if you want scheduled tasks to soak). |
| `ATLAS_SCHEDULER_SECRET` / `CRON_SECRET` | 🔒 | Distinct staging shared secret for the `/tick` endpoint. |
| `ATLAS_SCHEDULER_BACKEND`, `ATLAS_SCHEDULER_MAX_CONCURRENT`, `ATLAS_SCHEDULER_TIMEOUT`, `ATLAS_SCHEDULER_TICK_INTERVAL`, `ATLAS_ORPHAN_TASK_RECONCILE` | ♻️ | Mirror prod (defaults fine). |

### Networking, CORS, URLs

| Var(s) | Class | Staging value source |
| ------ | ----- | -------------------- |
| `ATLAS_PUBLIC_API_URL` | 🟦 | **`https://api.staging.useatlas.dev` — required.** `resolvePublicApiUrl()` builds every OAuth install handler's redirect URI from this; unset ⇒ Slack/Linear/GitHub/Salesforce install routes return 501 ([§2](#2-oauth--provider-apps)). Now a declared `.env.example` entry under **Networking** ([#3096](https://github.com/AtlasDevHQ/atlas/issues/3096), landed). |
| `ATLAS_PUBLIC_URL` | 🟦 | `https://api.staging.useatlas.dev`. Distinct from `ATLAS_PUBLIC_API_URL` — this one is the action-approval URL base; it is **not** a fallback for the OAuth redirect URI. |
| `ATLAS_CORS_ORIGIN` | 🟦 | `https://app.staging.useatlas.dev`. (No `www.staging` origin — `www` has no staging deploy.) |
| `ATLAS_API_URL` | ⚪ | Dev rewrite target — unset in deployed staging. |
| `ATLAS_PUBLIC_WEB_URL` | 🟦 | `https://app.staging.useatlas.dev`. |
| `NEXT_PUBLIC_ATLAS_API_URL` | 🟦🏗️ | `https://api.staging.useatlas.dev` (`web-staging`). **Build-time** — the `deploy/web/Dockerfile` already declares this as a build `ARG`; pass it as a Railway build arg, not just a runtime var. |
| `NEXT_PUBLIC_ATLAS_AUTH_MODE` | 🟦🏗️ | `managed` (`web-staging`). **Build-time** — already a `deploy/web/Dockerfile` build `ARG`. |
| `NEXT_PUBLIC_ATLAS_COOKIE_PREFIX` | 🟦🏗️ | `atlas-staging` — **must equal** the API's `ATLAS_COOKIE_PREFIX`. **Build-time and load-bearing for prod/staging isolation:** `packages/web/src/proxy.ts` reads it as a static `process.env.NEXT_PUBLIC_*` inlined at build. `deploy/web/Dockerfile` now threads it as a build `ARG` (alongside `NEXT_PUBLIC_ATLAS_API_URL` + `NEXT_PUBLIC_ATLAS_AUTH_MODE`) ([#3096](https://github.com/AtlasDevHQ/atlas/issues/3096), landed) — pass it as a Railway **build arg**, not just a runtime var, or the proxy defaults to `atlas` and treats prod's broadly-scoped cookie as a staging session. |
| `NEXT_PUBLIC_ATLAS_API_BASE` | ⚪🏗️ | **Build-time, www-only — not a staging var.** `www` has no staging deploy (it ships direct from `main` to prod), so there's no staging `www` service to set this on. `apps/www/src/components/talk-to-sales-form.tsx` posts to `NEXT_PUBLIC_ATLAS_API_BASE ?? "https://api.useatlas.dev"`, so on the prod `www` service it can be left unset (defaults to the prod API). Documented in `.env.example` ([#3096](https://github.com/AtlasDevHQ/atlas/issues/3096), landed); `www` builds with NIXPACKS so the Railway service var is inlined at build (no Dockerfile to thread). |

> 🏗️ = **build-time** `NEXT_PUBLIC_*` variable. Next.js inlines these into the
> client bundle at `bun run build`, so they must be present as build args/ENV
> before the build step — setting them only as runtime service vars has no
> effect on the already-built bundle.

### Observability & runtime

| Var(s) | Class | Staging value source |
| ------ | ----- | -------------------- |
| `ATLAS_LOG_LEVEL` | 🟦 | `info` (or `debug` while soaking). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | ♻️ | Same collector as prod (spans carry a `deploy.region=staging` attribute, so staging traffic is filterable). |
| `ATLAS_MIGRATION_RETRIES` | ♻️ | Default `5`. |
| `ATLAS_RUNTIME` | ⚪ | Unset (not Vercel). |

### Sandbox / explore isolation

| Var(s) | Class | Staging value source |
| ------ | ----- | -------------------- |
| `ATLAS_SANDBOX_URL` | ⚪ | Unset — staging has no sidecar; it shares the prod Vercel Sandbox priority via the config file. |
| `ATLAS_SANDBOX`, `ATLAS_SANDBOX_PRIORITY`, `ATLAS_SANDBOX_BACKEND` | ⚪ | Unset — SaaS pins `["vercel-sandbox"]` in the deploy config, not env. |
| `SIDECAR_AUTH_TOKEN`, `ATLAS_NSJAIL_PATH`, `ATLAS_NSJAIL_TIME_LIMIT`, `ATLAS_NSJAIL_MEMORY_LIMIT` | ⚪ | Unset (no sidecar / nsjail on SaaS staging). |
| `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, `VERCEL_TOKEN` | 🔒 | Required so off-Vercel `api-staging` can call `@vercel/sandbox`. Set **per-service** (Railway shared vars don't auto-inherit). Same Vercel team as prod; a staging-scoped token is preferable. |

### Action framework

| Var(s) | Class | Staging value source |
| ------ | ----- | -------------------- |
| `ATLAS_ACTIONS_ENABLED`, `ATLAS_ACTION_APPROVAL`, `ATLAS_ACTION_TIMEOUT`, `ATLAS_ACTION_MAX_PER_CONVERSATION` | ♻️ | Mirror prod. |

### Chat & other integrations

| Var(s) | Class | Staging value source |
| ------ | ----- | -------------------- |
| `SLACK_SIGNING_SECRET`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_ENCRYPTION_KEY` | 🔒 | Staging Slack app ([§2a](#2a-slack--pending-slice-12-2900)). |
| `SLACK_BOT_TOKEN` | ⚪ | Single-workspace mode — unset (staging uses multi-workspace OAuth). |
| `ATLAS_SLACK_INSTALL_TABLE` | ⚪ | Default `chat_cache` unless the chat plugin overrides `tablePrefix`. |
| `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` | 🔒 | Staging Linear app ([§2b](#2b-linear--pending-slice-13-2901)). |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | ⚪ | Only if soaking Discord; staging app credentials if so. |
| `TEAMS_APP_ID` | ⚪ | Only if soaking Teams; per-org passwords live in the DB, not env. |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_DEFAULT_PROJECT` | ⚪ | Manual-token Jira flow — unset unless soaking Jira actions. |
| `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET` | ⚪ | Jira lazy-OAuth — staging Atlassian app if soaking; otherwise unset. |
| `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET`, `SALESFORCE_LOGIN_URL` | ⚪ | Only if soaking Salesforce; staging connected-app if so. |

### Stripe billing

| Var(s) | Class | Staging value source |
| ------ | ----- | -------------------- |
| `STRIPE_SECRET_KEY` | 🔒 | `sk_test_…` ([§2f](#2f-stripe--pending-slice-17-2905)). |
| `STRIPE_WEBHOOK_SECRET` | 🔒 | `whsec_…` for the staging test-mode webhook endpoint. |
| `STRIPE_STARTER_PRICE_ID`, `STRIPE_STARTER_ANNUAL_PRICE_ID`, `STRIPE_PRO_PRICE_ID`, `STRIPE_PRO_ANNUAL_PRICE_ID`, `STRIPE_BUSINESS_PRICE_ID`, `STRIPE_BUSINESS_ANNUAL_PRICE_ID` | 🔒 | **Test-mode** price IDs from the staging Stripe account. |

### Data residency

| Var(s) | Class | Staging value source |
| ------ | ----- | -------------------- |
| `ATLAS_API_REGION` | 🟦 | **`staging`** — the canonical region discriminator. Drives the banner, `ResidencyResolver` no-op arm, seed/clamp gating, and `/api/health`. |
| `ATLAS_STRICT_ROUTING` | ♻️ | Match prod. |
| `ATLAS_INTERNAL_SECRET` | 🔒 | Distinct staging cross-region secret (staging is excluded from the residency router, so this rarely fires — keep it isolated regardless). |

### Deploy mode

| Var(s) | Class | Staging value source |
| ------ | ----- | -------------------- |
| `ATLAS_DEPLOY_MODE` | 🟦 | `saas` — staging exercises the full SaaS code path (enterprise gating, residency Tag, keyset enforcement). |
| `ATLAS_DEPLOY_ENV` | 🟦 | `staging` — drives non-secret per-env defaults (email-verification off, onboarding off, cookie prefix `atlas-staging`). |
| `ATLAS_COOKIE_PREFIX` | 🟦 | `atlas-staging` — must equal `web-staging`'s `NEXT_PUBLIC_ATLAS_COOKIE_PREFIX`. The prefix (not the cookie domain) is what isolates the staging session from prod's broadly-scoped `.useatlas.dev` cookie. |

### Enterprise & SaaS add-ons

| Var(s) | Class | Staging value source |
| ------ | ----- | -------------------- |
| `ATLAS_ENTERPRISE_ENABLED`, `ATLAS_ENTERPRISE_LICENSE_KEY` | 🟦 | Enable if you want to soak enterprise surfaces; use a staging/non-prod license. |
| `ATLAS_APPROVAL_EXPIRY_HOURS`, `ATLAS_SCIM_OVERRIDE_POLICY` | ♻️ | Mirror prod (defaults fine). |
| `ATLAS_SLA_LATENCY_P99_MS`, `ATLAS_SLA_ERROR_RATE_PCT`, `ATLAS_SLA_WEBHOOK_URL` | ⚪ | SLA monitoring — point the webhook at a staging channel if enabled, else unset. |
| `ATLAS_BACKUP_SCHEDULE`, `ATLAS_BACKUP_RETENTION_DAYS`, `ATLAS_BACKUP_STORAGE_PATH` | ⚪ | Backups — default/unset unless soaking backups. |
| `ATLAS_BACKUP_VERIFY_SCRATCH_URL` | ⚪ | Only with a **disposable** scratch DB (it WIPES on every run); never point at the staging or any real DB. |

### Status page & sub-processors

| Var(s) | Class | Staging value source |
| ------ | ----- | -------------------- |
| `NEXT_PUBLIC_STATUS_URL`, `NEXT_PUBLIC_OPENSTATUS_SLUG` | ⚪ | Optional; unset on staging or point at a staging status feed. |
| `ATLAS_SUBPROCESSORS_URL`, `ATLAS_SUBPROCESSOR_PUBLISH_INTERVAL_MS` | ⚪ | Default (publisher mirrors SaaS config). |

### Railway custom domains (enterprise feature)

| Var(s) | Class | Staging value source |
| ------ | ----- | -------------------- |
| `RAILWAY_API_TOKEN`, `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_WEB_SERVICE_ID` | 🔒 | Only if staging exercises the custom-domain feature. Use the `staging` environment ID and `web-staging` service ID; the token stays workspace-scoped. |

> **Staging seed env vars.** `StagingSeed` and the smoke harness read
> `STAGING_ADMIN_PASSWORD`, `STAGING_MAIL_SINK`, `STAGING_TWENTY_API_KEY`, and
> `STAGING_TWENTY_BASE_URL` — now documented in `.env.example` under
> **Staging seed (SaaS staging region only)**
> ([#3088](https://github.com/AtlasDevHQ/atlas/issues/3088), landed). Set them on
> `api-staging`. The seeded admin **email** is the fixed constant
> `admin@staging.useatlas.dev` (`STAGING_ADMIN_EMAIL` in `seed.ts`), not an env
> var. The CI-only smoke secrets `STAGING_DATABASE_URL` / `STAGING_SLACK_WEBHOOK_URL`
> live in GitHub Actions, not on the service.

---

## 4. Smoke-test webhook wiring

> References slice 10 ([#2898](https://github.com/AtlasDevHQ/atlas/issues/2898)) —
> `.github/workflows/staging-smoke.yml` is **pending**. The flow below is the
> intended wiring.

The chain is: **Railway staging-deploy success → GitHub `repository_dispatch` →
`staging-smoke.yml`.**

1. **Railway notifies GitHub on a successful staging deploy.** Configure a
   Railway deploy webhook (or a deploy-success step) on the `api-staging` service
   to POST a GitHub `repository_dispatch` with event type
   **`staging-deploy-success`**:

   ```bash
   curl -fsS -X POST \
     -H "Authorization: Bearer $GH_DISPATCH_TOKEN" \
     -H "Accept: application/vnd.github+json" \
     https://api.github.com/repos/AtlasDevHQ/atlas/dispatches \
     -d '{"event_type":"staging-deploy-success"}'
   ```

   The `GH_DISPATCH_TOKEN` must be able to **write** the dispatch: a
   fine-grained PAT needs **`Contents: write`** repository permission (GitHub
   requires write for `repository_dispatch` — see the
   [REST docs](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event));
   a read-only token is rejected. A classic PAT needs the `repo` scope. Store it
   as a Railway secret.

2. **`staging-smoke.yml` listens for the dispatch** (*pending slice 10*):

   ```yaml
   on:
     repository_dispatch:
       types: [staging-deploy-success]
   ```

3. **The job runs two checks:**
   - **Health + region:**
     ```bash
     curl -fsS https://api.staging.useatlas.dev/api/health | jq -e '.region == "staging"'
     ```
     This confirms the deploy landed and the region discriminator is set. The
     route is public — no auth, no API code change needed.
   - **CRM smoke:**
     ```bash
     bun run atlas-operator -- ops smoke-crm --personas ./scripts/staging-smoke-personas.yml
     ```
     with `TWENTY_API_KEY=$STAGING_TWENTY_API_KEY`,
     `TWENTY_BASE_URL=$STAGING_TWENTY_BASE_URL`, and
     `DATABASE_URL=$STAGING_DATABASE_URL` in the job env. The CLI talks directly
     to Twenty + Postgres (not through the staging API host). The personas
     fixture `scripts/staging-smoke-personas.yml` is committed alongside the
     workflow (*pending slice 10*).

4. **Result posts to Slack.** The pass/fail is posted to the maintainer's Slack
   via the existing chat plugin (re-using the `#sandbox-atlas` dogfood channel
   pattern), so the on-call sees whether the last merge is safe to tag without
   opening Railway.

**Interpreting a red signal:**

| Failure | Likely cause |
| ------- | ------------ |
| `curl` non-200 | `api-staging` didn't boot / CNAME or TLS not ready / health route down. |
| `.region != "staging"` | `ATLAS_API_REGION` not set to `staging` on `api-staging`. |
| `smoke-crm` fails | Staging Twenty key/URL wrong, `Person` custom fields missing, or the `crm_outbox` flusher wedged. |

---

## 5. Resetting the staging DB — `atlas-operator ops wipe`

When staging accumulates drift, reset its internal DB with the operator wipe
subcommand. It is **destructive** and **takes no backup**.

```bash
ATLAS_WIPE_OK=1 bun run atlas-operator -- ops wipe --confirm --database-url "$STAGING_DATABASE_URL"
```

- **Double gate.** The command refuses to run unless **both**
  `ATLAS_WIPE_OK=1` (exactly the string `1` — `true`/`yes` are rejected) **and**
  `--confirm` are present. This is intentional; one gate is too easy to trip.
- **No backup is taken.** `ops wipe` `TRUNCATE`s every table in the target's
  `public` schema (excluding migration bookkeeping). If you want a snapshot first,
  wrap it yourself: `pg_dump "$STAGING_DATABASE_URL" > staging-pre-wipe.sql`.
- **One DB per invocation.** Point `--database-url` at the **staging** DB
  explicitly. Without it the command targets `ATLAS_TEAM_PG_URL` (falling back to
  `DATABASE_URL`) — double-check you are not pointed at prod.
- **Reseed is automatic.** On the next `api-staging` boot, `ensureStagingSeed`
  re-creates the `staging-internal` org, the deterministic admin
  (`admin@staging.useatlas.dev` / `STAGING_ADMIN_PASSWORD`), the `__demo__`
  datasource, and (if `STAGING_TWENTY_*` are set) the Twenty install. The seed is
  idempotent, so a boot against a non-empty DB is a no-op.

> **Never run `ops wipe` against a prod region DB.** The staging DB is wipe-on-
> demand by design; prod is not. Confirm the `--database-url` host before adding
> `--confirm`.

---

## 6. Cutover playbook — moving prod onto the tag pattern

> References slice 22 ([#2918](https://github.com/AtlasDevHQ/atlas/issues/2918)) —
> **HITL**. This is the one-time switch that flips prod from "every `main` push
> deploys" to "only a release tag deploys."

**This already happened.** Per [release-process.md](./release-process.md), the
dual trigger went **live with `v0.0.1`** (wired in
[#2921](https://github.com/AtlasDevHQ/atlas/issues/2921)): prod already watches
the `prod` branch, advanced only by `/release` — the pre-`v0.0.1`
main-to-prod autodeploy is **retired**. A merge to `main` no longer reaches
customers on its own. The steps below document the cutover procedure for
reference and re-verification; the remaining slice-22 scope is confirming that
**every** prod service — including `www` — is on `prod` (not `main`).

**Steps:**

1. **Pre-flight.** Confirm staging is fully green: both staging services
   (`api-staging`, `web-staging`) deployed, `GET /api/health` returns
   `region: "staging"`, and a smoke run passed. Don't cut over onto a broken staging.
2. **Create the `prod` branch at the current prod SHA.** It must point at exactly
   what prod is running right now:
   ```bash
   git fetch origin
   git push origin <current-prod-SHA>:refs/heads/prod
   ```
   (Branch protection treats `prod` as a Railway-tracking artifact — no PRs, only
   `/release` advances it.)
3. **Repoint each gated prod service to `prod`.** In Railway, for `api`, `api-eu`,
   `api-apac`, and `web`: **Settings → Source → Branch** → change `main` to `prod`.
   Leave `docs` **and `www`** on `main` (both direct-from-main static `output: export`
   exports, no runtime surface to gate). (`www` was prod-gated at the original
   cutover but has since moved to direct-from-`main` like `docs` — a merge touching
   `apps/www/**` now goes live on www.useatlas.dev immediately.)
4. **Bridge the gap immediately with the first tag.** Any PR merged on cutover
   day *after* the flip but *before* the first prod tag won't reach prod until a
   tag fires. The first regular tag (`v0.0.1`, cut 2026-05-29) closed this window
   right after the flip — this is why cutover and the first `/release` were a
   single coordinated step. If you ever re-run a cutover, push the next tag in
   train (`/release`) immediately after repointing.
5. **Verify lineage.** `git rev-parse origin/prod` should equal the tagged SHA,
   and the four prod services (`api`, `api-eu`, `api-apac`, `web`) should show a
   fresh deploy sourced from `prod`.
6. **Update the memory + docs.** Cutover is reflected in the
   `feedback_no_staging_env` / staging-environment memory ("staging shipped —
   see `docs/development/staging-environment.md`"), and `release-process.md`
   documents the now-live dual trigger.

**Rollback during cutover.** If a prod service misbehaves on the first
`prod`-sourced deploy, Railway's per-service health-check rollback restores the
prior image for that region while the others proceed. To revert the whole
experiment, repoint the services back to `main` — but only as an emergency; the
intended end state is all four prod services (`api`, `api-eu`, `api-apac`, `web`)
on `prod` (with `docs` and `www` direct-from-`main`).

See [release-process.md § Common pitfalls](./release-process.md#common-pitfalls)
for "I tagged but prod didn't deploy" once cutover is complete.

---

## 7. Incidental findings

Building the env-var checklist (and the Codex review of this PR) surfaced
`.env.example` and deploy-config gaps. **All are now resolved** — the staging
hardening cluster ([#3088](https://github.com/AtlasDevHQ/atlas/issues/3088) +
[#3096](https://github.com/AtlasDevHQ/atlas/issues/3096)) closed them rather than
leaving them as deferred tickets:

1. ✅ **`STAGING_*` family documented** ([#3088](https://github.com/AtlasDevHQ/atlas/issues/3088)).
   `StagingSeed` (`packages/api/src/lib/staging/seed.ts`) and the smoke harness
   read `STAGING_ADMIN_PASSWORD`, `STAGING_MAIL_SINK`, `STAGING_TWENTY_API_KEY`,
   and `STAGING_TWENTY_BASE_URL` — now in `.env.example` under **Staging seed
   (SaaS staging region only)** and in the env-var reference docs. The seeded
   admin **email** is the fixed constant `admin@staging.useatlas.dev`
   (`STAGING_ADMIN_EMAIL` in `seed.ts`), not an env var, so it's documented as a
   note rather than a settable entry.
2. ✅ **`GITHUB_APP_*` family documented** ([#3088](https://github.com/AtlasDevHQ/atlas/issues/3088)).
   The `github`/`github-data` OAuth handlers
   (`packages/api/src/lib/integrations/install/register.ts`) read `GITHUB_APP_ID`,
   `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_ID`, and
   `GITHUB_APP_CLIENT_SECRET` — now in `.env.example` under **GitHub Data
   integration** and a dedicated **GitHub Integration** section of the env-var
   reference, distinct from the social-login `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`.
3. ✅ **`ATLAS_PUBLIC_API_URL` declared** ([#3096](https://github.com/AtlasDevHQ/atlas/issues/3096)).
   The **required** base for every OAuth install handler's redirect URI
   (`resolvePublicApiUrl()`) now has its own `# ATLAS_PUBLIC_API_URL=` entry under
   **Networking** in `.env.example`, documenting that `ATLAS_CORS_ORIGIN` is
   intentionally not a fallback.
4. ✅ **`NEXT_PUBLIC_ATLAS_API_BASE` documented** ([#3096](https://github.com/AtlasDevHQ/atlas/issues/3096)).
   `apps/www`'s talk-to-sales form
   (`apps/www/src/components/talk-to-sales-form.tsx`) falls back to the prod API
   when unset; the build-time var is now in `.env.example`. `www` builds with
   NIXPACKS, so the Railway service var is inlined at build (no Dockerfile to
   thread).
5. ✅ **`deploy/web/Dockerfile` threads `NEXT_PUBLIC_ATLAS_COOKIE_PREFIX`**
   ([#3096](https://github.com/AtlasDevHQ/atlas/issues/3096)).
   `packages/web/src/proxy.ts` reads it at build time; the Dockerfile now declares
   `ARG NEXT_PUBLIC_ATLAS_COOKIE_PREFIX` + `ENV` alongside the API-URL/auth-mode
   args, so a build arg actually reaches the bundle (a runtime-only value would
   silently default to `atlas` and defeat prod/staging session isolation).

A sixth finding — the `RegionGuardLive` ⟂ EE residency-resolver contradiction on
the `staging` region — was reconciled under
[#3097](https://github.com/AtlasDevHQ/atlas/issues/3097): on the staging deploy
the EE resolver now treats the boot-required `staging` entry in
`residency.regions` as legitimate (quiet debug), not dead config (warn). See the
RESOLVED CONTRACT note on the `staging` arm in `deploy/api/atlas.config.ts` (the
separate staging config that once held this note was retired in
[#3958](https://github.com/AtlasDevHQ/atlas/issues/3958)).

---

## 8. Analytics-datasource fleet — operational notes (#3253 soak matrix)

The multi-engine datasource-matrix soak ([#3253](https://github.com/AtlasDevHQ/atlas/issues/3253))
runs Postgres + MySQL + ClickHouse + Elasticsearch + OpenSearch as **live
analytics datasources** in one workspace, all driven through the deployed
agent. Those engines run as their own Railway services in the `staging`
environment of the `satisfied-creation` project, alongside `staging-postgres`
(Atlas's internal DB):

| Service | Engine | Role |
|---------|--------|------|
| `staging-postgres` | Postgres 16 | internal DB (auth/audit/settings) — always on |
| `MySQL` | MySQL | analytics datasource |
| `ClickHouse` | ClickHouse | analytics datasource |
| `Elasticsearch` | Elasticsearch | analytics datasource |
| `railwayapp-opensearch` | OpenSearch 2.19 (`vergissberlin/railwayapp-opensearch` template) | analytics datasource |

Two operational characteristics surfaced by the 2026-06-22 soak are now fixed
on the Railway side. Both fixes live in **Railway service config**, not the
repo — they're recorded here because the soak only completed by working around
them manually.

### App Sleep is disabled on every analytics DB ([#3880](https://github.com/AtlasDevHQ/atlas/issues/3880))

Atlas connects to these services over the **private network**
(`*.railway.internal`). Railway only wakes a sleeping service on **public /
edge-proxy** inbound traffic — **not** on private-network inbound from
`api-staging`. So a slept analytics DB makes the **first cold agent query hard-
fail with `ECONNREFUSED`**, and nothing Atlas does over the private network
wakes it (only a redeploy or external public traffic does).

Fix: **App Sleep is turned off** (`sleep_application = false`) on `ClickHouse`,
`Elasticsearch`, `railwayapp-opensearch`, and `MySQL` so they stay warm and a
cold agent query connects without a manual redeploy. `staging-postgres` was
already always-on.

> ⚠️ [#3867](https://github.com/AtlasDevHQ/atlas/issues/3867)'s cold-pool retry
> handles a **transient** cold-connect on a **live** pool — it does **not** (and
> shouldn't) cover a fully-slept server. A slept service is `ECONNREFUSED` on a
> stopped process; the retry can only help once the server is up.

If App Sleep is ever re-enabled to save spend, the pre-soak wake step is: open
each analytics DB service in Railway and redeploy it (or hit a public endpoint)
**before** starting the soak — a private-network query alone will not wake it.

### OpenSearch disk watermark + ephemeral data ([#3878](https://github.com/AtlasDevHQ/atlas/issues/3878))

`railwayapp-opensearch` keeps `path.data=/usr/share/opensearch/datalocal` — the
data dir sits on the **small ephemeral container filesystem**, not the attached
`opensearch-data` volume. That's the deliberate volume-UID workaround: the
volume mounts root-owned but the process runs as `RAILWAY_RUN_UID=1000`, so
data was pushed off the volume to a container-writable path (see
`docs/development/...` and the volume-UID note in project memory).

The small ephemeral fs trips OpenSearch's **disk-based shard-allocation
watermark** (low 85% / high 90% / flood 95%): a fresh index won't allocate its
primary, and the flood-stage `index.blocks.read_only_allow_delete` makes
`/_cluster/health` and queries hang (the soak saw 21ms↔>20s latency swings and
a `degraded` Atlas datasource).

Fix: set **`cluster.routing.allocation.disk.threshold_enabled=false`** as a
Railway service variable on `railwayapp-opensearch`. The OpenSearch Docker image
folds dotted env-var names into `opensearch.yml`, so the setting applies **at
boot**. This matters: the setting is a *dynamic* cluster setting, but applying
it via the `_cluster/settings` API would be **lost on every redeploy** because
cluster state lives on the ephemeral `path.data`. Only a boot-time setting
survives. With the decider off, the node boots **GREEN** and fresh indices
allocate without manually disabling the watermark each time. Disabling the
decider also clears any stuck `read_only_allow_delete` block.

### Data persistence decision: stay ephemeral, seed-before-soak

OpenSearch / ClickHouse / Elasticsearch data on staging is **ephemeral** — a
redeploy (including the wake-from-sleep redeploy above) **wipes it**. The
decision is to **keep it ephemeral** rather than move onto a persistent volume:
the OpenSearch volume-UID workaround already forced `path.data` off the volume,
and fixing that properly means forking the template entrypoint to `chown` the
mount for UID 1000 — not worth it for throwaway soak data. So **re-seed indices
/ tables at the start of each soak** and don't expect analytics-DB data to
survive a restart. (The internal `staging-postgres` is the only persistent
store, and it holds no analytics data.)

---

## Operational rules

- **New integrations start on staging.** When adding a chat platform, action
  target, or datasource, create the staging app/credentials first and soak there.
  Never OAuth-register a new platform straight against prod.
- **Staging mirrors prod config, not prod data.** Don't assume staging shares a
  database or secrets with prod; provision its own. The lone shared resource is
  the read-only `__demo__` analytics datasource.
- **A red staging run blocks the tag.** `/ci` runs before a release tag is cut,
  and a staging regression should be caught and fixed on `main` before
  `/release`.
- **Analytics DBs don't sleep, and their data is ephemeral.** App Sleep is off
  on the staging analytics datasources ([#3880](https://github.com/AtlasDevHQ/atlas/issues/3880)) —
  a private-network query from `api-staging` can't wake a slept service, so a
  cold query would `ECONNREFUSED`. Their data is wiped on redeploy; **re-seed
  before a soak** (see §8).

## Quick smoke check (manual)

After a `main` merge deploys to staging:

1. Load `app.staging.useatlas.dev` — confirm the amber banner is present.
2. `curl https://api.staging.useatlas.dev/api/health` — confirm `200` and
   `"region":"staging"` in the body.
3. Sign in with the seeded admin and run a query end-to-end against the staging
   datasource.
4. Trigger an email (e.g. a password reset) and confirm it lands in the
   `STAGING_MAIL_SINK` inbox, **never** the real recipient — the outbound clamp
   is working.

## References

- Design rationale: [staging PRD](../prd/staging-environment.md) ([#2893](https://github.com/AtlasDevHQ/atlas/issues/2893))
- Release flow this gates: [release-process.md](./release-process.md)
- Versioning + release branches: [ADR-0008](../adr/0008-versioning-and-release-tags.md)
- Tag-organized roadmap: [ADR-0009](../adr/0009-tag-organized-roadmap.md)
- Branch protection (the gate tags pass through): [branch-protection.md](./branch-protection.md)
- Milestone: [Staging Environment (#57)](https://github.com/AtlasDevHQ/atlas/milestone/57)
