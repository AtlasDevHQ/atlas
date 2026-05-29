# PRD: Staging environment + tag-gated production deploys

**Status:** Draft → ready-for-agent on filing
**Owner:** maintainer
**Posture:** pre-customer-launch (SaaS in trial; safe to introduce deploy gate without coordinating cutover with paying tenants)
**Target ship:** late June 2026

Read alongside:
- `docs/adr/0006-three-pillar-integration-taxonomy.md` — deploy_mode model
- `docs/adr/0007-unified-install-pipeline.md` — workspace_plugins schema
- `docs/adr/0008-versioning-and-release-tags.md` — version + Stability Contract policy (pending — handoff item 1)
- `docs/adr/0009-tag-organized-roadmap.md` — milestone/roadmap restructure (pending — handoff item 2)
- Cited prod incidents from the post-1.6.0 burst: #2858, #2856, #2857, #2864, #2865

---

## Problem Statement

Every push to `main` deploys straight to production across all three regions. There is no gate between "merge" and "customer-visible." After 1.6.0 shipped, five production incidents in 48 hours validated that the gap is load-bearing:

- **#2858** — catalog-seeder NOT NULL violation on Teams row, swallowed by boot-pass try/catch; every catalog edit in `deploy/api/atlas.config.ts` since migration 0097 was silently dropped from prod for ~10 days.
- **#2856** — Cloudflare Turnstile widget blocked by CSP on `apps/www/serve.ts`; the entire talk-to-sales form on `/pricing`, `/sla`, `/dpa`, `/terms` was broken for ~1 day, losing real leads.
- **#2857** — CORS helper allowed only a single origin; `www.useatlas.dev` requests to `api.useatlas.dev/api/v1/contact` got no `Access-Control-Allow-Origin` header. Same form, same window.
- **#2864** — `Effect.fork` instead of `Effect.forkScoped` killed every periodic Layer fiber at gen completion. CRM outbox flusher silent for ~30 min; if it had been the SLA monitor or audit retention, the silent-fail window could have been days.
- **#2865** — `TwentyClient.findPersonByEmail` used Strapi-style filter syntax; Twenty silently returned the unfiltered Person list. Every CRM lead after the first collapsed onto one Twenty Person record.

Each was caught only after prod was wedged. The recovery pattern was identical: maintainer notices a metric or a dogfood signal, opens a hotfix PR, merges and prays. Five fix-in-prod incidents in 48 hours during a quiet pre-launch week.

Compounding factor: solo maintainer + parallel-claude workflow means 3–5 in-flight branches at any moment. Every merge to `main` triggers a full prod deploy across all three regions. A bad merge isn't just a customer-visible bug — it's a cross-region rollout. Railway's health check rolls back per-service, but only after the bad deploy actually fails health; bugs that pass health (CORS misconfig, CSP block, silent fiber death, REST filter that returns 200) don't trigger rollback at all.

## Solution

Introduce a single staging environment fronting production. The shape is deliberately minimal — one region, one Postgres, one set of service replicas — because empirically every prod incident in the cited burst would have surfaced on a single-region staging soak before the prod tag fired.

User-visible promotion model:

- **`main` push** → staging deploys automatically (api + web + www, no docs)
- **Eyeball staging** — via `atlas ops smoke-crm`, click-through, or the `/verify` skill
- **Tag a release** — `git tag -a v0.x.y && git push origin v0.x.y` triggers production deploy across all three regions in parallel. Pushing the explicit tag ref (not `--tags`) prevents accidentally publishing stale local tags into the prod trigger.
- **Hotfix** — push fix to `main`, tag immediately. Don't wait for staging soak. Both deploys fire on the same commit; if prod's health check fails, Railway auto-rolls-back the bad region while staging keeps the failed code for reproduction.

Docs (`docs.useatlas.dev`) continues to deploy direct from `main`. The static-export + Caddy posture (PR #2879) means docs has no runtime surface to gate. `apps/www` IS gated despite the user's initial prior to leave it direct — the empirical evidence from #2856 + #2857 was that CSP / embed / origin changes in www are exactly the class staging catches, and the marginal cost is one small Railway service.

The maintainer's daily loop changes by exactly two steps: (1) wait ~5 min for staging to soak before tagging (skippable in hotfix), (2) tag via the new `/release` skill (skill itself is out of scope for this PRD, tracked separately). Everything else stays the same.

## User Stories

### Maintainer — primary daily user

1. As the maintainer, I want every push to `main` to deploy to a staging environment automatically, so that I can see the change running in a SaaS-shaped environment before customers do.
2. As the maintainer, I want staging to fail loudly when boot-time SQL or migrations are broken, so that I catch issues like #2858 before they ship.
3. As the maintainer, I want staging's CSP, CORS, and origin allow-lists to mirror prod, so that issues like #2856 and #2857 manifest in staging not prod.
4. As the maintainer, I want staging to actually exercise the CRM outbox flusher and other periodic fibers, so that scope-binding regressions like #2864 surface in staging not prod.
5. As the maintainer, I want staging to hit a real (test) Twenty Cloud workspace and a real (test) Stripe account, so that external-API integration bugs like #2865 surface in staging.
6. As the maintainer, I want tagging a release to deploy only the tag's commit to prod, so that uncommitted main work never ships.
7. As the maintainer, I want hotfixes to bypass the staging soak when urgent, so that a sub-hour fix is still possible.
8. As the maintainer, I want each region's prod deploy to be independent, so that if `api-eu` fails health, `api` and `api-apac` keep their current image.
9. As the maintainer, I want migrations to run on the staging DB before they touch prod, so that schema-drift bugs surface staging-side first.
10. As the maintainer, I want staging to use a fresh, deterministic seed on first boot, so that there's no PII risk and the staging state is reproducible.
11. As the maintainer, I want staging to share the `__demo__` NovaMart datasource with prod, so that I don't have to maintain two copies of the demo data.
12. As the maintainer, I want staging credentials to be fully isolated from prod (Stripe test mode, separate OAuth apps per provider, separate Twenty workspace, separate `BETTER_AUTH_SECRET` and `ATLAS_ENCRYPTION_KEYS`), so that a staging-side breach cannot authorize prod actions or decrypt prod-shape data.
13. As the maintainer, I want staging emails to clamp to `staging-mail@useatlas.dev`, so that I can verify rendering without spamming real-looking fake addresses or hurting Resend sender reputation.
14. As the maintainer, I want to log into staging with a deterministic admin credential, so that I can manually exercise admin surfaces without running through full signup each time.
15. As the maintainer, I want a `/staging` visual marker on the web app, so that I never confuse a staging tab with a prod tab during dogfood.
16. As the maintainer, I want `atlas ops smoke-crm` to be runnable against the staging URLs out of the box, so that the post-deploy gate is one command not five.
17. As the maintainer, I want staging to be a 4th region keyed `staging` and excluded from the residency router, so that no prod traffic gets misrouted to staging and staging never claims to be a residency target.
18. As the maintainer, I want OAuth callback URLs for Slack/Linear/GitHub/Google staging apps to point to `api.staging.useatlas.dev`, so that real OAuth flows can be exercised against staging end-to-end.
19. As the maintainer, I want a Railway-level kill switch for the staging deploy trigger, so that if staging itself is broken I can disable it without blocking prod releases.
20. As the maintainer, I want `bun run atlas -- ops wipe --confirm` to work against the staging DB, so that I can reset state when staging accumulates drift.

### Future contributor — once external contributions open up

21. As a future contributor, I want to read `docs/development/release-process.md` and understand the merge→staging→tag→prod flow in under 5 minutes, so that I can ship a fix without breaking things.
22. As a future contributor, I want the PR template to remind me that merge goes to staging not prod, so that I expect the staging URL in my verification step.

### Customer admin — indirect beneficiary

23. As a customer admin, I want fewer prod incidents per release, so that my data and integrations stay reliable. Success metric: hotfix-PR count over rolling 90-day window drops from current baseline (5 hotfixes / 48 hours during 1.6.0 burst) to ≤2 hotfixes / month at comparable release cadence.

### On-call / observer — future role

24. As the on-call, I want clear deploy lineage (`v0.1.4` deployed on date X to all regions, staging soak duration N min), so that I can correlate incident windows to specific deploys.
25. As the on-call, I want a smoke-test pass/fail signal posted to Slack after every staging deploy, so that I know without checking whether the last merge is safe to tag.

## Implementation Decisions

### Region-keying and deploy mode

- `ATLAS_DEPLOY_MODE` stays `"saas"` for staging so that the SaaS code paths (enterprise gating, residency Tag, encryption keyset enforcement) are all exercised identically to prod.
- **The discriminator is the existing `ATLAS_API_REGION` env var, not a new one.** `packages/api/src/lib/residency/misrouting.ts:getApiRegion()` and `lib/effect/saas-guards.ts:RegionGuardLive` already read `ATLAS_API_REGION` (falling back to `residency.defaultRegion`). Introducing a parallel `ATLAS_DEPLOY_REGION` would leave those readers stuck on the default `us`, defeating the staging isolation. Staging deploys set `ATLAS_API_REGION=staging`; existing values `us | eu | apac` join the new `staging` arm.
- The `DeployRegion` type union in `@useatlas/types` widens to `"us" | "eu" | "apac" | "staging"`. Type-only change; the runtime read remains via the existing `getApiRegion()` helper.
- `ResidencyResolver` Tag in `ee/src/platform/residency/` gains a `staging` arm that returns `null` from `resolveRegionDatabaseUrl`, falling through to the local DB connection. Existing `us/eu/apac` paths untouched. A region-aware-connection test pins the staging arm against accidental routing changes.
- The existing public `/api/health` route already surfaces `region` from `getApiRegion()`. Staging's region appears there with no new wire fields. The auth'd `/api/v1/mode` route does NOT gain `deployRegion` — `/health` is sufficient and avoids needing to sign in to verify region during smoke tests.

### Deep modules

- **`StagingClamp` (new, deep)** at `packages/api/src/lib/staging/clamp.ts`. Pure transform: `clampOutbound(region: DeployRegion, sendable: T): T`. Identity transform for non-staging regions. For staging:
  - Email payloads — rewrite `to` field to `STAGING_MAIL_SINK` env var (default `staging-mail@useatlas.dev`). Preserve `subject`, `body`, `from`, headers.
  - Future expansion (out of scope today): Stripe customer creation mirror, Slack webhook destination overrides, etc.
- **`StagingSeed` (new, deep)** at `packages/api/src/lib/staging/seed.ts`. Idempotent boot-time bootstrap: `ensureStagingSeed(): Effect<void>`. Runs in `lib/startup.ts` when `getApiRegion() === "staging"` (reading the same env source as residency). On first boot creates:
  - 1 organization `staging-internal`
  - 1 admin user (deterministic email `admin@staging.useatlas.dev`, password from `STAGING_ADMIN_PASSWORD`)
  - 1 datasource pointing at the shared `__demo__` NovaMart connection
  - 1 staging Twenty install pointing at the separate Twenty Cloud workspace
  Subsequent boots: detect seed marker (`org.slug = "staging-internal"`) and skip. No-op on `region !== "staging"`.
- **Email delivery integration** — `packages/api/src/lib/email/delivery.ts` calls `StagingClamp.clampOutbound(getRegion(), payload)` before handing to Resend. One insertion point.

### Railway topology

- Same Railway project (`satisfied-creation`), new environment `staging`.
- Four new resources in the staging env:
  - `api-staging` (Hono API service)
  - `web-staging` (Next.js)
  - `www-staging` (Caddy static)
  - `staging-postgres` (Railway-managed Postgres)
  - No staging docs service (docs deploys direct from `main`)
  - No staging sandbox sidecar — staging shares the prod Vercel Sandbox per existing `deploy/api/atlas.config.ts` priority (Vercel Sandbox is per-request Firecracker microVM with `networkPolicy: "deny-all"`, so cross-env contamination is structurally impossible)
- CNAMEs:
  - `api.staging.useatlas.dev` → `api-staging` (peer-symmetric with `api.useatlas.dev` / `api-eu.useatlas.dev` / `api-apac.useatlas.dev`)
  - `app.staging.useatlas.dev` → `web-staging`
  - `www.staging.useatlas.dev` → `www-staging`
- Deploy triggers (path 2 — prod-branch tracker, see [release-process.md § Mental model](../development/release-process.md#mental-model)):
  - `api-staging` / `web-staging` / `www-staging` → watch `main` branch (autodeploy on merge)
  - `api` / `api-eu` / `api-apac` / `web` / `www` → watch `prod` branch (advanced by `/release` via `git push origin <tag-sha>^{}:prod --force-with-lease`)
  - `docs` → continues watching `main` (direct-to-prod; static export + Caddy, no runtime surface)

  Prod `www` joins the `prod`-branch group because `apps/www` IS gated per Q2 — leaving prod www on `main` push would let CSP/embed changes like #2856/#2857 ship without ever transiting staging, contradicting the design.

  This shape was originally drafted as "Railway tag-pattern `v*.*.*`". Railway has no native tag trigger and the Railway CLI cannot deploy an arbitrary SHA on a GitHub-linked service (`railway up` ships a local tarball, severing the GitHub Deployments link). The `prod`-branch tracker is the simplest composable primitive that preserves Railway's branch-driven autodeploy semantics. The `prod` branch is a Railway-tracking artifact, not an integration branch — no PRs target it, only `/release` advances it. Branch protection enforces this. See [ADR-0008 § Release branches: none](../adr/0008-versioning-and-release-tags.md#release-branches-none).

### Configuration file

- New `deploy/api-staging/atlas.config.ts`, structurally identical to `deploy/api/atlas.config.ts`. Same plugin set, same proactive runtime wiring. Per-service env vars carry the staging-specific OAuth credentials and the `ATLAS_API_REGION=staging` discriminator. Justification for not just reusing the prod file: prod config imports from absolute `/app/` paths in the SaaS container and embeds prod-only assumptions; a separate file keeps regional drift explicit and reviewable.

### Credentials hard wall

Per-env Railway env vars for every secret in `.env.example`. No inheritance between staging and prod environments. Specifically:

- `STRIPE_SECRET_KEY` = `sk_test_...` in staging
- `STRIPE_WEBHOOK_SECRET` = `whsec_test_...` in staging (separate webhook endpoint registered)
- `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` = staging Slack app credentials. New Slack app `atlas-staging` cloned from prod manifest; callback URL `https://api.staging.useatlas.dev/api/v1/integrations/slack/callback`.
- `LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET` = staging Linear app
- `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` = staging GitHub App (separate App, separate webhook URL)
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` = staging OAuth client in same GCP project as prod, separate client
- `TWENTY_API_KEY` = staging Twenty Cloud workspace key (separate workspace, separate key — Atlas's own crm.useatlas.dev workspace stays prod-only)
- `RESEND_API_KEY` = staging Resend API key + verified sender domain `staging.useatlas.dev`
- `BETTER_AUTH_SECRET` = staging-specific 32-byte random
- `ATLAS_ENCRYPTION_KEYS` = staging-specific versioned keyset (so a staging DB dump can't decrypt prod-shape integration credentials)
- `ATLAS_API_REGION` = `staging` (the canonical region discriminator — see Region-keying section)
- `STAGING_MAIL_SINK` = `staging-mail@useatlas.dev` (consumed by `StagingClamp`)
- `STAGING_ADMIN_PASSWORD` = deterministic credential for the seeded admin

### Smoke-test harness

- New `.github/workflows/staging-smoke.yml`. Triggers on Railway staging-deploy success webhook. Runs:
  - `curl -fsS https://api.staging.useatlas.dev/api/health | jq -e '.region == "staging"'` — verifies the deploy actually landed and the region discriminator is set. `/health` is public, no auth; the existing route already surfaces `region` from `getApiRegion()`, so no API code change is needed for this check.
  - `bun run atlas -- ops smoke-crm --personas ./scripts/staging-smoke-personas.yml` with `TWENTY_API_KEY=$STAGING_TWENTY_API_KEY`, `TWENTY_BASE_URL=$STAGING_TWENTY_BASE_URL`, `DATABASE_URL=$STAGING_DATABASE_URL` env vars. The CLI talks directly to Twenty + Postgres — no `--base-url` against the staging API host. A small personas fixture lives in `scripts/staging-smoke-personas.yml` and is committed to the repo.
- Posts pass/fail to maintainer's Slack via the existing chat plugin (re-uses the `#sandbox-atlas` channel pattern from the proactive dogfood loop).

### Observability

- All OTel spans gain a `deploy.region` attribute (`"us" | "eu" | "apac" | "staging"`). Rate-limit middleware already includes `deploy.mode`; the region attr makes staging traffic filterable in dashboards.
- The web client renders the staging banner by reading `region` from the public `/api/health` endpoint — pre-auth, no sign-in required. `/api/v1/mode` is NOT touched; it stays auth-gated for the in-app developer-mode UX.

### Operator documentation

- New `docs/development/staging-environment.md` — operator runbook covering Railway setup (env creation, service cloning, PG provisioning, CNAME wiring), the OAuth app creation list with per-provider step-by-step, the env var checklist, and the smoke-test webhook wiring. Lives next to (eventual) `docs/development/release-process.md`.
- Existing `docs/development/branch-protection.md` and CLAUDE.md "Merge discipline" section get cross-references to the new release flow.

## Testing Decisions

What makes a good test here: each test exercises a contract at the staging boundary without coupling to internal staging-clamp wiring. Tests should fail iff a prod-vs-staging policy is violated, not iff a refactor moved the implementation.

### `StagingClamp` — pure unit test

Module: `packages/api/src/lib/staging/__tests__/clamp.test.ts`. Cases:

- `clampOutbound("us", emailWithRealTo)` returns unchanged
- `clampOutbound("eu", emailWithRealTo)` returns unchanged
- `clampOutbound("apac", emailWithRealTo)` returns unchanged
- `clampOutbound("staging", emailWithRealTo)` rewrites `to` to sink
- `clampOutbound("staging", emailWithRealTo)` preserves `subject`, `body`, `from`, custom headers
- `clampOutbound("staging", emailWithEmptyTo)` returns sink-targeted email (not crash)
- `clampOutbound("staging", emailWithArrayTo)` rewrites an array `to` to a one-element `[sink]` array — one recipient (the sink), with the array shape preserved so `clampOutbound`'s `(T) => T` signature stays type-honest (collapsing to a bare string would make the runtime value diverge from the declared `string[]`)

Prior art: `packages/api/src/lib/__tests__/cors-origin.test.ts` — pure-function allowlist tests.

### `StagingSeed` — real-Postgres integration test

Module: `packages/api/src/lib/staging/__tests__/seed.test.ts`. Runs against `TEST_DATABASE_URL` (Postgres service container in api-tests CI shard). Cases:

- `ensureStagingSeed` on empty DB creates 1 org with slug `staging-internal`, 1 admin user, 1 datasource, 1 Twenty install
- `ensureStagingSeed` second call is idempotent — no duplicate rows
- Admin user's password hash verifies against `STAGING_ADMIN_PASSWORD`
- Datasource's `connection_id` resolves to the `__demo__` connection
- `ensureStagingSeed` on `ATLAS_API_REGION=us` is a no-op (early-return without DB touch)

Prior art: `packages/api/src/lib/db/__tests__/migrate-pg.test.ts` — real-PG integration test pattern, including the `MANAGED_AUTH_MIGRATIONS` opt-in for Better Auth tables.

### `ResidencyResolver` staging arm — extend existing test

Module: `packages/api/src/lib/db/__tests__/region-aware-connection.test.ts` (existing). Add case:

- `resolveRegionDatabaseUrl("staging")` returns `null` (falls through to local DB)
- A staging-keyed request is not mis-routed to a residency-mapped region

Prior art: the existing test file's pattern for asserting Tag behavior under varying region values.

### Smoke-test harness

- The GH Action IS the test. No meta-test required.
- Documented failure modes in `docs/development/staging-environment.md` so the on-call can interpret a red signal.

### Out of test scope

- Railway service creation, CNAME wiring, OAuth app registration at providers — operator runbook validation, not code tests. The runbook lives at `docs/development/staging-environment.md`; correctness is verified by running through it once and capturing any drift.
- The `atlas ops wipe` subcommand against staging — already covered by existing CLI tests; staging is just another DB URL to it.

## Out of Scope

- **`/release` skill creation** — separate work item, tracked via handoff doc, lands as part of the v0.0.1 (Release Process Bootstrap) milestone.
- **`docs/adr/0008-versioning-and-release-tags.md`** — Q6 (versioning policy + Stability Contract) gets its own ADR, see handoff item 1.
- **`docs/adr/0009-tag-organized-roadmap.md`** — Q7 (roadmap restructure) gets its own ADR, see handoff item 2.
- **`docs/development/release-process.md`** — operational doc for the dual-trigger release flow, see handoff item 3. The PRD assumes this exists; the staging implementation can ship before it but Day 1 docs should be in place.
- **ROADMAP.md restructure** — see handoff item 6. The staging build can be tracked in the current ROADMAP shape as a single line item under "Active" until restructure lands.
- **Stability Contract docs page** — customer-facing, see handoff item 4.
- **v0.1.0 — July Launch milestone scoping** — see handoff item 7.
- **Cross-DB validation from staging against prod regional DBs** — deferred. The risk inversion (unvalidated staging code reading prod data) makes this dangerous. If ever needed, the correct shape is read-replica + contract tests against `/api/health`, not direct DB access.
- **Twenty self-hosting in staging** — deferred until the 1.7.0 Generic REST / Non-SQL Datasources work begins. Today staging uses Twenty Cloud separate workspace, same as prod's Twenty Cloud usage.
- **Pre-release tags** (`v0.1.0-rc.1`, `v0.1.0-canary.1`) — deferred until first enterprise customer requests an RC channel. KISS for now.
- **PR-preview environments** (one staging instance per open PR) — Railway is not designed for this; cost is prohibitive and Vercel-style preview envs would require a different platform.
- **Path-based staging gates** (`apps/www/serve.ts` → staged, rest of www → direct) — rejected in Q2 in favor of per-service rule for mental simplicity. Reconsider if www staging soak becomes a real friction.
- **Persistent staging across DB wipes** — staging DB is wipe-on-demand (via `atlas ops wipe`), not wipe-on-deploy. Persistence is the default.
- **Auto-rollback to prior tag on failed prod health check** — Railway already handles per-service health-check rollback. App-level "tag back to v0.x-1" logic is not introduced.

## Further Notes

- **Cost estimate.** Railway services run roughly $5–10/mo each at small scale; three new services plus a managed Postgres totals ~$30–50/mo. Sleep schedules can reduce idle cost further. Compared against the engineering cost of the post-1.6.0 fix-in-prod burst (5 PRs × ~30 min mean turnaround = 2.5 hours of context-switched maintainer time, plus ~1 day of broken `/pricing` form lead-loss), staging pays for itself within ~2 months at any reasonable hourly rate.
- **Cutover risk.** The day staging is wired, the Railway prod deploy trigger changes from "main branch push" to "tag pattern match." Any PR merged on cutover day but before the first prod tag fires won't ship to prod until the first tag is pushed. Coordinate the cutover with an immediate tag push (the first regular tag, `v0.0.1`) to bridge the gap. Document this in the operator runbook.
- **Solo-maintainer caveat.** The 5-min staging soak adds friction for the current "merge → prod in 5 min" cadence. The `/release` skill + muscle memory will absorb most of it within a week. Worst case, the maintainer treats staging soak as "background tab while I context-switch to the next PR."
- **Customer trust posture.** Atlas is currently SaaS-launched in 3 regions but has no paying tenants at risk. Cutover does not require customer communication. Once paying tenants exist, future deploy-gate changes will need a comms plan; staging itself is invisible to customers.
- **`feedback_no_staging_env.md` memory.** The user memory entry capturing "no staging env — infra runs against prod" gets updated post-implementation to "staging shipped (PR #XYZ), see docs/development/staging-environment.md." The lesson stays banked rather than being deleted.
- **Provenance.** This design followed a 7-question `/grill-me` session on 2026-05-28. Decisions Q1–Q5 are captured here. Q6 (versioning) → ADR-0008 (pending). Q7 (roadmap restructure) → ADR-0009 (pending). Session handoff at `/tmp/handoff-ugF7Qr.md` covers all non-staging-PRD follow-up.
