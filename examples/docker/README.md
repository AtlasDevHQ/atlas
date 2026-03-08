# Atlas Docker Deployment

Self-hosted Hono API server with optional nsjail isolation, running as a single-process Docker container. Pair with [`examples/nextjs-standalone/`](../nextjs-standalone/) for a full-stack setup with a frontend.

## Architecture

```
                  ┌─────────────────────────────────┐
                  │         Docker Container         │
                  │                                  │
 HTTP clients ──►│  :3001  Hono API Server          │ ◄──── Postgres
                  │         (nsjail isolation)       │
                  │                                  │
                  └─────────────────────────────────┘
```

- **Hono API** (:3001) — Agent loop, SQL validation, semantic layer, auth

## Quick Start (Local Dev)

From the repo root:

```bash
bun install
bun run db:up                    # Start local Postgres
bun run dev:api                  # Starts Hono API on :3001
```

## Deploy

### Docker

From the repo root:

```bash
docker build -f examples/docker/Dockerfile -t atlas .
docker run -p 3001:3001 \
  -e ATLAS_PROVIDER=anthropic \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e ATLAS_DATASOURCE_URL=postgresql://user:pass@host:5432/dbname \
  atlas
```

### Docker Compose (with Postgres)

```bash
docker compose -f examples/docker/docker-compose.yml up
```

### Railway

**One-click deploy** — use the marketplace templates:

<!-- TODO: replace slugs with actual Railway template URLs after publishing -->
- [Atlas Demo](https://railway.com/template/atlas-demo) — seeded demo data, just add your API key
- [Atlas](https://railway.com/template/atlas) — connect your own PostgreSQL or MySQL database

**Manual setup:**

1. Create a new Railway project and add a **Postgres** plugin
2. Connect your repo — Railway picks up `examples/docker/railway.json`
3. Set environment variables:
   - `ATLAS_PROVIDER` + API key (e.g. `ANTHROPIC_API_KEY`)
   - `ATLAS_DATASOURCE_URL` — your analytics database

See [Railway Templates](https://docs.useatlas.dev/docs/deployment/railway-template) for full template configuration details.

## Environment Variables

See [`.env.example`](../../.env.example) for all options. Key variables:

| Variable | Description |
|----------|-------------|
| `ATLAS_PROVIDER` | LLM provider (anthropic, openai, bedrock, ollama, gateway) |
| `ATLAS_DATASOURCE_URL` | Analytics database connection string |
| `DATABASE_URL` | Atlas internal Postgres for auth/audit |
| `ATLAS_API_KEY` | Simple API key for authentication (optional) |

## Disabling nsjail

To build without nsjail (smaller image, no process isolation):

```bash
docker build --build-arg INSTALL_NSJAIL=false -f examples/docker/Dockerfile -t atlas .
```

## Adding a Frontend

This example is API-only. For a full-stack deployment with a web UI, see [`examples/nextjs-standalone/`](../nextjs-standalone/) (Next.js + embedded API, deploys to Vercel).
