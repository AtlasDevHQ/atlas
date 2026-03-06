# Atlas

Deploy-anywhere text-to-SQL data analyst agent. Ask natural language questions, get validated SQL and interpreted results.

Built with Hono, Vercel AI SDK, and bun. Supports Anthropic, OpenAI, Bedrock, Ollama, and Vercel AI Gateway. Works with PostgreSQL and MySQL.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FAtlasDevHQ%2Fatlas-starter-vercel&project-name=atlas&repository-name=atlas&products=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D&env=AI_GATEWAY_API_KEY,BETTER_AUTH_SECRET,ATLAS_DEMO_DATA&envDescription=AI_GATEWAY_API_KEY%3A%20Vercel%20AI%20Gateway%20key%20(vercel.com%2F~%2Fai%2Fapi-keys).%20BETTER_AUTH_SECRET%3A%20Random%20string%2C%2032%2B%20chars%20(openssl%20rand%20-base64%2032).%20ATLAS_DEMO_DATA%3A%20Set%20to%20%22true%22%20for%20demo%20data%20or%20leave%20empty.)
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/from-repo?repo=AtlasDevHQ%2Fatlas-starter-railway)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/AtlasDevHQ/atlas-starter-render)

**Docker:**

```bash
git clone https://github.com/AtlasDevHQ/atlas-starter-docker.git && cd atlas-starter-docker
cp .env.example .env   # Set your API key + database URL
docker compose up
```

## Quick Start

The fastest way to start:

```bash
bun create @useatlas my-app
```

The interactive setup asks for your template, database, LLM provider, and API key.

### Manual setup

Clone the repo and pick a database:

**PostgreSQL (with Docker):**

```bash
bun install
bun run db:up                         # Start local Postgres + seed demo data
cp .env.example .env                  # Set ATLAS_PROVIDER + API key + ATLAS_DATASOURCE_URL
bun run dev                           # http://localhost:3000
```

## How It Works

1. User asks a natural language question
2. Agent explores the **semantic layer** (YAML files describing your schema)
3. Agent writes SQL, validated through a multi-layer security pipeline (empty check, regex, AST parse, table whitelist, auto-LIMIT, statement timeout)
4. Results are returned with interpreted narrative

The semantic layer is auto-generated from your database:

```bash
bun run atlas -- init              # Profile DB and generate YAMLs
bun run atlas -- init --enrich     # Profile + LLM enrichment
bun run atlas -- init --demo       # Load demo data + profile
```

## Monorepo Structure

```
atlas/
├── packages/
│   ├── api/              # @atlas/api — Hono API server + all backend logic + shared types
│   ├── web/              # @atlas/web — Next.js frontend + chat UI components
│   ├── cli/              # @atlas/cli — CLI (profiler, schema diff, enrichment)
│   ├── mcp/              # @atlas/mcp — MCP server (Claude Desktop, Cursor, etc.)
│   ├── sdk/              # @useatlas/sdk — TypeScript SDK for the Atlas API
│   ├── plugin-sdk/       # @useatlas/plugin-sdk — Type definitions & helpers for plugins
│   └── sandbox-sidecar/  # @atlas/sandbox-sidecar — Isolated explore sidecar
├── plugins/         # Atlas plugins (datasource, context, interaction, action, sandbox)
├── examples/
│   ├── docker/              # Self-hosted: Hono API + Docker + optional nsjail
│   └── nextjs-standalone/   # Full stack: Next.js + embedded Hono API (Vercel)
├── create-atlas/    # Scaffolding CLI (bun create @useatlas)
├── semantic/        # Semantic layer (YAML on disk)
└── scripts/         # Dev scripts (db-up.sh, start.sh)
```

## Deployment

| Platform | Starter | Guide |
|----------|---------|-------|
| Vercel | [atlas-starter-vercel](https://github.com/AtlasDevHQ/atlas-starter-vercel) | Next.js + embedded Hono API + Neon Postgres |
| Railway | [atlas-starter-railway](https://github.com/AtlasDevHQ/atlas-starter-railway) | Docker + sidecar sandbox + Railway Postgres |
| Render | [atlas-starter-render](https://github.com/AtlasDevHQ/atlas-starter-render) | Docker + sidecar sandbox + Render Postgres |
| Docker | [atlas-starter-docker](https://github.com/AtlasDevHQ/atlas-starter-docker) | Docker Compose + optional nsjail isolation |

See [Deploy options](docs/guides/deploy.md) for detailed instructions.

## Security

Atlas is designed to be safe by default. All SQL is validated through a multi-layer pipeline (regex guard, AST parse, table whitelist, auto-LIMIT, statement timeout) — only SELECT queries against tables defined in your semantic layer are allowed.

The explore tool (filesystem access to semantic YAML files) runs in a sandbox that auto-detects the best available isolation:

| Platform | Sandbox | Isolation |
|----------|---------|-----------|
| Vercel | Firecracker microVM | Hardware-level (strongest) |
| Self-hosted Docker | nsjail (Linux namespaces) | Kernel-level |
| Railway, Render | Sidecar service | Process-level |
| Local dev | just-bash + OverlayFS | Path-traversal protection |

**If you're deploying Atlas for your own team** on a private network, any tier is fine — you're protecting against prompt injection edge cases, not hostile tenants. **If you're running multi-tenant**, use Vercel or nsjail-capable platforms for real isolation.

Secrets (database credentials, API keys) never enter the sandbox. The agent accesses the database through scoped tools, not raw connection strings.

See [sandbox architecture](docs/design/sandbox-architecture.md) for the full threat model and design.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ATLAS_PROVIDER` | `anthropic` (`gateway` on Vercel) | LLM provider (`anthropic`, `openai`, `bedrock`, `ollama`, `gateway`) |
| `ATLAS_MODEL` | Provider default | Model ID override |
| `DATABASE_URL` | -- | Atlas internal Postgres (`postgresql://...`) for auth, audit, settings |
| `ATLAS_DATASOURCE_URL` | -- | Analytics datasource — PostgreSQL (`postgresql://...`) or MySQL (`mysql://...`) |
| `ATLAS_ROW_LIMIT` | `1000` | Max rows per query |
| `ATLAS_QUERY_TIMEOUT` | `30000` | Query timeout in ms (PostgreSQL and MySQL) |

See [`.env.example`](.env.example) for all options.

## Documentation

- [Quick Start](docs/guides/quick-start.md) -- Local dev from zero to asking questions
- [Deploy options](docs/guides/deploy.md) -- Docker, Render, Railway, and more
- [Bring Your Own DB](docs/guides/bring-your-own-db.md) -- Connect to an existing database safely
- [Bring Your Own Frontend](docs/guides/byof/overview.md) -- Nuxt, SvelteKit, React/Vite, TanStack Start
- [Plugin Authoring](docs/guides/plugin-authoring-guide.md) -- Build custom plugins
- [Security & Sandbox Architecture](docs/design/sandbox-architecture.md) -- Threat model, isolation tiers, platform capabilities

## Acknowledgments

Atlas was inspired by [Abhi Sivasailam](https://x.com/_abhisivasailam)'s work on Vercel's internal data agent **d0** and the open-source [vercel-labs/oss-data-analyst](https://github.com/vercel-labs/oss-data-analyst) template. The core insight — invest in a rich semantic layer on the filesystem, trust the model, and keep the tool surface minimal — came from that work. The four-bucket taxonomy (Stores of Data, Stores of Context, Systems of Interaction, Systems of Action) directly shaped Atlas's plugin architecture.

Atlas is a ground-up rewrite that extends those ideas with a plugin SDK, multi-database support, sandboxed execution, auth, an admin console, scheduled tasks, and deploy-anywhere packaging.

## License

MIT
