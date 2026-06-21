Bring Atlas local dev up reliably in a chosen deploy mode, handling every harness gotcha that normally makes this painful. Usage: `/dev [self-host|saas] [clean] [stop]`.

This command exists because getting local dev to boot — especially SaaS mode — keeps tripping on the same papercuts (deploy-mode auto-detect, fail-closed SaaS guards, cookie-prefix mismatch, Turbopack/browser cache). Encode the fix once; stop rediscovering it.

## Args

- **`self-host`** (default when no arg) — boot in self-hosted mode. Zero SaaS env, exercises the same agent/datasource/admin code paths. Right for almost all local work.
- **`saas`** — boot the SaaS code path locally (billing, trials, marketplace, all plugins). Uses the dev guard-relaxation so it boots against your real `.env` with no prod-only secret bundle.
- **`clean`** — also nuke the build caches first (`.next` + `node_modules/.cache`). Use when a UI/code change isn't showing up. Can combine: `/dev saas clean`.
- **`stop`** — stop the running dev stack (find the background task and `TaskStop` it; never `pkill` — that signals harness tasks and exits 144).

## Steps

Run from the repo root (`/home/msywu/oss/atlas/ide`). Containers must be up: `bun run db:up` (Postgres :5432 + sandbox sidecar) — idempotent, run it if `docker ps` doesn't show `ide-postgres-1` healthy.

### 1. Set the mode in `.env` (NOT the command line)

`.env` is the source of truth — the `bun run dev` wrapper spawns the API in a subshell and inline `VAR=… bun run dev` does NOT propagate. Edit `.env`:

- `ATLAS_DEPLOY_ENV=development` — always, for both modes. This is load-bearing: it (a) relaxes the SaaS fail-closed boot guards via `relaxSaasGuardForDev` in `packages/api/src/lib/effect/saas-guards.ts`, (b) bypasses the admin-MFA enrollment gate, (c) turns off email verification + onboarding emails, and (d) makes unset/`auto` deploy mode resolve to self-hosted (`resolveDeployMode`).
- **self-host:** `ATLAS_DEPLOY_MODE=self-hosted`
- **saas:** `ATLAS_DEPLOY_MODE=saas` **and** `NEXT_PUBLIC_ATLAS_COOKIE_PREFIX=atlas-dev`.
  - The cookie prefix is mandatory: in `development` the API issues `atlas-dev.session_token`, but the web middleware (`packages/web/src/proxy.ts`) defaults to looking for `atlas.session_token`. Mismatch → every `/admin/*` route bounces to `/login` even with a valid session. (Self-host dev usually works without it because deploy-env still drives the API prefix, but set it for saas.)

### 2. SaaS only — register every plugin

SaaS dev should expose the whole marketplace. There is **no auto-discovery** — plugins must be enumerated in a root `atlas.config.ts` (`loadConfig` finds `atlas.config.{ts,js,mjs}` at the repo root; with none present, dev boots with zero plugins). Ensure a root `atlas.config.ts` exists registering them; it's **gitignored** (`/atlas.config.ts` in `.gitignore`) — a local-only dev artifact, never committed, and it doesn't touch deploy (which uses `deploy/api/atlas.config.ts`). If it's missing, generate it (see the committed reference shape in this command's history / `docs/development/local-development.md`).

What to register (verified to boot — mirroring prod's curation; registering literally every factory fights the architecture and fails config validation):
- **`plugins[]`: the 4 datasource ADAPTERS only** — `clickhousePlugin({})`, `snowflakePlugin({})`, `bigqueryPlugin({})`, `elasticsearchPlugin({})`. This is the part migrations DON'T do — it makes those plugin datasources functionally installable via Admin → Connections.
- **Do NOT register** (deliberate, same as prod, each fails or is inert): Postgres/MySQL (bridge registers DB-stored installs natively — no entry needed), DuckDB (file-based, not multi-tenant-safe), Salesforce (OAuth-managed via `integration_credentials` + `LazyPluginLoader` — a `plugins[]` entry is inert), and **`chatPlugin`** (config validation requires a host `executeQuery` + proactive runtime that only `deploy/api/atlas.config.ts` wires).
- **Marketplace catalog is already handled by migrations.** Chat platforms (slack/telegram/discord/teams/gchat/whatsapp) and integrations (email/jira/twenty/webhook/obsidian/linear/github) are seeded into `plugin_catalog` by migrations + the builtin-datasource seed, so they show in the marketplace WITHOUT a `catalog: [...]` here. Don't add catalog rows unless you need to force a normally-hidden row visible (e.g. `github-pat`) — and note `install_model:'form'` rows REQUIRE a non-empty `configSchema`, so copy the row verbatim from deploy.
- Sandbox backends are priority-selected at runtime, not `plugins[]` entries.

Do NOT set `deployMode` inside `atlas.config.ts` — leave it to `.env` so the same file serves both modes. The 9 builtin datasources (postgres/mysql/snowflake/clickhouse/bigquery/duckdb/salesforce/elasticsearch/demo) seed regardless of config. The full verified config is ~12 lines: `defineConfig({ plugins: [clickhousePlugin({}), snowflakePlugin({}), bigqueryPlugin({}), elasticsearchPlugin({})] })` with the four imports.

### 3. `clean` — nuke caches if requested (or if a change isn't rendering)

```
rm -rf packages/web/.next packages/web/node_modules/.cache node_modules/.cache
```

Turbopack dev uses **stable chunk filenames** (no content hash). A stale chunk survives `.next` wipes in two places: the dev server's Turbopack cache (`node_modules/.cache`) AND the browser's HTTP cache (which survives tab close). If a code edit compiles but doesn't show in the browser, this is why — wipe both, and in the browser force a cache-bypassing reload (or close the whole context, not just the tab).

### 4. Boot in the background and verify BOTH ports

Start `bun run dev` as a background task (it stays alive; redirect to a log). Then poll until ready — do not trust "server up" from one port:

- API: `curl -sf http://localhost:3001/api/health` returns (503 is fine — means it's serving; the app answers even when a provider key is missing).
- Web: `curl -s http://localhost:3000` responds.
- Watch the log for `Server startup failed` / `Layer DAG could not initialize` (boot guard tripped — in saas without `development`, or a genuinely missing non-relaxed guard like encryption/internal-DB).

A cold first compile of a route is several seconds (Turbopack); subsequent hits are fast. For saas, confirm the log shows `deployMode: "saas"` followed by the `RELAXED — ATLAS_DEPLOY_ENV=development` guard warnings (RateLimit/Turnstile/ProviderKey/…). Those warnings are expected and correct in dev.

### 5. Report

State the mode, both URLs (web :3000, API :3001), the dev admin login (**admin@useatlas.dev / atlas-dev**), and — for saas — that the guards relaxed and plugins registered. Leave the stack running unless `stop` was requested.

## Gotcha index (the hard-won list)

- **Deploy vars belong in `.env`, not the `bun run dev` command line** (wrapper subshell drops them).
- **`ATLAS_DEPLOY_ENV=development` is the master dev switch** — relaxes SaaS guards, bypasses MFA, off email-verify, auto→self-host. Never set `development` on a real deploy.
- **SaaS needs `NEXT_PUBLIC_ATLAS_COOKIE_PREFIX=atlas-dev`** or admin routes bounce to login.
- **Plugins need explicit registration** in root `atlas.config.ts` (no glob/env discovery). Builtin datasources are seeded anyway.
- **Stale render = Turbopack stable-chunk cache** in `node_modules/.cache` + browser HTTP cache (survives tab close). `clean` + hard reload.
- **Verify both ports**; API health 503 ≠ down.
- **Tests:** if your shell exports `VERCEL_*` / `ATLAS_SANDBOX_URL`, run sandbox tests with them unset (`env -u VERCEL_TOKEN -u VERCEL_TEAM_ID -u VERCEL_PROJECT_ID -u ATLAS_SANDBOX_URL …`).
- **Stop via TaskStop, never `pkill`** (harness-task signal → exit 144).

See `docs/development/local-development.md` for the full runbook.
