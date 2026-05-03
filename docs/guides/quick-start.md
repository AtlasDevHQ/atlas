# Quick Start

Get Atlas running locally in under 5 minutes.

## Prerequisites

- [Bun](https://bun.sh/) v1.3+
- [Docker](https://docs.docker.com/get-docker/) — required for local PostgreSQL and sandbox sidecar (matches production setup)
- An LLM API key (Anthropic, OpenAI, or another [supported provider](../.env.example))

## Setup

```bash
git clone <your-repo-url> atlas
cd atlas
bun install
bun run db:up                        # Start Postgres + sandbox sidecar
```

This launches two containers via Docker Compose:
- **Postgres** (`postgres:16-alpine`) with two databases: `atlas` (internals) and `atlas_demo` (demo analytics data)
- **Sandbox sidecar** — isolated container for the explore tool (shell + Python execution), matching production isolation

> For a larger, production-like dataset, use `bun run atlas -- init --demo cybersec` instead. This loads a 62-table cybersecurity SaaS database (~500K rows) with realistic tech debt patterns.

Configure your environment:

```bash
cp .env.example .env
```

Edit `.env` — set your LLM provider (the database URLs are pre-configured for local Docker):

```bash
ATLAS_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

Generate the semantic layer and start:

```bash
bun run atlas -- init                # Profile DB and generate YAMLs
bun run dev                          # Start containers + dev servers → http://localhost:3000
```

> **New project scaffolding:** `bun create atlas-agent my-app` provides interactive setup with template selection, DB config, provider setup, and optional semantic layer generation.

## Ask your first question

Open [http://localhost:3000](http://localhost:3000) in your browser. The chat UI shows suggested starter questions derived from the semantic layer. Try one of these:

- "How many companies are there by industry?"
- "What is the average revenue across all companies?"
- "Which departments have the most people?"

The agent will explore the semantic layer YAMLs, write validated SQL, execute it against your database, and return an interpreted answer.

## Using your own database

To connect Atlas to your own database instead of the demo:

1. Set `ATLAS_DATASOURCE_URL` in `.env`:
   - PostgreSQL: `postgresql://user:pass@host:5432/dbname`
   - MySQL: `mysql://user:pass@host:3306/dbname`
2. Generate a semantic layer from your schema:

```bash
bun run atlas -- init
```

To profile only specific tables:

```bash
bun run atlas -- init --tables users,orders,products
```

To add LLM-enriched descriptions and query patterns (requires a configured API key):

```bash
bun run atlas -- init --enrich
```

See [Bring Your Own DB](bring-your-own-db.md) for production database setup including read-only users, SSL, and safety configuration.

## Useful commands

| Command | Description |
|---------|-------------|
| `bun run dev` | Start containers (Postgres + sidecar) + dev servers |
| `bun run build` | Production build |
| `bun run start` | Start production server |
| `bun run lint` | ESLint |
| `bun run type` | TypeScript type-check |
| `bun run test` | Run tests |
| `bun run db:up` | Start local Postgres + sandbox sidecar |
| `bun run db:down` | Stop containers |
| `bun run db:reset` | Nuke volume and re-seed from scratch |

## Next steps

- [Deploy to production](deploy.md)
- [Connect your own database](bring-your-own-db.md)
