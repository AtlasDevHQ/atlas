# `migrations/` — numbered SQL migrations

Hand-written, append-only SQL migrations named `NNNN_<short_slug>.sql`. They
run **in-process at boot**, under a `pg_advisory_lock`, **before** `Bun.serve`
starts accepting traffic (`migrate.ts`), so a migration never races live
request handlers *inside the same container*. Better Auth-owned tables follow
the `MANAGED_AUTH_MIGRATIONS` ordering in `db/internal.ts`.

Companion one-shot backfill scripts live in [`scripts/`](./scripts/README.md).
Every `CREATE TABLE`/`ALTER TABLE` must be mirrored in `db/schema.ts` in the
same PR — `scripts/check-schema-drift.sh` (in `/ci`) fails otherwise.

## Two-phase drop discipline (expand–contract)

> **Rule:** a column or table is *stopped being read and written* in release N,
> and *dropped* in release N+1. Never drop in the same release that removes the
> last reader, once a paying customer is live.

### Why — the N-1 ↔ N deploy-overlap window

Migrations are safe *within* a container, but a deploy is not atomic across
containers. Railway deploys are **replace-not-rolling** (`numReplicas: 1`), yet
there is still a brief overlap where the **old (N-1)** container is draining and
still serving requests while the **new (N)** container has *already* migrated the
**shared regional database**. During that window:

- a `DROP TABLE` / `DROP COLUMN` applied by N means an N-1 request that still
  reads the dropped object hits `relation does not exist` /
  `column does not exist` — a hard 500 for real traffic.

Because the schema is shared and the migration lands the instant N boots, the
*old code* is the thing that breaks, not the new code. Splitting the change into
two releases closes the window: by the time the drop ships in N+1, no
still-running pod (N or N-1) reads the object.

### The two phases

1. **Release N — contract reads/writes (no DDL on the doomed object).**
   Remove every code path that reads or writes the column/table. Stop writing it
   first; backfill any successor column if needed. The object still exists, so
   any lingering N-1 pod from the *previous* deploy keeps working.
2. **Release N+1 — drop the object.**
   Now that no shipped code (and no in-flight pod) touches it, `DROP TABLE` /
   `DROP COLUMN` is safe. Remove the `pgTable`/column from `db/schema.ts` in the
   **same commit** as the drop migration (`check-schema-drift.sh` excludes
   explicitly-dropped tables from the expected set, so a tracked drop won't
   surface as false-positive drift — see below).

For a **`DROP COLUMN`**, the same split applies: stop writing the column in N
(let it go `NULL`/default), drop it in N+1.

### How the schema-drift guard already encodes this

`scripts/check-schema-drift.sh` computes *expected tables = created MINUS
dropped*: every `DROP TABLE [IF EXISTS] <name>` subtracts that table from the set
it expects to find in `schema.ts`. So the guard's contract is already
"a dropped table must also be removed from `schema.ts`" — pair your drop
migration with the matching `schema.ts` deletion in one commit and the check
stays green (the same reason `mcp_tokens`, dropped by 0047, is excluded).

### Motivating examples

- **`0119_drop_legacy_credential_tables.sql`** — `DROP TABLE ... CASCADE` of the
  four legacy static-bot install tables. Safe **only** because the read paths
  were removed earlier in the same release train (#3154): the inbound resolvers
  already read exclusively from `workspace_plugins`. Had an N-1 pod still read
  `teams_installations` during overlap, it would have 500'd. This is the
  borderline case the rule is meant to make deliberate rather than incidental.
- **`0118_drop_user_admin_role.sql`** — unbounded `UPDATE member/user` scans plus
  the column retirement. A no-op on current data, but the advisory-lock hold
  grows with table size, so at scale the migration itself becomes the stall — a
  second reason to keep doomed-object changes small and staged.

### When a one-release drop is still fine

Pre-launch (no customers) the overlap window carries no real traffic, so a
same-release "remove reads + drop" is acceptable today — but write it as a
*deliberate* exception in the migration header (as `0119` does), not a default.
Once live, default to the two-phase split.
