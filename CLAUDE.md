# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Core Rules Checklist

**ALWAYS follow these rules when writing code:**

### Security (SQL)
- [ ] **SELECT only** — SQL validation blocks all DML/DDL. Never allow INSERT, UPDATE, DELETE, DROP, TRUNCATE, ALTER, etc.
- [ ] **Single statement** — No `;` chaining. One query per execution
- [ ] **AST validation** — All SQL parsed via `node-sql-parser` (PostgreSQL or MySQL mode, auto-detected). Regex guard is a first pass, not the only check. If the AST parser cannot parse a query, it is **rejected** (never silently skipped)
- [ ] **Table whitelist** — Only tables defined in `semantic/entities/*.yml` or `semantic/{source}/entities/*.yml` are queryable. `packages/api/src/lib/semantic.ts` builds the allowed set. Schema-qualified queries (e.g. `schema.table`) require the qualified name in the whitelist; unqualified names cannot bypass schema restrictions
- [ ] **Auto LIMIT** — Every query gets a LIMIT appended. Default 1000, configurable via `ATLAS_ROW_LIMIT`
- [ ] **Statement timeout** — PostgreSQL and MySQL queries get a session-level timeout. Default 30s, configurable via `ATLAS_QUERY_TIMEOUT`

### Security (General)
- [ ] **Path traversal protection** — Each explore backend enforces read-only access scoped to the `semantic/` directory (nsjail: bind-mount, sidecar: container filesystem, just-bash: OverlayFs, Vercel: VM filesystem)
- [ ] **No secrets in responses** — Never expose connection strings, API keys, or stack traces to the user or agent
- [ ] **Readonly DB connections** — PostgreSQL uses read-only queries enforced by validation; MySQL uses a read-only session variable; ClickHouse uses `readonly: 1` per-query setting
- [ ] **Explore tool isolation** — Five-tier priority: Vercel sandbox (Firecracker VM) > nsjail explicit (`ATLAS_SANDBOX=nsjail`, hard-fail) > sidecar (`ATLAS_SANDBOX_URL`, HTTP-isolated container) > nsjail auto-detect (binary on PATH) > just-bash (dev fallback). When `ATLAS_SANDBOX_URL` is set, sidecar is the intended backend — nsjail auto-detection is skipped entirely (no noisy namespace warnings on Railway). nsjail runs with no network, read-only `semantic/` mount, no host secrets, as nobody:65534

### Code Style
- [ ] **bun only** — Package manager and runtime. Never npm, yarn, or node
- [ ] **TypeScript strict mode** — Monorepo path aliases: `@atlas/api/*` for cross-package imports, `@/*` → `./src/*` within web package only
- [ ] **Tailwind CSS 4** — Via `@tailwindcss/postcss`, not v3
- [ ] **shadcn/ui v2** — Component library for `@atlas/web`. New-york style, neutral base, Lucide icons. **Always use shadcn/ui primitives** for UI elements (buttons, toggles, cards, dialogs, etc.) — never hand-roll equivalent components. If a needed primitive isn't installed yet, add it: `npx shadcn@latest add <component>` from `packages/web/`. Config at `packages/web/components.json`. Uses `cn()` from `@/lib/utils` for class merging
- [ ] **Server external packages** — `pg`, `mysql2`, `@clickhouse/client`, `@duckdb/node-api`, `snowflake-sdk`, `jsforce`, `just-bash`, `pino`, and `pino-pretty` must stay in `serverExternalPackages` in the `create-atlas` template — they use native bindings or worker threads incompatible with Next.js bundling
- [ ] **Frontend is a pure HTTP client** — `@atlas/web` does NOT depend on `@atlas/api` — the frontend talks to the API over HTTP (same-origin rewrite or cross-origin fetch). Shared types are duplicated in `packages/web/src/ui/lib/types.ts`. The `nextjs-standalone` example embeds `@atlas/api` server-side via a Next.js catch-all route; the React client still communicates over HTTP
- [ ] **nuqs for URL state** — Use [nuqs](https://nuqs.47ng.com/) for any state that belongs in the URL (pagination, filters, selected items, view modes). Define parsers in a `search-params.ts` file next to the page, use `useQueryStates` in client components. Transient UI state (loading, open dropdowns, form drafts) stays as `useState`. `NuqsAdapter` is in the root layout
- [ ] **React Compiler handles memoization** — Do not add `useMemo`, `useCallback`, or `React.memo` for performance. The React Compiler (enabled in `next.config.ts`) auto-memoizes. Only use `useMemo` when a stable reference is required for correctness (e.g. TanStack Table controlled state). Only use `React.memo` with a custom comparator when skipping renders based on semantic equality (e.g. completed tool parts)
- [ ] **No async waterfalls** — Use `Promise.all([a(), b()])` for independent awaits, not sequential `await a(); await b();`. Start promises early, await late
- [ ] **Immutable array operations** — Use `toSorted()`, `toReversed()`, `toSpliced()` instead of `.sort()`, `.reverse()`, `.splice()` in React components to avoid mutating state
- [ ] **Dynamic imports for heavy components** — Use `next/dynamic` for Monaco, Recharts, syntax highlighters, and other large client-only libraries
- [ ] **Flat ESLint config** — `eslint.config.mjs`, not `.eslintrc`

### Testing
- [ ] **`bun run test`, never `bun test`** — Bun's `mock.module()` is process-global and irreversible. Running `bun test` executes all files in one process, causing mock contamination across files (177 false failures). The project uses an isolated test runner (`packages/api/scripts/test-isolated.ts`) that spawns each file in its own subprocess. Always use `bun run test` (which invokes the isolated runner) or `bun test <single-file>` for one file. Never run `bun test` against a directory
- [ ] **Mock all exports** — When using `mock.module()`, mock every named export the real module provides. Partial mocks cause `SyntaxError: Export named 'X' not found` in other test files if they happen to share a process

### Agent Tools
- [ ] **Tools return structured data** — `executeSQL` returns `{ columns, rows }`
- [ ] **Explore is read-only** — Only `ls`, `cat`, `grep`, `find` on the `semantic/` directory. No writes, no shell escapes
- [ ] **Agent max 25 steps** — `stopWhen: stepCountIs(25)` in `streamText`. Don't increase without good reason
- [ ] **Semantic layer drives the agent** — The agent must read entity YAMLs before writing SQL. This is the intended workflow

### Semantic Layer
- [ ] **YAML format** — Entity files define columns, types, sample values, joins, virtual dimensions, measures, and query patterns
- [ ] **Metrics are authoritative** — SQL in `metrics/*.yml` must be used exactly as written by the agent
- [ ] **Glossary terms** — Terms marked `ambiguous` in `glossary.yml` should trigger clarifying questions

---

## Project Overview

**Atlas** — Deploy-anywhere text-to-SQL data analyst agent. Users ask natural language questions, the agent explores a semantic layer (YAML files on disk), writes validated SQL, and returns interpreted results.

> Based on [vercel-labs/oss-data-analyst](https://github.com/vercel-labs/oss-data-analyst). Supports self-hosted (Docker/Railway with nsjail isolation) and Vercel-native deployment (via `@vercel/sandbox`).

> Hono + Next.js + TypeScript + Vercel AI SDK + bun

### Versioning & release strategy

This repo (`AtlasDevHQ/atlas`) is the **development monorepo** — internal milestones (v0.1–v1.0) track architectural progress, not public releases. The milestone labels in ROADMAP.md and GitHub Issues reflect internal maturity:

- **v0.1–v0.9** — Shipped. Foundation through action framework.
- **v1.0** — Current. Plugin SDK: get all interfaces, reference implementations, CLI tooling, and docs into a stable state.

When the internal architecture is solid (post-v1.0), Atlas will be published as a **beta release (`0.0.1`)** on a new public repo. The public semver starts fresh — internal v1.0 ≠ public v1.0. Internal milestones are about getting the code right; public versions are about API stability for users.

**Don't confuse internal milestones with public version numbers.** When writing docs, changelogs, or user-facing copy, use the public version scheme (TBD), not the internal milestone labels.

## Commands

```bash
# Dev
bun install              # Install dependencies
bun run dev              # Start Hono API (:3001) + Next.js (:3000)
bun run dev:api          # Standalone Hono API on :3001
bun run dev:web          # Standalone Next.js on :3000
bun run dev:www          # Landing page on :3002
bun run build            # Production build (Next.js)
bun run start            # Start production (both API + web via scripts/start.sh)

# Quality
bun run lint             # ESLint (flat config)
bun run type             # TypeScript type-check (tsgo --noEmit)
bun run test             # Run tests (isolated per-file — ALWAYS use this, never bare `bun test`)

# Dependencies
bun run deps:lint        # Check cross-workspace version consistency (syncpack)
bun run deps:fix         # Auto-fix version drift across workspaces
bun run deps:update      # Update all deps + sync versions

# Database
bun run db:up            # Start local Postgres (Docker, auto-seeds demo data)
bun run db:down          # Stop local Postgres
bun run db:reset         # Nuke volume + restart (fresh seed)

# Semantic layer
bun run atlas -- init              # Profile DB tables & views, auto-generate semantic layer (TTY: interactive picker)
bun run atlas -- init --enrich     # Profile + LLM enrichment (needs API key)
bun run atlas -- init --no-enrich  # Explicitly skip LLM enrichment
bun run atlas -- init --tables t1,t2  # Only profile specific tables/views (skips interactive picker)
bun run atlas -- init --schema sales  # Profile a non-public PostgreSQL schema
bun run atlas -- init --demo          # Load simple demo dataset (3 tables), then profile
bun run atlas -- init --demo cybersec # Load cybersec demo (62 tables, ~500K rows), then profile
bun run atlas -- diff                 # Compare DB schema against semantic layer (exit 1 if drift)
bun run atlas -- diff --tables t1,t2  # Diff only specific tables
bun run atlas -- diff --schema sales  # Diff a non-public PostgreSQL schema
bun run atlas -- mcp                  # Start MCP server (stdio transport for Claude Desktop, Cursor, etc.)

# Query (headless)
bun run atlas -- query "question"          # Table output (default)
bun run atlas -- query "question" --json   # JSON output
bun run atlas -- query "question" --csv    # CSV output (pipe-friendly)
bun run atlas -- query "question" --quiet  # Data only, no narrative

# MCP server (standalone)
bun run mcp                           # Start MCP server on stdio (same as atlas -- mcp)
bun run dev:mcp                       # Start MCP server with hot reload
```

**Quick start:** `bun install` → `bun run db:up` → `cp .env.example .env` (set your LLM provider key) → `bun run atlas -- init` → `bun run dev`. The `.env` comes pre-configured with Docker Postgres URLs and managed auth. On first boot a dev admin account is seeded: **admin@atlas.dev / atlas-dev**.

| Script | URL |
|--------|-----|
| `bun run dev` | http://localhost:3000 (web) + http://localhost:3001 (API) |
| `bun run dev:web` | http://localhost:3000 |
| `bun run dev:api` | http://localhost:3001 |
| `bun run dev:www` | http://localhost:3002 |

**New project:** `bun create atlas-agent my-app` — interactive scaffolding with template selection, DB config, provider setup, and optional semantic layer generation.

**Production:** Deploy using `examples/docker/` (self-hosted with optional nsjail) or `examples/nextjs-standalone/` (full-stack Vercel). Set `ATLAS_DATASOURCE_URL` to a PostgreSQL or MySQL connection string. Set `DATABASE_URL` for Atlas internals (auth, audit).

## Architecture

### Monorepo Structure (bun workspaces)

```
atlas/
├── packages/
│   ├── api/                     # @atlas/api — Hono API server + all backend logic + shared types
│   │   ├── package.json         # exports: ./app, ./lib/*, ./lib/auth/*, ./lib/db/*, ./lib/tools/*
│   │   ├── bunfig.toml          # test preload
│   │   └── src/
│   │       ├── api/             # Hono routes (chat, health, auth, query, conversations, slack)
│   │       │   ├── index.ts     # Hono app — mounts routes, CORS middleware
│   │       │   ├── server.ts    # Standalone Bun server entry point
│   │       │   └── routes/
│   │       ├── lib/             # All backend logic + shared types
│   │       │   ├── agent.ts     # Agent loop (streamText, stopWhen, prepareStep)
│   │       │   ├── providers.ts # LLM provider factory
│   │       │   ├── semantic.ts  # Reads entity YAMLs → builds table whitelist
│   │       │   ├── startup.ts   # Environment validation
│   │       │   ├── auth/        # Auth middleware, detect, simple-key, managed, byot, audit
│   │       │   │   └── types.ts # AuthMode, AtlasUser, AuthResult, createAtlasUser
│   │       │   ├── db/          # connection.ts, internal.ts
│   │       │   ├── errors.ts    # ChatErrorCode, ChatErrorInfo, parseChatError
│   │       │   ├── action-types.ts      # ActionApprovalMode, ActionStatus, AtlasAction, isAction
│   │       │   ├── conversation-types.ts # MessageRole, Surface, Conversation, Message
│   │       │   ├── sidecar-types.ts     # SidecarExecRequest, SidecarExecResponse
│   │       │   ├── slack/       # api.ts, verify.ts, format.ts, store.ts, threads.ts
│   │       │   ├── tools/       # explore.ts, explore-nsjail.ts, sql.ts, registry.ts
│   │       │   ├── agent-query.ts  # Shared agent execution for JSON + Slack
│   │       │   └── conversations.ts # Conversation + message persistence (CRUD)
│   │       └── test-setup.ts
│   │
│   ├── web/                     # @atlas/web — Next.js frontend + chat UI components
│   │   ├── package.json         # exports: ./ui/context, ./ui/components/atlas-chat
│   │   ├── next.config.ts       # Turbopack, API rewrites
│   │   ├── postcss.config.mjs
│   │   └── src/
│   │       ├── app/             # Next.js app router
│   │       │   └── page.tsx     # Wraps <AtlasChat /> in <AtlasUIProvider>
│   │       ├── ui/              # Chat UI components (absorbed from former @atlas/ui)
│   │       │   ├── context.tsx  # AtlasUIProvider (apiUrl, isCrossOrigin, authClient)
│   │       │   ├── hooks/       # use-dark-mode.ts, use-conversations.ts
│   │       │   ├── components/
│   │       │   │   ├── atlas-chat.tsx      # Top-level composite: useChat + auth + sidebar + messages
│   │       │   │   ├── chat/              # 13 chat components (error-banner, markdown, tool-part, etc.)
│   │       │   │   ├── chart/             # chart-detection.ts, result-chart.tsx
│   │       │   │   ├── actions/           # Action approval card, status badge
│   │       │   │   └── conversations/     # Sidebar, list, item, delete-confirmation
│   │       │   └── lib/         # helpers.ts, types.ts
│   │       ├── lib/auth/client.ts  # Better Auth React client (frontend-only)
│   │       └── instrumentation.ts  # OpenTelemetry setup
│   │
│   ├── cli/                     # @atlas/cli — atlas CLI (profiler, schema diff, enrichment)
│   │   ├── package.json
│   │   ├── bin/                 # atlas.ts, enrich.ts
│   │   └── data/                # demo.sql, cybersec.sql
│   │
│   ├── mcp/                     # @atlas/mcp — MCP server (Model Context Protocol)
│   │   ├── package.json
│   │   ├── bin/serve.ts         # Stdio entry point for Claude Desktop, Cursor, etc.
│   │   └── src/
│   │       ├── server.ts        # createAtlasMcpServer() factory
│   │       ├── tools.ts         # Bridge: AI SDK tools → MCP tools
│   │       └── resources.ts     # Semantic layer as MCP resources
│   │
│   ├── sandbox-sidecar/         # @atlas/sandbox-sidecar — Isolated explore sidecar (Railway)
│   │   ├── package.json
│   │   ├── Dockerfile           # Minimal: bun + bash/coreutils + semantic/ files
│   │   └── src/server.ts        # Bun.serve: POST /exec, GET /health
│   │
│   ├── sdk/                     # @useatlas/sdk — TypeScript SDK for the Atlas API
│   │   ├── package.json         # exports: ., ./client
│   │   └── src/
│   │       ├── index.ts         # Public API re-exports
│   │       └── client.ts        # createAtlasClient(), AtlasError, query/chat/conversations
│   │
│   └── plugin-sdk/              # @useatlas/plugin-sdk — Type definitions & helpers for authoring Atlas plugins
│       ├── package.json         # exports: ., ./types, ./helpers
│       └── src/
│           ├── index.ts         # Public API re-exports
│           ├── types.ts         # Plugin interfaces (datasource, context, interaction, action)
│           └── helpers.ts       # definePlugin() factory + type guards
│
├── apps/
│   ├── www/                     # @atlas/www — Static landing page (useatlas.dev)
│   │   ├── serve.ts             # Bun static file server (production runtime)
│   │   ├── railway.json         # Railway NIXPACKS deploy config
│   │   └── src/app/             # Next.js static export (output: "export")
│   └── docs/                    # @atlas/docs — Documentation site (Fumadocs, docs.useatlas.dev)
│       ├── source.config.ts     # Fumadocs source config with Orama search
│       └── src/app/             # MDX pages, OG images, layout
│
├── examples/
│   ├── docker/                  # Self-hosted Docker deploy + optional nsjail
│   │   ├── Dockerfile           # Multi-stage: build API + nsjail
│   │   ├── docker-compose.yml   # Dev: Postgres + API
│   │   ├── railway.json         # Railway deploy config
│   │   └── scripts/start.sh     # Single-process: Hono API
│   └── nextjs-standalone/       # Pure Next.js + embedded Hono API (Vercel)
│       ├── vercel.json          # Vercel framework + build config
│       └── src/app/api/         # Catch-all route → @atlas/api (Hono)
│
├── deploy/                      # Production deploy configs (Railway: api, web, www, docs, sidecar)
├── docs/                        # Guides (docs/guides/) and design ADRs (docs/design/)
├── e2e/                         # End-to-end test suite
├── plugins/                     # Atlas plugins directory
├── semantic/                    # Semantic layer (YAML on disk, shared across packages)
│   ├── catalog.yml
│   ├── glossary.yml
│   ├── entities/*.yml
│   └── metrics/*.yml
├── scripts/                     # db-up.sh, start.sh
├── create-atlas/                # Scaffolding CLI (bun create atlas-agent)
├── create-atlas-plugin/         # Plugin scaffolding CLI (bun create @useatlas/plugin)
├── package.json                 # Root workspace config
├── tsconfig.json                # Base config, extended by packages
└── docker-compose.yml           # Local dev Postgres + sandbox sidecar (bun run db:up)
```

**Import conventions:**
- `@atlas/api` package uses its own name for all imports: `@atlas/api/lib/agent` (via package.json exports). Shared types live here: `@atlas/api/lib/auth/types`, `@atlas/api/lib/errors`, `@atlas/api/lib/action-types`, `@atlas/api/lib/conversation-types`, `@atlas/api/lib/sidecar-types`
- `@atlas/web` uses tsconfig path alias: `@/lib/auth/client` → `./src/lib/auth/client`, `@/ui/context` → `./src/ui/context`
- `@atlas/web` exports UI components for external consumers: `@atlas/web/ui/context`, `@atlas/web/ui/components/atlas-chat`
- Cross-package: `@atlas/api/app`, `@atlas/api/lib/auth/types`, `@atlas/api/lib/db/connection`

### Agent Loop

```
User Question
    ↓
POST /api/chat (Hono route — served standalone, or proxied via Next.js rewrites)
    ↓
authenticateRequest(req) → 401/500 if auth fails
    ↓
checkRateLimit(key) → 429 if over ATLAS_RATE_LIMIT_RPM
    ↓
withRequestContext({ requestId, user }) → AsyncLocalStorage binding
    ↓
validateEnvironment() → 400 if misconfigured
    ↓
runAgent(messages)
    ↓
streamText (Vercel AI SDK, tools from ToolRegistry, stopWhen: stepCountIs(25))
    ├── prepareStep → apply per-step cache control (provider-specific)
    ├── explore → read semantic/*.yml files (path-traversal protected)
    └── executeSQL → validate (4 layers) → query via ConnectionRegistry → { columns, rows }
    ↓
Data Stream Response → Chat UI (onStepFinish logs per-step token usage)
    ↓
Error boundary catches provider/DB errors → structured JSON response
```

**Additional API routes:**

- `POST /api/v1/query` — Synchronous JSON query endpoint. Same agent loop, returns `{ answer, sql, data, steps, usage }` instead of a stream
- `GET /api/v1/conversations` — List conversations (paginated, auth-scoped)
- `GET /api/v1/conversations/:id` — Get conversation with messages
- `DELETE /api/v1/conversations/:id` — Delete conversation
- `/api/v1/actions/*` — Action approval workflow (list, approve, reject)
- `/api/v1/admin/*` — Admin console API (connections, users, plugins, settings, analytics, health)
- `/api/v1/scheduled-tasks/*` — Scheduled task CRUD, run history, delivery channels
- `GET /api/openapi.json` — OpenAPI spec
- `POST /api/slack/commands` — Slack slash command handler (`/atlas`)
- `POST /api/slack/events` — Slack Events API (thread follow-ups, url_verification)
- `GET /api/slack/install` — Slack OAuth install redirect
- `GET /api/slack/callback` — Slack OAuth callback

### SQL Validation Pipeline

**In `validateSQL` (4 layers):**

0. **Empty check** — Reject empty/whitespace-only queries
1. **Regex mutation guard** — Quick reject of obvious DML/DDL keywords
2. **AST parse** — `node-sql-parser` (database mode auto-detected: `"PostgresQL"` or `"MySQL"`) verifies single SELECT-only statement. Unparseable queries are **rejected**, not allowed through. CTE names are extracted here for the whitelist check
3. **Table whitelist** — All tables must exist in `semantic/entities/*.yml` or `semantic/{source}/entities/*.yml` (CTE names excluded). Schema-qualified references (e.g. `analytics.orders`) require the qualified form in the whitelist. Parse failure = rejection

**Applied during execution (3 layers):**

4. **RLS injection** — WHERE clause injection based on user claims (when enabled via `ATLAS_RLS_ENABLED`). Applied after validation + plugin hooks so plugins cannot strip RLS conditions
5. **Auto LIMIT** — Appended to every query (default 1000)
6. **Statement timeout** — Configurable per-query deadline

~103 unit tests cover the core validation pipeline — see `packages/api/src/lib/tools/__tests__/sql.test.ts`. Additional DB-specific validation tests live in each plugin's test directory.

### Database Layer

**Two-database architecture:**

1. **Analytics datasource** (`packages/api/src/lib/db/connection.ts`, `ATLAS_DATASOURCE_URL`) — The user's data. Read-only. Supports PostgreSQL (via `pg` Pool with `statement_timeout` and per-connection `search_path`) and MySQL (via `mysql2` Pool with session-level timeout and read-only mode). Managed via `ConnectionRegistry` — `connections.register(id, config)` / `connections.get(id)` / `connections.getDefault()`. The default connection lazy-inits from `ATLAS_DATASOURCE_URL`. Backward-compatible `getDB()` delegates to `connections.getDefault()`. `executeSQL` accepts optional `connectionId` for multi-database queries. Per-connection table whitelists in `semantic.ts`. PostgreSQL validates schema at init (regex + `pg_namespace` existence check).

2. **Internal database** (`packages/api/src/lib/db/internal.ts`, `DATABASE_URL`) — Atlas's own Postgres for auth tables (Better Auth), audit log, and settings. Read-write. Optional — Atlas works without it (audit goes to pino only, managed auth unavailable). Auto-migrates `audit_log` table on startup. `hasInternalDB()`, `internalQuery()`, `internalExecute()` are the public API.

### Provider System (`packages/api/src/lib/providers.ts`)

| `ATLAS_PROVIDER` | Package | Default Model |
|-------------------|---------|---------------|
| `anthropic` (default) | `@ai-sdk/anthropic` | `claude-opus-4-6` |
| `openai` | `@ai-sdk/openai` | `gpt-4o` |
| `bedrock` | `@ai-sdk/amazon-bedrock` + `/anthropic` | `anthropic.claude-opus-4-6-v1:0` |
| `ollama` | `@ai-sdk/openai` (compat) | `llama3.1` |
| `gateway` | `ai` (built-in) | `anthropic/claude-opus-4.6` |

Override model: `ATLAS_MODEL=claude-sonnet-4-6` (or any supported model ID)

**Bedrock subprovider routing:** Claude models (ID contains `anthropic` or `claude`) auto-route to `bedrockAnthropic()` for full Anthropic API support including prompt caching. Non-Claude models (Nova, Titan, Llama) use generic `bedrock()`.

**Prompt caching:** Applied automatically via `prepareStep` in `agent.ts`. Anthropic/Bedrock-Anthropic use `cacheControl: { type: 'ephemeral' }`, Bedrock native uses `cachePoint: { type: 'default' }`, OpenAI caches automatically for prompts ≥1024 tokens. ~80% token savings on multi-step conversations.

## Key Patterns

### Adding to the Semantic Layer

```yaml
# semantic/entities/table_name.yml
table: table_name
description: |
  What this table contains. What each row represents.
dimensions:
  column_name:
    type: string|number|text|integer|real|numeric|date|boolean|timestamp
    # CLI profiler uses string/number; the semantic layer parser accepts any type name
    description: What this column means
    sample_values: [value1, value2, value3]
joins:
  to_other_table:
    description: table_name.col → other_table.col
query_patterns:
  pattern_name:
    description: What this pattern does
    sql: |
      SELECT ... FROM table_name ...
```

### Database Connection

```typescript
import { getDB, connections } from "@atlas/api/lib/db/connection";

// Default connection (backward compat) — lazy-inits from ATLAS_DATASOURCE_URL
const db = getDB();
const { columns, rows } = await db.query("SELECT ...", 30000);

// Named connections (v0.7+)
connections.register("warehouse", { url: "postgresql://...", schema: "analytics" });
const wh = connections.get("warehouse");
```

### Tool Registry

```typescript
import { ToolRegistry, defaultRegistry } from "@atlas/api/lib/tools/registry";

// Default registry is frozen with explore, executeSQL
const tools = defaultRegistry.getAll();

// Custom registry for specialized agents
const custom = new ToolRegistry();
custom.register({ name: "myTool", description: "...", tool: myAISDKTool });
custom.freeze();
await runAgent({ messages, tools: custom });
```

## Configuration

### Declarative Config (`atlas.config.ts`)

Optional config file for multi-datasource deployments. When present, takes precedence over env vars for datasource and tool config. When absent, env-var behavior is preserved exactly.

```typescript
// atlas.config.ts
import { defineConfig } from "@atlas/api/lib/config";

export default defineConfig({
  datasources: {
    default: { url: process.env.ATLAS_DATASOURCE_URL! },
    warehouse: { url: "postgresql://...", schema: "analytics" },
  },
  tools: ["explore", "executeSQL"],
  auth: "auto",
  semanticLayer: "./semantic",
});
```

### Key Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ATLAS_PROVIDER` | `anthropic` (`gateway` on Vercel) | LLM provider (anthropic/openai/bedrock/ollama/gateway) |
| `ATLAS_MODEL` | Provider default | Model ID override |
| `ATLAS_LOG_LEVEL` | `info` | Pino log level (trace/debug/info/warn/error/fatal) |
| `ATLAS_RUNTIME` | — | Runtime hint: `vercel` enables Vercel-specific sandbox and optimizations |
| `DATABASE_URL` | — | Atlas internal Postgres (auth, audit, settings) |
| `ATLAS_DATASOURCE_URL` | — | Analytics datasource — PostgreSQL or MySQL connection string. Falls back to `DATABASE_URL_UNPOOLED`/`DATABASE_URL` when `ATLAS_DEMO_DATA=true` |
| `ATLAS_DEMO_DATA` | — | Set to `true` to use the internal DB (e.g. Neon) as both analytics datasource and internal DB. Seeds demo data at build time on Vercel |
| `ATLAS_AUTH_MODE` | — | Explicit auth mode: `none`, `api-key`, `managed`, `byot`. When unset, auto-detected from env vars |
| `ATLAS_ADMIN_EMAIL` | — | First managed-auth admin email. If set, this user gets `admin` role on signup and on migration. If unset, the first user to sign up gets admin automatically |
| `ATLAS_API_KEY` | — | Simple API key auth — requires `Authorization: Bearer <key>` |
| `ATLAS_API_KEY_ROLE` | `analyst` | Role for simple-key auth mode (viewer/analyst/admin) |
| `ATLAS_ENCRYPTION_KEY` | — | AES-256-GCM key for encrypting connection URLs at rest. Falls back to `BETTER_AUTH_SECRET` if unset. Any length (SHA-256 derived) |
| `BETTER_AUTH_SECRET` | — | Managed auth (Better Auth) — min 32 chars. Also used as fallback encryption key for connection URLs |
| `BETTER_AUTH_URL` | auto-detect | Base URL for Better Auth |
| `BETTER_AUTH_TRUSTED_ORIGINS` | — | Comma-separated CSRF-allowed origins |
| `ATLAS_AUTH_JWKS_URL` | — | BYOT mode — JWKS endpoint URL for JWT verification |
| `ATLAS_AUTH_ISSUER` | — | BYOT mode — expected JWT issuer |
| `ATLAS_AUTH_AUDIENCE` | — | BYOT mode — expected JWT audience (optional) |
| `ATLAS_AUTH_ROLE_CLAIM` | `role`, `atlas_role` | JWT claim path for BYOT role extraction (supports dot-delimited nested paths like `app_metadata.role`) |
| `ATLAS_RATE_LIMIT_RPM` | — | Max requests per minute per user (0 or unset = disabled) |
| `ATLAS_TRUST_PROXY` | `false` | Trust `X-Forwarded-For`/`X-Real-IP` headers. Set `true` behind a reverse proxy |
| `ATLAS_TABLE_WHITELIST` | `true` | Only allow tables in semantic layer |
| `ATLAS_ROW_LIMIT` | `1000` | Max rows per query |
| `ATLAS_QUERY_TIMEOUT` | `30000` | Query timeout in ms |
| `ATLAS_SCHEMA` | `public` | PostgreSQL schema for profiling and runtime queries |
| `ATLAS_RLS_ENABLED` | — | Set to `true` to enable row-level security filtering on queries |
| `ATLAS_RLS_COLUMN` | — | Column name used for RLS filtering (e.g. `tenant_id`) |
| `ATLAS_RLS_CLAIM` | — | JWT claim path for RLS value extraction (e.g. `org_id`) |
| `ATLAS_SANDBOX` | — | Set to `nsjail` to enforce nsjail isolation (hard fail if unavailable) |
| `ATLAS_SANDBOX_URL` | — | Sidecar service URL for explore isolation (e.g. `http://sandbox-sidecar:8080`) |
| `SIDECAR_AUTH_TOKEN` | — | Optional shared secret for sidecar auth (set on both API and sidecar) |
| `ATLAS_NSJAIL_PATH` | — | Explicit path to nsjail binary (auto-detected on PATH otherwise) |
| `ATLAS_NSJAIL_TIME_LIMIT` | `10` | nsjail per-command time limit in seconds |
| `ATLAS_NSJAIL_MEMORY_LIMIT` | `256` | nsjail per-command memory limit in MB |
| `ATLAS_CORS_ORIGIN` | `*` | CORS allowed origin. **Must** set explicitly for cross-origin + managed auth (cookie-based) |
| `NEXT_PUBLIC_ATLAS_API_URL` | — | Next.js frontend: cross-origin API URL. When unset, same-origin via Next.js rewrites |
| `VITE_ATLAS_API_URL` | — | Vite-based frontend: cross-origin API URL (legacy, unused in current packages) |
| `ATLAS_API_URL` | `http://localhost:3001` | Rewrite target for same-origin mode (only used when `NEXT_PUBLIC_ATLAS_API_URL` is unset) |
| `ATLAS_ACTIONS_ENABLED` | — | Set to `true` to enable the action framework (approval-gated write operations) |
| `ATLAS_SCHEDULER_ENABLED` | — | Set to `true` to enable scheduled task routes and execution |
| `ATLAS_SCHEDULER_BACKEND` | `bun` | Execution backend: `bun` (in-process tick loop), `webhook` (external cron hits POST /:id/run), or `vercel` (Vercel Cron hits POST /tick) |
| `ATLAS_SCHEDULER_SECRET` | — | Shared secret for the `/tick` endpoint (non-Vercel). On Vercel, use `CRON_SECRET` instead |
| `ATLAS_SCHEDULER_MAX_CONCURRENT` | `5` | Maximum concurrent task executions per scheduler tick |
| `ATLAS_SCHEDULER_TIMEOUT` | `60000` | Per-task execution timeout in milliseconds |
| `ATLAS_SCHEDULER_TICK_INTERVAL` | `60` | Tick interval in seconds (how often the scheduler checks for due tasks) |
| `RESEND_API_KEY` | — | Resend API key for email delivery in scheduled tasks |
| `ATLAS_EMAIL_FROM` | `Atlas <noreply@useatlas.dev>` | From address for scheduled task email delivery |
| `SLACK_SIGNING_SECRET` | — | Enables Slack integration when set — used to verify request signatures |
| `SLACK_BOT_TOKEN` | — | Single-workspace Slack mode (skip OAuth) |
| `SLACK_CLIENT_ID` | — | Multi-workspace Slack OAuth app client ID |
| `SLACK_CLIENT_SECRET` | — | Multi-workspace Slack OAuth app client secret |

### Local Postgres (Docker)

```bash
bun run db:up     # Starts postgres:16-alpine with two databases (atlas + atlas_demo)
bun run db:down   # Stops container
bun run db:reset  # Nukes volume, re-seeds from scratch
```

Internal DB: `postgresql://atlas:atlas@localhost:5432/atlas`
Analytics datasource: `postgresql://atlas:atlas@localhost:5432/atlas_demo`
Sandbox sidecar: `http://localhost:8080` (Python execution isolation)

Demo datasets:
- **Simple** (`--demo`): 50 companies, ~200 people, 80 accounts — loaded from `data/demo.sql`
- **Cybersec** (`--demo cybersec`): 62-table SaaS database with ~500K rows — loaded from `data/cybersec.sql`

## Deployment

End-user deploy templates live in `examples/`. Production deploy configs for the Atlas team's Railway infrastructure live in `deploy/`. The root repo has no `Dockerfile` — it's a dev monorepo.

### Docker (`examples/docker/`)

Self-hosted Hono API server with optional nsjail isolation (pair with `nextjs-standalone` for a frontend).

```bash
docker build -f examples/docker/Dockerfile -t atlas .
docker run -p 3001:3001 \
  -e ATLAS_PROVIDER=anthropic \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e ATLAS_DATASOURCE_URL=postgresql://user:pass@host:5432/dbname \
  atlas
```

### Railway

The Docker example includes a `railway.json` platform config. See the example README for platform-specific instructions.

### Required production env vars

| Variable | Example |
|----------|---------|
| `ATLAS_PROVIDER` | `anthropic` |
| Provider API key | `ANTHROPIC_API_KEY=sk-ant-...` |
| `DATABASE_URL` | `postgresql://user:pass@host:5432/atlas` |
| `ATLAS_DATASOURCE_URL` | `postgresql://user:pass@host:5432/dbname` |

`PORT` is set automatically by most platforms. `DATABASE_URL` is auto-set by most platforms (Railway, etc.). All other vars have safe defaults.

## Semantic Layer Generation

### `atlas init` — Enhanced Profiler

The `bin/atlas.ts` profiler queries the database to extract schema information for both **tables and views**. PostgreSQL uses system catalogs (`pg_constraint`, `pg_attribute`) and `information_schema`; MySQL uses `information_schema`. All paths extract:
- **Tables and views** — Both BASE TABLEs and VIEWs are discovered and profiled. Views get `object_type: "view"` on their profile, `type: "view"` in generated YAML, and skip PK/FK/measures/query_patterns generation. Heuristics (abandoned, denormalized) also skip views
- **Primary keys** — marked with `primary_key: true` on dimensions (tables only)
- **Foreign keys** — auto-generates `joins` array with `many_to_one` relationships (tables only)
- **Enum-like columns** — text columns with <20 unique values and <5% cardinality get all distinct values
- **Measures** — `count_distinct` on PKs, `sum`/`avg` on numeric non-FK columns (tables only)
- **Virtual dimensions** — CASE bucketing for numerics, year/month extraction for dates
- **Query patterns** — count-by-enum and aggregate-by-enum patterns (tables only)
- **Auto-generated glossary** — ambiguous terms (same column name in multiple tables), FK relationships, enum definitions
- **Auto-generated metrics** — per-table metric files with atomic and breakdown metrics (tables only; views are excluded)
- **Catalog enrichment** — `use_for` and `common_questions` derived from column types

### `--enrich` — LLM Enrichment

When `--enrich` is passed (or auto-enabled when `ATLAS_PROVIDER` + API key are set), `bin/enrich.ts` calls `generateText()` to:
1. **Enrich entity YAMLs** — adds rich descriptions, improved use_cases, query_patterns, virtual dimensions
2. **Enrich glossary** — adds domain-specific definitions and disambiguation guidance
3. **Enrich metrics** — fills in missing `unit`/`aggregation`/`objective` fields, suggests derived metrics

### `create-atlas-agent` — Project Scaffolding

The `create-atlas/` package provides `bun create atlas-agent my-app`:
1. Interactive prompts for project name, platform (vercel, railway, docker, other), database choice, provider, API key, model. Pass `--defaults` or `-y` to skip all prompts. Pass `--platform <name>` to select a deploy target directly
2. Copies template files from the bundled template directory (includes src/, bin/, data/)
3. Writes `.env` with collected configuration
4. Runs `bun install` and optionally `atlas init --enrich`
5. Prints next steps (`cd my-app && bun run dev`)

## Template Sync

`create-atlas/templates/nextjs-standalone/src/` is **gitignored** and regenerated at publish time by `create-atlas/scripts/prepare-templates.sh`. Never edit template `src/` files directly — edit the monorepo source and the prepare script will copy it.

- `prepare-templates.sh` copies `packages/api/src/` and `packages/web/src/ui/` wholesale into templates. Template-specific overrides (`lib/api-url.ts`, `lib/auth/client.ts`) are saved and restored
- CI runs `scripts/check-template-drift.sh` which regenerates templates and verifies 200+ files match the monorepo source
- A few files are intentionally excluded from the drift check (listed in the script): template-specific Next.js overrides for same-origin embedded API
- Set `SKIP_SYNCPACK=1` to skip the syncpack step when running `prepare-templates.sh` locally (CI does this automatically)

## Quick Reference

Key files not obvious from the monorepo tree above. For standard paths, follow the package structure in the Architecture section.

**Core agent pipeline** — `packages/api/src/lib/`: `agent.ts` (loop), `agent-query.ts` (shared JSON+Slack execution), `providers.ts` (LLM factory), `semantic.ts` (whitelist builder), `startup.ts` (env validation), `security.ts` (scrubbing), `config.ts` (declarative config), `conversations.ts` (persistence), `settings.ts` (admin settings CRUD)

**Tools** — `packages/api/src/lib/tools/`: `sql.ts` (validation+execution), `explore.ts` (reader+backend selection), `explore-nsjail.ts`, `explore-sandbox.ts` (Vercel), `explore-sidecar.ts`, `registry.ts`

**Auth** — `packages/api/src/lib/auth/`: `middleware.ts` (middleware+rate limiting), `detect.ts` (mode detection), `simple-key.ts`, `managed.ts`, `byot.ts`, `server.ts` (Better Auth), `audit.ts`, `migrate.ts`. Client: `packages/web/src/lib/auth/client.ts`

**DB** — `packages/api/src/lib/db/`: `connection.ts` (ConnectionRegistry), `internal.ts` (Atlas's own Postgres)

**Routes** — `packages/api/src/api/`: `index.ts` (Hono app), `server.ts` (standalone entry), `routes/` (chat, health, auth, query, conversations, slack, actions, admin, scheduled-tasks, openapi)

**Shared types** — `packages/api/src/lib/`: `auth/types.ts`, `errors.ts`, `action-types.ts`, `conversation-types.ts`, `sidecar-types.ts`, `scheduled-task-types.ts`

**Scheduler** — `packages/api/src/lib/scheduler/`: `engine.ts` (tick loop, singleton), `executor.ts` (bridges to executeAgentQuery), `delivery.ts` (channel dispatch), `format-email.ts`, `format-slack.ts`, `format-webhook.ts`, `preview.ts` (dry-run preview), `index.ts` (barrel). CRUD: `packages/api/src/lib/scheduled-tasks.ts`. Routes: `packages/api/src/api/routes/scheduled-tasks.ts`

**UI** — `packages/web/src/ui/`: `context.tsx` (provider), `components/atlas-chat.tsx` (orchestrator), `components/chat/*.tsx`, `components/chart/chart-detection.ts`, `hooks/use-conversations.ts`

**CLI** — `packages/cli/bin/`: `atlas.ts` (profiler+diff+query), `enrich.ts`. Data: `packages/cli/data/demo.sql`, `cybersec.sql`

**MCP** — `packages/mcp/`: `src/server.ts` (factory), `src/tools.ts` (bridge), `src/resources.ts`, `bin/serve.ts` (stdio)

**SDK** — `packages/sdk/src/`: `client.ts` (createAtlasClient, query/chat/conversations), `index.ts` (re-exports)

**Plugin SDK** — `packages/plugin-sdk/src/`: `types.ts` (interfaces), `helpers.ts` (definePlugin), `index.ts` (re-exports)

**Infra** — `scripts/start.sh`, `docker-compose.yml` (local Postgres), `.github/workflows/ci.yml`, `create-atlas/index.ts` (scaffolding), `.syncpackrc.json`
