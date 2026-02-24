# Atlas

Deploy-anywhere text-to-SQL data analyst agent. Ask natural language questions, get validated SQL and interpreted results.

Built with Next.js 16, Vercel AI SDK, and bun. Supports Anthropic, OpenAI, Bedrock, Ollama, and Vercel AI Gateway. Works with both PostgreSQL and SQLite.

## Quick Start

The fastest way to start:

```bash
bun create atlas my-app
```

The interactive setup asks for your database (SQLite or PostgreSQL), LLM provider, and API key. SQLite is the default — zero setup, no Docker required.

### Manual setup

Clone the repo and pick a database:

**SQLite (no Docker needed):**

```bash
bun install
bun run atlas -- init --demo          # Creates SQLite DB + seeds demo data + generates semantic layer
bun run dev                           # http://localhost:3000
```

Set your LLM provider in `.env`:

```bash
cp .env.example .env
# Edit .env: set ATLAS_PROVIDER + API key
```

**PostgreSQL (with Docker):**

```bash
bun install
bun run db:up                         # Start local Postgres + seed demo data
cp .env.example .env                  # Set ATLAS_PROVIDER + API key + DATABASE_URL
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
bun run atlas -- init --demo       # Load demo data + profile (SQLite or Postgres)
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ATLAS_PROVIDER` | `anthropic` | LLM provider (`anthropic`, `openai`, `bedrock`, `ollama`, `gateway`) |
| `ATLAS_MODEL` | Provider default | Model ID override |
| `DATABASE_URL` | -- | PostgreSQL (`postgresql://...`) or SQLite (`file:./data/atlas.db`) |
| `ATLAS_ROW_LIMIT` | `1000` | Max rows per query |
| `ATLAS_QUERY_TIMEOUT` | `30000` | Query timeout in ms (PostgreSQL only) |

See [`.env.example`](.env.example) for all options.

## Documentation

- [Quick Start](docs/quick-start.md) -- Local dev from zero to asking questions
- [Deploy to Vercel](docs/deploy.md#quick-deploy-vercel) -- Zero to production in 5 minutes
- [Deploy to Railway](docs/deploy.md#quick-deploy-railway) -- Includes managed Postgres
- [All deploy options](docs/deploy.md) -- Docker, Fly.io, Render, and more
- [Bring Your Own DB](docs/bring-your-own-db.md) -- Connect to an existing database safely
- [Roadmap](ROADMAP.md)

## License

MIT
