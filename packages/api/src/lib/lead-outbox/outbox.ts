/**
 * Lead outbox — durable queue for SaaS CRM lead dispatches (#2729,
 * slice 2 of 1.6.0).
 *
 * This module is generic over the dispatcher: it owns the queue
 * mechanics (enqueue, claim, sub-step persistence, backoff, dead-letter,
 * startup recovery) and delegates the actual upstream call to a
 * pluggable `OutboxDispatcher`. The Twenty-specific dispatcher lives in
 * `ee/src/saas-crm/index.ts` so the `core → ee` inversion (enforced by
 * `scripts/check-ee-imports.sh`) stays intact.
 *
 * Idempotency contract: the dispatcher receives the row's current
 * `twentyPersonId` / `twentyNoteId` snapshot and must skip any sub-step
 * whose ID is already populated. After each successful sub-step the
 * dispatcher calls back into `persist.setTwentyPersonId` /
 * `setTwentyNoteId` which UPDATEs the column immediately. This is what
 * makes "upsertPerson succeeded, createNote crashed before commit"
 * safe — the next flush sees `twentyPersonId` set and skips upsertPerson.
 * (createNote follows the same pattern once it lands — see the
 * placeholder in `ee/src/saas-crm/index.ts:dispatchOutboxRow`.)
 *
 * Concurrency: the claim is a single `UPDATE … WHERE id IN (SELECT …
 * FOR UPDATE SKIP LOCKED) RETURNING *` statement. Multiple flusher
 * workers (today there is one per pod; tomorrow's horizontal scale
 * lands free) cannot double-claim a row.
 *
 * Retry-After: when the dispatcher surfaces a transient outcome with a
 * `retryAfterMs` (parsed from the upstream `Retry-After` header on a
 * 429 or similar), the flusher stamps `retry_after = now() + delay` on
 * the row. The claim WHERE then prefers that timestamp over the
 * tier-based backoff via `COALESCE(retry_after, created_at + tier)`,
 * so the upstream's requested delay always wins.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { CLAIM_DELAY_SQL, DEAD_AFTER_ATTEMPTS } from "./backoff";

/**
 * Narrow DB surface the outbox needs. Matches the `query` method on
 * `InternalDBShape` and on the module-level `internalQuery` standalone
 * function, so the EE dispatcher can hand in either. Keeping the
 * dependency narrow makes the unit tests trivial (pass any object with
 * a `query` method) and avoids dragging the full `InternalDB` Tag into
 * `lib/lead-outbox/` consumers.
 */
export interface OutboxDB {
  query<T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
}

const log = createLogger("lead-outbox");

// ─────────────────────────────────────────────────────────────────────
//  Public types
// ─────────────────────────────────────────────────────────────────────

/**
 * Outbox lifecycle states. Mirrors the `crm_outbox_status_chk` CHECK
 * constraint exactly. Use this everywhere a status literal is referenced
 * (SQL or Drizzle) so a typo fails at compile time, not at runtime when
 * the CHECK fires.
 */
export type OutboxStatus = "pending" | "in_flight" | "done" | "dead";

/** What a freshly-enqueued row looks like before any dispatch attempt. */
export interface EnqueueInput {
  /** Discriminator for the dispatcher's switch (e.g., "demo", "sales-form"). */
  readonly eventType: string;
  /** Opaque payload the dispatcher knows how to interpret. */
  readonly payload: Record<string, unknown>;
}

/**
 * Snapshot of a row at the moment the flusher claimed it. The omission
 * of `status` is deliberate: the claim has already flipped this row to
 * `in_flight`, and the dispatcher's contract is "do work, return an
 * outcome" — no caller should need to branch on the lifecycle state of
 * a row it's currently holding.
 */
export interface ClaimedOutboxRow {
  readonly id: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly attempts: number;
  // TODO(#2729-followup): rename to a generic `resourceIds` record if a
  // second SaaS CRM ever ships — the Twenty-specific naming leaks
  // vendor specifics into the otherwise-generic outbox surface.
  readonly twentyPersonId: string | null;
  readonly twentyNoteId: string | null;
}

/**
 * Sub-step persistence helpers passed to the dispatcher. Each callback
 * does a single targeted UPDATE — the writes happen inline so the next
 * claim of this row (on a retry) sees the populated ID and can skip.
 */
export interface OutboxPersistHelpers {
  // TODO(#2729-followup): generalise to `setResourceId(key, id)` if a
  // second SaaS CRM ever ships. See ClaimedOutboxRow for context.
  setTwentyPersonId(id: string): Promise<void>;
  setTwentyNoteId(id: string): Promise<void>;
}

/**
 * Dispatcher classification of an error. The outbox uses this to decide
 * dead-letter vs retry without needing to know about
 * `TwentyClientError` or any other domain type.
 *
 * `transient.retryAfterMs` lets the dispatcher honour an upstream
 * `Retry-After` header (typically on a 429). When set, the flusher
 * stamps `retry_after = now() + retryAfterMs` on the row and the
 * claim WHERE prefers that over the tier-based backoff.
 *
 * `transient.httpStatus` / `permanent.httpStatus` are optional carriers
 * for the upstream HTTP status code. The flusher doesn't use them today
 * — they're surfaced so a future admin UI (#2735) can bucket
 * dead-letter rows by status without re-parsing log strings.
 */
export type DispatchOutcome =
  | { readonly kind: "ok" }
  | {
      readonly kind: "transient";
      readonly message: string;
      readonly retryAfterMs?: number;
      readonly httpStatus?: number;
    }
  | {
      readonly kind: "permanent";
      readonly message: string;
      readonly httpStatus?: number;
    };

/**
 * Pluggable dispatcher. The implementation owns the upstream call(s)
 * AND owns the decision of whether a thrown error is transient or
 * permanent (because only it knows which library's errors are which).
 */
export type OutboxDispatcher = (
  row: ClaimedOutboxRow,
  persist: OutboxPersistHelpers,
) => Promise<DispatchOutcome>;

export interface FlushResult {
  readonly claimed: number;
  readonly ok: number;
  readonly transient: number;
  readonly permanent: number;
}

// ─────────────────────────────────────────────────────────────────────
//  SQL — hoisted as top-level constants so each statement is greppable
//  and the `CLAIM_DELAY_SQL` interpolation point is colocated with the
//  WHERE clause it shapes.
// ─────────────────────────────────────────────────────────────────────

const ENQUEUE_SQL = `
  INSERT INTO crm_outbox (event_type, payload, status)
  VALUES ($1, $2::jsonb, 'pending')
  RETURNING id
`;

/**
 * Single-statement claim. The inner SELECT uses `FOR UPDATE SKIP
 * LOCKED` so concurrent flushers walk disjoint sets of pending rows
 * without blocking each other. The outer UPDATE atomically flips
 * status and bumps `attempts`.
 *
 * `attempts < DEAD_AFTER_ATTEMPTS` is enforced here AND in the
 * permanent-dispatch branch — the WHERE clause is the load-bearing
 * gate (rows past the threshold simply stop being claimable).
 *
 * Backoff gate: `COALESCE(retry_after, created_at + tier) <= now()`.
 * When the previous failure surfaced a Retry-After header, the
 * absolute `retry_after` timestamp wins; otherwise we fall back to
 * the tier-based delay measured from `created_at`. The COALESCE
 * keeps a long upstream-requested delay from being clobbered by an
 * eager tier value (e.g. 30s tier-1 vs `Retry-After: 3600`).
 */
const CLAIM_SQL = `
  UPDATE crm_outbox
  SET status = 'in_flight',
      attempts = attempts + 1,
      claimed_at = now()
  WHERE id IN (
    SELECT id FROM crm_outbox
    WHERE status = 'pending'
      AND attempts < ${DEAD_AFTER_ATTEMPTS}
      AND COALESCE(retry_after, created_at + (${CLAIM_DELAY_SQL})) <= now()
    ORDER BY created_at
    LIMIT $1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING id, event_type, payload, attempts, twenty_person_id, twenty_note_id
`;

const PERSIST_PERSON_ID_SQL = `
  UPDATE crm_outbox SET twenty_person_id = $1 WHERE id = $2
`;

const PERSIST_NOTE_ID_SQL = `
  UPDATE crm_outbox SET twenty_note_id = $1 WHERE id = $2
`;

const MARK_DONE_SQL = `
  UPDATE crm_outbox
  SET status = 'done',
      processed_at = now(),
      last_error = NULL,
      retry_after = NULL,
      claimed_at = NULL
  WHERE id = $1
`;

/**
 * Transient mark. `$3` is either an absolute timestamp (when the
 * upstream supplied a parseable Retry-After) or NULL (clears any
 * previous retry_after so the row falls back to the tier-based gate
 * on the next claim). `claimed_at` is cleared so the recovery sweep's
 * staleness gate doesn't trip on a row that's already back to pending.
 */
const MARK_TRANSIENT_FAIL_SQL = `
  UPDATE crm_outbox
  SET status = 'pending',
      last_error = $1,
      retry_after = $3,
      claimed_at = NULL
  WHERE id = $2
`;

const MARK_DEAD_SQL = `
  UPDATE crm_outbox
  SET status = 'dead',
      processed_at = now(),
      last_error = $1,
      retry_after = NULL,
      claimed_at = NULL
  WHERE id = $2
`;

/**
 * Recovery sweep — splits the in_flight set into two buckets:
 *
 *  1. **Exhausted carcasses** (`attempts >= DEAD_AFTER_ATTEMPTS`) move
 *     straight to `status = 'dead'`. Without this they'd land in
 *     `pending` and never re-claim (the claim WHERE filters them),
 *     hiding terminal failures from a `status = 'dead'` triage query.
 *     (Codex P3, 2026-05-25.)
 *  2. **Stale carcasses** (claimed > `$1` ms ago, OR never stamped)
 *     return to `pending` for re-claim. The age threshold protects
 *     concurrent peer pods in a multi-pod deployment — a sibling pod
 *     that claimed the row 5s ago is NOT reset out from under its
 *     still-running dispatcher. (Codex P1, 2026-05-25.)
 *
 * `retry_after` is preserved across both branches: the upstream's
 * rate-limit window does not reset when we crash, so a recovered row
 * still respects any prior Retry-After before its next claim.
 *
 * Returns the count of rows touched (dead + reset, combined).
 */
const MARK_EXHAUSTED_IN_FLIGHT_DEAD_SQL = `
  UPDATE crm_outbox
  SET status = 'dead', processed_at = now(),
      last_error = CASE
        WHEN last_error IS NULL OR last_error = ''
          THEN 'crashed mid-dispatch at attempts=' || attempts || ' (recovery)'
        ELSE last_error || ' [crashed mid-dispatch at attempts=' || attempts || ', recovery dead-lettered]'
      END
  WHERE status = 'in_flight'
    AND attempts >= ${DEAD_AFTER_ATTEMPTS}
  RETURNING id
`;

const RECOVER_STALE_IN_FLIGHT_SQL = `
  UPDATE crm_outbox
  SET status = 'pending'
  WHERE status = 'in_flight'
    AND attempts < ${DEAD_AFTER_ATTEMPTS}
    AND (claimed_at IS NULL OR claimed_at < now() - ($1::int * INTERVAL '1 millisecond'))
  RETURNING id
`;

/**
 * Recovery age thresholds. Startup uses a generous window so any
 * still-running peer pod's dispatch finishes before we'd interfere;
 * shutdown can use a shorter window since the dying pod's OWN
 * dispatcher has just been interrupted (and the only concern is peer
 * pods that may have claimed rows in the last few seconds).
 */
export const STARTUP_RECOVERY_STALE_MS = 5 * 60_000; // 5 min
export const SHUTDOWN_RECOVERY_STALE_MS = 30_000;   // 30 s

// ─────────────────────────────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────────────────────────────

/** Insert a row in `pending` status. Returns the new row id. */
export async function enqueue(
  db: OutboxDB,
  input: EnqueueInput,
): Promise<string> {
  const rows = await db.query<{ id: string }>(ENQUEUE_SQL, [
    input.eventType,
    JSON.stringify(input.payload),
  ]);
  const id = rows[0]?.id;
  if (!id) {
    // INSERT … RETURNING with no row back is a driver-level invariant
    // violation — fail loud rather than silently drop the enqueue.
    throw new Error("crm_outbox enqueue returned no row");
  }
  return id;
}

/**
 * Reset stale `in_flight` rows. Call at Layer init AND from the
 * shutdown finalizer.
 *
 * The `staleAgeMs` option gates which rows are touched:
 *  - Rows whose `claimed_at` is older than `staleAgeMs` (or NULL) are
 *    presumed dead and either:
 *      - moved to `dead` if `attempts >= DEAD_AFTER_ATTEMPTS` (Codex P3)
 *      - reset to `pending` otherwise
 *  - Rows recently claimed (i.e. a sibling pod is actively working
 *    them) are left alone — protects multi-pod deploys from
 *    double-dispatch (Codex P1).
 *
 * Returns a per-bucket count for logging.
 */
export interface RecoveryResult {
  readonly deadLettered: number;
  readonly reset: number;
}

export async function recoverInFlight(
  db: OutboxDB,
  staleAgeMs: number = STARTUP_RECOVERY_STALE_MS,
): Promise<RecoveryResult> {
  // Dead-letter exhausted rows first — these don't care about staleness
  // (a row claimed 1s ago that's already exhausted is still terminally
  // failed and should not retry).
  const dead = await db.query<{ id: string }>(MARK_EXHAUSTED_IN_FLIGHT_DEAD_SQL);
  const reset = await db.query<{ id: string }>(RECOVER_STALE_IN_FLIGHT_SQL, [staleAgeMs]);
  return { deadLettered: dead.length, reset: reset.length };
}

/**
 * Claim a batch of pending-and-due rows, dispatch each, persist per-
 * sub-step IDs, and stamp final status. Returns counts so the caller
 * can log / surface metrics in a later slice.
 *
 * Errors from the dispatcher are NEVER re-thrown — they're caught and
 * the row's status is updated according to `DispatchOutcome`. An
 * uncaught defect (e.g. the dispatcher itself throws something it
 * shouldn't) is logged and the row is treated as transient (will retry
 * with backoff) — anything else would leak `in_flight` rows that
 * `recoverInFlight` would need to mop up on the next restart.
 */
export async function flushBatch(
  db: OutboxDB,
  dispatcher: OutboxDispatcher,
  batchLimit: number,
): Promise<FlushResult> {
  if (batchLimit <= 0) return { claimed: 0, ok: 0, transient: 0, permanent: 0 };

  type ClaimedRow = {
    id: string;
    event_type: string;
    payload: unknown;
    attempts: number;
    twenty_person_id: string | null;
    twenty_note_id: string | null;
  };
  const claimed = await db.query<ClaimedRow>(CLAIM_SQL, [batchLimit]);
  let ok = 0;
  let transient = 0;
  let permanent = 0;

  for (const raw of claimed) {
    const row: ClaimedOutboxRow = {
      id: raw.id,
      eventType: raw.event_type,
      payload: raw.payload,
      attempts: raw.attempts,
      twentyPersonId: raw.twenty_person_id,
      twentyNoteId: raw.twenty_note_id,
    };

    const persist: OutboxPersistHelpers = {
      setTwentyPersonId: async (id) => {
        await db.query(PERSIST_PERSON_ID_SQL, [id, row.id]);
      },
      setTwentyNoteId: async (id) => {
        await db.query(PERSIST_NOTE_ID_SQL, [id, row.id]);
      },
    };

    let outcome: DispatchOutcome;
    try {
      outcome = await dispatcher(row, persist);
    } catch (err) {
      // Dispatcher contract violation: it should classify and return,
      // never throw. Treat as transient so we don't dead-letter on a
      // bug in the dispatcher's error handling.
      log.error(
        {
          rowId: row.id,
          attempts: row.attempts,
          err: err instanceof Error ? err.message : String(err),
          event: "lead_outbox.dispatcher_threw",
        },
        "Dispatcher threw — classifying as transient so the row will retry",
      );
      outcome = {
        kind: "transient",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    if (outcome.kind === "ok") {
      await markStatusWithRetry(db, MARK_DONE_SQL, [row.id], row.id, "done");
      ok++;
      continue;
    }

    if (outcome.kind === "permanent") {
      await markStatusWithRetry(
        db,
        MARK_DEAD_SQL,
        [outcome.message, row.id],
        row.id,
        "dead",
      );
      log.error(
        {
          rowId: row.id,
          attempts: row.attempts,
          err: outcome.message,
          event: "lead_outbox.dead_letter_permanent",
        },
        "Lead dead-lettered (permanent failure) — operator intervention required",
      );
      permanent++;
      continue;
    }

    // Transient. If we've already burned through the retry budget the
    // row dies here too — the claim WHERE wouldn't let us pick it up
    // again, so leaving it `pending` would be a silent stuck-forever
    // row.
    if (row.attempts >= DEAD_AFTER_ATTEMPTS) {
      await markStatusWithRetry(
        db,
        MARK_DEAD_SQL,
        [
          `transient failure after ${DEAD_AFTER_ATTEMPTS} attempts: ${outcome.message}`,
          row.id,
        ],
        row.id,
        "dead",
      );
      log.error(
        {
          rowId: row.id,
          attempts: row.attempts,
          err: outcome.message,
          event: "lead_outbox.dead_letter_exhausted",
        },
        `Lead dead-lettered (retry budget exhausted)`,
      );
      permanent++;
      continue;
    }

    const retryAfter = computeRetryAfterTimestamp(outcome.retryAfterMs);
    await markStatusWithRetry(
      db,
      MARK_TRANSIENT_FAIL_SQL,
      [outcome.message, row.id, retryAfter],
      row.id,
      "pending",
    );
    log.warn(
      {
        rowId: row.id,
        attempts: row.attempts,
        err: outcome.message,
        retryAfterMs: outcome.retryAfterMs ?? null,
        event: "lead_outbox.transient_failure",
      },
      "Lead dispatch failed (transient) — will retry with backoff",
    );
    transient++;
  }

  return { claimed: claimed.length, ok, transient, permanent };
}

/**
 * Compute the absolute `retry_after` timestamp for a transient outcome
 * with an upstream-specified delay. Returns `null` when the outcome
 * carries no header (the SQL clears the column on every transient mark
 * so a prior Retry-After can't strand a row).
 *
 * Exported for tests; not part of the dispatcher contract.
 */
export function computeRetryAfterTimestamp(retryAfterMs: number | undefined): Date | null {
  if (retryAfterMs == null) return null;
  if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) return null;
  return new Date(Date.now() + retryAfterMs);
}

/**
 * Single-retry wrapper around a terminal-status UPDATE. If the first
 * write fails (Postgres connection blip between dispatch return and
 * status stamp), wait briefly and try once more. If both fail, log
 * loudly and re-throw so the tick's outer Effect.catchAll records the
 * tick as failed — the row stays `in_flight` and `recoverInFlight`
 * mops it up on the next boot. Without this, an isolated network
 * hiccup at the wrong moment strands the row until restart.
 */
async function markStatusWithRetry(
  db: OutboxDB,
  sql: string,
  params: unknown[],
  rowId: string,
  intent: OutboxStatus,
): Promise<void> {
  try {
    await db.query(sql, params);
    return;
  } catch (err) {
    log.warn(
      {
        rowId,
        intent,
        err: err instanceof Error ? err.message : String(err),
        event: "lead_outbox.status_update_retrying",
      },
      "Outbox terminal-status UPDATE failed — retrying once before letting the row strand",
    );
    // Briefly defer so a transient pool error has a chance to clear.
    // 50ms is short enough that the tick doesn't visibly slow but long
    // enough for the pg pool to swap a broken connection.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.query(sql, params);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Configuration
// ─────────────────────────────────────────────────────────────────────

/**
 * Tick interval. Default 5s per the issue; configurable via
 * `ATLAS_CRM_OUTBOX_TICK_SECONDS` for operators who want to dial it
 * down (e.g. SaaS-region traffic spike) without redeploying.
 *
 * Clamped to `[1, 3600]` seconds (1s … 1h). The upper bound avoids a
 * Bun timer overflow at >~2^31 ms — without the clamp, a typo'd
 * `ATLAS_CRM_OUTBOX_TICK_SECONDS=3600000` (operator meant ms) would
 * overflow to a 1ms tick and DDoS Postgres + Twenty (Codex P2,
 * 2026-05-25). The lower bound prevents an accidental 0.x-second
 * tick from doing the same. Out-of-range inputs warn-and-clamp
 * rather than silently default — the operator's intent (faster /
 * slower) is preserved at the boundary value.
 */
export const MIN_TICK_SECONDS = 1;
export const MAX_TICK_SECONDS = 3600;
export const DEFAULT_TICK_SECONDS = 5;

export function getTickIntervalMs(): number {
  const raw = process.env.ATLAS_CRM_OUTBOX_TICK_SECONDS;
  if (!raw) return DEFAULT_TICK_SECONDS * 1_000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TICK_SECONDS * 1_000;
  if (parsed < MIN_TICK_SECONDS) {
    log.warn(
      { requested: parsed, clamped: MIN_TICK_SECONDS, event: "lead_outbox.tick_clamped" },
      `ATLAS_CRM_OUTBOX_TICK_SECONDS=${parsed} is below ${MIN_TICK_SECONDS}s minimum — clamping`,
    );
    return MIN_TICK_SECONDS * 1_000;
  }
  if (parsed > MAX_TICK_SECONDS) {
    log.warn(
      { requested: parsed, clamped: MAX_TICK_SECONDS, event: "lead_outbox.tick_clamped" },
      `ATLAS_CRM_OUTBOX_TICK_SECONDS=${parsed} exceeds ${MAX_TICK_SECONDS}s maximum — clamping`,
    );
    return MAX_TICK_SECONDS * 1_000;
  }
  return parsed * 1_000;
}

/**
 * Per-tick claim batch size. Capped at 50 to keep a single tick's
 * fan-out to Twenty bounded — a multi-thousand-row backlog is recovered
 * across many ticks rather than starving the upstream rate limit in one.
 */
export const FLUSH_BATCH_LIMIT = 50;
