# Atlas Roadmap

> Single source of truth for what's shipped and what's next.
> Updated as work completes. Referenced by `/next` command.

---

## v0.1 — Foundation (Shipped)

The core text-to-SQL agent, end to end.

- [x] Agent loop — streamText with 3 tools (explore, executeSQL, finalizeReport)
- [x] SQL validation — Multi-layer pipeline (empty check, regex, AST, whitelist, auto-LIMIT, statement timeout)
- [x] Semantic layer — YAML on disk (catalog, entities, glossary, metrics)
- [x] DB profiler CLI — `atlas init` with PK/FK detection, enum sampling, measures, virtual dimensions
- [x] LLM enrichment — `atlas init --enrich` post-processing via generateText
- [x] 5 LLM providers — Anthropic, OpenAI, Bedrock, Ollama, Vercel AI Gateway
- [x] Chat UI — Minimal useChat interface with streaming
- [x] Docker + Railway deployment — Multi-stage Dockerfile, railway.json
- [x] create-atlas scaffolding — `bun create atlas my-app` with interactive setup
- [x] Demo dataset — 50 companies, ~200 people, 80 accounts
- [x] PostgreSQL only — Singleton pool with statement_timeout

---

## v0.2 — Deploy Anywhere

Make `bun create atlas`, deployment, and the getting-started path bulletproof. Support both self-hosted (Docker/Railway/Fly) and Vercel-native deployment.

> **Origin:** Atlas is based on [vercel-labs/oss-data-analyst](https://github.com/vercel-labs/oss-data-analyst). The original uses Vercel Sandbox for the explore tool. We support both Vercel Sandbox and self-hosted (`just-bash`) via an adapter pattern.

### Vercel Sandbox integration
- [ ] Explore tool adapter — Abstract the shell backend behind an interface: `just-bash` for self-hosted, `@vercel/sandbox` for Vercel. Same tool contract, two implementations
- [ ] Sandbox lifecycle — Create sandbox on first explore call, write `semantic/` files into it, reuse for the session. Snapshot for fast cold starts
- [ ] Vercel deployment — `vercel.json` or auto-detect, OIDC auth for sandbox, env var documentation
- [ ] Add `@vercel/sandbox` as optional dependency — Only loaded when `ATLAS_RUNTIME=vercel` (or auto-detected via `VERCEL` env var)

### create-atlas CLI
- [ ] Self-contained template — Bundle source files into the package instead of copying from parent repo via relative path (current `path.resolve(import.meta.dir, "..")` breaks on npm install)
- [ ] Publish to npm — `bun create atlas my-app` works from the registry
- [ ] Vercel as deployment option — Add Vercel to the platform select in create-atlas, generate appropriate config
- [ ] Pre-flight checks — Verify bun version, Docker availability, port conflicts before scaffolding
- [ ] DB connectivity check — Verify DATABASE_URL is reachable before running `atlas init`
- [ ] Smoke test — CI test that scaffolds a project, installs deps, and runs `bun run build` successfully

### Deployment configs
- [ ] Health endpoint — `GET /api/health` returns DB status, provider config, semantic layer presence
- [ ] Docker healthcheck — `HEALTHCHECK` instruction in Dockerfile using `/api/health`
- [ ] Fly.io support — `fly.toml` config + Fly Postgres setup instructions
- [ ] Render support — Deploy docs (Render auto-detects Dockerfile, just needs env var guide)

### atlas init hardening
- [ ] Connection test first — `atlas init` pings DB and reports version/permissions before profiling
- [ ] Progress output — Show table-by-table progress during profiling (not silent until done)
- [ ] Graceful partial failure — If one table fails to profile, continue with others and report errors at end

### Error messages
- [x] Startup diagnostics — Clear error when DATABASE_URL is missing/unreachable, API key is missing, or provider is misconfigured
- [x] Agent-facing errors — When a SQL query fails, return the Postgres error message to the agent (not a stack trace to the user)

### Documentation
- [ ] Quick start guide — Step-by-step for local dev, from zero to asking questions
- [ ] Deploy guides — One page each for Railway, Fly.io, Render, Docker, Vercel
- [ ] Bring-your-own-DB guide — How to connect Atlas to an existing production database safely

---

## v0.3 — Agent Quality & UI

Make the agent smarter and the UI worth showing in a demo.

### Agent
- [x] Error recovery — Agent retries with corrected SQL when a query fails
- [ ] Multi-turn awareness — Agent references previous queries/results in follow-ups
- [ ] Clarifying questions — Agent asks before querying when terms are ambiguous (glossary-driven)

### UI
- [x] Rendered data tables — Formatted numbers in styled tables
- [ ] Sortable columns — Click-to-sort on data table headers
- [x] Starter prompts — Suggested questions on empty state (driven by catalog.yml `common_questions`)
- [x] Tool call visibility — Show explore/SQL steps as collapsible cards
- [x] Copy/export — Copy SQL, download CSV from finalizeReport results
- [ ] Dark/light theme — Respect system preference

---

## v0.4 — Semantic Layer Maturity

Make `atlas init` work on real-world databases, not just demos.

- [ ] MySQL support — Profiler + runtime (add mysql2 adapter to connection.ts)
- [ ] Schema drift detection — Compare current DB schema against existing entity YAMLs, flag changes
- [ ] Table filtering UX — Interactive table selection during `atlas init` (not just `--tables`)
- [ ] Relationship inference — Suggest joins from naming conventions when FKs are missing
- [ ] Schema selection — `--schema` flag for non-`public` schemas
- [ ] Profiler edge cases — Handle views, materialized views, partitioned tables

---

## v0.5 — Production Readiness

What you need before handing Atlas to a real team.

- [ ] Authentication — Protect `/api/chat` (API key, OAuth, or session-based)
- [ ] Query audit log — Log every SQL execution with user, timestamp, duration, row count
- [ ] Rate limiting — Per-user query throttle
- [x] Test coverage — Unit tests for SQL validation (64 tests in `src/lib/tools/__tests__/sql.test.ts`)
- [ ] Test coverage — Integration tests for agent loop
- [x] Error boundaries — Graceful UI handling of API failures, DB timeouts, provider errors
- [ ] Observability — Structured logging, optional trace export (OpenTelemetry)

---

## Backlog

Ideas to evaluate. Not committed, not ordered.

- **Charts & visualization** — Auto-detect chart-appropriate results, render with a charting lib
- **Saved queries** — Bookmark and re-run previous analyses
- **Scheduled reports** — Cron-driven query execution with email/Slack delivery
- **Multi-database** — Connect to multiple databases in one instance
- **RAG over semantic layer** — Embed entity descriptions for smarter tool selection on large schemas
- **API/SDK mode** — Headless mode for programmatic access (no UI, just REST/streaming)
- **Multi-agent** — Researcher agent explores schema, analyst agent writes SQL
- **Custom tools** — User-defined tools beyond explore/SQL/report
- **Row-level security** — Filter queries based on user identity/role
- **Postgres extensions** — pgvector, PostGIS awareness in profiler

---

## Status Key

- [x] Shipped
- [ ] Planned (in a versioned milestone)
- Backlog items have no checkbox — they're ideas, not commitments
