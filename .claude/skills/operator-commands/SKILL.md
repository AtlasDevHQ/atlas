---
name: operator-commands
description: Run destructive tenant-data operator subcommands via the atlas-operator binary — proactive enable/disable, seed prompts/workspace, ops wipe, backfill-crm-leads, smoke-crm, teardown-verify-accounts, gate-export, heldout-manifest. Use when asked to wipe, seed, backfill, smoke-test, tear down, export gate decisions, or cut/verify the frozen held-out set from workspace/tenant data.
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
| `ops gate-export` | a **region's internal** DB, on the same terms — no `DATABASE_URL` fallback |
| `ops heldout-manifest` | a **region's internal** DB, on the same terms — no `DATABASE_URL` fallback |

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

# Cut an EVALUATION bundle of one workspace's review-gate decisions (#5335).
# DRY RUN by default; EXECUTE = ATLAS_GATE_EXPORT_OK=1 + --confirm:
ATLAS_GATE_EXPORT_OK=1 bun run atlas-operator -- ops gate-export \
  --workspace <orgId> --region <us|eu|apac> --output ./bundle.json --confirm [--dry-run]

# Cut the FROZEN held-out set #5338 measures the extraction cascade against —
# ids and labels, NO tenant text. DRY RUN by default; EXECUTE = ATLAS_HELDOUT_OK=1 + --confirm:
ATLAS_HELDOUT_OK=1 bun run atlas-operator -- ops heldout-manifest \
  --workspace <orgId> --region <us|eu|apac> \
  --from 2026-06-01T00:00:00Z --to 2026-09-01T00:00:00Z \
  --output packages/api/scripts/heldout/us-2026-09.json --confirm [--dry-run]

# Re-resolve an existing manifest against the live DB. Ungated — writes nothing:
bun run atlas-operator -- ops heldout-manifest --region <us|eu|apac> \
  --verify packages/api/scripts/heldout/us-2026-09.json
```

## Gates and blast radius

- **`ops wipe`** is the only subcommand that wipes the tenant DB. Requires **both** `ATLAS_WIPE_OK=1` **and** `--confirm` — an intentional double-gate. **No backup is taken**; wrap with `pg_dump` yourself. Operates on one DB per invocation.
- **`ops smoke-crm`** verifies the demo→Twenty lead-capture pipeline end to end. Run ad-hoc by an operator and as the post-deploy Staging Smoke gate (`.github/workflows/staging-smoke.yml`) — not per-PR CI. Its optional `--wipe-twenty` phase clears the Twenty workspace and is double-gated by `ATLAS_SMOKE_WIPE_OK=1`.
- **`ops teardown-verify-accounts`** targets a region's internal DB, resolved from `--region` or an explicit `--database-url`. There is deliberately **no `DATABASE_URL` fallback**, so you can't tear down the wrong DB by forgetting the flag. DRY RUN by default; EXECUTE is double-gated by `ATLAS_TEARDOWN_OK=1` + `--confirm`, with a 12-workspace blast-radius cap and a plus-addressing guard (`--force` to override).

- **`ops gate-export`** is the one subcommand here that is gated because it **exfiltrates** rather than destroys. It reads verbatim tenant content — Slack messages, transcript lines, mail bodies, and the claims a human ruled on — and writes them to a portable file that leaves every mechanism the platform has for reaching tenant data: a purge cannot reach a bundle, and residency routing cannot recall one. So it takes `ops wipe`'s shape: DRY RUN by default, EXECUTE double-gated by `ATLAS_GATE_EXPORT_OK=1` + `--confirm`, one workspace per invocation, capped at 5,000 rows, and every run — refusals and dry runs included — written to `admin_action_log`. It refuses outright to cross a region boundary or to export a workspace carrying a grant token outside the ACL grammar.
  - ⚠️ **The bundle is EVALUATION ONLY and is never a training corpus** (ADR-0043, #5339). It is outside `purge-scope.ts` by construction, so cut one for a **named** evaluation and destroy it afterwards rather than accumulating bundles. The file says so in its own header.
  - A DRY RUN runs the identical query and prints exact counts and analytics; it just writes no file. The preview an operator decides on is the thing that would be exported.

- **`ops heldout-manifest`** cuts the frozen held-out set for #5338. It reads the same rows `gate-export` does but writes **only `(episodeId, class)` plus the cut date, the window and the dial evidence** — no body, no claim text, no grant. That is what lets these files be **committed** (`packages/api/scripts/heldout/`) where a bundle must not be: the set is NAMED, not carried, and bodies are re-read live at measurement time. Gated anyway on two grounds — the read is identical to a bundle's, and the write is a **freeze** that is supposed to happen exactly once. DRY RUN by default; EXECUTE double-gated by `ATLAS_HELDOUT_OK=1` + `--confirm`.
  - ⚠️ **It refuses rather than truncates.** A window that is too large, still open, inverted, or in which stage-0 triage left evidence of having run produces no file at all. A set clipped at a cap is sampled by sort order, which is exactly the authorship a mechanical window exists to remove.
  - The triage-dial precondition reads three signals: a `triaged_out_at` mark in the window (erased by a #5534 re-queue), an extraction-cycle audit row reporting a non-zero `skipped.triaged` (survives one), and the platform `settings` row for the dial today. **When no cycle audit rows exist at all the audit half is UNATTESTED** — recorded on the manifest and warned about, never silently passed.
  - `--verify <path>` is **ungated** (it writes nothing and prints only ids the operator already has) but **does** refuse to cross a region boundary: a `us` manifest read against `--region eu` would report every row as purged, firing the design's loudest alarm from a flag typo. An id that genuinely no longer resolves is a **purge** — report the shrunken denominator, never re-cut the set to replace it.
  - ⚠️ **The attestation covers ONE region** (`dialEvidence.attestsRegion`), and the console says `<region> ONLY` on every run. ADR-0024 makes the process the region, so no deployment can probe another's tables; covering the fleet means one manifest per region. Likewise `counts.stillDraining` reports episodes still on the extraction drain — `to` having elapsed does not mean the drain caught up, and no drain-lag constant is both true and non-blocking, so the shortfall is measured into the file instead of gated.

One-shot migration backfills live next to their migration in `db/migrations/scripts/`.

## Not here: re-queueing triaged-out brain episodes (#5534)

There is **no `atlas-operator` subcommand for clearing stage-0 extraction triage marks**, and that is a recorded decision rather than a gap. The verb is `POST /api/v1/admin/brain-triage/requeue`, beside the per-rule backlog counts at `GET /api/v1/admin/brain-triage`.

Two reasons, if you come here looking for it:

- **The audit obligation is only satisfiable on the admin route.** Re-queueing sets both triage columns back to NULL, so afterwards nothing in `brain_episodes` records that those rows were ever triaged — the `brain.triage_requeue` admin-action row is the *only* durable account. Operator subcommands audit as `systemActor: "system:atlas-operator"`, which records that *some* operator ran something; for an act whose sole record is that row, that is not an answer to "who".
- **It is not an operator-shaped act.** What this binary exists for is direct-DB work the gate chain cannot reach — destructive (`ops wipe`), cross-tenant, or exfiltrating (`gate-export`); ADR-0025 step 4 split it out precisely so the workspace-facing CLI ships none of that. (Not every subcommand is destructive — `seed prompts` and `proactive enable` are neither — but each is direct-DB operator work with no admin principal behind it.) A re-queue is not: it is single-workspace, additive (it restores a queue position and deletes nothing), and the judgement behind it — "our acknowledgement list was wrong", "that rule is eating our messages" — belongs to the workspace's own admin.

`packages/api/src/api/routes/admin-brain-triage.ts` carries the full argument, including why the answer is not "both".
