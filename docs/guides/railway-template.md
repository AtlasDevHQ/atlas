# Railway Marketplace Templates for Atlas

Two Railway marketplace templates deploy from the same repo and Dockerfile. The difference is environment variables only.

## Prerequisites

- A [Railway](https://railway.com) account
- A GitHub repo: `AtlasDevHQ/atlas`
- An Anthropic API key

## Template 1: "Atlas Demo"

One-click deploy with seeded demo data. User only provides an Anthropic API key.

### Setup in Railway Dashboard

1. **Create a new template** at [railway.com/templates/new](https://railway.com/templates/new)
2. **Add a Postgres service** — use Railway's managed Postgres plugin
3. **Add a GitHub service** pointing to `AtlasDevHQ/atlas`

### Service Configuration (GitHub Service)

- **Root directory**: leave empty (builds from repo root)
- **Config path**: `examples/docker/railway.json`

### Environment Variables

| Variable | Value | User prompted? |
|----------|-------|----------------|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | No |
| `ATLAS_DATASOURCE_URL` | `${{Postgres.DATABASE_URL}}` | No |
| `ATLAS_SEED_DEMO` | `true` | No |
| `ATLAS_PROVIDER` | `anthropic` | No |
| `ANTHROPIC_API_KEY` | — | Yes |
| `BETTER_AUTH_SECRET` | `${{secret(32)}}` | No (auto-generated) |
| `ATLAS_TRUST_PROXY` | `true` | No |
| `NODE_ENV` | `production` | No |

Both `DATABASE_URL` and `ATLAS_DATASOURCE_URL` point to the same Railway Postgres. Internal tables (`audit_log`, `user`, `session`, `account`, `verification`) and demo tables (`companies`, `people`, `accounts`) coexist without name collisions.

### Template Overview

**Name**: Atlas Demo

**Description**: One-click text-to-SQL data analyst agent with demo data. Ask natural language questions about companies, people, and accounts. Powered by Claude.

## Template 2: "Atlas"

Production deploy. User provides their API key + their own database URL. No demo data — the internal Postgres is only for auth and audit.

### Setup in Railway Dashboard

1. **Create a new template** at [railway.com/templates/new](https://railway.com/templates/new)
2. **Add a Postgres service** — for Atlas internals (auth, audit). This is *not* the user's analytics database
3. **Add a GitHub service** pointing to `AtlasDevHQ/atlas`

### Service Configuration (GitHub Service)

Same as Template 1:

- **Root directory**: leave empty
- **Config path**: `examples/docker/railway.json`

### Environment Variables

| Variable | Value | User prompted? | Description shown to user |
|----------|-------|----------------|---------------------------|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | No | — |
| `ATLAS_DATASOURCE_URL` | — | Yes | `PostgreSQL or MySQL connection string for your analytics database (e.g. postgresql://user:pass@host:5432/dbname)` |
| `ATLAS_PROVIDER` | `anthropic` | No | — |
| `ANTHROPIC_API_KEY` | — | Yes | `Your Anthropic API key (starts with sk-ant-)` |
| `BETTER_AUTH_SECRET` | `${{secret(32)}}` | No | — |
| `ATLAS_TRUST_PROXY` | `true` | No | — |
| `NODE_ENV` | `production` | No | — |

No `ATLAS_SEED_DEMO` — the user's own database is the analytics datasource.

### Template Overview

**Name**: Atlas

**Description**: Text-to-SQL data analyst agent. Connect your own database.

**Detailed description** (if Railway supports a longer body):

> Deploy-anywhere text-to-SQL data analyst agent. Connect your own PostgreSQL or MySQL database, define a semantic layer, and ask natural language questions. Powered by Claude.

### Post-deploy: Semantic Layer

The Docker image bundles a demo semantic layer at `/app/semantic/` (companies/people/accounts). For BYOD deployments, the agent will boot but queries won't match the user's schema until a proper semantic layer is generated.

This is a known gap — future versions will auto-generate the semantic layer on first boot when the bundled layer doesn't match the connected database.

## How Demo Seeding Works

When `ATLAS_SEED_DEMO=true`, the start script (`scripts/start.sh`) runs `seed-demo.ts` before launching the API and client:

1. Connects to `ATLAS_DATASOURCE_URL` with a 10s timeout
2. Checks if the `companies` table exists in `public` schema
3. If not, executes `/app/data/demo.sql` (bundled in the Docker image)
4. Retries up to 5 times with 3s intervals (Railway Postgres may need a moment to become ready)
5. Non-blocking: the app starts even if seeding fails

The seed script is idempotent — running it multiple times is safe.

## Troubleshooting

### Health check fails after deploy

The health check hits `/api/health` on the API port. Common causes:

- **Postgres not ready yet**: Railway Postgres can take 10-30s to provision. The app will retry connections. Wait for the next health check cycle.
- **Missing API key**: Check that `ANTHROPIC_API_KEY` is set.
- **Wrong datasource URL**: For Template 2, verify `ATLAS_DATASOURCE_URL` is a valid PostgreSQL or MySQL connection string.

### Demo data not appearing

- Check deploy logs for `seed-demo:` messages
- Verify `ATLAS_SEED_DEMO=true` is set
- Verify `ATLAS_DATASOURCE_URL` points to a Postgres database (demo seeding only supports Postgres)

### Semantic layer doesn't match my database

The Docker image bundles the demo semantic layer at `/app/semantic/` (companies, people, accounts). For Template 2 (BYOD), queries will fail until you generate a semantic layer matching your schema. See [Post-deploy: Semantic Layer](#post-deploy-semantic-layer) above.

### Connection timeouts

- Ensure Railway's internal networking allows connections between services
- For external databases (Template 2), verify the database allows connections from Railway's IP ranges
- Check `ATLAS_QUERY_TIMEOUT` if queries are timing out (default: 30s)
