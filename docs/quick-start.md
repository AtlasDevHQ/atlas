# Quick Start

Get Atlas running locally in under 5 minutes.

## Prerequisites

- [Bun](https://bun.sh/) v1.3+
- An LLM API key (Anthropic, OpenAI, or another [supported provider](../.env.example))
- Docker is **optional** — only needed for PostgreSQL. SQLite works out of the box.

## Option A: `bun create atlas-agent` (recommended)

```bash
bun create atlas-agent my-app
cd my-app
bun run dev
```

The interactive setup asks for your database, LLM provider, and API key. SQLite is the default — no Docker needed.

## Option B: Manual setup with SQLite

```bash
git clone <your-repo-url> atlas
cd atlas
bun install
```

Configure your LLM provider:

```bash
cp .env.example .env
```

Edit `.env`:

```bash
DATABASE_URL=file:./data/atlas.db
ATLAS_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

Load demo data, generate the semantic layer, and start:

```bash
bun run atlas -- init --demo         # Creates DB, seeds data, generates YAMLs
bun run dev                          # http://localhost:3000
```

## Option C: Manual setup with PostgreSQL

```bash
git clone <your-repo-url> atlas
cd atlas
bun install
bun run db:up
```

This launches a `postgres:16-alpine` container via Docker Compose. It auto-seeds a demo dataset with:

- **50 companies** (industry, revenue, valuation, employee count)
- **~200 people** (department, seniority, title, start date)
- **80 accounts** (plan, status, monthly value, contract dates)

Configure your environment:

```bash
cp .env.example .env
```

Edit `.env`:

```bash
DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
ATLAS_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

Generate the semantic layer and start:

```bash
bun run atlas -- init                # Profile DB and generate YAMLs
bun run dev                          # http://localhost:3000
```

## Ask your first question

Open [http://localhost:3000](http://localhost:3000) in your browser. The chat UI shows suggested starter questions derived from the semantic layer. Try one of these:

- "How many companies are there by industry?"
- "What is the average revenue across all companies?"
- "Which departments have the most people?"

The agent will explore the semantic layer YAMLs, write validated SQL, execute it against your database, and return an interpreted answer.

## Using your own database

To connect Atlas to your own database instead of the demo:

1. Set `DATABASE_URL` in `.env`:
   - PostgreSQL: `postgresql://user:pass@host:5432/dbname`
   - SQLite: `file:./path/to/your.db`
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
| `bun run dev` | Start dev server (port 3000, Turbopack) |
| `bun run build` | Production build |
| `bun run start` | Start production server |
| `bun run lint` | ESLint |
| `bun run type` | TypeScript type-check |
| `bun run test` | Run tests |
| `bun run db:up` | Start local Postgres |
| `bun run db:down` | Stop local Postgres |
| `bun run db:reset` | Nuke volume and re-seed from scratch |

## Next steps

- [Deploy to production](deploy.md)
- [Connect your own database](bring-your-own-db.md)
