# Atlas — Next.js Standalone (Vercel)

A single Next.js app that embeds the Atlas API via a catch-all route. Deploy to Vercel with zero infrastructure.

## Architecture

```
Next.js App (single Vercel project)
├── /api/*  → catch-all route → @atlas/api (Hono)
└── /       → Chat UI (React)
```

The API and frontend run in the same Next.js process. No separate API server, no rewrites, no cross-origin configuration needed.

### Vercel-native features

- **Vercel Sandbox** — The explore tool runs in a Firecracker microVM (`@vercel/sandbox`) with `networkPolicy: "deny-all"`. Auto-detected on Vercel via the `VERCEL` env var
- **AI Gateway** — Use `ATLAS_PROVIDER=gateway` with a single `AI_GATEWAY_API_KEY` to route through [Vercel's AI Gateway](https://vercel.com/docs/ai-gateway). Supports Claude, GPT, and other major providers with built-in observability
- **maxDuration** — The catch-all route sets `maxDuration = 60`. Increase based on your [Vercel plan](https://vercel.com/docs/functions/configuring-functions/duration) for complex multi-step queries
- **serverExternalPackages** — `pg`, `mysql2`, `just-bash`, `pino`, `pino-pretty` are excluded from bundling (native bindings / worker threads)

## Quick Start (monorepo)

```bash
cd examples/nextjs-standalone
cp ../../.env .env   # or create your own with ATLAS_DATASOURCE_URL + ATLAS_PROVIDER + API key
bun run dev
```

Open http://localhost:3000 — health check at http://localhost:3000/api/health.

## Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FAtlasDevHQ%2Fatlas&project-name=atlas&repository-name=atlas&root-directory=examples/nextjs-standalone&products=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D&env=AI_GATEWAY_API_KEY,BETTER_AUTH_SECRET,ATLAS_DEMO_DATA&envDescription=AI_GATEWAY_API_KEY%3A%20Vercel%20AI%20Gateway%20key%20(vercel.com%2F~%2Fai%2Fapi-keys).%20BETTER_AUTH_SECRET%3A%20Random%20string%2C%2032%2B%20chars%20(openssl%20rand%20-base64%2032).%20ATLAS_DEMO_DATA%3A%20Set%20to%20%22true%22%20for%20demo%20data%20or%20leave%20empty.)

The deploy button provisions a Neon Postgres database and configures AI Gateway automatically. You'll be asked for:

- **`AI_GATEWAY_API_KEY`** — Your Vercel AI Gateway key ([create one here](https://vercel.com/~/ai/api-keys))
- **`BETTER_AUTH_SECRET`** — Random string, 32+ chars (run `openssl rand -base64 32`)
- **`ATLAS_DEMO_DATA`** — Set to `true` to seed demo data into the Neon DB, or leave empty to connect your own database

When `ATLAS_DEMO_DATA=true`, the build step seeds demo data (companies, people, accounts) into the Neon database and uses it as both the internal DB and analytics datasource. The demo semantic layer is copied at build time.

See [docs/guides/deploy.md](../../docs/guides/deploy.md#vercel) for full instructions.

**Live deployment:** [next.useatlas.dev](https://next.useatlas.dev)

### Connecting your own database

Set `ATLAS_DATASOURCE_URL` in your Vercel project env vars to point at your analytics database. The Neon DB (via `DATABASE_URL`) is still used for Atlas internals (auth, audit, conversations).

```
ATLAS_DATASOURCE_URL=postgresql://user:pass@host:5432/dbname   # Analytics DB (read-only)
```

When `ATLAS_DATASOURCE_URL` is set, it always takes priority over the Neon fallback. You'll also need to generate a semantic layer for your schema (`bun run atlas -- init`).

### Build pipeline

The `vercel.json` `buildCommand` runs three steps:

1. Copies the demo semantic layer into the project
2. Seeds demo data into Neon (if `ATLAS_DEMO_DATA=true`, otherwise skips)
3. Runs `next build`

## Scaffold a standalone project

```bash
bun create @useatlas my-app --platform vercel
```
