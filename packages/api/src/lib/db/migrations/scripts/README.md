# `migrations/scripts/` — one-shot backfill helpers

This directory holds **one-shot** TypeScript helpers that accompany numbered
migrations. They're for backfills the migration itself can't (or shouldn't)
do inline — usually because the data transform is complex enough to warrant
real code rather than a `DO $$` block, or because the migration has to land
shape-only so deploys don't stall.

Each file is named `NNNN_<short_slug>.ts` where `NNNN` matches the migration
number it accompanies — **unless it accompanies no numbered migration**, in
which case it is named after its source table or domain (see the three such
scripts listed below). A helper has no number when the work has no DDL half:
the table is created at runtime by a plugin, the transform bridges two existing
tables, or — as with `purge_partial_action_credentials.ts` — the rows can only
be classified by application code holding the encryption key, so no SQL
migration could do it. The file's header docblock states the **exact**
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
  the `atlas-cli` instead (`atlas-operator seed`, `atlas-operator proactive`, etc.).

## Existing scripts

- `0027_backfill_region.ts` — accompanies `0027_organization_saas_columns.sql`
- `0096_connections_to_workspace_plugins.ts` — sanity-check harness for `0096_drop_connections_table.sql` (1.5.3 cutover / ADR-0007)
- `slack_installations_to_chat_cache.ts` — accompanies the runtime DDL emitted by `@useatlas/chat`'s `pg-adapter.ts`
- `purge_partial_action_credentials.ts` — deletes `workspace_action_credentials` rows whose decrypted bundle misses a required field of its target's spec (#5564). No numbered migration accompanies it because there is no DDL half: the bundle is one AES-GCM ciphertext column, so no SQL can inspect completeness. **DRY RUN unless `--confirm`, and it must never become a recurring sweep** — the day a target's spec gains a required field, every stored row for that target becomes partial at once, and a scheduled version would delete every workspace's credentials for it. The script's header docblock carries the full reasoning.
- `backfill-crm-leads.ts` — enqueues every existing `demo_leads` row into `crm_outbox` for dispatch to Twenty (#2736). Surfaced via `bun run atlas-operator -- ops backfill-crm-leads`. Re-runs are safe — `TwentyClient.upsertPerson` dedupes by `emails.primaryEmail`. Lives here rather than under `atlas-cli` because it's a one-shot bridge for the cutover where demo signups began flowing through the outbox (#2730 / PR #2785).

See each script's header docblock for the prod-run date and the exact invocation. The Slack, CRM-leads and partial-action-credential scripts don't accompany a numbered migration: `chat_cache` is created at runtime by the chat plugin; the CRM-leads backfill is a one-shot bridge from the existing `demo_leads` to the new `crm_outbox` (0102) — naming them after the source table / domain is the clearest signal of intent.
