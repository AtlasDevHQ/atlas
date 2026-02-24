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
- [ ] **Readonly DB connections** — SQLite opens in `readonly: true` mode. PostgreSQL uses read-only queries enforced by validation

### Code Style
- [ ] **bun only** — Package manager and runtime. Never npm, yarn, or node
- [ ] **TypeScript strict mode** — Path alias `@/*` → `./src/*`
- [ ] **Tailwind CSS 4** — Via `@tailwindcss/postcss`, not v3
- [ ] **Server external packages** — `better-sqlite3`, `pg`, and `just-bash` must stay in `serverExternalPackages` (next.config.ts) — they have native bindings
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
bun run seed             # Seed demo SQLite DB (data/atlas.db)

# Semantic layer
bun run atlas -- init    # Profile DB and auto-generate semantic layer
```

**Quick start (SQLite):** `bun run seed && bun run dev`

**Quick start (Postgres):** `bun run db:up` → set `ATLAS_DB=postgres` and `DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas` in `.env` → `bun run dev`

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
│   │   └── connection.ts     # DBConnection interface, SQLite + PostgreSQL adapters
│   └── tools/
│       ├── explore.ts        # Read-only semantic layer access (ls/cat/grep/find)
│       ├── sql.ts            # SQL validation (5 layers) + execution
│       └── report.ts         # Final report packaging
semantic/                     # Semantic layer (YAML on disk)
├── catalog.yml               # Entry point — lists all entities
├── glossary.yml              # Business term definitions
├── entities/*.yml            # Table schemas + data profiling
└── metrics/*.yml             # Canonical metric definitions
data/
├── demo.sql                  # Postgres seed data (auto-loaded by Docker)
└── atlas.db                  # SQLite demo database (created by bun run seed)
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

| Adapter | Engine | Package | Mode | Selection |
|---------|--------|---------|------|-----------|
| SQLite | `better-sqlite3` | Native binding | `readonly: true` | `ATLAS_DB=sqlite` (default) |
| PostgreSQL | `pg` Pool | Native binding | `statement_timeout` per query | `ATLAS_DB=postgres` |

Singleton `getDB()` returns a `DBConnection` with `query(sql, timeout)`.

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

const db = getDB();  // Singleton — SQLite or Postgres based on ATLAS_DB
const { columns, rows } = await db.query("SELECT ...", 30000);
```

## Configuration

### Key Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ATLAS_PROVIDER` | `anthropic` | LLM provider (anthropic/openai/bedrock/ollama) |
| `ATLAS_MODEL` | Provider default | Model ID override |
| `ATLAS_DB` | `sqlite` | Database engine (sqlite/postgres) |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `ATLAS_SQLITE_PATH` | `./data/atlas.db` | SQLite file path |
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
| Docker setup | `docker-compose.yml` |
| Environment reference | `.env.example` |
