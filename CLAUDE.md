# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Core Rules Checklist

Most of these are **subsystem-conditional** — read the group that matches what you're touching, not all of them. The groups marked ⚠️ are unconditional: they hold regardless of what you're working on.

Where a rule names a `scripts/check-*.sh` guard, that guard is the enforcement — the rule is here so you don't waste a cycle discovering it in CI, not because prose is the gate.

### Security (SQL)
- [ ] **SELECT only** — SQL validation blocks all DML/DDL. Never INSERT, UPDATE, DELETE, DROP, TRUNCATE, ALTER, etc.
- [ ] **Single statement** — No `;` chaining. One query per execution
- [ ] **One AST parse, shared everywhere** — All SQL parsed via `node-sql-parser` (PostgreSQL/MySQL, auto-detected) **exactly once** per validation (`parseOnce` in `lib/tools/sql.ts`): the shape guards (single SELECT, no `SELECT … INTO`, no PG `ONLY`), the forbidden-function AST walk (`pg_read_file`, `dblink`, `pg_sleep`, `load_file`, …), the table whitelist, and the query classifier all read that same parse — one table set by construction, so the classifier that drives approval gating + PII masking can never diverge from the whitelist. Regex guard is a first pass, not the only check. Unparseable queries are **rejected**, never silently skipped
- [ ] **Table whitelist** — Only whitelisted semantic-layer tables are queryable (`packages/api/src/lib/semantic/whitelist.ts`). File layouts: `semantic/entities/` (default group), `semantic/groups/<group>/entities/` (canonical per-group, [ADR-0012](docs/adr/0012-group-scoped-semantic-layer-directories.md) — the directory is authoritative), `semantic/<source>/entities/` (legacy). On SaaS the whitelist is DB-backed (`semantic_entities` keyed by connection group, `loadOrgWhitelist`). A failed scan **fails closed** (`getWhitelistedTablesStrict`) — never falls back to a broader set. Schema-qualified queries need the qualified name in the whitelist
- [ ] **Auto LIMIT** — Every query gets a LIMIT appended. Default 1000, via `ATLAS_ROW_LIMIT`
- [ ] **Statement timeout** — PostgreSQL/MySQL get a session-level timeout. Default 30s, via `ATLAS_QUERY_TIMEOUT`

### Security (General)
- [ ] **Explore is read-only by isolation, not a path jail** — Each explore backend is read-only *structurally* (ephemeral microVM / read-only bind mounts / in-memory overlay): shell writes and `..` traversal may succeed *inside* the sandbox but never touch host files, and there is no command allowlist or `semantic/`-scoped path check. See the fuller "read-only by isolation, not command validation" note under **Agent Tools**; don't lean on a path-traversal guard that isn't enforced (#4781)
- [ ] **No secrets in responses** — Never expose connection strings, API keys, or stack traces to the user or agent
- [ ] **Readonly DB connections** — PostgreSQL via validation; MySQL via read-only session variable; ClickHouse via `readonly: 1`
- [ ] **Encrypted at rest** — New integration + datasource credentials use `encryptSecret` / `decryptSecret` from `db/secret-encryption.ts` (versioned AES-256-GCM). New credential table = one-line add to `INTEGRATION_TABLES` in `db/integration-tables.ts` + an `_encrypted` column. Datasource URLs use selective-field encryption (`encryptSecretFields`) keyed on the `config_schema` `secret: true` flag. The legacy `db/internal.ts` passthrough is frozen to two columns — no new call sites. See [ADR-0005](docs/adr/0005-integration-credentials-table.md), [ADR-0007](docs/adr/0007-unified-install-pipeline.md)
- [ ] **Explore/python tool isolation** — One backend-selection module for both tools: `lib/tools/backends/selection.ts`. Default priority: plugin/BYOC > Vercel sandbox > nsjail explicit > sidecar > nsjail auto-detect > just-bash (dev). Override via `sandbox.priority` or `ATLAS_SANDBOX_PRIORITY`; `ATLAS_SANDBOX=nsjail` is hard-fail (API won't boot if init fails). **SaaS pins `["vercel-sandbox"]`** in `deploy/api/atlas.config.ts` (deny-all egress, fail-closed on exhaustion — no `just-bash` fallback). Vercel team/project IDs are non-secret config in `atlas.config.ts` (`sandbox.vercel`); only `VERCEL_TOKEN` stays a **per-service** env secret (Railway shared vars don't auto-inherit)
- [ ] **Per-tenant plugin creds never fall back to operator env vars** — `resolveWorkspaceCredentials` is DB-only in both deploy modes. `TWENTY_API_KEY` belongs to Atlas's own lead-capture pipeline (`ee/src/saas-crm/`) via `resolveOperatorCredentials`. No plugin install (customer or Atlas's own team workspace) ever reads from env — installs go through `atlas.config.ts` or Admin → Integrations. `scripts/check-twenty-resolver-imports.sh` keeps the seam tight. See #2850

### Error Handling
- [ ] **Never silently swallow errors** — Every `catch` must log (`log.warn`/`console.debug`) or re-throw. Empty `catch {}` forbidden. If intentional: `// intentionally ignored: <reason>`
- [ ] **Type-narrow caught errors** — Always `err instanceof Error ? err.message : String(err)`. Never access `.message` unguarded
- [ ] **Request IDs on all 500s** — Every 500 response includes `requestId` for log correlation
- [ ] **No generic error messages** — Replace "Something went wrong" with actionable, context-specific messages + retry guidance
- [ ] **Prefer errors over silent fallbacks** — `catch { return false }` on a security check is a bug. Return 500, not a false negative

### Type Safety
- [ ] **No explicit `any`** — Use proper types or `unknown` with narrowing. `any` only where unavoidable (third-party) with `oxlint-disable` + justification
- [ ] **Minimize non-null assertions** — Only `!` when provably non-null. Prefer `?.` or explicit null checks

### Code Style
- [ ] **bun only** — Package manager and runtime. Never npm, yarn, or node
- [ ] **TypeScript strict mode** — Path aliases: `@atlas/api/*` cross-package, `@/*` → `./src/*` within web only
- [ ] **Tailwind CSS 4** — Via `@tailwindcss/postcss`, not v3
- [ ] **shadcn/ui v2** — New-york style, neutral base, Lucide icons. **Always use shadcn/ui primitives** — never hand-roll. Install: `bun x shadcn@latest add <component>` from `packages/web/`. Uses `cn()` from `@/lib/utils`
- [ ] **Server external packages** — `pg`, `mysql2`, `@clickhouse/client`, `@duckdb/node-api`, `snowflake-sdk`, `jsforce`, `just-bash`, `nodemailer`, `pino`, `pino-pretty`, `stripe` must stay in `serverExternalPackages` in the `create-atlas` template
- [ ] **Frontend is a pure HTTP client** — `@atlas/web` does NOT depend on `@atlas/api`. Shared types live in `@useatlas/types` (wire types) and `@useatlas/schemas` (Zod validation), re-exported via `packages/web/src/ui/lib/types.ts`
- [ ] **`lib/` must not import from `api/routes/`** — The data/helper layer (`src/lib/**`) stays above the Hono route layer (`src/api/**`). Inverted imports pull auth/logger/middleware into every `lib/` consumer and break partial `mock.module()` mocks. Extract route helpers into a `lib/` module (e.g. `lib/content-mode/` ↔ `api/routes/mode.ts`). Convention-only — no lint rule enforces it yet, so watch for it in review
- [ ] **nuqs for URL state** — [nuqs](https://nuqs.47ng.com/) for pagination, filters, selected items. Parsers in `search-params.ts` next to the page. Transient UI state stays `useState`
- [ ] **zustand for cross-page UI state** — [zustand](https://zustand.docs.pmnd.rs/) for transient state that outlives a component but isn't URL-shareable (command menus, wizards, undo). Stores in `packages/web/src/lib/stores/<name>-store.ts`, client components only. Not for local (`useState`), URL (`nuqs`), or server state (`useAdminFetch`)
- [ ] **React Compiler handles memoization** — No `useMemo`/`useCallback`/`React.memo` for performance. `useMemo` only for correctness (stable refs); `React.memo` w/ custom comparator for semantic equality
- [ ] **No async waterfalls** — `Promise.all([a(), b()])` for independent awaits
- [ ] **Immutable array operations** — `toSorted()`, `toReversed()`, `toSpliced()` in React components
- [ ] **Dynamic imports for heavy components** — `next/dynamic` for Monaco, Recharts, syntax highlighters
- [ ] **oxlint, not ESLint** — Linting is [oxlint](https://oxc.rs) via `.oxlintrc.json` (Rust core, tsgo-backed). Rule set mirrors the former ESLint baseline (eslint + typescript + nextjs + import correctness). The three CI-enforced guards (FetchError-flatten, `feature: FeatureName` registry, `@useatlas/schemas` import boundary) run as `no-restricted-syntax`/`no-restricted-imports` through the `oxlint-plugin-eslint` JS plugin (`jsPlugins` in `.oxlintrc.json`). Type-aware linting (tsgolint) runs as `bun run lint:type-aware` — a separate CI-blocking gate (`lint-type-aware` job in the `ci` umbrella + `/ci` stage 1), kept out of fast `lint` because it builds TS programs. Promoted rules are at `error` and 0 repo-wide; the remaining `warn` rules (~200: `no-base-to-string`, `unbound-method`, `restrict-template-expressions`, `no-misused-spread`, `no-implied-eval`) are permanent non-targets — don't try to clear them (ADR-0031)
- [ ] **`FeatureName` registry for admin surfaces** — `<MutationErrorSurface>`, `<EnterpriseUpsell>`, `<FeatureGate>`, `<AdminContentWrapper>`, `<ReasonDialog>` type `feature` as `FeatureName` from `@/ui/components/admin/feature-registry`. Append the canonical name to `FEATURE_NAMES` first (casing matches banner copy — "SSO" not "sso"); consolidate duplicates. `tsgo`-enforced

### Database & Migrations
- [ ] **Drizzle schema mirrors every migration** — A new `db/migrations/####_*.sql` that creates/alters a table needs a matching `db/schema.ts` update **in the same PR** — mirror types, composite PKs, indexes, CHECK constraints. `scripts/check-schema-drift.sh` (in `/ci`) fails on missing mirrors; without it, the next `drizzle-kit generate` emits a `DROP TABLE` that wipes the table on deploy
- [ ] **DROP TABLE migrations tracked separately** — `check-schema-drift.sh` excludes tables explicitly dropped by migrations (e.g. `mcp_tokens`, dropped by 0047). When you drop a table, remove its `pgTable` from `schema.ts` in the same commit
- [ ] **Two-phase drop discipline for `DROP TABLE`/`DROP COLUMN`** — stop reading/writing the object in release N, drop it in release N+1, so the N-1↔N deploy-overlap window can never `relation/column does not exist`. CI-enforced: `scripts/check-migration-rename-discipline.sh` (in `/ci`) rejects any newly-added migration doing a single-phase `RENAME COLUMN`/`DROP COLUMN`. Rationale + expand-contract checklist: [packages/api/src/lib/db/migrations/README.md](packages/api/src/lib/db/migrations/README.md)
- [ ] **Real-Postgres migration smoke runs in CI** — `migrate-pg.test.ts` runs every migration against `TEST_DATABASE_URL`; Better-Auth-dependent migrations must join `MANAGED_AUTH_MIGRATIONS` in `db/internal.ts`. See [docs/development/testing.md](docs/development/testing.md)

### Effect.ts (packages/api only)
- [ ] **Use Context.Tag for services** — `class Foo extends Context.Tag("Foo")<Foo, FooShape>()`. Interfaces are `FooShape` with `readonly` fields
- [ ] **Layer.effect vs Layer.scoped** — `Layer.scoped` when the service has a finalizer (cleanup on shutdown); `Layer.effect` for stateless
- [ ] **Tagged errors via Data.TaggedError** — Never plain `Error` subclasses with `_tag`. Use `Data.TaggedError("ErrorName")<{ ... }>`
- [ ] **runHandler for route handlers** — `runHandler(c, "label", async () => { ... })` bridges Hono → Effect Context and centralizes error-to-HTTP mapping
- [ ] **No `catch: (err) => err`** — In `Effect.tryPromise`, always normalize: `catch: (err) => err instanceof Error ? err : new Error(String(err))`. **Carve-out:** `lib/effect/semantic-generator.ts`'s profile `tryPromise` intentionally uses `catch: (err) => err` to preserve the raw rejection's identity (a cooperative `OperationCancelledError` from the MCP progress bridge) so the downstream `catchAll` can route cancellation → defect; normalizing there would erase the identity and surface a spurious `validation_failed`. Don't "fix" it
- [ ] **satisfies on service returns** — Always `satisfies FooShape` on returned service objects
- [ ] **Effect test layers + no top-level singleton mutation** — Prefer `Layer.provide` test layers over `mock.module()`; never mutate a registry/singleton at test module top-level. See [docs/development/testing.md](docs/development/testing.md)

### Testing
- [ ] **`bun run test`, never bare `bun test`** — Isolated per-file runner. Single file OK: `bun test path/to/file.test.ts`. Never bare `bun test` against a directory
- [ ] **Use `--affected` for local loops** — `cd packages/api && bun run scripts/test-isolated.ts --affected`. Run full `bun run test` before a PR
- [ ] **Pre-PR gates via `/ci`** — runs `scripts/ci-local.sh`: ~27 gates (stage 0 type-check → stage 1 parallel checks: lint, type-aware lint, syncpack, template/schema/openapi/auth-md drift, ee-imports, twenty-resolver, migration-rename discipline, published-symbols, … → stage 2 full isolated test suite). All must pass; the `/ci` skill carries the authoritative gate list
- [ ] **Mock all exports** when using `mock.module()`; use `createConnectionMock()` for connection mocks (never inline)
- [ ] **Tests are self-contained** — No top-level `process.env.X =` or `process.chdir(...)`; `??=` hoist permitted for import-time env reads
- Full rationale, gotchas, and the `??=` vs `=` discipline: [docs/development/testing.md](docs/development/testing.md)

### Agent Tools
- [ ] **Tools return structured data** — `executeSQL` returns `{ columns, rows }`
- [ ] **Default tool set lives in the registry** — `defaultRegistry` (`lib/tools/registry.ts`) registers `explore`, `executeSQL`, `searchBrain`, `createDashboard`, `sendEmail`, `createLinearIssue`, and OAuth-gated `querySalesforce`; `buildRegistry` adds `executePython` (when `ATLAS_PYTHON_ENABLED`) + configured action tools. Never wire a tool around the registry. A tool RENAME goes in `RENAMED_TOOLS` in the same file — `validateToolConfig` throws on an unknown `atlas.config.ts` `tools:` entry, so an unmapped rename is a boot failure in someone else's deployment
- [ ] **Explore is read-only by isolation, not command validation** — There is no command allowlist; the agent may run arbitrary shell (`awk`/`sed`/pipes included). Read-only scoping to `semantic/` is enforced structurally by each backend (ephemeral microVM / read-only bind mounts / OverlayFs): writes land in ephemeral or in-memory layers and never touch host files. Output is capped at 1 MB at the tool seam. Sandbox priority documented under **Security (General)** above
- [ ] **Agent max steps** — `stopWhen: stepCountIs(getAgentMaxSteps())`. Default 25, via `ATLAS_AGENT_MAX_STEPS` (1–100)
- [ ] **Tools are traced by registration, not by diligence** — `ToolRegistry.getAll()` wraps every executable tool in an `atlas.tool.<name>` span (`lib/tools/tool-spans.ts`), so a new tool needs no telemetry code; a tool that wants more detail adds an inner span that nests under it. Span/attribute conventions + the grandfathered off-prefix names: [docs/development/telemetry.md](docs/development/telemetry.md)
- [ ] **Semantic layer drives the agent** — Read entity YAMLs before writing SQL

### Semantic Layer
- [ ] **YAML format** — Entity files define columns, types, sample values, joins, virtual dimensions, measures, query patterns (`EntityShape` in `packages/api/src/lib/semantic/shapes.ts`). Group-scoped directory layout per [ADR-0012](docs/adr/0012-group-scoped-semantic-layer-directories.md) — see **Table whitelist** above
- [ ] **Metrics are authoritative** — SQL in `metrics/*.yml` must be used exactly as written
- [ ] **Glossary terms** — Terms marked `ambiguous` in `glossary.yml` should trigger clarifying questions

### Content Mode System
Schema requirements, mode-resolution middleware, the atomic publish endpoint, and carve-out rules: [docs/development/content-mode.md](docs/development/content-mode.md).
- [ ] **New user-surfaced content tables opt into mode** — Add a `status` column (`draft`/`published`/`archived` enum + `CHECK`), default `draft`. Gate non-admin reads by `status = 'published'`; admin/dev-mode overlays `status IN ('draft','published')` via `ContentModeRegistry` (`readFilter`) or `resolveStatusClause` for non-Effect callers. Register the table in `CONTENT_MODE_TABLES` (`lib/content-mode/tables.ts`) — the publish wire contract derives from it
- [ ] **Promote only via the atomic publish endpoint** — `/api/v1/admin/publish` is the single place drafts go live: promote inside its transaction (`admin-publish.ts`) and surface the count in `/api/v1/mode` `draftCounts`. Never stamp drafts to published outside it. Carve-outs (e.g. `user_favorite_prompts`) need a recorded rationale (migration comment + the content-mode doc)

### Plugin migrations
- [ ] **Update the chat-plugin × Atlas contract doc when the boundary changes** — Any PR that adds/removes/reshapes a field at the `@useatlas/chat` / `@chat-adapter/*` boundary updates the table in [docs/architecture/chat-plugin-atlas-contract.md](docs/architecture/chat-plugin-atlas-contract.md) in the same commit. Before a PR touching `plugins/chat/src/`, `packages/api/src/lib/slack/`, or `packages/api/src/lib/integrations/install/*-oauth-handler.ts`, diff the contract table; open ⚠ rows block milestone closeout

### Enterprise & SaaS Gating (`/ee`)
Full rationale, enforcement mechanics, and the `Tag.available` membership list: [docs/development/enterprise-gating.md](docs/development/enterprise-gating.md).
- [ ] **SaaS-specific features go in `/ee`** — Anything that exists specifically to make Atlas a hosted SaaS (deploy-mode detection, marketplace, residency, masking, SSO/SCIM, approvals, backups, white-labeling) lives in `ee/src/` under the commercial license
- [ ] **Never let core AGPL depend on `/ee`** — in `packages/api/src` exactly one file (`lib/effect/enterprise-layer.ts`) may import `@atlas/ee`; in `packages/mcp/src` only two audited seam files (`MCP_ALLOWED_FILES`). `scripts/check-ee-imports.sh` + `ee-stub-build` enforce it, so a violation is a CI failure, not a review catch
- [ ] **Never import `isEnterpriseEnabled` from `@atlas/ee` in core** — `yield* TheTag` and let the `NoopXxxLayer` short-circuit; value-level checks use the core mirror in `lib/effect/enterprise-config.ts`
- [ ] **Enterprise errors use `EnterpriseError`** — `instanceof`, never string matching. Routes map it to 403. `Tag.available` is for the 404 / shaped-success branch only — omit by default
- [ ] **Deploy mode is enterprise-gated** — `ATLAS_DEPLOY_MODE=saas` requires `/ee`. The commercial license prohibits using `/ee` in a competing product
- [ ] **SaaS-first configuration: env is for secrets + pre-DB boot inputs ONLY** — an operator or workspace admin must never redeploy to change config. A new knob's default home is the **settings registry** (`lib/settings.ts`; precedence `workspace > platform > env > default`, ~30s hot-reload). A new env var needs one of two justifications: it's secret, or the process needs it before the internal DB exists. Non-secret cross-region constants go in `atlas.config.ts` or the [env-profile](packages/api/src/lib/env-profile.ts). Boot contract: `SAAS_ENV_KEYS` in [saas-env.ts](packages/api/src/lib/effect/saas-env.ts); audit + backlog: [saas-env-audit.md](docs/development/saas-env-audit.md)

### Merge discipline
Full rationale + override rules: [docs/development/branch-protection.md](docs/development/branch-protection.md).
The required-check list, `strict`/`enforce_admins` settings, and the full override rules live in that doc. The prohibitions that must never be looked up:

- [ ] **NEVER merge a fork PR** — head repo ≠ `AtlasDevHQ/atlas` (`isCrossRepository: true`) is an external contributor's code. An agent must never merge one, not even fully green. Needs in-session human confirmation **and** a recorded security diff review; the `external-approved` label applied by hand **is** the sign-off. Surface provenance first: `gh pr view <PR> --json headRepositoryOwner,author,isCrossRepository,reviews`. See #3772
- [ ] **`--admin` is for a broken gate, not a slow one** — merge only after `gh pr checks <PR> --watch` is green on the head SHA. "Tests are slow" doesn't qualify (#2206). **A check that *structurally cannot run* on a class of PR is a stop sign, not an override invitation** — CodeQL never runs on fork PRs and `fork-pr-gate` is red by design. Admin-merging past a missing-by-design gate is forbidden for agents (#3772)
- [ ] **Never target `prod` with a PR** — it's a Railway-tracking artifact advanced only by `/release`
- [ ] **`milestone/**` is the one integration-branch exception** — but branch protection is `main`-only, so **nothing blocks a bad merge into a milestone branch**; green checks there are discipline, not enforcement. CodeQL is deferred to the milestone→`main` PR — deferred, not waived
- [ ] **Required reviews are intentionally off** — solo dev + parallel-claude workflow. Don't enable without rethinking the model

---

## Project Overview

**Atlas** — Deploy-anywhere text-to-SQL data analyst agent. Hono + Next.js + TypeScript + Effect.ts + Vercel AI SDK + bun.

The product surface (each subsystem's design lives in its ADR): web chat + embeddable React widget + eight chat-platform adapters (Slack live); **dashboards** with draft-first, publish-gated editing ([ADR-0029](docs/adr/0029-dashboards-draft-first-editing.md)); the **Knowledge Base pillar** — per-workspace OKF collections, review-gated draft→published, served OKF-native to the agent ([ADR-0028](docs/adr/0028-knowledge-base-fourth-pillar.md)); an OAuth 2.1 **MCP server** with self-serve `start_trial` ([ADR-0016](docs/adr/0016-mcp-v2-security-model.md), [ADR-0018](docs/adr/0018-self-serve-trial-over-mcp.md)); **durable agent sessions** + compaction + durable memory, default-OFF and degrading cleanly without an internal DB ([ADR-0020](docs/adr/0020-durable-agent-sessions.md)); per-conversation **answer styles** (`lib/answer-styles.ts` — plain-english/analyst/executive/conversational; precedence per-conversation pick > workspace `ATLAS_DEFAULT_ANSWER_STYLE` > surface default); **cross-group reach** + source catalog ([ADR-0022](docs/adr/0022-cross-group-reach-llm-composition.md)); and 3-region SaaS **residency** where the process is the region ([ADR-0024](docs/adr/0024-regional-identity-isolation.md)).

### Versioning & releases

Three independent version trains that **never coordinate** — git tags, GitHub milestones, and per-package npm semver. Rules, semver policy, and the release flow: [ADR-0008](docs/adr/0008-versioning-and-release-tags.md) + [release-process.md](docs/development/release-process.md); milestone naming: [ADR-0009](docs/adr/0009-tag-organized-roadmap.md).

Two things that trip people up:

- The shipped internal milestone `1.0.0 — SaaS Launch` (#24) is **not** the future git tag `v1.0.0` — say "internal milestone 1.0.0". `v1.0.0` is reserved for when REST + MCP + plugin SDK contracts freeze.
- The docs changelog is a **per-tag feed**, not banked for `v0.1.0` ([ADR-0008 amendment](docs/adr/0008-versioning-and-release-tags.md)). `/release` owns writing it.

**Operational rule:** when adding a new integration (chat platform, action target, datasource), create the staging app/credentials first — staging is the soak environment. Don't OAuth-register a new platform straight against prod.

## Commands

Run `bun run` for the script list — `dev`, `build`, `lint`, `type`, `test*`, `db:*` are all there and do what their names say. Only the non-obvious invocations are worth stating:

```bash
# Fast local feedback loop — only tests whose source graph your branch touched:
cd packages/api && bun run scripts/test-isolated.ts --affected
cd packages/api && bun run scripts/test-isolated.ts --since HEAD~3     # last 3 commits
bun run atlas -- init    # Profile DB, generate semantic layer
bun run atlas -- diff    # Compare DB schema vs semantic layer
```

**Quick start:** `bun install` → `cp .env.example .env` → `bun run db:up` → `bun run atlas -- init` → `bun run dev`. Dev admin: **admin@useatlas.dev / atlas-dev**.

> **Local dev runs either deploy mode; `self-hosted` is the trivial default.** `.env` ships `ATLAS_DEPLOY_MODE=self-hosted` + `ATLAS_DEPLOY_ENV=development`. With `development` set, even an unset/`auto` deploy mode resolves to `self-hosted` (`resolveDeployMode`), so a missing value no longer face-plants the API onto the SaaS-only boot guards. To dev against the SaaS code path, set `ATLAS_DEPLOY_MODE=saas`: in `development` env the SaaS fail-closed boot guards (Turnstile #3795, rate-limit RPM #1983, billing, MCP spine, …) **relax to a no-op** (`relaxSaasGuardForDev` in `saas-guards.ts`) so it boots against your real local `.env` without the prod-only secrets — an **intentional local-dev footgun, gated solely on `development`; never set `ATLAS_DEPLOY_ENV=development` on a customer-facing deploy.** Don't set deploy vars on the `bun run dev` command line (the wrapper subshell drops them); they belong in `.env`. Full runbook + the `VERCEL_*`-and-sandbox-tests note (class fixed in the test preload; see the doc): [docs/development/local-development.md](docs/development/local-development.md).

### Operator subcommands (destructive) — the `atlas-operator` binary

Tenant-destructive direct-DB tooling lives in its **own binary, `atlas-operator`** (`bun run atlas-operator -- <command>`), deliberately split out of the published `atlas` CLI (ADR-0025 step 4, #4045). Command list, per-command DB targets, and gate details: the **`operator-commands`** skill.

⚠️ **`ops wipe` TRUNCATEs every public table and takes no backup** — double-gated by `ATLAS_WIPE_OK=1` **and** `--confirm`. Wrap with `pg_dump` yourself.
⚠️ **`ops teardown-verify-accounts` targets a region's internal DB, not the tenant DB** — no `DATABASE_URL` fallback by design; DRY RUN unless `ATLAS_TEARDOWN_OK=1` + `--confirm`.

## Architecture

### Packages

`ls packages/ apps/ examples/ plugins/` is the authoritative inventory; each package's `package.json` `name` + `description` says what it is. Only the facts you can't read off disk:

- **Published to npm** (`@useatlas/*`, independent semver, see *Publishing* below): `types`, `schemas`, `sdk`, `react`, `plugin-sdk`, `webhook-publisher`. Everything under `@atlas/*` is internal and never published — including `oauth-helper`, which looks publishable but is deliberately not.
- **`@useatlas/schemas` is the one exception** — internal-only despite the public scope; it never publishes to npm.
- **`ee/`** is `@atlas/ee`: source-available under a commercial license, not AGPL. See *Enterprise & SaaS Gating*.
- **`plugins/`** — datasources, sandbox runtimes, chat adapters, action targets. The count is pinned by `scripts/check-plugin-count.sh`; don't hand-maintain it here.

**Import conventions:**
- `@atlas/api` uses its own name: `@atlas/api/lib/agent`, `@atlas/api/lib/auth/types`
- `@atlas/web` uses tsconfig alias: `@/ui/context` → `./src/ui/context`
- Frontend never imports from `@atlas/api` — communicates over HTTP

### Agent Loop

```
POST /api/v1/chat → authenticateRequest → checkRateLimit → withRequestContext → validateEnvironment
    → runAgent(messages)  [or runAgentEffect → yield* AtlasAiModel]
    → streamText (AI SDK, ToolRegistry, stopWhen: stepCountIs(getAgentMaxSteps()))
        ├── explore → read semantic/ + knowledge mirrors in the sandbox (read-only by isolation)
        ├── executeSQL → validate (one parse) → resolveSqlExecutionPlan → reject | single | fanout
        │                → query via ConnectionRegistry → { columns, rows }
        ├── searchBrain → fused trust-labeled read: facts (tier-2) · episodes (tier-3) · KB docs (ADR-0036)
        └── createDashboard · sendEmail · createLinearIssue · querySalesforce · executePython (gated)
    → Data Stream Response → Chat UI

Other routes use: runHandler(c, ...) → RequestContext + AuthContext via Effect bridge
```

`runAgentEffect` yields `AtlasAiModel` from Effect Context — testable with a mock LLM via `createAiModelTestLayer()`. Durable sessions (when enabled) checkpoint per-step for crash-resume + approval-park (ADR-0020).

### SQL Validation & Execution

Validation (all consumers share **one** AST parse — `parseOnce` in `lib/tools/sql.ts`):

0. Empty check → 1. Regex mutation guard → 2. AST shape guards (single SELECT, no `SELECT…INTO`, forbidden functions, PG `ONLY`) → 3. Table whitelist + query classification from the same parse (CTE names excluded)

At execution: RLS injection (optional; reuses the threaded parse) → Auto LIMIT → Statement timeout.

Routing: `lib/tools/sql-execution-plan.ts` (`resolveSqlExecutionPlan`) resolves reach → routing mode → per-leg execution targets into a discriminated plan — `reject` (out-of-reach is a hard error, never a silent re-route) | `single` | `fanout`. The same `resolveReachableGroups` feeds both the advertised source catalog and the enforcing gate, so advertised == enforceable by construction (ADR-0022).

### Two-Database Architecture

1. **Analytics datasources** — the customer's data, read-only. PostgreSQL/MySQL native; ClickHouse, Snowflake, BigQuery, DuckDB, Elasticsearch/OpenSearch, Salesforce, and REST/OpenAPI via datasource plugins ([ADR-0013](docs/adr/0013-db-stored-plugin-datasource-connections.md)). Via `ConnectionRegistry` in `db/connection.ts`; `ATLAS_DATASOURCE_URL` seeds the default self-hosted connection
2. **Internal database** (`DATABASE_URL`) — Atlas's own Postgres for auth, audit, settings, content mode, knowledge, durable sessions. Optional self-hosted; required for SaaS. `db/internal.ts`

### Effect.ts Service Architecture

Backend services use Effect.ts for DI, typed errors, and lifecycle. Core Tags live in `packages/api/src/lib/effect/`:

| Service | File | Provides |
|---------|------|----------|
| `ConnectionRegistry` | `services.ts` | Analytics DB pools, health checks, metrics |
| `PluginRegistry` | `services.ts` | Plugin lifecycle, health checks |
| `RequestContext` | `services.ts` | `{ requestId, startTime }` per request |
| `AuthContext` | `services.ts` | `{ mode, user, orgId }` per request |
| `DurableSession` / `DurableState` | `services.ts` | Per-step checkpoints + durable memory (ADR-0020) |
| `Migration` | `services.ts` | Internal-DB migration runner |
| `AtlasAiModel` | `ai.ts` | Configured LLM (Vercel AI SDK LanguageModel) |
| `InternalDB` | `db/internal.ts` | Internal Postgres pool |
| `Settings` | `layers.ts` | Runtime settings registry (hot-reload) |
| `SemanticSync` | `layers.ts` | Startup semantic-layer sync |
| `Telemetry` / `Config` / `Scheduler` | `layers.ts` | OTel handle · resolved atlas.config.ts · scheduler lifecycle |

Enterprise seams (residency, masking, approvals, marketplace, SaaS CRM, …) are additional Tags in `services.ts` behind Noop layers — see **Enterprise & SaaS Gating** above.

- **Hono bridge:** `runHandler(c, "label", async () => { ... })` wraps every route handler — provides `RequestContext` + `AuthContext`, centralizes error-to-HTTP via `classifyError()`
- **Startup:** `buildAppLayer(config)` composes startup Layers (telemetry, migrations, semantic sync, settings, scheduler) into one DAG; `ManagedRuntime.make(appLayer)` boots eagerly
- **Tagged errors:** in `errors.ts` via `Data.TaggedError`; exhaustive `mapTaggedError()` switch maps each to HTTP status (compile-time check via `ATLAS_ERROR_TAG_LIST`)
- **Test utilities:** `__test-utils__/layers.ts` provides `TestAppLayer`, `TestAdminLayer`, `TestPlatformLayer`, `runTest()`, `buildTestLayer()`

### `lib/` subsystem map (packages/api/src/lib/)

Orientation for the biggest areas beyond `effect/`, `db/`, `semantic/`, `tools/`: `billing/` (Stripe subscriptions, entitlements, overage metering) · `integrations/install/` (OAuth + form-install spine; `persistSingletonInstall` is the single workspace-install write path) · `knowledge/` (KB pillar; `ingest-bundle.ts` is the one ingest seam) · `dashboards*.ts` (draft-first dashboards) · `durable-session.ts` / `durable-state.ts` / `agent-compaction.ts` (ADR-0020) · `residency/` (region routing) · `content-mode/` (draft/published) · `settings.ts` (runtime settings registry) · `mcp/` (MCP spine + `auth.md` discovery) · `scheduler/` (periodic fibers via `registerPeriodicFiber`) · `learn/` (learned query patterns) · `proactive/` (proactive chat, enterprise-gated) · `group-reach/` + `source-catalog/` (cross-group reach, ADR-0022) · `answer-styles.ts` (voice registry) · `tools/backends/` (sandbox selection).

## Key Patterns

### Entity YAML
Entity files define columns, types, sample values, joins, virtual dimensions, measures, query patterns. See `semantic/entities/*.yml` (and `semantic/groups/<group>/entities/`) + `EntityShape` in `packages/api/src/lib/semantic/shapes.ts`.

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
Admin pages use shared hooks — never hand-roll fetch/mutation logic:
```typescript
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";

const { data, loading, error, refetch } = useAdminFetch<T>("/api/v1/admin/...");
const { mutate, saving, error } = useAdminMutation<T>({
  path: "/api/v1/admin/...", method: "POST", invalidates: refetch,
});
```
Config-form pages (load one settings object → edit fields → dirty-gated save → reset on refetch) use `useConfigForm` instead of wiring those two by hand — `toForm` is the single statement of the field set, and the dirty compare derives from it so a new field can't be forgotten:
```typescript
import { useConfigForm } from "@/ui/hooks/use-config-form";

const form = useConfigForm<WireConfig, FormValues>({
  path: "/api/v1/admin/...", schema: WireConfigSchema,
  toForm: (d) => ({ enabled: d.enabled, cap: d.cap === null ? "" : String(d.cap) }),
  toPayload: (v) => ({ enabled: v.enabled, cap: v.cap === "" ? null : Number(v.cap) }),
});
// form.fields.enabled.{value,set} · form.{data,loading,loadError,refetch,values,dirty,reset,save,saving,error}
```

## Template Sync

`create-atlas/templates/nextjs-standalone/src/` is gitignored, regenerated by `create-atlas/scripts/prepare-templates.sh`. Never edit template `src/` directly. CI runs `scripts/check-template-drift.sh`.

### Publishing `@useatlas/*` packages

Full sequence, guards, and rationale: the **`publish-package`** skill.

⚠️ **Never push more than 3 release tags in one `git push`** — GitHub fires NO `push` event for tags when >3 land in a single push, so `publish.yml` runs for none of them: the tags land on the remote and nothing publishes, silently. Groups of ≤3, or one at a time. (Caught 2026-06-15 backfilling 6 tags — published nothing.)

⚠️ **Sequence ref bumps AFTER the publish lands** — for `0.0.x`, `^0.0.2` pins exactly to `0.0.2`, so bumping refs first makes Deploy Validation scaffolds fail on `npm install`.

## Environment Variables

See `.env.example` for the full list. Key vars: `ATLAS_PROVIDER`, `ATLAS_MODEL`, `ATLAS_DATASOURCE_URL`, `DATABASE_URL`, `ATLAS_AUTH_MODE`, `BETTER_AUTH_SECRET`.

## Agent skills

- **Workflow** — how Atlas commands (`/next`, `/tidy`, `/investigate`, `/elevate`, `/kickoff`, `/closeout`, `/ci`, `/pr`) compose with the Matt Pocock skills (`/diagnose`, `/tdd`, `/to-prd`, `/to-issues`, `/triage`, `/grill-with-docs`, `/improve-codebase-architecture`, `/zoom-out`, `/prototype`, `/handoff`). See `docs/agents/workflow.md`
- **Issue tracker** — GitHub issues at `AtlasDevHQ/atlas` via `gh` (always `-R AtlasDevHQ/atlas`). Atlas body format (`## Key files / ## Acceptance criteria / ## Dependencies`); labels on two axes (kind+area AND triage state). See `docs/agents/issue-tracker.md`
- **Triage labels** — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix` (created lazily). Orthogonal to kind/area. See `docs/agents/triage-labels.md`
- **Audit commands** — `/docs-audit`, `/www-audit`, `/prod-audit`, `/contracts-audit` share conventions in `docs/agents/audits.md`: Step-0 self-check (each command verifies its own references before trusting its checks), discover-don't-enumerate, guard-first (run existing CI gates, audit only the residue), the promote-to-CI ratchet for repeat findings, and the pre-tag battery (which audits to run before `/release`)
- **Domain docs** — single-context `CONTEXT.md` + `docs/adr/` at repo root; `/grill-with-docs` and `/teach-impeccable` produce them lazily. See `docs/agents/domain.md`
