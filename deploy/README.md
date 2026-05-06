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
- `ATLAS_API_REGION` — Region identity for this instance (e.g. `us-east`). Required for multi-region deployments. Each regional API service (api, api-eu, api-apac) must set this so the health endpoint reports its region and misrouting detection works correctly

#### Replica cap (read before scaling)

Each regional API service is **pinned to `numReplicas: 1`** via `multiRegionConfig` in its `railway.json`. This is intentional, not aspirational.

- **Why**: hosted MCP sessions live in the API process's memory (`Map<sessionId, SessionEntry>` at `packages/mcp/src/hosted.ts`). Frames after `initialize` carry an `mcp-session-id` header that must arrive at the same replica that handled init — otherwise the lookup misses and the response is `404 unknown_session`, breaking the agent's connection mid-conversation.
- **Why not just turn on sticky sessions**: Railway's HTTP load balancer does not support cookie-based or IP-hash session affinity ([docs.railway.com — scaling](https://docs.railway.com/reference/scaling): "Railway does not support sticky sessions"). For multi-replica services, traffic is randomly distributed; Atlas's per-region API services scale horizontally by adding regions, not replicas-within-region.
- **What to do if you genuinely need horizontal scale**: ship the fallback flagged in #2069 — move MCP session state from in-process Map to the existing internal Postgres (the `oauthProvider` plugin already uses internal DB; reusing it for sessions is a small refactor). Until that lands, raising `numReplicas` will silently break every active MCP session on every load-balancer reroute.
- **Verification monitor**: an OpenStatus synthetic monitor exercises sequential MCP frames against each regional API hostname and pages on `404 unknown_session`. If `numReplicas` ever drifts above 1 without the fallback, that monitor fires before users do.

### Web service (`app.useatlas.dev`)

- `NEXT_PUBLIC_ATLAS_API_URL=https://api.useatlas.dev` — Baked at build time
- `NEXT_PUBLIC_ATLAS_AUTH_MODE=managed` — Baked at build time, enables proxy route protection
- `PORT=3000`

### Sidecar service (internal)

- `SIDECAR_AUTH_TOKEN` — Shared secret (must match API service)
- `PORT=8080` (default)
- No public domain — only reachable by the API service via Railway private networking

### WWW service (`useatlas.dev`)

- No env vars required (static site)
- `PORT` — Set automatically by Railway
