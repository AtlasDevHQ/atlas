# Local development

Runbook for running Atlas locally. Read this first if `bun run dev` won't boot.

## Quick start

```bash
bun install
cp .env.example .env      # ships ATLAS_DEPLOY_MODE=self-hosted — keep it for local dev
bun run db:up             # Postgres + sandbox sidecar containers
bun run atlas -- init     # profile the demo DB, generate the semantic layer
bun run dev               # containers + Hono API (:3001) + Next.js (:3000)
```

Dev admin: **admin@useatlas.dev / atlas-dev**.

## Deploy mode: self-hosted is the default, SaaS works too

Local dev runs **either** deploy mode. `self-hosted` is the trivial default; the SaaS code
path is one flip away and now boots without the prod-only secrets.

### Self-hosted (the default)

`.env.example` ships `ATLAS_DEPLOY_MODE=self-hosted` + `ATLAS_DEPLOY_ENV=development`. Keep
both. Self-hosted skips every SaaS-only guard and exercises the same agent / datasource /
admin code paths, so it's right for almost all local work.

Belt-and-suspenders: with `ATLAS_DEPLOY_ENV=development` set, even an **unset** or `auto`
deploy mode resolves to `self-hosted` (`resolveDeployMode()` in
`packages/api/src/lib/effect/deploy-mode.ts`). Before this, `auto` resolved to **`saas`** in
this monorepo (`@atlas/ee` present + a DB configured) and the API hard-failed boot on the
SaaS-only guards while `/health` and the web app stayed green — the classic "half-broken
app" that was really a deploy-mode mismatch. A development checkout no longer face-plants.

> Setting deploy vars on the `bun run dev` *command line*
> (`ATLAS_DEPLOY_MODE=… bun run dev`) is unreliable — the wrapper script spawns the API in a
> subshell and the inline var doesn't always propagate. Put them in `.env`, which the server
> loads directly.

### Developing SaaS-only features locally

Set `ATLAS_DEPLOY_MODE=saas` in `.env` (keep `ATLAS_DEPLOY_ENV=development`). That's it — the
API boots the SaaS code path against your existing local `.env`.

In `development` env the SaaS **fail-closed boot guards relax to a no-op**
(`relaxSaasGuardForDev()` in `saas-guards.ts`): `TURNSTILE_SECRET_KEY`, `ATLAS_RATE_LIMIT_RPM`,
the provider-key guards, chat-adapter env, billing config, and the MCP spine probe are all
skipped, so you no longer rediscover the prod env bundle one boot-crash at a time. Each
relaxed guard logs a loud `RELAXED — ATLAS_DEPLOY_ENV=development` warning. The migration,
encryption-key, and internal-DB guards stay **active** — they're real correctness signals and
pass for free on any working dev box (DB up, `BETTER_AUTH_SECRET` set, migrations applied).

> ⚠️ This is an intentional security footgun, gated **solely** on `ATLAS_DEPLOY_ENV=development`.
> A customer-facing region never runs `development` (it sets `production` or leaves it unset,
> and pins `deployMode` in `deploy/api/atlas.config.ts`, #3702). **Never set
> `ATLAS_DEPLOY_ENV=development` on a real deploy** — it would relax these guards (and has
> already turned off email verification, onboarding emails, and the admin-MFA gate via
> `env-profile.ts`). The authoritative list of SaaS boot keys is `SAAS_ENV_KEYS` in
> `packages/api/src/lib/effect/saas-env.ts`; the guards live in `saas-guards.ts`.

## `VERCEL_*` / `ATLAS_SANDBOX_URL` in your shell and sandbox tests

**Fixed for the in-repo suites:** the sandbox backend-selection tests
(`explore-backend`, `explore-workspace-override`, `python`) neutralize ambient
`VERCEL_TOKEN` / `VERCEL_TEAM_ID` / `VERCEL_PROJECT_ID` (and `ATLAS_SANDBOX_URL`)
in their env setup, so a shell — or a `.env`-loading agent session — that carries
deploy credentials no longer makes them resolve the real Vercel sandbox and fail
locally while green in CI.

If a sandbox test ever fails this way again, the bug is a *new* test missing that
hygiene — add the `VERCEL_*` deletes to its env setup rather than working around
it. The blunt workaround still works in a pinch:

```bash
env -u VERCEL_TOKEN -u VERCEL_TEAM_ID -u VERCEL_PROJECT_ID -u ATLAS_SANDBOX_URL bun run test
```

See [testing.md](testing.md) for the full local-vs-CI test parity checklist.
