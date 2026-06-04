# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Core Rules Checklist

**ALWAYS follow these rules when writing code:**

### Security (SQL)
- [ ] **SELECT only** — SQL validation blocks all DML/DDL. Never INSERT, UPDATE, DELETE, DROP, TRUNCATE, ALTER, etc.
- [ ] **Single statement** — No `;` chaining. One query per execution
- [ ] **AST validation** — All SQL parsed via `node-sql-parser` (PostgreSQL/MySQL, auto-detected). Regex guard is a first pass, not the only check. Unparseable queries are **rejected**, never silently skipped
- [ ] **Table whitelist** — Only tables from `semantic/entities/*.yml` or `semantic/{source}/entities/*.yml` are queryable (`packages/api/src/lib/semantic/whitelist.ts`). Schema-qualified queries need the qualified name in the whitelist
- [ ] **Auto LIMIT** — Every query gets a LIMIT appended. Default 1000, via `ATLAS_ROW_LIMIT`
- [ ] **Statement timeout** — PostgreSQL/MySQL get a session-level timeout. Default 30s, via `ATLAS_QUERY_TIMEOUT`

### Security (General)
- [ ] **Path traversal protection** — Each explore backend enforces read-only access scoped to `semantic/`
- [ ] **No secrets in responses** — Never expose connection strings, API keys, or stack traces to the user or agent
- [ ] **Readonly DB connections** — PostgreSQL via validation; MySQL via read-only session variable; ClickHouse via `readonly: 1`
- [ ] **Encrypted at rest** — New integration + datasource credentials use `encryptSecret` / `decryptSecret` from `db/secret-encryption.ts` (versioned AES-256-GCM). New credential table = one-line add to `INTEGRATION_TABLES` in `db/integration-tables.ts` + an `_encrypted` column. Datasource URLs use selective-field encryption (`encryptSecretFields`) keyed on the `config_schema` `secret: true` flag. The legacy `db/internal.ts` passthrough is frozen to two columns — no new call sites. See [ADR-0005](docs/adr/0005-integration-credentials-table.md), [ADR-0007](docs/adr/0007-unified-install-pipeline.md)
- [ ] **Explore tool isolation** — Default priority: plugin > Vercel sandbox > nsjail explicit > sidecar > nsjail auto-detect > just-bash (dev). Override via `sandbox.priority` or `ATLAS_SANDBOX_PRIORITY`; `ATLAS_SANDBOX=nsjail` is hard-fail (API won't boot if init fails). **SaaS pins `["vercel-sandbox"]`** in `deploy/api/atlas.config.ts` (`networkPolicy: "deny-all"`, no fallback). Off-Vercel hosts calling `@vercel/sandbox` need `VERCEL_TEAM_ID` / `VERCEL_PROJECT_ID` / `VERCEL_TOKEN` set **per-service** (Railway shared vars don't auto-inherit)
- [ ] **Per-tenant plugin creds never fall back to operator env vars** — `resolveWorkspaceCredentials` is DB-only in both deploy modes. `TWENTY_API_KEY` belongs to Atlas's own lead-capture pipeline (`ee/src/saas-crm/`) via `resolveOperatorCredentials`. No plugin install (customer or Atlas's own team workspace) ever reads from env — installs go through `atlas.config.ts` or Admin → Integrations. `scripts/check-twenty-resolver-imports.sh` keeps the seam tight. See #2850

### Error Handling
- [ ] **Never silently swallow errors** — Every `catch` must log (`log.warn`/`console.debug`) or re-throw. Empty `catch {}` forbidden. If intentional: `// intentionally ignored: <reason>`
- [ ] **Type-narrow caught errors** — Always `err instanceof Error ? err.message : String(err)`. Never access `.message` unguarded
- [ ] **Request IDs on all 500s** — Every 500 response includes `requestId` for log correlation
- [ ] **No generic error messages** — Replace "Something went wrong" with actionable, context-specific messages + retry guidance
- [ ] **Prefer errors over silent fallbacks** — `catch { return false }` on a security check is a bug. Return 500, not a false negative

### Type Safety
- [ ] **No explicit `any`** — Use proper types or `unknown` with narrowing. `any` only where unavoidable (third-party) with `eslint-disable` + justification
- [ ] **Minimize non-null assertions** — Only `!` when provably non-null. Prefer `?.` or explicit null checks

### Code Style
- [ ] **bun only** — Package manager and runtime. Never npm, yarn, or node
- [ ] **TypeScript strict mode** — Path aliases: `@atlas/api/*` cross-package, `@/*` → `./src/*` within web only
- [ ] **Tailwind CSS 4** — Via `@tailwindcss/postcss`, not v3
- [ ] **shadcn/ui v2** — New-york style, neutral base, Lucide icons. **Always use shadcn/ui primitives** — never hand-roll. Install: `bun x shadcn@latest add <component>` from `packages/web/`. Uses `cn()` from `@/lib/utils`
- [ ] **Server external packages** — `pg`, `mysql2`, `@clickhouse/client`, `@duckdb/node-api`, `snowflake-sdk`, `jsforce`, `just-bash`, `pino`, `pino-pretty`, `stripe` must stay in `serverExternalPackages` in the `create-atlas` template
- [ ] **Frontend is a pure HTTP client** — `@atlas/web` does NOT depend on `@atlas/api`. Shared types live in `@useatlas/types` (wire types) and `@useatlas/schemas` (Zod validation), re-exported via `packages/web/src/ui/lib/types.ts`
- [ ] **`lib/` must not import from `api/routes/`** — The data/helper layer (`src/lib/**`) stays above the Hono route layer (`src/api/**`). Inverted imports pull auth/logger/middleware into every `lib/` consumer and break partial `mock.module()` mocks. Extract route helpers to a `lib/*.ts` module (see `lib/mode.ts` ↔ `api/routes/middleware.ts`)
- [ ] **nuqs for URL state** — [nuqs](https://nuqs.47ng.com/) for pagination, filters, selected items. Parsers in `search-params.ts` next to the page. Transient UI state stays `useState`
- [ ] **zustand for cross-page UI state** — [zustand](https://zustand.docs.pmnd.rs/) for transient state that outlives a component but isn't URL-shareable (command menus, wizards, undo). Stores in `packages/web/src/lib/stores/<name>-store.ts`, client components only. Not for local (`useState`), URL (`nuqs`), or server state (`useAdminFetch`)
- [ ] **React Compiler handles memoization** — No `useMemo`/`useCallback`/`React.memo` for performance. `useMemo` only for correctness (stable refs); `React.memo` w/ custom comparator for semantic equality
- [ ] **No async waterfalls** — `Promise.all([a(), b()])` for independent awaits
- [ ] **Immutable array operations** — `toSorted()`, `toReversed()`, `toSpliced()` in React components
- [ ] **Dynamic imports for heavy components** — `next/dynamic` for Monaco, Recharts, syntax highlighters
- [ ] **Flat ESLint config** — `eslint.config.mjs`, not `.eslintrc`
- [ ] **`FeatureName` registry for admin surfaces** — `<MutationErrorSurface>`, `<EnterpriseUpsell>`, `<FeatureGate>`, `<AdminContentWrapper>`, `<ReasonDialog>` type `feature` as `FeatureName` from `@/ui/components/admin/feature-registry`. Append the canonical name to `FEATURE_NAMES` first (casing matches banner copy — "SSO" not "sso"); consolidate duplicates. `tsgo`-enforced

### Database & Migrations
- [ ] **Drizzle schema mirrors every migration** — A new `db/migrations/####_*.sql` that creates/alters a table needs a matching `db/schema.ts` update **in the same PR** — mirror types, composite PKs, indexes, CHECK constraints. `scripts/check-schema-drift.sh` (in `/ci`) fails on missing mirrors; without it, the next `drizzle-kit generate` emits a `DROP TABLE` that wipes the table on deploy
- [ ] **DROP TABLE migrations tracked separately** — `check-schema-drift.sh` excludes tables explicitly dropped by migrations (e.g. `mcp_tokens`, dropped by 0047). When you drop a table, remove its `pgTable` from `schema.ts` in the same commit
- [ ] **Two-phase drop discipline for `DROP TABLE`/`DROP COLUMN`** — stop reading/writing the object in release N, drop it in release N+1, so the N-1↔N deploy-overlap window can never `relation/column does not exist`. Rationale + expand-contract checklist: [packages/api/src/lib/db/migrations/README.md](packages/api/src/lib/db/migrations/README.md)
- [ ] **Real-Postgres migration smoke runs in CI** — `migrate-pg.test.ts` runs every migration against `TEST_DATABASE_URL`; Better-Auth-dependent migrations must join `MANAGED_AUTH_MIGRATIONS` in `db/internal.ts`. See [docs/development/testing.md](docs/development/testing.md)

### Effect.ts (packages/api only)
- [ ] **Use Context.Tag for services** — `class Foo extends Context.Tag("Foo")<Foo, FooShape>()`. Interfaces are `FooShape` with `readonly` fields
- [ ] **Layer.effect vs Layer.scoped** — `Layer.scoped` when the service has a finalizer (cleanup on shutdown); `Layer.effect` for stateless
- [ ] **Tagged errors via Data.TaggedError** — Never plain `Error` subclasses with `_tag`. Use `Data.TaggedError("ErrorName")<{ ... }>`
- [ ] **runHandler for route handlers** — `runHandler(c, "label", async () => { ... })` bridges Hono → Effect Context and centralizes error-to-HTTP mapping
- [ ] **No `catch: (err) => err`** — In `Effect.tryPromise`, always normalize: `catch: (err) => err instanceof Error ? err : new Error(String(err))`
- [ ] **satisfies on service returns** — Always `satisfies FooShape` on returned service objects
- [ ] **Effect test layers + no top-level singleton mutation** — Prefer `Layer.provide` test layers over `mock.module()`; never mutate a registry/singleton at test module top-level. See [docs/development/testing.md](docs/development/testing.md)

### Testing
- [ ] **`bun run test`, never bare `bun test`** — Isolated per-file runner. Single file OK: `bun test path/to/file.test.ts`. Never bare `bun test` against a directory
- [ ] **Use `--affected` for local loops** — `cd packages/api && bun run scripts/test-isolated.ts --affected`. Run full `bun run test` before a PR
- [ ] **Pre-PR gates via `/ci`** — lint + type + test + syncpack + template drift + railway-watch. All must pass
- [ ] **Mock all exports** when using `mock.module()`; use `createConnectionMock()` for connection mocks (never inline)
- [ ] **Tests are self-contained** — No top-level `process.env.X =` or `process.chdir(...)`; `??=` hoist permitted for import-time env reads
- Full rationale, gotchas, and the `??=` vs `=` discipline: [docs/development/testing.md](docs/development/testing.md)

### Agent Tools
- [ ] **Tools return structured data** — `executeSQL` returns `{ columns, rows }`
- [ ] **Explore is read-only** — Only `ls`, `cat`, `grep`, `find` on `semantic/`. No writes, no shell escapes. Sandbox priority documented under **Security (General)** above
- [ ] **Agent max steps** — `stopWhen: stepCountIs(getAgentMaxSteps())`. Default 25, via `ATLAS_AGENT_MAX_STEPS` (1–100)
- [ ] **Semantic layer drives the agent** — Read entity YAMLs before writing SQL

### Semantic Layer
- [ ] **YAML format** — Entity files define columns, types, sample values, joins, virtual dimensions, measures, query patterns
- [ ] **Metrics are authoritative** — SQL in `metrics/*.yml` must be used exactly as written
- [ ] **Glossary terms** — Terms marked `ambiguous` in `glossary.yml` should trigger clarifying questions

### Content Mode System
Schema requirements, mode-resolution middleware, the atomic publish endpoint, and carve-out rules: [docs/development/content-mode.md](docs/development/content-mode.md).
- [ ] **New user-surfaced content tables opt into mode** — Add a `status` column (`draft`/`published`/`archived` enum + `CHECK`), default `draft`. Gate non-admin reads by `status = 'published'`; admin/dev-mode overlays `status IN ('draft','published')` via `ContentModeRegistry` (`readFilter`) or `resolveStatusClause` for non-Effect callers
- [ ] **Promote only via the atomic publish endpoint** — `/api/v1/admin/publish` is the single place drafts go live: promote inside its transaction (phase 3, `admin-publish.ts`) and surface the count in `/api/v1/mode` `draftCounts`. Never stamp drafts to published outside it. Carve-outs (e.g. `user_favorite_prompts`) need a schema comment explaining why

### Plugin migrations
- [ ] **Update the chat-plugin × Atlas contract doc when the boundary changes** — Any PR that adds/removes/reshapes a field at the `@useatlas/chat` / `@chat-adapter/*` boundary updates the table in [docs/architecture/chat-plugin-atlas-contract.md](docs/architecture/chat-plugin-atlas-contract.md) in the same commit. Before a PR touching `plugins/chat/src/`, `packages/api/src/lib/slack/`, or `integrations/install/*-oauth-handler.ts`, diff the contract table; open ⚠ rows block milestone closeout

### Enterprise & SaaS Gating (`/ee`)
Full rationale, enforcement mechanics, and the drift-checked `Tag.available` membership list: [docs/development/enterprise-gating.md](docs/development/enterprise-gating.md).
- [ ] **SaaS-specific features go in `/ee`** — Anything that exists specifically to make Atlas a hosted SaaS (deploy-mode detection, marketplace, billing, residency, masking, SSO/SCIM, approvals, backups, white-labeling) lives in `ee/src/` under the commercial license
- [ ] **Self-hosted is always free; the inversion is enforced** — Core AGPL never depends on `/ee`. Exactly one file (`lib/effect/enterprise-layer.ts`) may import `@atlas/ee`; `scripts/check-ee-imports.sh` + `ee-stub-build` enforce it. Every subsystem is reachable via a `Context.Tag` in `lib/effect/services.ts`
- [ ] **Read the enterprise flag through a Tag** — `yield* TheTag` and let the `NoopXxxLayer` short-circuit. Never import `isEnterpriseEnabled` from `@atlas/ee` in core; value-level checks use the core mirror in `lib/effect/enterprise-config.ts`
- [ ] **Enterprise errors use `EnterpriseError`** — from `@atlas/api/lib/effect/errors`. Use `instanceof`, never string matching. Routes map it to 403
- [ ] **`Tag.available` is for the 404 / shaped-success branch only** — Omit by default; add only when a consumer needs a different response shape than the 403 envelope. Membership list is drift-checked — see the doc
- [ ] **Deploy mode is enterprise-gated** — `ATLAS_DEPLOY_MODE=saas` requires `/ee`; otherwise resolves to `self-hosted`. The commercial license prohibits using `/ee` in a competing product

### Merge discipline
Full rationale + override rules: [docs/development/branch-protection.md](docs/development/branch-protection.md).
- [ ] **Branch protection is on for `main`** — Required checks: `ci`, `api-tests (1/4)`–`(4/4)`, `Deploy Validation`, `Analyze (javascript-typescript)`, `Symlink Stub Build`. `strict: true`, force-push/deletion blocked, `enforce_admins: false`
- [ ] **`prod` is a Railway-tracking artifact, not an integration branch** — Advanced only by `/release` (`git push origin <tag-sha>^{}:prod --force-with-lease`). No PRs target `prod`. See [ADR-0008 § Release branches](docs/adr/0008-versioning-and-release-tags.md#release-branches-none)
- [ ] **Wait for the gate; `--admin` is for a broken gate, not a slow one** — Merge only after `gh pr checks <PR> --watch` is green on the head SHA. The only legitimate `--admin` is a genuinely broken required check (verify the run isn't merely stuck first); document the reason in the merge commit. "Tests are slow"/"I'm impatient" don't qualify (#2206)
- [ ] **Required reviews are intentionally off** — Solo dev + parallel-claude workflow. Don't enable without rethinking the model

---

## Project Overview

**Atlas** — Deploy-anywhere text-to-SQL data analyst agent. Hono + Next.js + TypeScript + Effect.ts + Vercel AI SDK + bun.

### Versioning & releases

Three independent version trains, none coordinate. See [ADR-0008](docs/adr/0008-versioning-and-release-tags.md) + [docs/development/release-process.md](docs/development/release-process.md):

- **Git tags** (`v0.0.1`, `v0.0.2`, …) — gate prod deploys. Semver: contract break → major (reserved for `v1.0.0`), customer-visible change → minor, bug/perf/docs → patch, hotfix → tag immediately. Annotated only (`git tag -a`). The train starts at `v0.0.1` (pre-launch dev train; patch position banks dev milestones); `v0.1.0` is **reserved for the public launch** (July 2026, #2919)
- **GitHub milestones** — tag-named (`v0.0.2 — REST Datasources`). One non-tag milestone persists (`Architecture Backlog`). See [ADR-0009](docs/adr/0009-tag-organized-roadmap.md)
- **`@useatlas/*` npm packages** — independent semver per package. `0.0.x` exact-pin rule (`^0.0.2` ≠ `0.0.3`) — see *Publishing* below

The shipped internal milestone `1.0.0 — SaaS Launch` (#24) is **not** the future git tag `v1.0.0` — call it "internal milestone 1.0.0". `v1.0.0` is reserved for when REST + MCP + plugin SDK contracts freeze.

`/release` bundles `/ci` + a per-tag docs-changelog entry (`apps/docs/src/components/changelog-data.ts` `releases[]`) + annotated tag + push + `gh release create`. The changelog is a per-tag feed, **not** banked for `v0.1.0` ([ADR-0008 amendment](docs/adr/0008-versioning-and-release-tags.md)). Stability commitments: [apps/docs/content/docs/reference/stability.mdx](apps/docs/content/docs/reference/stability.mdx).

**Operational rule:** when adding a new integration (chat platform, action target, datasource), create the staging app/credentials first — staging is the soak environment. Don't OAuth-register a new platform straight against prod.

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

**Quick start:** `bun install` → `cp .env.example .env` → `bun run db:up` → `bun run atlas -- init` → `bun run dev`. Dev admin: **admin@useatlas.dev / atlas-dev**.

### Operator subcommands (destructive)

The atlas-cli exposes a tenant-data operator surface (promoted from the gitignored `internal/` in #2635). All target the tenant DB at `ATLAS_TEAM_PG_URL` (falling back to `DATABASE_URL`).

```bash
bun run atlas -- proactive enable --workspace <id|slug> --channels <c1,c2>
bun run atlas -- proactive disable --workspace <id|slug>
bun run atlas -- seed prompts --workspace <id|slug> --library ./prompts/library.yml
bun run atlas -- seed workspace --workspace <id|slug> --group prod \
  --connections us-prod=US_DB_URL:postgres:primary,eu-prod=EU_DB_URL:postgres
# DESTRUCTIVE — TRUNCATE every public table (excluding migration bookkeeping):
ATLAS_WIPE_OK=1 bun run atlas -- ops wipe --confirm [--database-url <url>]
# One-shot: enqueue every demo_leads row into crm_outbox for dispatch to Twenty:
bun run atlas -- ops backfill-crm-leads [--dry-run] [--batch-size 500] [--source demo]
# Local-only E2E check of the demo→Twenty lead pipeline (below Turnstile, via the outbox):
bun run atlas -- ops smoke-crm --personas <path> [--wipe-twenty] [--twenty-base-url <url>] \
  [--twenty-api-key <key>] [--timeout-seconds 60] [--database-url <url>]
```

`ops wipe` is the only subcommand that wipes the tenant DB: requires **both** `ATLAS_WIPE_OK=1` **and** `--confirm` (intentional double-gate). No backup is taken — wrap with `pg_dump` yourself. Operates on one DB per invocation. `ops smoke-crm` is a local-only (never-in-CI) end-to-end verification of the demo→Twenty lead-capture pipeline; its optional `--wipe-twenty` phase clears the Twenty workspace and is double-gated by `ATLAS_SMOKE_WIPE_OK=1`. One-shot migration backfills live next to their migration in `db/migrations/scripts/`.

## Architecture

### Packages

| Package | Name | Description |
|---------|------|-------------|
| `packages/types` | `@useatlas/types` | Shared TypeScript types (wire format) across API, web, SDK, react |
| `packages/schemas` | `@useatlas/schemas` | Shared Zod schemas (wire format) — SSOT for API route validation + web response parsing |
| `packages/api` | `@atlas/api` | Hono API server, agent loop, tools, auth, DB |
| `packages/web` | `@atlas/web` | Next.js frontend, chat UI (exports `./ui/context`, `./ui/components/atlas-chat`) |
| `packages/cli` | `@atlas/cli` | CLI: profiler, schema diff, enrichment, query |
| `packages/mcp` | `@atlas/mcp` | MCP server (stdio + SSE transport) |
| `packages/oauth-helper` | `@atlas/oauth-helper` | Internal OAuth 2.1 + DCR + PKCE primitives shared by sdk + mcp (not published) |
| `packages/sandbox-sidecar` | `@atlas/sandbox-sidecar` | Isolated explore/python sidecar |
| `packages/sdk` | `@useatlas/sdk` | TypeScript SDK for Atlas API |
| `packages/react` | `@useatlas/react` | Embeddable React chat component + headless hooks |
| `packages/plugin-sdk` | `@useatlas/plugin-sdk` | Plugin type definitions + `definePlugin()` |
| `apps/www` | `@atlas/www` | Landing page (useatlas.dev) |
| `apps/docs` | `@atlas/docs` | Documentation site (Fumadocs) |
| `examples/docker` | — | Self-hosted Docker deploy + optional nsjail |
| `examples/nextjs-standalone` | — | Pure Next.js + embedded Hono API (Vercel) |
| `examples/embedded-mcp-onboarding` | — | Embedded Atlas MCP onboarding flow example |
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

Other routes use: runHandler(c, ...) → RequestContext + AuthContext via Effect bridge
```

`runAgentEffect` yields `AtlasAiModel` from Effect Context — testable with a mock LLM via `createAiModelTestLayer()`.

### SQL Validation (4 layers)

0. Empty check → 1. Regex mutation guard → 2. AST parse (`node-sql-parser`, single SELECT) → 3. Table whitelist (semantic entities only, CTE names excluded)

Applied at execution: RLS injection (optional) → Auto LIMIT → Statement timeout

### Two-Database Architecture

1. **Analytics datasource** (`ATLAS_DATASOURCE_URL`) — User's data. Read-only. PostgreSQL/MySQL. Via `ConnectionRegistry` in `db/connection.ts`
2. **Internal database** (`DATABASE_URL`) — Atlas's own Postgres for auth, audit, settings. Optional. `db/internal.ts`

### Effect.ts Service Architecture

Backend services use Effect.ts for DI, typed errors, and lifecycle. All live in `packages/api/src/lib/effect/`.

| Service | Tag | File | Provides |
|---------|-----|------|----------|
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

- **Hono bridge:** `runHandler(c, "label", async () => { ... })` wraps every route handler — provides `RequestContext` + `AuthContext`, centralizes error-to-HTTP via `classifyError()`
- **Startup:** `buildAppLayer(config)` composes startup Layers (telemetry, migrations, semantic sync, settings, scheduler) into one DAG; `ManagedRuntime.make(appLayer)` boots eagerly
- **Tagged errors:** in `errors.ts` via `Data.TaggedError`; exhaustive `mapTaggedError()` switch maps each to HTTP status (compile-time check via `ATLAS_ERROR_TAG_LIST`)
- **Test utilities:** `__test-utils__/layers.ts` provides `TestAppLayer`, `TestAdminLayer`, `TestPlatformLayer`, `runTest()`, `buildTestLayer()`

## Key Patterns

### Entity YAML
Entity files define columns, types, sample values, joins, virtual dimensions, measures, query patterns. See `semantic/entities/*.yml` and `packages/api/src/lib/semantic/types.ts`.

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
Admin pages use two shared hooks — never hand-roll fetch/mutation logic:
```typescript
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";

const { data, loading, error, refetch } = useAdminFetch<T>("/api/v1/admin/...");
const { mutate, saving, error } = useAdminMutation<T>({
  path: "/api/v1/admin/...", method: "POST", invalidates: refetch,
});
```

## Template Sync

`create-atlas/templates/nextjs-standalone/src/` is gitignored, regenerated by `create-atlas/scripts/prepare-templates.sh`. Never edit template `src/` directly. CI runs `scripts/check-template-drift.sh`.

### Publishing `@useatlas/*` packages

For `0.0.x` semver, `^0.0.2` pins EXACTLY to `0.0.2`. When bumping a published package, **sequence the ref bump after publish** or Deploy Validation scaffolds fail (`npm install` hits the registry):

1. **Feature PR** — bump `version` in the package's own `package.json`, but **keep** dependency refs in `sdk`/`react`/templates at the old version
2. **After merge** — tag the release (`git tag types-v0.0.4 && git push origin types-v0.0.4`); wait for the publish workflow
3. **Then** push a follow-up bumping refs in `packages/sdk`, `packages/react`, `create-atlas/templates/*/package.json`

`scripts/check-published-symbols.ts` (in `/ci`) catches "added a new export and used it before publishing" locally — it diffs braced **value** imports from `@useatlas/*` in scaffold-bound source against the symbols exported by the pinned published version. Type-only imports are skipped.

## Environment Variables

See `.env.example` for the full list. Key vars: `ATLAS_PROVIDER`, `ATLAS_MODEL`, `ATLAS_DATASOURCE_URL`, `DATABASE_URL`, `ATLAS_AUTH_MODE`, `BETTER_AUTH_SECRET`.

## Agent skills

- **Workflow** — how Atlas commands (`/next`, `/tidy`, `/investigate`, `/kickoff`, `/closeout`, `/ci`, `/pr`) compose with the Matt Pocock skills (`/diagnose`, `/tdd`, `/to-prd`, `/to-issues`, `/triage`, `/grill-with-docs`, `/improve-codebase-architecture`, `/zoom-out`, `/prototype`, `/handoff`). See `docs/agents/workflow.md`
- **Issue tracker** — GitHub issues at `AtlasDevHQ/atlas` via `gh` (always `-R AtlasDevHQ/atlas`). Atlas body format (`## Key files / ## Acceptance criteria / ## Dependencies`); labels on two axes (kind+area AND triage state). See `docs/agents/issue-tracker.md`
- **Triage labels** — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix` (created lazily). Orthogonal to kind/area. See `docs/agents/triage-labels.md`
- **Domain docs** — single-context `CONTEXT.md` + `docs/adr/` at repo root; `/grill-with-docs` and `/teach-impeccable` produce them lazily. See `docs/agents/domain.md`
