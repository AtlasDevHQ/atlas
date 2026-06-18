# `migrations/` — numbered SQL migrations

Hand-written, append-only SQL migrations named `NNNN_<short_slug>.sql`. They
run **in-process at boot**, under a `pg_advisory_lock`, **before** `Bun.serve`
starts accepting traffic (`migrate.ts`), so a migration never races live
request handlers *inside the same container*. Better Auth-owned tables follow
the `MANAGED_AUTH_MIGRATIONS` ordering in `db/internal.ts`.

Companion one-shot backfill scripts live in [`scripts/`](./scripts/README.md).
Every schema change must be mirrored in `db/schema.ts` in the same PR. Note how
narrow the guard's reach is: `scripts/check-schema-drift.sh` (in `/ci`) does a
single forward check — every `CREATE TABLE` name must have a matching `pgTable`
(table-level existence). That's all it enforces. It does **not**:
- inspect `ALTER TABLE` — added/changed columns, types, constraints, indexes are
  **not** compared, so an unmirrored `ALTER TABLE` passes `/ci` green and a later
  `drizzle-kit generate` can emit a migration that reverts it;
- verify that a *dropped* table's `pgTable` was removed — `DROP TABLE` names are
  only subtracted from the expected set (to avoid a false-positive), never
  reverse-checked, so a leftover `pgTable` for a dropped table also passes green
  and can have `drizzle-kit generate` re-`CREATE` it.

So mirror column-level changes and dropped-table removals **by hand** — a green
drift check does not confirm either.

## Two-phase drop discipline (expand–contract)

> **Rule:** a column or table is *stopped being read and written* in release N,
> and *dropped* in release N+1. Never drop in the same release that removes the
> last reader, once a paying customer is live.

> Single-phase `RENAME COLUMN` / `DROP COLUMN` in a *new* migration is
> CI-enforced against by [`check-migration-rename-discipline.sh`](#ci-guard--check-migration-rename-disciplinesh-3686)
> (#3686). See also the [launch-readiness checklist](#launch-readiness-checklist-pre-v010).

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

### How the schema-drift guard relates to drops

`scripts/check-schema-drift.sh` computes *expected tables = created MINUS
dropped*: every `DROP TABLE [IF EXISTS] <name>` subtracts that table from the set
it expects to find in `schema.ts`. That subtraction only stops a *false
positive* — once a table is dropped, the forward check no longer demands a
`pgTable` for it (the same reason `mcp_tokens`, dropped by 0047, is excluded). It
does **not** verify you removed the stale `pgTable`; that remains your job (see
the guard-reach note at the top). Pair your drop migration with the matching
`schema.ts` deletion in the same commit so a later `drizzle-kit generate` can't
re-`CREATE` the table.

### Motivating examples

- **`0119_drop_legacy_credential_tables.sql`** — `DROP TABLE ... CASCADE` of the
  four legacy static-bot install tables, in the **same release** that removed
  their readers (#3154). This is exactly the pattern the rule discourages:
  although the inbound resolvers had already moved to `workspace_plugins`, a
  draining N-1 pod still runs the *old* readers during overlap and would 500 on
  `teams_installations`. Moving the readers was necessary but **not** sufficient —
  it was acceptable only under the pre-launch exception below (no real overlap
  traffic). Once a customer is live, this same drop would have needed the
  two-phase split. (The `0119` header documents *why the tables are unused*, not
  the overlap reasoning — capturing that deploy-safety rationale in the header is
  exactly the discipline this doc is asking future drops to add.)
- **`0118_drop_user_admin_role.sql`** — unbounded `UPDATE member/user` scans plus
  the column retirement. A no-op on current data, but the advisory-lock hold
  grows with table size, so at scale the migration itself becomes the stall — a
  second reason to keep doomed-object changes small and staged.

### When a one-release drop is still fine

Pre-launch (no customers) the overlap window carries no real traffic, so a
same-release "remove reads + drop" is acceptable today — but call it out as a
*deliberate* exception in the migration header (state that the overlap is
empty because there are no customers yet), not a default. Once live, default to
the two-phase split.

## CI guard — `check-migration-rename-discipline.sh` (#3686)

`scripts/check-migration-rename-discipline.sh` (in `/ci`) enforces this
discipline mechanically so the pattern can't recur. It diffs the migrations
*added* on the branch vs the base ref (`git diff --diff-filter=A`) and **fails**
when a newly-added migration contains a single-phase `RENAME COLUMN` or
`DROP COLUMN` (including the `DO $$ … $$` and bare `ALTER TABLE … RENAME a TO b`
spellings). It scans **only added files**, so pre-existing migrations — notably
`0133_approval_origin_rename.sql`, the authorized pre-customer clean-break — are
exempt by construction; no allowlist is needed.

When a `DROP COLUMN` is genuinely deploy-safe — the N+1 contract phase of a
documented two-phase drop, an explicitly-authorized pre-launch clean-break, or a
table that is not live-written — declare it in the migration with a **justified**
marker comment:

```sql
-- expand-contract: N+1 contract drop; reads/writes removed in <release/PR> (#xxxx)
ALTER TABLE foo DROP COLUMN bar;
```

A bare `-- expand-contract:` with no justification does not exempt anything —
the marker forces the deploy-safety rationale into the migration header, which
is the whole point. The marker suppresses **`DROP COLUMN` only**: a `RENAME
COLUMN` in the same migration still fails the guard, because a rename is
inherently single-phase and has no deploy-safe form. Replace it with
add-new-column + dual-write + backfill + two-phase-drop.

## Launch-readiness checklist (pre-`v0.1.0`)

The `v0.0.x` train runs under the pre-customer clean-break exception above.
Before the **`v0.1.0` public launch** ([#2919](https://github.com/AtlasDevHQ/atlas/issues/2919)),
confirm:

- [ ] **Expand-contract is the only column-rename/-drop path on live-written
  tables.** No single-phase `RENAME COLUMN` / `DROP COLUMN` in a new migration —
  CI-enforced by `scripts/check-migration-rename-discipline.sh`. Any
  `-- expand-contract:` escape-hatch usage on `main` has a real two-phase
  sequence (or non-live-table justification) behind it, not a rubber-stamp.
