# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Atlas is a deploy-anywhere text-to-SQL data analyst agent. Users ask natural language questions, the agent explores a semantic layer (YAML files on disk), writes validated SQL, and returns interpreted results. Vendor-agnostic: no Vercel infrastructure, runs anywhere.

## Commands

```bash
bun install              # Install dependencies
bun run dev              # Start dev server (Next.js + Turbopack) on :3000
bun run build            # Production build
bun run start            # Start production server
bun run lint             # ESLint (flat config)
bun run type             # TypeScript type-check (tsgo --noEmit)
bun run seed             # Seed demo SQLite DB (data/atlas.db)
bun run atlas -- init    # Profile DB and auto-generate semantic layer
```

To get a working demo: `bun run seed && bun run dev`

## Architecture

### Agent Loop (`src/lib/agent.ts`)

Single-agent architecture using Vercel AI SDK `streamText` with `maxSteps: 25`. The agent has exactly 3 tools:

1. **explore** (`src/lib/tools/explore.ts`) — Read-only access to `semantic/` directory. Supports `ls`, `cat`, `grep`, `find` commands. Path-traversal protected via `resolveSafePath`. The agent reads these YAML files to understand table schemas before writing SQL.

2. **executeSQL** (`src/lib/tools/sql.ts`) — Runs validated read-only queries. Five security layers: regex mutation guard → single-statement check → AST parse via `node-sql-parser` (SELECT only) → table whitelist from semantic layer → auto-appended LIMIT. Returns structured `{ columns, rows }`.

3. **finalizeReport** (`src/lib/tools/report.ts`) — Signals the agent is done. Packages SQL, CSV results, and narrative interpretation.

The agent workflow is: explore semantic layer → write SQL → interpret results → finalize report.

### Semantic Layer (`semantic/`)

This is the core product differentiator. Static YAML files that describe the data model:

- `catalog.yml` — Entry point. Lists all entities with descriptions and common questions.
- `entities/*.yml` — Table schemas with columns, types, sample values, joins, virtual dimensions (computed CASE expressions), measures, and query patterns.
- `metrics/*.yml` — Canonical metric definitions with authoritative SQL the agent must use exactly.
- `glossary.yml` — Business term definitions. Terms marked `ambiguous` trigger clarifying questions.

The semantic layer drives both the agent's understanding AND the SQL validation whitelist (`src/lib/semantic.ts` reads entity YAMLs to build the allowed tables set).

### Provider System (`src/lib/providers.ts`)

`ATLAS_PROVIDER` env var selects the LLM: `anthropic` (default), `openai`, `bedrock`, `ollama`. Each uses its AI SDK provider package directly — no gateway strings. Ollama routes through OpenAI-compatible endpoint.

### Database Layer (`src/lib/db/connection.ts`)

Singleton `getDB()` returns a `DBConnection` interface with `query(sql, timeout)`. Two adapters: SQLite (via `better-sqlite3`, readonly mode, default for demo) and PostgreSQL (via `pg` Pool with `statement_timeout`). Selected by `ATLAS_DB` env var.

### Frontend (`src/app/page.tsx`)

Minimal chat UI using AI SDK `useChat` hook → `POST /api/chat`. The route handler (`src/app/api/chat/route.ts`) calls `runAgent()` and returns a data stream response.

### CLI (`bin/atlas.ts`)

`bun run atlas -- init` profiles a database (SQLite or Postgres), introspects all tables/columns, generates entity YAMLs with sample values and cardinality, creates catalog.yml. This is the "5-minute setup" experience.

## Conventions

- **bun** is the package manager and runtime — never npm/node
- TypeScript strict mode, path alias `@/*` → `./src/*`
- Tailwind CSS 4 via `@tailwindcss/postcss`
- `better-sqlite3` and `pg` are in `serverExternalPackages` (next.config.ts) since they have native bindings
- Environment config via `.env` — see `.env.example` for all options
- Security settings (row limit, query timeout, table whitelist) are env-var configurable but secure by default
