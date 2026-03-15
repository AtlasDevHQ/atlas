You are researching the Atlas codebase to answer a question or plan a change.

**Start with these for high-level context:**
- `.claude/research/ROADMAP.md` — current milestones, shipped work, what's next. The active milestone (0.5.0 — Launch) is a 3-week sprint ending early April focused on embeddable widget, BigQuery, Python SDK, and launch prep
- `.claude/research/design/competitive-landscape.md` — competitive analysis, positioning, licensing strategy, strategic rationale for roadmap ordering

**Module map:**

| Area | Key files |
|------|-----------|
| Agent loop | `packages/api/src/lib/agent.ts` — streamText, stopWhen: stepCountIs(getAgentMaxSteps()), tool orchestration |
| Agent query | `packages/api/src/lib/agent-query.ts` — shared execution for JSON + Slack |
| LLM providers | `packages/api/src/lib/providers.ts` — anthropic/openai/bedrock/ollama/gateway |
| SQL validation | `packages/api/src/lib/tools/sql.ts` — 4-layer pipeline + execution |
| Explore tool | `packages/api/src/lib/tools/explore.ts` — read-only semantic layer access |
| Python sandbox | `packages/api/src/lib/tools/python.ts` — executePython with import guard |
| Tool registry | `packages/api/src/lib/tools/registry.ts` — frozen default tools |
| nsjail sandbox | `packages/api/src/lib/tools/explore-nsjail.ts` — process isolation backend |
| Vercel sandbox | `packages/api/src/lib/tools/explore-sandbox.ts` — Firecracker VM backend |
| Sidecar sandbox | `packages/api/src/lib/tools/explore-sidecar.ts` — HTTP container backend |
| Semantic layer | `packages/api/src/lib/semantic.ts` — reads entity YAMLs, builds table whitelist |
| DB connections | `packages/api/src/lib/db/connection.ts` — ConnectionRegistry, PostgreSQL, MySQL |
| Internal DB | `packages/api/src/lib/db/internal.ts` — Atlas Postgres (auth, audit) |
| Config | `packages/api/src/lib/config.ts` — declarative config (atlas.config.ts) |
| Startup | `packages/api/src/lib/startup.ts` — env validation, diagnostics |
| Errors | `packages/api/src/lib/errors.ts` — ChatErrorCode, structured error handling |
| Security | `packages/api/src/lib/security.ts` — secret scrubbing |
| Logger | `packages/api/src/lib/logger.ts` — Pino-based, redaction, request context |
| Tracing | `packages/api/src/lib/tracing.ts` — OpenTelemetry spans |
| Auth middleware | `packages/api/src/lib/auth/middleware.ts` — request auth + rate limiting |
| Auth detection | `packages/api/src/lib/auth/detect.ts` — auto-detect auth mode from env |
| Auth (simple key) | `packages/api/src/lib/auth/simple-key.ts` — timing-safe API key check |
| Auth (managed) | `packages/api/src/lib/auth/managed.ts` + `server.ts` — Better Auth sessions |
| Auth (BYOT) | `packages/api/src/lib/auth/byot.ts` — JWT/JWKS verification |
| Audit log | `packages/api/src/lib/auth/audit.ts` — query logging |
| Scheduler | `packages/api/src/lib/scheduler/` — engine, executor, delivery, formatters |
| Actions | `packages/api/src/lib/action-types.ts` — approval framework |
| Conversations | `packages/api/src/lib/conversations.ts` — persistence CRUD |
| Routes | `packages/api/src/api/routes/` — chat, query, health, auth, admin, slack, etc. |
| OpenAPI | `packages/api/src/api/routes/openapi.ts` — GET /api/v1/openapi.json |
| Hono app | `packages/api/src/api/index.ts` — mount routes, CORS |
| Chat UI | `packages/web/src/ui/components/atlas-chat.tsx` — top-level orchestrator |
| UI context | `packages/web/src/ui/context.tsx` — AtlasUIProvider |
| Chat components | `packages/web/src/ui/components/chat/` — 14 components |
| Admin console | `packages/web/src/app/admin/` — read-only admin pages |
| CLI | `packages/cli/bin/atlas.ts` — init, diff, query, mcp, plugin, migrate |
| CLI enrichment | `packages/cli/bin/enrich.ts` — LLM enrichment |
| MCP server | `packages/mcp/src/server.ts` — createAtlasMcpServer() |
| MCP tools | `packages/mcp/src/tools.ts` — AI SDK tools to MCP bridge |
| SDK client | `packages/sdk/src/client.ts` — createAtlasClient() |
| Plugin SDK | `packages/plugin-sdk/src/types.ts` + `helpers.ts` — definePlugin, createPlugin |
| Plugins | `plugins/` — 15 reference plugins (datasource, context, interaction, action, sandbox) |
| Scaffolding | `create-atlas/index.ts` — bun create @useatlas my-app |
| Landing page | `apps/www/src/app/page.tsx` — useatlas.dev |
| Semantic layer | `semantic/` — catalog.yml, glossary.yml, entities/*.yml, metrics/*.yml |
| Deploy configs | `deploy/` — api, web, www, sidecar Railway configs |
| Examples | `examples/docker/`, `examples/nextjs-standalone/` |
| E2E tests | `e2e/` — surfaces, helpers, fixtures |

**Key conventions:**
- bun only (never npm/yarn/node)
- TypeScript strict mode. Path aliases: `@atlas/api/*` cross-package, `@/*` within web
- SQL is SELECT-only, AST-validated, table-whitelisted, auto-LIMITed
- Explore tool is path-traversal protected to `semantic/` only
- Plugin SDK follows Better Auth pattern: factory functions, `satisfies AtlasPlugin`, Zod config schemas

**Your job:** Explore the relevant files to answer the question. Trace through code to understand data flow. Provide a clear, specific answer with file paths and line numbers.
