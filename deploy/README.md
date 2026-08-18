# deploy/ — AtlasDevHQ Infrastructure

Production deployment configs for AtlasDevHQ's Railway project (`satisfied-creation`). These are **not** end-user templates — those live in `examples/`.

## Services

| Service | Subdomain | Directory | Description |
|---------|-----------|-----------|-------------|
| API | `api.useatlas.dev` | `deploy/api/` | Hono standalone server + nsjail sandbox |
| Web | `app.useatlas.dev` | `deploy/web/` | Next.js query UI + admin console |
| WWW | `useatlas.dev` | `deploy/www/` | Static landing page (Nixpacks, serves `apps/www/out/`) |
| Postgres | (internal) | — | Railway-managed database |

> The **Sidecar** service (Explore isolation container, formerly deploy/sidecar/) was
> dropped in [#2387](https://github.com/AtlasDevHQ/atlas/issues/2387) — Vercel Sandbox is the
> sole SaaS sandbox backend. Three things in this file still describe it as live and are
> kept only because they remain true for **self-hosted** deployments, where the sidecar is
> a supported backend (`packages/sandbox-sidecar`, `SIDECAR_AUTH_TOKEN` in `.env.example`):
> the architecture diagram below, the `ATLAS_SANDBOX_URL` line in the API service's env
> list, and the `### Sidecar service (internal)` section. **None of them describes anything
> Railway runs.** Read this file's env lists as "what a deployment may set", not as the
> prod inventory.

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
- `ATLAS_CORS_ORIGIN` — No longer stamped: its default derives from `ATLAS_API_REGION` + the `residency.regions[].apiUrl` map (#3706), and it's a runtime registry setting (Admin → Security). Set explicitly only to override.
- `BETTER_AUTH_SECRET` — min 32 chars
- `BETTER_AUTH_TRUSTED_ORIGINS=https://app.useatlas.dev` — Read before config in Better Auth init, so it stays env. Also the web origin `getWebOrigin()` reads first (anchors the passkey rpID + CORS default).
- `ATLAS_SANDBOX_URL` — Internal sidecar URL
- `ATLAS_API_REGION` — Region identity for this instance. **Must be a key in the `residency.regions` map** in `deploy/api/atlas.config.ts` (`us` / `eu` / `apac` / `staging`) — not a free-form value. Required for multi-region deployments. Each regional API service (api, api-eu, api-apac) must set this so the health endpoint reports its region, misrouting detection works, and the per-region origin derivation (`ATLAS_PUBLIC_API_URL` / web origin, #3706) resolves; a value absent from the map silently no-ops the derivation

#### Replica cap (read before scaling)

Each regional API service is **pinned to `numReplicas: 1`** via `multiRegionConfig` in its `railway.json`. This is intentional, not aspirational.

- **Why**: hosted MCP sessions live in the API process's memory (`Map<sessionId, SessionEntry>` at `packages/mcp/src/hosted.ts`). Frames after `initialize` carry an `mcp-session-id` header that must arrive at the same replica that handled init — otherwise the lookup misses and the response is `404 unknown_session`, breaking the agent's connection mid-conversation. The in-process **Query Cache** (`packages/api/src/lib/cache/`) is a second in-memory-per-replica store that assumes the cap: its hit/miss stats and admin flush are per-process, so multiple replicas would report and flush only their own slice.
- **Also assumes the cap — the periodic brain fibers**: neither has leader election, so each replica would run its own copy of the same tick. Two consequences, both cost rather than correctness. (a) The **audience re-verify scan** (`lib/brain/audience/reverify.ts`) stamps `attempted_at` on SELECTION with no `FOR UPDATE`/`SKIP LOCKED`, and its `ORDER BY` is deterministic — so every replica selects the *same* page and issues the *same* vendor calls. Membership stays correct (the reconcile is idempotent), but Zoom/Graph quota is spent R times for 1× the coverage. (b) The **extraction fiber**'s quarantine ledger (`lib/brain/extract.ts`) is an in-memory `Map`, so each replica runs its own failure ramp and every model-spend figure in that module reads as ×R. (c) The **Slack membership walk** in that same fiber (`audience/sync.ts`) duplicates for the same reason — each replica reads every install's directory and every private channel's roster, up to `MAX_ROSTER_PAGES` each, against the same Slack rate limit.

If you lift the cap, the cheapest correct fix for (a) is to make the existing `attempted_at` stamp the *claim* — but the claim has to be established by the **write**, not the read. Selecting rows whose stamp predates the cycle and then stamping them does *not* serialise under READ COMMITTED: both replicas' `SELECT` runs before either commits, so both see the same page and both proceed to spend the vendor calls. Narrow the UPDATE instead — `TOUCH_REVERIFY_ATTEMPT_SQL` with `WHERE … attempted_at < $cycleStart RETURNING audience_id` — and trim each replica's page to the ids that actually came back. The loser gets an empty set and skips. Still no new lock and no migration.
- **Why not just turn on sticky sessions**: Railway's HTTP load balancer does not support cookie-based or IP-hash session affinity ([docs.railway.com — scaling](https://docs.railway.com/reference/scaling): "Railway does not support sticky sessions"). For multi-replica services, traffic is randomly distributed; Atlas's per-region API services scale horizontally by adding regions, not replicas-within-region.
- **What to do if you genuinely need horizontal scale**: ship the fallback flagged in #2069 — move MCP session state from in-process Map to the existing internal Postgres (the `oauthProvider` plugin already uses internal DB; reusing it for sessions is a small refactor). Until that lands, raising `numReplicas` will silently break every active MCP session on every load-balancer reroute.
- **Verification monitor (staged, not yet provisioned)**: a per-region multi-step OpenStatus synthetic is specified at [`docs/guides/openstatus-mcp-monitor.md`](../docs/guides/openstatus-mcp-monitor.md) and gets provisioned the moment the OpenStatus Starter-tier upgrade in [#1936](https://github.com/AtlasDevHQ/atlas/issues/1936) lands (free tier is at the 1-monitor cap). Until then, the contract is held only by the integration test (`e2e/integration/mcp-multi-replica.test.ts`) and the `numReplicas: 1` cap above — a manual scale-up will silently break MCP sessions and there is no production page until #1936 ships. Read the spec doc before lifting the cap.

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
