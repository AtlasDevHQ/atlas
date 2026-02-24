# Bring Your Own Database

Connect Atlas to your existing PostgreSQL database. This guide covers user setup, SSL, semantic layer generation, and safety configuration.

## Prerequisites

- A PostgreSQL database (version 12+)
- Network access from your Atlas deployment to the database
- Atlas installed locally (`bun install`) for semantic layer generation

## 1. Create a read-only database user

Atlas only runs `SELECT` queries -- enforced by a multi-layer SQL validation pipeline. For defense in depth, connect with a read-only Postgres user:

```sql
-- Create a read-only user
CREATE USER atlas_reader WITH PASSWORD 'your-strong-password';

-- Grant connect and usage
GRANT CONNECT ON DATABASE your_db TO atlas_reader;
GRANT USAGE ON SCHEMA public TO atlas_reader;

-- Grant SELECT on all existing tables
GRANT SELECT ON ALL TABLES IN SCHEMA public TO atlas_reader;

-- Auto-grant SELECT on future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO atlas_reader;
```

## 2. Build the connection string

```
DATABASE_URL=postgresql://atlas_reader:your-strong-password@your-host:5432/your_db
```

### SSL configuration

Most managed Postgres providers (AWS RDS, Supabase, Neon, Railway) require SSL. Append `?sslmode=require` to your connection string:

```
DATABASE_URL=postgresql://atlas_reader:password@host:5432/db?sslmode=require
```

For self-signed certificates, use `?sslmode=no-verify` (not recommended for production).

Atlas uses the `pg` Node.js driver. SSL options are parsed directly from the connection string.

## 3. Generate the semantic layer

The `atlas init` CLI profiles your database and generates YAML files that teach the agent about your schema.

### Profile all tables

```bash
DATABASE_URL="postgresql://atlas_reader:password@host:5432/db" \
  bun run atlas -- init
```

This connects to your database, queries system catalogs (`pg_constraint`, `pg_attribute`, `information_schema`), and generates:

- `semantic/entities/*.yml` -- One file per table with columns, types, sample values, joins, measures, virtual dimensions, and query patterns
- `semantic/catalog.yml` -- Entry point listing all entities with `use_for` guidance and `common_questions`
- `semantic/glossary.yml` -- Auto-detected ambiguous terms, FK relationships, and enum definitions
- `semantic/metrics/*.yml` -- Per-table metric definitions (count, sum, avg, breakdowns)

### Profile specific tables

If your database has many tables and you only need a subset:

```bash
bun run atlas -- init --tables users,orders,products,line_items
```

### Add LLM enrichment

The `--enrich` flag uses your configured LLM provider to add richer descriptions, business context, and additional query patterns:

```bash
ATLAS_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... \
  bun run atlas -- init --enrich
```

Enrichment is auto-enabled when `ATLAS_PROVIDER` and its API key are both set. Skip it explicitly with `--no-enrich`.

Enrichment adds:
- Rich 2-3 sentence business descriptions for each entity
- Concrete analytical use cases
- Additional query patterns with valid PostgreSQL
- Improved glossary definitions and disambiguation guidance
- Missing metric fields (`unit`, `aggregation`, `objective`) and derived metrics

### Review and refine

The generated YAMLs are a starting point. Review them and:

- Fix descriptions that the profiler could not infer
- Add business context only you know
- Remove tables or columns that should not be queryable
- Adjust `sample_values` for sensitive columns

The agent reads these files before writing SQL. Better YAMLs produce better queries.

## 4. Safety knobs

Atlas enforces several safety limits. Tune them via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `ATLAS_TABLE_WHITELIST` | `true` | Only allow queries against tables defined in `semantic/entities/*.yml`. Prevents access to tables not in the semantic layer |
| `ATLAS_ROW_LIMIT` | `1000` | Maximum rows returned per query. Appended as `LIMIT` to every query |
| `ATLAS_QUERY_TIMEOUT` | `30000` | Per-query timeout in milliseconds. Set via `SET statement_timeout` before each query |

> **Note:** Non-SELECT SQL (INSERT, UPDATE, DELETE, DROP, etc.) is always rejected by the validation pipeline. There is no toggle to disable this.

### SQL validation pipeline

Every query goes through six layers of validation before execution:

1. **Empty check** -- Reject empty or whitespace-only queries
2. **Regex mutation guard** -- Quick reject of DML/DDL keywords (INSERT, UPDATE, DELETE, DROP, etc.)
3. **AST parse** -- `node-sql-parser` in PostgreSQL mode verifies a single SELECT statement. Unparseable queries are rejected
4. **Table whitelist** -- All referenced tables must exist in `semantic/entities/*.yml`. CTE names are excluded from the check
5. **Auto LIMIT** -- `LIMIT` appended to every query (configurable via `ATLAS_ROW_LIMIT`)
6. **Statement timeout** -- `SET statement_timeout` applied before each query (configurable via `ATLAS_QUERY_TIMEOUT`)

### Recommended production settings

For a production database with sensitive data:

```bash
# .env
ATLAS_TABLE_WHITELIST=true
ATLAS_ROW_LIMIT=500
ATLAS_QUERY_TIMEOUT=15000
```

Lower the row limit to reduce load on your database. Reduce the query timeout to kill runaway queries faster.

## 5. Verify the setup

Start the dev server and check the health endpoint:

```bash
bun run dev
curl http://localhost:3000/api/health
```

The health response includes:

```json
{
  "status": "ok",
  "checks": {
    "database": { "status": "ok", "latencyMs": 12 },
    "provider": { "status": "ok", "provider": "anthropic", "model": "(default)" },
    "semanticLayer": { "status": "ok", "entityCount": 5 }
  }
}
```

If `database.status` is `"error"`, check your `DATABASE_URL`, network access, and user permissions.

## Troubleshooting

**"Cannot connect to database"** during `atlas init`
- Verify the connection string: `psql "$DATABASE_URL"` should connect
- Check that the host is reachable from your machine
- For SSL issues, try appending `?sslmode=require` or `?sslmode=no-verify`

**"No tables were successfully profiled"**
- Ensure the user has `SELECT` and `USAGE` privileges on the `public` schema
- Check that tables exist in the `public` schema (Atlas profiles `public` by default)
- Use `--tables` to target specific tables if the schema has many objects

**Health check shows `MISSING_SEMANTIC_LAYER`**
- Run `bun run atlas -- init` to generate the `semantic/` directory
- If deploying via Docker, the semantic layer must exist at build time (it gets baked into the image)

**Queries timing out**
- Increase `ATLAS_QUERY_TIMEOUT` for complex queries
- Lower `ATLAS_ROW_LIMIT` to reduce result set sizes
- Add indexes to your database for commonly queried columns
