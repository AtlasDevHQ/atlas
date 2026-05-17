/**
 * Dashboard stage tracker — destructive-op staging queue (#2365, PRD #2362).
 *
 * The chat-as-dashboard-editor PRD #2362 commits SAFE mutations
 * (addCard / updateCard / updateLayout / updateMeta) immediately, but
 * holds destructive mutations (removeCard / updateCardSql) as ghost
 * changes the user accepts or discards inline. This module is the deep
 * one in this slice — the pure state machine on top, the DB-touching
 * helpers at the bottom. Same shape as `dashboard-versioning.ts` (the
 * sibling deep module from #2364) so the tests can lean on the same
 * separation: pure transitions get exhaustive coverage with zero DB,
 * the helpers get focused DB-touching tests via `_resetPool(mockPool)`.
 *
 * State machine (pure):
 *
 *   pending → applied   (`acceptStageTransition` returns `apply` op + new row)
 *   pending → discarded (`discardStageTransition` returns new row)
 *   applied → applied   (idempotent — re-accept is a no-op)
 *   discarded → discarded (idempotent — re-discard is a no-op)
 *
 * The terminal-state idempotency is intentional: the inline Accept /
 * Discard buttons can race a parallel agent re-stage and we don't want
 * double-application or a 500 on the second click. `acceptStageTransition`
 * returns a discriminated result the route layer maps to a 200 / 409 /
 * 500; the DB-touching wrapper `acceptStagedChange` is responsible for
 * keeping the apply-the-change side-effect transactional with the
 * status flip.
 *
 * Per-user scope is enforced at every layer:
 *   - `stageChange` writes `(dashboard_id, user_id, ...)` — caller-supplied.
 *   - `acceptStagedChange` / `discardStagedChange` resolve the row by
 *     `(id, user_id)` so another user's stage can never be accepted or
 *     discarded across users; an attacker stamping someone else's stage
 *     id gets `not_found`.
 *   - `listStagedChangesForUser` filters by `(dashboard_id, user_id, status='pending')`.
 *
 * No HTTP / Hono / Effect concepts. The route layer wires this into
 * `/api/v1/dashboards/[id]/stage` + `/[id]/stage/[stageId]/accept` +
 * `/[id]/stage/[stageId]/discard`. The bound chat tools wire the stage
 * payload via `stageChange({ kind: "remove_card", ... })`.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import {
  hasInternalDB,
  internalQuery,
  getInternalDB,
} from "@atlas/api/lib/db/internal";
import {
  applyChangeToDraft,
  forkOrLoadDraft,
  type DraftChange,
} from "@atlas/api/lib/dashboard-versioning";
import { getDashboard } from "@atlas/api/lib/dashboards";

const log = createLogger("stage-tracker");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StageKind = "remove_card" | "edit_sql";
export type StageStatus = "pending" | "applied" | "discarded";

/**
 * Payload shape per kind. The wrappers store this as a JSONB blob; the
 * pure transitions below read it back through a discriminated union so
 * the type system enforces shape-by-kind at every call site.
 */
export type StagePayload =
  | { kind: "remove_card"; cardId: string }
  | { kind: "edit_sql"; cardId: string; newSql: string; currentSql: string };

export interface StagedChange {
  id: string;
  dashboardId: string;
  userId: string;
  kind: StageKind;
  payload: StagePayload;
  status: StageStatus;
  createdAt: string;
  updatedAt: string;
  appliedAt: string | null;
  discardedAt: string | null;
}

// ---------------------------------------------------------------------------
// Pure transitions — the part that gets exhaustive unit coverage
// ---------------------------------------------------------------------------

/**
 * Compute the result of accepting a staged change.
 *
 * Pure: takes a snapshot of the row + the "now" timestamp, returns either:
 *   - `{ kind: "apply", change, next }` — the row is `pending`; the
 *     caller should run `applyChangeToDraft(draft, change)` then UPDATE
 *     the row to `next`. The `DraftChange` is the version-module value
 *     the caller passes to `applyChangeToDraft`.
 *   - `{ kind: "noop", next: row }` — the row is already `applied`.
 *     Idempotent re-accept; the caller does nothing.
 *   - `{ kind: "rejected", reason: "discarded" }` — the row is
 *     `discarded`; accepting a discarded stage is forbidden. The route
 *     layer maps this to 409.
 */
export type AcceptTransition =
  | { kind: "apply"; change: DraftChange; next: StagedChange }
  | { kind: "noop"; next: StagedChange }
  | { kind: "rejected"; reason: "discarded" };

export function acceptStageTransition(
  row: StagedChange,
  nowIso: string,
): AcceptTransition {
  if (row.status === "applied") {
    return { kind: "noop", next: row };
  }
  if (row.status === "discarded") {
    return { kind: "rejected", reason: "discarded" };
  }
  // pending → applied. Translate the stage payload into the canonical
  // `DraftChange` the versioning module already knows how to apply.
  const change = payloadToDraftChange(row.payload);
  const next: StagedChange = {
    ...row,
    status: "applied",
    appliedAt: nowIso,
    discardedAt: null,
    updatedAt: nowIso,
  };
  return { kind: "apply", change, next };
}

/**
 * Compute the result of discarding a staged change.
 *
 * Pure. Same idempotency contract as accept:
 *   - pending → discarded (`{ kind: "discard", next }`)
 *   - applied → applied (`{ kind: "rejected", reason: "applied" }`) —
 *     route layer maps to 409.
 *   - discarded → discarded (`{ kind: "noop", next: row }`).
 */
export type DiscardTransition =
  | { kind: "discard"; next: StagedChange }
  | { kind: "noop"; next: StagedChange }
  | { kind: "rejected"; reason: "applied" };

export function discardStageTransition(
  row: StagedChange,
  nowIso: string,
): DiscardTransition {
  if (row.status === "discarded") {
    return { kind: "noop", next: row };
  }
  if (row.status === "applied") {
    return { kind: "rejected", reason: "applied" };
  }
  const next: StagedChange = {
    ...row,
    status: "discarded",
    discardedAt: nowIso,
    appliedAt: null,
    updatedAt: nowIso,
  };
  return { kind: "discard", next };
}

/**
 * Translate a stored `StagePayload` to the `DraftChange` the versioning
 * module's `applyChangeToDraft` understands. Pure — no DB, no logger.
 *
 * Exported for the rare caller (e.g. a future audit tool) that wants to
 * preview what a stage would apply without actually accepting it.
 */
export function payloadToDraftChange(payload: StagePayload): DraftChange {
  switch (payload.kind) {
    case "remove_card":
      return { kind: "removeCard", cardId: payload.cardId };
    case "edit_sql":
      return { kind: "editSql", cardId: payload.cardId, newSql: payload.newSql };
  }
}

// ---------------------------------------------------------------------------
// DB helpers — the thin wrappers
// ---------------------------------------------------------------------------

function rowToStagedChange(r: Record<string, unknown>): StagedChange {
  const payload =
    typeof r.payload === "string"
      ? (JSON.parse(r.payload) as StagePayload)
      : (r.payload as StagePayload);
  return {
    id: r.id as string,
    dashboardId: r.dashboard_id as string,
    userId: r.user_id as string,
    kind: r.kind as StageKind,
    payload,
    status: r.status as StageStatus,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    appliedAt: r.applied_at == null ? null : String(r.applied_at),
    discardedAt: r.discarded_at == null ? null : String(r.discarded_at),
  };
}

export type StageChangeResult =
  | { ok: true; stage: StagedChange }
  | { ok: false; reason: "no_db" | "error" };

/**
 * Queue a destructive change as a pending stage.
 *
 * Caller is responsible for org-scoping (the bound editor tools resolve
 * the bound dashboard via `resolveBoundDashboard` before calling this).
 * We INSERT with `RETURNING *` so the route can echo the full row back
 * to the agent — the stage id flows into the chat's accept/discard
 * affordances.
 *
 * Multiple stages against the same card are allowed (the schema does
 * NOT enforce a per-card uniqueness constraint). This is intentional:
 * the agent might queue "delete card 3" → user clarifies "actually
 * rewrite its SQL" → agent stages an `edit_sql` against the same card.
 * Each is independently accepted or discarded; we don't pre-collapse
 * server-side because the UI surfaces them as distinct ghost changes.
 */
export async function stageChange(opts: {
  dashboardId: string;
  userId: string;
  payload: StagePayload;
}): Promise<StageChangeResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const rows = await internalQuery<Record<string, unknown>>(
      `INSERT INTO dashboard_stage_changes
         (dashboard_id, user_id, kind, payload, status)
       VALUES ($1, $2, $3, $4::jsonb, 'pending')
       RETURNING id, dashboard_id, user_id, kind, payload, status,
                 created_at, updated_at, applied_at, discarded_at`,
      [
        opts.dashboardId,
        opts.userId,
        opts.payload.kind,
        JSON.stringify(opts.payload),
      ],
    );
    if (rows.length === 0) return { ok: false, reason: "error" };
    return { ok: true, stage: rowToStagedChange(rows[0]!) };
  } catch (err) {
    log.error(
      { err: errorMessage(err), dashboardId: opts.dashboardId, userId: opts.userId },
      "stageChange failed",
    );
    return { ok: false, reason: "error" };
  }
}

/**
 * Look up a stage row by id, gated on the supplied user. Returns null
 * if the row doesn't exist OR belongs to a different user — an attacker
 * stamping someone else's stage id can't probe for existence.
 */
export async function loadStagedChange(
  stageId: string,
  userId: string,
): Promise<StagedChange | null> {
  if (!hasInternalDB()) return null;
  try {
    const rows = await internalQuery<Record<string, unknown>>(
      `SELECT id, dashboard_id, user_id, kind, payload, status,
              created_at, updated_at, applied_at, discarded_at
         FROM dashboard_stage_changes
        WHERE id = $1 AND user_id = $2`,
      [stageId, userId],
    );
    if (rows.length === 0) return null;
    return rowToStagedChange(rows[0]!);
  } catch (err) {
    log.error({ err: errorMessage(err), stageId, userId }, "loadStagedChange failed");
    return null;
  }
}

/**
 * List the user's pending stages for a dashboard. Drives the ghost
 * overlay on the dashboard view. Terminal rows (applied / discarded)
 * are excluded — they're kept for the audit trail but don't render.
 *
 * Caller is responsible for org-scoping the dashboard before calling
 * this (the route layer loads the dashboard via the org-scoped
 * `getDashboard` first).
 */
export async function listStagedChangesForUser(
  dashboardId: string,
  userId: string,
): Promise<StagedChange[]> {
  if (!hasInternalDB()) return [];
  try {
    const rows = await internalQuery<Record<string, unknown>>(
      `SELECT id, dashboard_id, user_id, kind, payload, status,
              created_at, updated_at, applied_at, discarded_at
         FROM dashboard_stage_changes
        WHERE dashboard_id = $1
          AND user_id = $2
          AND status = 'pending'
        ORDER BY created_at ASC`,
      [dashboardId, userId],
    );
    return rows.map((r) => rowToStagedChange(r));
  } catch (err) {
    log.error(
      { err: errorMessage(err), dashboardId, userId },
      "listStagedChangesForUser failed",
    );
    return [];
  }
}

export type AcceptStagedChangeResult =
  | { ok: true; stage: StagedChange; applied: boolean }
  | { ok: false; reason: "no_db" | "not_found" | "rejected" | "unknown_card" | "no_draft" | "error" };

/**
 * Accept a staged change: apply it to the user's draft and flip the
 * stage to `applied` in a single transaction.
 *
 * Acceptance walks four steps:
 *   1. Load the stage row, gated on `(stageId, userId)`. 404 if missing.
 *   2. Compute the transition (`pending → applied`, or idempotent noop
 *      on `applied`, or rejected on `discarded`).
 *   3. Load the dashboard (org-scoped) + fork-or-load the user's draft,
 *      apply the change via `applyChangeToDraft`. Bail with
 *      `unknown_card` if the draft no longer knows about the card.
 *   4. Transactionally UPDATE the draft snapshot + UPDATE the stage to
 *      `applied`. If either step throws, ROLLBACK leaves both untouched.
 *
 * The acceptance criterion "accept applies the staged change to the
 * user's draft via the versioning module from #2364" is preserved
 * exactly by step 3.
 *
 * Returns `{ ok: true, applied: false }` for the idempotent noop case
 * (already applied) so the route layer can return 200 without re-running
 * the side effect.
 */
export async function acceptStagedChange(opts: {
  stageId: string;
  userId: string;
  orgId: string | null | undefined;
}): Promise<AcceptStagedChangeResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  const row = await loadStagedChange(opts.stageId, opts.userId);
  if (!row) return { ok: false, reason: "not_found" };

  const nowIso = new Date().toISOString();
  const transition = acceptStageTransition(row, nowIso);

  if (transition.kind === "rejected") {
    return { ok: false, reason: "rejected" };
  }

  if (transition.kind === "noop") {
    return { ok: true, stage: transition.next, applied: false };
  }

  // pending → applied. Run the draft mutation + the status flip in a
  // single transaction so a draft write that fails leaves the stage
  // pending (and vice versa).
  const dash = await getDashboard(row.dashboardId, { orgId: opts.orgId ?? undefined });
  if (!dash.ok) {
    return { ok: false, reason: "not_found" };
  }
  const draftRow = await forkOrLoadDraft(opts.userId, dash.data);
  if (!draftRow) {
    return { ok: false, reason: "no_draft" };
  }

  const applied = applyChangeToDraft(draftRow.snapshot, transition.change);
  if (!applied.ok) {
    return { ok: false, reason: "unknown_card" };
  }

  const pool = getInternalDB();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE dashboard_user_drafts
          SET draft = $1::jsonb,
              updated_at = now()
        WHERE user_id = $2 AND dashboard_id = $3`,
      [JSON.stringify(applied.snapshot), opts.userId, row.dashboardId],
    );
    const updateRows = await client.query(
      `UPDATE dashboard_stage_changes
          SET status = 'applied',
              applied_at = now(),
              discarded_at = NULL,
              updated_at = now()
        WHERE id = $1 AND user_id = $2 AND status = 'pending'
        RETURNING id, dashboard_id, user_id, kind, payload, status,
                  created_at, updated_at, applied_at, discarded_at`,
      [opts.stageId, opts.userId],
    );
    await client.query("COMMIT");
    if (updateRows.rows.length === 0) {
      // The row flipped under us between the load and the UPDATE — surface
      // as not_found so the UI re-fetches the stage list. The transaction
      // committed an idempotent draft update; the next render reconciles.
      return { ok: false, reason: "not_found" };
    }
    return {
      ok: true,
      stage: rowToStagedChange(updateRows.rows[0]!),
      applied: true,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      log.warn(
        { err: errorMessage(rollbackErr), stageId: opts.stageId, userId: opts.userId },
        "acceptStagedChange ROLLBACK failed",
      );
    }
    log.error(
      { err: errorMessage(err), stageId: opts.stageId, userId: opts.userId },
      "acceptStagedChange transaction failed",
    );
    return { ok: false, reason: "error" };
  } finally {
    client.release();
  }
}

export type DiscardStagedChangeResult =
  | { ok: true; stage: StagedChange; discarded: boolean }
  | { ok: false; reason: "no_db" | "not_found" | "rejected" | "error" };

/**
 * Discard a staged change: flip its status to `discarded`. No draft
 * mutation; the user is throwing the stage away. Idempotent on rows
 * that are already discarded; rejected on rows that are already applied
 * (the route layer maps to 409 — "you can't un-apply an accepted edit").
 */
export async function discardStagedChange(opts: {
  stageId: string;
  userId: string;
}): Promise<DiscardStagedChangeResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  const row = await loadStagedChange(opts.stageId, opts.userId);
  if (!row) return { ok: false, reason: "not_found" };

  const nowIso = new Date().toISOString();
  const transition = discardStageTransition(row, nowIso);

  if (transition.kind === "rejected") {
    return { ok: false, reason: "rejected" };
  }
  if (transition.kind === "noop") {
    return { ok: true, stage: transition.next, discarded: false };
  }

  try {
    const rows = await internalQuery<Record<string, unknown>>(
      `UPDATE dashboard_stage_changes
          SET status = 'discarded',
              discarded_at = now(),
              applied_at = NULL,
              updated_at = now()
        WHERE id = $1 AND user_id = $2 AND status = 'pending'
        RETURNING id, dashboard_id, user_id, kind, payload, status,
                  created_at, updated_at, applied_at, discarded_at`,
      [opts.stageId, opts.userId],
    );
    if (rows.length === 0) {
      // Status flipped between load and UPDATE — surface as not_found so
      // the UI re-fetches. No side-effects to roll back.
      return { ok: false, reason: "not_found" };
    }
    return { ok: true, stage: rowToStagedChange(rows[0]!), discarded: true };
  } catch (err) {
    log.error(
      { err: errorMessage(err), stageId: opts.stageId, userId: opts.userId },
      "discardStagedChange failed",
    );
    return { ok: false, reason: "error" };
  }
}
