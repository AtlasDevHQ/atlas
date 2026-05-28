# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Core Rules Checklist

**ALWAYS follow these rules when writing code:**

### Security (SQL)
- [ ] **SELECT only** — SQL validation blocks all DML/DDL. Never allow INSERT, UPDATE, DELETE, DROP, TRUNCATE, ALTER, etc.
- [ ] **Single statement** — No `;` chaining. One query per execution
- [ ] **AST validation** — All SQL parsed via `node-sql-parser` (PostgreSQL or MySQL mode, auto-detected). Regex guard is a first pass, not the only check. If the AST parser cannot parse a query, it is **rejected** (never silently skipped)
- [ ] **Table whitelist** — Only tables defined in `semantic/entities/*.yml` or `semantic/{source}/entities/*.yml` are queryable. `packages/api/src/lib/semantic/whitelist.ts` builds the allowed set. Schema-qualified queries (e.g. `schema.table`) require the qualified name in the whitelist
- [ ] **Auto LIMIT** — Every query gets a LIMIT appended. Default 1000, configurable via `ATLAS_ROW_LIMIT`
- [ ] **Statement timeout** — PostgreSQL and MySQL queries get a session-level timeout. Default 30s, configurable via `ATLAS_QUERY_TIMEOUT`

### Security (General)
- [ ] **Path traversal protection** — Each explore backend enforces read-only access scoped to `semantic/`
- [ ] **No secrets in responses** — Never expose connection strings, API keys, or stack traces to the user or agent
- [ ] **Readonly DB connections** — PostgreSQL uses read-only queries enforced by validation; MySQL uses a read-only session variable; ClickHouse uses `readonly: 1`
- [ ] **Encrypted at rest** — All new integration + datasource credentials use `encryptSecret` / `decryptSecret` from `db/secret-encryption.ts` (versioned `enc:v<N>:iv:authTag:ciphertext` AES-256-GCM). The legacy `db/internal.ts` helper pair (URL-aware passthrough) is reserved for two surviving columns — `workspace_model_config.api_key_encrypted` and `sso_providers.config.clientSecret`; no new call sites. Datasource URLs live in `workspace_plugins.config->>'url'` via selective-field encryption (`encryptSecretFields` / `decryptSecretFields`) keyed on the catalog row's `config_schema` `secret: true` flag. New credential table = one-line add to `INTEGRATION_TABLES` in `packages/api/src/lib/db/integration-tables.ts` + an `_encrypted` column in the migration. SaaS regions opt into `ATLAS_STRICT_PLUGIN_SECRETS=true` to reject plugin admin writes with corrupt/drifted schemas. Key derivation: `ATLAS_ENCRYPTION_KEYS` (versioned) → `ATLAS_ENCRYPTION_KEY` (legacy, treated as v1) → `BETTER_AUTH_SECRET` (deprecated under SaaS — startup warns). See [ADR-0005](docs/adr/0005-integration-credentials-table.md) and [ADR-0007](docs/adr/0007-unified-install-pipeline.md)
- [ ] **Explore tool isolation** — Default priority: plugin > Vercel sandbox > nsjail explicit > sidecar > nsjail auto-detect > just-bash (dev fallback). Override via `sandbox.priority` in `atlas.config.ts` or `ATLAS_SANDBOX_PRIORITY`. `ATLAS_SANDBOX=nsjail` is a hard-fail directive — if init fails, the API does not boot. **SaaS pins `["vercel-sandbox"]`** in `deploy/api/atlas.config.ts` (per-request Firecracker microVM with `networkPolicy: "deny-all"`). No fallback — a Vercel outage hard-fails rather than degrading to a less-isolated backend. Self-hosted defaults to sidecar (when `ATLAS_SANDBOX_URL` is set) or just-bash (dev). Off-Vercel hosts calling `@vercel/sandbox` need `VERCEL_TEAM_ID` / `VERCEL_PROJECT_ID` / `VERCEL_TOKEN` set **per-service** (Railway shared variables don't auto-inherit)
- [ ] **Twenty (and future per-tenant plugin) credentials never silently fall back to operator env vars** — `resolveWorkspaceCredentials` is DB-only in both deploy modes; `TWENTY_API_KEY` belongs to Atlas's own lead-capture pipeline in `ee/src/saas-crm/` and is reached via `resolveOperatorCredentials`. No plugin install — customer workspace, or Atlas's own team workspace — ever reads from env. Plugin installs go through `atlas.config.ts` or Admin → Integrations → Twenty. The `scripts/check-twenty-resolver-imports.sh` gate keeps the seam tight: only `ee/src/saas-crm/` (and the plugin's own source) may import `resolveOperatorCredentials`. See #2850

### Error Handling
- [ ] **Never silently swallow errors** — Every `catch` must log (`log.warn`/`console.debug`) or re-throw. Empty `catch {}` blocks are forbidden. If intentional, add `// intentionally ignored: <reason>`
- [ ] **Type-narrow caught errors** — Always `err instanceof Error ? err.message : String(err)`. Never access `.message` without guarding
- [ ] **Request IDs on all 500s** — Every 500 response includes `requestId` for log correlation
- [ ] **No generic error messages** — Replace "Something went wrong" with actionable, context-specific messages. Include retry guidance where appropriate
- [ ] **Prefer errors over silent fallbacks** — `catch { return false }` on a security check is a bug. Return 500, not a false negative

### Type Safety
- [ ] **No explicit `any`** — Use proper types or `unknown` with narrowing. Keep `any` only where unavoidable (third-party constraints) with `eslint-disable` + justification comment
- [ ] **Minimize non-null assertions** — Only use `!` when the value is provably non-null. Prefer optional chaining (`?.`) or explicit null checks

### Code Style
- [ ] **bun only** — Package manager and runtime. Never npm, yarn, or node
- [ ] **TypeScript strict mode** — Path aliases: `@atlas/api/*` for cross-package, `@/*` → `./src/*` within web only
- [ ] **Tailwind CSS 4** — Via `@tailwindcss/postcss`, not v3
- [ ] **shadcn/ui v2** — New-york style, neutral base, Lucide icons. **Always use shadcn/ui primitives** — never hand-roll equivalent components. Install: `bun x shadcn@latest add <component>` from `packages/web/`. Uses `cn()` from `@/lib/utils`
- [ ] **Server external packages** — `pg`, `mysql2`, `@clickhouse/client`, `@duckdb/node-api`, `snowflake-sdk`, `jsforce`, `just-bash`, `pino`, `pino-pretty`, `stripe` must stay in `serverExternalPackages` in the `create-atlas` template
- [ ] **Frontend is a pure HTTP client** — `@atlas/web` does NOT depend on `@atlas/api`. Shared types live in `@useatlas/types` and are re-exported via `packages/web/src/ui/lib/types.ts`
- [ ] **`lib/` must not import from `api/routes/`** — The data/helper layer (`src/lib/**`) stays above the Hono route layer (`src/api/**`). Inverted imports transitively pull auth/logger/middleware into every `lib/` consumer and break partial `mock.module()` mocks. Extract route-layer helpers to a new `lib/*.ts` module and re-export from the route layer (see `lib/mode.ts` ↔ `api/routes/middleware.ts`)
- [ ] **nuqs for URL state** — Use [nuqs](https://nuqs.47ng.com/) for URL state (pagination, filters, selected items). Define parsers in `search-params.ts` next to the page. Transient UI state stays as `useState`
- [ ] **zustand for cross-page UI state** — Use [zustand](https://zustand.docs.pmnd.rs/) for transient UI state that outlives a component but isn't URL-shareable (command menus, multi-step wizards, undo history). Stores live in `packages/web/src/lib/stores/<name>-store.ts`, consumed only from client components. Not for local state (`useState`), URL state (`nuqs`), or server state (`useAdminFetch`/TanStack Query)
- [ ] **React Compiler handles memoization** — Do not add `useMemo`, `useCallback`, or `React.memo` for performance. Only use `useMemo` for correctness (stable references), `React.memo` with custom comparators for semantic equality
- [ ] **No async waterfalls** — Use `Promise.all([a(), b()])` for independent awaits
- [ ] **Immutable array operations** — Use `toSorted()`, `toReversed()`, `toSpliced()` in React components
- [ ] **Dynamic imports for heavy components** — Use `next/dynamic` for Monaco, Recharts, syntax highlighters
- [ ] **Flat ESLint config** — `eslint.config.mjs`, not `.eslintrc`
- [ ] **`FeatureName` registry for admin surfaces** — `<MutationErrorSurface>`, `<EnterpriseUpsell>`, `<FeatureGate>`, `<AdminContentWrapper>`, `<ReasonDialog>` type their `feature` prop as `FeatureName` from `@/ui/components/admin/feature-registry`. Append the canonical name to `FEATURE_NAMES` first (casing matches banner copy — "SSO" not "sso"); consolidate duplicates rather than adding variants. `tsgo`-enforced source of truth for user-visible labels

### Database & Migrations
- [ ] **Drizzle schema mirrors every migration** — A new `packages/api/src/lib/db/migrations/####_*.sql` that creates or alters a table requires a matching `packages/api/src/lib/db/schema.ts` update **in the same PR** — mirror types, composite PKs (`primaryKey({ columns: [...] })`), indexes (`index` / `uniqueIndex`), CHECK constraints (`check("name", sql\`...\`)`). `scripts/check-schema-drift.sh` (part of `/ci`) fails on missing mirrors. Without it, the next `drizzle-kit generate` emits a `DROP TABLE` that wipes the table on deploy
- [ ] **DROP TABLE migrations are tracked separately** — `scripts/check-schema-drift.sh` excludes tables explicitly dropped by migrations (e.g. `mcp_tokens`, dropped by 0047). When you drop a table, remove its `pgTable` definition from `schema.ts` in the same commit and the drift check stays green
- [ ] **Real-Postgres migration smoke runs in CI** — `migrate-pg.test.ts` runs every migration end-to-end against `TEST_DATABASE_URL` (Postgres service container in api-tests). Catches SQL planning errors mock-pool tests can't see. To opt in locally: `bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas`. **Migrations referencing Better Auth tables (`user`, `session`, `organization`, `account`, `verification`) MUST be added to `MANAGED_AUTH_MIGRATIONS` in `packages/api/src/lib/db/internal.ts`** — the smoke test fails otherwise, keeping boot-time skip wiring in lockstep with the migration set

### Effect.ts (packages/api only)
- [ ] **Use Context.Tag for services** — All backend services use `class Foo extends Context.Tag("Foo")<Foo, FooShape>()`. Service interfaces are `FooShape` with `readonly` fields
- [ ] **Layer.effect vs Layer.scoped** — Use `Layer.scoped` when the service has a finalizer (cleanup on shutdown). Use `Layer.effect` for stateless services
- [ ] **Tagged errors via Data.TaggedError** — Never use plain `Error` subclasses with `_tag`. Use `Data.TaggedError("ErrorName")<{ ... }>` from Effect
- [ ] **runHandler for route handlers** — All route handlers use `runHandler(c, "label", async () => { ... })` which bridges Hono context → Effect Context and centralizes error-to-HTTP mapping
- [ ] **Effect test layers** — Use `createXxxTestLayer()` from `services.ts` or `__test-utils__/layers.ts` for tests. Prefer `Layer.provide` over `mock.module()` for new Effect-based tests. **Never mutate a registry / singleton at test module top-level** (`plugins.register(...)`, `connections.set(...)`, etc.) — that state survives across files sharing a bun worker under `bun test --parallel` (1.5.4 / #2796). Use `createPluginRegistryTestLayer()` / `createConnectionTestLayer()` to get a fresh scoped instance, or fall back to an explicit `afterAll(() => singleton._reset())` when the production code path reads the global singleton directly (see `mcp-boot.test.ts` for that pattern)
- [ ] **No `catch: (err) => err`** — In `Effect.tryPromise`, always normalize: `catch: (err) => err instanceof Error ? err : new Error(String(err))`
- [ ] **satisfies on service returns** — Always use `satisfies FooShape` on returned service objects for compile-time verification

### Testing
- [ ] **`bun run test`, never `bun test`** — Project uses isolated test runner (each file in its own subprocess). Always `bun run test` (or `test:api` / `test:others` / `test-isolated.ts --affected`). Single file is OK: `bun test path/to/file.test.ts`. Never bare `bun test` against a directory
- [ ] **Use `--affected` for local feedback loops** — `cd packages/api && bun run scripts/test-isolated.ts --affected` runs only tests whose source graph your branch touched vs `origin/main`. Use `--since HEAD~3` for last-N-commit windows. Typical PRs drop from 225s to 10–60s. Run the full `bun run test` before opening a PR. The runner throws loudly if the git detector can't resolve the base ref — don't ignore it
- [ ] **Pre-PR gates via `/ci`** — `/ci` runs lint + type + test + syncpack + template drift + railway-watch. All five must pass before opening a PR. In CI the api suite is sharded 4-way; locally it runs serial
- [ ] **Mock all exports** — When using `mock.module()`, mock every named export. Partial mocks cause `SyntaxError` in other files
- [ ] **Use shared mock factory** — Connection mocks use `createConnectionMock()` from `packages/api/src/__mocks__/connection.ts`. Don't create inline connection mocks
- [ ] **Effect test layers preferred** — For new tests, prefer `createConnectionTestLayer()` / `TestAppLayer` / `buildTestLayer()` from `packages/api/src/__test-utils__/layers.ts` over `mock.module()`. Composable Layers are type-safe and don't leak state between tests
- [ ] **Tests are self-contained** — No top-level `process.env.X = ...` or `process.chdir(...)` at module scope. The hoisted `??=` pattern IS permitted when an import-time env read requires the var to be set before the file's first import (see `actions.test.ts` for the template); `scripts/check-test-discipline.sh` (drift CI job) treats `??=` and `=` differently — only unconditional `=` is blocked. For path-typed test-owned vars (`ATLAS_SEMANTIC_ROOT = tmpRoot`), unconditional `=` is REQUIRED so a parent-env value doesn't break hermetic isolation. `mock.module()` does NOT need a paired `mock.restore()` — bun's `--isolate` resets module mocks between files. The custom `scripts/test-isolated.ts` subprocess-per-file runner is still in use until slice 6 (#2802) lands, because `--parallel` reuses workers across files so OS-level state (env, cwd, file handles, signal listeners) leaks

### Agent Tools
- [ ] **Tools return structured data** — `executeSQL` returns `{ columns, rows }`
- [ ] **Explore is read-only** — Only `ls`, `cat`, `grep`, `find` on `semantic/`. No writes, no shell escapes. Sandbox backend priority is documented once under **Security (General)** above — don't duplicate it here
- [ ] **Agent max steps** — `stopWhen: stepCountIs(getAgentMaxSteps())` in `streamText`. Default 25, configurable via `ATLAS_AGENT_MAX_STEPS` (range 1–100)
- [ ] **Semantic layer drives the agent** — Read entity YAMLs before writing SQL

### Semantic Layer
- [ ] **YAML format** — Entity files define columns, types, sample values, joins, virtual dimensions, measures, query patterns
- [ ] **Metrics are authoritative** — SQL in `metrics/*.yml` must be used exactly as written
- [ ] **Glossary terms** — Terms marked `ambiguous` in `glossary.yml` should trigger clarifying questions

### Content Mode System
- [ ] **New user-surfaced content tables opt into the mode system** — Any new table that holds content end-users see (prompts, connections, semantic entities, dashboards, reports, starter prompts, etc.) must include a `status` column with the `draft` / `published` / `archived` enum and a matching `CHECK` constraint. Default new rows to `draft` unless there's an explicit reason to bypass the pending-changes banner
- [ ] **Participate in mode resolution middleware** — Read handlers that expose the content to non-admins must gate by `status = 'published'`. Admin handlers in developer mode should overlay `status IN ('draft', 'published')` via the `ContentModeRegistry`. Effect-based routes `yield* ContentModeRegistry` and call `readFilter(table, mode, alias)`; non-Effect callers (e.g. `lib/db/internal.ts`) call `resolveStatusClause(table, mode, alias)` from `packages/api/src/lib/content-mode/port.ts` — the registry delegates to the same helper so semantics stay in lockstep. `resolveMode()` lives in `packages/api/src/api/routes/middleware.ts`. Write handlers must honor the caller's `atlasMode` when choosing the status value
- [ ] **Visible to the atomic publish endpoint** — `/api/v1/admin/publish` is the single place drafts become visible to everyone. A new content table must have its drafts promoted inside the existing transaction (phase 3 in `admin-publish.ts`), and its draft count surfaced in `/api/v1/mode` `draftCounts` so the banner stays accurate. Partial failure rolls every table back — never stamp a content table's drafts to published outside the publish transaction
- [ ] **Carve-outs must be explicit and justified** — A table that bypasses mode (e.g. `user_favorite_prompts`, where pins are per-user and must never be a shared-workspace draft) needs a comment explaining why in the schema file. If in doubt, opt in: retrofitting mode after launch is painful

### Plugin migrations
- [ ] **Update the chat-plugin × Atlas contract doc when the boundary changes** — Any PR that adds, removes, or reshapes a field at the `@useatlas/chat` / `@chat-adapter/*` boundary updates the table in `docs/architecture/chat-plugin-atlas-contract.md` in the same commit. Covers: new Atlas-extension fields on `chat_cache.value`; new host-callback wirings under `chatPlugin({ proactive: { ... } })`; new platforms moving from ○ pending to ✓ verified; read-site fail-loud changes. Before opening a PR that touches `plugins/chat/src/`, `packages/api/src/lib/slack/`, or `packages/api/src/lib/integrations/install/*-oauth-handler.ts`, diff the contract table against the change set. Open ⚠ rows are blockers for milestone closeout

### Enterprise & SaaS Gating (`/ee`)
- [ ] **SaaS-specific features go in `/ee`** — Any feature that exists specifically to make Atlas work as a hosted SaaS product (app.useatlas.dev) must live in `ee/src/` under the commercial license. This includes: deploy mode detection, SaaS admin UX branching, plugin marketplace, multi-tenant billing, platform admin tools, data residency routing, SLA monitoring, automated backups, PII masking, SSO/SCIM, approval workflows, abuse prevention, white-labeling
- [ ] **Self-hosted is always free** — Core AGPL never depends on `/ee`. Self-hosted gets the full product (agent, tools, admin, plugins via config); `/ee` adds governance, compliance, scale, polished SaaS UX. **The inversion is enforced.** Exactly one file in `packages/api/src/` is allowed to import from `@atlas/ee` — `lib/effect/enterprise-layer.ts` (boot-time composition via `await import("@atlas/ee/layers")`). `scripts/check-ee-imports.sh` (drift CI job) fails any other `@atlas/ee` import; the `ee-stub-build` job replaces `ee/` with a no-op stub and re-runs `bun run type` + `bun run build` to prove core compiles standalone. Every enterprise subsystem (residency, model routing, masking, approval, SLA, backups, audit retention, IP allowlist, SSO, SCIM, roles, branding, domains, proactive, deploy mode) is reachable via a `Context.Tag` in `lib/effect/services.ts` — `yield* TheTag`, never `await import("@atlas/ee/...")`
- [ ] **Read the enterprise flag through a Tag, not `isEnterpriseEnabled()` from `@atlas/ee`** — Core code never imports `isEnterpriseEnabled` from `@atlas/ee` (closeout grep gate rejects it). Branch on capability: `yield* TheTag` and let the `NoopXxxLayer` default short-circuit when EE isn't installed (e.g. `ProactiveGate.requireEnabled` yields `EnterpriseError`; `RolesPolicy.checkPermission` falls back to legacy admin/member mapping). For the rare value-level boolean (CLI helpers, `enterprise-layer.ts` itself), use `isEnterpriseEnabled()` from `packages/api/src/lib/effect/enterprise-config.ts` — the core mirror that doesn't import `@atlas/ee`. `requireEnterprise()` / `requireEnterpriseEffect()` are defined in `ee/src/index.ts` for use *inside ee/*; core uses `EnterpriseError` from `@atlas/api/lib/effect/errors` directly
- [ ] **Enterprise errors use `EnterpriseError`** — Always throw/catch `EnterpriseError`. Core imports it from `@atlas/api/lib/effect/errors`; `@atlas/ee` re-exports the same class for use *inside* `ee/`. Use `instanceof EnterpriseError`, never string matching. Route handlers map `EnterpriseError` to 403
- [ ] **`Tag.available` is for the 404 / shaped-success branch only** — When authoring a new enterprise Tag in `lib/effect/services.ts`, **omit** `readonly available: boolean` by default. The Noop layer's `Effect.fail(EnterpriseError(...))` + Hono 403 mapping is the canonical "feature unavailable" signal — routes don't need a flag. Add `available` only when a non-test consumer must branch into a *different* response shape than the 403 envelope: 404 `not_available`, a 200-with-empty-shape body, or a DB-skip short-circuit. Document the consumer(s) in the Tag's JSDoc so the next reviewer can confirm the flag is still load-bearing. Domain-specific boolean flags (`customRolesActive`, `enabled`, etc.) are not permitted — fold into `available` or surface via method return value. `DeployModeResolver` is the single sentinel-returning Tag (`"saas" | "self-hosted"` is the *value*) and that pattern is reserved for it
- [ ] **Deploy mode is enterprise-gated** — `ATLAS_DEPLOY_MODE=saas` requires `/ee`. Without enterprise enabled, deploy mode always resolves to `self-hosted`. The frontend reads `deployMode` from the API to branch admin UX
- [ ] **No competing SaaS** — The commercial license (`ee/LICENSE`) prohibits using `/ee` in a competing product. This is the business model: self-hosted is free (AGPL), the hosted SaaS and enterprise features are the commercial offering

### Merge discipline
- [ ] **Branch protection is on for `main`** — Required checks: `ci`, `api-tests (1/4)`–`(4/4)`, `Deploy Validation` (umbrella over Scaffold + Standalone + Config), `Analyze (javascript-typescript)`, `Symlink Stub Build` (the `ee-stub-build` job that enforces the core→ee inversion). `strict: true`, force-push/deletion blocked, `enforce_admins: false`. See `docs/development/branch-protection.md`
- [ ] **`prod` branch is a Railway-tracking artifact, not an integration branch** — Advanced only by `/release` via `git push origin <tag-sha>^{}:prod --force-with-lease`. No PRs target `prod`. Force-pushes allowed (required for the `--force-with-lease` semantic), deletions blocked, no required checks (the `/ci` gate already ran pre-tag). See `docs/development/branch-protection.md` § `prod` and [ADR-0008 § Release branches](docs/adr/0008-versioning-and-release-tags.md#release-branches-none)
- [ ] **Wait for the gate, never `--admin` through pending checks** — `gh pr merge` should be called only after `gh pr checks <PR> --watch` reports green on the head SHA being merged. The #2206 incident: PR #2198 was merged at 22:50:38Z while `ci` was still running; `ci` failed 19s later and broke Railway boot. Without protection there was no gate. With protection the merge is refused — never override
- [ ] **`--admin` is reserved for a broken gate, not a slow one** — The only legitimate use of `gh pr merge --admin` is when the required check itself is broken (e.g. GitHub-actions outage stuck in `queued`, or a check pinned to a SHA that no longer reflects the PR's content). Document the reason in the merge commit when you do override. "Tests are slow" is not a broken gate. "I'm impatient" is not a broken gate. If you're tempted to `--admin` because the check has been pending for an unusual amount of time, first verify the workflow run actually started and isn't stuck — only override after confirming the gate cannot complete
- [ ] **Required reviews are intentionally off** — Solo developer + parallel-claude workflow. Don't enable `required_pull_request_reviews` without rethinking the model

---

## Project Overview

**Atlas** — Deploy-anywhere text-to-SQL data analyst agent. Hono + Next.js + TypeScript + Effect.ts + Vercel AI SDK + bun.

### Versioning & releases

Three independent version trains, none coordinate. See [ADR-0008](docs/adr/0008-versioning-and-release-tags.md) for the full rules and [docs/development/release-process.md](docs/development/release-process.md) for the operational flow:

- **Git tags** (`v0.1.0`, `v0.2.0`, …) — release identifiers that gate prod deploys. Semver discipline: contract break → major (reserved for `v1.0.0`), customer-visible workflow change → minor, bug/perf/docs → patch, hotfix → tag immediately don't batch. No pre-release tags, no release branches. Annotated tags only (`git tag -a`). First public tag is `v0.1.0` (cut once the release-process bundle is ready — tag-cut is decoupled from the public launch announcement).
- **GitHub milestones** — tag-named going forward (`v0.2.0 — REST Datasources`). Only minor tags get milestones; patches don't. One non-tag milestone persists (`Architecture Backlog`). See [ADR-0009](docs/adr/0009-tag-organized-roadmap.md).
- **`@useatlas/*` npm packages** — independent semver per package. 0.0.x exact-pin rule (`^0.0.2` ≠ `0.0.3`) — see "Publishing `@useatlas/*` packages" below.

The shipped internal milestone `1.0.0 — SaaS Launch` (#24) is **not** the future git tag `v1.0.0`. Reference it as "internal milestone 1.0.0" to disambiguate. `v1.0.0` is reserved for the moment REST + MCP + plugin SDK contracts freeze.

The `/release` skill bundles `/ci` + annotated tag + push + `gh release create --generate-notes`. Customer-facing stability commitments live at [apps/docs/content/docs/reference/stability.mdx](apps/docs/content/docs/reference/stability.mdx).

**Operational rule:** when adding a new integration (chat platform, action target, datasource), create the staging app/credentials first — staging is the soak environment for tag-gated prod deploys. Don't OAuth-register a new platform straight against prod.

## Commands

```bash
bun install              # Install dependencies
bun run dev              # Containers + Hono API (:3001) + Next.js (:3000)
bun run dev:api          # Standalone Hono API
bun run dev:web          # Standalone Next.js
bun run build            # Production build
bun run lint             # ESLint
bun run type             # TypeScript type-check (tsgo --noEmit)
bun run test             # Full suite — @atlas/api then all other packages (isolated per-file)
bun run test:api         # Just @atlas/api tests (serial, full)
bun run test:others      # All other workspace test suites
# Fast local feedback loop — only tests whose source graph your branch touched:
cd packages/api && bun run scripts/test-isolated.ts --affected
cd packages/api && bun run scripts/test-isolated.ts --since HEAD~3     # last 3 commits
bun run db:up            # Start Postgres + sandbox sidecar
bun run db:down          # Stop containers
bun run db:reset         # Nuke volume + restart
bun run atlas -- init    # Profile DB, generate semantic layer
bun run atlas -- diff    # Compare DB schema vs semantic layer
```

### Operator subcommands (destructive)

The atlas-cli exposes a small operator surface for tenant-data ops. These were promoted from the gitignored `internal/` directory in #2635 so they're type-checked, unit-tested, and discoverable. All target the tenant DB at `ATLAS_TEAM_PG_URL` (falling back to `DATABASE_URL`).

```bash
bun run atlas -- proactive enable --workspace <id|slug> --channels <c1,c2>
bun run atlas -- proactive disable --workspace <id|slug>
bun run atlas -- seed prompts --workspace <id|slug> --library ./prompts/library.yml
bun run atlas -- seed workspace --workspace <id|slug> --group prod \
  --connections us-prod=US_DB_URL:postgres:primary,eu-prod=EU_DB_URL:postgres
# DESTRUCTIVE — TRUNCATE every public table (excluding migration bookkeeping):
ATLAS_WIPE_OK=1 bun run atlas -- ops wipe --confirm [--database-url <url>]
# One-shot: enqueue every demo_leads row into crm_outbox for dispatch to Twenty
# (idempotent — TwentyClient.upsertPerson dedupes by primary email):
bun run atlas -- ops backfill-crm-leads [--dry-run] [--batch-size 500] [--source demo]
```

The `ops wipe` subcommand is the only destructive one. It requires **both** `ATLAS_WIPE_OK=1` in the env **and** `--confirm` on the command line — the double-confirm gate is intentional. No backup is taken; wrap with `pg_dump` yourself for any data you might want back. Operates on one DB per invocation, so wiping multiple regional clusters means running it once per cluster (intentional — keeps the SQL surface testable).

One-shot migration backfills (already run on prod) live next to their migration in `packages/api/src/lib/db/migrations/scripts/` — see the README there.

**Quick start:** `bun install` → `cp .env.example .env` → `bun run db:up` → `bun run atlas -- init` → `bun run dev`. Dev admin: **admin@useatlas.dev / atlas-dev**.

## Architecture

### Packages

| Package | Name | Description |
|---------|------|-------------|
| `packages/types` | `@useatlas/types` | Shared TypeScript types (wire format) across API, web, SDK, and react |
| `packages/api` | `@atlas/api` | Hono API server, agent loop, tools, auth, DB |
| `packages/web` | `@atlas/web` | Next.js frontend, chat UI components (exports `./ui/context`, `./ui/components/atlas-chat`) |
| `packages/cli` | `@atlas/cli` | CLI: profiler, schema diff, enrichment, query |
| `packages/mcp` | `@atlas/mcp` | MCP server (stdio + SSE transport) |
| `packages/sandbox-sidecar` | `@atlas/sandbox-sidecar` | Isolated explore/python sidecar |
| `packages/sdk` | `@useatlas/sdk` | TypeScript SDK for Atlas API |
| `packages/react` | `@useatlas/react` | Embeddable React chat component + headless hooks |
| `packages/plugin-sdk` | `@useatlas/plugin-sdk` | Plugin type definitions + `definePlugin()` helper |
| `apps/www` | `@atlas/www` | Landing page (useatlas.dev) |
| `apps/docs` | `@atlas/docs` | Documentation site (Fumadocs) |
| `examples/docker` | — | Self-hosted Docker deploy + optional nsjail |
| `examples/nextjs-standalone` | — | Pure Next.js + embedded Hono API (Vercel) |
| `create-atlas` | `create-atlas-agent` | Scaffolding CLI (`bun create atlas-agent`) |
| `create-atlas-plugin` | `create-atlas-plugin` | Plugin scaffolding CLI (`bun create atlas-plugin`) |
| `ee/` | `@atlas/ee` | Enterprise features — source-available, commercial license |
| `plugins/` | — | Atlas plugins directory |

**Import conventions:**
- `@atlas/api` uses its own name: `@atlas/api/lib/agent`, `@atlas/api/lib/auth/types`
- `@atlas/web` uses tsconfig alias: `@/ui/context` → `./src/ui/context`
- Frontend never imports from `@atlas/api` — communicates over HTTP

### Agent Loop

```
POST /api/v1/chat → authenticateRequest → checkRateLimit → withRequestContext → validateEnvironment
    → runAgent(messages)  [or runAgentEffect → yield* AtlasAiModel]
    → streamText (AI SDK, ToolRegistry, stopWhen: stepCountIs(getAgentMaxSteps()))
        ├── explore → read semantic/*.yml (path-traversal protected)
        └── executeSQL → validate (4 layers) → query via ConnectionRegistry → { columns, rows }
    → Data Stream Response → Chat UI

Other routes use: runHandler(c, ...) → RequestContext + AuthContext provided via Effect bridge
```

`runAgentEffect` yields `AtlasAiModel` from Effect Context — testable with mock LLM via `createAiModelTestLayer()`.

### SQL Validation (4 layers)

0. Empty check → 1. Regex mutation guard → 2. AST parse (`node-sql-parser`, single SELECT) → 3. Table whitelist (semantic entities only, CTE names excluded)

Applied at execution: RLS injection (optional) → Auto LIMIT → Statement timeout

### Two-Database Architecture

1. **Analytics datasource** (`ATLAS_DATASOURCE_URL`) — User's data. Read-only. PostgreSQL or MySQL. Managed via `ConnectionRegistry` in `packages/api/src/lib/db/connection.ts`
2. **Internal database** (`DATABASE_URL`) — Atlas's own Postgres for auth, audit, settings. Optional. `packages/api/src/lib/db/internal.ts`

### Effect.ts Service Architecture

Backend services use Effect.ts for dependency injection, typed errors, and lifecycle management. All services live in `packages/api/src/lib/effect/`.

**Services (Context.Tag):**

| Service | Tag | File | What it provides |
|---------|-----|------|-----------------|
| `ConnectionRegistry` | `"ConnectionRegistry"` | `services.ts` | Analytics DB pools, health checks, metrics |
| `PluginRegistry` | `"PluginRegistry"` | `services.ts` | Plugin lifecycle, health checks |
| `RequestContext` | `"RequestContext"` | `services.ts` | `{ requestId, startTime }` per request |
| `AuthContext` | `"AuthContext"` | `services.ts` | `{ mode, user, orgId }` per request |
| `AtlasAiModel` | `"AtlasAiModel"` | `ai.ts` | Configured LLM (Vercel AI SDK LanguageModel) |
| `AtlasToolkit` | `"AtlasToolkit"` | `toolkit.ts` | Tool registry for agent loop |
| `AtlasSqlClient` | `"AtlasSqlClient"` | `sql.ts` | SQL query execution via Effect |
| `InternalDB` | `"InternalDB"` | `db/internal.ts` | Internal Postgres pool |
| `Telemetry` | `"Telemetry"` | `layers.ts` | OTel shutdown handle |
| `Config` | `"Config"` | `layers.ts` | Resolved atlas.config.ts |
| `Scheduler` | `"Scheduler"` | `layers.ts` | Scheduler backend lifecycle |

**Hono bridge:** `runHandler(c, "label", async () => { ... })` wraps every route handler. Automatically provides `RequestContext` + `AuthContext` from Hono context, centralizes error-to-HTTP mapping via `classifyError()`.

**Server startup:** `buildAppLayer(config)` composes independent startup Layers (telemetry, migrations, semantic sync, settings, scheduler) into a single Layer DAG. `ManagedRuntime.make(appLayer)` boots eagerly.

**Tagged errors:** Defined in `errors.ts` using `Data.TaggedError`. Exhaustive `mapTaggedError()` switch maps each to HTTP status. Compile-time completeness check via `ATLAS_ERROR_TAG_LIST`.

**Test utilities:** `packages/api/src/__test-utils__/layers.ts` provides `TestAppLayer`, `TestAdminLayer`, `TestPlatformLayer`, `runTest()`, `buildTestLayer()`. See `packages/api/src/api/routes/*` for live `yield*` patterns.

## Key Patterns

### Entity YAML

Entity files define columns, types, sample values, joins, virtual dimensions, measures, and query patterns. See `semantic/entities/*.yml` for live examples and `packages/api/src/lib/semantic/types.ts` for the schema.

### Database Connection

```typescript
import { getDB, connections } from "@atlas/api/lib/db/connection";
const db = getDB();
const { columns, rows } = await db.query("SELECT ...", 30000);
```

### Tool Registry

```typescript
import { ToolRegistry, defaultRegistry } from "@atlas/api/lib/tools/registry";
const custom = new ToolRegistry();
custom.register({ name: "myTool", description: "...", tool: myAISDKTool });
custom.freeze();
```

### Declarative Config

```typescript
// atlas.config.ts
import { defineConfig } from "@atlas/api/lib/config";
export default defineConfig({
  datasources: { default: { url: process.env.ATLAS_DATASOURCE_URL! } },
  tools: ["explore", "executeSQL"],
  auth: "auto",
  semanticLayer: "./semantic",
});
```

### Admin Page Hooks

Admin pages use two shared hooks — never hand-roll fetch/mutation logic in admin pages:

```typescript
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";

// Read data
const { data, loading, error, refetch } = useAdminFetch<T>("/api/v1/admin/...");

// Write data (POST/PUT/PATCH/DELETE)
const { mutate, saving, error } = useAdminMutation<T>({
  path: "/api/v1/admin/...",
  method: "POST",
  invalidates: refetch,  // auto-refetch after success
});
```

## Template Sync

`create-atlas/templates/nextjs-standalone/src/` is gitignored, regenerated by `create-atlas/scripts/prepare-templates.sh`. Never edit template `src/` files directly. CI runs `scripts/check-template-drift.sh` to verify.

### Publishing `@useatlas/*` packages

For `0.0.x` semver, `^0.0.2` pins EXACTLY to `0.0.2` — consumers won't get `0.0.3` automatically. When bumping a published package version:

1. **Feature PR** — bump `version` in the package's own `package.json` (e.g. `0.0.3` → `0.0.4`), but **keep** dependency refs in `sdk`, `react`, and template `package.json` files at the old version (`^0.0.3`)
2. **After merge** — tag the release (e.g. `git tag types-v0.0.4 && git push origin types-v0.0.4`). Wait for the publish workflow to complete
3. **Then bump refs** — push a follow-up commit updating `^0.0.3` → `^0.0.4` in `packages/sdk`, `packages/react`, and `create-atlas/templates/*/package.json`

**Why this order matters:** Deploy Validation scaffold jobs run `npm install` from the registry. If template refs point to an unpublished version, scaffolds fail. Sequencing the ref bump after publish avoids the race.

**Local gate against pre-publish drift:** `scripts/check-published-symbols.ts` (part of `/ci`) diffs braced **value** imports from `@useatlas/*` packages in scaffold-bound source (`packages/{api,cli,web,schemas}/src`, `ee/src`, `examples/nextjs-standalone/src`, `create-atlas/overrides`) against the symbols exported by the version `npm view` resolves for the range pinned in `create-atlas/templates/*/package.json`. Catches "I added a new export and used it before publishing" locally instead of in the CI Scaffold (docker)/(vercel) jobs. Type-only imports are skipped (they erase; the scaffold's `next build` runs with `ignoreBuildErrors: true`).

## Environment Variables

See `.env.example` for the full list with defaults and descriptions. Key vars: `ATLAS_PROVIDER`, `ATLAS_MODEL`, `ATLAS_DATASOURCE_URL`, `DATABASE_URL`, `ATLAS_AUTH_MODE`, `BETTER_AUTH_SECRET`.

## Agent skills

### Workflow

How Atlas commands (`/next`, `/tidy`, `/investigate`, `/kickoff`, `/closeout`, `/ci`, `/pr`) compose with the Matt Pocock engineering skills (`/diagnose`, `/tdd`, `/to-prd`, `/to-issues`, `/triage`, `/grill-with-docs`, `/improve-codebase-architecture`, `/zoom-out`, `/prototype`, `/handoff`). See `docs/agents/workflow.md`.

### Issue tracker

GitHub issues at `AtlasDevHQ/atlas` via the `gh` CLI (always with `-R AtlasDevHQ/atlas`). Every issue uses the Atlas body format (`## Key files / ## Acceptance criteria / ## Dependencies`) and carries labels on **two axes**: kind+location (`bug`/`feature`/… + `area: *`) AND triage state. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical defaults (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). Skill creates them lazily on first triage run. State labels are orthogonal to kind/area — both apply. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root. Neither exists yet; `/grill-with-docs` and `/teach-impeccable` produce them lazily. See `docs/agents/domain.md`.
