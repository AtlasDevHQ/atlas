<h1 align="center">Atlas</h1>

<p align="center">
  Atlas is a YAML-defined semantic layer for analytics — authored by humans, consumed by AI agents.
</p>

<p align="center">
  <a href="https://github.com/AtlasDevHQ/atlas/actions/workflows/ci.yml"><img src="https://github.com/AtlasDevHQ/atlas/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@useatlas/sdk"><img src="https://img.shields.io/npm/v/@useatlas/sdk" alt="npm"></a>
  <a href="https://github.com/AtlasDevHQ/atlas/blob/main/LICENSE"><img src="https://img.shields.io/github/license/AtlasDevHQ/atlas" alt="License"></a>
</p>

<p align="center">
  <a href="https://docs.useatlas.dev">Documentation</a> · <a href="https://app.useatlas.dev">Live Demo</a> · <a href="https://docs.useatlas.dev/semantic-layer">The Semantic Layer</a> · <a href="https://docs.useatlas.dev/guides/mcp">MCP Guide</a> · <a href="https://github.com/AtlasDevHQ/atlas/issues">Issues</a>
</p>

<p align="center">
  <img src="assets/demo.svg" alt="Atlas terminal demo — create, init, and query in under 30 seconds" width="820">
</p>

---

## What is Atlas?

Atlas turns a directory of YAML files into a complete semantic layer for analytics — entities, dimensions, measures, joins, virtual dimensions, query patterns, glossary terms, and authoritative metrics. Humans author the YAML. AI agents consume it through the **Model Context Protocol (MCP)** to answer business questions in natural language, with deterministic, validated, read-only SQL.

Every YAML field exists because an LLM needs it to write correct SQL: `sample_values` ground the agent in real data, `glossary.status: ambiguous` forces clarifying questions, `metrics.objective` picks `MAX` vs `MIN`, `query_patterns` teach the canonical join shapes for your domain.

Built with Hono, Vercel AI SDK, and bun. Supports Anthropic, OpenAI, Bedrock, Ollama, and Vercel AI Gateway. Works with PostgreSQL, MySQL, ClickHouse, Snowflake, DuckDB, BigQuery, and Salesforce.

## Install Atlas as an MCP server (the lead path)

Add Atlas to Claude Desktop, Cursor, or Continue with one command. Auto-detects the client and falls back to a bundled demo fixture when no datasource is configured:

```bash
bunx @useatlas/mcp init --local            # print paste-ready config
bunx @useatlas/mcp init --local --write    # merge into the detected client config (with a .bak)
```

Restart Claude Desktop / Cursor and ask one of the canonical questions:

- *"What's our GMV this quarter?"*
- *"What's our top-performing category by GMV this month?"*
- *"Monthly GMV trend over the past 6 months."*
- *"Show me revenue last quarter."* — Atlas asks which definition you mean (GMV vs. net revenue vs. seller revenue) because `revenue` is `status: ambiguous` in the glossary
- *"What are our most common return reasons?"*

The agent reads your YAML semantic layer first, picks the right entities, writes SQL, runs it through the validation pipeline, and returns answers with the underlying SQL on display. See the [MCP guide](https://docs.useatlas.dev/guides/mcp) for the full flow. Hosted MCP at `mcp.useatlas.dev` is in development — tracked in [#2024](https://github.com/AtlasDevHQ/atlas/issues/2024).

## What's in the YAML?

A 20-line slice of `semantic/entities/orders.yml` from the bundled NovaMart e-commerce demo (#2021):

```yaml
name: Orders
type: fact_table
table: orders
grain: one row per order
description: |
  Customer orders — the primary fact table for revenue analysis.
  shipping_cost uses MIXED UNITS (some rows in dollars, some in cents).
dimensions:
  - name: status
    sql: status
    type: string
    sample_values: [pending, processing, shipped, delivered, cancelled]
  - name: order_month
    sql: TO_CHAR(created_at, 'YYYY-MM')
    type: string
    virtual: true
measures:
  - name: total_gmv_cents
    sql: total_cents
    type: sum
joins:
  - target_entity: Customers
    relationship: many_to_one
    join_columns: { from: customer_id, to: id }
```

That YAML is the contract between your team and the agent — version-controlled, code-reviewed, diffable. Sibling files (`glossary.yml`, `metrics/*.yml`, `catalog.yml`) round it out: glossary terms with `status: ambiguous` force the agent to clarify, metrics with `objective: maximize` / `minimize` make optimization direction explicit, and the catalog routes the agent to the right entity for a given question.

See the full [Semantic Layer reference](https://docs.useatlas.dev/getting-started/semantic-layer) for the complete schema.

## Try the demo locally

```bash
bun create atlas-agent my-app --demo
cd my-app && bun run dev
# Open http://localhost:3000
```

The `--demo` flag seeds the canonical NovaMart e-commerce dataset (52 tables, ~480K rows) — twelve generic e-commerce KPIs ship as starter prompts inside the chat UI; the canonical 5 above drive the eval harness ([#2025](https://github.com/AtlasDevHQ/atlas/issues/2025)) and the docs/landing copy.

## Embed in your app

Atlas also ships an embeddable chat widget for any frontend:

```html
<script
  src="https://your-atlas.example.com/widget.js"
  data-api-url="https://your-atlas.example.com"
  data-theme="dark"
></script>
```

Or use the React component:

```tsx
import { AtlasChat } from "@useatlas/react";

export default function App() {
  return <AtlasChat apiUrl="https://your-atlas.example.com" />;
}
```

The widget supports programmatic control (`Atlas.open()`, `Atlas.ask("...")`, `Atlas.destroy()`), event callbacks, and theming. See the [widget docs](https://docs.useatlas.dev/guides/embedding-widget).

## Why Atlas?

| | Atlas | Traditional BI | Other text-to-SQL |
|---|---|---|---|
| **Semantic layer** | YAML on disk — `query_patterns`, `virtual_dimensions`, `glossary.status: ambiguous`, `metrics.objective` are all first-class | Proprietary metadata, GUI-authored | None or limited |
| **Agent-native** | MCP server first — Claude Desktop, Cursor, Continue with `bunx @useatlas/mcp init` | Bolted-on AI feature | Standalone chat UI |
| **Embeddable** | Script tag, React component, headless API, MCP, Slack, Teams | Standalone app | Standalone app |
| **Deploy anywhere** | Docker, Railway, Vercel, or your own infra | Vendor-hosted | Vendor-hosted |
| **Plugin ecosystem** | 21 plugins across 5 types — extend anything | Closed | Limited |
| **Open source** | AGPL-3.0 core, MIT client libs | Proprietary | Varies |
| **Multi-database** | PostgreSQL, MySQL, ClickHouse, Snowflake, DuckDB, BigQuery, Salesforce | Usually one | Usually one |

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FAtlasDevHQ%2Fatlas-starter-vercel&project-name=atlas&repository-name=atlas&products=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D&env=AI_GATEWAY_API_KEY,BETTER_AUTH_SECRET&envDescription=AI_GATEWAY_API_KEY%3A%20Vercel%20AI%20Gateway%20key%20(vercel.com%2F~%2Fai%2Fapi-keys).%20BETTER_AUTH_SECRET%3A%20Random%20string%2C%2032%2B%20chars%20(openssl%20rand%20-base64%2032).)
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/_XHuNP?referralCode=N5vD3S)

**Docker:**

```bash
git clone https://github.com/AtlasDevHQ/atlas-starter-docker.git && cd atlas-starter-docker
cp .env.example .env   # Set your API key + database URL
docker compose up
```

| Platform | Starter | Guide |
|----------|---------|-------|
| Vercel | [atlas-starter-vercel](https://github.com/AtlasDevHQ/atlas-starter-vercel) | Next.js + embedded Hono API + Neon Postgres |
| Railway | [atlas-starter-railway](https://github.com/AtlasDevHQ/atlas-starter-railway) | Docker + sidecar sandbox + Railway Postgres |
| Docker | [atlas-starter-docker](https://github.com/AtlasDevHQ/atlas-starter-docker) | Docker Compose + optional nsjail isolation |

## How It Works

1. User (or agent) asks a natural language question — over MCP, the chat widget, the API, Slack, or Teams
2. Agent explores the **YAML semantic layer** — entities, glossary, metrics, query patterns
3. Agent writes SQL, validated through a multi-layer security pipeline (regex guard, AST parse, table whitelist, auto-LIMIT, statement timeout)
4. Results are returned with charts and an interpreted narrative

```
Question → YAML semantic layer → SQL generation → Multi-layer validation → Query execution → Charts + narrative
```

### Generate the semantic layer

```bash
bun run atlas -- init                 # Profile DB and generate YAMLs
bun run atlas -- init --enrich        # Profile + LLM enrichment
bun run atlas -- init --demo          # Load NovaMart demo data + profile
```

## Architecture

```
atlas/
├── packages/
│   ├── api/              # @atlas/api — Hono API server + agent loop + tools + auth
│   ├── web/              # @atlas/web — Next.js frontend + chat UI components
│   ├── cli/              # @atlas/cli — CLI (profiler, schema diff, enrichment)
│   ├── mcp/              # @atlas/mcp — MCP server (Claude Desktop, Cursor, etc.)
│   ├── sandbox-sidecar/  # @atlas/sandbox-sidecar — Isolated explore sidecar
│   ├── sdk/              # @useatlas/sdk — TypeScript SDK
│   ├── react/            # @useatlas/react — Embeddable chat component + hooks
│   ├── types/            # @useatlas/types — Shared wire-format types
│   ├── schemas/          # @useatlas/schemas — Shared Zod schemas
│   └── plugin-sdk/       # @useatlas/plugin-sdk — Plugin type definitions
├── plugins/              # 21 plugins (datasource, context, interaction, action, sandbox)
├── ee/                   # @atlas/ee — Enterprise features (source-available, commercial license)
├── create-atlas/         # Scaffolding CLI (bun create atlas-agent)
├── apps/
│   ├── www/              # Landing page (useatlas.dev)
│   └── docs/             # Documentation (docs.useatlas.dev)
└── examples/             # Docker + Vercel deploy examples
```

## Security

SQL validation runs through multiple layers. Your database credentials and query results never leave your infrastructure — only questions reach the LLM provider (use Ollama for fully self-hosted).

| Layer | What it does |
|-------|-------------|
| Read-only enforcement | Only SELECT queries allowed (regex + AST validation) |
| AST parsing | `node-sql-parser` verifies single-statement SELECT |
| Table whitelist | Only tables in your semantic layer are queryable |
| Auto LIMIT | Every query gets a LIMIT (default 1000) |
| Statement timeout | Queries killed after 30s (configurable) |
| Sandboxed execution | Filesystem access runs in nsjail / Firecracker / sidecar |
| Row-level security | Optional RLS injection per-user |

See [sandbox architecture](https://docs.useatlas.dev/architecture/sandbox) for the full threat model.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ATLAS_PROVIDER` | `anthropic` | LLM provider (`anthropic`, `openai`, `bedrock`, `ollama`, `gateway`) |
| `ATLAS_MODEL` | Provider default | Model ID override |
| `DATABASE_URL` | — | Atlas internal Postgres for auth, audit, settings |
| `ATLAS_DATASOURCE_URL` | — | Analytics datasource (PostgreSQL, MySQL, etc.) |
| `ATLAS_ROW_LIMIT` | `1000` | Max rows per query |
| `ATLAS_QUERY_TIMEOUT` | `30000` | Query timeout in ms |

See [`.env.example`](.env.example) for all options.

## Documentation

- [The Semantic Layer](https://docs.useatlas.dev/getting-started/semantic-layer) — Entities, dimensions, measures, joins, glossary, metrics — the YAML format reference
- [MCP Server](https://docs.useatlas.dev/guides/mcp) — Use Atlas from Claude Desktop, Cursor, Continue
- [Quick Start](https://docs.useatlas.dev/getting-started/quick-start) — Local dev from zero to asking questions
- [Demo Dataset](https://docs.useatlas.dev/getting-started/demo-datasets) — NovaMart e-commerce dataset and canonical questions
- [Deploy Options](https://docs.useatlas.dev/deployment/deploy) — Docker, Railway, Vercel, and more
- [Connect Your Data](https://docs.useatlas.dev/getting-started/connect-your-data) — Connect to an existing database safely
- [Widget Embedding](https://docs.useatlas.dev/guides/embedding-widget) — Script tag and React component
- [Bring Your Own Frontend](https://docs.useatlas.dev/frameworks/overview) — Nuxt, SvelteKit, React/Vite, TanStack Start
- [Plugin Authoring](https://docs.useatlas.dev/plugins/authoring-guide) — Build custom plugins
- [Security & Sandbox](https://docs.useatlas.dev/architecture/sandbox) — Threat model, isolation tiers
- [Enterprise Boundary](https://docs.useatlas.dev/architecture/enterprise) — `/ee` features, AGPL vs commercial split, `requireEnterprise` API

## Contributing

Quick development setup:

```bash
git clone https://github.com/AtlasDevHQ/atlas.git && cd atlas
bun install
bun run db:up         # Start Postgres + sandbox sidecar
cp .env.example .env  # Set ATLAS_PROVIDER + API key
bun run dev           # http://localhost:3000
```

## Acknowledgments

Atlas was inspired by [Abhi Sivasailam](https://x.com/_abhisivasailam)'s work on Vercel's internal data agent **d0** and the open-source [vercel-labs/oss-data-analyst](https://github.com/vercel-labs/oss-data-analyst) template. The core insight — invest in a rich semantic layer, trust the model, and keep the tool surface minimal — came from that work.

## License

The Atlas server and core packages (`@atlas/api`, `@atlas/cli`, `@atlas/web`, `@atlas/mcp`, `@atlas/sandbox-sidecar`) are licensed under [AGPL-3.0](LICENSE). If you modify the server and serve it to users, you must share those modifications.

The client libraries (`@useatlas/sdk`, `@useatlas/react`, `@useatlas/types`, `@useatlas/plugin-sdk`) and all plugins are licensed under [MIT](packages/sdk/LICENSE). Embed them in proprietary apps with no restrictions.

The `ee/` directory (`@atlas/ee` — SSO, SCIM, custom roles, approval workflows, residency, branding, and the rest of the SaaS surfaces) is **source-available** under a [commercial license](ee/LICENSE). Self-hosted users get the full AGPL core for free; the commercial license adds enterprise governance and the polished hosted experience. See the [Enterprise Boundary](https://docs.useatlas.dev/architecture/enterprise) page for the full feature inventory.
