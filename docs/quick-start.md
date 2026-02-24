# Quick Start

Get Atlas running locally in under 5 minutes.

## Prerequisites

- [Bun](https://bun.sh/) v1.3+
- [Docker](https://docs.docker.com/get-docker/) (for the local Postgres instance)
- An LLM API key (Anthropic, OpenAI, or another [supported provider](../.env.example))

## 1. Clone and install

```bash
git clone <your-repo-url> atlas
cd atlas
bun install
```

## 2. Start the database

```bash
bun run db:up
```

This launches a `postgres:16-alpine` container via Docker Compose. It auto-seeds a demo dataset with:

- **50 companies** (industry, revenue, valuation, employee count)
- **~200 people** (department, seniority, title, start date)
- **80 accounts** (plan, status, monthly value, contract dates)

The schema is defined in `data/demo.sql`.

## 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set these two values:

```bash
DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
ATLAS_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

Replace the API key with your own. For other providers, see `.env.example`.

## 4. Start the dev server

```bash
bun run dev
```

Atlas starts on [http://localhost:3000](http://localhost:3000) with Turbopack for fast reloads.

## 5. Ask your first question

Open [http://localhost:3000](http://localhost:3000) in your browser. The chat UI shows suggested starter questions derived from the semantic layer. Try one of these:

- "How many companies are there by industry?"
- "What is the average revenue across all companies?"
- "Which departments have the most people?"

The agent will explore the semantic layer YAMLs, write validated SQL, execute it against your database, and return an interpreted answer.

## Using your own database

To connect Atlas to your own Postgres database instead of the demo:

1. Set `DATABASE_URL` in `.env` to your connection string
2. Generate a semantic layer from your schema:

```bash
bun run atlas -- init
```

This profiles every table in the `public` schema and generates YAML files under `semantic/`.

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
