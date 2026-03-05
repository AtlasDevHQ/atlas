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

See [docs/guides/deploy.md](../../docs/guides/deploy.md#vercel) for full instructions.

**Live deployment:** [next.useatlas.dev](https://next.useatlas.dev)

### Semantic layer at build time

The `vercel.json` `buildCommand` copies the demo semantic layer into the project before `next build`:

```json
"buildCommand": "cp -r ../../packages/cli/data/demo-semantic semantic && next build"
```

This is the same `demo-semantic` directory that Docker builds use. For your own data, replace with your generated semantic layer files or run `atlas init` before deploying.

### Connecting to an external database

This example connects to any PostgreSQL or MySQL database. Set these Vercel env vars:

```
ATLAS_DATASOURCE_URL=postgresql://user:pass@host:5432/dbname   # Analytics DB (read-only)
DATABASE_URL=postgresql://user:pass@host:5432/atlas            # Atlas internal DB (auth, audit)
```

The production deployment at `next.useatlas.dev` connects to Railway's PostgreSQL over the public TCP proxy.

## Scaffold a standalone project

```bash
bun create @useatlas my-app --platform vercel
```
