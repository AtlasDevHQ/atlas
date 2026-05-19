/**
 * Proactive chat — classifier review verdicts (#2622).
 *
 * Backs the `proactive_classification_review` table (migration 0084):
 * the admin drill-down at `/admin/proactive-chat/events` flips a
 * meter row's verdict to `misfire` / `correct` / `unsure` and the row
 * is persisted here keyed on `(workspaceId, messageId)`.
 *
 * Lives next to `answer-meter.ts` rather than inside it because the
 * meter is the per-event recorder + aggregator; reviews are a smaller
 * CRUD surface with no aggregation. Keeping them separate stops the
 * meter file from sprawling and matches the `public-dataset.ts`
 * companion module pattern.
 *
 * The module never imports `@atlas/ee` — the enterprise gate is the
 * route layer's job. Tests can exercise the DB shape directly.
 *
 * PRIVACY: no message text ever lands here. The admin reviewer reads
 * the message on the chat platform (Slack permalink in the UI) and
 * the verdict is the only thing this table persists.
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import type { ProactiveReviewVerdict } from "@atlas/api/lib/proactive/answer-meter";

const log = createLogger("proactive:classification-review");

// Re-export so existing consumers keep their import path. Canonical
// definition lives in `answer-meter.ts` alongside the meter row + event
// types — a single source of truth keeps the union from drifting
// across two structurally-identical declarations.
export type { ProactiveReviewVerdict };

export const PROACTIVE_REVIEW_VERDICTS: readonly ProactiveReviewVerdict[] = [
  "misfire",
  "correct",
  "unsure",
];

export interface UpsertReviewInput {
  workspaceId: string;
  messageId: string;
  verdict: ProactiveReviewVerdict;
  reviewerUserId: string | null;
  note: string | null;
}

export interface UpsertReviewResult {
  workspaceId: string;
  messageId: string;
  verdict: ProactiveReviewVerdict;
  reviewerUserId: string | null;
  note: string | null;
  /** Previous verdict on this `(workspaceId, messageId)` — null on first write. */
  previousVerdict: ProactiveReviewVerdict | null;
  createdAt: string;
  updatedAt: string;
}

interface ReviewDbRow {
  workspace_id: string;
  message_id: string;
  verdict: ProactiveReviewVerdict;
  reviewer_user_id: string | null;
  note: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  // Index signature so the row threads through `internalQuery<T>`.
  [key: string]: unknown;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Idempotent upsert on `(workspace_id, message_id)`. Re-reviewing the
 * same message replaces the verdict + note and bumps `updated_at`. The
 * previous verdict (if any) is returned so the route layer can stamp
 * it onto the admin audit row — without that, a forensic query
 * answering "what did the admin change from?" needs two reads of this
 * table around the audit event.
 *
 * Throws when no internal DB is wired. The admin route's
 * `requireOrgContext()` middleware 404s with `not_available` before
 * reaching this helper, so the throw is a paranoia rail for non-route
 * callers.
 */
export const MAX_REVIEW_NOTE_LENGTH = 1024;

export async function upsertClassificationReview(
  input: UpsertReviewInput,
): Promise<UpsertReviewResult> {
  if (!hasInternalDB()) {
    throw new Error(
      "upsertClassificationReview: internal DB is not configured",
    );
  }
  if (!PROACTIVE_REVIEW_VERDICTS.includes(input.verdict)) {
    // Belt-and-braces — the route's zod schema enforces this too, but
    // the CHECK constraint would also reject it. Failing here means
    // route changes can't accidentally route an invalid verdict past
    // the DB into a 500 with a Postgres-side message.
    throw new Error(
      `upsertClassificationReview: invalid verdict ${JSON.stringify(input.verdict)}`,
    );
  }
  if (input.note !== null && input.note.length > MAX_REVIEW_NOTE_LENGTH) {
    // Same belt-and-braces stance for the note cap. The route's zod
    // schema enforces 1024 chars too, but a future bulk-import script
    // or admin CLI could call this helper directly — without the
    // helper-side floor, the cap is route-layer-only and the privacy
    // posture ("note is short, not a message-text dump") weakens.
    throw new Error(
      `upsertClassificationReview: note exceeds ${MAX_REVIEW_NOTE_LENGTH} chars`,
    );
  }

  // Two-query upsert: read the prior verdict (so we can surface it on
  // the audit row), then upsert the new value. The two statements run
  // on the same pool so they're back-to-back; we deliberately don't
  // wrap them in a transaction because the only consistency guarantee
  // the caller needs is "the new row is what we returned" and the
  // upsert is atomic on its own.
  const priorRows = await internalQuery<{ verdict: ProactiveReviewVerdict }>(
    `SELECT verdict FROM proactive_classification_review
     WHERE workspace_id = $1 AND message_id = $2`,
    [input.workspaceId, input.messageId],
  );
  const previousVerdict = priorRows[0]?.verdict ?? null;

  const rows = await internalQuery<ReviewDbRow>(
    `INSERT INTO proactive_classification_review
       (workspace_id, message_id, verdict, reviewer_user_id, note, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())
     ON CONFLICT (workspace_id, message_id) DO UPDATE SET
       verdict = EXCLUDED.verdict,
       reviewer_user_id = EXCLUDED.reviewer_user_id,
       note = EXCLUDED.note,
       updated_at = now()
     RETURNING workspace_id, message_id, verdict, reviewer_user_id, note,
               created_at, updated_at`,
    [
      input.workspaceId,
      input.messageId,
      input.verdict,
      input.reviewerUserId,
      input.note,
    ],
  );

  const row = rows[0];
  if (!row) {
    throw new Error(
      "upsertClassificationReview: upsert returned no row (unexpected)",
    );
  }

  log.info(
    {
      workspaceId: input.workspaceId,
      messageId: input.messageId,
      verdict: input.verdict,
      previousVerdict,
    },
    "proactive classification review upserted",
  );

  return {
    workspaceId: row.workspace_id,
    messageId: row.message_id,
    verdict: row.verdict,
    reviewerUserId: row.reviewer_user_id,
    note: row.note,
    previousVerdict,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * Look up the classify meter row backing a verdict write. Returns the
 * row's `channelId` so the route layer can stamp it onto the audit
 * payload without a second read; returns `null` when no classify row
 * exists for `(workspaceId, messageId)`.
 *
 * The route layer calls this to keep `proactive_classification_review`
 * free of orphan verdicts — without the guard, a malicious admin could
 * persist a verdict for an arbitrary `messageId` and silently shift
 * the misfire metric upward.
 *
 * Throws when no internal DB is wired — matches the
 * `upsertClassificationReview` posture (route's
 * `requireOrgContext()` middleware already 404s before this is
 * reached). Returning `false` here would hide a misconfiguration as
 * "no orphan row" and shape every reviewer call as a 404 with no
 * signal — the throw makes the misconfiguration loud at the call
 * site.
 */
export async function lookupClassifyChannel(
  workspaceId: string,
  messageId: string,
): Promise<string | null> {
  if (!hasInternalDB()) {
    throw new Error(
      "lookupClassifyChannel: internal DB is not configured",
    );
  }
  const rows = await internalQuery<{ channel_id: string }>(
    `SELECT channel_id FROM proactive_meter_events
     WHERE workspace_id = $1 AND message_id = $2 AND event_type = 'classify'
     LIMIT 1`,
    [workspaceId, messageId],
  );
  return rows[0]?.channel_id ?? null;
}
