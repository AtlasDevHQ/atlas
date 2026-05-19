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
- [ ] **Encrypted at rest** — Bearer secrets in the internal DB go through one of two `encryptSecret` / `decryptSecret` helper pairs before write; both produce identical `enc:v<N>:iv:authTag:ciphertext` AES-256-GCM ciphertext, but their plaintext-detection differs and current call sites are split: (1) **`db/internal.ts`** (URL-aware passthrough on read — accepts `scheme://…` plaintext as-is, plus a 3-colon legacy fallback) is used for `connections.url`, `workspace_model_config.api_key_encrypted` (including the bedrock JSON cred bundle), and `sso_providers.config.clientSecret`; (2) **`db/secret-encryption.ts`** (versioned-prefix-only — anything without `enc:v<N>:` is treated as opaque plaintext) is used for every F-41 integration credential column (bot tokens, API keys, email/sandbox JSON blobs). New integration credential columns SHOULD default to the `db/secret-encryption.ts` pair — only use `db/internal.ts` when the column is a URL or you're matching one of the legacy call sites. Reads call `decryptSecret(<col>_encrypted)` directly — no plaintext fallback survives post-#1832. Adding a new integration credential table is a one-line addition to `INTEGRATION_TABLES` in `packages/api/src/lib/db/integration-tables.ts` (consumed by both rotation + the F-42 residue audit) plus an `_encrypted` column in the migration. Plugin config secrets use selective-field encryption inside the JSONB via `encryptSecretFields` / `decryptSecretFields` keyed on the catalog schema's `secret: true` flag; SaaS regions can opt into `ATLAS_STRICT_PLUGIN_SECRETS=true` to reject plugin admin writes whose schema is corrupt or carries secret/passthrough drift. `encryptUrl` / `decryptUrl` are `@deprecated` re-exports of the `db/internal.ts` pair, kept only so external SDK consumers pinned pre-#2285 keep working — slated for removal in 1.5.0; do not introduce new call sites. Key derivation: `ATLAS_ENCRYPTION_KEYS` (versioned, F-47) → `ATLAS_ENCRYPTION_KEY` (legacy single-key, treated as v1) → `BETTER_AUTH_SECRET` (deprecated under SaaS — startup warns)
- [ ] **Explore tool isolation** — Default priority: plugin > Vercel sandbox > nsjail explicit > sidecar > nsjail auto-detect > just-bash (dev fallback). Operators can override via `sandbox.priority` in `atlas.config.ts` or `ATLAS_SANDBOX_PRIORITY` env var. Plugin backends always take highest priority. When `ATLAS_SANDBOX_URL` is set, sidecar is the intended backend — nsjail auto-detection is skipped. `ATLAS_SANDBOX=nsjail` is a hard-fail directive — if init fails, the API does not boot. Remove the env var to allow the priority chain to fall through to auto-detect. **SaaS pins `["vercel-sandbox"]`** in `deploy/api/atlas.config.ts` — Vercel Sandbox exclusively (per-request Firecracker microVM with `networkPolicy: "deny-all"`). No fallback: a Vercel outage hard-fails the explore tool with a clear error rather than degrading to a less-isolated backend that can't enforce multi-tenant boundaries. Self-hosted defaults to sidecar (when `ATLAS_SANDBOX_URL` is set by `docker compose`) or just-bash (dev). Calling `@vercel/sandbox` from off-Vercel hosts (Railway) requires `VERCEL_TEAM_ID` / `VERCEL_PROJECT_ID` / `VERCEL_TOKEN` set **per-service** (Railway shared variables don't auto-inherit) — `useVercelSandbox()` returns true only when those are set (or on Vercel itself via OIDC)

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
- [ ] **`lib/` must not import from `api/routes/`** — Within `packages/api`, the data / helper layer (`src/lib/**`) must stay above the Hono route layer (`src/api/**`). Inverted imports transitively pull auth / logger / middleware into every `lib/` consumer and break pre-existing partial `mock.module()` mocks in unrelated tests. If a route-layer helper is needed in `lib/`, extract the pure function to a new `lib/*.ts` module and have the route layer re-export it (see `lib/mode.ts` ↔ `api/routes/middleware.ts`)
- [ ] **nuqs for URL state** — Use [nuqs](https://nuqs.47ng.com/) for URL state (pagination, filters, selected items). Define parsers in `search-params.ts` next to the page. Transient UI state stays as `useState`
- [ ] **zustand for cross-page UI state** — Use [zustand](https://zustand.docs.pmnd.rs/) for transient UI state that outlives a single component but isn't URL-shareable (e.g. global command menu open/close, multi-step wizard progress, undo history). Stores live under `packages/web/src/lib/stores/<name>-store.ts` and are consumed only from client components. Don't reach for it for local component state (`useState`), URL state (`nuqs`), or server state (`useAdminFetch`/TanStack Query)
- [ ] **React Compiler handles memoization** — Do not add `useMemo`, `useCallback`, or `React.memo` for performance. Only use `useMemo` for correctness (stable references), `React.memo` with custom comparators for semantic equality
- [ ] **No async waterfalls** — Use `Promise.all([a(), b()])` for independent awaits
- [ ] **Immutable array operations** — Use `toSorted()`, `toReversed()`, `toSpliced()` in React components
- [ ] **Dynamic imports for heavy components** — Use `next/dynamic` for Monaco, Recharts, syntax highlighters
- [ ] **Flat ESLint config** — `eslint.config.mjs`, not `.eslintrc`
- [ ] **`FeatureName` registry for admin surfaces** — `<MutationErrorSurface>`, `<EnterpriseUpsell>`, `<FeatureGate>`, `<AdminContentWrapper>`, and `<ReasonDialog>` type their `feature` prop as `FeatureName` from `@/ui/components/admin/feature-registry`. Adding a new admin surface means appending its canonical name to `FEATURE_NAMES` first — then TS guides every call site into agreement. Casing matches the banner copy ("SSO" not "sso"); consolidate duplicates rather than adding variants. The registry is the `tsgo`-enforced source of truth for user-visible feature labels — skip it and typos render in production upsells

### Database & Migrations
- [ ] **Drizzle schema mirrors every migration** — Adding a `packages/api/src/lib/db/migrations/####_*.sql` file that creates or alters a table requires a matching update to `packages/api/src/lib/db/schema.ts` **in the same PR**. Mirror SQL types, primary keys (composite via `primaryKey({ columns: [...] })`), indexes (`index` / `uniqueIndex`), and CHECK constraints (`check("name", sql\`...\`)`). CI runs `bash scripts/check-schema-drift.sh` and fails if a migration table is missing from `schema.ts`. Without the mirror, the next `drizzle-kit generate` emits a `DROP TABLE` that wipes the table on the next deploy. The drift check is part of `/ci`; never push a migration-only PR
- [ ] **DROP TABLE migrations are tracked separately** — `scripts/check-schema-drift.sh` excludes tables explicitly dropped by migrations (e.g. `mcp_tokens`, dropped by 0047). When you drop a table, remove its `pgTable` definition from `schema.ts` in the same commit and the drift check stays green
- [ ] **Real-Postgres migration smoke runs in CI** — `migrate-pg.test.ts` connects to `TEST_DATABASE_URL` (Postgres service container in the api-tests workflow) and runs every migration end-to-end. Catches SQL planning errors that mock-pool tests can't see. Skips locally when `TEST_DATABASE_URL` is unset; pass `bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas` to opt in. **Migrations that reference Better Auth tables (`user`, `session`, `organization`, `account`, `verification`) MUST be added to `MANAGED_AUTH_MIGRATIONS` in `packages/api/src/lib/db/internal.ts`** — the smoke test imports that list and fails when a migration references a Better Auth table without being skipped, so the boot-time skip wiring stays in lockstep with the migration set

### Effect.ts (packages/api only)
- [ ] **Use Context.Tag for services** — All backend services use `class Foo extends Context.Tag("Foo")<Foo, FooShape>()`. Service interfaces are `FooShape` with `readonly` fields
- [ ] **Layer.effect vs Layer.scoped** — Use `Layer.scoped` when the service has a finalizer (cleanup on shutdown). Use `Layer.effect` for stateless services
- [ ] **Tagged errors via Data.TaggedError** — Never use plain `Error` subclasses with `_tag`. Use `Data.TaggedError("ErrorName")<{ ... }>` from Effect
- [ ] **runHandler for route handlers** — All route handlers use `runHandler(c, "label", async () => { ... })` which bridges Hono context → Effect Context and centralizes error-to-HTTP mapping
- [ ] **Effect test layers** — Use `createXxxTestLayer()` from `services.ts` or `__test-utils__/layers.ts` for tests. Prefer `Layer.provide` over `mock.module()` for new Effect-based tests
- [ ] **No `catch: (err) => err`** — In `Effect.tryPromise`, always normalize: `catch: (err) => err instanceof Error ? err : new Error(String(err))`
- [ ] **satisfies on service returns** — Always use `satisfies FooShape` on returned service objects for compile-time verification

### Testing
- [ ] **`bun run test`, never `bun test`** — Project uses isolated test runner (each file in its own subprocess). Always `bun run test` (or `test:api` / `test:others` / `test-isolated.ts --affected`). Single file is OK: `bun test path/to/file.test.ts`. Never bare `bun test` against a directory
- [ ] **Use `--affected` for local feedback loops** — `cd packages/api && bun run scripts/test-isolated.ts --affected` runs only tests whose source graph your branch touched vs `origin/main`. Use `--since HEAD~3` for last-N-commit windows. Typical PRs drop from 225s to 10–60s. Run the full `bun run test` before opening a PR. The runner throws loudly if the git detector can't resolve the base ref — don't ignore it
- [ ] **Pre-PR gates via `/ci`** — `/ci` runs lint + type + test + syncpack + template drift + railway-watch. All five must pass before opening a PR. In CI the api suite is sharded 4-way; locally it runs serial
- [ ] **Mock all exports** — When using `mock.module()`, mock every named export. Partial mocks cause `SyntaxError` in other files
- [ ] **Use shared mock factory** — Connection mocks use `createConnectionMock()` from `packages/api/src/__mocks__/connection.ts`. Don't create inline connection mocks
- [ ] **Effect test layers preferred** — For new tests, prefer `createConnectionTestLayer()` / `TestAppLayer` / `buildTestLayer()` from `packages/api/src/__test-utils__/layers.ts` over `mock.module()`. Composable Layers are type-safe and don't leak state between tests

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

### Enterprise & SaaS Gating (`/ee`)
- [ ] **SaaS-specific features go in `/ee`** — Any feature that exists specifically to make Atlas work as a hosted SaaS product (app.useatlas.dev) must live in `ee/src/` under the commercial license. This includes: deploy mode detection, SaaS admin UX branching, plugin marketplace, multi-tenant billing, platform admin tools, data residency routing, SLA monitoring, automated backups, PII masking, SSO/SCIM, approval workflows, abuse prevention, white-labeling
- [ ] **Self-hosted is always free** — Core AGPL functionality must never depend on `/ee`. Self-hosted users get the full product (agent, tools, admin, plugins via config). The `/ee` gate adds governance, compliance, scale, and the polished SaaS experience. **The inversion is enforced.** Exactly one file in `packages/api/src/` is allowed to import from `@atlas/ee` — `lib/effect/enterprise-layer.ts`, the boot-time composition (`await import("@atlas/ee/layers")`). `scripts/check-ee-imports.sh` runs in the `drift` CI job and fails any PR that re-introduces a `@atlas/ee` import elsewhere; the `ee-stub-build` job replaces `ee/` with a no-op stub and re-runs `bun run type` + `bun run build` to prove core compiles standalone. Every enterprise subsystem (residency, model routing, masking, approval, SLA, backups, audit retention, IP allowlist, SSO, SCIM, roles, branding, domains, proactive, deploy mode) is reachable from core via a `Context.Tag` in `lib/effect/services.ts` — `yield* TheTag` from Effect Context, never `await import("@atlas/ee/...")`. See parent issue #2017 and the slice trail (#2563 → #2585) for the migration history.
- [ ] **Read the enterprise flag through a Tag, not `isEnterpriseEnabled()` from `@atlas/ee`** — Core code never imports `isEnterpriseEnabled` from `@atlas/ee` (the closeout grep gate rejects it). Branch on capability instead: `yield* TheTag` and let the `NoopXxxLayer` default short-circuit when EE isn't installed (e.g. `ProactiveGate.requireEnabled` yields `EnterpriseError` on self-hosted; `RolesPolicy.checkPermission` falls back to legacy admin/member mapping). For the rare case where a value-level boolean really is needed (e.g. inside `enterprise-layer.ts` itself, or a CLI helper), use `isEnterpriseEnabled()` from `packages/api/src/lib/effect/enterprise-config.ts` — the core copy that mirrors `ee/src/index.ts:isEnterpriseEnabled` without importing it. `requireEnterprise("feature")` / `requireEnterpriseEffect("feature")` are still defined in `ee/src/index.ts` for use *inside ee/*; core uses `EnterpriseError` from `@atlas/api/lib/effect/errors` directly
- [ ] **Enterprise errors use `EnterpriseError`** — Always throw/catch `EnterpriseError`. Core imports it from `@atlas/api/lib/effect/errors`; `@atlas/ee` re-exports the same class for use *inside* `ee/`. Use `instanceof EnterpriseError`, never string matching. Route handlers map `EnterpriseError` to 403
- [ ] **`Tag.available` is for the 404 / shaped-success branch only** — When you author a new enterprise Tag in `lib/effect/services.ts`, **omit** `readonly available: boolean` by default. The Noop layer's `Effect.fail(EnterpriseError(...))` plus the Hono bridge's 403 mapping is the canonical "feature unavailable" signal — routes don't need a flag to surface it. Add `available` only when at least one non-test consumer must branch into a *different* response shape than the 403 envelope: 404 `not_available` (e.g. `platform-sla.ts`, `platform-backups.ts`), a 200-with-empty-shape body (e.g. `admin-residency.ts` returning `{ configured: false, ... }`), or a DB-skip short-circuit (e.g. `lib/auth/scim-provenance.ts` returning `false` without querying). Document the consumer(s) in the Tag's JSDoc — "False when EE X is not loaded — `<route>` …" — so the next reviewer can confirm the flag is still load-bearing. The Tags that pass the bar today: `ResidencyResolver`, `ModelRouter`, `SlaMetrics`, `BackupsManager`, `IpAllowlistPolicy`, `SCIMProvenance`, `Domains`. Domain-specific boolean flags (`customRolesActive`, `enabled`, etc.) are not permitted — either fold the distinction into `available` or surface it through a method return value. `DeployModeResolver` is the single sentinel-returning Tag (`"saas" | "self-hosted"` is the *value*, not a flag) and that pattern is reserved for it
- [ ] **Deploy mode is enterprise-gated** — `ATLAS_DEPLOY_MODE=saas` requires `/ee`. Without enterprise enabled, deploy mode always resolves to `self-hosted`. The frontend reads `deployMode` from the API to branch admin UX
- [ ] **No competing SaaS** — The commercial license (`ee/LICENSE`) prohibits using `/ee` in a competing product. This is the business model: self-hosted is free (AGPL), the hosted SaaS and enterprise features are the commercial offering

### Merge discipline
- [ ] **Branch protection is on for `main`** — Required status checks: `ci`, `api-tests (1/4)`–`(4/4)`, `Deploy Validation` (umbrella over Scaffold + Standalone + Config), `Analyze (javascript-typescript)`, `Symlink Stub Build`. `strict: true` (branch must be up to date). Force-push and deletion blocked. `enforce_admins: false` so the override below works in genuine emergencies. The `Deploy Validation` umbrella exists because GitHub emits the un-substituted matrix template name (`Scaffold (${{ matrix.platform }})`) when an entire matrix job is skipped, breaking required-context name matching — `deploy-validation-required` (`if: always()`) collapses it. `Symlink Stub Build` is the `ee-stub-build` job — it replaces `ee/` with `scripts/ee-stub/` and re-runs `bun run type` + `bun run build` so any regression that re-introduces a `core → ee` import beyond `lib/effect/enterprise-layer.ts` fails the merge gate (the 1.5.1 architecture-deepening inversion is only meaningful if it's enforced). See `docs/development/branch-protection.md`
- [ ] **Wait for the gate, never `--admin` through pending checks** — `gh pr merge` should be called only after `gh pr checks <PR> --watch` reports green on the head SHA being merged. The #2206 incident: PR #2198 was merged at 22:50:38Z while `ci` was still running; `ci` failed 19s later and broke Railway boot. Without protection there was no gate. With protection the merge is refused — never override
- [ ] **`--admin` is reserved for a broken gate, not a slow one** — The only legitimate use of `gh pr merge --admin` is when the required check itself is broken (e.g. GitHub-actions outage stuck in `queued`, or a check pinned to a SHA that no longer reflects the PR's content). Document the reason in the merge commit when you do override. "Tests are slow" is not a broken gate. "I'm impatient" is not a broken gate. If you're tempted to `--admin` because the check has been pending for an unusual amount of time, first verify the workflow run actually started and isn't stuck — only override after confirming the gate cannot complete
- [ ] **Required reviews are intentionally off** — Solo developer + parallel-claude workflow. Don't enable `required_pull_request_reviews` without rethinking the model

---

## Project Overview

**Atlas** — Deploy-anywhere text-to-SQL data analyst agent. Hono + Next.js + TypeScript + Effect.ts + Vercel AI SDK + bun.

### Versioning

Internal milestones (v0.1–v1.0) track architectural progress. Public semver starts fresh post-v1.0 as beta `0.0.1`. Don't confuse internal milestones with public version numbers in user-facing copy.

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

**Test utilities:** `packages/api/src/__test-utils__/layers.ts` provides `TestAppLayer`, `TestAdminLayer`, `TestPlatformLayer`, `runTest()`, `buildTestLayer()`.

```typescript
// Yielding services in an Effect program
import { ConnectionRegistry, RequestContext, AuthContext } from "@atlas/api/lib/effect";

const program = Effect.gen(function* () {
  const { requestId } = yield* RequestContext;
  const { orgId } = yield* AuthContext;
  const registry = yield* ConnectionRegistry;
  const conn = registry.getForOrg(orgId!, "default");
  return yield* Effect.promise(() => conn.query("SELECT 1"));
});

// Running with test layers
import { runTest, TestAdminLayer } from "@atlas/api/src/__test-utils__/layers";
const result = await runTest(program, TestAdminLayer);
```

## Key Patterns

### Entity YAML

```yaml
# semantic/entities/table_name.yml
table: table_name
description: What this table contains
dimensions:
  - name: column_name
    sql: column_name
    type: string|number|date|boolean|timestamp
    description: What this column means
    sample_values: [value1, value2]
measures:
  - name: metric_name
    sql: COUNT(DISTINCT id)
    type: count_distinct|sum|avg|count
    description: What this measure calculates
joins:
  - name: to_other_table
    sql: table_name.col = other_table.col
    description: table_name.col → other_table.col
query_patterns:
  - name: pattern_name
    description: What this pattern does
    sql: SELECT ... FROM table_name ...
```

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
