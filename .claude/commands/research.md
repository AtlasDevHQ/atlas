You are researching the Atlas codebase to answer a question or plan a change.

**Start here:**
- `CLAUDE.md` — Project overview, architecture, commands, conventions
- `ROADMAP.md` — What's shipped, what's next, current priorities
- `src/` — All application source code

**Core modules (how the system works):**
- `src/lib/agent.ts` — Agent loop (streamText, maxSteps: 25, tool orchestration)
- `src/lib/providers.ts` — LLM provider factory (anthropic/openai/bedrock/ollama)
- `src/lib/semantic.ts` — Reads entity YAMLs → builds table whitelist
- `src/lib/db/connection.ts` — PostgreSQL adapter, singleton pool, statement_timeout

**Agent tools:**
- `src/lib/tools/sql.ts` — SQL validation pipeline (5 layers) + execution
- `src/lib/tools/explore.ts` — Read-only semantic layer access (ls/cat/grep/find)
- `src/lib/tools/report.ts` — Final report packaging (sql, csv, narrative)

**Frontend:**
- `src/app/page.tsx` — Chat UI (Vercel AI SDK useChat hook)
- `src/app/api/chat/route.ts` — POST handler → runAgent() → data stream

**Semantic layer (data model on disk):**
- `semantic/catalog.yml` — Entry point listing all entities
- `semantic/glossary.yml` — Business term definitions + ambiguity flags
- `semantic/entities/*.yml` — Table schemas, columns, joins, measures, query patterns
- `semantic/metrics/*.yml` — Canonical metric definitions

**CLI tooling:**
- `bin/atlas.ts` — DB profiler + semantic layer generator (`atlas init`)
- `bin/enrich.ts` — LLM enrichment module (optional post-processing)
- `create-atlas/index.ts` — Scaffolding CLI (`bun create atlas-agent my-app`)

**Infrastructure:**
- `next.config.ts` — Next.js config (serverExternalPackages: pg, just-bash)
- `docker-compose.yml` — Local Postgres setup
- `Dockerfile` — Multi-stage production build
- `data/demo.sql` — Postgres seed data (50 companies, ~200 people, 80 accounts)

**Key conventions:**
- bun only (never npm/yarn/node)
- TypeScript strict mode, path alias `@/*` → `./src/*`
- Tailwind CSS 4 via `@tailwindcss/postcss`
- SQL is SELECT-only, AST-validated, table-whitelisted, auto-LIMITed
- Explore tool is path-traversal protected to `semantic/` only

---

**Your job:** Explore the relevant files above to answer the user's question. Trace through the code to understand data flow, then provide a clear, specific answer with file paths and line numbers.

---

## Execution Output

After completing your research, decide how to present actionable work:

**Option A: Independent prompts (default)**
If the work breaks into 2-3 tasks that touch different files/surfaces with no merge conflicts, output them as standalone prompts the user can paste into separate Claude Code sessions (they have multiple checkouts of this repo).

Format each prompt as:
```
### Prompt [N]: [short title]
**Files:** [key files to create/modify]
**Branch:** [suggested branch name]

[Full prompt — detailed enough for a fresh Claude Code session with only CLAUDE.md context to execute it. Include the specific ROADMAP.md checkbox items being addressed.]
```

**Option B: Agent team**
If the tasks are interdependent (shared interfaces, files that both need to touch, coordination required), recommend using an agent team instead. Explain why parallelization won't work and describe the team structure.

**How to decide:**
- Tasks touching different directories (e.g., `create-atlas/` vs `src/app/` vs `bin/`) → independent prompts
- Tasks that share types, interfaces, or files → agent team
- When in doubt, prefer independent prompts — they're simpler and the user can coordinate manually
