/**
 * Lead outbox — durable queue for SaaS CRM lead dispatches (#2729).
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
import { CLAIM_DELAY_SQL, DEAD_AFTER_ATTEMPTS, nextDelayMs } from "./backoff";
import { kickActiveFlusher } from "./signal";

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
  /**
   * Tenant attribution for per-row dispatch routing (#2849).
   *
   * The dispatcher in `ee/src/saas-crm/` reads this to decide which
   * Twenty instance receives the row: rows tagged with the resolved
   * operator workspace id (the SaaS lead-capture pipeline path) use
   * Atlas's `TWENTY_API_KEY` env creds; rows tagged with a customer
   * workspace id consult `twenty_integrations` for that workspace's
   * per-tenant credentials. The required-not-empty shape (rejected at
   * enqueue) prevents the silent "NULL workspace_id → dispatch wherever
   * the boot config points" trap that the old `findLatestTwentyDbCredentials`
   * helper enabled before #2850.
   */
  readonly workspaceId: string;
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
  /**
   * Tenant attribution for per-row dispatch routing (#2849). The
   * dispatcher branches on this to pick env creds (operator workspace)
   * vs `twenty_integrations` row (per-tenant workspace).
   */
  readonly workspaceId: string;
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
 * See `ClaimedOutboxRow.twentyPersonId`'s `TODO(#2729-followup)` for
 * the second-SaaS-CRM generalisation plan.
 */
export interface OutboxPersistHelpers {
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

/**
 * Per-row retry scheduler (#2874). `flushBatch` calls `scheduleRetry`
 * after marking a row transiently-failed so the flusher fiber wakes
 * exactly when the row comes due, instead of waiting for the next
 * backstop sweep. The production implementation is `FlusherSignal`
 * (`signal.ts`); tests pass a stub. Structural — `flushBatch` depends on
 * this narrow surface, not the concrete signal, so the queue mechanics
 * stay decoupled from the Layer-owned doorbell.
 */
export interface OutboxRetryScheduler {
  /** Wake the flusher in `delayMs` to re-attempt `rowId` (best-effort). */
  scheduleRetry(rowId: string, delayMs: number): void;
}

// ─────────────────────────────────────────────────────────────────────
//  SQL — hoisted as top-level constants so each statement is greppable
//  and the `CLAIM_DELAY_SQL` interpolation point is colocated with the
//  WHERE clause it shapes.
// ─────────────────────────────────────────────────────────────────────

const ENQUEUE_SQL = `
  INSERT INTO crm_outbox (event_type, payload, email_key, workspace_id, status)
  VALUES ($1, $2::jsonb, $3, $4, 'pending')
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
 *
 * Per-`(workspace_id, email_key)` serialization (#2870 + #2849):
 * a row is claimable only if NO blocking same-(workspace,email)
 * sibling exists. The workspace dimension is load-bearing post-
 * #2849: tenant A's `alice@example.com` and tenant B's
 * `alice@example.com` dispatch to DIFFERENT Twenty instances and
 * have independent idempotency. Without the workspace scoping
 * (codex C3), tenant A's row would block tenant B's row and
 * head-of-line-stall an unrelated CRM. Three layers cooperate:
 *
 *   1. **NOT EXISTS gate** — scoped to the same `workspace_id`,
 *      splits the predicate by sibling status:
 *      * Any `in_flight` same-(workspace,email) row blocks
 *        unconditionally (regardless of `created_at`). A rolling
 *        hotfix or manual recovery can leave a newer `in_flight`
 *        row alongside an older `pending` row — without the
 *        age-independent in_flight check, the older `pending` row
 *        would dispatch concurrently with the newer in_flight one.
 *      * Any `pending` same-(workspace,email) row blocks only if
 *        it's strictly older by `(created_at, id)`. The `id`
 *        tie-break is what serializes bulk-INSERT rows that share
 *        `created_at` (e.g. the historic-leads backfill path that
 *        produces many rows in one statement with one `now()`
 *        timestamp); without it, the next tick would see a same-
 *        `created_at` sibling as not-older and claim a second row
 *        while the first is still in_flight.
 *      The age check on `pending` is what closes the retry-cooldown
 *      leapfrog: R1 (older, in transient-fail backoff) is filtered
 *      out of `claimable` by the due-time check, but its presence as
 *      an older pending sibling still blocks R2 (newer, fresh) from
 *      flipping atlasFirstSource ahead of it.
 *   2. **Advisory xact lock per `(workspace_id, email_key)`** —
 *      `pg_try_advisory_xact_lock` gives us serialization across
 *      concurrent transactions that MVCC alone can't provide.
 *      Without it, two flusher pods could each see the other's
 *      pre-commit UPDATE as invisible, both pass the NOT EXISTS
 *      gate at lookup time, and both end up with different
 *      same-(workspace,email) rows in_flight (each pod skips the
 *      other's locked row via SKIP LOCKED, then claims a different
 *      sibling). The advisory lock is transaction-scoped: held
 *      until commit, then released, so the next tick re-acquires
 *      cleanly. The lock key is
 *      `hashtext(workspace_id || ':' || email_key)` so the lock
 *      namespace is per-(workspace,email), not per-email — preserves
 *      cross-tenant independence. NULL email_key rows skip the lock
 *      (no per-row serialization needed — those are their own dedup
 *      groups).
 *   3. **DISTINCT ON dedupe (intra-statement)** — belt-and-suspenders:
 *      within a single tick the NOT EXISTS gate already keeps only
 *      the earliest same-(workspace,email) row, but DISTINCT ON
 *      formalizes the "one row per (workspace, email_key) per batch"
 *      contract for any future WHERE-clause regression. The dedupe
 *      key is `(workspace_id, COALESCE(email_key, id::text))` so
 *      NULL-email_key rows fall back to their own id (each in its
 *      own group, dispatched independently). The `id` tie-breaker
 *      on `ORDER BY` makes claim order deterministic when two rows
 *      share `created_at` (e.g. bulk INSERT).
 *
 * The outer LIMIT applies to the deduped set, not the raw candidate
 * set, so a workspace with a backlog of same-email events drains one
 * event per (workspace, email) per tick rather than starving siblings.
 *
 * Advisory-lock namespace: the first arg `2870` (the issue number)
 * is the lock class; the second arg is the per-(workspace,email)
 * hash. The two-key variant avoids collisions with any other
 * advisory locks the codebase may take elsewhere.
 */
const CLAIM_SQL = `
  UPDATE crm_outbox
  SET status = 'in_flight',
      attempts = attempts + 1,
      claimed_at = now()
  WHERE id IN (
    WITH claimable AS (
      SELECT id, workspace_id, email_key, created_at FROM crm_outbox
      WHERE status = 'pending'
        AND attempts < ${DEAD_AFTER_ATTEMPTS}
        AND COALESCE(retry_after, created_at + (${CLAIM_DELAY_SQL})) <= now()
        AND NOT EXISTS (
          SELECT 1 FROM crm_outbox o2
          WHERE o2.email_key IS NOT NULL
            AND o2.email_key = crm_outbox.email_key
            AND o2.workspace_id = crm_outbox.workspace_id
            AND o2.id <> crm_outbox.id
            AND (
              o2.status = 'in_flight'
              OR (
                o2.status = 'pending'
                AND (o2.created_at, o2.id) < (crm_outbox.created_at, crm_outbox.id)
              )
            )
        )
        AND (
          email_key IS NULL
          OR pg_try_advisory_xact_lock(
               2870,
               hashtext(workspace_id || ':' || email_key)
             )
        )
      ORDER BY created_at, id
      FOR UPDATE SKIP LOCKED
    ),
    deduped AS (
      SELECT DISTINCT ON (workspace_id, COALESCE(email_key, id::text))
             id, created_at
      FROM claimable
      ORDER BY workspace_id, COALESCE(email_key, id::text), created_at, id
    )
    SELECT id FROM deduped ORDER BY created_at, id LIMIT $1
  )
  RETURNING id, event_type, payload, attempts, workspace_id, created_at, twenty_person_id, twenty_note_id
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

/**
 * Event types whose payload is contractually email-keyed. A row of one
 * of these types landing with a NULL email_key is almost always a bug
 * — a type-system bypass, schema drift, or upstream payload corruption
 * — and we lose per-email serialization for that row (it dispatches
 * concurrently with siblings). Warn-log so operators can grep and
 * investigate before atlasFirstSource flips weeks later.
 *
 * The literals must match the `eventType` strings that actually land
 * in `crm_outbox.event_type`, NOT the upstream `LeadEvent.source`
 * variants — they coincide for `demo` / `signup` / `sales-form` (the
 * dispatcher passes `input.source` through verbatim) but diverge for
 * conversions, which enqueue as `"stamp-conversion"` (the
 * `STAMP_CONVERSION_EVENT_TYPE` constant in `ee/src/saas-crm/index.ts`).
 *
 * New email-keyed event types must be added here AND have an `email`
 * field on their payload type — the runtime check is the only defense
 * against a TypeScript cast or `unknown`-laundered payload silently
 * disabling serialization.
 */
const EMAIL_KEYED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "demo",
  "signup",
  "sales-form",
  "stamp-conversion",
]);

/** Insert a row in `pending` status. Returns the new row id. */
export async function enqueue(
  db: OutboxDB,
  input: EnqueueInput,
): Promise<string> {
  // Fail loud on an empty workspace_id. The migration enforces NOT NULL
  // at the column level (0106), but Postgres' empty-string-vs-NULL
  // distinction would let `""` through — and the dispatcher's routing
  // key compares string-equal, so `""` would mismatch the operator id
  // AND mismatch every real workspace id, silently dead-lettering the
  // row. Reject at the seam.
  if (input.workspaceId.length === 0) {
    throw new Error(
      "crm_outbox enqueue: workspaceId must be non-empty " +
        "(operator pipeline passes the resolved operator workspace id; " +
        "per-tenant enqueue passes the customer's workspace id).",
    );
  }
  const emailKey = extractEmailKey(input.payload);
  if (emailKey === null && EMAIL_KEYED_EVENT_TYPES.has(input.eventType)) {
    const raw = input.payload["email"];
    log.warn(
      {
        eventType: input.eventType,
        rawType: typeof raw,
        event: "lead_outbox.email_key_missing",
      },
      "Email-keyed event enqueued with no extractable email — per-email serialization disabled for this row",
    );
  }
  const rows = await db.query<{ id: string }>(ENQUEUE_SQL, [
    input.eventType,
    JSON.stringify(input.payload),
    emailKey,
    input.workspaceId,
  ]);
  const id = rows[0]?.id;
  if (!id) {
    // INSERT … RETURNING with no row back is a driver-level invariant
    // violation — fail loud rather than silently drop the enqueue.
    throw new Error("crm_outbox enqueue returned no row");
  }
  // Edge-trigger the flusher (#2874): ring the in-process doorbell so a
  // mounted flusher dispatches this row within ms instead of waiting up
  // to a full backstop interval. Fire-and-forget and never-throwing — the
  // row is already durably persisted, so a missing/faulty doorbell
  // (self-hosted, region-gated-off region, or a backfill-script process
  // with no flusher) only defers dispatch to the backstop sweep or next
  // boot, it never loses the lead.
  kickActiveFlusher();
  return id;
}

/**
 * Pull the lead's primary email out of a free-form payload and
 * normalize it for `email_key` storage. Returns `null` when the
 * payload has no recognizable email field — those rows fall back to
 * "every row dispatches independently" semantics in CLAIM_SQL
 * (`COALESCE(email_key, id::text)` makes NULL rows their own dedup
 * group).
 *
 * Normalization is `.trim().toLowerCase()`. The SQL backfill in
 * migration 0104 uses the equivalent `NULLIF(LOWER(TRIM(...)), '')`
 * so both code paths produce identical email_key values for the
 * same input. Note: the lead-normalizer in `@useatlas/twenty` uses
 * the reverse order (`.toLowerCase().trim()`) — for ASCII emails
 * both orders produce identical output, but if you ever extend
 * either path to non-ASCII inputs the orders should be reconciled.
 *
 * Exported so unit tests can assert lockstep with the 0104 backfill
 * and so the bulk-enqueue path in `backfill-crm-leads.ts` populates
 * email_key the same way `enqueue` does. Not part of the public
 * outbox surface; new callers should pass payloads through
 * `enqueue`, not call this directly.
 */
export function extractEmailKey(payload: Record<string, unknown>): string | null {
  const raw = payload["email"];
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
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
  scheduler?: OutboxRetryScheduler,
): Promise<FlushResult> {
  if (batchLimit <= 0) return { claimed: 0, ok: 0, transient: 0, permanent: 0 };

  type ClaimedRow = {
    id: string;
    event_type: string;
    payload: unknown;
    attempts: number;
    workspace_id: string;
    // `created_at` rides along (added to CLAIM RETURNING in #2874) so a
    // transient failure can schedule its retry timer at the exact tier
    // due-time `created_at + nextDelayMs(attempts)` without a re-query.
    created_at: Date | string;
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
      workspaceId: raw.workspace_id,
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
    // Edge-trigger the next attempt (#2874): wake the flusher exactly when
    // this row comes due (upstream Retry-After, else the tier delay from
    // `created_at`) rather than waiting for the backstop sweep to notice.
    // Best-effort and in-memory — a timer lost to a restart is re-caught
    // by the backstop. The DB write above is the source of truth for the
    // due-time; this only schedules a wakeup, it does not move the gate.
    if (scheduler) {
      scheduler.scheduleRetry(
        row.id,
        computeRetryDelayMs(raw.created_at, row.attempts, outcome.retryAfterMs),
      );
    }
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
 * Compute the delay (ms from `nowMs`) until a transiently-failed row's
 * next attempt is due, for scheduling the in-memory retry timer (#2874).
 * Mirrors the SQL claim gate `COALESCE(retry_after, created_at + tier)`:
 *
 *  - An upstream `Retry-After` (`retryAfterMs`) wins — the row's DB
 *    `retry_after` was stamped to `now + retryAfterMs`, so the timer
 *    fires after the same delay.
 *  - Otherwise the row is due at `created_at + nextDelayMs(attempts)`;
 *    the delay is the remaining time until then, floored at 0 (a row
 *    already past its tier due-time fires on the next tick).
 *
 * An unparseable `created_at` falls back to the tier delay measured from
 * now — marginally over-delays a back-dated row, but the backstop sweep
 * still guarantees eventual claim, so it never strands the lead. Pure;
 * unit-tested. Not part of the dispatcher contract.
 */
export function computeRetryDelayMs(
  createdAt: Date | string,
  attempts: number,
  retryAfterMs: number | undefined,
  nowMs: number = Date.now(),
): number {
  if (retryAfterMs != null && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return retryAfterMs;
  }
  const createdMs = toEpochMs(createdAt);
  if (createdMs == null) return nextDelayMs(attempts);
  return Math.max(0, createdMs + nextDelayMs(attempts) - nowMs);
}

function toEpochMs(v: Date | string): number | null {
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
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
 * Backstop sweep interval (#2874). The flusher is edge-triggered — it
 * wakes on the inline kick from `enqueue` and on per-row retry timers —
 * so this is NOT a poll cadence. It is the low-frequency safety net that
 * runs the claim once per interval to catch the cases an in-memory
 * doorbell can't: a retry timer lost to a pod restart, a crash-recovered
 * `in_flight` row, or a kick dropped in the window between enqueue and
 * fork. Default 300s (5 min) — an idle pod then issues ~288 claims/day
 * instead of the old ~17,280 polls/day.
 *
 * Configurable via `ATLAS_CRM_OUTBOX_BACKSTOP_SWEEP_SECONDS`, clamped to
 * `[1, 86400]` seconds (1s … 24h). The upper bound keeps the timer well
 * under the 2^31-1 ms `setTimeout` ceiling; the lower bound prevents an
 * accidental tight loop. Out-of-range inputs warn-and-clamp rather than
 * silently defaulting — the operator's intent is preserved at the
 * boundary value (same discipline as `getWarnThreshold`).
 */
export const MIN_BACKSTOP_SWEEP_SECONDS = 1;
export const MAX_BACKSTOP_SWEEP_SECONDS = 86_400;
export const DEFAULT_BACKSTOP_SWEEP_SECONDS = 300;

export function getBackstopSweepIntervalMs(): number {
  const raw = process.env.ATLAS_CRM_OUTBOX_BACKSTOP_SWEEP_SECONDS;
  if (!raw) return DEFAULT_BACKSTOP_SWEEP_SECONDS * 1_000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BACKSTOP_SWEEP_SECONDS * 1_000;
  if (parsed < MIN_BACKSTOP_SWEEP_SECONDS) {
    log.warn(
      {
        requested: parsed,
        clamped: MIN_BACKSTOP_SWEEP_SECONDS,
        event: "lead_outbox.backstop_clamped",
      },
      `ATLAS_CRM_OUTBOX_BACKSTOP_SWEEP_SECONDS=${parsed} is below ${MIN_BACKSTOP_SWEEP_SECONDS}s minimum — clamping`,
    );
    return MIN_BACKSTOP_SWEEP_SECONDS * 1_000;
  }
  if (parsed > MAX_BACKSTOP_SWEEP_SECONDS) {
    log.warn(
      {
        requested: parsed,
        clamped: MAX_BACKSTOP_SWEEP_SECONDS,
        event: "lead_outbox.backstop_clamped",
      },
      `ATLAS_CRM_OUTBOX_BACKSTOP_SWEEP_SECONDS=${parsed} exceeds ${MAX_BACKSTOP_SWEEP_SECONDS}s maximum — clamping`,
    );
    return MAX_BACKSTOP_SWEEP_SECONDS * 1_000;
  }
  return parsed * 1_000;
}

/**
 * Per-tick claim batch size. Capped at 50 to keep a single tick's
 * fan-out to Twenty bounded — a multi-thousand-row backlog is recovered
 * across many ticks rather than starving the upstream rate limit in one.
 */
export const FLUSH_BATCH_LIMIT = 50;

/**
 * Flusher region gate. Default `true` — every API instance that has
 * `SaasCrm.dispatcher !== null` and an internal DB runs the flusher,
 * which preserves the pre-#2873 behavior.
 *
 * Set `ATLAS_CRM_OUTBOX_FLUSHER_ENABLED=false` on regional API pods
 * (api-eu / api-apac) whose internal DB has no source of `crm_outbox`
 * rows: the SaaS lead-capture pipeline at `crm.useatlas.dev` only
 * writes to US, so EU/APAC tick 12×/min against a permanently-empty
 * table — ~17k wasted `UPDATE ... SELECT ... FOR UPDATE SKIP LOCKED`
 * statements per region per day, plus log noise (`lead_outbox.heartbeat`
 * every 60s).
 *
 * Disabling the flusher does NOT skip the recovery sweep finalizer:
 * boot-time `recoverInFlight` still resets stranded `in_flight` rows
 * from a previous deploy's crash. So flipping the env on a region that
 * previously had the flusher running is safe.
 *
 * Post-#2874 the flusher is edge-triggered (enqueue kick + per-row retry
 * timer + low-frequency backstop sweep) rather than a 5s poll, so a US
 * pod idles near-silent without this gate. The gate still earns its keep
 * on EU/APAC: it skips the kick + backstop entirely (recovery only),
 * avoiding even the ~288 backstop claims/day against a permanently-empty
 * regional table.
 */
export function isFlusherEnabled(): boolean {
  const raw = process.env.ATLAS_CRM_OUTBOX_FLUSHER_ENABLED;
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  // Accept the usual boolean affordances; default-true semantics mean
  // anything we don't recognize as a "no" stays enabled.
  return !(
    normalized === "false" ||
    normalized === "0" ||
    normalized === "no" ||
    normalized === "off"
  );
}
