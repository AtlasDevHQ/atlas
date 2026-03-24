# Atlas Roadmap

> What's shipped and what's planned. Detailed tracking lives in [GitHub Issues](https://github.com/AtlasDevHQ/atlas/issues).
> Filter by milestone label: `v0.5`, `v0.6`, `v0.7`, etc.
>
> **Note:** The scaffolding command changed from `bun create atlas-agent` to `bun create @useatlas` when `@useatlas/create` was published to npm. Historical bullets below use the old name.

---

## v0.1 — Foundation (Shipped)

The core text-to-SQL agent, end to end.

- [x] Agent loop — streamText with core tools (explore, executeSQL)
- [x] SQL validation — Multi-layer pipeline (empty check, regex, AST, whitelist, auto-LIMIT, statement timeout)
- [x] Semantic layer — YAML on disk (catalog, entities, glossary, metrics)
- [x] DB profiler CLI — `atlas init` with PK/FK detection, enum sampling, measures, virtual dimensions
- [x] LLM enrichment — `atlas init --enrich` post-processing via generateText
- [x] 5 LLM providers — Anthropic, OpenAI, Bedrock, Ollama, Vercel AI Gateway
- [x] Chat UI — Minimal useChat interface with streaming
- [x] Docker + Railway deployment — Multi-stage Dockerfile, railway.json
- [x] create-atlas-agent scaffolding — `bun create atlas-agent my-app` with interactive setup
- [x] Demo dataset — 50 companies, ~200 people, 80 accounts
- [x] PostgreSQL only — Singleton pool with statement_timeout

---

## v0.2 — Deploy Anywhere

Make `bun create atlas-agent`, deployment, and the getting-started path bulletproof. Support both self-hosted (Docker/Railway) and Vercel-native deployment.

> **Origin:** Atlas is based on [vercel-labs/oss-data-analyst](https://github.com/vercel-labs/oss-data-analyst). The original uses Vercel Sandbox for the explore tool. We support both Vercel Sandbox and self-hosted (`just-bash`) via an adapter pattern.

### Vercel Sandbox integration
- [x] Explore tool adapter — Abstract the shell backend behind an interface: `just-bash` for self-hosted, `@vercel/sandbox` for Vercel. Same tool contract, two implementations
- [x] Sandbox lifecycle — Create sandbox on first explore call, write `semantic/` files into it, reuse for the session. Snapshot for fast cold starts
- [x] Vercel deployment — `vercel.json` or auto-detect, OIDC auth for sandbox, env var documentation
- [x] Add `@vercel/sandbox` as optional dependency — Only loaded when `ATLAS_RUNTIME=vercel` (or auto-detected via `VERCEL` env var)

### create-atlas CLI
- [x] Self-contained template — Bundle source files into the package instead of copying from parent repo via relative path (current `path.resolve(import.meta.dir, "..")` breaks on npm install)
- [x] Publish to npm — `bun create atlas-agent my-app` works from the registry
- [x] Vercel as deployment option — Add Vercel to the platform select in create-atlas, generate appropriate config
- [x] Pre-flight checks — Verify bun version, Docker availability, port conflicts before scaffolding
- [x] DB connectivity check — Verify ATLAS_DATASOURCE_URL is reachable before running `atlas init`
- [x] Smoke test — CI test that scaffolds a project, installs deps, and runs `bun run build` successfully

### Deployment configs
- [x] Health endpoint — `GET /api/health` returns DB status, provider config, semantic layer presence
- [x] Docker healthcheck — `HEALTHCHECK` instruction in Dockerfile using `/api/health`
- [x] Render support — `render.yaml` Blueprint + env var placeholders
- [x] Deploy config audit — All configs (Docker, Render, Railway, Vercel) verified against current platform docs

### atlas init hardening
- [x] Connection test first — `atlas init` pings DB and reports version/permissions before profiling
- [x] Progress output — Show table-by-table progress during profiling (not silent until done)
- [x] Graceful partial failure — If one table fails to profile, continue with others and report errors at end

### Error messages
- [x] Startup diagnostics — Clear error when ATLAS_DATASOURCE_URL is missing/unreachable, API key is missing, or provider is misconfigured
- [x] Agent-facing errors — When a SQL query fails, return the Postgres error message to the agent (not a stack trace to the user)

### Documentation
- [x] Quick start guide — Step-by-step for local dev, from zero to asking questions
- [x] Deploy guides — One page each for Railway, Render, Docker, Vercel
- [x] Bring-your-own-DB guide — How to connect Atlas to an existing production database safely

---

## v0.2.1 — Deploy Hardening (Shipped)

Fixes found during a full audit of all deploy configs against current platform documentation.

### Docker
- [x] Non-root container — Run as `nextjs` user instead of root in the runner stage
- [x] `bun ci` — Replace `bun install --frozen-lockfile` with idiomatic `bun ci`
- [x] Copy `public/` — Add missing `COPY --from=builder /app/public ./public` for static assets

### Vercel
- [x] `maxDuration` — Add `export const maxDuration = 60` to chat API route to prevent serverless timeout during multi-step agent loops

### Housekeeping
- [x] Template sync — Mirror all Dockerfile fixes to `create-atlas/template/Dockerfile`

---

## v0.2.5 — SQLite & Quick Start (SQLite removed in v0.7)

Zero-setup getting-started path. No Docker, no Postgres required.

### SQLite support
- [x] Database abstraction — `detectDBType()` dispatches to PostgreSQL or SQLite based on `ATLAS_DATASOURCE_URL`
- [x] `bun:sqlite` adapter — Synchronous queries wrapped in async `DBConnection` interface
- [x] SQL validation — Parser mode switches between `PostgresQL` and `Sqlite` (node-sql-parser)
- [x] PRAGMA/ATTACH/DETACH rejection — Added to regex forbidden patterns
- [x] SQLite profiler — `profileSQLite()` uses PRAGMA table_info, foreign_key_list
- [x] Dialect-aware virtual dimensions — `strftime()` for SQLite, `EXTRACT()` for Postgres
- [x] Agent SQLite guidance — System prompt includes dialect-specific SQL tips

### Demo data & CLI
- [x] `data/demo-sqlite.sql` — SQLite-compatible demo schema (AUTOINCREMENT, REAL)
- [x] `--demo` flag — `bun run atlas -- init --demo` seeds demo data then profiles
- [x] Startup validation — SQLite file existence check, Postgres connectivity check

### create-atlas TUI
- [x] Database choice first — SQLite (default) or PostgreSQL
- [x] SQLite demo flow — "Load demo dataset?" seeds data + generates semantic layer
- [x] Removed deployment platform question — deployment docs linked instead
- [x] Simplified success message — just `cd my-app && bun run dev`

### Documentation
- [x] README — Lead with `bun create atlas-agent`, show both SQLite and Postgres paths
- [x] .env.example — SQLite option first
- [x] Quick start — Three paths: `bun create atlas-agent`, manual SQLite, manual Postgres

---

## v0.2.8 — Provider Best Practices & Cost Control (Shipped)

Optimize LLM API usage across all providers for cost, latency, and observability.

### Prompt Caching
- [x] Anthropic cache control — System prompt + tool definitions cached with `cacheControl: { type: 'ephemeral' }`
- [x] Bedrock `bedrockAnthropic()` subprovider — Claude models on Bedrock now use full Anthropic API with cache support
- [x] Bedrock native cache points — Non-Claude models use `cachePoint: { type: 'default' }`
- [x] Dynamic per-step caching — `prepareStep` callback applies cache control to last message each step
- [x] OpenAI automatic caching — Prompt structure optimized (static content first) for built-in caching

### Agent Loop Improvements
- [x] Natural termination — loop stops when model finishes responding or step limit (25) is reached
- [x] Deterministic SQL — `temperature: 0.2` for consistent query generation
- [x] Output limit — `maxOutputTokens: 4096` per step
- [x] Timeouts — `totalMs: 180s`, `stepMs: 30s`, `chunkMs: 5s` to prevent stalled streams

### Observability
- [x] `onStepFinish` callback — Per-step token usage + cache hit/miss logging
- [x] `onFinish` callback — Aggregate stats (total tokens, cache totals, step count)

### Error Handling
- [x] Exhaustive switches — `never` default in `getModel()`, `buildSystemParam()`, `applyCacheControl()` catches missing cases at compile time
- [x] `onError` callback — Structured server-side logging with stack trace (no secrets leaked to client)
- [x] Timeout error handler — `route.ts` returns 504 with actionable message instead of generic 500
- [x] Safe observability — Optional chaining on `usage`/`totalUsage` in callbacks prevents crashes with Ollama or abort scenarios
- [x] Provider validation — `resolveProvider()` centralizes env validation with `ReadonlySet<ConfigProvider>`, throws on unknown providers

### Provider Detection
- [x] `getProviderType()` — Distinguishes 'anthropic', 'bedrock-anthropic', 'bedrock', 'openai', 'ollama', 'gateway'
- [x] Tests — 29 new tests (provider detection, cache control, buildSystemParam, immutability, invalid provider)

---

## v0.3 — Agent Quality & UI (Shipped)

Make the agent smarter and the UI worth showing in a demo.

### Agent
- [x] Error recovery — Agent retries with corrected SQL when a query fails
- [x] Multi-turn awareness — Agent references previous queries/results in follow-ups
- [x] Clarifying questions — Agent asks before querying when terms are ambiguous (glossary-driven)

### UI
- [x] Rendered data tables — Formatted numbers in styled tables
- [x] Sortable columns — Click-to-sort on data table headers
- [x] Starter prompts — Suggested questions on empty state (driven by catalog.yml `common_questions`)
- [x] Tool call visibility — Show explore/SQL steps as collapsible cards
- [x] Copy/export — Copy SQL, download CSV from executeSQL results
- [x] Dark/light theme — Respect system preference

---

## v0.4 — Semantic Layer Maturity (Shipped)

Make `atlas init` work on real-world databases, not just demos.

> Organized around two of the four integration buckets: **Stores of Data** (what you query) and **Stores of Context** (what the agent knows about your data).

### Cybersecurity SaaS demo seed
- [x] Design doc — 62-table schema for "Sentinel Security" B2B cybersecurity SaaS, 4 tech debt patterns (abandoned tables, schema evolution, missing constraints, denormalization). See `docs/design/cybersec-seed.md`
- [x] Postgres seed — `data/cybersec.sql` with full DDL, GENERATE_SERIES data (~500K rows), verified against Postgres 16
- [x] Demo integration — `atlas init --demo cybersec` flag, `DEMO_DATASETS` registry in `bin/atlas.ts`, dataset selection in `create-atlas` TUI. Backward compatible (`--demo` alone still loads simple dataset). Cybersec is PostgreSQL-only by design
- [x] Profiler improvements — FK inference from naming conventions (`inferForeignKeys`), abandoned table heuristics (`detectAbandonedTables`), enum inconsistency detection (`detectEnumInconsistency`), denormalized table detection (`detectDenormalizedTables`). Required types with empty defaults, 140 tests
- [x] Documentation — Usage guide (`docs/guides/demo-datasets.md`) with suggested questions, tech debt pattern walkthrough, loading instructions

### Stores of Data
- [x] MySQL support — `mysql2` adapter in `connection.ts`, `profileMySQL()` in `bin/atlas.ts`, parser mode `"MySQL"`. Same `DBConnection` interface pattern as PostgreSQL — zero architectural changes
- [x] Schema selection — `--schema` flag for non-`public` PostgreSQL schemas, `ATLAS_SCHEMA` env var for runtime `search_path`, schema-qualified table names in generated YAMLs and SQL validation

### Stores of Context
- [x] Schema drift detection — `atlas diff` compares live DB schema against entity YAMLs, reports column/type/FK/table changes, exits 1 for CI use
- [x] Relationship inference — `inferForeignKeys` in `bin/atlas.ts` matches `*_id` columns to tables by name (singular/plural), marks as `source: "inferred"` in generated YAML
- [x] Table filtering UX — Interactive `@clack/prompts` multiselect during `atlas init` (TTY auto-detect, fallback to `--tables`)
- [x] View profiling — `atlas init` and `atlas diff` discover and profile database views (both adapters (PostgreSQL and MySQL)). Views get `type: "view"` in YAML, skip PK/FK/measures/query_patterns. Materialized views deferred

---

## v0.5 — Production Readiness (Shipped)

What you need before handing Atlas to a real team. Prerequisites for multi-user interaction surfaces.

- [x] Test coverage — Unit tests for SQL validation (115 tests in `src/lib/tools/__tests__/sql.test.ts`)
- [x] Test coverage — Integration tests for agent loop (9 tests in `src/lib/__tests__/agent-integration.test.ts`)
- [x] Error boundaries — Graceful UI handling of API failures, DB timeouts, provider errors
- [x] Observability — Structured logging, optional trace export (OpenTelemetry)

### Authentication (Better Auth)

Three deployment patterns — Atlas should support all of them. [Better Auth](https://www.better-auth.com/) provides the framework; its plugin system covers each pattern without custom crypto.

> **Why Better Auth:** Framework-agnostic (first-class Hono integration), self-hosted (no SaaS dependency), progressive plugin system (start simple, add OAuth/roles later), handles all the session/token/JWKS pitfalls. Chosen over Auth.js (React-centric), Lucia (deprecated), and hosted services (break "deploy anywhere").

| Pattern | Who manages users | Auth state in Atlas | When to use |
|---|---|---|---|
| **Simple API key** | Nobody | `ATLAS_API_KEY` env var | Single-user self-hosted, CI/CD pipelines |
| **Atlas-managed** | Better Auth | `Internal Postgres (DATABASE_URL)` | Standalone teams, Atlas is the primary tool |
| **Bring-your-own-token** | External system (Okta, Auth0, your app) | None — stateless JWT/JWKS verification | Embedding Atlas in existing infrastructure |

- [x] Simple API key mode — `ATLAS_API_KEY` env var, timing-safe `Authorization: Bearer <key>` validation. No user model, no database. Default for single-user deploys
- [x] Better Auth integration — `better-auth` with `apiKey()` + `bearer()` plugins. Auth state in internal Postgres (`DATABASE_URL`) — isolated from the analytics database. Login/signup UI, headless REST API
- [x] BYOT (bring-your-own-token) — Stateless JWT/JWKS verification via `jose`. `ATLAS_AUTH_JWKS_URL` + `ATLAS_AUTH_ISSUER` env vars. No auth database needed
- [x] Auth mode detection — Auto-detect from config with startup diagnostics: `ATLAS_API_KEY` → simple-key; `BETTER_AUTH_SECRET` → managed; `ATLAS_AUTH_JWKS_URL` → BYOT; none → open
- [x] Query audit log — Every SQL execution logged with user identity (pino always, DB insert when `DATABASE_URL` available), timestamp, duration, row count, sensitive error scrubbing
- [x] Rate limiting — Per-user in-memory sliding-window throttle (`ATLAS_RATE_LIMIT_RPM`), disabled by default

### Explore tool isolation (self-hosted)

The explore tool runs shell commands via `just-bash`. On Vercel, `@vercel/sandbox` provides Firecracker VM isolation. On self-hosted deploys, `just-bash` runs on the same host that holds secrets (`ATLAS_DATASOURCE_URL`, API keys). Process-level isolation via nsjail closes this gap.

> **Threat model:** The primary risk is the LLM going off-rails via prompt injection, not malicious end users. Atlas users deploy against their own database. `executeSQL` is already well-scoped (agent never sees `ATLAS_DATASOURCE_URL`). The gap is the explore tool's shell access in production.

- [x] nsjail integration — Wrap `just-bash` process calls with nsjail in production. Mount `semantic/` read-only, writable tmpfs for scratch, no network access, no access to `.env` or secrets, time + memory limits per command
- [x] Auto-detection — Use nsjail when binary is on `PATH` or `ATLAS_SANDBOX=nsjail` env var is set
- [x] Dev mode warning — Log a warning when running `just-bash` without isolation in non-dev environments
- [x] Dockerfile update — Install nsjail in production Docker image (parallel build stage, opt-out via `INSTALL_NSJAIL=false`)
- [x] Platform compatibility — Resolved via sandbox sidecar ([#137](https://github.com/AtlasDevHQ/atlas/issues/137)). nsjail falls back to HTTP-isolated sidecar on Railway/Render where kernel capabilities are unavailable
- [ ] ~~Fallback~~ — Deferred to backlog. If nsjail requires unavailable capabilities on managed platforms, evaluate bubblewrap (bwrap) as alternative

| Deployment | Explore adapter | Isolation | Secret protection |
|---|---|---|---|
| Vercel | `@vercel/sandbox` | Firecracker VM | Vercel network policy + credential brokering |
| Docker / Railway / Render | `just-bash` + nsjail | Process (namespaces + seccomp) | Filesystem isolation, no network |
| Local dev | `just-bash` (raw) | None | N/A (dev mode) |

---

## v0.6 — Core API (Hono)

Standalone API server, monorepo structure, and frontend decoupling. Users can bring their own frontend (Next.js, TanStack Start, Nuxt, SvelteKit, etc.).

> **Done:** Standalone Hono API server, Bun workspace monorepo (4 packages), frontend decoupled (pure HTTP client via rewrites or cross-origin), ConnectionRegistry for multi-database, ToolRegistry for composable tool sets, `atlas.config.ts` declarative configuration, auth migration extraction, interactive enrichment prompt. Dual-process Docker entrypoint (`scripts/start.sh`). Example projects with TanStack Start client, `create-atlas --platform` support.

### Hono API server ([#33](https://github.com/AtlasDevHQ/atlas/issues/33)) ✓
- [x] New `src/api/` directory with Hono app — `POST /api/chat`, `GET /api/health`, `ALL /api/auth/*`
- [x] AI SDK integration — `result.toUIMessageStreamResponse()` works directly with Hono (zero adapter code)
- [x] Migrate `route.ts` error handling, startup diagnostics, and middleware to Hono equivalents
- [x] CORS middleware — `hono/cors`, configurable via `ATLAS_CORS_ORIGIN`
- [x] Standalone server entry point (`src/api/server.ts`) — headless API mode
- [x] Next.js catch-all proxy — transitional, keeps frontend working at same origin

### DX: Better Auth migration cleanup ([#32](https://github.com/AtlasDevHQ/atlas/issues/32)) ✓
- [x] Extract BA table migration from `validateEnvironment()` into dedicated startup hook (`src/lib/auth/migrate.ts`)
- [x] Run once on Hono server boot, not on every request
- [x] Migration error state exposed via `getMigrationError()` for diagnostic feedback

### Frontend decoupling ([#34](https://github.com/AtlasDevHQ/atlas/issues/34)) ✓
- [x] `NEXT_PUBLIC_ATLAS_API_URL` env var — same-origin default (Next.js rewrites to Hono), remote when set (cross-origin)
- [x] Next.js app becomes a thin client — `useChat()` transport points at configurable API URL, `@atlas/web` no longer depends on `@atlas/api`
- [x] Remove catch-all proxy — replaced with Next.js `rewrites()` in `next.config.ts`
- [x] Dual-process Docker entrypoint — `scripts/start.sh` starts both Hono API (:3001) and Next.js (:3000) with signal handling
- [x] Cross-origin auth — `credentials: "include"` sent only for managed auth mode, documented CORS requirements
- [ ] Document bring-your-own-frontend pattern (TanStack Start, Nuxt via `@ai-sdk/vue`, SvelteKit via `@ai-sdk/svelte`) — deferred to #38

### Connection registry ([#35](https://github.com/AtlasDevHQ/atlas/issues/35)) ✓
- [x] `ConnectionRegistry` class — `register(id, config)` / `get(id)` / `getDefault()` / `getDBType(id)` / `list()` / `_reset()`
- [x] `getDB()` backward compat — delegates to `connections.getDefault()`, lazy-inits from `ATLAS_DATASOURCE_URL`
- [x] Per-connection table whitelists in `semantic.ts` — `getWhitelistedTables(connectionId?)` with per-connection cache
- [x] `executeSQL` accepts optional `connectionId` parameter, validates connection exists before querying
- [x] `validateSQL` resolves DB type per-connection (rejects unknown connectionId instead of silent fallback)

### Tool registry ([#36](https://github.com/AtlasDevHQ/atlas/issues/36)) ✓
- [x] `ToolRegistry` class — `register(entry)` / `get(name)` / `getAll()` / `describe()` / `freeze()`
- [x] `defaultRegistry` — frozen singleton with explore, executeSQL
- [x] `runAgent()` accepts optional `tools?: ToolRegistry` parameter (defaults to `defaultRegistry`)
- [x] Dynamic system prompt composition — `registry.describe()` generates workflow section, sandwiched between prefix and suffix

### Configuration ([#37](https://github.com/AtlasDevHQ/atlas/issues/37)) ✓
- [x] `atlas.config.ts` — Declarative multi-source, multi-tool setup via Zod-validated config
- [x] `defineConfig()` type-safe authoring helper, `loadConfig()` with file discovery + env fallback
- [x] Wires into ConnectionRegistry and ToolRegistry at server boot
- [x] Env vars still work for single-DB deployments (backward compatible)

### Bun workspace monorepo ([#50](https://github.com/AtlasDevHQ/atlas/issues/50)) ✓
- [x] Split flat `src/` into 4 workspace packages: `@atlas/shared`, `@atlas/api`, `@atlas/web`, `@atlas/cli`
- [x] Workspace-scoped imports — `@atlas/api/*` for cross-package, `@/` for intra-package
- [x] Re-export shims in `@atlas/api` for shared types (zero internal import rewrites)
- [x] Next.js Turbopack build with `transpilePackages` for workspace deps
- [x] Updated Dockerfile, docker-compose, ESLint, and root scripts for monorepo layout

### Example projects ([#38](https://github.com/AtlasDevHQ/atlas/issues/38)) ✓
- [x] `examples/docker` — Hono API + Docker + optional nsjail, deploy configs (Railway, Render)
- [x] `create-atlas` template update — `--platform` flag (default: `docker`), platform selection UI
- [x] Root repo cleanup — Deploy configs moved to examples, root README updated
- [x] `examples/nextjs-standalone` — Pure Next.js/Vercel ([#59](https://github.com/AtlasDevHQ/atlas/issues/59))
- [x] `apps/www` — Static landing page at useatlas.dev, Bun static server, Railway NIXPACKS ([#64](https://github.com/AtlasDevHQ/atlas/issues/64))
- [x] Vercel deployment — `nextjs-standalone` deployed to next.useatlas.dev, GitHub auto-deploys, Railway Postgres over public TCP proxy
- [x] Domain topology — useatlas.dev (www), app (main), demo, api, next (Vercel)

### DX: Interactive enrichment ([#31](https://github.com/AtlasDevHQ/atlas/issues/31)) ✓
- [x] `atlas init` prompts for enrichment in TTY mode (instead of requiring `--enrich` flag)
- [x] Explains what enrichment does before asking
- [x] `--enrich` / `--no-enrich` flags still override (skip prompt)
- [x] Ctrl+C on prompt cleanly aborts

---

## v0.7 — Stores of Data (Shipped)

First-class data source integrations building on the v0.6 connection registry.

> **Bucket: Stores of Data** — Everything Atlas can query. Moving beyond single-database to multi-source analytics.

> **Done:** Five data source adapters (PostgreSQL, MySQL, Snowflake, ClickHouse, Salesforce/SOQL), DuckDB-backed CSV/Parquet document sources, multi-source `atlas init` profiling, per-source semantic layer with cross-source join hints, and MCP server (pulled forward from v1.0).

### Multi-database
- [x] Multiple simultaneous connections — Agent system prompt describes available sources ([#79](https://github.com/AtlasDevHQ/atlas/pull/79))
- [x] `executeSQL` accepts optional `connectionId` parameter ([#79](https://github.com/AtlasDevHQ/atlas/pull/79))

### New adapters ([#40](https://github.com/AtlasDevHQ/atlas/issues/40))
- [x] Snowflake — `snowflake-sdk` adapter + profiler ([#90](https://github.com/AtlasDevHQ/atlas/pull/90), hardened in [#95](https://github.com/AtlasDevHQ/atlas/pull/95))
- [x] ClickHouse — `@clickhouse/client` adapter + profiler ([#91](https://github.com/AtlasDevHQ/atlas/pull/91))
- [x] Salesforce (SOQL read) — `jsforce` adapter with `DataSource` interface, `querySalesforce` tool, 4-layer SOQL validation, profiler integration ([#99](https://github.com/AtlasDevHQ/atlas/pull/99))

### Documents ([#41](https://github.com/AtlasDevHQ/atlas/issues/41))
- [x] CSV/Parquet — Loaded into DuckDB in-process via `@duckdb/node-api`, `--csv` / `--parquet` flags for `atlas init` ([#97](https://github.com/AtlasDevHQ/atlas/pull/97))
- [ ] ~~Google Sheets~~ — Deferred to backlog

### Semantic layer
- [x] Per-source entity directories — Organize `semantic/entities/` by data source ([#87](https://github.com/AtlasDevHQ/atlas/pull/87))
- [x] Cross-source join hints — Describe how tables across sources relate ([#89](https://github.com/AtlasDevHQ/atlas/pull/89))
- [x] `atlas init` multi-source — Profile multiple connections in one run ([#98](https://github.com/AtlasDevHQ/atlas/pull/98))

### MCP server ([#84](https://github.com/AtlasDevHQ/atlas/issues/84)) — pulled forward from v1.0
- [x] `@atlas/mcp` package — Atlas tools (explore, executeSQL) exposed as MCP tools ([#100](https://github.com/AtlasDevHQ/atlas/pull/100))
- [x] Semantic layer as MCP resources
- [x] stdio transport (`atlas mcp` / `bun run mcp`)
- [ ] ~~Ship as `AtlasInteractionPlugin`~~ — Deferred to v1.0 Plugin SDK

---

## v0.8 — Systems of Interaction (Shipped)

How users reach Atlas beyond the web UI. All new surfaces are Hono routes on the core API from v0.6.

> **Bucket: Systems of Interaction** — Every surface where a user can ask a question and get an answer. The Hono API server from v0.6 is the single backend — new interaction surfaces are just new routes and middleware.

> **Done:** JSON query endpoint (`POST /api/v1/query`), `atlas query` CLI with table/JSON/CSV output, Slack bot (`/atlas` slash command + threaded conversations + Block Kit formatting), conversation persistence (conversations + messages in internal DB, REST API, wired into chat and query routes), test isolation fix for mock.module contamination.

### API / SDK
- [x] `POST /api/v1/query` — Synchronous JSON endpoint, API key auth ([#108](https://github.com/AtlasDevHQ/atlas/pull/108))
- [x] OpenAPI spec — Complete spec for all routes: chat, query, conversations, health ([#120](https://github.com/AtlasDevHQ/atlas/pull/120))
- [ ] ~~TypeScript SDK~~ — Deferred to backlog
- [ ] ~~Python SDK~~ — Deferred to backlog

### CLI
- [x] `atlas query "question"` — Table, JSON, CSV, quiet output modes, `--connection` flag ([#112](https://github.com/AtlasDevHQ/atlas/pull/112))

### Slack bot ([#110](https://github.com/AtlasDevHQ/atlas/issues/110))
- [x] `/atlas` slash command + threaded conversations ([#113](https://github.com/AtlasDevHQ/atlas/pull/113))
- [x] Block Kit formatting for tables and reports
- [x] OAuth app install flow + single-workspace fallback
- [x] Hono routes at `/api/slack/*` (conditional on `SLACK_SIGNING_SECRET`)

### Microsoft Teams
- [ ] ~~Bot Framework adapter~~ — Deferred to backlog

### Conversation persistence ([#109](https://github.com/AtlasDevHQ/atlas/issues/109))
- [x] `conversations` + `messages` tables in internal DB ([#114](https://github.com/AtlasDevHQ/atlas/pull/114))
- [x] CRUD module + REST API (`GET/DELETE /api/v1/conversations`)
- [x] Wired into chat (`x-conversation-id` header) and query routes
- [x] Graceful degradation without `DATABASE_URL`

### Infrastructure
- [x] Test isolation — Fixed mock.module cross-file contamination ([#115](https://github.com/AtlasDevHQ/atlas/pull/115))

---

## v0.8.1 — Infrastructure & Quality (Shipped)

Post-v0.8 hardening: sandbox isolation for managed platforms, shared UI package, benchmark harness, and deployment cleanup.

### Sandbox & isolation
- [x] Sandbox architecture design doc — Threat model, tier system, sidecar design, credential brokering plan ([#116](https://github.com/AtlasDevHQ/atlas/pull/116))
- [x] Sidecar explore backend — `packages/sandbox-sidecar/` HTTP-isolated service for Railway/Render where nsjail can't run ([#118](https://github.com/AtlasDevHQ/atlas/pull/118))
- [x] nsjail startup diagnostic — Probes kernel capabilities at boot, logs specific failure reason, auto-falls back with clear warning ([#27](https://github.com/AtlasDevHQ/atlas/issues/27))
- [x] nsjail Docker build fixes — Match trixie base, fix libprotobuf, add ca-certificates, remove deprecated `--clone_newnet`
- [x] Pin sidecar Dockerfile — `bun:1.3.10-debian` for reproducible builds ([#122](https://github.com/AtlasDevHQ/atlas/pull/122))
- [x] Add sandbox-sidecar workspace to Dockerfiles ([#125](https://github.com/AtlasDevHQ/atlas/pull/125))
- [x] Sidecar bundled in create-atlas templates — docker template ships with `sidecar/` directory ([#137](https://github.com/AtlasDevHQ/atlas/issues/137), [#138](https://github.com/AtlasDevHQ/atlas/pull/138))

### Shared UI
- [x] `@atlas/ui` package — Extract ~1000 lines of shared chat UI into source-only workspace package: `AtlasChat` component, 14 chat sub-components, chart detection, conversation sidebar, hooks, helpers ([#124](https://github.com/AtlasDevHQ/atlas/pull/124), [#123](https://github.com/AtlasDevHQ/atlas/issues/123))
- [x] Frontend migration — `packages/web` and `examples/nextjs-standalone` consume shared UI components

### Quality & DX
- [x] BIRD benchmark harness — `atlas benchmark` CLI with BIRD dataset support, per-query timing, accuracy scoring ([#121](https://github.com/AtlasDevHQ/atlas/pull/121), [#85](https://github.com/AtlasDevHQ/atlas/issues/85))
- [x] Action framework design revision — Non-blocking approval, single registry, safety gap analysis ([#44](https://github.com/AtlasDevHQ/atlas/issues/44))

### Deployment
- [x] Railway sidecar deploy — `railway.json` + multi-service config for sandbox sidecar ([#136](https://github.com/AtlasDevHQ/atlas/pull/136), [#126](https://github.com/AtlasDevHQ/atlas/issues/126))
- [x] Railway marketplace templates — One-click deploy templates for demo and BYOD production ([#143](https://github.com/AtlasDevHQ/atlas/pull/143), [#144](https://github.com/AtlasDevHQ/atlas/issues/144), [#145](https://github.com/AtlasDevHQ/atlas/pull/145))
- [x] Fix TanStack Start static assets — Serve `/assets/` correctly in production server
- [x] Fix demo.useatlas.dev — Add API reverse proxy to TanStack Start production server

### Demo data
- [x] E-commerce seed dataset — 52-table DTC home goods company ("NovaMart"), ~480K rows, 4 tech debt patterns. `--demo ecommerce` flag ([ca7e395](https://github.com/AtlasDevHQ/atlas/commit/ca7e395))

### Housekeeping
- [x] Remove Fly.io deployment configs — Deleted `fly.toml` files, updated all docs, templates, and marketing copy ([#128](https://github.com/AtlasDevHQ/atlas/pull/128), [#127](https://github.com/AtlasDevHQ/atlas/issues/127))
- [x] Health check audit — Fix stale nsjail backend reporting after capability failure
- [x] Portless dev URLs — Stable `.localhost` URLs via portless reverse proxy, random ports ([#134](https://github.com/AtlasDevHQ/atlas/pull/134))
- [x] Brand assets — Prism logo and brand identity ([#140](https://github.com/AtlasDevHQ/atlas/pull/140))
- [x] BYOD multi-source architecture design doc — Three-tier source taxonomy (DataSource, ActionTarget, InteractionSurface) spanning v0.7–v1.0
- [x] Fix BYOT startup — JWKS reachability check is now a non-blocking warning ([#139](https://github.com/AtlasDevHQ/atlas/pull/139))

---

## v0.9 — Systems of Action (Shipped)

Write-back tools with a safety framework. Most security-sensitive milestone.

> **Bucket: Systems of Action** — Things Atlas can *do* beyond answering questions. Every action requires explicit user approval. Interaction adapters from v0.8 provide the confirmation flows.
>
> **Design doc:** `docs/design/action-framework.md` (revised in v0.8.1 — non-blocking approval, single registry, safety gap analysis)

### Phase 1: Action framework core ([#129](https://github.com/AtlasDevHQ/atlas/issues/129)) — Shipped
- [x] `AtlasAction` extends `AtlasTool` in existing `ToolRegistry` (single registry, `isAction()` type guard)
- [x] `action_log` table + `logActionAudit()` (mirrors query audit pattern)
- [x] `handleAction()` — persist pending, approval check, execution, audit logging
- [x] Atomic approve/deny with CAS (`UPDATE ... WHERE status = 'pending'`, 409 on conflict)
- [x] Action config schema in `atlas.config.ts` (Zod) + `ATLAS_ACTIONS_ENABLED` master switch
- [x] Startup validation: reject `none` auth + actions, check credentials, warn on high-risk auto-approve

### Phase 2: Slack notification + web UI approval ([#130](https://github.com/AtlasDevHQ/atlas/issues/130)) — Shipped
- [x] `sendSlackMessage` action tool (reuses v0.8 `postMessage()` infrastructure)
- [x] Non-blocking approval: tool returns `pending_approval`, resolves in next turn
- [x] Web UI `ActionApprovalCard` with Approve/Deny buttons
- [x] `POST /api/v1/actions/:id/approve|deny|rollback` Hono routes
- [x] Rollback via `chat.delete`

### Phase 3: Multi-surface approval ([#131](https://github.com/AtlasDevHQ/atlas/issues/131)) — Shipped
- [x] CLI: Terminal approve/deny prompt + `--auto-approve` flag ([#147](https://github.com/AtlasDevHQ/atlas/pull/147))
- [x] JSON API: `pendingActions` in response, separate approve/deny endpoints ([#147](https://github.com/AtlasDevHQ/atlas/pull/147))
- [x] Slack bot: Ephemeral Block Kit approval buttons ([#147](https://github.com/AtlasDevHQ/atlas/pull/147))

### Phase 4: Additional actions + permissions ([#132](https://github.com/AtlasDevHQ/atlas/issues/132), [#133](https://github.com/AtlasDevHQ/atlas/issues/133))
- [x] `createJiraTicket` — JIRA REST API v3 with project/labels config ([#146](https://github.com/AtlasDevHQ/atlas/pull/146))
- [x] `sendEmailReport` — SMTP / SendGrid / SES abstraction ([#146](https://github.com/AtlasDevHQ/atlas/pull/146))
- [x] Role-based permissions — `permissions.ts` with `canApprove()`, per-tool `requiredRole` config ([#148](https://github.com/AtlasDevHQ/atlas/pull/148))
- [x] Role extraction across auth modes — `ATLAS_API_KEY_ROLE`, BYOT JWT claim extraction (dot-path), Better Auth role field ([#148](https://github.com/AtlasDevHQ/atlas/pull/148))

### Deferred
- [ ] ~~Salesforce updates~~ — Write-back needs own design spike (read path shipped in v0.7)
- [ ] ~~Scheduled actions~~ — Cron-driven reports, threshold alerts — deferred to v0.9.1+

---

## v1.0 — Platform: Integration Builder (Shipped)

Plugin system. First-class integrations from v0.7–v0.9 proved the interfaces; now open them up.

> The plugin SDK formalizes the four bucket interfaces so third parties can extend Atlas without forking it. Each plugin type corresponds to one bucket. Architecture follows the Better Auth plugin model: plugin = factory function returning a typed config object, registered via a plugin array in `atlas.config.ts`. See `docs/design/plugin-architecture.md` for the full design.

### Plugin SDK ([#45](https://github.com/AtlasDevHQ/atlas/issues/45))
- [x] `@useatlas/plugin-sdk` package with four interfaces: `AtlasDatasourcePlugin`, `AtlasContextPlugin`, `AtlasInteractionPlugin`, `AtlasActionPlugin` ([#153](https://github.com/AtlasDevHQ/atlas/pull/153))
- [x] Plugin lifecycle — `initialize(ctx)`, `healthCheck()`, `teardown()` ([#153](https://github.com/AtlasDevHQ/atlas/pull/153))
- [x] Configuration via `atlas.config.ts` plugin array ([#153](https://github.com/AtlasDevHQ/atlas/pull/153))
- [x] `definePlugin()` factory with runtime validation + type guards ([#153](https://github.com/AtlasDevHQ/atlas/pull/153))
- [x] Runtime wiring — plugin tools into agent, hook dispatch, context plugin wiring ([#158](https://github.com/AtlasDevHQ/atlas/pull/158))
- [x] `$InferServerPlugin` pattern — client plugins infer types from server plugins (zero codegen) ([#199](https://github.com/AtlasDevHQ/atlas/pull/199))
- [x] Schema-driven migrations — plugins declare DB tables, `atlas migrate` generates and applies ([#181](https://github.com/AtlasDevHQ/atlas/pull/181))
- [x] Plugin hooks should support mutation, not just observation ([#164](https://github.com/AtlasDevHQ/atlas/issues/164), [#176](https://github.com/AtlasDevHQ/atlas/pull/176))
- [x] Typed plugin configuration via factory pattern ([#165](https://github.com/AtlasDevHQ/atlas/issues/165), [#177](https://github.com/AtlasDevHQ/atlas/pull/177))
- [x] Replace `unknown` escape hatches with optional peer dep types ([#166](https://github.com/AtlasDevHQ/atlas/issues/166), [#179](https://github.com/AtlasDevHQ/atlas/pull/179))
- [x] Datasource plugins should ship semantic layer fragments ([#167](https://github.com/AtlasDevHQ/atlas/issues/167), [#178](https://github.com/AtlasDevHQ/atlas/pull/178))
- [x] Validate plugin shapes in config loader ([#168](https://github.com/AtlasDevHQ/atlas/issues/168))

### CLI ([#151](https://github.com/AtlasDevHQ/atlas/issues/151)) — Shipped
- [x] `atlas plugin add` / `atlas plugin list` / `atlas plugin create` ([#184](https://github.com/AtlasDevHQ/atlas/pull/184))
- [x] `atlas migrate` / `atlas migrate --apply` — plugin schema migrations ([#181](https://github.com/AtlasDevHQ/atlas/pull/181))

### MCP server ([#84](https://github.com/AtlasDevHQ/atlas/issues/84)) — shipped in v0.7, refactored as plugin
- [x] `@atlas/mcp` package — tools + resources + stdio transport ([#100](https://github.com/AtlasDevHQ/atlas/pull/100))
- [x] SSE transport for remote clients ([#200](https://github.com/AtlasDevHQ/atlas/pull/200))
- [x] Refactor as `AtlasInteractionPlugin` reference implementation ([#186](https://github.com/AtlasDevHQ/atlas/pull/186))

### Reference implementations ([#150](https://github.com/AtlasDevHQ/atlas/issues/150)) — Shipped (4/4 types)
- [x] Salesforce adapter — SOQL read adapter shipped as first-class integration in v0.7 ([#99](https://github.com/AtlasDevHQ/atlas/pull/99)). Refactor as `DataSourcePlugin` when SDK stabilizes
- [x] ClickHouse `DataSourcePlugin` — Reference datasource plugin with semantic layer fragments and dialect hints ([#180](https://github.com/AtlasDevHQ/atlas/pull/180))
- [x] JIRA `ActionPlugin` — Reference action plugin with `createJiraTicket` tool ([#182](https://github.com/AtlasDevHQ/atlas/pull/182))
- [x] YAML `ContextPlugin` — Reference context plugin wrapping semantic layer directory ([#185](https://github.com/AtlasDevHQ/atlas/pull/185))
- [x] MCP `InteractionPlugin` — Reference interaction plugin wrapping MCP server ([#186](https://github.com/AtlasDevHQ/atlas/pull/186))

### Additional plugin extractions — Shipped
- [x] MySQL `DataSourcePlugin` ([#187](https://github.com/AtlasDevHQ/atlas/issues/187), [#196](https://github.com/AtlasDevHQ/atlas/pull/196))
- [x] Snowflake `DataSourcePlugin` ([#188](https://github.com/AtlasDevHQ/atlas/issues/188), [#197](https://github.com/AtlasDevHQ/atlas/pull/197))
- [x] DuckDB `DataSourcePlugin` ([#189](https://github.com/AtlasDevHQ/atlas/issues/189), [#196](https://github.com/AtlasDevHQ/atlas/pull/196))
- [x] Email `ActionPlugin` ([#190](https://github.com/AtlasDevHQ/atlas/issues/190), [#195](https://github.com/AtlasDevHQ/atlas/pull/195))
- [x] Slack `InteractionPlugin` ([#191](https://github.com/AtlasDevHQ/atlas/issues/191), [#198](https://github.com/AtlasDevHQ/atlas/pull/198))

### Sandbox plugins — Shipped
- [x] `SandboxPlugin` type for pluggable explore backends ([#192](https://github.com/AtlasDevHQ/atlas/issues/192), [#201](https://github.com/AtlasDevHQ/atlas/pull/201))
- [x] Sidecar `SandboxPlugin` — extract from built-in backend ([#204](https://github.com/AtlasDevHQ/atlas/pull/204))
- [x] Vercel `SandboxPlugin` — extract from built-in backend ([#205](https://github.com/AtlasDevHQ/atlas/pull/205))
- [x] E2B `SandboxPlugin` ([#206](https://github.com/AtlasDevHQ/atlas/pull/206))
- [x] Daytona `SandboxPlugin` ([#207](https://github.com/AtlasDevHQ/atlas/pull/207))
- [x] nsjail `SandboxPlugin` — extract from built-in backend ([#202](https://github.com/AtlasDevHQ/atlas/issues/202))
- [x] Move plugins to top-level `plugins/` directory ([#212](https://github.com/AtlasDevHQ/atlas/issues/212), [#213](https://github.com/AtlasDevHQ/atlas/pull/213))

### Developer experience
- [x] Plugin scaffolding — `atlas plugin create my-plugin --type data-source` ([#184](https://github.com/AtlasDevHQ/atlas/pull/184))
- [x] Plugin documentation and contribution guide ([#208](https://github.com/AtlasDevHQ/atlas/pull/208))

---

## v1.1 — Admin Console ([#260](https://github.com/AtlasDevHQ/atlas/issues/260))

Operator UI for managing Atlas. Embedded in `packages/web` under `/admin/*` (role-gated to `admin`). Admin API at `/api/v1/admin/*`.

> **Decision:** Embed in the existing Next.js app for Phase 1 — no new package, no new build/deploy. Extract to `apps/console` later if the surface grows. See [#260](https://github.com/AtlasDevHQ/atlas/issues/260) for full design.

### Phase 1: Read-only — Shipped
- [x] Admin API routes (`/api/v1/admin/*`) — semantic layer, connections, audit, plugins, overview ([#262](https://github.com/AtlasDevHQ/atlas/pull/262))
- [x] Admin UI shell — sidebar layout, role gate, dark mode ([#261](https://github.com/AtlasDevHQ/atlas/pull/261))
- [x] Semantic layer browser — entity list, detail panel, glossary, metrics, multi-connection filter ([#261](https://github.com/AtlasDevHQ/atlas/pull/261))
- [x] Connection manager — health status, table whitelists, test probe ([#265](https://github.com/AtlasDevHQ/atlas/pull/265))
- [x] Audit log viewer — filterable table with date range, user, error toggle ([#265](https://github.com/AtlasDevHQ/atlas/pull/265))
- [x] Plugin registry — card grid with health checks ([#265](https://github.com/AtlasDevHQ/atlas/pull/265))
- [x] Scheduled tasks + Action queue — wraps existing `/api/v1/` routes ([#265](https://github.com/AtlasDevHQ/atlas/pull/265))
- [x] Better Auth admin plugin — first-user bootstrap, role management
- [x] Railway deploy split — separate API, Web, WWW, Sidecar services in `deploy/` ([#264](https://github.com/AtlasDevHQ/atlas/pull/264))

### Phase 2: Write operations (future)
- [ ] Semantic layer editing — YAML write-back with git diff preview
- [ ] Connection CRUD — register new datasources from UI
- [ ] Plugin config editing
- [ ] User management — Better Auth `organization()` plugin
- [ ] Validation preview — "what will the agent see for this question?"

---

## v1.2 — Public Launch & Plugin Refactor (Shipped)

Public repo release, adapter extraction into plugins, starter automation, and deploy buttons.

> **Context:** Atlas moved to a public repo (`AtlasDevHQ/atlas`). Issue numbers below reference the new public repo.

### Public release
- [x] Initial public release — monorepo published to GitHub ([f5f5e42](https://github.com/AtlasDevHQ/atlas/commit/f5f5e42))
- [x] Admin user management — default password enforcement ([#1](https://github.com/AtlasDevHQ/atlas/pull/1))
- [x] Vercel deploy button — one-click deploy with Neon + AI Gateway ([#2](https://github.com/AtlasDevHQ/atlas/issues/2), [#3](https://github.com/AtlasDevHQ/atlas/pull/3))
- [x] `@useatlas/sdk` and `@useatlas/plugin-sdk` bumped to 0.0.2 for fresh publish

### Adapter plugin refactor ([#11](https://github.com/AtlasDevHQ/atlas/issues/11), [#13](https://github.com/AtlasDevHQ/atlas/issues/13))
- [x] Plugin SDK: `parserDialect` and `forbiddenPatterns` on datasource plugins ([#14](https://github.com/AtlasDevHQ/atlas/issues/14), [#23](https://github.com/AtlasDevHQ/atlas/pull/23))
- [x] `validateSQL` and `ConnectionRegistry` made plugin-aware ([#15](https://github.com/AtlasDevHQ/atlas/issues/15), [#25](https://github.com/AtlasDevHQ/atlas/pull/25))
- [x] Agent dialect system made plugin-driven ([#16](https://github.com/AtlasDevHQ/atlas/issues/16), [#24](https://github.com/AtlasDevHQ/atlas/pull/24))
- [x] ClickHouse plugin: parserDialect, forbiddenPatterns, validation ([#17](https://github.com/AtlasDevHQ/atlas/issues/17), [#26](https://github.com/AtlasDevHQ/atlas/pull/26))
- [x] Snowflake plugin: parserDialect, forbiddenPatterns, validation ([#18](https://github.com/AtlasDevHQ/atlas/issues/18), [#27](https://github.com/AtlasDevHQ/atlas/pull/27))
- [x] DuckDB datasource plugin ([#19](https://github.com/AtlasDevHQ/atlas/issues/19), [#28](https://github.com/AtlasDevHQ/atlas/pull/28))
- [x] Salesforce datasource plugin ([#20](https://github.com/AtlasDevHQ/atlas/issues/20), [#31](https://github.com/AtlasDevHQ/atlas/pull/31))
- [x] Strip adapter code from core — plugins own their adapters ([#21](https://github.com/AtlasDevHQ/atlas/issues/21), [#32](https://github.com/AtlasDevHQ/atlas/pull/32))
- [x] Adapter tests moved to plugins + integration tests ([#22](https://github.com/AtlasDevHQ/atlas/issues/22))
- [x] Fix: anchor ClickHouse forbidden patterns to avoid false positives ([#29](https://github.com/AtlasDevHQ/atlas/issues/29), [#30](https://github.com/AtlasDevHQ/atlas/pull/30))

### Starter automation
- [x] Template sync with monorepo source ([#4](https://github.com/AtlasDevHQ/atlas/issues/4))
- [x] Starter template repo for deploy button ([#5](https://github.com/AtlasDevHQ/atlas/issues/5))
- [x] CI: automate atlas-starter sync from monorepo ([#7](https://github.com/AtlasDevHQ/atlas/issues/7), [#8](https://github.com/AtlasDevHQ/atlas/issues/8), [#34](https://github.com/AtlasDevHQ/atlas/issues/34), [#35](https://github.com/AtlasDevHQ/atlas/pull/35))
- [x] CI: template drift check ([#9](https://github.com/AtlasDevHQ/atlas/pull/9), [#10](https://github.com/AtlasDevHQ/atlas/pull/10))
- [x] Platform-specific READMEs with deploy buttons ([#12](https://github.com/AtlasDevHQ/atlas/issues/12), [#33](https://github.com/AtlasDevHQ/atlas/pull/33))
- [x] Fix: sync starters post adapter strip ([#36](https://github.com/AtlasDevHQ/atlas/pull/36), [#37](https://github.com/AtlasDevHQ/atlas/pull/37), [#38](https://github.com/AtlasDevHQ/atlas/pull/38))

---

## v1.3 — Python Data Science Sandbox (Shipped)

`executePython` tool — sandboxed Python execution for data analysis, visualization, and transformation. Runs pandas, matplotlib, seaborn in isolation alongside SQL.

### Core tool
- [x] `executePython` tool definition with import guard + just-bash backend ([#43](https://github.com/AtlasDevHQ/atlas/issues/43), [#46](https://github.com/AtlasDevHQ/atlas/pull/46))
- [x] Replace just-bash backend with sidecar execution ([#40](https://github.com/AtlasDevHQ/atlas/issues/40), [#47](https://github.com/AtlasDevHQ/atlas/pull/47))
- [x] Wire executePython results into chat UI — chart rendering ([#41](https://github.com/AtlasDevHQ/atlas/issues/41), [#48](https://github.com/AtlasDevHQ/atlas/pull/48))
- [x] Agent prompt tuning for Python tool usage ([#44](https://github.com/AtlasDevHQ/atlas/issues/44), [#49](https://github.com/AtlasDevHQ/atlas/pull/49))

### Sandbox backends
- [x] nsjail Python sandbox backend ([#42](https://github.com/AtlasDevHQ/atlas/issues/42), [#50](https://github.com/AtlasDevHQ/atlas/pull/50))
- [x] Vercel sandbox Python backend ([#45](https://github.com/AtlasDevHQ/atlas/issues/45), [#51](https://github.com/AtlasDevHQ/atlas/pull/51))

---

## Backlog

Triaged. Items below are committed — tracked on the [project board](https://github.com/orgs/AtlasDevHQ/projects/1). Closed items listed for historical context.

### Active

(No active backlog items — all current work tracked under milestones above)

### Shipped

- ~~**Public beta prep**~~ — Package, publish, and document Atlas for public release ([#215](https://github.com/AtlasDevHQ/atlas/issues/215), shipped as v1.2)
- ~~**Vercel Cron integration**~~ — Native cron scheduling for Vercel deployments ([#258](https://github.com/AtlasDevHQ/atlas/issues/258), [#266](https://github.com/AtlasDevHQ/atlas/pull/266))
- ~~**Platform-aware scaffolding**~~ — Smart sandbox defaults per deploy target in `create-atlas` ([#267](https://github.com/AtlasDevHQ/atlas/issues/267), [#268](https://github.com/AtlasDevHQ/atlas/pull/268))
- ~~**Production eval pipeline**~~ — 48 curated cases, baseline regression detection, CI integration ([#242](https://github.com/AtlasDevHQ/atlas/issues/242), [#257](https://github.com/AtlasDevHQ/atlas/pull/257))
- ~~**Scheduled actions**~~ — Cron-driven reports with email/Slack/webhook delivery ([#233](https://github.com/AtlasDevHQ/atlas/issues/233), [#256](https://github.com/AtlasDevHQ/atlas/pull/256))
- ~~**Materialized views & partitioned tables**~~ — Profiler support for matviews and partition-aware hints ([#239](https://github.com/AtlasDevHQ/atlas/issues/239), [#254](https://github.com/AtlasDevHQ/atlas/pull/254))
- ~~**Row-level security**~~ — Automatic WHERE clause injection by user identity/role ([#236](https://github.com/AtlasDevHQ/atlas/issues/236), [#263](https://github.com/AtlasDevHQ/atlas/pull/263))
- ~~**BYOF documentation**~~ — Nuxt, SvelteKit, React/Vite, TanStack Start guides ([#240](https://github.com/AtlasDevHQ/atlas/issues/240), [#253](https://github.com/AtlasDevHQ/atlas/pull/253))
- ~~**E2E integration test suite**~~ — Full coverage: smoke harness, shared helpers, auth matrix, Slack, actions, MCP, multi-datasource, conversations, scaffold, CI jobs ([#217](https://github.com/AtlasDevHQ/atlas/issues/217), [#216](https://github.com/AtlasDevHQ/atlas/issues/216), [#218](https://github.com/AtlasDevHQ/atlas/issues/218)–[#226](https://github.com/AtlasDevHQ/atlas/issues/226), PRs [#251](https://github.com/AtlasDevHQ/atlas/pull/251), [#271](https://github.com/AtlasDevHQ/atlas/pull/271)–[#277](https://github.com/AtlasDevHQ/atlas/pull/277))
- ~~**Conversation CRUD error handling**~~ — ([#245](https://github.com/AtlasDevHQ/atlas/issues/245), [#250](https://github.com/AtlasDevHQ/atlas/pull/250))
- ~~**Remove finalizeReport tool**~~ — ([#243](https://github.com/AtlasDevHQ/atlas/issues/243), [#252](https://github.com/AtlasDevHQ/atlas/pull/252))
- ~~**Explicit auth mode**~~ — `ATLAS_AUTH_MODE` env var for deterministic auth selection ([#214](https://github.com/AtlasDevHQ/atlas/pull/214))
- ~~**Saved queries**~~ — ([#228](https://github.com/AtlasDevHQ/atlas/issues/228), [#241](https://github.com/AtlasDevHQ/atlas/pull/241))
- ~~**TypeScript SDK**~~ — ([#227](https://github.com/AtlasDevHQ/atlas/issues/227), [#247](https://github.com/AtlasDevHQ/atlas/pull/247))
- ~~**Pre-index semantic layer**~~ — ([#163](https://github.com/AtlasDevHQ/atlas/issues/163), [#210](https://github.com/AtlasDevHQ/atlas/pull/210))
- ~~**Non-SQL datasources**~~ — ([#169](https://github.com/AtlasDevHQ/atlas/issues/169), [#246](https://github.com/AtlasDevHQ/atlas/pull/246))
- ~~**Simplification sweep**~~ — Consolidate packages, pick Next.js, narrow deploy surface, simplify auth ([#170](https://github.com/AtlasDevHQ/atlas/issues/170)–[#173](https://github.com/AtlasDevHQ/atlas/issues/173))

### Won't do

- ~~**RAG over semantic layer**~~ — Pre-indexing solved this differently
- ~~**Multi-agent**~~ — Single-agent loop is sufficient
- ~~**OSI compatibility**~~ — No traction; Atlas YAML format is the standard
- ~~**Community sandbox plugins**~~ — 6 sandbox plugins shipped; Plugin SDK is open for community
- ~~**Google Sheets data source**~~ — DuckDB CSV/Parquet covers flat-file use cases
- ~~**Microsoft Teams bot**~~ — Plugin SDK enables community to build this
- ~~**Salesforce write-back**~~ — Read adapter shipped; write-back buildable as ActionPlugin
- ~~**Postgres extensions (pgvector, PostGIS)**~~ — Profiler handles unknown types; users can add YAML hints
- ~~**Additional seed datasets**~~ — 3 seeds (simple, cybersec, ecommerce) are sufficient
- ~~**Skills/methodology plugins**~~ — Premature; Plugin SDK already supports the pattern
- ~~**Python SDK**~~ — REST API and MCP server cover programmatic access

---

## Status Key

- [x] Shipped
- [ ] Planned (in a versioned milestone)
- Backlog items have no checkbox — they're ideas, not commitments
