# @useatlas/create

Deploy a text-to-SQL data analyst agent on your database in minutes. Ask natural language questions, get validated SQL and interpreted results.

**What you get:** A self-contained project with a chat UI, multi-layer SQL validation, auto-generated semantic layer from your schema, and deploy configs for Docker, Railway, and Vercel.

## Quick start

```bash
bun create @useatlas my-app
cd my-app
bun run dev
```

Open [http://localhost:3000](http://localhost:3000) and start asking questions about your data.

## Prerequisites

- [Bun](https://bun.sh/) 1.3+
- A database (PostgreSQL or MySQL)
- An LLM API key (Anthropic, OpenAI, AWS Bedrock, or Ollama for local models)

## Interactive setup

Running `bun create @useatlas my-app` walks you through each option:

| Prompt | Options | Default |
|--------|---------|---------|
| **Project name** | Any valid directory name | `my-atlas-app` |
| **Platform** | Docker, Railway, Vercel, Other | Docker |
| **Sandbox** | nsjail, Sidecar, E2B, Daytona, None (only for "Other" platform) | nsjail |
| **Database** | PostgreSQL, MySQL | PostgreSQL |
| **Connection string** | Your database URL | `postgresql://atlas:atlas@localhost:5432/atlas` |
| **LLM provider** | Anthropic, OpenAI, AWS Bedrock, Ollama, Vercel AI Gateway | Anthropic |
| **API key** | Your provider's API key | -- |
| **Model override** | Any model ID supported by your provider | Provider default |
| **Demo data** | Load a demo dataset (PostgreSQL only) | No |
| **Generate semantic layer** | Profile your database and generate YAML | No |

### Non-interactive mode

Skip all prompts with sensible defaults (PostgreSQL + Anthropic + Docker):

```bash
bun create @useatlas my-app --defaults
# or
bun create @useatlas my-app -y
```

### Platform flag

Skip the platform prompt:

```bash
bun create @useatlas my-app --platform vercel
bun create @useatlas my-app --platform railway
```

Available platforms: `vercel`, `railway`, `docker`, `other`

## Demo datasets

Atlas includes built-in demo datasets for PostgreSQL. The setup wizard offers to load one for you, or you can load them later with `bun run atlas -- init --demo`.

| Dataset | Tables | Rows | Description |
|---------|--------|------|-------------|
| **Simple** | 3 | ~330 | Companies, people, accounts. Quick start |
| **Cybersecurity SaaS** | 62 | ~500K | Full SaaS platform with users, alerts, incidents, assets, compliance |
| **E-commerce (NovaMart)** | 52 | ~480K | DTC brand + marketplace with orders, inventory, customers, analytics |

Demo data is not available for MySQL. Use your own database and run `bun run atlas -- init` to generate the semantic layer.

## Deploy

Each platform gets the right template and sandbox configuration automatically.

### Docker (self-hosted)

nsjail process isolation is built into the Docker image.

```bash
bun create @useatlas my-app --platform docker
cd my-app

# Generate semantic layer from your database
bun run atlas -- init

# Build and run
docker build -t my-app .
docker run -p 3001:3001 --env-file .env my-app
```

Verify: `curl http://localhost:3001/api/health`

### Railway

Uses a sidecar container for sandbox isolation via Railway's internal networking.

```bash
bun create @useatlas my-app --platform railway
cd my-app
```

1. Push to GitHub
2. Create a Railway project with two services:
   - **Main service** -- your repo root (uses `railway.json`)
   - **Sidecar** -- the `sidecar/` directory (uses `sidecar/railway.json`)
3. Add a Postgres plugin (Railway auto-injects `DATABASE_URL`)
4. Set env vars on the main service: `ATLAS_PROVIDER`, provider API key, `ATLAS_DATASOURCE_URL`
5. Set `SIDECAR_AUTH_TOKEN` on **both** services (pre-generated in `.env`)

### Vercel

Deploys as a Next.js app with the API embedded via a catch-all route. Explore tool auto-detects Vercel Sandbox (Firecracker VM isolation).

```bash
bun create @useatlas my-app --platform vercel
cd my-app
```

1. Push to GitHub and import in the [Vercel Dashboard](https://vercel.com/new)
2. Set env vars: `ATLAS_PROVIDER`, provider API key, `ATLAS_DATASOURCE_URL`, `DATABASE_URL` (Postgres for auth and audit)
3. Deploy

## Semantic layer

The semantic layer is a set of YAML files that describe your database schema, relationships, and query patterns. Atlas uses it to write accurate SQL.

Generate it from your database. If you chose "Generate semantic layer" during setup, the scaffolder already ran `atlas init --enrich` for you.

```bash
# Basic profiling
bun run atlas -- init

# With LLM enrichment (adds descriptions, query patterns, virtual dimensions)
bun run atlas -- init --enrich

# Profile specific tables only
bun run atlas -- init --tables users,orders,products

# Check for schema drift
bun run atlas -- diff
```

## Environment variables

### Required

| Variable | Example | Description |
|----------|---------|-------------|
| `ATLAS_PROVIDER` | `anthropic` | LLM provider (`anthropic`, `openai`, `bedrock`, `ollama`, `gateway`) |
| Provider API key | `ANTHROPIC_API_KEY=sk-ant-...` | Depends on provider |
| `ATLAS_DATASOURCE_URL` | `postgresql://user:pass@host:5432/db` | Your analytics database |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | -- | Atlas internal Postgres (auth, audit). Auto-set on most platforms |
| `ATLAS_MODEL` | Provider default | Override the LLM model |
| `ATLAS_ROW_LIMIT` | `1000` | Max rows per query |
| `ATLAS_QUERY_TIMEOUT` | `30000` | Query timeout in ms |
| `ATLAS_SANDBOX` | auto-detect | Set to `nsjail` to enforce nsjail isolation |
| `ATLAS_SANDBOX_URL` | -- | Sidecar service URL for sandbox isolation |
| `SIDECAR_AUTH_TOKEN` | -- | Shared secret between main service and sidecar |
| `ATLAS_API_KEY` | -- | Enable simple API key auth |
| `BETTER_AUTH_SECRET` | -- | Enable managed auth (min 32 chars, requires `DATABASE_URL`) |
| `ATLAS_RATE_LIMIT_RPM` | disabled | Max requests per minute per user |

### Provider API keys

| Provider | Env var | Default model |
|----------|---------|---------------|
| Anthropic | `ANTHROPIC_API_KEY` | `claude-opus-4-6` |
| OpenAI | `OPENAI_API_KEY` | `gpt-4o` |
| AWS Bedrock | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` + `AWS_REGION` | `anthropic.claude-opus-4-6-v1:0` |
| Ollama | `OLLAMA_BASE_URL` | `llama3.1` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `anthropic/claude-opus-4.6` |

## Useful commands

```bash
bun run dev              # Start dev server (http://localhost:3000)
bun run build            # Production build
bun run start            # Start production server
bun run atlas -- init    # Generate semantic layer from database
bun run atlas -- diff    # Check for schema drift
bun run db:up            # Start local Postgres via Docker Compose
bun run db:down          # Stop local Postgres
bun run db:reset         # Reset local Postgres (fresh data)
bun run test             # Run tests
bun run lint             # Lint with ESLint
```

## Troubleshooting

**"bun: command not found"** -- Install Bun: `curl -fsSL https://bun.sh/install | bash`

**"Database is not reachable"** -- Check your connection string. For local Postgres, run `bun run db:up` first. Ensure the database exists and accepts connections.

**"ANTHROPIC_API_KEY is required"** -- Edit `.env` and set a real API key. If you used `--defaults`, the file contains a placeholder.

**"No semantic layer found"** -- Run `bun run atlas -- init` to generate YAML files from your database schema. The agent needs these to write SQL.

**Docker build fails with nsjail errors** -- nsjail requires Linux. On macOS, build with `docker build --platform linux/amd64 -t my-app .` or skip nsjail: add `--build-arg INSTALL_NSJAIL=false`.

**"Connection refused" on Railway** -- Ensure `ATLAS_DATASOURCE_URL` uses an external hostname, not `localhost`. For the sidecar, verify both services share the same `SIDECAR_AUTH_TOKEN`.

## Links

- [GitHub](https://github.com/AtlasDevHQ/atlas)
- [Website](https://www.useatlas.dev)
- [Issues](https://github.com/AtlasDevHQ/atlas/issues)

## License

MIT — see [LICENSE](./LICENSE)
