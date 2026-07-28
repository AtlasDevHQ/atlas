---
paths:
  - "packages/api/src/lib/db/**"
---

# Database, migrations, and the two-database split

- [ ] **Drizzle schema mirrors every migration** — A new `db/migrations/####_*.sql` that creates/alters a table needs a matching `db/schema.ts` update **in the same PR** — mirror types, composite PKs, indexes, CHECK constraints. `scripts/check-schema-drift.sh` (in `/ci`) fails on missing mirrors; without it, the next `drizzle-kit generate` emits a `DROP TABLE` that wipes the table on deploy
- [ ] **DROP TABLE migrations tracked separately** — `check-schema-drift.sh` excludes tables explicitly dropped by migrations (e.g. `mcp_tokens`, dropped by 0047). When you drop a table, remove its `pgTable` from `schema.ts` in the same commit
- [ ] **Two-phase drop discipline for `DROP TABLE`/`DROP COLUMN`** — stop reading/writing the object in release N, drop it in release N+1, so the N-1↔N deploy-overlap window can never `relation/column does not exist`. CI-enforced: `scripts/check-migration-rename-discipline.sh` (in `/ci`) rejects any newly-added migration doing a single-phase `RENAME COLUMN`/`DROP COLUMN`. Rationale + expand-contract checklist: [packages/api/src/lib/db/migrations/README.md](packages/api/src/lib/db/migrations/README.md)
- [ ] **Real-Postgres migration smoke runs in CI** — `migrate-pg.test.ts` runs every migration against `TEST_DATABASE_URL`; Better-Auth-dependent migrations must join `MANAGED_AUTH_MIGRATIONS` in `db/internal.ts`. See [docs/development/testing.md](docs/development/testing.md)

## Two-database architecture

1. **Analytics datasources** — the customer's data, read-only. PostgreSQL/MySQL native; ClickHouse, Snowflake, BigQuery, DuckDB, Elasticsearch/OpenSearch, Salesforce, and REST/OpenAPI via datasource plugins ([ADR-0013](docs/adr/0013-db-stored-plugin-datasource-connections.md)). Via `ConnectionRegistry` in `db/connection.ts`; `ATLAS_DATASOURCE_URL` seeds the default self-hosted connection
2. **Internal database** (`DATABASE_URL`) — Atlas's own Postgres for auth, audit, settings, content mode, knowledge, durable sessions. Optional self-hosted; required for SaaS. `db/internal.ts`

## Connecting

```typescript
import { getDB, connections } from "@atlas/api/lib/db/connection";
const db = getDB();
const { columns, rows } = await db.query("SELECT ...", 30000);
```
