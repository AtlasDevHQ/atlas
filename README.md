# Atlas

Deploy-anywhere text-to-SQL data analyst agent. Ask natural language questions, get validated SQL and interpreted results.

Built with Next.js 16, Vercel AI SDK, and bun. Supports Anthropic, OpenAI, Bedrock, Ollama, and Vercel AI Gateway.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fmsywulak%2Fdata-agent&env=ATLAS_PROVIDER,ANTHROPIC_API_KEY,DATABASE_URL&envDescription=LLM+provider+config+and+Postgres+connection+string.+See+.env.example+for+all+options.&project-name=atlas&repository-name=atlas)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/msywulak/data-agent)
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/github?repo=https%3A%2F%2Fgithub.com%2Fmsywulak%2Fdata-agent)

Fly.io: `fly launch` from a clone (see [deploy guide](docs/deploy.md#flyio)).

Docker:
```bash
docker build -t atlas .
docker run -p 3000:3000 \
  -e ATLAS_PROVIDER=anthropic \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e DATABASE_URL=postgresql://user:pass@host:5432/dbname \
  atlas
```

## Quick Start

```bash
bun install
bun run db:up                    # Start local Postgres + seed demo data
cp .env.example .env             # Set ATLAS_PROVIDER + API key + DATABASE_URL
bun run dev                      # http://localhost:3000
```

Or scaffold a new project:

```bash
bun create atlas my-app
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
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ATLAS_PROVIDER` | `anthropic` | LLM provider (`anthropic`, `openai`, `bedrock`, `ollama`, `gateway`) |
| `ATLAS_MODEL` | Provider default | Model ID override |
| `DATABASE_URL` | -- | PostgreSQL connection string |
| `ATLAS_ROW_LIMIT` | `1000` | Max rows per query |
| `ATLAS_QUERY_TIMEOUT` | `30000` | Query timeout in ms |

See [`.env.example`](.env.example) for all options.

## Documentation

- [Quick Start](docs/quick-start.md) -- Local dev from zero to asking questions
- [Deploy Guide](docs/deploy.md) -- Railway, Fly.io, Render, Docker, Vercel
- [Bring Your Own DB](docs/bring-your-own-db.md) -- Connect to an existing database safely
- [Roadmap](ROADMAP.md)

## License

MIT
