# Deploy Guides

Atlas ships a multi-stage `Dockerfile` that produces a standalone Next.js build. It runs on any Docker-capable platform. This guide covers Docker, Railway, Fly.io, Render, and Vercel.

---

## Quick Deploy: Vercel

Go from zero to production in 5 minutes.

1. **Scaffold your project:**

```bash
bun create atlas my-app
cd my-app
```

2. **Push to GitHub:**

```bash
git init && git add -A && git commit -m "Initial commit"
gh repo create my-app --public --source=. --push
```

3. **Import in Vercel:** Open the [Vercel Dashboard](https://vercel.com/), click **Add New > Project**, and import your repo. Vercel auto-detects Next.js via `vercel.json`.

4. **Set environment variables** in the Vercel project settings:

```
ATLAS_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=postgresql://user:pass@host:5432/dbname
```

5. **Deploy.** Vercel builds and deploys automatically.

6. **Verify:** `https://<your-app>.vercel.app/api/health` -- should return `{"status":"ok"}`

**What happens automatically on Vercel:**

- The explore tool uses `@vercel/sandbox` instead of `just-bash` when the `VERCEL` env var is present (no config needed)
- `output: "standalone"` is auto-skipped on Vercel (see `next.config.ts` -- the `VERCEL` env var check)
- `maxDuration` is already set to 60s in the chat API route
- `pg` and `just-bash` are in `serverExternalPackages` for serverless compatibility

For more details, see the [full Vercel section](#vercel) below.

---

## Quick Deploy: Railway

Go from zero to production with managed Postgres included.

1. **Scaffold your project:**

```bash
bun create atlas my-app
cd my-app
```

2. **Push to GitHub:**

```bash
git init && git add -A && git commit -m "Initial commit"
gh repo create my-app --public --source=. --push
```

3. **Create a Railway project:** Go to the [Railway Dashboard](https://railway.app/) and click **New Project**.

4. **Add a Postgres plugin:** Click **+ New** inside the project and add **Database > PostgreSQL**. Link it to your web service -- Railway injects `DATABASE_URL` automatically.

5. **Connect your repo:** Click **+ New > GitHub Repo** and select your repo. Railway detects `railway.json` and builds from the Dockerfile.

6. **Set environment variables** in the Railway service settings (only 2 -- `DATABASE_URL` is already set):

```
ATLAS_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

7. **Seed your data.** Either seed the demo dataset or generate a semantic layer from your own tables:

```bash
# Option A: Demo data
psql "$RAILWAY_DATABASE_URL" < data/demo.sql

# Option B: Your own data
DATABASE_URL="$RAILWAY_DATABASE_URL" bun run atlas -- init
```

8. **Deploy.** Railway builds and starts the container automatically.

9. **Verify:** `https://<your-app>.up.railway.app/api/health` -- should return `{"status":"ok"}`

**What happens automatically on Railway:**

- `DATABASE_URL` is injected by the Postgres plugin -- no manual config needed
- `railway.json` configures Dockerfile builds, health checks, and restart policy
- The Docker `HEALTHCHECK` polls `/api/health` every 30 seconds

For more details, see the [full Railway section](#railway) below.

---

## Required environment variables

Every deployment needs these three:

| Variable | Example |
|----------|---------|
| `ATLAS_PROVIDER` | `anthropic` |
| Provider API key | `ANTHROPIC_API_KEY=sk-ant-...` |
| `DATABASE_URL` | `postgresql://user:pass@host:5432/dbname` |

Optional variables (safe defaults for most deployments):

| Variable | Default | Description |
|----------|---------|-------------|
| `ATLAS_MODEL` | Provider default | Override the LLM model |
| `ATLAS_ROW_LIMIT` | `1000` | Max rows returned per query |
| `ATLAS_QUERY_TIMEOUT` | `30000` | Query timeout in ms |
| `PORT` | `3000` | Set automatically by most platforms |

## Health check

All deployments should verify with the health endpoint:

```
GET /api/health
```

Returns JSON with status `"ok"`, `"degraded"`, or `"error"` and sub-checks for database connectivity, provider configuration, and semantic layer presence. Returns HTTP 200 when status is `"ok"` or `"degraded"`, and HTTP 503 when status is `"error"` (database unreachable).

---

## Docker

The `Dockerfile` uses a three-stage build: install deps, build Next.js standalone output, then run with a minimal image.

### Build and run

```bash
docker build -t atlas .
docker run -p 3000:3000 \
  -e ATLAS_PROVIDER=anthropic \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e DATABASE_URL=postgresql://user:pass@host:5432/dbname \
  atlas
```

### Verify

```bash
curl http://localhost:3000/api/health
```

The Dockerfile includes a built-in `HEALTHCHECK` that polls `/api/health` every 30 seconds.

### Notes

- The image is based on `oven/bun:1.3`
- Standalone output copies only what's needed: `.next/standalone`, `.next/static`, `public/`, and `semantic/`
- The semantic layer (`semantic/`) is baked into the image at build time. If you update YAMLs, rebuild the image

---

## Railway

Railway auto-detects the `Dockerfile` via `railway.json` at the repo root.

### Steps

1. Create a new Railway project
2. Add a **Postgres** plugin (or use an external database)
3. Connect your GitHub repo -- Railway detects `railway.json` and builds from the Dockerfile
4. Set environment variables in the Railway dashboard:

```
ATLAS_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=<Railway-provided Postgres URL>
```

5. If using the demo dataset, seed the database:

```bash
# Connect to the Railway Postgres and run the seed file
psql "$RAILWAY_DATABASE_URL" < data/demo.sql
```

Or generate a semantic layer from your own data:

```bash
DATABASE_URL="$RAILWAY_DATABASE_URL" bun run atlas -- init
```

6. Deploy -- Railway builds and starts the container automatically

### Configuration

The `railway.json` config sets:

- Dockerfile-based builds
- Health check at `/api/health` with a 60-second timeout
- Restart on failure (max 10 retries)

### Verify

Railway exposes a public URL. Check health at `https://<your-app>.up.railway.app/api/health`.

---

## Fly.io

Atlas includes a `fly.toml` at the repo root.

### Steps

1. Install the [Fly CLI](https://fly.io/docs/flyctl/install/)

2. Launch the app (without deploying yet):

```bash
fly launch --no-deploy
```

3. Set secrets:

```bash
fly secrets set \
  DATABASE_URL="postgresql://user:pass@host:5432/dbname" \
  ANTHROPIC_API_KEY="sk-ant-..."
```

4. Deploy:

```bash
fly deploy
```

### Using Fly Postgres

To use Fly's managed Postgres instead of an external database:

```bash
fly postgres create --name atlas-db
fly postgres attach atlas-db
```

Fly automatically sets `DATABASE_URL` when you attach. Seed the demo data:

```bash
fly postgres connect --app atlas-db
# Then in the psql shell, paste contents of data/demo.sql
```

### Configuration

The `fly.toml` configures:

- Region: `iad` (US East) -- change `primary_region` for your location
- Health check: `GET /api/health` every 30 seconds
- Auto-stop/start machines (scales to zero when idle)
- VM: `shared-cpu-1x` with 512 MB memory

### Verify

```bash
fly status
curl https://<your-app>.fly.dev/api/health
```

---

## Render

Atlas includes a `render.yaml` Blueprint at the repo root.

### Steps

1. Go to the [Render Dashboard](https://dashboard.render.com/) and click **New > Blueprint**
2. Connect your GitHub repo -- Render reads `render.yaml`
3. Set the prompted environment variables:
   - `DATABASE_URL` -- your Postgres connection string
   - `ANTHROPIC_API_KEY` -- your API key
4. Deploy

### Using Render Postgres

1. Create a Render Postgres instance from the dashboard
2. Copy the **Internal Connection String**
3. Set it as `DATABASE_URL` in the Atlas service environment

### Configuration

The `render.yaml` configures:

- Docker-based deployment using the repo's `Dockerfile`
- Health check at `/api/health`
- Starter plan
- `ATLAS_PROVIDER` defaults to `anthropic`
- `autoDeploy` is disabled -- trigger deploys manually from the Render dashboard, or set `autoDeploy: true` in `render.yaml` to deploy on every push

### Verify

```bash
curl https://<your-app>.onrender.com/api/health
```

---

## Vercel

Atlas supports Vercel-native deployment. On Vercel, the explore tool uses `@vercel/sandbox` instead of `just-bash` for shell operations.

### Steps

1. Import your repo in the [Vercel Dashboard](https://vercel.com/)
2. Vercel auto-detects Next.js via `vercel.json` (framework: `nextjs`)
3. Set environment variables:

```
ATLAS_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=postgresql://user:pass@host:5432/dbname
```

4. Deploy

### Notes

- Vercel is auto-detected via the `VERCEL` environment variable -- no manual `ATLAS_RUNTIME` setting needed
- The `output: "standalone"` build option is skipped on Vercel (Vercel uses its own build pipeline)
- `@vercel/sandbox` is an optional dependency and only loaded when running on Vercel
- `pg` and `just-bash` are listed in `serverExternalPackages` in `next.config.ts` for compatibility with serverless functions

### Verify

```bash
curl https://<your-app>.vercel.app/api/health
```
