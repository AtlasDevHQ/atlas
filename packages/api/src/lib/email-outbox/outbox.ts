/**
 * Email outbox — durable queue for transactional email (#2942).
 *
 * This is a STRIPPED-DOWN mirror of `lib/lead-outbox/`. It owns the
 * queue mechanics (enqueue, claim, backoff, dead-letter, startup
 * recovery) and delegates the actual send to a pluggable
 * `EmailDispatcher` (wired to `email/delivery.ts:sendEmail` in
 * `lib/email-outbox/dispatch.ts`). Keeping the dispatcher injectable
 * makes `flushBatch` trivial to unit-test with a fake.
 *
 * What it DOESN'T carry, vs `crm_outbox`, and why:
 *   - No `email_key` per-email serialization: transactional sends have
 *     no cross-row ordering contract, and an at-least-once duplicate
 *     send is acceptable. Rows dispatch independently.
 *   - No `workspace_id` routing / advisory locks: these are
 *     operator-level transactional sends, not per-tenant plugin
 *     dispatches. `orgId` is carried only so the flusher re-resolves a
 *     per-org transport override on re-send.
 *   - No sub-step resource IDs (`twenty_person_id` etc.): a send is a
 *     single operation; there is no partial-success sub-step.
 *
 * Concurrency: the claim is a single `UPDATE … WHERE id IN (SELECT …
 * FOR UPDATE SKIP LOCKED) RETURNING *` statement, so multiple flusher
 * workers (one per pod) cannot double-claim a row.
 *
 * Retry-After: when a transient outcome carries a `retryAfterMs`, the
 * flusher stamps `retry_after = now() + delay` and the claim WHERE
 * prefers it over the tier-based backoff via
 * `COALESCE(retry_after, created_at + tier)`.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { encryptSecret, decryptSecret, type RawSecret } from "@atlas/api/lib/db/secret-encryption";
import { CLAIM_DELAY_SQL, DEAD_AFTER_ATTEMPTS } from "./backoff";

/**
 * Narrow DB surface the outbox needs. Matches the `query` method on
 * `InternalDBShape` and the module-level `internalQuery` standalone, so
 * the layers.ts wiring can hand in either. Keeping the dependency narrow
 * makes unit tests trivial (pass any object with a `query` method).
 */
export interface EmailOutboxDB {
  query<T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
}

const log = createLogger("email-outbox");

// ─────────────────────────────────────────────────────────────────────
//  Public types
// ─────────────────────────────────────────────────────────────────────

/**
 * Outbox lifecycle states. Mirrors the `email_outbox_status_chk` CHECK
 * constraint exactly. This is the QUEUE lifecycle status, NOT the
 * content-mode status (draft/published/archived) — email_outbox is an
 * operational queue, deliberately outside the content-mode system.
 */
export type EmailOutboxStatus = "pending" | "in_flight" | "done" | "dead";

/**
 * The rendered message stored in a row's `payload`. Structurally an
 * `EmailMessage` (`email/delivery.ts`); kept local so the outbox module
 * has no static dependency on the delivery layer (the concrete
 * dispatcher in `dispatch.ts` bridges the two).
 */
export interface EmailOutboxMessage {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
}

/** What a freshly-enqueued row looks like before any send attempt. */
export interface EnqueueEmailInput {
  /** Send classification for observability (e.g. "password-reset"). */
  readonly emailType: string;
  /** The rendered message to deliver. */
  readonly message: EmailOutboxMessage;
  /**
   * Optional org scope so the flusher re-resolves a per-org transport
   * override on re-send. Session-less flows (password reset) pass null.
   */
  readonly orgId?: string | null;
  /**
   * Hard delivery deadline. Past this the embedded token/OTP is dead, so
   * the flusher dead-letters the row instead of delivering an unusable
   * link/code. Omit / null for non-expiring sends. The caller derives
   * this from the email type's TTL (reset link 1h, OTP 10m).
   *
   * Anchor: this is stamped at ENQUEUE time (`now() + ttlMs`), i.e. the
   * failed-send moment — a few seconds AFTER the token was actually
   * minted. So it slightly over-estimates true token life (safe
   * direction: we may attempt a send whose token died seconds earlier and
   * the auth layer rejects it; we never refuse a still-valid token).
   */
  readonly expiresAt?: Date | null;
}

/** Snapshot of a row at the moment the flusher claimed it. */
export interface ClaimedEmailRow {
  readonly id: string;
  readonly emailType: string;
  readonly message: EmailOutboxMessage;
  readonly orgId: string | null;
  readonly attempts: number;
  /** Hard delivery deadline (see EnqueueEmailInput.expiresAt); null = none. */
  readonly expiresAt: Date | null;
}

/**
 * Dispatcher classification of a send outcome. The outbox uses this to
 * decide dead-letter vs retry without knowing anything about HTTP
 * status codes or provider specifics.
 *
 * `transient.retryAfterMs` lets the dispatcher honour an upstream
 * delay (e.g. a 429 `Retry-After`). When set, the flusher stamps
 * `retry_after = now() + retryAfterMs` and the claim WHERE prefers it.
 */
export type EmailDispatchOutcome =
  | { readonly kind: "ok" }
  | {
      readonly kind: "transient";
      readonly message: string;
      readonly retryAfterMs?: number;
    }
  // NOTE: the current concrete dispatcher (`makeEmailDispatcher`) never
  // emits `permanent` — `sendEmail` surfaces no HTTP status, so every
  // live failure is classified `transient` and dead-letters via budget
  // exhaustion instead. This arm is retained for queue-mechanic
  // completeness and for a future status-aware dispatcher (cf. the
  // lead-outbox dispatcher, which distinguishes 4xx-permanent). The
  // `flushBatch` permanent branch is exercised by tests via a synthetic
  // dispatcher.
  | { readonly kind: "permanent"; readonly message: string };

/**
 * Pluggable dispatcher. The implementation owns the send and the
 * decision of whether a failure is transient or permanent. The concrete
 * dispatcher (`dispatch.ts`) wraps `sendEmail`.
 */
export type EmailDispatcher = (row: ClaimedEmailRow) => Promise<EmailDispatchOutcome>;

export interface FlushResult {
  readonly claimed: number;
  readonly ok: number;
  readonly transient: number;
  readonly permanent: number;
}

export interface RecoveryResult {
  readonly deadLettered: number;
  readonly reset: number;
}

// ─────────────────────────────────────────────────────────────────────
//  SQL — hoisted as top-level constants so each statement is greppable.
// ─────────────────────────────────────────────────────────────────────

const ENQUEUE_SQL = `
  INSERT INTO email_outbox (email_type, payload, org_id, expires_at, status)
  VALUES ($1, $2, $3, $4, 'pending')
  RETURNING id
`;

/**
 * Single-statement claim. The inner SELECT uses `FOR UPDATE SKIP
 * LOCKED` so concurrent flushers walk disjoint sets of pending rows
 * without blocking each other. The outer UPDATE atomically flips status
 * and bumps `attempts`.
 *
 * Backoff gate: `COALESCE(retry_after, created_at + tier) <= now()`.
 * Post-#2972 `retry_after` is stamped on every transient failure, so for
 * any row that has failed at least once the COALESCE resolves to
 * `retry_after`. The `created_at + tier` fallback only applies to a
 * never-failed row (retry_after NULL) — where tier(0)=0 makes it
 * immediately due on the first claim.
 *
 * No per-email serialization / advisory locks (cf. crm_outbox) — each
 * transactional send is independent and an at-least-once duplicate is
 * acceptable, so the claim is a plain age-ordered batch.
 */
const CLAIM_SQL = `
  UPDATE email_outbox
  SET status = 'in_flight',
      attempts = attempts + 1,
      claimed_at = now()
  WHERE id IN (
    SELECT id FROM email_outbox
    WHERE status = 'pending'
      AND attempts < ${DEAD_AFTER_ATTEMPTS}
      AND COALESCE(retry_after, created_at + (${CLAIM_DELAY_SQL})) <= now()
    ORDER BY created_at, id
    FOR UPDATE SKIP LOCKED
    LIMIT $1
  )
  RETURNING id, email_type, payload, org_id, expires_at, attempts
`;

const MARK_DONE_SQL = `
  UPDATE email_outbox
  SET status = 'done',
      processed_at = now(),
      last_error = NULL,
      retry_after = NULL,
      claimed_at = NULL
  WHERE id = $1
`;

/**
 * Transient mark. Stamps `retry_after` on EVERY transient failure as
 * `GREATEST(now() + tier(attempts), $3)` — the next-due time is measured
 * from the FAILURE moment (`now()`), not from `created_at`. This closes
 * the codex #2972 finding: a row that sat pending a long time before its
 * first claim (flusher disabled, app down, delayed migrations) would
 * otherwise have `created_at + tier` already in the past for every tier
 * and burn its whole retry budget in a back-to-back burst. `$3` is the
 * optional upstream-requested delay (a 429 `Retry-After`); GREATEST lets
 * a longer upstream window win and ignores NULL when there's none.
 * `claimed_at` is cleared so the recovery sweep's staleness gate doesn't
 * trip on a row that's already back to pending.
 */
const MARK_TRANSIENT_FAIL_SQL = `
  UPDATE email_outbox
  SET status = 'pending',
      last_error = $1,
      retry_after = GREATEST(now() + (${CLAIM_DELAY_SQL}), $3),
      claimed_at = NULL
  WHERE id = $2
`;

const MARK_DEAD_SQL = `
  UPDATE email_outbox
  SET status = 'dead',
      processed_at = now(),
      last_error = $1,
      retry_after = NULL,
      claimed_at = NULL
  WHERE id = $2
`;

/**
 * Recovery sweep — splits the STALE in_flight set into two buckets
 * (both gated on `claimed > $1 ms ago OR never stamped`, so a peer pod
 * that just claimed a row is never touched mid-send):
 *
 *  1. **Exhausted carcasses** (`attempts >= DEAD_AFTER_ATTEMPTS`) move
 *     straight to `status = 'dead'`. Without this they'd land in
 *     `pending` and never re-claim (the claim WHERE filters them out),
 *     hiding terminal failures from a `status = 'dead'` triage query.
 *     The staleness gate here is the codex #2972 fix: in a multi-pod
 *     deploy a peer that just claimed a row for its LAST allowed attempt
 *     (attempts already incremented to the budget, mid-send) must NOT be
 *     dead-lettered out from under the active sender — that would race
 *     its final status write and emit a false dead-letter. An abandoned
 *     exhausted row is still dead-lettered once it goes stale.
 *  2. **Stale carcasses** (under budget) return to `pending` for
 *     re-claim. Same age threshold, same multi-pod protection.
 *
 * `retry_after` is preserved across both branches.
 */
const MARK_EXHAUSTED_IN_FLIGHT_DEAD_SQL = `
  UPDATE email_outbox
  SET status = 'dead', processed_at = now(),
      last_error = CASE
        WHEN last_error IS NULL OR last_error = ''
          THEN 'crashed mid-send at attempts=' || attempts || ' (recovery)'
        ELSE last_error || ' [crashed mid-send at attempts=' || attempts || ', recovery dead-lettered]'
      END
  WHERE status = 'in_flight'
    AND attempts >= ${DEAD_AFTER_ATTEMPTS}
    AND (claimed_at IS NULL OR claimed_at < now() - ($1::int * INTERVAL '1 millisecond'))
  RETURNING id
`;

const RECOVER_STALE_IN_FLIGHT_SQL = `
  UPDATE email_outbox
  SET status = 'pending'
  WHERE status = 'in_flight'
    AND attempts < ${DEAD_AFTER_ATTEMPTS}
    AND (claimed_at IS NULL OR claimed_at < now() - ($1::int * INTERVAL '1 millisecond'))
  RETURNING id
`;

/**
 * Recovery age thresholds. Startup uses a generous window so any
 * still-running peer pod's send finishes before we'd interfere;
 * shutdown can use a shorter window since the dying pod's OWN send has
 * just been interrupted.
 */
export const STARTUP_RECOVERY_STALE_MS = 5 * 60_000; // 5 min
export const SHUTDOWN_RECOVERY_STALE_MS = 30_000; // 30 s

// ─────────────────────────────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────────────────────────────

/** Insert a row in `pending` status. Returns the new row id. */
export async function enqueue(
  db: EmailOutboxDB,
  input: EnqueueEmailInput,
): Promise<string> {
  // Fail loud on an empty recipient. A row whose payload has no `to`
  // can never deliver — it would just burn the retry budget and
  // dead-letter. Reject at the seam so the bug surfaces where it
  // originates, not six attempts later in the dead-letter log.
  if (input.message.to.trim().length === 0) {
    throw new Error(
      "email_outbox enqueue: message.to must be a non-empty recipient address",
    );
  }
  // Encrypt the rendered body at rest: it carries a live reset link / OTP
  // for the TTL window (codex #2972). encryptSecret degrades to plaintext
  // passthrough when no key is configured; decryptSecret round-trips it.
  const encryptedPayload = encryptSecret(JSON.stringify(input.message));
  const rows = await db.query<{ id: string }>(ENQUEUE_SQL, [
    input.emailType,
    encryptedPayload,
    input.orgId ?? null,
    input.expiresAt ?? null,
  ]);
  const id = rows[0]?.id;
  if (!id) {
    // INSERT … RETURNING with no row back is a driver-level invariant
    // violation — fail loud rather than silently drop the enqueue.
    throw new Error("email_outbox enqueue returned no row");
  }
  return id;
}

/**
 * Reset stale `in_flight` rows. Call at Layer init AND from the shutdown
 * finalizer. Returns a per-bucket count for logging.
 */
export async function recoverInFlight(
  db: EmailOutboxDB,
  staleAgeMs: number = STARTUP_RECOVERY_STALE_MS,
): Promise<RecoveryResult> {
  // Dead-letter exhausted rows that are ALSO stale — a peer pod actively
  // sending its final attempt (claimed within the window) is left alone
  // so we don't race its terminal write (codex #2972). Both sweeps share
  // the same staleness threshold.
  const dead = await db.query<{ id: string }>(MARK_EXHAUSTED_IN_FLIGHT_DEAD_SQL, [staleAgeMs]);
  const reset = await db.query<{ id: string }>(RECOVER_STALE_IN_FLIGHT_SQL, [staleAgeMs]);
  return { deadLettered: dead.length, reset: reset.length };
}

/**
 * Claim a batch of pending-and-due rows, dispatch each, and stamp final
 * status. Returns counts so the caller can log / surface metrics.
 *
 * Errors from the dispatcher are NEVER re-thrown — they're caught and
 * the row's status is updated per `EmailDispatchOutcome`. An uncaught
 * defect (the dispatcher itself throwing) is logged and treated as
 * transient (will retry with backoff) — anything else would leak
 * `in_flight` rows that `recoverInFlight` would need to mop up.
 */
export async function flushBatch(
  db: EmailOutboxDB,
  dispatcher: EmailDispatcher,
  batchLimit: number,
): Promise<FlushResult> {
  if (batchLimit <= 0) return { claimed: 0, ok: 0, transient: 0, permanent: 0 };

  type ClaimedRow = {
    id: string;
    email_type: string;
    payload: unknown;
    org_id: string | null;
    expires_at: Date | string | null;
    attempts: number;
  };
  const claimed = await db.query<ClaimedRow>(CLAIM_SQL, [batchLimit]);
  let ok = 0;
  let transient = 0;
  let permanent = 0;

  for (const raw of claimed) {
    // Expiry gate (codex #2972): the body embeds a live reset link / OTP
    // that dies at `expires_at`. If a sustained outage outlasted the TTL,
    // delivering it would just give the user a dead link — dead-letter
    // instead of sending. `expires_at` is a plaintext column, so this is
    // checked BEFORE decrypt: a dead-token row is dead-lettered regardless
    // of whether its (encrypted) body can currently be decrypted.
    const expiresAt = coerceDate(raw.expires_at);
    if (expiresAt !== null && Date.now() >= expiresAt.getTime()) {
      await markStatusWithRetry(
        db,
        MARK_DEAD_SQL,
        [`expired before delivery (expires_at=${expiresAt.toISOString()})`, raw.id],
        raw.id,
        "dead",
      );
      log.warn(
        {
          rowId: raw.id,
          emailType: raw.email_type,
          expiresAt: expiresAt.toISOString(),
          event: "email_outbox.dead_letter_expired",
        },
        "Transactional email dead-lettered — embedded token/OTP expired before delivery (outage outlasted the TTL); not sending a dead link",
      );
      permanent++;
      continue;
    }

    const coerced = coerceMessage(raw.payload);

    // Structurally-broken payload (decrypted fine but isn't a valid
    // EmailMessage) is unrecoverable — re-sending will never fix it.
    // Dead-letter immediately.
    if (coerced.kind === "malformed") {
      await markStatusWithRetry(
        db,
        MARK_DEAD_SQL,
        [`email_outbox payload is not a valid EmailMessage: ${coerced.reason}`, raw.id],
        raw.id,
        "dead",
      );
      log.error(
        { rowId: raw.id, reason: coerced.reason, event: "email_outbox.dead_letter_malformed" },
        "Email outbox row dead-lettered — payload is not a recoverable EmailMessage",
      );
      permanent++;
      continue;
    }

    let outcome: EmailDispatchOutcome;
    if (coerced.kind === "retryable") {
      // Decrypt THREW (e.g. a key version was dropped from
      // ATLAS_ENCRYPTION_KEYS mid-rotation — recoverable by restoring it,
      // or genuine ciphertext corruption). Classify as transient rather
      // than dead-lettering (codex #2972): a fixable key-config error must
      // NOT irreversibly destroy the queued auth email. The retry budget
      // still bounds it — if the key is never restored the row dead-letters
      // after DEAD_AFTER_ATTEMPTS rather than spinning forever.
      log.error(
        { rowId: raw.id, reason: coerced.reason, event: "email_outbox.decrypt_failed" },
        "email_outbox payload decrypt failed — RETRYABLE (restore the key version in ATLAS_ENCRYPTION_KEYS); row stays pending until the retry budget is exhausted",
      );
      outcome = { kind: "transient", message: coerced.reason };
    } else {
      const row: ClaimedEmailRow = {
        id: raw.id,
        emailType: raw.email_type,
        message: coerced.message,
        orgId: raw.org_id,
        attempts: raw.attempts,
        expiresAt,
      };
      try {
        outcome = await dispatcher(row);
      } catch (err) {
        // Dispatcher contract violation: it should classify and return,
        // never throw. Treat as transient so we don't dead-letter on a
        // bug in the dispatcher's error handling.
        log.error(
          {
            rowId: row.id,
            attempts: row.attempts,
            err: err instanceof Error ? err.message : String(err),
            event: "email_outbox.dispatcher_threw",
          },
          "Dispatcher threw — classifying as transient so the row will retry",
        );
        outcome = {
          kind: "transient",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // Final-status handling is keyed off `raw` (always defined) so it
    // works for both the dispatched path and the decrypt-retryable path
    // (which has no constructed `row`).
    if (outcome.kind === "ok") {
      await markStatusWithRetry(db, MARK_DONE_SQL, [raw.id], raw.id, "done");
      ok++;
      continue;
    }

    if (outcome.kind === "permanent") {
      await markStatusWithRetry(db, MARK_DEAD_SQL, [outcome.message, raw.id], raw.id, "dead");
      log.error(
        {
          rowId: raw.id,
          attempts: raw.attempts,
          err: outcome.message,
          emailType: raw.email_type,
          event: "email_outbox.dead_letter_permanent",
        },
        "Transactional email dead-lettered (permanent failure) — operator intervention required",
      );
      permanent++;
      continue;
    }

    // Transient. If we've already burned through the retry budget the
    // row dies here — the claim WHERE wouldn't let us pick it up again,
    // so leaving it `pending` would be a silent stuck-forever row.
    if (raw.attempts >= DEAD_AFTER_ATTEMPTS) {
      await markStatusWithRetry(
        db,
        MARK_DEAD_SQL,
        [`transient failure after ${DEAD_AFTER_ATTEMPTS} attempts: ${outcome.message}`, raw.id],
        raw.id,
        "dead",
      );
      log.error(
        {
          rowId: raw.id,
          attempts: raw.attempts,
          err: outcome.message,
          emailType: raw.email_type,
          event: "email_outbox.dead_letter_exhausted",
        },
        "Transactional email dead-lettered (retry budget exhausted)",
      );
      permanent++;
      continue;
    }

    const retryAfter = computeRetryAfterTimestamp(outcome.retryAfterMs);
    await markStatusWithRetry(
      db,
      MARK_TRANSIENT_FAIL_SQL,
      [outcome.message, raw.id, retryAfter],
      raw.id,
      "pending",
    );
    log.warn(
      {
        rowId: raw.id,
        attempts: raw.attempts,
        err: outcome.message,
        retryAfterMs: outcome.retryAfterMs ?? null,
        emailType: raw.email_type,
        event: "email_outbox.transient_failure",
      },
      "Transactional email send failed (transient) — will retry with backoff",
    );
    transient++;
  }

  return { claimed: claimed.length, ok, transient, permanent };
}

/**
 * Result of decoding a claimed row's `payload` column:
 *  - `ok`        — decrypted + parsed into a valid EmailMessage.
 *  - `retryable` — decrypt THREW (a dropped/missing key version mid-
 *                  rotation, or ciphertext corruption). The key case is
 *                  RECOVERABLE by restoring the key, so flushBatch routes
 *                  this through the transient path (bounded by the retry
 *                  budget) rather than permanently dead-lettering — a
 *                  fixable key-config error must not irreversibly destroy
 *                  queued auth emails (codex #2972).
 *  - `malformed` — decrypt SUCCEEDED but the plaintext isn't a valid
 *                  EmailMessage (bad JSON / missing fields). Structurally
 *                  broken and unrecoverable → permanent dead-letter.
 */
type CoercedPayload =
  | { readonly kind: "ok"; readonly message: EmailOutboxMessage }
  | { readonly kind: "retryable"; readonly reason: string }
  | { readonly kind: "malformed"; readonly reason: string };

/**
 * Decode a claimed row's `payload`: decrypt (encryptSecret round-trip;
 * plaintext passthrough when no key is configured) then JSON-parse and
 * validate. The `payload` TEXT column is always a string; a non-string
 * indicates a driver/schema regression. See {@link CoercedPayload} for
 * how each failure mode is classified (decrypt-throw = retryable,
 * decrypted-but-invalid = malformed).
 */
function coerceMessage(payload: unknown): CoercedPayload {
  if (typeof payload !== "string") {
    return { kind: "malformed", reason: "payload column is not a string (schema/driver regression)" };
  }
  let json: string;
  try {
    json = decryptSecret(payload as RawSecret);
  } catch (err) {
    // Recoverable-or-corrupt: don't dead-letter here. flushBatch treats
    // this as transient so a restored key revives delivery; the retry
    // budget still terminates a permanently-missing key.
    return { kind: "retryable", reason: `decrypt failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    // intentionally ignored: decrypt succeeded but the plaintext isn't
    // JSON — structurally broken, never recoverable → malformed.
    return { kind: "malformed", reason: "decrypted payload is not valid JSON" };
  }
  if (obj === null || typeof obj !== "object") {
    return { kind: "malformed", reason: "decrypted payload is not an object" };
  }
  const rec = obj as Record<string, unknown>;
  if (
    typeof rec.to !== "string" ||
    typeof rec.subject !== "string" ||
    typeof rec.html !== "string" ||
    rec.to.trim().length === 0
  ) {
    return { kind: "malformed", reason: "missing/invalid to/subject/html" };
  }
  return { kind: "ok", message: { to: rec.to, subject: rec.subject, html: rec.html } };
}

/**
 * Coerce a claimed row's `expires_at` (Date from the pg driver, or a
 * string under some pool configs) into a Date. Returns `null` for an
 * absent or unparseable deadline (treated as "no deadline").
 */
function coerceDate(v: Date | string | null): Date | null {
  if (v == null) return null;
  if (v instanceof Date) {
    if (!Number.isNaN(v.getTime())) return v;
  } else {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  // Non-null but unparseable: log rather than silently treating it as "no
  // deadline" (which would let a possibly-dead token deliver). A real
  // timestamptz column should never hit this — it'd signal a driver/schema
  // regression — so mirror depth.ts:parseTimestamp's discipline.
  log.warn(
    { raw: v, event: "email_outbox.expires_at_unparseable" },
    "email_outbox expires_at could not be parsed as a Date — treating as no deadline this tick",
  );
  return null;
}

/**
 * Compute the absolute `retry_after` candidate for a transient outcome
 * that carried an upstream-specified delay (e.g. a 429 `Retry-After`).
 * Returns `null` when the outcome carries no delay — in which case the
 * SQL's `GREATEST(now() + tier, $3)` uses just the tier-based floor (it
 * does NOT clear the column: every transient mark overwrites retry_after
 * with a fresh now-based value, so a prior Retry-After can't strand a
 * row). Exported for tests.
 */
export function computeRetryAfterTimestamp(retryAfterMs: number | undefined): Date | null {
  if (retryAfterMs == null) return null;
  if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) return null;
  return new Date(Date.now() + retryAfterMs);
}

/**
 * Single-retry wrapper around a terminal-status UPDATE. If the first
 * write fails (a Postgres blip between dispatch return and status
 * stamp), wait briefly and try once more. If both fail, log loudly and
 * re-throw so the tick's outer catch records the tick as failed — the
 * row stays `in_flight` and `recoverInFlight` mops it up on the next
 * boot. Without this, an isolated network hiccup at the wrong moment
 * strands the row until restart.
 */
async function markStatusWithRetry(
  db: EmailOutboxDB,
  sql: string,
  params: unknown[],
  rowId: string,
  intent: EmailOutboxStatus,
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
        event: "email_outbox.status_update_retrying",
      },
      "Email outbox terminal-status UPDATE failed — retrying once before letting the row strand",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.query(sql, params);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Configuration
// ─────────────────────────────────────────────────────────────────────

/**
 * Tick interval. Default 5s; configurable via
 * `ATLAS_EMAIL_OUTBOX_TICK_SECONDS`. Clamped to `[1, 3600]` seconds —
 * the upper bound avoids a Bun timer overflow and the lower bound
 * prevents an accidental sub-second tick from hammering Postgres.
 * Out-of-range inputs warn-and-clamp rather than silently default so
 * the operator's intent (faster / slower) is preserved at the boundary.
 */
export const MIN_TICK_SECONDS = 1;
export const MAX_TICK_SECONDS = 3600;
export const DEFAULT_TICK_SECONDS = 5;

export function getTickIntervalMs(): number {
  const raw = process.env.ATLAS_EMAIL_OUTBOX_TICK_SECONDS;
  if (!raw) return DEFAULT_TICK_SECONDS * 1_000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TICK_SECONDS * 1_000;
  if (parsed < MIN_TICK_SECONDS) {
    log.warn(
      { requested: parsed, clamped: MIN_TICK_SECONDS, event: "email_outbox.tick_clamped" },
      `ATLAS_EMAIL_OUTBOX_TICK_SECONDS=${parsed} is below ${MIN_TICK_SECONDS}s minimum — clamping`,
    );
    return MIN_TICK_SECONDS * 1_000;
  }
  if (parsed > MAX_TICK_SECONDS) {
    log.warn(
      { requested: parsed, clamped: MAX_TICK_SECONDS, event: "email_outbox.tick_clamped" },
      `ATLAS_EMAIL_OUTBOX_TICK_SECONDS=${parsed} exceeds ${MAX_TICK_SECONDS}s maximum — clamping`,
    );
    return MAX_TICK_SECONDS * 1_000;
  }
  return parsed * 1_000;
}

/**
 * Per-tick claim batch size. Transactional email is low-volume; 25 is
 * plenty to drain a backlog after an outage without a single tick
 * fanning out an unbounded number of provider calls.
 */
export const FLUSH_BATCH_LIMIT = 25;

/**
 * Flusher region gate. Default `true` — every API instance with an
 * internal DB runs the flusher. Set `ATLAS_EMAIL_OUTBOX_FLUSHER_ENABLED=false`
 * on pods whose internal DB never accumulates email_outbox rows (e.g. a
 * regional read replica that doesn't serve auth) to skip the idle poll.
 * Disabling the flusher does NOT skip the boot/shutdown recovery sweep.
 */
export function isFlusherEnabled(): boolean {
  const raw = process.env.ATLAS_EMAIL_OUTBOX_FLUSHER_ENABLED;
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return !(
    normalized === "false" ||
    normalized === "0" ||
    normalized === "no" ||
    normalized === "off"
  );
}
