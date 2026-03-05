You are researching the Atlas codebase to answer a question or plan a change.

**Module map (start here):**

| Area | Key files |
|------|-----------|
| Agent loop | `src/lib/agent.ts` — streamText, maxSteps: 25, tool orchestration |
| LLM providers | `src/lib/providers.ts` — anthropic/openai/bedrock/ollama/gateway |
| SQL validation | `src/lib/tools/sql.ts` — 4-layer pipeline + execution |
| Explore tool | `src/lib/tools/explore.ts` — read-only semantic layer access |
| nsjail sandbox | `src/lib/tools/explore-nsjail.ts` — process isolation backend |
| Report tool | `src/lib/tools/report.ts` — final report packaging |
| Semantic layer | `src/lib/semantic.ts` — reads entity YAMLs, builds table whitelist |
| DB connections | `src/lib/db/connection.ts` — PostgreSQL, MySQL adapters |
| Internal DB | `src/lib/db/internal.ts` — Atlas Postgres (auth, audit) |
| Auth middleware | `src/lib/auth/middleware.ts` — request auth + rate limiting |
| Auth detection | `src/lib/auth/detect.ts` — auto-detect auth mode from env |
| Auth (simple key) | `src/lib/auth/simple-key.ts` — timing-safe API key check |
| Auth (managed) | `src/lib/auth/managed.ts` + `server.ts` — Better Auth sessions |
| Auth (BYOT) | `src/lib/auth/byot.ts` — JWT/JWKS verification |
| Audit log | `src/lib/auth/audit.ts` — query logging |
| Startup checks | `src/lib/startup.ts` — env validation, diagnostics |
| Chat UI | `src/app/page.tsx` — useChat hook |
| Chat API | `src/app/api/chat/route.ts` — POST handler → runAgent() |
| Health API | `src/app/api/health/route.ts` — GET health check |
| CLI profiler | `bin/atlas.ts` — DB profiling, semantic layer gen, schema diff |
| LLM enrichment | `bin/enrich.ts` — optional post-processing |
| Scaffolding CLI | `create-atlas/index.ts` — bun create atlas-agent |
| Semantic layer | `semantic/` — catalog.yml, glossary.yml, entities/*.yml, metrics/*.yml |

**Key conventions:**
- bun only (never npm/yarn/node)
- TypeScript strict mode, path alias `@/*` → `./src/*`
- SQL is SELECT-only, AST-validated, table-whitelisted, auto-LIMITed
- Explore tool is path-traversal protected to `semantic/` only

**Your job:** Explore the relevant files to answer the question. Trace through code to understand data flow. Provide a clear, specific answer with file paths and line numbers.
