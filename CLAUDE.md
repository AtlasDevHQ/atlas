# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Core Rules Checklist

**ALWAYS follow these rules when writing code:**

### Security (SQL)
- [ ] **SELECT only** — SQL validation blocks all DML/DDL. Never allow INSERT, UPDATE, DELETE, DROP, TRUNCATE, ALTER, etc.
- [ ] **Single statement** — No `;` chaining. One query per execution
- [ ] **AST validation** — All SQL parsed via `node-sql-parser` (PostgreSQL or MySQL mode, auto-detected). Regex guard is a first pass, not the only check. If the AST parser cannot parse a query, it is **rejected** (never silently skipped)
- [ ] **Table whitelist** — Only tables defined in `semantic/entities/*.yml` or `semantic/{source}/entities/*.yml` are queryable. `packages/api/src/lib/semantic.ts` builds the allowed set. Schema-qualified queries (e.g. `schema.table`) require the qualified name in the whitelist
- [ ] **Auto LIMIT** — Every query gets a LIMIT appended. Default 1000, configurable via `ATLAS_ROW_LIMIT`
- [ ] **Statement timeout** — PostgreSQL and MySQL queries get a session-level timeout. Default 30s, configurable via `ATLAS_QUERY_TIMEOUT`

### Security (General)
- [ ] **Path traversal protection** — Each explore backend enforces read-only access scoped to `semantic/`
- [ ] **No secrets in responses** — Never expose connection strings, API keys, or stack traces to the user or agent
- [ ] **Readonly DB connections** — PostgreSQL uses read-only queries enforced by validation; MySQL uses a read-only session variable; ClickHouse uses `readonly: 1`
- [ ] **Explore tool isolation** — Five-tier priority: Vercel sandbox > nsjail explicit > sidecar > nsjail auto-detect > just-bash (dev fallback). When `ATLAS_SANDBOX_URL` is set, sidecar is the intended backend — nsjail auto-detection is skipped

### Code Style
- [ ] **bun only** — Package manager and runtime. Never npm, yarn, or node
- [ ] **TypeScript strict mode** — Path aliases: `@atlas/api/*` for cross-package, `@/*` → `./src/*` within web only
- [ ] **Tailwind CSS 4** — Via `@tailwindcss/postcss`, not v3
- [ ] **shadcn/ui v2** — New-york style, neutral base, Lucide icons. **Always use shadcn/ui primitives** — never hand-roll equivalent components. Install: `bun x shadcn@latest add <component>` from `packages/web/`. Uses `cn()` from `@/lib/utils`
- [ ] **Server external packages** — `pg`, `mysql2`, `@clickhouse/client`, `@duckdb/node-api`, `snowflake-sdk`, `jsforce`, `just-bash`, `pino`, `pino-pretty` must stay in `serverExternalPackages` in the `create-atlas` template
- [ ] **Frontend is a pure HTTP client** — `@atlas/web` does NOT depend on `@atlas/api`. Shared types are duplicated in `packages/web/src/ui/lib/types.ts`
- [ ] **nuqs for URL state** — Use [nuqs](https://nuqs.47ng.com/) for URL state (pagination, filters, selected items). Define parsers in `search-params.ts` next to the page. Transient UI state stays as `useState`
- [ ] **React Compiler handles memoization** — Do not add `useMemo`, `useCallback`, or `React.memo` for performance. Only use `useMemo` for correctness (stable references), `React.memo` with custom comparators for semantic equality
- [ ] **No async waterfalls** — Use `Promise.all([a(), b()])` for independent awaits
- [ ] **Immutable array operations** — Use `toSorted()`, `toReversed()`, `toSpliced()` in React components
- [ ] **Dynamic imports for heavy components** — Use `next/dynamic` for Monaco, Recharts, syntax highlighters
- [ ] **Flat ESLint config** — `eslint.config.mjs`, not `.eslintrc`

### Testing
- [ ] **`bun run test`, never `bun test`** — Project uses isolated test runner (each file in its own subprocess). Always `bun run test` or `bun test <single-file>`. Never bare `bun test` against a directory
- [ ] **Mock all exports** — When using `mock.module()`, mock every named export. Partial mocks cause `SyntaxError` in other files

### Agent Tools
- [ ] **Tools return structured data** — `executeSQL` returns `{ columns, rows }`
- [ ] **Explore is read-only** — Only `ls`, `cat`, `grep`, `find` on `semantic/`. No writes, no shell escapes
- [ ] **Agent max 25 steps** — `stopWhen: stepCountIs(25)` in `streamText`
- [ ] **Semantic layer drives the agent** — Read entity YAMLs before writing SQL

### Semantic Layer
- [ ] **YAML format** — Entity files define columns, types, sample values, joins, virtual dimensions, measures, query patterns
- [ ] **Metrics are authoritative** — SQL in `metrics/*.yml` must be used exactly as written
- [ ] **Glossary terms** — Terms marked `ambiguous` in `glossary.yml` should trigger clarifying questions

---

## Project Overview

**Atlas** — Deploy-anywhere text-to-SQL data analyst agent. Hono + Next.js + TypeScript + Vercel AI SDK + bun.

### Versioning

Internal milestones (v0.1–v1.0) track architectural progress. Public semver starts fresh post-v1.0 as beta `0.0.1`. Don't confuse internal milestones with public version numbers in user-facing copy.

## Commands

```bash
bun install              # Install dependencies
bun run dev:local        # Containers + dev servers
bun run dev              # Hono API (:3001) + Next.js (:3000)
bun run dev:api          # Standalone Hono API
bun run dev:web          # Standalone Next.js
bun run build            # Production build
bun run lint             # ESLint
bun run type             # TypeScript type-check (tsgo --noEmit)
bun run test             # Tests (isolated per-file)
bun run db:up            # Start Postgres + sandbox sidecar
bun run db:down          # Stop containers
bun run db:reset         # Nuke volume + restart
bun run atlas -- init    # Profile DB, generate semantic layer
bun run atlas -- diff    # Compare DB schema vs semantic layer
```

**Quick start:** `bun install` → `cp .env.example .env` → `bun run db:up` → `bun run atlas -- init` → `bun run dev`. Dev admin: **admin@atlas.dev / atlas-dev**.

## Architecture

### Packages

| Package | Name | Description |
|---------|------|-------------|
| `packages/api` | `@atlas/api` | Hono API server, agent loop, tools, auth, DB, shared types |
| `packages/web` | `@atlas/web` | Next.js frontend, chat UI components (exports `./ui/context`, `./ui/components/atlas-chat`) |
| `packages/cli` | `@atlas/cli` | CLI: profiler, schema diff, enrichment, query |
| `packages/mcp` | `@atlas/mcp` | MCP server (stdio + SSE transport) |
| `packages/sandbox-sidecar` | `@atlas/sandbox-sidecar` | Isolated explore/python sidecar |
| `packages/sdk` | `@useatlas/sdk` | TypeScript SDK for Atlas API |
| `packages/plugin-sdk` | `@useatlas/plugin-sdk` | Plugin type definitions + `definePlugin()` helper |
| `apps/www` | `@atlas/www` | Landing page (useatlas.dev) |
| `apps/docs` | `@atlas/docs` | Documentation site (Fumadocs) |
| `examples/docker` | — | Self-hosted Docker deploy + optional nsjail |
| `examples/nextjs-standalone` | — | Pure Next.js + embedded Hono API (Vercel) |
| `create-atlas` | — | Scaffolding CLI (`bun create atlas-agent`) |
| `plugins/` | — | Atlas plugins directory |

**Import conventions:**
- `@atlas/api` uses its own name: `@atlas/api/lib/agent`, `@atlas/api/lib/auth/types`
- `@atlas/web` uses tsconfig alias: `@/ui/context` → `./src/ui/context`
- Frontend never imports from `@atlas/api` — communicates over HTTP

### Agent Loop

```
POST /api/chat → authenticateRequest → checkRateLimit → withRequestContext → validateEnvironment
    → runAgent(messages)
    → streamText (AI SDK, ToolRegistry, stopWhen: stepCountIs(25))
        ├── explore → read semantic/*.yml (path-traversal protected)
        └── executeSQL → validate (4 layers) → query via ConnectionRegistry → { columns, rows }
    → Data Stream Response → Chat UI
```

### SQL Validation (4 layers)

0. Empty check → 1. Regex mutation guard → 2. AST parse (`node-sql-parser`, single SELECT) → 3. Table whitelist (semantic entities only, CTE names excluded)

Applied at execution: RLS injection (optional) → Auto LIMIT → Statement timeout

### Two-Database Architecture

1. **Analytics datasource** (`ATLAS_DATASOURCE_URL`) — User's data. Read-only. PostgreSQL or MySQL. Managed via `ConnectionRegistry` in `packages/api/src/lib/db/connection.ts`
2. **Internal database** (`DATABASE_URL`) — Atlas's own Postgres for auth, audit, settings. Optional. `packages/api/src/lib/db/internal.ts`

## Key Patterns

### Entity YAML

```yaml
# semantic/entities/table_name.yml
table: table_name
description: What this table contains
dimensions:
  column_name:
    type: string|number|date|boolean|timestamp
    description: What this column means
    sample_values: [value1, value2]
joins:
  to_other_table:
    description: table_name.col → other_table.col
query_patterns:
  pattern_name:
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

## Template Sync

`create-atlas/templates/nextjs-standalone/src/` is gitignored, regenerated by `create-atlas/scripts/prepare-templates.sh`. Never edit template `src/` files directly. CI runs `scripts/check-template-drift.sh` to verify.

## Environment Variables

See `.env.example` for the full list with defaults and descriptions. Key vars: `ATLAS_PROVIDER`, `ATLAS_MODEL`, `ATLAS_DATASOURCE_URL`, `DATABASE_URL`, `ATLAS_AUTH_MODE`, `BETTER_AUTH_SECRET`.
