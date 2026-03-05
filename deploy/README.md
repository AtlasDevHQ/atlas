# deploy/ — AtlasDevHQ Infrastructure

Production deployment configs for AtlasDevHQ's Railway project (`satisfied-creation`). These are **not** end-user templates — those live in `examples/`.

## Services

| Service | Subdomain | Directory | Description |
|---------|-----------|-----------|-------------|
| API | `api.useatlas.dev` | `deploy/api/` | Hono standalone server + nsjail sandbox |
| Web | `app.useatlas.dev` | `deploy/web/` | Next.js query UI + admin console |
| WWW | `useatlas.dev` | `deploy/www/` | Static landing page (Nixpacks, serves `apps/www/out/`) |
| Sidecar | (internal) | `deploy/sidecar/` | Explore isolation container (no public domain) |
| Postgres | (internal) | — | Railway-managed database |

## Architecture

```
                    ┌─────────────────┐
                    │   useatlas.dev   │
                    │    (apps/www)    │
                    └─────────────────┘

  ┌─────────────────┐         ┌─────────────────┐
  │ app.useatlas.dev │ ──────→│ api.useatlas.dev │
  │  (packages/web)  │  HTTP  │  (packages/api)  │
  └─────────────────┘         └────────┬─────────┘
                                       │
                              ┌────────┴─────────┐
                              │     Sidecar       │
                              │  (sandbox-sidecar) │
                              └────────┬─────────┘
                                       │
                              ┌────────┴─────────┐
                              │    PostgreSQL     │
                              └──────────────────┘
```

The web service talks to the API over HTTPS (`NEXT_PUBLIC_ATLAS_API_URL=https://api.useatlas.dev` baked at build time). No server-side rewrites needed.

## Building locally

```bash
# API
docker build -f deploy/api/Dockerfile -t atlas-api .

# Web
docker build -f deploy/web/Dockerfile -t atlas-web .
```

## Railway configuration

Each service points to its `railway.json` via the Railway dashboard. Key env vars:

### API service (`api.useatlas.dev`)

- `ATLAS_PROVIDER` / `ANTHROPIC_API_KEY` — LLM provider
- `DATABASE_URL` — Atlas internal Postgres (auth, audit)
- `ATLAS_DATASOURCE_URL` — Analytics datasource
- `ATLAS_CORS_ORIGIN=https://app.useatlas.dev`
- `BETTER_AUTH_SECRET` — min 32 chars
- `BETTER_AUTH_TRUSTED_ORIGINS=https://app.useatlas.dev`
- `ATLAS_SANDBOX_URL` — Internal sidecar URL

### Web service (`app.useatlas.dev`)

- `NEXT_PUBLIC_ATLAS_API_URL=https://api.useatlas.dev` — Baked at build time
- `PORT=3000`

### Sidecar service (internal)

- `SIDECAR_AUTH_TOKEN` — Shared secret (must match API service)
- `PORT=8080` (default)
- No public domain — only reachable by the API service via Railway private networking

### WWW service (`useatlas.dev`)

- No env vars required (static site)
- `PORT` — Set automatically by Railway
