---
name: operator-commands
description: Run destructive tenant-data operator subcommands via the atlas-operator binary — proactive enable/disable, seed prompts/workspace, ops wipe, backfill-crm-leads, smoke-crm, teardown-verify-accounts. Use when asked to wipe, seed, backfill, smoke-test, or tear down workspace/tenant data.
---

# Operator subcommands (destructive) — the `atlas-operator` binary

The tenant-data operator surface lives in its **own binary**, split out of the published `atlas` CLI so the workspace-facing binary never ships tenant-destructive direct-DB tooling (ADR-0025 step 4, #4045). The published `atlas` CLI no longer dispatches these — it prints a redirect pointing here.

Run with `bun run atlas-operator -- <command>` (root or `packages/cli` script).

**Which database each command touches** is the thing to get right before running anything:

| Command family | Target DB |
|---|---|
| tenant-data subcommands | tenant DB at `ATLAS_TEAM_PG_URL`, falling back to `DATABASE_URL` |
| `export`, `learn` | **internal** DB via `DATABASE_URL` |
| `ops teardown-verify-accounts` | a **region's internal** DB via `ATLAS_REGION_<R>_DB_URL` — no `DATABASE_URL` fallback |

```bash
bun run atlas-operator -- proactive enable --workspace <id|slug> --channels <c1,c2>
bun run atlas-operator -- proactive disable --workspace <id|slug>
bun run atlas-operator -- seed prompts --workspace <id|slug> --library ./prompts/library.yml
bun run atlas-operator -- seed workspace --workspace <id|slug> --group prod \
  --connections us-prod=US_DB_URL:postgres:primary,eu-prod=EU_DB_URL:postgres

# DESTRUCTIVE — TRUNCATE every public table (excluding migration bookkeeping):
ATLAS_WIPE_OK=1 bun run atlas-operator -- ops wipe --confirm [--database-url <url>]

# One-shot: enqueue every demo_leads row into crm_outbox for dispatch to Twenty:
bun run atlas-operator -- ops backfill-crm-leads [--dry-run] [--batch-size 500] [--source demo]

# E2E check of the demo→Twenty lead pipeline (below Turnstile, via the outbox):
bun run atlas-operator -- ops smoke-crm --personas <path> [--wipe-twenty] [--twenty-base-url <url>] \
  [--twenty-api-key <key>] [--timeout-seconds 60] [--database-url <url>]

# Tear down throwaway /verify-prod-signup accounts (user+org+Stripe customer).
# DRY RUN by default; EXECUTE = ATLAS_TEARDOWN_OK=1 + --confirm:
ATLAS_TEARDOWN_OK=1 bun run atlas-operator -- ops teardown-verify-accounts \
  --region <us|eu|apac> --email <addr[,addr]> --confirm [--dry-run] [--force]
```

## Gates and blast radius

- **`ops wipe`** is the only subcommand that wipes the tenant DB. Requires **both** `ATLAS_WIPE_OK=1` **and** `--confirm` — an intentional double-gate. **No backup is taken**; wrap with `pg_dump` yourself. Operates on one DB per invocation.
- **`ops smoke-crm`** verifies the demo→Twenty lead-capture pipeline end to end. Run ad-hoc by an operator and as the post-deploy Staging Smoke gate (`.github/workflows/staging-smoke.yml`) — not per-PR CI. Its optional `--wipe-twenty` phase clears the Twenty workspace and is double-gated by `ATLAS_SMOKE_WIPE_OK=1`.
- **`ops teardown-verify-accounts`** targets a region's internal DB, resolved from `--region` or an explicit `--database-url`. There is deliberately **no `DATABASE_URL` fallback**, so you can't tear down the wrong DB by forgetting the flag. DRY RUN by default; EXECUTE is double-gated by `ATLAS_TEARDOWN_OK=1` + `--confirm`, with a 12-workspace blast-radius cap and a plus-addressing guard (`--force` to override).

One-shot migration backfills live next to their migration in `db/migrations/scripts/`.
