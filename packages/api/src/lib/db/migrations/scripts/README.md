# `migrations/scripts/` — one-shot backfill helpers

This directory holds **one-shot** TypeScript helpers that accompany numbered
migrations. They're for backfills the migration itself can't (or shouldn't)
do inline — usually because the data transform is complex enough to warrant
real code rather than a `DO $$` block, or because the migration has to land
shape-only so deploys don't stall.

Each file is named `NNNN_<short_slug>.ts` where `NNNN` matches the migration
number it accompanies. The file's header docblock states the **exact**
`bun run` command and the **date** it was run on prod, so anyone retracing
the deploy can confirm whether the backfill is already applied to a given
environment.

## When to use

- The migration adds a column with `NULL` defaults and needs the column
  populated separately (eg. `organization.region`, `connections.url_key_version`).
- The migration creates a new table that mirrors data from another table
  (eg. `chat_cache` ← `slack_installations`).

## When NOT to use

- The backfill fits inline in the migration (use a `DO $$ ... END $$` block).
- The transform is recurring or part of normal operation — promote it to
  the `atlas-cli` instead (`atlas seed`, `atlas proactive`, etc.).

## Existing scripts

- `0027_backfill_region.ts` — accompanies `0027_organization_saas_columns.sql`
- `slack_installations_to_chat_cache.ts` — accompanies the runtime DDL emitted by `@useatlas/chat`'s `pg-adapter.ts`

See each script's header docblock for the prod-run date and the exact invocation. The second script doesn't accompany a numbered migration: `chat_cache` is created at runtime by the chat plugin. Naming it after the source table is the clearest signal of intent.
