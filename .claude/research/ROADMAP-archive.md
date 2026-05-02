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

---

# Public-semver archive (0.6.0 → 1.2.2)

> Moved here from `ROADMAP.md` during 2026-04-24 tidy. These milestones are all closed; the current `ROADMAP.md` keeps compact one-line summaries and links back here for detail. Issue + PR bodies remain the canonical source of truth.

## 0.6.0 — Governance & Operational Hardening

**SaaS prerequisite: operators must trust Atlas with real workloads before it can be a hosted product.** Close half-built gaps, add governance primitives, and harden for multi-user production environments.

### Finish Half-Built Infrastructure

These are already partially implemented in the codebase — reserve status, DB schema, or env var parsing exists, but enforcement doesn't.

- [x] Action timeout enforcement (#448, PR #468) — enforce `ATLAS_ACTION_TIMEOUT` in action executor, transition to `timed_out` status after expiry
- [x] Rollback API for actions (#451, PR #476) — `POST /api/v1/actions/:id/rollback` endpoint, `rolled_back` status, admin UI rollback button, SDK `rollbackAction()`
- [x] Configurable agent step limit (#449, PR #467) — `ATLAS_AGENT_MAX_STEPS` env var (default 25, range 1–100)
- [x] Configurable Python blocked imports (#452, PR #472) — `python.blockedModules` and `python.allowModules` config arrays with critical module protection
- [x] Configurable explore backend priority (#453, PR #474) — `sandbox.priority` config array overrides hardcoded backend selection order

### Access Control

- [x] RLS improvements (#456, PR #488) — multi-column policies, array claim support, OR-logic between policies
- [x] Session management (#457, PR #501) — admin + user session listing, revoke individual/all, idle and absolute timeout policies, admin UI page
- [x] Social provider setup guide (#463, PR #486) — Google, GitHub, Microsoft

### Audit & Compliance

- [x] Audit log improvements (#458, PR #487, #493) — CSV export, full-text search, connection/table filtering
- [x] Data classification tags on query audit trails (#460, PR #498) — `tables_accessed` and `columns_accessed` arrays extracted from validated AST, stored with audit entries, filterable in admin UI

### Plugin Ecosystem

- [x] Replace `unknown` escape hatches with typed optional peer deps (#454, PR #473) — `@useatlas/plugin-sdk/ai` and `@useatlas/plugin-sdk/hono` type re-exports with optional peer deps
- [x] Plugin hooks: `beforeToolCall` / `afterToolCall` (#450, PR #469) — allow plugins to intercept agent tool decisions. Enables compliance gates, cost controls, and custom routing
- [x] Custom query validation hook on `PluginDBConnection` (#455, PR #475) — async `validate?(query: string)` for non-SQL datasources. Replaces `validateSQL` when present

### SDK Surface

- [x] `validateSQL(sql)` (#461, PR #485) — `POST /api/v1/validate-sql` endpoint + SDK method. Validates without executing
- [x] `getAuditLog()` (#462, PR #485) — SDK method wrapping admin audit endpoint with filters

### Collaboration

- [x] Semantic layer diff in UI (#464, PR #503) — `GET /api/v1/admin/semantic/diff` endpoint, admin UI page with color-coded diff (new/removed/changed tables and columns), multi-connection support

### Integrations

- [x] Microsoft Teams interaction plugin (#465, PR #499) — `@useatlas/teams` with Bot Framework messaging, Adaptive Cards, JWT verification, @mention handling
- [x] Webhook interaction plugin (#459, PR #500) — `@useatlas/webhook` with API key + HMAC auth, sync and async modes, structured JSON responses
- [x] Email digest plugin (#466, PR #502) — `@useatlas/email-digest` with subscription CRUD, daily/weekly scheduling, multi-metric aggregation, HTML email templates

---

## 0.7.0 — Performance & Multi-Tenancy

**SaaS prerequisite: a hosted product needs to serve multiple customers efficiently on shared infrastructure.** No backwards compatibility needed — zero external users, rip and replace freely. Better Auth organization plugin provides the tenant boundary; everything scopes to `activeOrganizationId`.

### Organization Foundation (P0 — do first, everything depends on this)

- [x] Better Auth organization plugin (#514, PR #517) — `organization()` plugin with `activeOrganizationId` on session, org CRUD + member management + invitations, RBAC (owner/admin/member), org switcher UI, first-run org creation flow, all data endpoints scoped to active org

### Caching

- [x] Query result caching (#504, PR #521) — LRU cache with SHA-256 keys (SQL + orgId + connectionId + claims), configurable TTL, admin flush endpoint, plugin hook for external backends (Redis), cache hit/miss headers
- [x] Cache admin UI (#505, PR #527) — admin page with hit rate, entry count, max size, TTL, and flush button with confirmation dialog

### Semantic Layer Indexing

- [x] Pre-computed semantic index at boot (#506, PR #515) — keyword extraction from entities, inverted index, relevant subset injected into agent system prompt based on question keywords
- [x] `atlas index` CLI command (#507, PR #533) — rebuild semantic index on demand with summary stats, `--stats` flag for read-only info

### Multi-Tenancy (all depend on #514)

- [x] Org-scoped semantic layers (#508, PR #524) — DB-backed `semantic_entities` table keyed by orgId, admin CRUD API, file YAML import as seed, org-scoped table whitelist in SQL validation
- [x] Org-scoped explore tool (#522, PR #525) — DB-backed filesystem with dual-write sync layer, atomic file writes, per-org backend caching in explore tool, sidecar cwd support, boot reconciliation
- [x] `atlas init` dual-write + import (#523, PR #526) — disk→DB import endpoint, `atlas import` CLI command, org-scoped `atlas init` with auto-import, first-boot auto-import from disk
- [x] Org-scoped connection pooling (#509, PR #529) — per-org pool isolation keyed by orgId + connectionId, lazy creation, configurable limits, health-based drain, per-org metrics via admin API
- [x] Org isolation validation (#510, PR #528) — 27 tests proving SQL whitelist, semantic index, cache keys, explore root, conversations, and audit never cross org boundaries
- [x] Pool capacity guard bug (#530, PR #534) — capacity check now includes org pool slots, config validation warns on overcapacity
- [x] Tenant pool integration tests (#531, PR #534) — org routing tests in sql.test.ts, admin pool endpoint tests, config validation tests
- [x] Pool misconfiguration health check (#536, PR #537) — surface capacity warnings in admin health endpoint
- [x] Shared connection mock factory (#535, PR #538) — reduce test maintenance burden across 20+ test files
- [x] Fix hooks-integration and custom-validation tests (#532) — already fixed by shared mock factory (PR #538)

### Infrastructure

- [x] Connection pooling improvements (#511, PR #516) — warmup at startup, health-based drain on error threshold, pool metrics (active/idle/waiting) exposed via admin API and health dashboard
- [x] Streaming Python execution output (#512) — progressive stdout chunks and chart renders via sidecar SSE protocol

### Learning (Phase 1)

- [x] `atlas learn` CLI (#513, PR #540) — offline batch process that reviews audit log, proposes YAML amendments (new `query_patterns`, join discoveries, glossary refinements). Human reviews the diff, commits what's useful. Zero runtime overhead, no DB dependency

---

## 0.7.x Refinement Arc

**Quality pass after a 27-issue sprint.** Systematic review of everything shipped in 0.7.0 — code smells, docs, type safety, error handling, test gaps. Same pattern as 0.5.x (4 point releases of polish).

### 0.7.1 — Immediate Cleanup

- [x] Fix 5 lint warnings (#542, PR #545) — unused `CacheEntry` export, unused `_err` var, unused `TData`/`TValue` type params
- [x] Clean up chat.ts stack trace logging (#543, PR #545) — stack trace moved to debug level
- [x] Docs gaps (#541, PR #546) — `atlas index` CLI reference, streaming Python in Python guide, cache admin UI in admin console guide
- [x] Code review of new 0.7.0 modules (#544, PR #549) — learn module, python-sidecar streaming, org-scoped code. Filed #547 (shared Python wrapper) and #548 (input mutation) for 0.7.2

### 0.7.2 — Type Safety & Code Smells

- [x] Non-null assertion (`!`) audit (#550, PR #556) — find and eliminate unnecessary `!` operators across all packages
- [x] `any` type usage audit (#551, PR #559) — replace explicit `any` with proper types or `unknown` where possible
- [x] Unused exports audit (#552, PR #560) — dead code elimination across packages
- [x] Function complexity (#553, PR #558) — identify and refactor functions over ~50 lines or deeply nested logic
- [x] Extract shared Python wrapper code (#547, PR #557) — deduplicate between streaming and non-streaming handlers
- [x] Eliminate input parameter mutation in generateProposals (#548, PR #555) — pure function refactor

### 0.7.3 — Error Handling & Resilience

- [x] Catch block audit (#561, PR #567) — eliminate ~35 silent catches, standardize error type narrowing across all packages
- [x] Error message quality (#562, PR #565) — replace 12 generic error messages with actionable guidance, add request IDs to all 500 responses
- [x] Fallback behavior review (#563, PR #566) — audit ~96 fallback patterns, add logging for suspicious silent degradation
- [x] Error boundary coverage (#564, PR #566) — wrap org context, streaming Python, and shared conversations with error boundaries
- [x] Fix remaining silent catch blocks in admin.ts (#569) — already addressed by PRs #565, #566, #567
- [x] Fix password-status endpoint swallowing DB errors (#568, f15424c) — return 500 instead of false on DB failure

### 0.7.4 — Test Hardening

- [x] Password endpoint test coverage (#571, PR #577) — add tests for /me/password-status and /me/password endpoints
- [x] Cache edge case tests (#572, PR #577) — TTL boundaries, concurrent access, oversized entries, LRU eviction
- [x] Streaming Python timeout/error path tests (#573, PR #578) — SSE protocol, mid-stream failures, timeout boundaries
- [x] `atlas learn` edge case tests (#574, PR #576) — malformed entries, conflicting proposals, full pipeline integration
- [x] Mock factory migration (#575, PR #576) — migrate remaining inline connection mocks to shared `createConnectionMock`
- [x] Fix empty catch blocks in atlas learn analyze (#579, 3a30a47) — add debug logging to 5 silent catches

### 0.7.5 — Docs Completeness

- [x] Feature-to-docs mapping (#580, PR #585) — audited all 0.1.0–0.7.4 features, created caching guide, expanded Python guide, verified CLI/pool/classification/hooks coverage
- [x] Stale reference cleanup + config/env var audit (#581, PR #585) — fixed dead link in MCP plugin docs, added pool.perOrg to config.mdx, added ATLAS_ORG_ID to env vars, added cache/pool to config summary table
- [x] Landing page refresh (#582, PR #584) — updated useatlas.dev feature grid for 0.7.0 (multi-tenancy, caching, learning)
- [x] Multi-tenancy / organization setup guide (#554, PR #583) — dedicated guide for Better Auth org plugin, org-scoped semantic layers, connections, and pooling

---

## 0.8.0 — Intelligence & Learning

**SaaS differentiator: the "gets smarter over time" story.** Dynamic learning is Atlas's answer to Vanna's RAG — auditable YAML diffs vs opaque embeddings. PII detection and compliance features live in `/ee` (0.9.0).

### Learning (Phase 2 — Dynamic Layer)

- [x] `learned_patterns` DB schema and CRUD API (#586, PR #595)
- [x] Agent proposes learned patterns after successful queries (#587, PR #599)
- [x] Inject approved learned patterns into agent context (#588, PR #600)
- [x] Admin UI for reviewing and managing learned patterns (#589, PR #598)

### Cleanup

- [x] Extract shared adminAuthPreamble to avoid 3-file duplication (#596, PR #597)

### Knowledge

- [x] Prompt library — curated per-industry question collections (#590, PR #602)
- [x] Query suggestion engine — learn from past successful queries (#591, PR #603)

### Advanced

- [x] Self-hosted model improvements — test matrix and benchmarks (#592, PR #594)
- [x] Notebook-style interface — cell-based exploratory analysis UI (#593, PR #606)

---

## 0.8.1 — Notebook Refinement

**Polish and extend notebook UI.** Harden Phase 1, add fork/reorder (Phase 2) and export/text cells (Phase 3).

### Hardening (P0 — do first)

- [x] Extract shared `useAtlasTransport` hook from chat and notebook (#608)
- [x] Add ErrorBoundary to notebook cells and fix generic error messages (#609)

### Bug Fixes

- [x] Error propagation in use-conversations — callers can't distinguish failure reasons (#622, PR #626)
- [x] useKeyboardNav fires callbacks with invalid index when cellCount is 0 (#623, PR #625)
- [x] Notebook error feedback + catch annotations (#616, #617, #618, PR #619)
- [x] Align @useatlas/react useConversations with throw-on-failure pattern (#628, 970d441)

### Quality

- [x] Notebook test coverage — keyboard nav, components, edge cases (#610, PR #621)
- [x] Notebook UX polish — keybindings, dead code, dialog dedup (#611, PR #620)
- [x] useNotebook hook-level tests with renderHook (#624, PR #627)

### Docs

- [x] Add missing error codes to CHAT_ERROR_CODES (#629, PR #634)
- [x] Fill docs reference gaps — learn config, CLI flags, .env.example (#630, #631, #633, PR #635)
- [x] Update OpenAPI spec — add 50+ missing endpoints via codegen pipeline (#632, PR #637)

### Features

- [x] Notebook Phase 2 — fork + reorder (#604)
- [x] Notebook Phase 3 — export + text cells (#605)

---

## 0.9.0 — SaaS Infrastructure

**The milestone that makes Atlas a hosted product.** Everything before this is "software that works well." This milestone is "software you can sell."

### Tenant Provisioning

- [x] Self-serve signup flow (#644, PR #674) — email/OAuth signup → workspace creation → connect database wizard. No CLI, no `atlas init`, no YAML editing. The web equivalent of `bun create @useatlas` but for non-developers
- [x] Workspace lifecycle (#645, PR #673) — create, suspend, delete. Cascading cleanup of connections, conversations, semantic layers, cached results
- [x] Guided semantic layer setup wizard (#649, PR #681) — web UI replacement for `atlas init`. Profile database, review generated entities, edit descriptions, preview agent behavior. Shared profiler library extracted from CLI

### Usage Metering & Billing

- [x] Usage tracking (#650, PR #675) — per-workspace query count, token consumption, storage, active users. Extend existing token tracking to workspace-scoped metering
- [x] Billing integration (#651, PR #682) — Stripe via Better Auth plugin. Free/trial/team/enterprise tiers, BYOT support, plan enforcement on queries, Customer Portal
- [x] Usage dashboard (#652, PR #687) — customer-facing view of consumption, limits, and billing history
- [x] Overage handling (#653, PR #690) — graceful degradation (rate limit, then block) when workspace exceeds plan limits

### Enterprise Features (`/ee`)

Source-available under separate commercial license. Core AGPL functionality stays free — `/ee` is governance, compliance, and scale features that enterprises pay for.

#### Auth & Access Control

- [x] `/ee` directory structure (#646, PR #672) — source-available enterprise features under separate commercial license
- [x] Enterprise SSO (#654, PR #676) — per-organization SAML and OIDC provider registration, domain-based auto-provisioning via Better Auth hooks
- [x] SCIM directory sync (#658, PR #754) — automated user provisioning from enterprise IdPs via SCIM 2.0 endpoints
- [x] SSO enforcement (#659, PR #729) — require SAML/OIDC for workspace, no password fallback
- [x] IP allowlisting (#655, PR #728) — restrict API and UI access by CIDR range per workspace
- [x] Custom role definitions (#656, PR #736) — granular permission-based RBAC with 8 flags, built-in roles (admin/analyst/viewer), admin CRUD API + UI, fail-closed resolution, ipaddr.js for IP parsing (PR #738)
- [x] Approval workflows (#660, PR #756) — require sign-off for queries touching sensitive tables or exceeding cost thresholds, admin approval UI with approve/deny actions

#### Compliance & Audit

- [x] Audit log retention policies (#657, PR #746) — configurable retention (30d/90d/1yr/custom), soft-delete + hard-delete auto-purge, CSV/JSON compliance export, admin UI "Retention" tab, enterprise-gated
- [x] PII detection and column masking (#661, PR #776) — regex+heuristic PII detector in `/ee`, afterQuery masking hook with role-based strategies (full/partial/hash/redact), admin UI for reviewing classifications, guide page. Enterprise-gated
- [x] Compliance reporting dashboard (#662, PR #778) — data access and user activity reports with date/user/role/table filters, CSV/JSON export, summary stats, admin UI "Reports" tab. Enterprise-gated

#### Multi-Tenant Enterprise

- [x] Data residency controls (#663, PR #809) — route tenant data to region-specific storage (EU customers need EU data)
- [x] Custom domains (#664, PR #814) — `data.customer.com` pointing at their Atlas workspace, powered by Railway GraphQL API for domain provisioning + TLS
- [x] Tenant-level model routing (#665, PR #747) — per-workspace BYOK LLM provider config, encrypted API keys, Anthropic/OpenAI/Azure/custom support, admin UI with test connection, enterprise-gated

#### Branding

- [x] White-labeling (#666, PR #777) — per-workspace branding (logo, colors, favicon, hide Atlas branding), admin UI, public branding endpoint for widget embeds, `useBranding()` hook, conditional sidebar rendering. Enterprise-gated

### Platform Operations

- [x] SLA monitoring and alerting (#667, PR #795) — per-workspace latency p50/p95/p99, error rate, uptime tracking with configurable alert thresholds. Platform admin dashboard with charts, alert management (fire/resolve/acknowledge), webhook delivery. Enterprise-gated via `/ee/sla/`
- [x] Abuse prevention (#668, PR #788) — anomaly detection on query patterns, graduated response (warn → throttle → suspend), admin UI for flagged workspaces, configurable thresholds, audit trail integration
- [x] Platform admin console (#669, PR #775) — cross-tenant dashboard for platform operators via Better Auth `platform_admin` role, workspace management (suspend/delete/plan change), noisy neighbor detection, aggregate stats, guide page
- [x] Automated backups and disaster recovery (#647, PR #802) — pg_dump-based with gzip compression, configurable schedule/retention, backup verification, restore with safety checks, platform admin dashboard, enterprise-gated via `/ee/backups/`

### Chat SDK — Unified Interaction Layer

Parent: #757. Replace per-platform interaction plugins with a single `@useatlas/chat` plugin built on vercel/chat.

#### Foundation
- [x] Core bridge plugin (#758, PR #774) — `@useatlas/chat` plugin bridging Chat SDK → Atlas plugin lifecycle, Slack adapter as proof-of-concept, in-memory state adapter, integration tests
- [x] State adapter integration with Atlas internal DB (#772, PR #779) — PG adapter with `chat_` prefixed tables, memory adapter, Redis stub, distributed locking, thread subscription persistence, configurable via plugin config

#### Platform Migrations
- [x] Migrate Slack interaction to Chat SDK adapter (#759, PR #784) — existing `@useatlas/slack` plugin migrated to Chat SDK bridge, slash commands, threaded conversations, Block Kit cards, approval buttons, OAuth multi-workspace, rate limiting all preserved via `@chat-adapter/slack`
- [x] Migrate Teams interaction to Chat SDK adapter (#760, PR #787) — Bot Framework routing through Chat SDK dispatch, Adaptive Cards preserved, tenant restriction + rate limiting retained, `@useatlas/teams` deprecated

#### New Platforms
- [x] Discord interaction (#761, PR #794) — `@chat-adapter/discord` via Chat SDK bridge, Ed25519 webhook verification, Embed cards, @mention and slash command handling, threaded conversations
- [x] Google Chat interaction (#762, PR #804) — `@chat-adapter/gchat` via Chat SDK bridge, service account + ADC auth, Google Chat Cards, Pub/Sub topic support, domain-wide delegation
- [x] Telegram interaction (#763, PR #807)
- [x] GitHub bot interaction (#764, PR #813)
- [x] Linear bot interaction (#765, PR #850)
- [x] WhatsApp interaction (#766, PR #853)

#### Cross-Platform Features
- [x] AI streaming responses across platforms (#767, PR #808)
- [x] Unified JSX cards for query results (#768, PR #803) — QueryResultCard, ErrorCard, ApprovalCard, DataTableCard via Chat SDK JSX runtime. Auto-compiles to Block Kit (Slack), Adaptive Cards (Teams), Discord Embeds, Google Chat Cards with markdown fallback
- [x] Modals, slash commands, and action buttons (#769, PR #812)
- [x] File upload support — CSV export (#770, PR #854)
- [x] Ephemeral messages and proactive DMs (#771, PR #861)
- [x] Cross-platform emoji and reactions (#773, PR #860)

### Auth & Routing

- [x] Auth route protection via Next.js 16 proxy (PR #810) — optimistic session cookie check, redirect unauthenticated users to /signup, dedicated /login page with social providers, managed auth mode only

### Follow-ups

- [x] CLI atlas init shared profiler (#686, PR #741) — replaced ~600 lines of duplicated profiling code with imports from `@atlas/api/lib/profiler`
- [x] Wizard types to @useatlas/types (#683, PR #740) — canonical wire-format types, Zod validation on save endpoint, immutable `analyzeTableProfiles`

### Onboarding

- [x] Interactive demo mode (#648, PR #677) — try Atlas against a sample database without connecting your own. The cybersec demo dataset, hosted, zero-config, email-gated lead capture
- [x] Onboarding email sequence (#670, PR #783) — automated drip campaign with milestone-triggered + time-based fallback emails, SMTP/webhook delivery, workspace branding, unsubscribe, admin management API
- [x] In-app guided tour (#671, PR #745) — tooltip-based walkthrough of chat, notebook, admin, semantic layer. Tour completion tracked per user, re-triggerable from help menu, lazy-loaded

---

## 0.9.1 — Docs & Polish

**Ongoing companion to 0.9.0.** Docs and hardening pass after each batch of SaaS features ships. Grows as 0.9.0 progresses.

- [x] Guide pages for first SaaS batch (#679, PR #680) — self-serve signup, demo mode, enterprise SSO, usage metering guides. Admin console docs updated with workspace management. React reference updated with AtlasChat component props. Onboarding endpoints added to OpenAPI spec
- [x] Semantic layer wizard guide (#691, PR #695) — step-by-step walkthrough, wizard vs CLI comparison, troubleshooting
- [x] Billing and plans guide (#692, PR #696) — plan tiers, Stripe setup, overage handling, usage dashboard, BYOT, Customer Portal
- [x] Fix useAdminFetch error body loss (#689, PR #694) — extract message + requestId from JSON error responses
- [x] RequestId consistency in API error responses (#697, #698, #699, PR #700) — global onError, adminAuthPreamble 401/403, wizard comment fix
- [x] OpenAPI spec gaps (#693, PR #704) — demo, billing, usage, wizard endpoints added to spec, codegen run
- [x] Wizard test coverage (#685, PR #706) — save endpoint, resolveConnectionUrl, profiler edge cases (461 + 470 lines)
- [x] Wizard generate schema type mismatch (#707) — incidental fix during OpenAPI work
- [x] Admin-tokens test mock fix (#701, e2a2c1b) — partial mock missing createAtlasUser
- [x] Billing/workspace error codes reference (#708, PR #709) — error code docs for plan_limit_exceeded, workspace_suspended, etc.
- [x] RequestId in remaining auth error responses (#705, #713, #714, PR #710) — conversations, sessions, billing, suggestions auth + operational 500s
- [x] Retryable billing/workspace error flags (#711, #712) — correct retryable field and status codes for billing errors
- [x] Wizard error handling and MySQL escaping (#684, PR #688) — harden resolveConnectionUrl, MySQL identifier quoting
- [x] OpenAPI auto-gen Phase 1 — foundation (#703, PR #715) — OpenAPIHono on index.ts + semantic.ts, /api/v1/openapi-auto.json endpoint
- [x] OpenAPI auto-gen Phase 2a — admin routes (#716, PR #718) — all 7 admin route files converted to OpenAPIHono + createRoute
- [x] OpenAPI auto-gen Phase 2b — public API routes (#717, PR #721) — 7 public route files (query, prompts, sessions, suggestions, onboarding, actions, scheduled-tasks) converted
- [x] @hono/zod-openapi dependency fix (#720, cf1b62e) — missing from packages/api/package.json
- [x] OpenAPI auto-gen cleanup — shared schemas, remove unnecessary as-never casts (PR #722)
- [x] OpenAPI auto-gen Phase 2c-i — conversations, billing, wizard (#723, PR #725)
- [x] OpenAPI auto-gen Phase 2c-ii — chat, demo, slack (#724, PR #726)
- [x] OpenAPI auto-gen Phase 3 — single merged spec endpoint, delete openapi-auto.json (PR #727). openapi.ts: 4,334 → 230 lines
- [x] IP allowlisting + SSO enforcement docs (#730, #731, PR #735) — guide pages for both enterprise auth features
- [x] SDK reference fixes (#733, PR #737) — HTTP status codes, phantom types, missing error codes, ConnectionDetail
- [x] RLS conditions field docs (#734, PR #737) — conditions array documented, required markers corrected
- [x] Validation hook (#719, PR #737) — context-aware error messages (query/param/body), 422 status, applied to all 23 sub-routers
- [x] IP parsing refactor (PR #738) — replace hand-rolled bigint math with ipaddr.js, fix IPv4-mapped IPv6 + duplicate detection + plain IP support
- [x] Custom roles guide (PR #736 included docs)
- [x] OpenAPI spec regeneration (#732, PR #739) — regenerated docs spec with all 150 routes (was missing 45+ after Phase 3 migration)
- [x] Trailing-slash path dedup (#742, 159d085) — 7 duplicate `/foo/` paths removed from spec, dedup added to extract script
- [x] Fix CLI analyzeTableProfiles return value (#743, dc78f2d) — 3 call sites + 1 test discarded immutable return, breaking FK inference
- [x] Fix WizardTableFlags type mismatch (#744, dc78f2d) — snake_case `TableFlags` replaced with camelCase `WizardTableFlags` matching wire format
- [x] `@atlas/ee` workspace package refactor (#752) — path alias replaces deep relative imports, workspace dependency setup
- [x] CI fix: add ipaddr.js to @atlas/ee dependencies (6331937) — missing explicit dep caused type-check failure
- [x] Docs for enterprise auth features — SCIM guide (scim.mdx, 227 lines), approval workflows guide (approval-workflows.mdx, 149 lines)
- [x] Platform admin console guide (platform-admin.mdx, included in PR #775)
- [x] PII compliance guide (pii-masking.mdx, included in PR #776)
- [x] Missing env var docs (#780, PR #781) — ATLAS_SEMANTIC_ROOT, SEMANTIC_DIR, SIDECAR_AUTH_TOKEN added to reference page and .env.example
- [x] Fix semantic-sync.ts ignoring ATLAS_SEMANTIC_ROOT (#782, PR #786) — replaced hardcoded path with shared `getSemanticRoot()` from semantic-files.ts
- [x] Extract useAdminMutation hook (#789, PR #791) — shared mutation hook for admin pages (POST/PUT/PATCH/DELETE) with auto-invalidation
- [x] Eliminate `as never` casts from OpenAPI route handlers (#790, PR #792) — type-safe OpenAPI middleware replaces manual cast workarounds
- [x] Add @useatlas/chat plugin guide page (#785, PR #793) — complete guide covering adapters (Slack, Teams, Discord), state config (memory/PG/Redis), migration from deprecated plugins, error scrubbing, env vars
- [x] Chat plugin hardening (#796-#801, cc7d75d) — requestId on webhook 500s, init error logging, Discord publicKey hex validation, docs: state sub-options, scrubbing patterns, link verification
- [x] SLA monitoring guide (sla-monitoring.mdx, included in PR #795)
- [x] JSX card error consistency (#805) — error cards for all bridge error paths
- [x] Card docs fix (#806) — correct section header and docs for card-based flow
- [x] Google Chat guide page (gchat.mdx, included in PR #804)
- [x] Backups guide page (backups.mdx, included in PR #802)
- [x] Telegram guide page (telegram.mdx, included in PR #807)
- [x] Chat plugin guide updated with streaming config and Telegram adapter (included in PRs #807, #808)
- [x] Data residency guide page (data-residency.mdx, included in PR #809)
- [x] Fix residency admin page type errors (6d52454) — FeatureGate missing feature prop, LoadingState wrong prop name, StatCard icon as JSX elements
- [x] Fix ConversationCallbacks.addMessage return type (7bedcbd) — `void` → `Promise<void> | void` to match async usage
- [x] GitHub bot guide page (github.mdx, included in PR #813) — GitHub App setup, PAT auth, webhook config
- [x] Chat plugin guide updated with interactive components, configurable slash commands, GitHub adapter (included in PRs #812, #813)
- [x] Custom domains guide page (custom-domains.mdx, included in PR #814) — Railway integration, DNS verification, CNAME setup
- [x] Enterprise error detection fixes (#817, #818, #826, PRs #827, #831) — `instanceof EnterpriseError` replacing fragile string matching across all admin route handlers, `no_internal_db` returns 503 instead of misleading 404
- [x] rowTo* runtime validation (#816, PR #824) — add runtime type checking at DB boundary layer instead of unsafe `as` casts
- [x] requestId in webhook logs + DuckDB segfault skip (#815, PR #825) — correlation IDs in webhook `waitUntil` error logs, skip DuckDB segfault test in Bun 1.3.10
- [x] ConversationCallbacks.addMessage return type fix (7bedcbd) — `void` → `Promise<void> | void` to match async usage in @useatlas/react
- [x] Fix approval.ts governance bypass (#828, PR #834) — `checkApprovalRequired`, `expireStaleRequests`, `getPendingCount` now re-throw unexpected errors instead of returning false-negative fallbacks. Only `EnterpriseError` returns safe fallback
- [x] instanceof error detection + test mock fixes (#829, #830, #832, PR #833) — `DomainError`/`ResidencyError` detection via `instanceof` in platform routes, 8 EE test files corrected to throw `EnterpriseError` with re-exported class
- [x] OpenAPI regen + env vars + error codes + dead links (#820, #821, #822, #823, PR #840) — 6 route groups (29 endpoints) added to OpenAPI spec with SaaS-only framing, 12 env vars added to reference, `workspace_throttled` error code added, onboarding-emails guide created, dead link fixed
- [x] Extract shared enterprise admin route middleware (#835, PR #852) — `throwIfEEError()` replaces 9 local `throwIf*Error` functions across admin routes
- [x] Create shared EE test mock factory (#836, PR #849) — createInternalDBMock following createConnectionMock pattern, fixes #829/#832
- [x] Reframe enterprise guides as SaaS-only (#819, c0d816b) — 14 /ee guides updated with SaaS-only framing, not self-deployable
- [x] Move operator guides to Platform Operations docs section (0c28f36)
- [x] Fix workspace_throttled emission (#843, PR #844) — return 429 with Retry-After instead of silent delay
- [x] Fix hasApprovedRequest enterprise gate + reject invalid rule_type (#841, #842, PR #845)
- [x] Fix approval request status cast (#846, PR #848) — validate status against known values instead of unchecked `as` cast
- [x] Consolidate semantic layer into semantic/ directory (#837, PR #855) — 5 top-level files → barrel export, move db/semantic-entities.ts
- [x] Extract shared pagination parser and ID validator (#838, PR #851) — `parsePagination()` + `isValidId()` + `PaginationQuerySchema` replace 24 inline implementations
- [x] Extract shared sandbox backends for explore/python (#839, PR #859) — 6 parallel backend files → 3 shared, SandboxBackend interface
- [x] Adopt react-hook-form + shadcn Form for admin dialogs (#856, PRs #862, #863, #864, #865) — FormDialog component with Zod 4 validation, all 26 admin pages migrated across 4 batches. z.ZodType<T,T> generic pattern for proper zodResolver overload matching
- [x] Extract AdminContentWrapper for admin page rendering (#857) — shared FeatureGate/ErrorBanner/LoadingState/EmptyState chain, 8 admin pages migrated
- [x] Extract createAdminRouter factory + requireOrgContext middleware (#858) — `createAdminRouter()`, `createPlatformRouter()`, `requireOrgContext()` replace 4-line router setup boilerplate × 22 files and ~8-line org-context extraction × 85 handlers

---

## 0.9.2 — Docs Persona Audit

**Systematic audit of all docs pages for persona clarity.** Every page should have a clear audience (end user, workspace admin, or platform operator) with appropriate framing, callouts, and sidebar placement.

### Phase 1 — Audit & Classification

- [x] Classify all 354 docs pages by persona (#847, PR #885) — audit table in `docs/research/persona-audit.md`, sub-issues filed for rewriting work

### Phase 2 — Structural Reorganization & Content Rewriting

- [x] Reframe deployment/config pages for SaaS vs self-hosted audiences (#878)
- [x] Reframe enterprise feature guides from customer perspective (#880)
- [x] Add persona sections to security reference pages (#881)
- [x] Relocate misplaced operator/developer guides to correct sections (#882)
- [x] Add persona sections to mixed-audience pages (#883)
- [x] Improve plugin interaction pages — chat SDK split, email digest sections (#884)

---

## 0.9.3 — Architecture Deepening

**Module-deepening refactors** from systematic codebase exploration. Reduce duplication, improve testability, and make the codebase more navigable before the 1.0.0 launch.

- ~Extract plugin initialization factory in plugin SDK (#890)~ — superseded by #908 (P5: Effect Layer composition)
- [x] Complete AdminContentWrapper adoption across all admin pages (#891, PR #899)
- [x] Extract route handler error wrapper for consistent 500 responses (#892, PR #902)
- [x] Extract OpenAPI schema factories for admin routes (#893, PR #916)
- [x] Deduplicate auth error classification between admin-auth and middleware (#894, PR #898)
- [x] Extract shared fetch error utility for admin hooks (PR #898) — quick win: deduped error parsing from `useAdminFetch` + `useAdminMutation` into `extractFetchError()`
- ~Extract plugin SDK utilities — health check, lazy loading, route helpers (#895)~ — superseded by #908 (P5: Effect Layer composition)
- [x] Extract conversation fetch client from use-conversations hook (#896, PR #915)
- [x] Extract shared ResultCardBase for SQL and Python result cards (#897, PR #899)

---

## 0.9.4 — Effect.ts Migration

**Incremental adoption of Effect.ts** across `packages/api/`. Typed errors, dependency injection via Layers, scoped resource lifecycle, structured concurrency. Backend only — frontend stays React/Zod.

### Foundation
- [x] P0: Effect.ts foundation — install, tagged errors, Hono bridge (#903, PR #918)

### Infrastructure Primitives (P1–P4)
- [x] P1: SQL validation & query execution → Effect.gen with tagged errors (#904, PR #920)
- [x] P2: Rate limiting → Effect Semaphore and Ref (#905, PR #920)
- [x] P3: Scheduler and delivery → Effect Schedule, Semaphore, retry (#906, PR #919)
- [x] P4: ConnectionRegistry → Effect Layer/Service with scoped resources (#907, PR #923)

### Service Architecture (P5–P8)
- [x] P5: Plugin lifecycle → Effect Layer composition (#908, PR #926)
- [x] P6: Server startup → Effect Layer DAG (#909, PR #928)
- [x] P7: Route handlers → Effect boundaries with typed error mapping (#910, PR #925)
- [x] P8: Auth and request context → Effect Context replacing AsyncLocalStorage (#911, PR #930)

### AI (P10) — Agent Loop → @effect/ai
- [x] P10a: Install @effect/ai, define provider Layers — bridge to existing providers.ts (#933, PR #938)
- [x] P10b: Define Atlas tools (explore, executeSQL) as AiToolkit (#934, PR #939)
- [x] P10c: Rewrite agent loop with AiLanguageModel.streamText (#935, PR #941)

### Database (P11) — Native Effect SQL
- [x] P11a: Install @effect/sql, define SqlClient Layer bridge (#936, PR #940)
- [x] P11b: Replace raw pg/mysql2 with @effect/sql native clients (#937, PR #942)

### Follow-ups
- [x] Migrate platform-residency and platform-domains inner error handling to domainErrors (#927)
- [x] Full audit — type safety, consistency, docs (PR #943)
- [x] Migrate route handlers from c.get() to Effect Context — incremental (#931, PR #944)

### Test Infrastructure
- [x] P9: Test infrastructure → Effect Layer-based test setup (#912)

---

## 0.9.5 — Post-Effect Validation

**Comprehensive end-to-end validation** after the 0.9.4 Effect.ts migration (23 issues, ~15 PRs, every route handler and backend service rewritten). Dev, CI, production, agent loop, enterprise features, browser tests, and external integrations.

### Dev & CI
- [x] Dev workflow smoke test — install, dev, build end-to-end (#945). Filed #955 (Better Auth migration bug, pre-existing)
- [x] CI test audit — 250/250 tests pass, no skipped tests, Effect layers healthy (#946). Filed #992 (flaky DuckDB segfault)

### Production
- [x] Production deploy validation — all 5 Railway services healthy, health endpoint green (#947)

### Effect Architecture
- [x] Effect service lifecycle — 131+ tests across 11 files cover startup, shutdown, error mapping, context propagation (#948)

### Agent & Features
- [x] Agent loop e2e — env isolation fix (PR #993), 272+ tool/agent tests pass (#949)
- [x] Enterprise feature smoke — env isolation fix (PR #994), 434 EE tests pass (#950). Filed #995 (axe violation)

### Integration
- [x] Browser e2e — tour dismissal fix (PR #996), 44/47 fast tests pass (#951). Filed #995 (axe violation)
- [x] SDK, MCP, and widget integration — external integration points (#952, PR #1138)

### Follow-ups (bugs found during validation)
- [x] Better Auth platform_admin role missing from roles config (#955, PR #956)
- [x] Notebook empty state after agent completes — user message not in conversation data (#958, f72689c)
- [x] Notebook text cells leak across conversations, chat broken in notebook view (#959, f72689c)
- [x] Demo dataset picker in onboarding — choose cybersec/ecommerce during first-run (PR #961)
- [x] Next.js proxy can't read NEXT_PUBLIC env vars from repo root .env (#957, PR #990)
- [x] Onboarding test mock — 5 tests failing, mock missing resolveDatasourceUrl + IP allowlist leak (#960, PR #989)
- [x] Admin learned-patterns test — 8 tests failing, IP allowlist query interference (#977, PR #989)
- [x] Seed-demo.ts skips seeding on fresh demo-data DB — Atlas tables leak into datasource (#962, PR #991)

---

## 0.9.6 — SaaS Customer Experience

**Pre-launch prerequisite: make the admin console work for paying SaaS workspace admins.** Scope settings/routes to workspaces, hide platform internals, add self-service for API keys, integrations, billing, sandbox, and custom domains. Keep self-hosted persona fully functional.

### Security & Scoping Fixes (P0)

- [x] Add requireOrgContext to learned-patterns, suggestions, and prompts routes (#963)
- [x] Add adminAuth middleware to scheduled-tasks routes (#964)
- [x] Scope Users admin page to active org members in SaaS mode (#965)
- [x] Hide Organizations page from non-platform-admin (#966)

### Settings Architecture (P0)

- [x] Activate org_id scoping on settings table for workspace-level overrides (#967, PR #999)
- [x] Split Settings page into workspace and platform tiers (#968, PR #1003)
- [x] Hide platform-only admin pages from workspace admins (#969)

### Self-Service Features

- [x] API key management UI for workspace admins (#970, PR #998)
- [x] Integrations hub page for workspace admins (#971, PR #1008)
- [x] Self-serve Slack disconnect/reconnect (#972, PR #1008)
- [x] Self-serve custom domain configuration (#973, PR #1007)
- [x] Self-serve sandbox backend selection per workspace (#974, PR #1015)
- [x] Workspace billing page — plan, usage vs limits, portal link (#975, PR #1006)
- [x] Self-serve data residency selection for workspace admins (#976, PR #1016, fix PR #1017)

### Infrastructure
- [x] Adopt versioned migration framework for internal DB (#978, PR #1019)

### Follow-ups
- [x] Org-scope admin write operations — role change, ban, delete (#983, PR #988)
- [x] Fix axe-core button-name violations on admin connections/audit pages (#995, PR #1000)
- [x] cascadeWorkspaceDelete does not clean up org-scoped settings rows (#1002, PR #1005)
- [x] Consolidate duplicated formatDate helpers across admin pages (#1001, PR #1004)
- [x] Billing routes used standardAuth instead of adminAuth (#1010, PR #1013)
- [x] formatNumber cross-page coupling — moved to shared @/lib/format (#1012, PR #1013)
- [x] Custom-domain page used inline toLocaleDateString instead of shared formatDate (#1009, PR #1013)
- [x] Regenerate API reference docs with flat filenames and operationIds (PR #987)
- [x] Consolidate formatNumber in token-usage pages to shared @/lib/format (#1014, PR #1015)
- [x] Fix type errors and runtime crash from #976 residency PR (PR #1017)
- [x] Slack events handler responds to url_verification before signature check (#1011, PR #1008)
- [x] Isolate corrupted-DuckDB test in subprocess to fix flaky segfault (#992, PR #1018)

---

## 0.9.7 — SaaS-First Admin Experience

**Make app.useatlas.dev feel like a real SaaS product, not a self-hosted deployment.** Remove operator-facing UX (env var names, "Requires restart", "configure DATABASE_URL") from the workspace admin experience. Make plugins, integrations, sandbox, and settings self-serve for paying SaaS customers. Keep self-hosted persona fully functional.

### Foundation (P0)

- [x] Add explicit deploy mode flag — `ATLAS_DEPLOY_MODE=saas|self-hosted|auto` (#1020, PR #1031)
- [x] Hide "Requires restart" and env var names from SaaS workspace admins (#1021, commit 59063af)
- [x] Fix demo dataset onboarding — missing connectionId + swallowed errors (#1032, PR #1034)
- [x] Filter settings page to workspace-relevant settings in SaaS mode (#1022, PR #1035)

### Self-Service Features (P1)

- [x] Make restart-required settings hot-reloadable in SaaS mode (#1023, PR #1087)
- [x] OAuth-first integration connect flows for SaaS workspaces (#1024)
  - [x] Connect flow framework + Microsoft Teams (#1040, PR #1039)
  - [x] Discord (#1041, PR #1053)
  - [x] Telegram (#1042, PR #1053)
  - [x] Google Chat (#1043, PR #1081)
  - [x] GitHub (#1044, PR #1081)
  - [x] Linear (#1045, PR #1083)
  - [x] WhatsApp (#1046, PR #1083)
- [x] Plugin marketplace — browse, install, configure per workspace (#1025)
  - [x] Phase 1: catalog + workspace installations backend (#1127, PR #1132)
  - [x] Phase 2: browse + install UI (#1129, PR #1134)
  - [x] Phase 3: platform admin catalog management (#1130, PR #1137)
- [x] Sandbox integration library — BYOC execution environments (#1026, PR #1054)
- [x] Product-focused data residency UX for SaaS users (#1027, PR #1065)
- [x] Missing p-6 padding on sandbox and residency admin pages (PR #1064)

### SaaS Management

- [x] SaaS-native semantic layer management — web editor + version control (#1033)
  - [x] Phase 1: entity CRUD editor (#1124, PR #1133)
  - [x] Phase 2: schema-aware autocomplete (#1125, PR #1135)
  - [x] Phase 3: version history + rollback (#1126, PR #1140)

### Docs

- [x] Add guide pages for undocumented 0.9.6 admin pages (#1038) — PR #1052
- [x] Regenerate OpenAPI spec — stale after 0.9.6/0.9.7 changes (#1037) — PR #1052

### Finishing Touches (P2)

- [x] Email integration connect flow in Integrations hub (#1028, PR #1086)
- [x] Self-hosted deploy validation via GH Actions for template repos (#1029, PR #1114)
- [x] Create platform OAuth apps for Slack/Teams/Discord on Railway (#1063)

### Dual-Mode Integrations (BYOT)

- [x] Slack BYOT — bot token form when OAuth not configured (#1060, PR #1070)
- [x] Teams BYOT — app credentials form when OAuth not configured (#1061, PR #1070)
- [x] Discord BYOT — bot credentials form when OAuth not configured (#1062, PR #1070)

### Follow-ups

- [x] Telegram connect sends empty POST body — botToken not wrapped in body (#1057, PR #1058)
- [x] Update docs guides for sandbox BYOC + Discord/Telegram (PR #1056)
- [x] In-memory OAuth state map not viable for multi-instance deployments (#1055, PR #1071)
- [x] syncpack picks up .next/standalone build artifacts (#1068)
- [x] Slack route still uses in-memory OAuth state map (#1076, PR #1078)
- [x] Slack store saveInstallation lacks org hijack protection (#1074, PR #1078)
- [x] Wire cleanExpiredOAuthState into scheduler (#1077, PR #1082)
- [x] useDeployMode silently defaults to self-hosted on settings fetch error (#1072, PR #1078)
- [x] Add BYOT route tests for Slack, Teams, Discord (#1075, PR #1082)
- [x] Replace xlsx (SheetJS) with exceljs — 3 Dependabot security alerts (#1079, PR #1080)
- [x] Google Chat + GitHub connect flows (#1043, #1044, PR #1081)
- [x] Linear + WhatsApp connect flows (#1045, #1046, PR #1083)
- [x] OAuth cleanup scheduler + BYOT tests (#1077, #1075, PR #1082)
- [x] useAdminFetch type safety — Zod schema validation replaces blind `as T` casts (#1073, PR #1088)

---

## 0.9.8 — Docs & Polish

**Documentation, reference pages, guide coverage, and follow-up fixes for 0.9.7 features.**

### Docs

- [x] Add Discord + Teams integration env vars to docs, .env.example, and OpenAPI extract (#1102, PR #1106)
- [x] Update admin console guide for SaaS hot-reload settings (#1103, PR #1107)
- [x] Update SDK + React reference — missing exports and stale types (#1104, PR #1108)
- [x] Add per-action timeout to config reference + fix learn --suggestions CLI help (#1105, PR #1109)

### Follow-ups from 0.9.7

- [x] Hot-reload settings — comment accuracy + test coverage gaps (#1089, PR #1112)
- [x] Migrate remaining useAdminFetch calls to Zod schema validation (#1090, PR #1111)
- [x] useAdminFetch does not clear stale data on HTTP error during refetch (#1091, PR #1111)
- [x] Periodic settings refresh for multi-instance SaaS (#1092, PR #1113)
- [x] Deduplicate provider switch in getModelForConfig (#1093, PR #1110)

### Refactors

- [x] Split integration installation types into secret/public variants (#1084, PR #1110)
- [x] Extract shared BaseInstallation type for integration stores (#1085, PR #1110)

### Data Residency

- [x] Region selection during workspace signup flow (#1066, PR #1115)
- [x] Data residency region migration flow Phase 1 (#1067, PR #1120)
- [x] Automated region migration orchestration — Phase 2: snapshot, replicate, cutover (#1118, PR #1128)

### Follow-ups

- [x] Atomic cache swap in loadSettings to prevent brief stale reads (#1116, PR #1119)
- [x] Deploy-validation CI missing bun install for create-atlas deps (#1117, PR #1119)
- [x] Scaffold template missing @useatlas/types + @useatlas/react deps (#1121, PR #1122)
- [x] Deploy-validation CI — scaffold build + standalone build fixes (#1123)

---

## 1.0.0 — SaaS Launch

**app.useatlas.dev goes live.** The hosted product where teams sign up, connect their database, and have a production-ready AI data analyst without deploying anything.

- [x] Public pricing page on useatlas.dev (#871, PR #922)
- [x] SLA commitments — uptime guarantee, query latency targets, support response times (#872, PR #1147)
- [x] Terms of service, privacy policy, DPA for enterprise (#873, PR #1148)
- [x] Launch content — blog post, Show HN, comparison pages updated (#874, PR #924)
- [x] Launch content follow-up — social media assets and demo video (#954, PR #1158)
- [x] Migration tooling — self-hosted to hosted (export/import conversations, semantic layers, settings) (#875, PR #1143)
- [x] Documentation for hosted users — separate onboarding flow from self-hosted docs (#876, PR #1146)
- [x] Status page — public health dashboard (#877, PR #921)
- [x] Status page follow-up — OpenStatus integration for incident management (#953, PR #1144)
- [x] Regional API deployment for tier-2 data residency compliance (#1069)
  - [x] Region API URL config — apiUrl in RegionConfigSchema + settings response (#1149, PR #1155)
  - [x] Region-aware ConnectionRegistry (#1151, PR #1156)
  - [x] Dynamic frontend API URL — runtime resolution from regionApiUrl (#1150, PR #1157)
  - [x] Multi-region Railway deployment — 3 regions live: api (us-west), api-eu (europe-west4), api-apac (asia-southeast1) (#1152)
  - [x] Cross-region request misrouting detection (#1153, PR #1159)
  - [x] Region migration — cross-region data movement with export/import bundle (#1154, PR #1168)
- [x] Docs — semantic editor, plugin marketplace, platform plugin catalog guides (#1141, PR #1142)
- [x] Fix flaky DuckDB ingest test — timeout bump (#1145, 71246b7c)
- [x] Pre-launch SaaS smoke test — health endpoints, admin review, signup flow, regional tests (#1161, PR #1166). Filed #1163, #1164, #1165 (fixed in PR #1169)
- [x] Competitive landscape + comparison pages refresh for 1.0 launch (#1162, PR #1167)

---

## Post-Launch Cleanup

**Hardening pass after 1.0.0 launch.** Org-scoping gaps, error handling bugs, and test coverage from admin route extraction.

### Security — Admin Org Scoping

- [x] Scope admin sessions page to active organization (#1190, PR #1190)
- [x] Scope admin audit log to active organization (#1192, PR #1192)
- [x] Scope admin token usage to active organization (#1193, PR #1193)
- [x] Scope remaining admin handlers (connections, cache, plugins, semantic) to active organization (#1194, PR #1194)
- [x] Migrate remaining admin.ts handlers to createAdminRouter + requireOrgContext (#1191, PR #1194)

### Bug Fixes

- [x] getConnectionRoute silently degrades to 200 on DB failure (#1197, PR #1202)
- [x] Connection update rollback failure message lacks recovery guidance (#1198, PR #1202)
- [x] Completions test out of sync — expects 13 commands, registry has 15 (#1200, PR #1204)
- [x] setWorkspaceRegion export missing from db/internal mock (#1201, PR #1203)

### Test Coverage

- [x] Connection CRUD org-scoping tests (#1195, PR #1204)
- [x] Cache endpoint tests (#1196, PR #1203)

### Architecture

- [x] Wrap all admin-connections routes in runHandler (#1205)
- [x] Unified API test mock factory — eliminate ~1,200 lines of duplicated mock setup (#1206, PR #1226)
- [x] Extract shared semantic entity scanner — eliminate 3x directory traversal duplication (#1207, PR #1211)
- [x] CLI command extraction Phase 1 — 6 handlers + shared connection testing (#1208, PR #1225)
- [x] CLI command extraction Phase 2 — profilers, plugin, init, migrate, help (#1227, PR #1228)
- [x] Consolidate useBranding into useAdminFetch (#1209)
- [x] Extract shared EEError base class — replace 14 identical error class definitions (#1231, PR #1234)
- [x] Extract shared hasInternalDB guard helpers — replace 75 inline checks across 18 EE files (#1232, PR #1233)
- [x] Type-safe exhaustive DomainErrorMapping via `domainError()` helper — branded type, 5xx sanitization, 13 routes migrated (#1235, PR #1236)

### Follow-ups
- [x] Add test coverage for ee/src/backups/ and ee/src/sla/ modules (#1237, PR #1238) — ~900 lines of Effect code with zero tests

---

## Dashboard Persistence

**Save and share query result layouts.** 6-phase feature (#1246): DB schema, add from chat, list/view pages, sharing, auto-refresh, AI suggestions.

- [x] Phase 1: DB schema + 14 CRUD API endpoints (#1247, PR #1253)
- [x] Phase 2: "Add to dashboard" button on SQL result cards in chat (#1248, PR #1254)
- [x] Phase 3: `/dashboards` list page + `/dashboards/:id` view page with DnD card reorder (#1249, PR #1255)
- [x] Phase 4: Share dialog + `/shared/dashboard/[token]` public page with OG tags (#1250, PR #1256)
- [x] Phase 5: Auto-refresh via scheduler — cron-based, hooks into existing scheduler tick engine (#1251, PR #1257)
- [x] Phase 6: AI-driven card suggestions — LLM analyzes existing cards, proposes complementary metrics grounded in semantic layer (#1252, PR #1258)
- [x] Docs: dashboard user guide (#1261, PR #1264)

---

## TanStack Query Migration

**Frontend data fetching migrated to TanStack Query** across both `packages/web` and `packages/react`. Automatic request deduplication, stale-while-revalidate, window-focus refetch, and cache-aware mutations.

- [x] Foundation — install, QueryProvider, query key factory, shared utils (#1213, #1214, PR #1239)
- [x] Core hooks — useAdminFetch → useQuery, useAdminMutation → useMutation (#1215, #1216, PR #1240)
- [x] IncidentBanner refetchInterval + password-status dedup via usePasswordStatus (#1221, #1219, PR #1241)
- [x] SchemaExplorer, PromptLibrary, EntityEditor → useQuery (#1220, PR #1242)
- [x] useConversations (web) — list fetch, optimistic star, cache-aware delete (#1217, PR #1243)
- [x] @useatlas/react — full adoption: useHealthQuery, conversations, AtlasChat QueryProvider (#1218, PR #1244)
- [x] Polish — health recovery clearing, stable fetchList ref (PR #1245)
- [x] Cleanup — deduplicate health checks, remove legacy hooks, verify dedup wins (#1222, #1223, #1224)

---

## Follow-ups

- [x] Docs: org management guide (#1263, PR #1264)
- [x] Docs: add missing env vars to .env.example — auth mode, scheduler, RLS, deploy mode (#1262, PR #1264)
- [x] Fix: standalone example build — QueryClientProvider + AtlasChat SSR (#1260)
- [x] Chore: publish @useatlas/types 0.0.6 + bump refs (#1259)

---

## 1.0.1 — Effect.ts Completion

**Complete Effect.ts adoption across `packages/api/`.** Eliminate all bridge layers and imperative patterns. Native `@effect/sql` for DB, Effect `Schedule`/`Cron` for timers, `Data.TaggedError` for errors, `Effect.all` for concurrency.

### Native DB Clients (P0 — eliminate bridge layers)

- [x] Migrate internal DB to native `@effect/sql-pg` `PgClient.layer()` (#1281, PR #1286)
- [x] Migrate analytics connection pools to native `@effect/sql-pg` (#1282, PR #1289) — PostgreSQL fully native via `PgClient.layerFromPool()`. MySQL stays on bridge (no `layerFromPool` upstream). Follow-up: #1290

### Timer Leaks (P0 — resource leaks on Railway restarts)

- [x] Migrate OAuth state cleanup setInterval to Effect Layer with finalizer (#1273, PR #1285)
- [x] Migrate auth middleware rate-limit cleanup setInterval to Effect Layer (#1274, PR #1285)
- [x] Migrate settings refresh timer to Effect Layer (#1275, PR #1285)
- [x] Migrate email scheduler to Effect Layer (#1276, PR #1285)
- [x] Replace all setInterval scheduling with Effect Schedule fibers (#1283, PR #1291) — 5 remaining timers migrated to SchedulerLayer

### Concurrency (P1 — unbounded DB calls under load)

- [x] Replace unbounded Promise.all with Effect.all/forEach + concurrency limits (#1277, PR #1287)

### Error Types (P2 — code quality)

- [x] Convert plain Error subclasses to Data.TaggedError (#1278, PR #1284)
- [x] Extract profiler utility functions to break circular dep (#1280, PR #1284)

### Sandbox (P2 — code quality)

- [x] Convert python-sandbox try/catch chains to Effect.tryPromise with retry (#1279, PR #1288)

### NOT migrating (bridge layers are correct)

- **Vercel AI SDK** — `AtlasAiModel` bridge stays. Frontend depends on AI SDK's data stream protocol and `useChat` hook. `@effect/ai` native would break the streaming pipeline.
- **Zod** — Powers `@hono/zod-openapi` for 150-route OpenAPI spec auto-generation. `effect/Schema` would require rewriting every route.
- **`@effect/platform` HTTP** — Hono handles all HTTP serving. No value in adding another HTTP layer.

---

## Follow-ups (post-1.0.1)

- [x] Smarter semantic layer profiling — probabilistic cardinality, FK inference, join candidate scoring (#1272, PR #1272)
- [x] Powered by Atlas badge on embedded widgets (PR #1265)
- [x] Semantic expert agent design doc (#1180, PR #1270)
- [x] Docs: chatEndpoint default `/api/chat` → `/api/v1/chat` (#1271)
- [x] Consolidate AtlasUIProvider + AtlasProvider into single AtlasProvider, shared auth types to @useatlas/types (PR #1298)
- [x] Fix AtlasContext in AtlasChat — useHealthQuery crash on app.useatlas.dev (f158a4cc)
- [x] Publish @useatlas/types 0.0.7 — SEMANTIC_TYPES + profiler exports
- [x] Fix Effect/Turbopack serverExternalPackages conflict in templates
- [x] Docs: fix stale AtlasUIProvider references in react.mdx (#1292, #1293)
- [x] Publish @useatlas/types 0.0.8 + @useatlas/react 0.0.6 — auth types in types, AtlasProvider consolidation in react (#1302)
- [x] Fix: cast user.role in dashboard pages — CI type-check regression from #1298 (#1300)
- [x] Migrate MySQL connections to native `@effect/sql-mysql2` (#1290)

---

## Semantic Layer Versioning

**`atlas migrate` CLI** — snapshot, diff, log, rollback for the semantic layer. Auto-snapshots on `atlas improve` and `atlas init`.

- [x] Snapshot library (`packages/cli/lib/migrate/snapshot.ts`) — capture, restore, diff semantic layer state (#1185, PR #1303)
- [x] CLI commands: `atlas migrate status`, `snapshot`, `diff`, `log`, `rollback` (#1185, PR #1303)
- [x] Auto-snapshot integration with `atlas improve` and `atlas init`
- [x] 626-line test suite for snapshot operations
- [x] Docs updated — CLI reference + semantic expert guide

---

## Multi-Seed Selection

**`create-atlas` seed picker** — choose demo dataset (simple/cybersec/ecommerce) during scaffolding.

- [x] Seed data restructured into `packages/cli/data/seeds/<name>/` (#1188, PR #1304)
- [x] Interactive seed picker + `--seed` flag for non-interactive mode
- [x] Ecommerce seed dataset with 14 entities and semantic layer
- [x] `pruneSeedData()` removes unselected seeds from scaffolded project
- [x] Backward-compat symlinks for Docker image paths
- [x] 316-line test suite for seed selection
- [x] Onboarding route updated for new seed path layout

---

## Semantic Expert Agent

**Autonomous analysis engine** that examines the semantic layer and database, identifies improvement opportunities, and proposes validated YAML amendments.

### Phase 1: Autonomous Analysis Engine
- [x] Analysis engine — 9 analysis categories (coverage, descriptions, types, measures, joins, glossary, sample values, query patterns, virtual dimensions) (#1266, PR #1297)
- [x] 5 new tools — profileTable, checkDataDistribution, searchAuditLog, proposeAmendment, validateProposal
- [x] `atlas improve` CLI command — batch mode with ranked proposals
- [x] DB migration — learned_patterns extended with `type` and `amendment_payload` columns
- [x] Admin UI — semantic_amendment filter + diff view on learned patterns page
- [x] Docs — semantic expert guide page + CLI reference update

### Phase 2: Interactive CLI Mode
- [x] `atlas improve -i` interactive session — multi-turn conversation in terminal (#1267, PR #1301)
- [x] Conversation state management (`packages/api/src/lib/semantic/expert/session.ts`)
- [x] YAML amendment apply/reject/edit flow with colorized unified diffs
- [x] Session summary at exit (accepted/rejected/skipped counts)
- [x] Docs updated — interactive mode section in semantic-expert.mdx + CLI reference

### Phase 3: Web Interactive Mode
- [x] Streaming API route (`/api/v1/admin/semantic-improve/chat`) with expert agent tools (#1268)
- [x] Session management endpoints (list, get, approve, reject proposals)
- [x] Split-view admin page (`/admin/semantic/improve`) — chat panel + proposals panel
- [x] Proposal cards with amendment preview, confidence score, approve/reject buttons
- [x] "Run Analysis" autonomous mode trigger from web UI
- [x] Applied changes recorded in semantic editor version history
- [x] "Improve" button in semantic editor page + sidebar navigation link
- [x] Apply module (`packages/api/src/lib/semantic/expert/apply.ts`) — amendment application with version history
- [x] Route tests for session and proposal endpoints
- [x] Docs updated — web UI section in semantic-expert.mdx

### Phase 4: Scheduled Improvements
- [x] Effect fiber in SchedulerLayer — periodic expert analysis tick (#1269, PR #1306)
- [x] Auto-approval policy via `ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD` setting
- [x] 3 new workspace-scoped settings in Intelligence section
- [x] Context loader (`context-loader.ts`) — disk-based semantic layer reading for scheduled mode
- [x] Health score computation (`health.ts`) — coverage, descriptions, measures, joins sub-scores
- [x] `GET /pending-count` and `GET /health` API endpoints
- [x] Notification badge on admin sidebar "Improve Layer" item (60s polling)
- [x] SemanticHealthWidget on semantic editor page with progress bars
- [x] 16 new tests (7 health + 9 scheduler)
- [x] Docs updated — scheduled mode section in semantic-expert.mdx + .env.example

### Follow-ups
- [x] Restrict auto-approval to low-risk amendment types — `ATLAS_EXPERT_AUTO_APPROVE_TYPES` setting (#1308, PR #1310)
- [x] Cache profiler output for scheduled expert ticks — `profile-cache.ts`, CLI writes cache after profiling (#1307, PR #1309)

---

## MCP Prompt Templates

- [x] Prompt templates via `prompts/list` and `prompts/get` protocol (PR #1296)
- [x] 5 built-in analytical patterns + semantic layer query_patterns + prompt library items
- [x] Docs updated (mcp.mdx)

---

## Per-Seat Pricing & Billing Hardening

**Transition from flat-rate to per-seat pricing model.** 4 tiers (Starter/Pro/Business/Enterprise) with model-aware token budgets, overage handling, and Stripe webhook hardening.

### Pricing Model
- [x] Per-seat pricing with model-aware token budgets (#1327, PR #1327)
- [x] Update pricing page to per-seat model with 4 tiers (#1325)
- [x] Billing admin page for per-seat pricing (#1326, PR #1329)

### Billing Hardening
- [x] Enforce member and connection limits per plan tier (#1314, PR #1320)
- [x] Add missing Stripe webhook handlers — payment failures + plan changes (#1312, #1313, PR #1322)
- [x] Rate limit Stripe portal session endpoint (#1317, PR #1321)
- [x] Use cached workspace data for suspension check (#1315, PR #1319)
- [x] Emit login events for active user tracking (#1316, PR #1318)

### Infrastructure
- [x] Platform email provider — first-class Resend integration with admin UI (#1324)
- [x] Fix: dashboard route require crashes server startup (#1311, PR e3894e2b)
- [x] Fix: org-scope connections table — composite PK (id, org_id) (#1330) — onboarding 409 for all orgs after first

### Bug Fixes
- [x] SSO auto-provisioning bypasses member limit check (#1323, PR #1339)
- [x] Fix admin-layout test — cannot resolve @/components/ui/sidebar (#1328, 54bcd46f)

### SaaS Infrastructure
- [x] Add `atlas.config.ts` for SaaS deployment — dogfood own config (144a2bf1)
- [x] Retry migration with backoff for serverless Postgres cold starts (1b541ff9)
- [x] Migration 0020 — add baseline org columns before tier rename (f027b02e)
- [x] Platform residency page — show not-configured state instead of error (65291d28)
- [x] Simplify region IDs — `us`/`eu`/`apac` (fcab8ac5)
- [x] Remove compliance badges — no security audits completed yet (43ad78c6)

---

## SSO Provider Management UI

**Self-serve SAML/OIDC configuration for SaaS workspace admins.** PRD: #1331. DNS domain verification (shared infra with custom domains), test connection, provider CRUD UI.

### Backend (complete)
- [x] Domain verification backend — migration 0022, DNS TXT lookup, domain-check endpoint (#1332, PR #1340)
- [x] Test connection endpoint — OIDC discovery + SAML cert validation (#1333, PR #1338)
- [x] Fix: grandfather existing enabled providers in migration, DNS timeout (72f662e0)

### Frontend (complete)
- [x] Provider list UI — cards, status badges, SP metadata, enable/disable (#1334, PR #1349)
- [x] Create provider dialog — SAML/OIDC forms, domain check, cert upload (#1335, PR #1349)
- [x] Edit provider dialog — pre-filled forms, secret masking, domain reset (#1336, PR #1349)
- [x] Delete provider — domain confirmation, enforcement warning (#1337, PR #1349)

### Refactors
- [x] Extract shared DNS domain verification utility (`ee/src/lib/domain-verification.ts`) (#1341, PR #1346)

### Docs
- [x] Billing docs — per-seat pricing, model-aware token budgets, overage handling (#1342, PR #1347)
- [x] OpenAPI spec regen — 3 new SSO endpoints + many new API groups (#1343, PR #1347)
- [x] SSO docs — domain verification flow, test connection, updated creation examples (#1344, PR #1347)

### Follow-ups
- [x] Custom domains could adopt DNS TXT verification for domain ownership (#1345, PR #1354)
- [x] Docker template data/.gitkeep missing (#1348)

---

## SaaS Hardening & Compliance

**Post-launch hardening.** GDPR compliance, settings architecture, error typing, billing fixes, package publishes.

### Features
- [x] GDPR workspace purge — hard delete all org data (#1359, PR #1360)
- [x] Split Settings into workspace and platform pages (PR #1358)
- [x] DNS TXT domain ownership verification for custom domains (PR #1354)

### Refactors
- [x] Migrate EE errors to Data.TaggedError (#1353, PR #1355)
- [x] Extract shared DNS domain verification utility (#1341, PR #1346)
- [x] Redact verification token from custom domain API responses (#1356, PR #1357)

### Billing & Pricing
- [x] Flat overage rate + Stripe plan fixes (PR #1362)
- [x] Fix plan name consistency across www pages (PR #1361)

### Packages
- [x] Publish @useatlas/types 0.0.9 — domain verification exports
- [x] Publish @useatlas/react 0.0.7 — consistent send button, no hardcoded colors

### Docs
- [x] Settings split + GDPR workspace purge docs (PR #1371)
- [x] Billing per-seat pricing, SSO domain verification & test connection docs (PR #1347)

### Follow-ups
- [x] Health check findings — PG readonly, sidecar healthchecks, whitelist warning (PR #1374)
- [x] Docs audit — critical/high findings across docs site (PR #1379)
- [x] Docs audit — OpenAPI params, SDK docs, plugin directory (PR #1380)
- [x] CORS on streaming responses, Bun idle timeout, PG read-only (PR #1381)
- [x] Docs accuracy audit — fix 12 findings across docs site (PR #1420)

---

## Admin Action Audit

**Persistent audit log for all admin mutations.** Track who changed what, when, and why across both platform and workspace admin operations. Parent: #1363.

- [x] Tracer bullet — schema + logger + first mutation + platform list + UI (#1364, PR #1373)
- [x] Workspace admin read surface (#1365, PR #1384)
- [x] Instrument all platform admin mutations (#1367, PR #1383)
- [x] Instrument all workspace admin mutations (#1368, PR #1385)
- [x] Filtering + CSV export (#1366, PR #1387)

---

## Native SaaS Chat Page

**Replace embeddable widget with first-class SaaS experience.** The dashboard (`/`) now uses native hooks instead of the `@useatlas/react` embed, giving URL state, prompt library, sharing, and full control. (#1389)

- [x] Native chat page with `?id=` URL state (PR #1388)
- [x] Lift `AtlasProvider` to root `AuthGuard` — remove 4 per-layout wrappers
- [x] Eliminate `DarkModeContext` and `ActionAuthProvider` — dead code after provider lift
- [x] Template overrides for standalone deployments (`create-atlas/overrides/page.tsx`)

---

## Bug Fixes (post-1.0.0)

- [x] Loaded conversations don't render tool results — SQL cards, charts, dashboard button (#1390, PR #1391)
- [x] Demo route does not persist tool results in conversations (#1392, PR #1394)
- [x] Extract `persistAssistantSteps` shared helper — deduplicate chat.ts/demo.ts persistence (PR #1394)
- [x] Semantic improve page shows badge count but no pending amendments (#1395)
- [x] Sidebar double-highlight on Semantic Layer + Improve Layer (PR #1395)
- [x] CORS test explore mock missing exports (#1386, PR #1382)
- [x] `api-test-mocks` missing `hardDeleteWorkspace` export (#1372)
- [x] `ErrorBanner` crashes on `FetchError` — extract `.message` before rendering
- [x] Semantic improve diff viewer: full-file rewrite diffs + monochrome display (PR #1403)
- [x] Admin-actions page missing p-6 padding (PR #1408)
- [x] Semantic improve page: independent scroll areas + text wrapping (PR #1407)
- [x] Semantic improve page: anchor height to viewport for panel scrolling (PR #1410)
- [x] Typing indicator: replace bounce easing with smooth pulse (PR #1412)
- [x] Chat UI: replace hardcoded blue with brand primary (PR #1413)
- [x] Report cells: `toolInvocationId` → `toolCallId` for AI SDK compat
- [x] SQL result card: narrow `executionMs` type before arithmetic
- [x] Railway deployments failing on main — `@useatlas/sdk` built after `packages/react` in api/api-eu/api-apac/web Dockerfiles (#1516, PR #1518)

---

## 1.1.0 — Notebook Evolution

**Make the notebook surface earn its place** by bridging exploratory chat and persistent dashboards. PRD: #1396. Milestone: #33.

### Phase 1 (core flow)
- [x] Execution metadata on tool results — timing + row count (#1397, PR #1404)
- [x] Convert chat to notebook — API + UI (#1398, PR #1405)
- [x] Dashboard bridge from notebook cells (#1399, PR #1406)

### Phase 2 (sharing + polish)
- [x] Report route — shareable notebook view (#1400, PR #1409)
- [x] Fork UX — "What if?" affordance + gutter indicators (#1401, PR #1419)
- [x] Execution metadata — rerun comparison (#1402, PR #1411)
- [x] Notebook guide docs update for all 1.1.0 features (#1414, PR #1415)

### Follow-ups
- [x] Extract shared `transformMessages` to `@useatlas/types/conversation` (#1393, PR #1417)
- [x] Fix report-view test: `toolInvocationId` → `toolCallId` (#1416, #1418)
- [x] Publish `@useatlas/types` 0.0.10 — conversation entrypoint

---

## 1.2.0 — Developer/Published Mode

**Stripe-style dual-mode experience with draft/published content model.** Admins configure in developer mode (drafts), publish atomically to users. Demo data is the initial published content for new signups. PRD: #1421. Milestone: #34.

### Foundation
- [x] Schema migration — add `status` column to connections, semantic_entities, prompt_collections (#1423, PR #1443)
- [x] Mode resolution middleware + RequestContext propagation (#1424, PR #1442)
- [x] Onboarding — save demo as `__demo__` connection with `demo_industry` setting (#1425, PR #1446)

### Query Layer
- [x] Published mode query filtering across connections, entities, prompts (#1426, PR #1447)
- [x] Developer mode overlay queries — entity CTE + union queries (#1427, PR #1451)
- [x] Write path mode-awareness — draft creation, draft edits, tombstones (#1428, PR #1461)

### Publishing
- [x] Atomic publish endpoint with `archiveConnections` parameter (#1429, PR #1464)
- [x] Archive/restore connection endpoints with entity cascade (#1437, PR #1469)

### Agent & Data
- [x] Agent isolation — mode-aware connection + whitelist in tool execution (#1430, PR #1460)
- [x] Semantic diff scoping — filter `getDBSchema` to whitelist (#1431, PR #1462)
- [x] Prompt library mode scoping — demo industry filtering + draft visibility (#1438, PR #1465)
- [x] `GET /api/v1/mode` endpoint (#1439, PR #1453)

### Frontend
- [x] Connect page redesign — two equal-weight paths (#1432, PRs #1449, #1456)
- [x] Developer mode banner + cookie-based toggle (#1433, PR #1445)
- [x] Non-admin demo indicator chip (#1434, PR #1459)
- [x] Admin surface — draft/demo badges, read-only published, pending changes summary (#1435, PR #1463)
- [x] Empty states in developer mode (#1436, PR #1467)

### Bug Fixes
- [x] Bundle cybersec + ecommerce semantic directories in Docker image (#1422, PR #1441)
- [x] Docker COPY for demo-semantic and SQL seed symlinks (#1440, PR #1441)
- [x] Partial unique indexes on semantic_entities are NULL-unsafe for connection_id (#1444, PR #1447)
- [x] Scaffold template layout override — strip ModeBanner for standalone deploys (commit 079f8996)
- [x] Scaffold types.ts — `ADMIN_ROLES`/`ATLAS_MODES` missing from published `@useatlas/types` (PRs #1457, #1458 — bumped to `0.0.11`, consumer refs updated; #1448 closed as superseded)
- [x] `admin-publish` reads `demo_industry` setting with wrong key — Phase 4b skips demo-prompt archive (#1466, PR #1486)
- [x] `readDemoIndustry` silent fallback drops prompt cascade on read failure (#1470, PR #1486 — extracted to `lib/demo-industry.ts` with discriminated `{ ok, value | err }` result)
- [x] `client.release()` after ROLLBACK failure may return poisoned connection to pool (#1471, PR #1486 — four sites: admin-archive, admin-publish, migrate, internal.cascadeWorkspaceDelete)
- [x] Organization SaaS columns skipped on first-boot migrations — blocks `checkResourceLimit` (#1472, PR #1484 — reordered Better Auth before Atlas migrations, added `0027_organization_saas_columns.sql`, `skip` list for non-managed deploys)

### Follow-ups
- [x] Rollback poisoning: `hardDeleteWorkspace` and naked ROLLBACK in internal.ts (#1485, PR #1490 — tracks `rollbackErr` at both sites, passes to `client.release(err)`)
- [x] Semantic entity unique index missing `entity_type` — us/apac internal DB `INTERNAL_DB_UNREACHABLE` live incident (#1489 — migration 0028, applied directly to prod + shipped as durable fix)
- [x] Signup-connect error-isolation tests double-counting Next.js dev-tools alert (#1488, PR #1489 — scoped queries to `<main>`)
- [x] Obsidian plugin doc — stale `/api/chat` → `/api/v1/chat` (#1491, surfaced by docs audit)
- [x] Migrate `internalQuery` call sites from `Effect.promise` to `Effect.tryPromise` (#1468, PR #1493 — 37 sites across 15 routes; extracted `queryEffect<T>()` helper in `@atlas/api/lib/effect` with normalized catch; `makeQueryEffectMock` test helper; found during #1465 silent-failure review)
- [x] Pre-existing flaky middleware test `mode 'managed' with valid session returns authenticated` (#1483 — fixed by isolating from internal DB so SSO enforcement check short-circuits)
- [x] `@atlas/mcp` test suite — 4 tests failing with `Export named getConfig not found` SyntaxError (#1487 — root cause was a static import of `detectAuthMode` added in PR #1484; reverted to dynamic import)

---

## 1.2.1 — Adaptive Starter Prompts

**Replace hardcoded starter prompt grid with an adaptive surface.** Composes per-user favorites, admin-moderated popular queries, and industry-filtered fallback. Participates in the 1.2.0 draft/published mode system so admins control what their team sees. PRD: #1473. Milestone: #35.

### Foundation
- [x] Resolver + `/api/v1/starter-prompts` endpoint + cold-start empty state (#1474, PR #1492 — `StarterPromptResolver` with 4-tier compose order, library + cold-start live; favorites/popular stubbed for later slices; shared types in `@useatlas/types/starter-prompt`; id namespacing; chat empty state wired)

### Personal surface
- [x] Per-user favorites (pin/unpin + resolver integration + pin-on-hover UX) (#1475, PR #1496 — `FavoritePromptStore` with cap enforcement + duplicate detection, POST/DELETE/PATCH `/favorites` routes with 401/403/404 surfaces, resolver composes favorites ahead of library tier, empty-state Pin icon + hover unpin, hover pin affordance on user-authored messages, browser test covering pin → reload → unpin flow, `ATLAS_STARTER_PROMPT_MAX_FAVORITES` env var + config field, migration `0029_user_favorite_prompts.sql`)

### Admin moderation
- [x] Schema migration + auto-promote + read-only admin queue (#1476, PR #1495 — orthogonal state matrix on `query_suggestions` (`approval_status` × `status`), `SuggestionApprovalService.checkAutoPromote` pure decision function with below/already-promoted/outside-window/already-reviewed reasons, `incrementSuggestionClick(userId)` with atomic upsert + CTE for distinct-user tracking, `GET /api/v1/admin/starter-prompts/queue` returning pending/approved/hidden buckets, read-only 3-tab admin page at `/admin/starter-prompts`, migration `0030_starter_prompt_approval.sql` (rebased over #1496's 0029), `ATLAS_STARTER_PROMPT_AUTO_PROMOTE_CLICKS` (default 3) + `ATLAS_STARTER_PROMPT_COLD_WINDOW_DAYS` (default 90) configs)
- [x] Admin moderation UX — approve/hide/unhide + author form (#1477, PR #1499 — `SuggestionApprovalStore` mutations with tagged errors + 3-way outcome (ok/not_found/forbidden) + guard SELECT to distinguish 404 vs 403, admin mutation routes `POST /api/v1/admin/starter-prompts/:id/{approve,hide,unhide}` + `/author` (author skips pending queue with `approval_status='approved' + status='published'`), popular tier now reads `approval_status='approved'` only, resolver composes favorites → popular → library → cold-start, chat empty state shows subtle "Popular" badge, all UPDATEs carry `(id, org_id)` predicates as belt-and-braces, 15 approval-store unit tests + 14 admin-route integration tests + popular SQL contract regression guard + browser test author→hide→unhide→approve without reload, `/guides/starter-prompt-moderation` docs + regenerated OpenAPI MDX for 4 new endpoints)
- [x] 1.2.0 mode participation + CLAUDE.md Content Mode System rule (#1478, PR #1503 — `SuggestionApprovalService` mutations (approve/hide/unhide/author) now honor `atlasMode` and write `status='draft'` in developer mode / `'published'` otherwise, `/api/v1/admin/publish` phase 3d promotes draft `query_suggestions` atomically alongside connections/entities/prompt-collections (partial failure rolls back across all four), `/api/v1/mode` `draftCounts` gains `starterPrompts` count via UNION segment, `getPopularSuggestions(orgId, limit, mode)` now gates by `status IN ('published', 'draft')` in developer mode and `status='published'` otherwise, pending-changes banner renders a `N starter prompts` segment after prompts, CLAUDE.md Core Rules Checklist gains a "Content Mode System" section (new user-surfaced content tables must include `status` column + participate in mode middleware + be visible to atomic publish endpoint; carve-outs must be explicit like `user_favorite_prompts`), integration tests for full draft→publish flow including atomic-rollback when Phase 3d fails)

### Other surfaces
- [x] Widget empty state + `starterPrompts` prop override (#1479, PR #1498 — `@useatlas/react` 0.0.7→0.0.8 with TanStack-driven empty state, `useStarterPromptsQuery` hook `enabled: false` when prop supplied (privacy-correctness guarantee: no `/api/v1/starter-prompts` fetch from embedded contexts), `data-starter-prompts` JSON attribute on script tag forwarded as iframe query param, `sanitizeStarterPrompts()` helper with `null` sentinel for fetch-from-API vs. non-null array for skip-the-fetch, capped payload size + per-string length, hardcoded `STARTER_PROMPTS` constant deleted, provenance badges match web, 6 unit tests with network assertion via mock(fetch) + widget-loader tests + `sanitizeStarterPrompts` exhaustive tests + Playwright zero-request override assertion, docs updates to `embedding-widget.mdx` + `reference/react.mdx`, template refs deferred per version-bump-ordering feedback)
- [x] Notebook new-cell empty state (#1480, PR #1501 — extracted shared `<StarterPromptList>` in `packages/web/src/ui/components/chat/starter-prompt-list.tsx` (provenance badges + optional unpin affordance + cold-start CTA), new `useStarterPromptsQuery` TanStack hook in `packages/web/src/ui/hooks/`, chat empty state re-points at the shared component with no behavior change (Pin/Popular/library + unpin-on-hover), notebook empty state renders adaptive list + cold-start message and routes click → `notebook.appendCell(text)` via `NotebookShell` prop wiring, 9 unit tests for the component + Playwright spec `notebook-starter-prompts.spec.ts` with mocked endpoint asserting ordering/provenance and cell-insertion, `PinOff` import dropped from `atlas-chat.tsx`)
- [x] SDK `atlas.getStarterPrompts()` method (#1481, PR #1497 — `@useatlas/sdk` 0.0.9→0.0.10 with `getStarterPrompts(options?: { limit? })` wrapping `GET /api/v1/starter-prompts`, re-exports `StarterPrompt`/`StarterPromptProvenance`/`StarterPromptsResponse` from `@useatlas/types` via SDK index, TDD flow (integration test red-bar first), 4 integration tests validating ordering parity with direct HTTP + `limit` forwarding + 401 behavior, dedicated `docs/sdk/starter-prompts.mdx` page + nav registration + cross-link from `reference/sdk.mdx` explaining API-key→user context mapping for favorites visibility, template refs deferred per version-bump-ordering feedback)

### CLI
- [x] `atlas learn` populates pending approval queue (#1482, PR #1500 — explicit `approval_status='pending'` + `status='draft'` on `upsertSuggestion` INSERT so CLI-populated rows flow through the `/admin/starter-prompts` Pending tab (matching the organic click-promote path), new `--auto-approve` operator flag skips the queue with `approved+published` on new rows only (`ON CONFLICT` preserves admin's prior hide/approve so re-runs never override moderation state), `GenerateSuggestionsOptions.autoApprove` threaded from CLI → `generateSuggestions` → `upsertSuggestion`, `--auto-approve` requires `--suggestions` and exits 1 otherwise, dry-run SQL contract test captures `approval_status` + `status` columns in the INSERT and asserts `ON CONFLICT DO UPDATE` never mutates either axis, 3 integration tests on `generateSuggestions` for autoApprove=false/true/undefined propagation, CLI docs describe the moderation step + `--auto-approve` escape hatch, help text updated)

### Follow-ups
- [x] Migrate `atlas-chat.tsx` to `useStarterPromptsQuery` + TanStack pin/unpin (#1504, PR #1510 — chat empty state now consumes the shared TanStack hook; pin/unpin use `queryClient.setQueryData` instead of local `useState<StarterPrompt[]>`; cross-surface cache verified so pinning in chat updates notebook without a re-fetch; new `starter-prompts-cache-contract.test.tsx` locks the `["atlas", "starter-prompts", apiUrl]` query-key contract + cache-based optimistic reads)
- [x] Consolidate duplicated fetch logic between `@useatlas/react` and `packages/web` hooks (#1505, PR #1511 — extracted `fetchStarterPrompts(config)` into `@useatlas/sdk` with 5xx→[] soft-fail / 4xx throw / requestId extraction / AbortError-quiet discipline; web hook 90→47 lines, react hook 83→41 lines; also wrapped `res.json()` on 200 path to soft-fail malformed bodies and suppressed warn on React Query cancellation; 18 unit tests vs. original 13; `@useatlas/sdk` 0.0.10→0.0.11; template refs bumped in same PR + scaffold re-run after publish)
- [x] Migration header number drift (#1502, PR #1509 — audit found 8 migrations with filename-vs-header drift: `0006_byot_credentials.sql`, `0016_invitations_org_id.sql`, `0017_dashboards.sql`, `0018_dashboard_refresh.sql`, `0019_expert_amendments.sql`, `0020_plan_tier_rename.sql`, `0027_organization_saas_columns.sql`, `0030_starter_prompt_approval.sql`; all corrected in one PR; filename-based runner was unaffected throughout)
- [x] Document 1.2.0 / 1.2.1 route-response error codes (#1507, PR #1508 — surfaced by /docs-audit; new "Route-Response Error Codes" section in `error-codes.mdx` with `demo_readonly`, `workspace_migrating`, `misdirected_request`, `duplicate_favorite`, `favorite_cap_exceeded`, `invalid_favorite_text`, plus cross-ref comment in `packages/types/src/errors.ts` pointing readers to the broader docs page when adding future non-chat codes)

---

## ContentModeRegistry (#1515)

**Consolidate the draft/published mode wiring behind a single registry.** The 1.2.0 mode system was shallow — four content tables participated via three different read-filter styles, a hand-written UNION ALL for draft counts, and four parallel UPDATE phases in the atomic publish endpoint. Adding a fifth table required coordinated edits across 6+ files with no compile-time enforcement. Parent issue: #1515. Architecture win #26.

### Phase 1 — Library
- [x] `ContentModeRegistry` service + static `CONTENT_MODE_TABLES` tuple + `InferDraftCounts<T>` type derivation (#1517 — 6 new files under `packages/api/src/lib/content-mode/`: `port.ts` with `SimpleModeTable` | `ExoticModeAdapter` discriminated union, `tables.ts` with the static tuple, `infer.ts` with compile-time wire-type equality assertion against `ModeDraftCounts`, `registry.ts` with Effect Context.Tag service exposing `readFilter` / `countAllDrafts` / `runPublishPhases`, plus boundary tests; phase 1 review fixes merged into same squash: fail-loud semantic_entities stub, exhaustive `kind` guards via `assertNever`, fold `PublishPhaseError`/`UnknownTableError`/`ExoticReadFilterUnavailableError` into `AtlasError` union + `mapTaggedError`, duplicate-key startup guards, strict NaN/negative/unknown-key handling in `countAllDrafts`)

### Phase 2 — Caller migrations
- [x] 2a — `mode.ts` → `registry.countAllDrafts` (#1519, PR #1525 — drop hand-written `DRAFT_COUNTS_SQL` + `rowsToCounts`; add `makeInternalDBShimLayer()` for route handlers that need InternalDB without opening a second pool; replace inline `Effect.tryPromise` with `queryEffect` for consistency; `mapTaggedError` for `PublishPhaseError` branches on `phase === "count"` with neutral message for read endpoints)
- [x] Test-mock hygiene follow-up — add `InternalDB` + `makeInternalDBShimLayer` to shared factory (`MockInternalDB` + `makeMockInternalDBShimLayer`) and 6 standalone partial mocks (#1524, PR #1526 — unblocked module-top imports for 2b/2c/2d/2e)
- [x] 2b — `prompts/scoping.ts` → `registry.readFilter` (#1520, PR #1527 — module-level `makeService(CONTENT_MODE_TABLES)` + `Effect.runSync`; alias every `prompt_collections` column with `pc.`; demo-industry + custom-vs-builtin scoping stays in `scoping.ts`)
- [x] 2c — `admin-connections.ts` → `registry.readFilter` (#1521, PR #1528 — same pattern as 2b. `admin-starter-prompts.ts` also in #1521's scope but has no mode-status filters; `getPopularSuggestions` in `lib/db/internal.ts` tracked separately in #1531 because `internal.ts` can't import `content-mode` without a cycle)
- [x] 2d — Replace `semantic_entities` stub with real `applyTombstones` + `promoteDraftEntities` composition (#1522, PR #1529 — new `content-mode/adapters/semantic-entities.ts` wraps the existing helpers in Effect + `PublishPhaseError` tagged by phase; adapter-boundary tests for ordering / failure / no transaction control)
- [x] 2e — `admin-publish.ts` → `registry.runPublishPhases` (#1523, PR #1530 — four UPDATE phases + `applyTombstones` + `promoteDraftEntities` collapse to one `runPublishPhases` call inside the existing BEGIN/COMMIT. `PromotionReport[]` projected back to the wire schema via `findReport(table)`. Phase 4 archival stays outside the registry — it's lifecycle, not promotion. `promoted` count falls back to `rows.length` when `rowCount` absent so test mocks stay tolerant)

### Follow-ups
- [x] Migrate `getPopularSuggestions` in `lib/db/internal.ts` (#1531 — added `resolveStatusClause(table, mode, alias)` to `content-mode/port.ts` as a pure, non-Effect helper; registry `readFilter` delegates to it so Effect and non-Effect callers share one source of truth. `buildUnionStatusClause` + `lib/mode.ts` retired.)

---

## Admin Console Revamp

**Progressive-disclosure redesign across `/admin/*` pages.** `/critique` baseline flagged empty-state walls of forms and duplicated per-card state. Pattern: `CompactRow` (thin row with status dot + right-aligned action button) expands in place into `IntegrationShell` / `ProviderShell` / etc. via `useDisclosure`; connected rows stay expanded to surface detail rows via `DetailList`. `--primary` teal retuned in `globals.css` for stronger action surfaces (brand mint preserved in `brand.css` for www / docs / sidebar). Skill flow: `/critique` → `/distill` → `/colorize` → `/revamp`.

### Tooling
- [x] `/revamp` slash command (PR #1539) — encodes the page-revamp workflow + `CompactRow` / `IntegrationShell` / `DetailList` / `InlineError` / `SectionHeading` primitives cheat sheet
- [x] Deeper `--primary` teal for UI action surfaces (PR #1538) — light `oklch(0.759 0.148 167.71)` → `oklch(0.58 0.185 167.71)`; dark chroma `0.148` → `0.175`
- [x] ScrollArea on sidebar, admin layout, conversation list (PR #1559) — overflow polish for long admin pages + conversation lists

### Pages (initial batch)
- [x] `/admin/integrations` — CompactRow with inline expansion across 8 platforms + brand teal retune (PR #1538)
- [x] `/admin/email-provider` — scope to org, lock provider to Resend (#1540)
- [x] `/admin/billing` — CompactRow + detail list (PR #1544)
- [x] `/admin/branding` — CompactRow + live preview shell (PR #1548)
- [x] `/admin/custom-domain` — CompactRow + full shell (PR #1549)
- [x] `/admin/sandbox` — CompactRow + live shell (PR #1550)
- [x] `/admin/residency` — CompactRow + progressive disclosure (PR #1553)
- [x] `/admin/starter-prompts` — dialog + trim empty state (PR #1554)
- [x] `/admin/settings` — CompactRow + per-section icons (PR #1552)
- [x] `/admin/model-config` — BYOT gate + CompactRow (PR #1556)

### Pages (second wave — post-primitive extraction)
- [x] `/admin/plugins` — CompactRow + progressive disclosure (PR #1560)
- [x] `/admin/sso` — CompactRow + progressive disclosure (PR #1561)
- [x] `/admin/connections` — CompactRow + progressive disclosure (PR #1562)
- [x] `/admin/ip-allowlist` — CompactRow + progressive disclosure (PR #1565)
- [x] `/admin/scim` — CompactRow + progressive disclosure (PR #1566)
- [x] `/admin/api-keys` — CompactRow + progressive disclosure (PR #1586)

### Primitive extraction & migration (#1551)
- [x] Extract `CompactRow` / `IntegrationShell` / `DetailList` / `InlineError` / `SectionHeading` primitives to `@/ui/components/admin/compact/` (#1551, PR #1573 — triggered on third adopter per the #1551 rule)
- [x] Migrate initial-batch pages to shared primitives: `/admin/custom-domain` (PR #1574), `/admin/billing` (PR #1575), `/admin/model-config` (PR #1576), `/admin/plugins` (PR #1577), `/admin/sandbox` (PR #1578), `/admin/residency` (PR #1579), `/admin/branding` (PR #1580), `/admin/ip-allowlist` (PR #1581), `/admin/sso` (PR #1582), `/admin/settings` (PR #1583), `/admin/connections` (PR #1584), `/admin/scim` (PR #1585)

### Bucket 1 — queue/moderation (tracker #1588)
Critique pass across `/admin/actions`, `/admin/learned-patterns`, `/admin/approval`, `/admin/abuse` identified shared shape: button-row filter affordance, inline-expand or Sheet detail (page-dependent), reason-on-deny dialog with audit reason capture, single funneled error banner, `RelativeTimestamp` with absolute tooltip, real optimistic revert with snapshot-inside-functional-setState, `extractFetchError` for requestId preservation, type-specific payload rendering. Primitives extracted on third adopter (PR 3 = `/admin/approval`, PR #1600) into `@/ui/components/admin/queue/` — architecture win #27.
- [x] `/admin/actions` — reason-on-deny dialog (closed legacy "Denied by admin" hardcode) + `PayloadView` SQL/API/file/JSON branch rendering + single ErrorBanner + `extractFetchError` (PR #1592)
- [x] `/admin/learned-patterns` — real optimistic revert + server error surfacing + button-row filter consolidation + StatCards → inline strip + `bulkPartialSummary` for 200-with-errors response (PR #1594)
- [x] `/admin/approval` — structural revamp (Tabs-as-pages → CompactRow, always-visible review form → inline expand, bulk actions, deny confirmation) + extracted `QueueFilterRow` / `RelativeTimestamp` / `ReasonDialog` / `useQueueRow` / `bulkFailureSummary` / `bulkPartialSummary` to `@/ui/components/admin/queue/` (PR #1600)
- [x] `/admin/abuse` — investigation panel with live counters + threshold annotations + escalation timeline + prior-instance history + Reinstate-on-evidence footer; new `GET /api/v1/admin/abuse/:workspaceId/detail` with `splitIntoInstances()` pure helper (7 unit tests); 3 silent-failure-hunter findings fixed pre-merge (404 `not_flagged` routing, empty-timeline copy, invalidates scope) (#1589, PR #1641) — **Bucket 1 now 4/4 complete**

### Bucket 2 — data tables (tracker #1588)
Per-page polish, not restructure. Targeted `/critique` + `/arrange`/`/polish`/`/clarify` per the tracker's intent. Primitives only extract if a pattern emerges across 3+ pages.
- [x] `/admin/sessions` — AlertDialog confirm on single-row Revoke (previously one-click destructive) + RelativeTimestamp on Created/Last Active + migrated from bespoke fetch to `useAdminFetch` + `perPage` URL drift fix + `Promise.allSettled` + `bulkFailureSummary` for partial failures (PR #1628, review-driven fixes in same PR)

### Bug fixes (surfaced during revamp)
- [x] `parseCIDR` crashes on non-string DB rows — auth middleware 500d, broke admin-integrations tests (#1541, PR #1546)
- [x] Drop `aria-controls` from CompactRow triggers whose panel isn't mounted — disclosure pattern correctness (#1545, PR #1547)
- [x] `useAdminMutation` dialog stays open on 204 No Content + `combineMutationErrors` helper surfaces concurrent failures (#1555, #1557, PR #1558)
- [x] `setState`-in-render on SaaS-mode redirect in `/admin/plugins` — moved redirect into `useEffect` (#1563, PR #1564)
- [x] `ip-allowlist` enforcement status lies when EE disabled or internal DB missing — surface `effectivelyEnforced` in response (#1567, PR #1571)

### Feature polish
- [x] Distinct `EnterpriseError` rendering in `AdminContentWrapper` — paywall upsell vs generic error (#1569, PR #1572)
- [x] SCIM stale-sync badge + schema passthrough (#1568, PR #1570)

### Follow-ups
- [x] Extract `CompactRow` / `ProviderShell` primitives to `@/ui/components/admin/` after third adopter (#1551, PR #1573)
- [x] `useAdminMutation` dialog stays open when server returns 204 No Content (#1555, PR #1558)
- [x] Admin mutation banners: surface concurrent failures instead of narrowing to first (#1557, PR #1558)
- [x] Silent clipboard failure on one-time-reveal Copy button in `/admin/api-keys` (#1587, PR #1599)
- [x] Atomic `POST /api/v1/actions/bulk` endpoint (#1590, PR #1601)
- [x] Expand pricing EE comparison + unify Business-plan gating (#1597, #1598, PR #1605) — 13 EE features shown (was 4), Business tier card backfilled, 22 docs MDX pages unified, `admin-domains`/`admin-residency` route descriptions fixed at source
- [x] OpenAPI ↔ api-reference drift CI gate (#1606, PR #1605) — `scripts/check-openapi-drift.sh` catches route changes that forget `openapi:extract`. Caught real drift on first run (#1601's bulk endpoint MDX)
- [x] `useAdminMutation` returns structured `FetchError` (#1595, PR #1614) — `MutateResult.error` carries `{ message, status, requestId, code }`; 13 caller sites migrated atomically; `friendlyError()` + `EnterpriseUpsell` now fire on mutation failures (not just page-load). Architecture win #29
- [x] `ReasonDialog` surfaces thrown `onConfirm` as local error (#1604, PR #1609) — local error state + render `localError ?? error` in alert block; logs via `console.debug` AND surfaces to user; compliance contract test asserts trimmed reason pass-through unchanged
- [x] Out-of-scope stale "enterprise plan" mentions unified to Business plan (#1607, PR #1608) — 4 MDX + 1 route source + regenerated api-reference
- [ ] Share `EMAIL_PROVIDERS` via `@useatlas/types` after next publish (#1543)
- [ ] Make `ProviderConfig` a tagged union keyed on provider (#1542)
- [x] `/admin/abuse` row needs investigation depth, not just reinstate (#1589, PR #1641) — shipped as Bucket 1 PR 4 (see Bucket 1 section above)
- [ ] Unify `ActionStatus` / `ActionDisplayStatus`, drop `mapStatus` (#1591)
- [ ] Pure-function tests + e2e spec for `/admin/actions` approval flow (#1593)
- [x] `bulk-summary`: group by failure class, carry requestIds in trailing slot (#1602, PR #1645) — `BulkRequestError` carries `requestId` separately + `extractBulkRequestId()` accepts `{fetchError:{requestId}}` and direct `.requestId` shapes too; identical-message failures collapse to one bucket with trailing `(IDs: ...)` slot instead of splintering per-requestId
- [x] Rollback warning: handle non-string warning shape (#1603, PR #1645) — pure `coerceRollbackWarning(raw: unknown): string | null` helper with compliance contract (never empty string for non-null) + `logUnsurfacedRollbackWarning()` observability helper for schema drift; 13 unit tests on the decision tree
- [x] `plugin-marketplace` docs describe UI that doesn't exist — rewrote guide (Option 1) to match shipped admin UI with a sentinel WARN callout about missing self-service browse; softened "Enterprise badge doesn't exist" to "no separate tier badges" (#1610, PR #1645)
- [x] `bulkFailureSummary` loses non-Error rejection values (#1611, PR #1619) — one-line `String(r.reason)` fallback + new test file `bulk-summary.test.ts` covering both Error and non-Error rejection paths; also migrated an older `queue-bulk-summary.test.ts` into the proper `__tests__/` dir
- [x] `ReasonDialog` caller `error` prop hidden while `localError` is set (#1612, PR #1645) — `useEffect` on `error` prop clears stale localError when a fresh non-null error arrives; null→null transition is a no-op; covers retry-flow distinct-non-null cases
- [x] `AtlasChat` demo usage has unknown prop `chatEndpoint` / `conversationsEndpoint` (#1613, PR #1618) — added `@atlas/web` to root `bun run type` so future drift catches in CI; surfaced a concrete repro (#1621 — props genuinely don't exist on current `AtlasChatProps` build) tracked as follow-up
- [x] `useAdminMutation.error` hook-level field still flattens `FetchError` — ~40 admin pages (#1615, PR #1622) — hook-level `error` widened to `FetchError | null`; `friendlyError()` + new `friendlyErrorOrNull()` helper rolled out atomically; architecture win #30
- [x] ESLint guard to prevent re-introducing `{ message: result.error }` wrap (#1616, PR #1622) — `no-restricted-syntax` rule in root `eslint.config.mjs`; broader `.error?.y` optional-chain variant carved out as follow-up #1625
- [x] `useAdminMutation` catch conflates `invalidates()` callback errors with fetch errors (#1617, PR #1622) — `invalidates()` callbacks moved outside the `mutateAsync` try-catch; throwing invalidates no longer flips `result.ok` or populates `error`; debug log preserved
- [x] Sibling to #1611: `action-approval-card` surfaces 'Unknown error' when `res.text()` rejects (#1620, PR #1633)
- [x] Follow-up to #1613: demo page still references `chatEndpoint` / `conversationsEndpoint` that don't exist on `AtlasChatProps` — decide wire-up vs drop (#1621, closed stale) — props actually exist on `AtlasChatProps` (`packages/react/src/components/atlas-chat.tsx:56-58`, added in `91213d18` / #677) and are threaded through to `DefaultChatTransport` + `useConversations`; both `bun run type` and `tsgo --noEmit -p packages/web/tsconfig.json` pass clean on `main`. No code change needed
- [x] Dead `enterprise_required` gate branch in `/admin/custom-domain` — server now emits `403 enterprise_required` on EE-off writes via existing `EnterpriseError → classifyError` plumbing (no new mapping). Read endpoints stay `404 not_available` (scope guard test). Matches `/admin/branding`/`/admin/sso` precedent; non-EE admins now see polished plan-gate CompactRow / EnterpriseUpsell instead of generic 404 (#1623, PR #1637)
- [x] `MutationErrorSurface` phase 1 — route mutation `FetchError`s through `EnterpriseUpsell` / `FeatureGate` / `ErrorBanner` with an `inline` variant for compact rows (#1624, PR #1650) — banner + inline variants, 10 branch tests, migrated `/admin/sso` + `/admin/scim` + `/admin/branding` + `/admin/billing` + `/admin/ip-allowlist`; architecture win #31. Phase 2 (~35 remaining pages) tracked in #1649
- [x] Broaden `no-restricted-syntax` guard to catch `{ message: X.error?.y }` optional-chain variants (#1625, PR #1633)
- [x] Regression test for structured plan-gate in `/admin/custom-domain` (code-based, not message-substring) (#1626, PR #1634)
- [x] Cover `combineMutationErrors` + `formError` fallback chain in `/admin/email-provider` (#1627, PR #1634)
- [x] Shared `ADMIN_FETCH_QUERY_KEY` constant between `useAdminFetch` + `useAdminMutation` (#1630, PR #1633) — `packages/web/src/ui/hooks/admin-query-keys.ts`; prevents silent cache-stale on rename
- [x] `useAdminMutation` concurrent error state stomping (#1629, PR #1635, architecture) — per-item error slots in `errorsByItemId`, unblocks every bulk-mutation admin page. Architecture win candidate #31 (pending entry in architecture-wins.md)
- [x] Sessions e2e smoke spec + pure-function tests for `shortUA` + `SessionsListSchema` round-trip (#1631, PR #1651) — first bucket-2 e2e (`e2e/browser/admin-sessions.spec.ts`) covers load + cancel-revoke + confirm-revoke + bulk-revoke + bulk-partial-failure with `page.route()` mocks so the admin's own session isn't revoked; `shortUA` + schema round-trip unit tests pin the contracts
- [x] Extract + unit-test `errorRatePct` branch in abuse detail (#1638, PR #1681) — pure helper in `abuse-instances.ts` with validation (throws on NaN/Infinity/negative), clamps to 100, 2-decimal rounding (preserves detail-panel threshold-comparison boundary)
- [x] Integration test for `getAbuseDetail` against real in-memory state (#1639, PR #1681) — 6 tests seeded via `recordQueryEvent` + DB fixtures covering existing/missing/reinstated/re-flagged/baseline-pending/DB-failure paths
- [x] Resolve `workspaceName` in abuse list + detail routes (#1640, PR #1645) — new `getWorkspaceNamesByIds()` batch helper avoids N+1; advisory fallback to null with `log.warn` (stack + orgIdCount + sampleOrgIds) on DB failure; admins now see display names instead of opaque `org_01K...` ids
- [x] Single-source Zod schemas for `AbuseDetail` (#1642, PR #1647) — new `@useatlas/schemas` workspace package (private, source-direct, depends on `@useatlas/types` + `zod`). 6 abuse schemas migrated (AbuseEvent/Status/ThresholdConfig/Counters/Instance/Detail); OpenAPI spec byte-identical after migration; tightened `z.enum(ABUSE_LEVELS)` where web was `z.string()`. Architecture win #32. Remaining 15+ schema pairs tracked in #1648
- [ ] `z.enum()` vs `z.string()` — tighten client validation in `admin-schemas.ts` (#1643, architecture, follow-up to PR #1641)
- [x] Factory + computed helpers for `AbuseInstance` invariants (#1644, PR #1681) — `makeInstance` → exported `createAbuseInstance(events)`; 10 invariant tests; architecture win #34. Advisory at the language level (interface is still structural); brand/discriminated-union upgrade tracked at #1684
- [x] Regenerate `apps/docs/openapi.json` + api-reference MDX after #1641 merge (CI drift gate #1606 caught it post-merge, commit c807b91f)
- [x] Bundled 5-bug sweep PR #1645 — closes #1602 + #1603 + #1610 + #1612 + #1640 in one PR with review-driven follow-ups inlined (silent-failure R1+A1, pr-test-analyzer coverage gaps, all 8 comment-analyzer polish items, B1 future-proofing). 5-agent review + fix cycle. 16 new tests (17 bulk-summary + 13 rollback-warning + 4 reason-dialog + 3 admin-abuse); total tests after merge: api 242/242, cli 19/19, web 70/70, ee 25/25, react 9/9
- [x] Post-PR-#1647 CI recovery (commit 67f8c546) — `@useatlas/schemas` workspace addition broke `Check Dockerfile workspace completeness` (2 missing COPY lines) and `Scaffold (docker)` smoke test (`Module not found: @useatlas/schemas` in scaffolded build). Railway api-eu/api-apac deploys failed from same root cause. Fixed by adding COPY lines to both Dockerfiles + path-alias + `prepare-templates.sh` Step 5e that copies `packages/schemas/src/` into both templates as `src/schemas/`. Branch CI didn't catch it because the Dockerfile completeness check only runs post-merge on main
- [x] `bulkFailureSummary` recognize `requestId` on non-`BulkRequestError` rejections (#1646, PR #1645 inline) — `extractBulkRequestId()` accepts BulkRequestError, `{ fetchError: { requestId } }`, and direct `.requestId` shapes; filed as follow-up during review then fixed inline before merge

---

## 1.2.2 — Admin Console Polish & Schema Consolidation — CLOSED

**Milestone #36. Shipped 2026-04-20.** 70+ issues closed across 50+ PRs. Admin console final-pass (Buckets 1+2+4 complete, 3+5 explicitly deferred by design); `@useatlas/schemas` wire-format consolidation across 5 phases (18 schemas migrated, `admin-schemas.ts` 542 → 241 lines); 3 `@useatlas/types` publish cycles (0.0.11 → 0.0.14) landing `Percentage`/`Ratio`/`EMAIL_PROVIDERS`/`HEALTH_STATUSES` tuples + 4 discriminated-union migrations (`ProviderConfig`, `ActionStatus` unification, `ApprovalRule`/`Request`, `RegionMigration`); `MutationErrorSurface` phase 1 + 2A–2D + branded `FeatureName` registry shipped across ~40 admin pages; residency hardening; `buildFetchError` empty-message invariant at the system boundary; 10+ architecture wins recorded (#34–#43). No items rolled forward — milestone fully closed.

### Shipped
- [x] DB CHECK + server-side enum drift coercion for `abuse_events.level` / `trigger_type` (#1653, PR #1655) — migration `0031_abuse_events_enum_checks.sql` coerces pre-drifted rows to safe defaults (`none` / `manual`) then adds idempotent `CHECK` constraints; server-side `coerceAbuseEnums()` helper validates hydrated rows against canonical tuples and emits `log.warn` on drift; replaces unchecked `as AbuseLevel` / `as AbuseTrigger` casts in `getAbuseEvents` + `restoreAbuseState`; 3 TDD drift tests
- [x] ApprovalRule / ApprovalRequest + CustomDomain → `@useatlas/schemas` (#1648 chunk, PR #1654) — second consumer of the package after AbuseDetail; deletes route-level copies in `admin-approval.ts` + `shared-domains.ts` and web-level copies in `admin-schemas.ts`; tightens `ApprovalRule.ruleType` / `ApprovalRequest.status` / `CustomDomain.status` / `CustomDomain.certificateStatus` from relaxed `z.string()` to strict `z.enum()`; 22 TDD tests; zero OpenAPI diff. Follow-ups #1660 / #1661 / #1662 filed during review
- [x] `MutationErrorSurface` phase 2A — platform/* subtree (#1649 chunk A, PR #1656) — 7 `/admin/platform/*` pages migrated (backups, domains, page.tsx, plugins, residency, settings, sla); `FormDialog` `serverError` props stay on `friendlyErrorOrNull()` per phase-1 contract; local-synthesized last-wins strings preserved per carve-out. Follow-ups #1657 (assignmentsError consistency) / #1658 (early-return drops wsError) / #1659 (wire onRetry on configError) filed during migration
- [x] `admin-approval listQueueRoute` — zod-openapi enum validation on `?status=` (#1662, PR #1664) — silent fallback on typoed status replaced with `z.enum(APPROVAL_STATUSES).optional()` query schema; invalid values now 422 `validation_error` (not silently all-statuses); removes double-cast + hardcoded list; OpenAPI spec surfaces valid enum automatically; 4 TDD tests
- [x] Platform/* migration follow-up bundle (#1657 + #1658 + #1659, PR #1663) — 9-line sweep: `/admin/platform/residency` assignmentsError → `MutationErrorSurface`, `/admin/platform/` page drops silent early-return that dropped wsError on dual failure, `/admin/platform/backups` Retry button wired to `clearConfigError`
- [x] Bucket 2 — `/admin/users` polish + MutationErrorSurface migration (#1588 bucket-2, #1649 subset, PR #1665) — RelativeTimestamp + AlertDialog confirms on destructive actions (sign-out-sessions / revoke-invitation / role-demotions) + copy clarify (Revoke Sessions → Sign out all sessions, Pending Invitations → Invitations + count) + `adminAction.error` / `revokeInvitation.error` through `<MutationErrorSurface feature="Users">`; extracted `roles.ts` pure module + columns structural test; scope guard honored (no `useAdminFetch` migration, no shared confirm-dialog primitive)
- [x] IntegrationStatus family → `@useatlas/schemas` (#1648 chunk 3, PR #1669) — 10 per-platform schemas (Slack/Teams/Discord/Telegram/GChat/GitHub/Linear/WhatsApp/Email/Webhooks) deduplicated across route + web; new `INTEGRATION_PLATFORMS` tuple + `IntegrationStatus` interface (+ per-platform sub-interfaces) in `@useatlas/types`; tightens `z.string()` → strict `z.enum(TUPLE)` on `deployMode` and `deliveryChannels`; net **−293/+25** + 23 TDD tests; zero OpenAPI drift. 3 of 15 schemas done
- [x] Bucket 2 — `/admin/organizations` polish (#1588 bucket-2, PR #1668) — `RelativeTimestamp` on Created + member Joined + invitation Sent/Expires; detail sheet split into loading/error/loaded branches (no more "Loading..." stuck in SheetDescription on fetch failure); stats grid fix (`sm:grid-cols-3` with 2 cards → `sm:grid-cols-2`); extracted `roleBadge()` helper + unit test with fail-closed unknown-role fallback (mirrors `/admin/users/roles.ts` pattern); color-coded role badges on detail sheet. Filed follow-ups #1666 (useAdminFetch migration) + #1667 (surface suspend / activate / delete / plan admin actions)
- [x] `MutationErrorSurface` phase 2B — queue/moderation cluster (#1649 chunk B, PR #1670) — 5 pages migrated (`/admin/actions`, `/admin/api-keys`, `/admin/approval`, `/admin/cache`, `/admin/scheduled-tasks`) via ~12 mutation error sites; ReasonDialog API extended with `mutationError` + `feature` props (render precedence: localError → mutationError → legacy string error); `bulkApproveSummary` preserved as local-synth string per carve-out; FormDialog `serverError` stays on `friendlyErrorOrNull()`; 17 of ~35 phase-2 pages done
- [x] `/admin/organizations` plumbing + workspace actions (#1666 + #1667, PR #1672) — Phase A: bespoke `useEffect` list fetch + detail fetch replaced with `useAdminFetch` (lazy detail via extracted `OrgDetailSheet` + `OrgDetailContent`, mirrors `AbuseDetailPanel`); drops `body.message ?? HTTP ${status}` concat. Phase B: Status + Plan columns, per-row actions dropdown (Suspend / Activate / Change plan / Delete) with `AlertDialog` destructive confirms + Dialog + Select for plan, all mutations through one `useAdminMutation` with `itemId` per-row error slots + `MutationErrorSurface`. Detail sheet header surfaces Status + Plan badges + relative `suspendedAt` / `deletedAt`. New `statuses.ts` (`statusBadge()` + `planBadge()` with fail-closed unknown-enum fallback + one-time `console.warn`) + 12 TDD tests. Plan enum aligned with server source (`free/trial/starter/pro/business` from canonical `PlanTier` in `packages/api/src/lib/db/internal.ts`, not the issue text's `team/enterprise`)
- [x] Bucket 2 — `/admin/audit` + `/admin/admin-actions` + `/admin/usage` polish (#1588 bucket-2, #1649 subset, PR #1671) — `<RelativeTimestamp>` on audit + admin-actions + usage trial-end + retention "Last Purge" card; `<TooltipProvider>` wraps so absolute datetime renders on hover; **Run Purge Now** gated by `AlertDialog` confirm (soft-deletes become unrecoverable once the hard-delete delay elapses); `/admin/audit/retention-panel` save/purge errors and `/admin/usage` `portalError` through `<MutationErrorSurface>`; `portalUrlError` kept as local-string fallback with inline comment (non-FetchError edge case); `StatCard.description` widened `string` → `ReactNode`; `/admin/token-usage` reviewed as no-op. Retention-panel policy-load `useAdminFetch` migration left as a scope-guard carve-out (same as #1666 precedent). Bucket 2 **complete** (7/7 pages)
- [x] `MutationErrorSurface` phase 2C — core admin (#1649 chunk C, PR #1673) — 9 pages migrated via ~14 mutation error sites: `/admin/connections` (test + delete), `/admin/custom-domain` (mutation + add), `/admin/email-provider` (structuredError chain), `/admin/model-config`, `/admin/residency` (mutation + migration-fetch), `/admin/sandbox` (page-level + per-row ProviderConnectShell), `/admin/settings`, `/admin/starter-prompts` (AuthorPromptDialog + page-level `rowActionError` re-typed `string → FetchError | null`). Local-synth strings preserved per carve-out (`PoolStatsSection` errors, `formError`, sandbox `validationError`). ~26 of ~35 phase-2 pages done
- [x] `MutationErrorSurface` phase 2D — finish core admin sweep (#1649, PR #1677) — 6 pages migrated: `/admin/compliance`, `/admin/prompts` (4 sites), `/admin/roles`, `/admin/semantic`, `/admin/semantic/improve`, `/admin/sessions`. Net +27/-33. Parent #1649 closed. Two carve-outs filed: `/admin/scim` row-pin (#1675 — needs `rowError: { error: FetchError }` retype), `/admin/billing` PlanShell combinedError (#1676 — blends structured + local-state errors, needs judgment call). Parent #1624 only blocked by those two carve-outs
- [x] Billing + Backup + Platform family → `@useatlas/schemas` (#1648 chunk 4, PR #1678) — 3 schemas / 10 shapes migrated. `@useatlas/types` extended with `BillingStatus` family + `OVERAGE_STATUSES` tuple. 8 enums tightened on the web side: `BACKUP_STATUSES`, `WORKSPACE_STATUSES`, `PLAN_TIERS` (×3 surfaces), `NOISY_NEIGHBOR_METRICS`, `ATLAS_ROLES`, `OVERAGE_STATUSES`. OpenAPI spec of `GET /api/v1/billing` expanded from `additionalProperties: {}` (undocumented) to fully-typed 3-level nested schema. 38 new tests (schemas package 75 → 113). Version-skew lesson recorded in architecture win #33: wire-only types belong in `@useatlas/schemas`, not `@useatlas/types` (scaffold smoke tests resolve from npm, not workspace). Follow-ups filed: `backups.status` DB CHECK constraint (#1679), `PLAN_MRR` stale `team`/`enterprise` keys — MRR stats return 0 (#1680)
- [x] Abuse cluster hardening — factory + helper + integration tests (#1644 + #1638 + #1639, PR #1681) — `createAbuseInstance(events)` exported as single public constructor for `AbuseInstance` (encodes startedAt / endedAt / peakLevel invariants + empty-sentinel shape in one place); `errorRatePct(errorCount, totalCount)` extracted as pure counter helper (zero-denom → 0, 1-decimal rounding); 6 integration tests for `getAbuseDetail` against real in-memory state (open instance + counters, missing workspace, reinstated, under-baseline `errorRatePct: null`, re-flagged preserves prior history, DB failure → empty events). 21 new tests total. Architecture win **#34** recorded. Follow-ups filed: `AbuseDetail` diagnostic channel for DB-load failure (#1682), `getAbuseEvents` JSON.parse poisoned-row catch radius (#1683), brand/discriminated-union for `AbuseInstance` invariants (#1684), `Percentage` vs `Ratio` branded numeric types (#1685)
- [x] `MutationErrorSurface` phase 2 carve-outs (#1675 + #1676, PR #1687) — `/admin/scim` row-pin reshaped from `{ message: string, id, kind }` to `{ error: FetchError, id, kind }` with `<MutationErrorSurface variant="inline" feature="SCIM" inlinePrefix="Revoke failed." />`; last-wins pin semantics preserved. `/admin/billing` PlanShell drops `combinedError` flattening — structured `<MutationErrorSurface>` wins precedence over local "200 but no URL" `<ErrorBanner>`. **Parent #1624 closed.** Filed #1686 for a flaky DuckDB CLI test (same class as #992)
- [x] Schemas phase-3 hardening — MRR stale keys bug + `backups.status` DB CHECK (#1679 + #1680, PR #1688) — **Production bug**: `PLAN_MRR` keyed on pre-migration-0020 `team` / `enterprise` so `GET /api/v1/platform/stats.mrr` silently returned `$0` for every paying workspace. Fix derives `PLAN_MRR` from `PLAN_TIERS` × `getPlanDefinition(tier).pricePerSeat` (pricing source of truth), typed `Record<PlanTier, number>` for compile-time enforcement; also fixed `changePlanRoute.description` stale copy. Migration `0032_backups_status_check.sql` adds idempotent `CHECK` constraint on `backups.status` (mirrors 0031 pattern: coerce drift rows to `failed` safe default + `DO $$ EXCEPTION` guard for re-runs). 8 TDD MRR tests. #1689 (unknown-tier log breadcrumb) closed completed in-PR
- [x] Abuse cluster hardening bundle — per-row JSON + diagnostic channel + brand + Percentage/Ratio (#1682 + #1683 + #1684 + #1685, PR #1690) — **#1683 bug**: `getAbuseEvents` per-row `JSON.parse(r.metadata)` catch narrows blast radius from "DB outage" to "one warn + empty metadata object" (follows `coerceAbuseEnums` pattern). **#1682 bug**: `AbuseDetail.eventsStatus: "ok" | "load_failed" | "db_unavailable"` diagnostic channel plumbed lib→route→UI; `detail-panel.tsx` destructive banner on non-ok ("Do not reinstate based on missing history"). **#1684 architecture**: phantom `unique symbol` brand makes `AbuseInstance` nominal — only `createAbuseInstance` + Zod parser can mint; `events: readonly AbuseEvent[]`; hand-rolled fixtures in `admin-abuse.test.ts` migrated to factory; `@ts-expect-error` regression guard. **#1685 architecture**: `Percentage` / `Ratio` branded types + `percentageToRatio` / `ratioToPercentage` converters in `@useatlas/types`; applied to `AbuseCounters.errorRatePct`, `AbuseThresholdConfig.errorRateThreshold`, SLA surfaces (`ee/src/sla/{metrics,alerting}.ts`, `admin/platform/sla/page.tsx`). Architecture wins **#35** (AbuseInstance brand) + **#36** (Percentage/Ratio) recorded. OpenAPI + MDX regenerated for the new `eventsStatus` field
- [x] Flaky DuckDB CLI test — one-off skip (#1686, PR #1691) — `bin/__tests__/duckdb-ingest.test.ts` wrapped with `describe.skip(...)` + issue cross-ref; same class as #992 heap corruption under the monorepo test runner, unblocks green CI while the root-cause investigation continues on the #992 thread
- [x] `resolveStatusClause` port helper — retires `buildUnionStatusClause` (#1531, PR #1694) — new pure `resolveStatusClause(table, mode, alias): string` in `packages/api/src/lib/content-mode/port.ts` (kept out of the registry to avoid the `InternalDB` ↔ content-mode cycle); `ContentModeRegistry.readFilter` delegates to it so Effect + non-Effect callers share one source of truth; `getPopularSuggestions` migrates to the new helper; `packages/api/src/lib/mode.ts` + its middleware re-export deleted (zero production callers); `mode-resolution.test.ts` migrated to exercise the port helper with added segment-key-vs-physical-name + exotic-refusal coverage. Closes phase 3 of #1515. Architecture win **#37** recorded
- [x] `/admin/actions` approval — pure-function tests + e2e deny spec (#1593, PR #1692) — extracts `summarizeBulkResult` helpers into `bulk-result.ts` and `PayloadView` into `payload-view.tsx` (page.tsx −71 lines; bulk-approve + bulk-deny now share one summary path so the index-based id-pairing lives in one place); 38 unit tests across 4 files pin the load-bearing `.toLowerCase()` (dev fixtures are all-lowercase so mixed-case regression was silent) with Zap reference-equality fallback, `PayloadView` branches (sql/sql_write alias, api_call method+url fallbacks, file_write path-only + non-string path, unknown-type JSON fallback, console.warn on malformed known-type payloads), and `DenyActionDialog` reason-clearing timing + Cmd/Ctrl+Enter gating + trim + onOpenChange-blocked-while-loading. New `@llm`-tagged `e2e/browser/actions-approval.spec.ts` mocks `/api/v1/actions*` (admin-sessions pattern) and asserts the deny request carries the operator's reason verbatim — the single assertion that would have caught the original hardcoded `"Denied by admin"` bug #1592 fixed
- [x] Regions family → `@useatlas/schemas` (#1648 chunk 5, PR #1693) — 4 entity + 3 composite response shapes migrated (`RegionPickerItem` / `RegionStatus` / `WorkspaceRegion` / `RegionMigration`, plus `RegionsResponse` / `AssignmentsResponse` / `MigrationStatusResponse`); every schema uses `satisfies z.ZodType<T>` against `@useatlas/types` interfaces (replaces 7 prior `as z.ZodType<T>` casts); `RegionMigration.status` tightened from hand-typed `z.enum([...])` to canonical `MIGRATION_STATUSES` tuple so status additions propagate automatically to both route OpenAPI and web parse. 17 new parse-boundary tests (schemas package 113 → 134); zero OpenAPI diff. Architecture win **#38** recorded. Follow-ups filed: #1695 (silent status coercion + unlogged migration-trigger failures), #1696 (`RegionMigration` discriminated union on terminal states), #1697 (shared `IsoTimestampSchema` + `OnboardingRegionSchema` dedup)
- [x] Bucket cleanup — residency hardening + schema dedup + warn-set reset (#1695 + #1697 + #1674, PR #1700) — **#1695 bug**: `admin-residency.ts` gets `narrowMigrationStatus(raw, ctx)` helper that emits `log.warn` on DB status drift instead of silently coercing to `"failed"` (applied to GET /migration status + POST /migrate/:id/retry); `scheduleMigrationExecution(id, requestId)` wraps the void-returning `triggerMigrationExecution` call in try/catch so a schedule-time throw surfaces in logs instead of returning 201 with no execution. **#1697 schemas**: new `packages/schemas/src/common.ts` exports `IsoTimestampSchema = z.string().datetime()` (first adopter is residency's `assignedAt` / `requestedAt` / `completedAt`; remaining families migrate as they're touched); `onboarding.ts` drops local `OnboardingRegionSchema` in favor of `RegionPickerItemSchema` from `@useatlas/schemas`. **#1674 test hygiene**: `_resetWarnSets()` exported from `organizations/statuses.ts` + `organizations/roles.ts` and wired to `beforeEach` in both test files so future tests that re-use an unknown value can't silently get zero warns; `users/roles.ts` skipped since it uses fail-closed rank comparison (no warn set)
- [x] `@useatlas/types` 0.0.12 publish sequence (#1698, PRs #1699 + #1701) — **PR A (#1699)**: bumped `packages/types/package.json` `0.0.11 → 0.0.12` + lockfile; consumer refs held at `^0.0.11` so scaffolds kept passing against the old published version. Tagged `types-v0.0.12` → publish workflow landed `0.0.12` on npm at 16:01 UTC with `Percentage` / `Ratio` / `asRatio` / `percentageToRatio` / `ratioToPercentage` exports (introduced by PR #1690 but missing on the published `0.0.11`), plus the previously-unpublished `starter-prompt` and `integrations` modules. **PR B (#1701)**: bumped `@useatlas/types` refs to `^0.0.12` in `packages/sdk`, `packages/react`, `create-atlas/templates/docker`, `create-atlas/templates/nextjs-standalone`. Deploy Validation was red on main for ~14 hours (since PR #1690) with `The export asRatio was not found` in scaffold smoke tests — both workflows back to green after PR B merged. OpenAPI spec regenerated to absorb the `OnboardingRegion` → `RegionPickerItem` rename from PR #1700 that the admin-bypass merge had skipped
- [x] `@useatlas/schemas` phase 5 — final mega-migration (closes #1648, PR #1702) — 4 new modules (`sla.ts` / `analytics.ts` / `connection.ts` / `admin-config.ts`) cover every remaining wire shape: SLA family (5 schemas with `SLA_ALERT_TYPES` / `SLA_ALERT_STATUSES` enum tightening), audit analytics + token usage + UsageSummary (14 shapes, web-only reads with local interfaces + `satisfies` structural guards), ConnectionInfo + ConnectionHealth (status → `CONNECTION_STATUSES`, health.status → inline `healthy/degraded/unhealthy` enum pending `HEALTH_STATUSES` tuple in #1703), WorkspaceBranding + WorkspaceModelConfig (provider → `MODEL_CONFIG_PROVIDERS` tuple — already existed in `@useatlas/types`) + PIIColumnClassification (category/confidence/maskingStrategy → `PII_CATEGORIES` / `PII_CONFIDENCE_LEVELS` / `MASKING_STRATEGIES`) + SemanticDiffResponse. Timestamp fields across all new modules route through `IsoTimestampSchema` (second adopter of #1697). 5 routes migrated (`platform-sla.ts`, `admin-branding.ts`, `admin-model-config.ts`, `admin-compliance.ts`, plus onboarding from PR #1700). `admin-schemas.ts` 542 → 241 lines. 60 new tests (schemas package 134 → 194). Follow-up #1703 reopened narrower: `HEALTH_STATUSES` tuple still pending a future types publish cycle
- [x] `@useatlas/types` 0.0.13 publish sequence (closes #1543, #1703, PRs #1704 + #1709) — **PR A (#1704)**: additive-only bump. New `packages/types/src/email-provider.ts` exports `EMAIL_PROVIDERS` + `EmailProvider`; `packages/types/src/connection.ts` adds `HEALTH_STATUSES` tuple alongside the existing `HealthStatus` union; `packages/types/src/domain.ts` also extended. Bumped version 0.0.12 → 0.0.13, consumer refs held at `^0.0.12`. Tagged `types-v0.0.13` → publish workflow landed on npm. **PR B (#1709)**: consumer-ref bumps + call-site migrations. `packages/api/src/lib/integrations/types.ts` replaces the inline `EMAIL_PROVIDERS` tuple with a re-export from `@useatlas/types/email-provider` (13 downstream importers unaffected). `packages/schemas/src/connection.ts` swaps the inline `z.enum(["healthy","degraded","unhealthy"])` for `z.enum(HEALTH_STATUSES)`. Deploy Validation stayed green throughout
- [x] `/admin/cache` polish — bucket 4 of #1588 (PR #1705) — a11y + responsive pass on the cache stats + controls page. Remaining buckets in #1588 are 3 (specialized, demand-driven) and 5 (platform subtree, deferred). Follow-up #1708 filed for e2e browser test coverage
- [x] CustomDomain 3-way verification invariant at wire layer (closes #1661, PR #1706) — `CustomDomainSchema` now uses Zod `.refine()` to enforce `domainVerified === true ↔ domainVerifiedAt !== null ↔ domainVerificationStatus === "verified"` at parse time, plus `status === "verified"` → `verifiedAt !== null` coupling; adds `domain: z.string().min(1)` to catch empty-string drift. Audit surfaced #1707 bug (Drizzle schema missing DNS TXT verification columns written by EE code)
- [x] `custom_domains` DNS verification schema drift + admin-cache e2e (closes #1707, #1708; PR #1711) — **#1707**: `schema.ts` adds `verification_token` / `domain_verified` / `domain_verified_at` / `domain_verification_status` columns + `chk_custom_domain_verification_status` check constraint. New migration `0033_custom_domains_dns_verification.sql` mirrors 0022's pattern with idempotent `IF NOT EXISTS` guards and grandfathering (`UPDATE ... WHERE status = 'verified'`). **#1708**: new `e2e/browser/admin-cache.spec.ts` covers 3 cases (golden path / disabled cache / flush failure) mirroring the `admin-sessions.spec.ts` route-mock pattern. Closes #1643 (architectural decision: keep `z.string()` resilience for plugin/BYOT/Stripe fields, tighten only server-owned enums with a tuple in `@useatlas/types`) and #1588 (admin console tracker — Buckets 1+2+4 complete 12/12, Buckets 3 specialized + 5 platform explicitly deferred)
- [x] `@useatlas/types` 0.0.14 discriminated-union cluster (closes #1542, #1591, #1660, #1696, PRs #1710 + #1712) — 4 breaking shape changes bundled into one publish cycle. **PR A (#1710, +199/-47)**: type shapes only. `types/src/action.ts` renames `ActionDisplayStatus.pending_approval` → `pending` (unifies with server-side `ActionStatus`, `_AssertStatusAlignment` flipped to assert equality). `types/src/approval.ts` — `ApprovalRule` becomes discriminated union on `ruleType` (`cost` → `threshold: number; pattern: ""`; `table`/`column` → `pattern: string; threshold: null`); `ApprovalRequest` becomes discriminated on `status` (`pending` → reviewer fields null; `approved`/`denied` → reviewer fields non-null; `expired` → reviewer null). `types/src/residency.ts` — `RegionMigration` discriminated on `status` with terminal-state invariants (pending/in_progress → completedAt/errorMessage null; completed → completedAt non-null, errorMessage null; failed → both non-null; cancelled → completedAt non-null, errorMessage null). `types/src/email-provider.ts` — `ProviderConfig` becomes tagged union keyed on `provider` (smtp/sendgrid/postmark/ses/resend). Bumped 0.0.13 → 0.0.14. **PR B (#1712, +4391/-1354)**: consumer-ref bumps (`^0.0.13 → ^0.0.14` in sdk/react/templates) + all 4 subsystem call-site migrations. `packages/schemas/src/approval.ts` + `residency.ts` switch to `z.discriminatedUnion`. Route handlers narrow via `switch (status)` / `switch (ruleType)`. `admin/actions/page.tsx` drops `mapStatus`; `STATUS_CONFIG` key renamed (label unchanged). `lib/email/store.ts` `parseInstallationRow` injects `provider` tag at read time; `delivery.ts` drops `Record<string, unknown>` fallback; `admin-email-provider.ts` `describeOverride` drops 5 `as` casts. OpenAPI regenerated. Deploy Validation stayed green through both merges
- [x] Type-design hardening for `<MutationErrorSurface>` — branded `FeatureName` + empty-message invariant (closes #1652, PR TBD) — Final 1.2.2 item. **Part 1**: new `packages/web/src/ui/components/admin/feature-registry.ts` exports a `readonly`-literal tuple of 49 canonical admin feature names + `type FeatureName = (typeof FEATURE_NAMES)[number]`. `<MutationErrorSurface>`, `<EnterpriseUpsell>`, `<FeatureGate>`, `<AdminContentWrapper>`, and `<ReasonDialog>` all swap `feature: string` → `feature: FeatureName`; typos now compile-error instead of rendering "sso requires an enterprise plan". Consolidated three naming duplicates ("User Management" → "Users", "Organization Management" → "Organizations", "Custom Domain" → "Custom Domains"). **Part 2**: `buildFetchError(input)` helper added to `packages/web/src/ui/lib/fetch-error.ts` — refuses empty / whitespace-only messages (dev throws, prod substitutes `Request failed (${status})` + `console.warn`). Both system boundaries (`extractFetchError` HTTP-status fallback + `useAdminFetch` network catch) route through the helper; `useAdminMutation` adopts it too. **Tests**: new `feature-registry.test.ts` (5 cases — tuple shape, no duplicates, non-empty trimmed, `"SSO"` casing guard) + `buildFetchError` block in `fetch-error.test.ts` (10 cases — trim, field omission, dev throw on empty/undefined/whitespace, prod substitute preservation). All 84 web-package tests pass, full-repo test suite green. Architecture win **#43** recorded. **Milestone 1.2.2 complete — closed on merge.**

---

## 1.2.3 — Security Sweep (closed)

Full security audit with in-milestone remediation. Audit-and-fix shape: P0/P1/P2 findings fixed in-milestone, P3s punted to a cleanup tail. Findings captured in `.claude/research/security-audit-1-2-3.md`. Tracking issue #1718.

- [x] Phase 1 — Audit Better Auth config + middleware coverage (#1720, PR #1734). All P0/P1/P2 findings fixed: F-01 → PR #1738 (+ #1742 dashboards twin #1736, + #1749 DB invariant #1737); F-02 → PR #1735; F-03 → PR #1744; F-04 → PR #1748; F-05 bundled into F-06; F-06 → PR #1739; F-07 → PR #1747. Follow-ups: share-token redaction (#1743 → PR #1771); Better Auth rate-limit integration test (#1741 → PR #1793); incidental P3 #1792 — `image: null` asymmetry — shipped PR #1838.
- [x] Phase 2 — Audit org-scoping on every route + ContentMode consumers (#1721, PR #1757, F-08..F-16). All P0/P1/P2 fixed: F-08 → PR #1762; F-09 → PR #1763; F-10 → PR #1758; F-11/F-12 → PR #1769; F-13/F-14 → PR #1770. F-15 + F-16 in P3 tail. Infra: PR #1759/#1760 (lockfile drift), PR #1764 (`@useatlas/types` 0.0.15 + scaffold publish-race fix).
- [x] Phase 3 — Audit SQL validation edges + fuzz the 4-layer validator (#1722, PR #1775, F-17..F-21). All P1/P2 fixes shipped in PR #1776: F-17 `unwrapMysqlExecutableComments()` (Option A, 8 regression pins); F-18 AST guard rejects `stmt.into?.type === "into"` when `keyword !== "var"`; F-19 `INTO OUTFILE/DUMPFILE` blocked. F-20 + F-21 in P3 tail. Regression pins F-17.a–F-17.h, F-18, F-19 kept in fuzz suite.
- [x] Phase 4 — Audit audit-log coverage on write routes (#1723, PR #1794). 201 write routes / 52 files enumerated; 15 findings (F-22..F-36) covering plugin install/uninstall, SCIM, IP allowlist, EE custom-role CRUD, audit retention, EE purge scheduler, session revocation, partially-audited admin subrouters, BYOT credential management, admin-orgs drift, workspace enterprise config, abuse reinstate split trail, wizard onboarding, content-governance trio, retention policy gap. **All 15/15 shipped:** F-22 → PR #1802; F-23 → #1796; F-24 → #1797; F-25 → #1800; F-26 → #1799; F-27 → #1807; F-28 → #1801; F-30 → #1805; F-31 → #1804; F-32 → #1806; F-33 → #1808; F-35 → #1809; F-29 + F-34 batched (#1784 + #1789); F-36 Phase 1 → #1821, Phase 2 admin UI → #1839; F-29 residuals (#1828) bundled with F-46. Shared `packages/api/src/lib/audit/error-scrub.ts` landed with F-28.
- [x] Phase 5 — Audit secret/error surfaces + plugin credential storage (#1724). 6 P1/P2 issues (F-41–F-44, F-46, F-47 — F-45 duplicate-helper consolidation folded into F-44). **No P0.** **F-43 → PR #1830** (marketplace `GET /available` masks secret fields). **F-44 + F-45 → PR #1831** (pino `serializers.err` + `formatters.log` scrubs DSN userinfo). **F-41 → PR #1833** (10-store dual-write at-rest encryption; migration `0036`). **F-42 → PR #1834** (selective-field encryption inside JSONB; migration `0037`). **F-46 (#1819)** bundled with F-29 residuals. **F-47 → PR #1837** (`ATLAS_ENCRYPTION_KEYS` versioned keyset; runbook at `platform-ops/encryption-key-rotation.mdx`). **F-41 + F-42 soak cleanup → PR #N (closes #1832, #1835)** — destructive migration `0040_drop_integration_plaintext.sql` drops plaintext columns from all 10 integration tables, tightens `_encrypted` siblings to NOT NULL where applicable, deletes back-compat helpers (`pickDecryptedSecret`, `pickEncryptedConfig`) + the integration-credentials backfill + tests. New `INTEGRATION_TABLES` catalog at `packages/api/src/lib/db/integration-tables.ts` shared by rotation + audit. Read-only `packages/api/scripts/audit-plugin-config-residue.ts` exits `2` with row IDs (no values) on residue. New `ATLAS_STRICT_PLUGIN_SECRETS=true` env var rejects writes under corrupt schema or per-key secret/passthrough drift (default off, SaaS regions opt in). Pre-flight runbook at `platform-ops/plugin-config-residue-audit.mdx`.
- [x] Phase 6 — Audit rate limiting, timeouts, pool caps, DoS surfaces (#1725, PR #1855). 0 P0 / 1 P1 / 4 P2 / 4 P3-noted / 11 verified-clean; remediation queue #1844–#1848. ID range starts at F-73 to dodge Phase 7's parallel claim. Remediation: F-75/F-76 → PR #1856; F-73/F-74/F-77 → PR #1861.
- [x] Phase 7 — Audit EE governance bypasses — SSO / SCIM / IP / approval (#1726, PR #1854). 0 P0 / 2 P1 / 3 P2 / 3 P3-noted; remediation queue #1849–#1853. F-54/F-55 → PR #1860. Remaining (F-53 custom-role permission enforcement multi-PR cluster, F-56 SSO `simple-key`/`byot` gating, F-57 SCIM provenance check, plus #1858 MCP actor binding) deferred to **1.2.4 — Security Cleanup Tail**.

---

## 1.3.0 — End-User UI Design Pass — CLOSED

Closed 2026-05-02. Tracking issue #1719, milestone #38 (1 + 28 issues). Revamped end-user facing surfaces using the treatment pattern from the 1.2.1/1.2.2 admin revamp (critique → distill → colorize → polish). No features, no backend — pure UI/UX. 13 page sub-issues #1864–#1876 + the post-bucket public-page audit + one structural refactor (#1888).

- [x] Bucket 1 — Chat (`/`, #1864) — message density, starter-prompt grid, tool calls, result cards, conversation sidebar (PR #1885)
- [x] Bucket 2 — Notebook (`/notebook`, #1865) — cell UX, fork-gutter verification, markdown cells, empty state — SQL-failure dedup wired in via existing `computeSqlFailureDedup`, cell head simplified, "What if?" promoted out of toolbar, mobile cell-toolbar collapsed to kebab
- [x] Bucket 3 — Dashboards
  - [x] 3b detail (`/dashboards/[id]`, #1867, PR #1889 + #1893) — freeform RGL tile grid + critique pass: chart-on-mount fix, mobile single-column read-only fallback, edit-mode dot tint + Esc banner, opaque fullscreen, tile-head a11y. Adjacent: #1891 / #1892
  - [x] 3a list (`/dashboards`, #1866 → superseded by #1895, PR #1896) — **completed by deletion**. `/dashboards` server-side redirects to the most-recently-updated dashboard; switcher dropdown + View All modal replace the standalone list. Pre-fetched after-delete redirect, multi-agent review fixes inline.
- [x] Bucket 4 — Public views — shared chat (#1868, PR #1902 + a11y #1903), embed (#1869, PR #1906), shared dashboard (#1870, PR #1904), report (#1871, PR #1905)
- [x] Bucket 5 — Onboarding — login (#1872, PR #1941), signup (#1873, PR #1943), create-org (#1874, PR #1948), wizard (#1875, PR #1949). Wizard pass extracted shared `<OnboardingShell>` + `<StepTrack>` to `@/ui/components/onboarding/`; signup migrated to thin-wrap them.
- [x] Bucket 6 — Demo (`/demo`, #1876, PR #1942) — two-column hero with dataset preview + curated cybersecurity starter prompts; bonus widget P0 fix so `propApiKey` bypasses `ManagedAuthCard` in managed-auth mode. Follow-up #1944 (PR #1947) wired demo bearer through `/api/v1/starter-prompts` so /demo flows through the adaptive resolver instead of the hard-coded teaser list.
- [x] Bucket 7 — Landing page (`/`, #1907, PR #1908) — Schema Map direction
- [x] Bucket 8 — apps/www legal + marketing — #1910 pricing (PR #1917), #1911 sla (PR #1918), #1912 terms (PR #1919), #1913 privacy (PR #1920), #1915 dpa + `LegalSection` extraction (PR #1921)
- [x] Post-Bucket 8 — public-page audit (PR #1933) — caught license/region/retention/MFA/cert drift; follow-ups: #1925 TOTP MFA (PR #1939), #1927 365-day audit retention default (PR #1937), #1929 pricing wording (PR #1934), #1930 status URL regression (PR #1935). Parked: #1922 (pre-signed DPA PDF), #1923 (security@ PGP key), #1924 (sub-processor change feed), #1928 (SOC 2 / ISO / pen test program), #1936 (OpenStatus Starter upgrade)
- [x] Refactor — `<AssistantTurn>` primitive extracted (#1888, PR #1952) — gutter rail consolidated across chat (`page.tsx`) + notebook (`notebook-cell-output.tsx`) at canonical `border-primary/40`; chat surface picked up the `/30` → `/40` opacity bump. Component takes `React.ComponentProps<"div">` so chat can keep `role="article"` + `aria-label` on the same DOM node. Architecture win **#44** recorded.

---
