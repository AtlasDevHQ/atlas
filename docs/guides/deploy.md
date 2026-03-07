# Deploy Guides

Atlas provides two example deployment topologies plus a static landing page. Deploy configs live in `examples/` and `apps/`, not at the repo root.

| Example | What's included | Use when |
|---------|----------------|----------|
| [`examples/docker/`](../examples/docker/) | Hono API + Docker + optional nsjail | Self-hosted deployment (Railway, Docker Compose) |
| [`examples/nextjs-standalone/`](../examples/nextjs-standalone/) | Next.js + embedded Hono API | You want to deploy to Vercel with zero infrastructure |
| [`apps/www/`](../apps/www/) | Static landing page (Next.js export + Bun server) | Marketing site at useatlas.dev |

See each example's README for architecture details and quick start instructions.

### Production subdomain topology (useatlas.dev)

| Subdomain | Source | Platform | What's running |
|-----------|--------|----------|----------------|
| `useatlas.dev` | `apps/www` | Railway (NIXPACKS) | Bun static server (`serve.ts`) |
| `app.useatlas.dev` | `packages/web` + Hono API | Railway (Docker) | Next.js + Hono API |
| `demo.useatlas.dev` | `examples/docker` | Railway (Docker) | Hono API |
| `next.useatlas.dev` | `examples/nextjs-standalone` | Vercel | Next.js + embedded Hono API |

---

## Quick Deploy: Railway

Go from zero to production with managed Postgres included.

1. **Scaffold your project:**

```bash
bun create @useatlas my-app
cd my-app
```

2. **Push to GitHub:**

```bash
git init && git add -A && git commit -m "Initial commit"
gh repo create my-app --public --source=. --push
```

3. **Create a Railway project:** Go to the [Railway Dashboard](https://railway.app/) and click **New Project**.

4. **Add a Postgres plugin:** Click **+ New** inside the project and add **Database > PostgreSQL**. Link it to your web service -- Railway injects `DATABASE_URL` automatically (this becomes Atlas's internal database).

5. **Connect your repo:** Click **+ New > GitHub Repo** and select your repo. Railway detects `railway.json` in `examples/docker/` and builds from the Dockerfile.

6. **Set environment variables** in the Railway service settings (`DATABASE_URL` is already set by the Postgres plugin):

```
ATLAS_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ATLAS_DATASOURCE_URL=postgresql://user:pass@your-analytics-host:5432/mydb
```

> `DATABASE_URL` (auto-set by Railway) is Atlas's internal Postgres. `ATLAS_DATASOURCE_URL` is the analytics database you want to query.

7. **Seed your data.** Choose a demo dataset or generate a semantic layer from your own tables:

```bash
# Option A: Simple demo (3 tables, ~330 rows)
psql "$ATLAS_DATASOURCE_URL" < data/demo.sql

# Option B: Cybersec SaaS demo (62 tables, ~500K rows)
psql "$ATLAS_DATASOURCE_URL" < data/cybersec.sql

# Option C: Your own data
ATLAS_DATASOURCE_URL="$ATLAS_DATASOURCE_URL" bun run atlas -- init
```

8. **Deploy.** Railway builds and starts the container automatically.

9. **Verify:** `https://<your-app>.up.railway.app/api/health` -- should return `{"status":"ok"}`

**What happens automatically on Railway:**

- `DATABASE_URL` is injected by the Postgres plugin (used as Atlas's internal DB)
- `railway.json` configures Dockerfile builds, health checks, and restart policy
- The Docker `HEALTHCHECK` polls `/api/health` every 30 seconds

For more details, see the [full Railway section](#railway) below.

---

## Required environment variables

Every deployment needs these:

| Variable | Example | Purpose |
|----------|---------|---------|
| `ATLAS_PROVIDER` | `anthropic` | LLM provider |
| Provider API key | `ANTHROPIC_API_KEY=sk-ant-...` | Authentication for LLM |
| `ATLAS_DATASOURCE_URL` | `postgresql://...` or `mysql://...` | Analytics database to query |
| `DATABASE_URL` | `postgresql://atlas:atlas@host:5432/atlas` | Atlas internal Postgres (auth, audit) — auto-set on most platforms |

Optional variables (safe defaults for most deployments):

| Variable | Default | Description |
|----------|---------|-------------|
| `ATLAS_MODEL` | Provider default | Override the LLM model |
| `ATLAS_ROW_LIMIT` | `1000` | Max rows returned per query |
| `ATLAS_QUERY_TIMEOUT` | `30000` | Query timeout in ms |
| `PORT` | `3000` | Set automatically by most platforms |

### Authentication (optional)

Auth is opt-in. Set one of these to enable:

| Variable | Auth mode | Description |
|----------|-----------|-------------|
| `ATLAS_API_KEY` | Simple key | Single shared key, validated via `Authorization: Bearer <key>` |
| `BETTER_AUTH_SECRET` | Managed | Full user management (email/password). Min 32 chars. Requires `DATABASE_URL` |
| `ATLAS_AUTH_JWKS_URL` | BYOT | Stateless JWT verification against an external JWKS endpoint |

Additional auth variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `ATLAS_AUTH_ISSUER` | — | Required with BYOT: expected JWT `iss` claim |
| `ATLAS_AUTH_AUDIENCE` | — | Optional with BYOT: expected JWT `aud` claim |
| `BETTER_AUTH_URL` | auto-detect | Base URL for Better Auth (recommended for production) |
| `ATLAS_RATE_LIMIT_RPM` | disabled | Max requests per minute per user (0 or unset = disabled) |
| `ATLAS_TRUST_PROXY` | `false` | Trust `X-Forwarded-For`/`X-Real-IP` for client IP. Set to `true` behind a reverse proxy |

When no auth vars are set, Atlas runs in open-access mode (identical to pre-v0.5 behavior). See [auth-design.md](auth-design.md) for details.

## Security & Isolation

Atlas runs agent-generated commands (filesystem exploration, future code execution) in a sandboxed environment. The level of isolation depends on your deployment platform — Atlas auto-detects the best available option and falls back gracefully.

### Sandbox tiers

| Tier | Backend | Platforms | Isolation level |
|------|---------|-----------|-----------------|
| 1 | Vercel Sandbox | Vercel | Firecracker microVM (hardware-level). No network, ephemeral filesystem |
| 2 | nsjail | Self-hosted Docker/VM | Linux namespaces. No network, read-only mount, separate PID/user space |
| 3 | Sidecar service | Railway | Separate container with no secrets. Process-level isolation via private networking |
| 4 | just-bash | Everywhere (fallback) | In-memory OverlayFS + path-traversal protection. No process isolation |

### What's right for you?

**Self-hosted for your own team** — You're deploying Atlas behind a VPN or with API key auth, and all users are employees. Any tier works. Even just-bash is reasonable — the explore tool only reads YAML files, and all SQL is validated through 4 security layers (regex, AST parse, table whitelist, auto-LIMIT). You're defending against prompt injection edge cases, not hostile tenants.

**Public-facing or multi-tenant** — Users from different organizations query through the same Atlas instance. Use Tier 1 (Vercel) or Tier 2 (nsjail on self-hosted Docker/VM). These provide real process/VM isolation so one user's request can't affect another's.

### What Atlas already does regardless of tier

These protections are always active, independent of the sandbox:

- **SQL is SELECT-only** — INSERT, UPDATE, DELETE, DROP, and all other mutations are blocked by AST-level validation
- **Table whitelist** — Only tables defined in the semantic layer are queryable
- **Secrets never enter the sandbox** — The explore tool runs with `PATH`, `HOME`, `LANG` only. No database credentials, no API keys
- **Auto-LIMIT** — Every query gets a row limit (default 1000) and statement timeout (default 30s)
- **Read-only filesystem** — The explore tool can only read `semantic/*.yml` files, never write

### Overriding the auto-detected tier

```bash
ATLAS_SANDBOX=nsjail       # Enforce nsjail (hard fail if unavailable)
ATLAS_SANDBOX_URL=http://sandbox:8080  # Use a sidecar service (planned)
```

The health endpoint (`GET /api/health`) reports which backend is active in the `explore.backend` field.

For the full sandbox architecture and threat model, see [sandbox-architecture-design.md](sandbox-architecture-design.md).

## Health check

All deployments should verify with the health endpoint:

```
GET /api/health
```

Returns JSON with status `"ok"`, `"degraded"`, or `"error"` and sub-checks for datasource connectivity, provider configuration, semantic layer presence, auth mode, and internal DB status. Returns HTTP 200 when status is `"ok"` or `"degraded"`, and HTTP 503 when status is `"error"` (database unreachable). The health endpoint is always public (no auth required).

---

## Docker

### Self-hosted (Docker)

The `examples/docker/Dockerfile` builds a single-process container with the Hono API server and optional nsjail isolation.

```bash
docker build -f examples/docker/Dockerfile -t atlas .
docker run -p 3001:3001 \
  -e ATLAS_PROVIDER=anthropic \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e ATLAS_DATASOURCE_URL=postgresql://user:pass@host:5432/dbname \
  atlas
```

To build without nsjail (smaller image, no process isolation):

```bash
docker build --build-arg INSTALL_NSJAIL=false -f examples/docker/Dockerfile -t atlas .
```

### Verify

```bash
curl http://localhost:3001/api/health
```

The Dockerfile includes a built-in `HEALTHCHECK` that polls `/api/health` every 30 seconds.

### Notes

- Images are based on `oven/bun:1.3`
- The semantic layer (`semantic/`) must be generated before building — run `atlas init` locally first. It gets baked into the image at build time; rebuild if you update YAMLs

---

## Railway

Railway auto-detects the `Dockerfile` via `railway.json` in the example directory.

### Steps

1. Create a new Railway project
2. Add a **Postgres** plugin (or use an external database)
3. Connect your GitHub repo -- Railway detects `examples/docker/railway.json` and builds from the Dockerfile
4. Set environment variables in the Railway dashboard:

```
ATLAS_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ATLAS_DATASOURCE_URL=postgresql://user:pass@your-analytics-host:5432/mydb
```

> Railway auto-sets `DATABASE_URL` via the Postgres plugin (Atlas internal DB). You only need to add `ATLAS_DATASOURCE_URL` for the analytics database.

5. Seed the database (choose one):

```bash
# Option A: Simple demo (3 tables, ~330 rows)
psql "$ATLAS_DATASOURCE_URL" < data/demo.sql

# Option B: Cybersec SaaS demo (62 tables, ~500K rows)
psql "$ATLAS_DATASOURCE_URL" < data/cybersec.sql

# Option C: Your own data (skip seeding, just generate semantic layer)
ATLAS_DATASOURCE_URL="$ATLAS_DATASOURCE_URL" bun run atlas -- init
```

6. Deploy -- Railway builds and starts the container automatically

### Configuration

The `examples/docker/railway.json` config sets:

- Dockerfile-based builds with `dockerfileContext: "../.."`
- Health check at `/api/health` with a 60-second timeout
- Restart on failure (max 10 retries)

### Verify

Railway exposes a public URL. Check health at `https://<your-app>.up.railway.app/api/health`.

---

## Vercel

Atlas provides a Next.js standalone example that embeds the Hono API via a catch-all route — deploy to Vercel with zero infrastructure. The explore tool automatically uses Vercel Sandbox (Firecracker VM isolation) when running on Vercel.

### Scaffold a new project

```bash
bun create @useatlas my-app --platform vercel
cd my-app
```

### Deploy from the monorepo

1. Import your repo in the [Vercel Dashboard](https://vercel.com/new)
2. Set **Root Directory** to `examples/nextjs-standalone`
3. Set environment variables:

```
# Option A: Vercel AI Gateway (recommended — single key, built-in observability)
ATLAS_PROVIDER=gateway
AI_GATEWAY_API_KEY=...           # Create at https://vercel.com/~/ai/api-keys

# Option B: Direct provider
ATLAS_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Required for both options
ATLAS_DATASOURCE_URL=postgresql://user:pass@host:5432/dbname
DATABASE_URL=postgresql://user:pass@host:5432/atlas
```

4. Deploy — `vercel.json` declares the Next.js framework for Vercel

### Configuration notes

- **`@vercel/sandbox`** — Auto-detected on Vercel via the `VERCEL` env var. The explore tool runs bash commands in a Firecracker microVM with `networkPolicy: "deny-all"` — no network access, ephemeral filesystem
- **AI Gateway** — `ATLAS_PROVIDER=gateway` routes through [Vercel's AI Gateway](https://vercel.com/docs/ai-gateway). Uses a single `AI_GATEWAY_API_KEY` to access Claude, GPT, and other major providers with usage tracking in the Vercel dashboard
- **`serverExternalPackages`** — `pg`, `mysql2`, `just-bash`, `pino`, `pino-pretty` are excluded from bundling (native bindings / worker threads)
- **`maxDuration`** — The catch-all route sets `maxDuration = 60` for multi-step agent loops. Increase based on your [Vercel plan](https://vercel.com/docs/functions/configuring-functions/duration) for complex queries that need more steps
- **No `output: "standalone"`** — Vercel uses its own build pipeline

### Semantic layer on Vercel

The `vercel.json` build command copies the demo semantic layer from `packages/cli/data/demo-semantic` into the project at build time (same approach the Docker builds use). For your own data, replace this with your generated semantic layer files.

### Verify

```bash
curl https://<your-app>.vercel.app/api/health
```

---

## Landing Page (apps/www)

The marketing site at `useatlas.dev` is a Next.js static export served by a lightweight Bun static file server. No nginx, no Docker.

### Architecture

```
Next.js (output: "export") → static HTML/CSS/JS in out/
Bun.serve() (serve.ts) → serves out/ with security headers + /health endpoint
Railway (NIXPACKS) → builds with bun, starts serve.ts
```

### Deploy to Railway

1. Connect your GitHub repo in Railway
2. Railway detects `apps/www/railway.json` — NIXPACKS builder
3. Build: `bun install && bun run --filter '@atlas/www' build`
4. Start: `cd apps/www && bun serve.ts`
5. No environment variables required (static site, no API calls)

### Local development

```bash
bun run dev:www    # http://localhost:3002 (Turbopack dev server)
bun run build:www  # Produces apps/www/out/
```

### Configuration

- **`serve.ts`** — Bun static file server with security headers (`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`), `/health` endpoint, and proper 404 responses
- **`railway.json`** — NIXPACKS builder, health check at `/health`, restart on failure
- **`PORT`** — Configurable via environment (default 8080)

### Verify

```bash
curl https://useatlas.dev/health
```
