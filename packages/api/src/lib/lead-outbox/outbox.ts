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
 * safe — the next flush sees `twentyPersonId` set, skips upsertPerson,
 * and goes straight to createNote.
 *
 * Concurrency: the claim is a single `UPDATE … WHERE id IN (SELECT …
 * FOR UPDATE SKIP LOCKED) RETURNING *` statement. Multiple flusher
 * workers (today there is one per pod; tomorrow's horizontal scale
 * lands free) cannot double-claim a row.
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

/** What a freshly-enqueued row looks like before any dispatch attempt. */
export interface EnqueueInput {
  /** Discriminator for the dispatcher's switch (e.g., "demo", "sales-form"). */
  readonly eventType: string;
  /** Opaque payload the dispatcher knows how to interpret. */
  readonly payload: Record<string, unknown>;
}

/** Snapshot of a row at the moment the flusher claimed it. */
export interface ClaimedOutboxRow {
  readonly id: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly attempts: number;
  readonly twentyPersonId: string | null;
  readonly twentyNoteId: string | null;
}

/**
 * Sub-step persistence helpers passed to the dispatcher. Each callback
 * does a single targeted UPDATE — the writes happen inline so the next
 * claim of this row (on a retry) sees the populated ID and can skip.
 */
export interface OutboxPersistHelpers {
  setTwentyPersonId(id: string): Promise<void>;
  setTwentyNoteId(id: string): Promise<void>;
}

/**
 * Dispatcher classification of an error. The outbox uses this to decide
 * dead-letter vs retry without needing to know about
 * `TwentyClientError` or any other domain type.
 */
export type DispatchOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "transient"; readonly message: string }
  | { readonly kind: "permanent"; readonly message: string };

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
//  SQL — kept as top-level constants so the test discipline gate
//  doesn't need to grep through string concatenation.
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
 */
const CLAIM_SQL = `
  UPDATE crm_outbox
  SET status = 'in_flight',
      attempts = attempts + 1
  WHERE id IN (
    SELECT id FROM crm_outbox
    WHERE status = 'pending'
      AND attempts < ${DEAD_AFTER_ATTEMPTS}
      AND created_at + (${CLAIM_DELAY_SQL}) <= now()
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
  SET status = 'done', processed_at = now(), last_error = NULL
  WHERE id = $1
`;

const MARK_TRANSIENT_FAIL_SQL = `
  UPDATE crm_outbox
  SET status = 'pending', last_error = $1
  WHERE id = $2
`;

const MARK_DEAD_SQL = `
  UPDATE crm_outbox
  SET status = 'dead', processed_at = now(), last_error = $1
  WHERE id = $2
`;

/**
 * Startup recovery: any `in_flight` row at boot is the carcass of a
 * crash mid-dispatch. Resetting to `pending` lets the next tick claim
 * it. `attempts` is NOT decremented — the previous flush already
 * incremented it (claim does `attempts = attempts + 1` atomically), so
 * if it's already at `DEAD_AFTER_ATTEMPTS` the claim WHERE filters it
 * out and the row stays pending forever. That's intentional: a row
 * that's crashed the process 6 times in a row is a poison pill and
 * deserves operator attention, not another silent retry.
 */
const RECOVER_IN_FLIGHT_SQL = `
  UPDATE crm_outbox SET status = 'pending'
  WHERE status = 'in_flight'
`;

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
 * Reset every `in_flight` row to `pending`. Call at Layer init (before
 * the tick fiber starts) AND from the shutdown finalizer (so SIGTERM
 * mid-dispatch doesn't strand rows). Returns the number of rows
 * affected — useful for boot logging.
 */
export async function recoverInFlight(db: OutboxDB): Promise<number> {
  const result = await db.query<{ id: string }>(`${RECOVER_IN_FLIGHT_SQL} RETURNING id`);
  return result.length;
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
      await db.query(MARK_DONE_SQL, [row.id]);
      ok++;
      continue;
    }

    if (outcome.kind === "permanent") {
      await db.query(MARK_DEAD_SQL, [outcome.message, row.id]);
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
      await db.query(MARK_DEAD_SQL, [
        `transient failure after ${DEAD_AFTER_ATTEMPTS} attempts: ${outcome.message}`,
        row.id,
      ]);
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

    await db.query(MARK_TRANSIENT_FAIL_SQL, [outcome.message, row.id]);
    log.warn(
      {
        rowId: row.id,
        attempts: row.attempts,
        err: outcome.message,
        event: "lead_outbox.transient_failure",
      },
      "Lead dispatch failed (transient) — will retry with backoff",
    );
    transient++;
  }

  return { claimed: claimed.length, ok, transient, permanent };
}

// ─────────────────────────────────────────────────────────────────────
//  Configuration
// ─────────────────────────────────────────────────────────────────────

/**
 * Tick interval. Default 5s per the issue; configurable via
 * `ATLAS_CRM_OUTBOX_TICK_SECONDS` for operators who want to dial it
 * down (e.g. SaaS-region traffic spike) without redeploying.
 */
export function getTickIntervalMs(): number {
  const raw = process.env.ATLAS_CRM_OUTBOX_TICK_SECONDS;
  if (!raw) return 5_000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 5_000;
  return parsed * 1_000;
}

/**
 * Per-tick claim batch size. Capped at 50 to keep a single tick's
 * fan-out to Twenty bounded — a multi-thousand-row backlog is recovered
 * across many ticks rather than starving the upstream rate limit in one.
 */
export const FLUSH_BATCH_LIMIT = 50;
