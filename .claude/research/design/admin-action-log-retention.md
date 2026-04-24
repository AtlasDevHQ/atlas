# `admin_action_log` Retention + Erasure — Design

> Design reference for F-36 (issue #1791, milestone 1.2.3 Phase 4 tail).
> Covers the data-layer decisions behind admin-action-log retention and
> GDPR / CCPA "right to erasure" support. Phase 1 ships the migration,
> library, and scheduler extension; Phase 2 ships the admin UI surface.

## Context

### What exists today

- **`audit_log`** — query-level audit. Has a per-org retention policy via
  `audit_retention_config` (baseline 0000) and a daily scheduler
  (`ee/src/audit/purge-scheduler.ts`, `ee/src/audit/retention.ts`).
  Supports soft-delete → hard-delete windows, compliance export, and — as
  of F-27 (PR #1807) — self-audit rows written under the reserved
  `system:audit-purge-scheduler` actor.
- **`admin_action_log`** — platform / workspace admin mutation audit.
  Migration `0023_admin_action_log.sql` explicitly documents "kept
  indefinitely — no `deleted_at` column." No retention policy, no purge
  mechanism, no erasure helper. `logAdminAction()` is INSERT-only across
  the whole repo (verified in the phase-4 audit append-only check).
- **Cascade delete** — `cascadeWorkspaceDelete` in
  `packages/api/src/lib/db/internal.ts` hard-deletes workspace-scoped
  rows. There is no user-level erasure helper anywhere in the codebase.

### Why a design doc

The fix sketch in `.claude/research/security-audit-1-2-3.md` (around
line 1480) flags "GDPR right to erasure support is the open design
decision the fix PR must propose and defend — there is no pre-existing
anonymization pattern in the codebase to model on." This doc commits to
specific answers for each of the open decisions so the Phase 1 PR doesn't
need to re-litigate them, and so the Phase 2 UI session inherits a
fixed data contract.

## Decisions

### D1 — Erasure shape: `actor_id = NULL, actor_email = NULL, anonymized_at = now()`

The phase-4 audit listed three candidates in preference order:

1. `actor_id = NULL, actor_email = NULL, anonymized_at = now()` — preserve
   the row, drop the identifiers, positive signal via the timestamp.
2. Sentinel strings (`"__erased__"`) — simpler but risks collision with
   real values unless an insert-time invariant check runs.
3. Peppered SHA-256 — preserves correlation without exposing the user,
   at the cost of pepper-rotation machinery.

**We pick option 1.**

Rationale:

- **Clearest positive signal.** `anonymized_at IS NOT NULL` is a boolean
  forensic question with no ambiguity. A reviewer asking "has this row
  been scrubbed?" reads one column. Option 2 asks the reviewer to trust
  the sentinel isn't a real value; option 3 asks them to hold the pepper
  across months of rotation.
- **NULL is the honest thing.** The regulator-facing story for GDPR /
  CCPA erasure is "we destroyed the identifier." `NULL` means destroyed.
  A sentinel string or hash is a representation of the identifier; a
  hostile reviewer could credibly argue it still points to the user.
- **Low blast radius.** `admin_action_log.actor_id` and `.actor_email`
  are `TEXT NOT NULL` in migration 0023. Relaxing them to NULL on those
  two columns is a narrower schema change than adding a separate sentinel
  column, and the existing reader code already handles `null` email /
  id via the `ctx?.user?.id ?? "unknown"` fallback in `logAdminAction`.
- **Sequencing isn't lost.** The `timestamp`, `action_type`, `target_id`,
  and `ip_address` columns survive. A reviewer investigating "what did
  this user do on 2024-02-12" can still reconstruct sequence from the
  surviving columns; they just can't name the human. That is exactly
  the intended post-erasure state.
- **Option 3's upside — preserving per-user correlation — is not
  something we need.** Erasure is permanent; we don't want to keep
  re-identifying the user by fuzzy-matching the hash. And the pepper
  rotation story is load-bearing: lose or leak the pepper and the
  "one-way-ness" collapses.
- **Invariant check for option 2 is not cheap.** "Reject inserts
  containing `__erased__` in `actor_id` or `actor_email`" needs a CHECK
  constraint *and* backfill-time discipline so an earlier legitimate row
  doesn't accidentally carry the sentinel. Option 1 needs no such check —
  NULL is structurally distinct from any legitimate value.

**What we lose.** With option 1 we cannot tell `(actor_id, actor_email)`
pairs apart post-erasure — two erased users become indistinguishable from
each other on the anonymized rows. This is acceptable because the
erasure contract explicitly asks for this outcome. A reviewer who needs
"which erased user did what" has already crossed the line the erasure
was designed to defend.

### D2 — Retention default: 2555 days (7 years)

The issue body calls for a 7-year default; this matches SOC 2, HIPAA, and
ISO 27001 common practice for admin / privileged-action logs. Query audit
(`audit_log`) uses `null = unlimited` with no default — that's the
looser trail. Admin-action audit is the stricter trail: we ship a
concrete default so self-hosters don't accidentally land in "keep
forever" purely by omission. `null = unlimited` remains available for
operators who explicitly want it.

- **Minimum retention**: reuse `MIN_RETENTION_DAYS = 7` from
  `ee/src/audit/retention.ts`. Dropping below 7 days on the admin trail
  would silently erase forensic evidence for in-progress investigations.
- **Hard-delete delay**: reuse `DEFAULT_HARD_DELETE_DELAY_DAYS = 30`.
  The soft-delete → hard-delete gap is about recoverability from a
  misconfigured retention window, not about the retention window itself;
  the same reasoning applies.

### D3 — pino sink boundary: out-of-band

`admin_action_log` is the forensic store; pino is the operational log.
Pre-erasure pino lines containing `actorEmail` land in stdout / Grafana
Loki / whatever sink the operator has configured. Two options:

- **Pipe pino records through a redaction filter pre-write.** Zero
  trust in the operator's log-retention policy — every audit pino line
  would need an `actorEmail` → redacted-hash substitution before it
  leaves the process.
- **Document the log sink as an out-of-band concern.** The operator
  already owns their log-retention policy; on SaaS, our Loki retention
  window is short (days, not years) and is a documented SaaS control; on
  self-hosted, the operator is accountable for their own stdout. A
  compliance-minded operator who receives an erasure request processes
  it against *both* Postgres and their log aggregator; this is already
  the pattern for any product that logs identifiers.

**We pick the second option.**

Rationale:

- The pino sink is not the forensic store. A compliance auditor asking
  "prove user X's identifier is gone" looks at `admin_action_log` (the
  system of record). We anonymize there, durably, with a positive
  signal.
- Redacting pino pre-write breaks the operational utility of the audit
  pino lines. The whole point of the line is "who did this just now";
  if it comes out already-redacted, triage has to join on the DB row to
  see the actor, which is exactly the join the DB row was supposed to
  make unnecessary.
- Log aggregators already have their own retention model. SaaS Loki is
  on a ~7-day window by default; an erased user's identifier naturally
  ages out of the sink within the regulator's response window (most
  frameworks allow 30 days). A customer on a self-hosted sink with
  unlimited retention is the one who needs to act on the erasure — and
  they're also the one who controls the sink.
- **Documentation surface.** The Phase 2 follow-up must call this out
  in the admin UI: a helper text near the "Erase user" button that
  reads something like "Identifiers are removed from the audit log. Pino
  / operational logs are controlled by your log-aggregator retention
  policy." That keeps the contract honest without shipping a
  half-solution.

Phase 2 tracked separately. We do not ship a pino redaction filter in
Phase 1. If a customer (or a specific compliance framework our SaaS
commits to) later forces the first option, a `hook.pino.serializers`
path exists; it's an additive change.

### D4 — Schema: new `admin_action_retention_config` table

Two candidates:

- Parallel table `admin_action_retention_config` with the same shape as
  `audit_retention_config`.
- Extend `audit_retention_config` with a `table_name` discriminator so
  one table holds retention policy for both logs.

**We pick the parallel table.**

Rationale:

- **Blast radius.** The existing `audit_retention_config` is wired into
  five places: `getRetentionPolicy`, `setRetentionPolicy`,
  `purgeExpiredEntries`, `hardDeleteExpired`, and the admin API route.
  Extending it with a discriminator means every `WHERE org_id = $1`
  query turns into `WHERE org_id = $1 AND table_name = $2`, and the
  uniqueness constraint on `(org_id)` has to become `(org_id,
  table_name)`. That's invasive for a feature that doesn't need the
  join.
- **Clear separation of responsibilities.** Query audit and admin-action
  audit have different retention defaults, different minimum-retention
  argumentation, and different erasure semantics (admin actions anonymize
  a row; query audit soft-deletes it wholesale). A shared config table
  suggests they share policy shape; they don't.
- **Mode-system precedent.** F-27 explicitly kept the scheduler
  self-audit row shape as a distinct `audit_log.purge_cycle` action
  type rather than mashing it into an existing domain, for the same
  reason: forensic readability.
- **Migration simplicity.** The parallel table is one `CREATE TABLE IF
  NOT EXISTS` plus the `anonymized_at` column on `admin_action_log`.
  Extending the existing table requires a `table_name` default
  backfill, the uniqueness constraint change, and a whole-code-path
  migration of every existing caller.

**What we lose.** Two tables to query if someone ever wants a unified
"which logs are under retention?" report. The pair of tables stays
short and queryable — `UNION` across the two when that report is ever
built — and the cost is one more migration on the operator's database.

## Data model

### New table: `admin_action_retention_config`

Mirrors `audit_retention_config`:

```sql
CREATE TABLE IF NOT EXISTS admin_action_retention_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL UNIQUE,
  retention_days INTEGER,
  hard_delete_delay_days INTEGER NOT NULL DEFAULT 30,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,
  last_purge_at TIMESTAMPTZ,
  last_purge_count INTEGER
);

CREATE INDEX IF NOT EXISTS idx_admin_action_retention_config_org
  ON admin_action_retention_config(org_id);
```

Key is `org_id` with a reserved literal `"platform"` for the
platform-scoped policy (every row with `scope = 'platform'` in
`admin_action_log` is keyed here). Per-workspace retention still goes to
its org's row. This matches the `audit_retention_config` convention.

### `admin_action_log.anonymized_at`

```sql
ALTER TABLE admin_action_log
  ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;
```

NULL = not erased. Non-NULL = erased at that instant; `actor_id` and
`actor_email` are also NULL on that row.

Both columns relax from `NOT NULL` to nullable so erasure can write NULL
through without a schema violation. Existing rows are unaffected (all
current rows have values); the constraint relaxation is one-way and
does not break any reader.

### Platform scope key

`admin_action_retention_config` keys by `org_id` with a reserved string
`"platform"` for platform-scoped retention (mirrors the mode-system
convention for the platform row). The scheduler iterates every
non-`null` retention-days row, same as `audit_retention_config`.

## Library surface

### `ee/src/audit/retention.ts` additions

- `purgeAdminActionExpired(orgId?: string): Effect<PurgeResult[], ...>`
  — parallel to `purgeExpiredEntries`. Hard-deletes rows past the
  retention window (no soft-delete stage for admin actions: the
  retention contract is long enough — default 7 years — that a
  second recovery window adds little safety relative to the audit
  volume).

- `anonymizeUserAdminActions(userId: string, initiatedBy:
  "self_request" | "dsr_request" | "scheduled_retention"):
  Effect<{ anonymizedRowCount: number }, ...>` — scrubs `actor_id` /
  `actor_email`, stamps `anonymized_at = now()`, on every row where
  `actor_id = userId`. Emits a `user.erase` audit row with metadata
  `{ targetUserId, anonymizedRowCount, initiatedBy }`.

The erasure operation itself is an auditable event at platform scope —
even when the erasure target is the audit log. This resolves the
"audit the audit" paradox: the erasure leaves forensic evidence that
the erasure happened, without leaving the identifier.

### System actor pin

The retention scheduler reuses `AUDIT_PURGE_SCHEDULER_ACTOR`
(`"system:audit-purge-scheduler"`) from F-27. Admin-action retention is
a sibling responsibility of the same scheduler (one 24 h loop processes
both tables); a distinct actor like `"system:admin-action-retention"`
would split forensic queries ("which scheduler ticked?") across two
actors without buying us anything on the threat-model side.

### `ADMIN_ACTIONS` additions

```typescript
admin_action_retention: {
  policyUpdate: "admin_action_retention.policy_update",
  manualPurge: "admin_action_retention.manual_purge",
  hardDelete: "admin_action_retention.hard_delete",
},
user: {
  // ...existing actions
  erase: "user.erase",
},
```

Parallels the `audit_retention.*` catalog. `user.erase` lives under the
existing `user` domain; the metadata shape is pinned in the
`anonymizeUserAdminActions` signature.

## Scheduler extension

### One self-audit row per table per cycle

`runPurgeCycle()` currently emits exactly one `audit_log.purge_cycle`
row per tick. The extension processes both tables and emits two
rows — one per table — keyed on `targetType`:

- `audit_log.purge_cycle` (existing) — `targetType: "audit_log"`
- `admin_action_log.purge_cycle` (new action type) — `targetType:
  "admin_action"`

**Rationale:** a single combined row would hide the case where one
table's purge completed successfully and the other threw. The F-27
zero-row-cycle invariant ("absence of a cycle row over a retention
window is the signal that the scheduler stopped") needs per-table
granularity to tell an admin-action-audit-only outage from an audit-log
outage. The separation costs one extra row per 24 h tick — negligible
relative to the admin_action_log volume the scheduler exists to bound.

Both rows carry the same cycle invariant: emitted even at zero rows,
with a `status: "failure"` variant on the catchAll path, under the
`system:audit-purge-scheduler` actor.

### Action catalog additions (scheduler-side)

```typescript
admin_action_log: {
  purgeCycle: "admin_action_log.purge_cycle",
},
```

Under a new `admin_action_log` domain, mirroring the existing
`audit_log` domain from F-27.

## Test contract

Tests ordered by load-bearing-ness — the anonymize test goes first
because the compliance assertion is "identifiers are destroyed":

1. **`anonymizeUserAdminActions`** — scrubs `actor_id` + `actor_email`
   to NULL, sets `anonymized_at`, preserves row, emits `user.erase`
   audit row with metadata including `anonymizedRowCount` and
   `initiatedBy`. The erasure is the compliance promise; this test is
   the contract.
2. **Migration applies cleanly** — via `buildTestLayer()` +
   `createConnectionTestLayer`. Schema and column shapes match.
3. **`purgeAdminActionExpired`** — with a retention policy past-window,
   rows delete + `admin_action_retention.hard_delete` audit row is
   emitted.
4. **Scheduler** — `runPurgeCycle` processes both tables, emits two
   `purge_cycle` rows, zero-row variant + failure variant both covered.
5. **Parity** — zero-row purgeAdminActionExpired emits zero-count
   summary row, consistent with F-27 scheduler-health pattern.

## Out of scope for Phase 1

- **Admin UI** (`/admin/audit/retention` needs an admin-action-retention
  tab + "Erase user" button + helper copy for the pino-sink boundary).
  Tracked as the Phase 2 follow-up issue #1813.
- **Pino redaction filter.** Documented as an out-of-band operator
  concern above; customers requesting zero-trust redaction pre-write
  can open a new issue.
- **DB-level grant revocation on `admin_action_log`** (F-40, deferred
  in the audit doc as P3). Separate hardening initiative.
- **Scheduled periodic erasure sweeps.** Erasure today is on-request
  (user self-serve or DSR intake); a "forget everyone who left more
  than N months ago" automation is out of scope and arguably a
  bad default given the audit-trail contract.

## Open questions (Phase 2)

- Does `"self_request"` require extra auth-mode gating (e.g., only
  applies when the user is already banned / deleted from Better Auth)?
  Phase 2 UI decision.
- Should the erasure return the row IDs, or only the count? The count
  is sufficient for the audit-row metadata; row IDs would give the UI
  an undo path, but undo against erasure is a contract violation —
  dropped from this design.
- Workspace-scoped retention (per-org policy for workspace-scope admin
  actions) vs platform-only. Phase 1 keeps `org_id` key for schema
  parity; Phase 2 decides whether the UI exposes per-workspace tuning.
