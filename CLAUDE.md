# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Core Rules Checklist

**ALWAYS follow these rules when writing code:**

### Security (SQL)
- [ ] **SELECT only** — SQL validation blocks all DML/DDL. Never allow INSERT, UPDATE, DELETE, DROP, TRUNCATE, ALTER, etc.
- [ ] **Single statement** — No `;` chaining. One query per execution
- [ ] **AST validation** — All SQL parsed via `node-sql-parser`. Regex guard is a first pass, not the only check
- [ ] **Table whitelist** — Only tables defined in `semantic/entities/*.yml` are queryable. `src/lib/semantic.ts` builds the allowed set
- [ ] **Auto LIMIT** — Every query gets a LIMIT appended. Default 1000, configurable via `ATLAS_ROW_LIMIT`
- [ ] **Statement timeout** — PostgreSQL queries get `SET statement_timeout`. Default 30s, configurable via `ATLAS_QUERY_TIMEOUT`

### Security (General)
- [ ] **Path traversal protection** — `resolveSafePath` in explore tool restricts reads to `semantic/` directory only
- [ ] **No secrets in responses** — Never expose connection strings, API keys, or stack traces to the user or agent
- [ ] **Readonly DB connections** — PostgreSQL uses read-only queries enforced by validation

### Code Style
- [ ] **bun only** — Package manager and runtime. Never npm, yarn, or node
- [ ] **TypeScript strict mode** — Path alias `@/*` → `./src/*`
- [ ] **Tailwind CSS 4** — Via `@tailwindcss/postcss`, not v3
- [ ] **Server external packages** — `pg` and `just-bash` must stay in `serverExternalPackages` (next.config.ts) — they have native bindings
- [ ] **Flat ESLint config** — `eslint.config.mjs`, not `.eslintrc`

### Agent Tools
- [ ] **Tools return structured data** — `executeSQL` returns `{ columns, rows }`. `finalizeReport` returns `{ sql, csv, narrative }`
- [ ] **Explore is read-only** — Only `ls`, `cat`, `grep`, `find` on the `semantic/` directory. No writes, no shell escapes
- [ ] **Agent max 25 steps** — `maxSteps: 25` in `streamText`. Don't increase without good reason
- [ ] **Semantic layer drives the agent** — The agent must read entity YAMLs before writing SQL. This is the intended workflow

### Semantic Layer
- [ ] **YAML format** — Entity files define columns, types, sample values, joins, virtual dimensions, measures, and query patterns
- [ ] **Metrics are authoritative** — SQL in `metrics/*.yml` must be used exactly as written by the agent
- [ ] **Glossary terms** — Terms marked `ambiguous` in `glossary.yml` should trigger clarifying questions

---

## Project Overview

**Atlas** — Deploy-anywhere text-to-SQL data analyst agent. Users ask natural language questions, the agent explores a semantic layer (YAML files on disk), writes validated SQL, and returns interpreted results.

> Based on [vercel-labs/oss-data-analyst](https://github.com/vercel-labs/oss-data-analyst). Supports both self-hosted (Docker/Railway/Fly via `just-bash`) and Vercel-native deployment (via `@vercel/sandbox`).

> Next.js 16 + TypeScript + Vercel AI SDK + bun

## Commands

```bash
# Dev
bun install              # Install dependencies
bun run dev              # Start dev server (Next.js + Turbopack) on :3000
bun run build            # Production build
bun run start            # Start production server

# Quality
bun run lint             # ESLint (flat config)
bun run type             # TypeScript type-check (tsgo --noEmit)

# Database
bun run db:up            # Start local Postgres (Docker, auto-seeds demo data)
bun run db:down          # Stop local Postgres
bun run db:reset         # Nuke volume + restart (fresh seed)

# Semantic layer
bun run atlas -- init              # Profile DB and auto-generate semantic layer
bun run atlas -- init --enrich     # Profile + LLM enrichment (needs API key)
bun run atlas -- init --no-enrich  # Explicitly skip LLM enrichment
bun run atlas -- init --tables t1,t2  # Only profile specific tables
```

**Quick start:** `bun run db:up` → set `DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas` in `.env` → `bun run dev`

**New project:** `bun create atlas my-app` — interactive scaffolding with provider setup, DB config, and optional semantic layer generation.

**Production:** Set `DATABASE_URL` to your managed Postgres. No Docker needed.

## Architecture

### Module Structure

```
src/
├── app/
│   ├── page.tsx              # Chat UI (AI SDK useChat hook)
│   └── api/chat/route.ts     # POST handler → runAgent() → data stream
├── lib/
│   ├── agent.ts              # Agent loop (streamText, maxSteps: 25)
│   ├── providers.ts          # LLM provider factory (anthropic/openai/bedrock/ollama)
│   ├── semantic.ts           # Reads entity YAMLs → builds table whitelist
│   ├── db/
│   │   └── connection.ts     # DBConnection interface, PostgreSQL adapter
│   └── tools/
│       ├── explore.ts        # Read-only semantic layer access (ls/cat/grep/find)
│       ├── sql.ts            # SQL validation (5 layers) + execution
│       └── report.ts         # Final report packaging
bin/
├── atlas.ts                  # CLI — DB profiler + semantic layer generator
└── enrich.ts                 # LLM enrichment module (optional post-processing)
semantic/                     # Semantic layer (YAML on disk)
├── catalog.yml               # Entry point — lists all entities
├── glossary.yml              # Business term definitions
├── entities/*.yml            # Table schemas + data profiling
└── metrics/*.yml             # Canonical metric definitions
data/
└── demo.sql                  # Postgres seed data (auto-loaded by Docker)
create-atlas/                 # Scaffolding CLI package (bun create atlas)
├── index.ts                  # Interactive setup prompts
├── package.json              # npm package metadata
└── template/                 # Files copied to new projects
```

### Agent Loop

```
User Question
    ↓
runAgent(messages)
    ↓
streamText (Vercel AI SDK, maxSteps: 25)
    ├── explore → read semantic/*.yml files (path-traversal protected)
    ├── executeSQL → validate (5 layers) → query DB → { columns, rows }
    └── finalizeReport → { sql, csv, narrative }
    ↓
Data Stream Response → Chat UI
```

### SQL Validation Pipeline (5 layers)

1. **Regex mutation guard** — Quick reject of obvious DML/DDL keywords
2. **Single-statement check** — No `;` chaining
3. **AST parse** — `node-sql-parser` verifies SELECT-only
4. **Table whitelist** — All tables must exist in `semantic/entities/*.yml`
5. **Auto LIMIT** — Appended to every query (default 1000)

Then: `statement_timeout` set per-query on PostgreSQL connections.

### Database Layer (`src/lib/db/connection.ts`)

PostgreSQL via `pg` Pool with `statement_timeout` per query. Singleton `getDB()` returns a `DBConnection` with `query(sql, timeout)`.

### Provider System (`src/lib/providers.ts`)

| `ATLAS_PROVIDER` | Package | Default Model |
|-------------------|---------|---------------|
| `anthropic` (default) | `@ai-sdk/anthropic` | `claude-sonnet-4-6` |
| `openai` | `@ai-sdk/openai` | `gpt-4o` |
| `bedrock` | `@ai-sdk/amazon-bedrock` | (region-specific) |
| `ollama` | `@ai-sdk/openai` (compat) | (local model) |

Override model: `ATLAS_MODEL=claude-opus-4-6`

## Key Patterns

### Adding to the Semantic Layer

```yaml
# semantic/entities/table_name.yml
table: table_name
description: |
  What this table contains. What each row represents.
columns:
  column_name:
    type: text|integer|real|numeric|date|boolean
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
import { getDB } from "@/lib/db/connection";

const db = getDB();  // Singleton — Postgres via DATABASE_URL
const { columns, rows } = await db.query("SELECT ...", 30000);
```

## Configuration

### Key Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ATLAS_PROVIDER` | `anthropic` | LLM provider (anthropic/openai/bedrock/ollama) |
| `ATLAS_MODEL` | Provider default | Model ID override |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `ATLAS_READ_ONLY` | `true` | Reject non-SELECT SQL |
| `ATLAS_TABLE_WHITELIST` | `true` | Only allow tables in semantic layer |
| `ATLAS_ROW_LIMIT` | `1000` | Max rows per query |
| `ATLAS_QUERY_TIMEOUT` | `30000` | Query timeout in ms |

### Local Postgres (Docker)

```bash
bun run db:up     # Starts postgres:16-alpine, seeds demo data
bun run db:down   # Stops container
bun run db:reset  # Nukes volume, re-seeds from scratch
```

Connection: `postgresql://atlas:atlas@localhost:5432/atlas`

Demo data: 50 companies, ~200 people, 80 accounts (loaded from `data/demo.sql`).

## Deployment

### Docker (any platform)

The multi-stage `Dockerfile` produces a standalone Next.js build. It works on Railway, Fly.io, Render, or any Docker-capable host.

```bash
docker build -t atlas .
docker run -p 3000:3000 \
  -e ATLAS_PROVIDER=anthropic \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e DATABASE_URL=postgresql://user:pass@host:5432/dbname \
  atlas
```

### Railway

1. Create a new Railway project and add a **Postgres** plugin
2. Connect your repo — Railway detects `railway.json` and uses the Dockerfile
3. Set environment variables in the Railway dashboard:
   - `ATLAS_PROVIDER` + its API key (e.g. `ANTHROPIC_API_KEY`)
   - `DATABASE_URL` — use the Railway-provided Postgres connection string
4. Seed the database: connect to the Railway Postgres instance and run `data/demo.sql`, or use `bun run atlas -- init` to generate a semantic layer from your own data
5. Deploy — Railway builds and starts the container automatically

### Required production env vars

| Variable | Example |
|----------|---------|
| `ATLAS_PROVIDER` | `anthropic` |
| Provider API key | `ANTHROPIC_API_KEY=sk-ant-...` |
| `DATABASE_URL` | `postgresql://user:pass@host:5432/dbname` |

`PORT` is set automatically by most platforms. All other vars have safe defaults.

## Semantic Layer Generation

### `atlas init` — Enhanced Profiler

The `bin/atlas.ts` profiler queries Postgres system catalogs (`pg_constraint`, `pg_attribute`) to extract:
- **Primary keys** — marked with `primary_key: true` on dimensions
- **Foreign keys** — auto-generates `joins` array with `many_to_one` relationships
- **Enum-like columns** — text columns with <20 unique values and <5% cardinality get all distinct values
- **Measures** — `count_distinct` on PKs, `sum`/`avg` on numeric non-FK columns
- **Virtual dimensions** — CASE bucketing for numerics, year/month extraction for dates
- **Query patterns** — count-by-enum and aggregate-by-enum patterns
- **Auto-generated glossary** — ambiguous terms (same column name in multiple tables), FK relationships, enum definitions
- **Auto-generated metrics** — per-table metric files with atomic and breakdown metrics
- **Catalog enrichment** — `use_for` and `common_questions` derived from column types

### `--enrich` — LLM Enrichment

When `--enrich` is passed (or auto-enabled when `ATLAS_PROVIDER` + API key are set), `bin/enrich.ts` calls `generateText()` to:
1. **Enrich entity YAMLs** — adds rich descriptions, improved use_cases, query_patterns, virtual dimensions
2. **Enrich glossary** — adds domain-specific definitions and disambiguation guidance
3. **Enrich metrics** — fills in missing `unit`/`aggregation`/`objective` fields, suggests derived metrics

### `create-atlas` — Project Scaffolding

The `create-atlas/` package provides `bun create atlas my-app`:
1. Interactive prompts for provider, API key, model, database URL
2. Copies template files + source code from the Atlas repo
3. Writes `.env` with collected configuration
4. Runs `bun install` and optionally `atlas init --enrich`
5. Prints platform-specific deploy instructions (Railway, Fly.io, Docker)

## Quick Reference

| Need | Where |
|------|-------|
| Agent loop | `src/lib/agent.ts` |
| SQL validation + execution | `src/lib/tools/sql.ts` |
| Semantic layer reader | `src/lib/tools/explore.ts` |
| Table whitelist builder | `src/lib/semantic.ts` |
| DB connection factory | `src/lib/db/connection.ts` |
| LLM provider setup | `src/lib/providers.ts` |
| Chat UI | `src/app/page.tsx` |
| API route | `src/app/api/chat/route.ts` |
| Semantic layer entry point | `semantic/catalog.yml` |
| Entity schemas | `semantic/entities/*.yml` |
| Metric definitions | `semantic/metrics/*.yml` |
| Postgres seed data | `data/demo.sql` |
| CLI (semantic layer generator) | `bin/atlas.ts` |
| LLM enrichment module | `bin/enrich.ts` |
| Scaffolding CLI | `create-atlas/index.ts` |
| Docker setup | `docker-compose.yml` |
| Environment reference | `.env.example` |
