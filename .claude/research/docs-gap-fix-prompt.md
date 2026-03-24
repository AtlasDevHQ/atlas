# Prompt: Fix all Atlas docs gaps

## Task

Create 11 new documentation pages and update the docs navigation for the Atlas docs site at `apps/docs/content/docs/`. Also update `apps/docs/content/docs/index.mdx` to link to all new pages. Run `bun run type` and `bun run lint` before committing.

---

## Style conventions (match existing pages exactly)

- **Frontmatter:** `title` and `description` only. No `sidebar` or other fields.
- **Imports:** Use `import { Callout } from "fumadocs-ui/components/callout";` when you need callouts. No other Fumadocs component imports.
- **Opening paragraph:** One sentence that summarizes the page, immediately after frontmatter. No `#` heading — Fumadocs renders the `title` as `<h1>`.
- **Section separators:** Use `---` between major sections (see `connect-your-data.mdx`).
- **Code blocks:** Use language tags (`bash`, `typescript`, `yaml`, `sql`). Show real Atlas code, not pseudocode.
- **Tables:** Use for comparison/reference data (see authentication.mdx for the pattern).
- **Callouts:** Use `<Callout type="warn">` for warnings, `<Callout type="info">` for tips. Sparingly.
- **Links:** Internal links use `/docs/...` paths (e.g., `/docs/reference/cli`). External links are full URLs.
- **Tone:** Direct, technical, concise. No marketing language. No "In this guide we will..." — just start.
- **Length:** Aim for 100–250 lines per page. Enough to be comprehensive, not so much it's overwhelming.

---

## Source of truth

Read the **actual source code** for each feature before writing its docs page. The CLAUDE.md has an overview, but the code is authoritative. Key files to read per page:

| Page | Source files to read |
|------|---------------------|
| Semantic Layer | `packages/api/src/lib/semantic.ts`, `semantic/entities/*.yml` (any example), `semantic/glossary.yml`, `semantic/metrics/*.yml`, `semantic/catalog.yml` |
| SDK | `packages/sdk/src/client.ts`, `packages/sdk/src/index.ts`, `packages/sdk/package.json` |
| MCP Server | `packages/mcp/src/server.ts`, `packages/mcp/src/tools.ts`, `packages/mcp/src/resources.ts`, `packages/mcp/bin/serve.ts` |
| Slack | `packages/api/src/lib/slack/api.ts`, `packages/api/src/lib/slack/verify.ts`, `packages/api/src/lib/slack/format.ts`, `packages/api/src/lib/slack/threads.ts`, `packages/api/src/api/routes/slack.ts` |
| Scheduled Tasks | `packages/api/src/lib/scheduler/engine.ts`, `packages/api/src/lib/scheduler/executor.ts`, `packages/api/src/lib/scheduler/delivery.ts`, `packages/api/src/lib/scheduled-task-types.ts`, `packages/api/src/lib/scheduled-tasks.ts`, `packages/api/src/api/routes/scheduled-tasks.ts` |
| Admin Console | `packages/web/src/app/admin/` (all files) |
| Declarative Config | `packages/api/src/lib/config.ts` |
| Actions | `packages/api/src/lib/action-types.ts`, `packages/api/src/lib/tools/` (look for action-related tools), `packages/api/src/api/routes/` (action routes) |
| Python Tool | `packages/api/src/lib/tools/python.ts`, `packages/api/src/lib/tools/explore.ts` (python sandbox backends) |
| API Reference | `packages/api/src/api/routes/chat.ts`, `packages/api/src/api/routes/query.ts`, `packages/api/src/api/routes/conversations.ts`, `packages/api/src/api/index.ts` |
| Troubleshooting | `packages/api/src/lib/startup.ts`, `packages/api/src/lib/errors.ts`, `packages/cli/bin/atlas.ts` (doctor command) |

---

## Pages to create

### 1. `getting-started/semantic-layer.mdx` — Semantic Layer Guide

The most important missing page. This is the core concept of Atlas.

**Sections:**
- What the semantic layer is and why it matters (2–3 sentences, not a sales pitch)
- Directory structure (`semantic/entities/`, `semantic/metrics/`, `semantic/glossary.yml`, `semantic/catalog.yml`, per-source layout `semantic/{source}/entities/`)
- Entity YAML reference — full field reference with types and examples. Read `semantic.ts` to get the exact fields: `table`, `description`, `object_type`, `dimensions` (with `type`, `description`, `sample_values`, `primary_key`), `joins` (with `description`, `cardinality`), `virtual_dimensions`, `measures`, `query_patterns`, `use_for`, `common_questions`
- Glossary YAML reference — `term`, `definition`, `ambiguous`, `related_terms`
- Metrics YAML reference — `name`, `description`, `sql`, `unit`, `aggregation`, `objective`, atomic vs breakdown
- Catalog reference — `use_for`, `common_questions`
- Manual editing tips — when to edit by hand vs re-run `atlas init --enrich`
- How the agent uses the semantic layer (reads entities → understands schema → writes SQL)

**Cross-link to:** `/docs/reference/cli` (init, diff commands), `/docs/getting-started/connect-your-data`

### 2. `reference/sdk.mdx` — SDK Reference

**Sections:**
- Installation (`bun add @useatlas/sdk`)
- `createAtlasClient(options)` — full options reference (baseUrl, apiKey, headers, etc.)
- `client.query(question, options)` — request/response shape, options (format, quiet, connectionId)
- `client.chat(messages, options)` — streaming, message format
- `client.conversations.list()`, `.get(id)`, `.delete(id)` — conversation management
- `AtlasError` — error handling patterns
- Authentication — how to pass API key, managed auth cookies, BYOT tokens
- Examples: simple query, streaming chat, conversation history

### 3. `reference/api.mdx` — API Reference

**Sections:**
- Base URL configuration (same-origin vs cross-origin)
- `POST /api/chat` — streaming chat endpoint. Request body (messages, conversationId), response format (data stream), headers
- `POST /api/v1/query` — synchronous query. Request body (question, format, connectionId), response shape (answer, sql, data, steps, usage)
- `GET /api/v1/conversations` — list (pagination params, response shape)
- `GET /api/v1/conversations/:id` — get with messages
- `DELETE /api/v1/conversations/:id` — delete
- `GET /api/health` — health check response format
- Authentication headers per auth mode
- Error responses — status codes, error body format (read `errors.ts` for ChatErrorCode enum)
- Rate limiting — 429 response, `Retry-After` header

### 4. `reference/config.mdx` — Configuration Guide (`atlas.config.ts`)

**Sections:**
- When to use config file vs env vars (config file wins when present, env vars still work as fallback)
- `defineConfig()` — full TypeScript type reference
- `datasources` — single and multi-datasource setup, `url`, `schema`, per-source semantic paths
- `auth` — mode configuration
- `tools` — tool array, custom tool registration
- `plugins` — plugin array with config
- `rls` — RLS policies (single column, multi-policy, per-table). Show `column`, `claim`, `table` fields
- `actions` — defaults and per-action overrides (`approvalMode`, `roleRequired`)
- `semanticLayer` — custom path
- `rateLimiting` — per-datasource rate limits
- Full example config with multiple datasources, plugins, and RLS

**Cross-link to:** `/docs/getting-started/connect-your-data` (datasource setup), `/docs/deployment/authentication` (auth modes)

### 5. `guides/slack.mdx` — Slack Integration

**Sections:**
- Overview — what Atlas does in Slack (slash command, thread follow-ups)
- Single-workspace setup (simple: just `SLACK_BOT_TOKEN` + `SLACK_SIGNING_SECRET`)
- Multi-workspace OAuth setup (`SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, install/callback URLs)
- Slack app manifest — what scopes and event subscriptions are needed
- Slash command (`/atlas <question>`) — how it works, response format
- Thread follow-ups — how replies in a thread continue the conversation
- Environment variables reference (all Slack-related vars)
- Deployment notes — URL configuration, HTTPS requirements

### 6. `guides/scheduled-tasks.mdx` — Scheduled Tasks

**Sections:**
- Overview — recurring queries delivered via email, Slack, or webhook
- Enable (`ATLAS_ACTIONS_ENABLED=true`, `ATLAS_SCHEDULER_ENABLED=true`)
- Task definition — cron expression, question, delivery channel, format
- Backends — `bun` (in-process), `webhook` (external cron), `vercel` (Vercel Cron). When to use each
- Delivery channels — email (Resend setup), Slack (requires Slack integration), webhook (payload format)
- Environment variables reference (all `ATLAS_SCHEDULER_*` vars, `RESEND_API_KEY`, `ATLAS_EMAIL_FROM`)
- Execution model — tick loop, concurrency limits, timeouts, failure handling

### 7. `guides/admin-console.mdx` — Admin Console

**Sections:**
- Overview — what it is, how to access (`/admin/*`, requires `admin` role)
- Prerequisites — managed auth enabled, admin user exists
- Dashboard — what's shown on the main admin page
- Pages walkthrough — describe each admin page and what it does. Read the actual `packages/web/src/app/admin/` files to determine what pages exist
- Permissions — only admin role can access

### 8. `guides/actions.mdx` — Actions Framework

**Sections:**
- Overview — approval-gated write operations the agent can perform
- Enable (`ATLAS_ACTIONS_ENABLED=true`)
- Approval modes — `auto`, `manual`, `admin-only`. What each means
- Built-in action types — read the code to find what actions exist (JIRA, email, Slack, webhook, etc.)
- Action lifecycle — pending → approved/denied → executed/failed
- Role requirements — which roles can approve
- Configuration via `atlas.config.ts` — `actions.defaults`, per-action overrides
- Building custom actions — reference the plugin authoring guide for action plugins

**Cross-link to:** `/docs/plugins/authoring-guide` (action plugin type), `/docs/reference/config`

### 9. `guides/python.mdx` — Python Data Analysis

**Sections:**
- Overview — sandboxed Python execution for data analysis and charting
- Enable (`ATLAS_PYTHON_ENABLED=true`)
- Available libraries — what's importable (pandas, numpy, matplotlib, plotly, etc.) and what's blocked
- Chart rendering — how charts appear in the chat UI, supported chart types
- Sandbox backends — which sandbox backend runs Python (nsjail, sidecar, Vercel). Reference sandbox architecture
- Environment variables (`ATLAS_PYTHON_ENABLED`, `ATLAS_PYTHON_TIMEOUT`)
- Security model — import guards, no filesystem writes, no network, no shell

**Cross-link to:** `/docs/architecture/sandbox`

### 10. `guides/mcp.mdx` — MCP Server

**Sections:**
- Overview — what MCP is, what Atlas exposes (tools: explore, executeSQL; resources: semantic layer)
- Quick setup — `atlas mcp` or `bun run mcp`
- Claude Desktop — JSON config snippet for `claude_desktop_config.json`
- Cursor — settings configuration
- Other MCP clients — generic stdio setup
- SSE transport — for containerized/remote setups
- Available tools — `explore` (read semantic layer), `executeSQL` (validated query)
- Available resources — entity files, glossary, metrics as MCP resources
- Environment variables — same as the main Atlas server (provider, datasource, etc.)

**Cross-link to:** `/docs/reference/cli#mcp`

### 11. `guides/troubleshooting.mdx` — Troubleshooting

**Sections:**
- `atlas doctor` — what it checks, how to interpret output
- Common startup errors — read `startup.ts` for validation checks (missing provider, missing datasource URL, invalid config)
- Connection issues — PostgreSQL SSL, MySQL timeouts, ClickHouse connection refused. Common fixes
- SQL validation errors — query rejected (DML detected, table not in whitelist, parse failure). What each means
- Sandbox issues — nsjail not found, sidecar unreachable, permission denied
- Auth issues — 401 responses, JWKS fetch failures, CORS with managed auth
- Debug logging — `ATLAS_LOG_LEVEL=debug`, what to look for in logs
- Getting help — GitHub Issues link

---

## Navigation update

Update `apps/docs/content/docs/meta.json` to:

```json
{
  "title": "Docs",
  "pages": [
    "---Getting Started---",
    "getting-started/quick-start",
    "getting-started/connect-your-data",
    "getting-started/semantic-layer",
    "getting-started/demo-datasets",
    "---Guides---",
    "guides/mcp",
    "guides/slack",
    "guides/python",
    "guides/scheduled-tasks",
    "guides/actions",
    "guides/admin-console",
    "guides/troubleshooting",
    "---Deployment---",
    "deployment/deploy",
    "deployment/authentication",
    "---Frameworks---",
    "frameworks/overview",
    "frameworks/react-vite",
    "frameworks/nuxt",
    "frameworks/sveltekit",
    "frameworks/tanstack-start",
    "---Security---",
    "security/sql-validation",
    "---Reference---",
    "reference/environment-variables",
    "reference/cli",
    "reference/config",
    "reference/sdk",
    "reference/api",
    "---Plugins---",
    "plugins/authoring-guide",
    "---Architecture---",
    "architecture/sandbox",
    "---",
    "roadmap"
  ]
}
```

## Index update

Update `apps/docs/content/docs/index.mdx` to include links to all new pages in the appropriate sections. Add a new "Guides" section between "Frameworks" and "Plugins" with links to MCP, Slack, Python, Scheduled Tasks, Actions, Admin Console, and Troubleshooting. Add SDK and API Reference to the existing "Reference" section. Add Semantic Layer to the "Getting Started" section.

---

## Rules

- **Read source code first** — Every page must be based on what the code actually does, not guesses. Read the files listed in the source-of-truth table.
- **No fabrication** — If a feature doesn't exist in the code, don't document it. If you're unsure about a detail, check the code.
- **Cross-link generously** — Link to related pages. Link to env var reference for specific variables. Link to CLI reference for commands.
- **Keep it DRY** — Don't duplicate the env vars reference. Say "see [Environment Variables](/docs/reference/environment-variables)" and list only the key vars inline.
- **Match existing tone** — Read `authentication.mdx` and `connect-your-data.mdx` as tone references. Direct, practical, code-heavy.
- **Create directories** — `apps/docs/content/docs/guides/` doesn't exist yet. Create it.
- **Run quality checks** — `bun run type` and `bun run lint` must pass before done.
