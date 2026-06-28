/**
 * AnswerMeter — proactive-chat per-event meter (EE IMPLEMENTATION).
 *
 * The `AnswerMeter` Context.Tag, its shape, every meter/event type, and
 * `MAX_EVENT_PAGE_LIMIT` live in core (`@atlas/api/lib/proactive/answer-meter`)
 * so the admin analytics + events routes can `yield* AnswerMeter` without
 * importing `@atlas/ee`. This module holds the proactive-only
 * implementation — the SQL readers/writer, the pure `aggregateRows`
 * roller, and `AnswerMeterLive` — and is bound onto the Tag by
 * `ee/src/layers.ts` (`EELayer`) when enterprise is enabled (#3999).
 *
 * Pairs with the audit log (new `proactive.*` action types in
 * `audit/actions.ts`) — the meter is the per-event row with cost; audit
 * is the human-readable forensic trail. We deliberately do NOT collapse
 * them: meter writes are high-volume per-classify (one per message); the
 * admin trail wants one human-readable row per state transition.
 */

import { Effect, Layer } from "effect";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import { logAdminAction } from "@atlas/api/lib/audit/admin";
import { ADMIN_ACTIONS } from "@atlas/api/lib/audit/actions";
import type { AdminActionType } from "@atlas/api/lib/audit/actions";
import type { ProactiveMeterEvent } from "@useatlas/types";
import {
  AnswerMeter,
  MAX_EVENT_PAGE_LIMIT,
  type AnswerMeterShape,
  type ChannelSummary,
  type ProactiveMeterSummary,
  type ProactiveMeterRow,
  type ProactiveEventType,
  type ProactiveOutcome,
  type ProactiveEventRow,
  type ProactiveReviewVerdict,
  type EventCursor,
  type ListEventsOptions,
  type ListEventsResult,
  type ProactiveReviewSummary,
} from "@atlas/api/lib/proactive/answer-meter";

const log = createLogger("answer-meter");

// ---------------------------------------------------------------------------
// Pure aggregation helper (unit-testable)
// ---------------------------------------------------------------------------

/**
 * Roll up raw `proactive_meter_events` rows into the summary shape.
 *
 * Pure — no I/O. Exported so unit tests can pin the math without a DB
 * round-trip and so the eventual billing aggregator can reuse it.
 *
 * Channel rollups preserve insertion order of the first-seen row per
 * channel, which matches how the SQL query returns rows (`ORDER BY
 * created_at DESC`) — admin UIs show "most-recent-activity first" by
 * default.
 */
export function aggregateRows(rows: ProactiveMeterRow[]): ProactiveMeterSummary {
  const summary: ProactiveMeterSummary = {
    classifyCount: 0,
    reactCount: 0,
    offerCount: 0,
    acceptCount: 0,
    feedbackByOutcome: emptyFeedbackMap(),
    totalCostMicroUsd: 0,
    byChannel: [],
  };

  // Preserve first-seen order without touching prototype.
  const channelIndex = new Map<string, ChannelSummary>();

  for (const row of rows) {
    incrementEventType(summary, row.event_type);
    summary.totalCostMicroUsd += row.cost_micro_usd ?? 0;

    if (row.event_type === "feedback" && row.outcome) {
      summary.feedbackByOutcome[row.outcome] =
        (summary.feedbackByOutcome[row.outcome] ?? 0) + 1;
    }

    let channel = channelIndex.get(row.channel_id);
    if (!channel) {
      channel = {
        channelId: row.channel_id,
        classifyCount: 0,
        reactCount: 0,
        offerCount: 0,
        acceptCount: 0,
        feedbackByOutcome: emptyFeedbackMap(),
        totalCostMicroUsd: 0,
      };
      channelIndex.set(row.channel_id, channel);
      summary.byChannel.push(channel);
    }
    incrementEventType(channel, row.event_type);
    channel.totalCostMicroUsd += row.cost_micro_usd ?? 0;
    if (row.event_type === "feedback" && row.outcome) {
      channel.feedbackByOutcome[row.outcome] =
        (channel.feedbackByOutcome[row.outcome] ?? 0) + 1;
    }
  }

  return summary;
}

function emptyFeedbackMap(): Record<ProactiveOutcome, number> {
  return {
    helpful: 0,
    "not-helpful": 0,
    "wrong-data": 0,
    "no-feedback": 0,
  };
}

function incrementEventType(
  target: { classifyCount: number; reactCount: number; offerCount: number; acceptCount: number },
  type: ProactiveEventType,
): void {
  switch (type) {
    case "classify":
      target.classifyCount += 1;
      return;
    case "react":
      target.reactCount += 1;
      return;
    case "offer":
      target.offerCount += 1;
      return;
    case "accept":
      target.acceptCount += 1;
      return;
    case "feedback":
      // Outcome split tracked separately; the bucket counter is the
      // total across outcomes.
      return;
    case "public_refused":
      // `public_refused` rows are aggregated by the public-dataset
      // discoverability rollup (`summarizePublicRefused`) — the
      // top-level meter summary deliberately ignores them so an admin
      // glancing at "react count" doesn't accidentally double-count
      // proactive engagement against the silent-refusal stream.
      return;
  }
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const INSERT_SQL = `INSERT INTO proactive_meter_events
  (workspace_id, channel_id, message_id, event_type, outcome, tokens, cost_micro_usd, confidence, actor_user_id, metadata)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`;

const SUMMARY_SQL = `SELECT channel_id, event_type, outcome, cost_micro_usd
FROM proactive_meter_events
WHERE workspace_id = $1
  AND created_at >= $2
ORDER BY created_at DESC`;

/**
 * Drill-down events query (#2622). LEFT JOIN onto
 * `proactive_classification_review` so each meter row carries the
 * verdict if one has been recorded — null otherwise. Keyset
 * pagination on (created_at DESC, id DESC) so the page stays stable
 * under inserts arriving during the admin's scroll.
 *
 * Parameters (`$1`..`$6`):
 *   1. workspace_id
 *   2. created_at lower bound (window)
 *   3. event_type filter ('' = no filter)
 *   4. cursor created_at (NULL = first page)
 *   5. cursor id (the keyset tie-breaker; NULL = first page)
 *   6. limit + 1 (the route slices the final row off to compute
 *      hasMore without an extra COUNT(*))
 *
 * Note: `$4` and `$5` participate in the keyset filter only as a pair.
 * Keeping the SQL inline (rather than building it with string
 * concatenation) keeps the predicates greppable for SQL-injection
 * audits and avoids accidental dynamic-predicate construction.
 */
const EVENTS_PAGE_SQL = `SELECT
  e.id,
  e.workspace_id,
  e.channel_id,
  e.message_id,
  e.event_type,
  e.outcome,
  e.tokens,
  e.cost_micro_usd,
  e.confidence,
  e.actor_user_id,
  e.metadata,
  e.created_at,
  r.verdict     AS review_verdict,
  r.note        AS review_note,
  r.reviewer_user_id AS review_reviewer_user_id,
  r.created_at  AS review_created_at,
  r.updated_at  AS review_updated_at
FROM proactive_meter_events e
LEFT JOIN proactive_classification_review r
  ON r.workspace_id = e.workspace_id
 AND r.message_id   = e.message_id
WHERE e.workspace_id = $1
  AND e.created_at  >= $2
  AND ($3 = '' OR e.event_type = $3)
  AND (
    $4::timestamptz IS NULL
    OR (e.created_at, e.id) < ($4::timestamptz, $5::uuid)
  )
ORDER BY e.created_at DESC, e.id DESC
LIMIT $6`;

/**
 * Labelled-misfire rollup (#2622). Counts every classify row in the
 * window and the labelled subset across the three verdict buckets.
 * Surface tile on the analytics panel; mirrors PRD #2291's <5% misfire
 * bar. Independent of `summarizeMeterEvents` so the existing analytics
 * response shape is unchanged.
 */
const REVIEW_SUMMARY_SQL = `SELECT
  COUNT(*) FILTER (WHERE e.event_type = 'classify')                     AS classify_count,
  COUNT(r.verdict) FILTER (WHERE e.event_type = 'classify')             AS reviewed_count,
  COUNT(*) FILTER (WHERE e.event_type = 'classify' AND r.verdict = 'misfire') AS misfire_count,
  COUNT(*) FILTER (WHERE e.event_type = 'classify' AND r.verdict = 'correct') AS correct_count,
  COUNT(*) FILTER (WHERE e.event_type = 'classify' AND r.verdict = 'unsure')  AS unsure_count
FROM proactive_meter_events e
LEFT JOIN proactive_classification_review r
  ON r.workspace_id = e.workspace_id
 AND r.message_id   = e.message_id
WHERE e.workspace_id = $1
  AND e.created_at  >= $2`;

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

/**
 * Map a meter event type to its sibling `ADMIN_ACTIONS.proactive.*`
 * audit action. `accept` maps to `proactive.answer` (the moment the
 * answer was delivered). `offer` / `public_refused` aggregate into
 * the meter only — no audit emit.
 */
function adminActionForEvent(
  eventType: ProactiveEventType,
): AdminActionType | null {
  switch (eventType) {
    case "classify":
      return ADMIN_ACTIONS.proactive.classify;
    case "react":
      return ADMIN_ACTIONS.proactive.react;
    case "accept":
      return ADMIN_ACTIONS.proactive.answer;
    case "feedback":
      return ADMIN_ACTIONS.proactive.feedback;
    case "offer":
    case "public_refused":
      return null;
    default: {
      // Compile-time exhaustiveness — a future event type added to
      // ProactiveEventType breaks the build here instead of silently
      // returning `undefined` from this function.
      const _exhaustive: never = eventType;
      return _exhaustive;
    }
  }
}

/**
 * Emit the forensic audit row for a meter event. Fire-and-forget
 * (`logAdminAction` is documented as never-throws). Skips events that
 * have no sibling admin action.
 *
 * Ordering invariant: emit BEFORE the meter insert. If the meter retry
 * path drops the row, pino still captures the audit line — the table
 * itself is best-effort but the log floor survives.
 */
function emitMeterAudit(event: ProactiveMeterEvent): void {
  const adminAction = adminActionForEvent(event.eventType);
  if (!adminAction) return;
  logAdminAction({
    actionType: adminAction,
    targetType: "proactive",
    // channelId so admins filtering by channel see the row on the
    // channel they care about; message_id is too noisy.
    targetId: event.channelId,
    scope: "workspace",
    systemActor: "system:proactive-meter",
    metadata: {
      workspaceId: event.workspaceId,
      channelId: event.channelId,
      ...(event.messageId ? { messageId: event.messageId } : {}),
      ...(event.outcome ? { outcome: event.outcome } : {}),
      ...(event.confidence != null ? { confidence: event.confidence } : {}),
      ...(event.actorUserId ? { actorUserId: event.actorUserId } : {}),
      ...(event.metadata ?? {}),
    },
  });
}

/**
 * Real implementation backing the AnswerMeter service. Exported so the
 * plugin host (which lives outside Effect) can wire the meter callback
 * to the database without booting a full Effect runtime.
 *
 * Dual-write: every meter row whose event type has a sibling
 * `proactive.*` admin action also emits a `logAdminAction` row so the
 * forensic trail and the analytics rollup stay in lockstep.
 */
export async function recordMeterEvent(event: ProactiveMeterEvent): Promise<void> {
  emitMeterAudit(event);

  if (!hasInternalDB()) {
    log.debug(
      { eventType: event.eventType, workspaceId: event.workspaceId },
      "proactive_meter_events insert skipped — no internal DB",
    );
    return;
  }
  const metadataJson = JSON.stringify(event.metadata ?? {});
  const params: unknown[] = [
    event.workspaceId,
    event.channelId,
    event.messageId ?? null,
    event.eventType,
    event.outcome ?? null,
    event.tokens ?? 0,
    event.costMicroUsd ?? 0,
    event.confidence ?? null,
    event.actorUserId ?? null,
    metadataJson,
  ];
  // Single retry with a short backoff before dropping the row. The
  // meter is the billing source-of-truth and feeds the quota cap — a
  // dropped row both under-bills AND under-counts the next quota
  // check. One retry recovers from transient pool-exhaustion /
  // network blips; sustained outages still surface as `log.error` so
  // on-call alerting fires.
  try {
    await internalQuery(INSERT_SQL, params);
    return;
  } catch (firstErr) {
    try {
      // 250ms is short enough that the Chat SDK handler isn't visibly
      // delayed and long enough to clear a transient pool spike.
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      await internalQuery(INSERT_SQL, params);
      log.info(
        {
          eventType: event.eventType,
          workspaceId: event.workspaceId,
          firstError:
            firstErr instanceof Error ? firstErr.message : String(firstErr),
        },
        "proactive_meter_events insert succeeded after one retry",
      );
      return;
    } catch (secondErr: unknown) {
      // Both attempts failed — drop the row, log at error so on-call
      // alerting + the billing-reconcile job catch the gap. The caller
      // path (the plugin listener handler) must never crash the Chat
      // SDK loop, so the throw is swallowed at this layer.
      log.error(
        {
          firstError:
            firstErr instanceof Error ? firstErr.message : String(firstErr),
          err:
            secondErr instanceof Error
              ? secondErr.message
              : String(secondErr),
          eventType: event.eventType,
          workspaceId: event.workspaceId,
          channelId: event.channelId,
          messageId: event.messageId ?? null,
        },
        "proactive_meter_events insert failed twice — meter row dropped (billing + quota under-count this event)",
      );
    }
  }
}

/**
 * Summary fetch. Computes the cutoff timestamp at call time so a
 * 30-day rolling window is exactly that — the SQL parameter is the
 * cutoff, not "30 days".
 */
export async function summarizeMeterEvents(
  workspaceId: string,
  sinceMs: number,
): Promise<ProactiveMeterSummary> {
  if (!hasInternalDB()) {
    return aggregateRows([]);
  }
  const cutoff = new Date(Date.now() - sinceMs).toISOString();
  const rows = await internalQuery<ProactiveMeterRow>(SUMMARY_SQL, [
    workspaceId,
    cutoff,
  ]);
  // Postgres NUMERIC returns as string from `pg`; coerce to number
  // before aggregating. INTEGER columns come back as JS numbers.
  const normalized = rows.map((row) => ({
    ...row,
    cost_micro_usd:
      typeof row.cost_micro_usd === "string"
        ? Number(row.cost_micro_usd)
        : row.cost_micro_usd,
  }));
  return aggregateRows(normalized);
}

/**
 * One row as returned by `EVENTS_PAGE_SQL`. Snake_case mirrors the SQL;
 * `listEvents` normalises to camelCase before handing rows to callers.
 */
interface ProactiveEventDbRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  message_id: string | null;
  event_type: ProactiveEventType;
  outcome: ProactiveOutcome | null;
  tokens: number;
  cost_micro_usd: number | string;
  confidence: number | string | null;
  actor_user_id: string | null;
  metadata: Record<string, unknown> | string | null;
  created_at: string | Date;
  review_verdict: ProactiveReviewVerdict | null;
  review_note: string | null;
  review_reviewer_user_id: string | null;
  review_created_at: string | Date | null;
  review_updated_at: string | Date | null;
  [key: string]: unknown;
}

function isoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function normaliseEventRow(row: ProactiveEventDbRow): ProactiveEventRow {
  // metadata can come back as a parsed object (default `pg` types parser
  // on `jsonb`) or as a string when the driver is configured without the
  // automatic JSONB parser. Tolerate both rather than depending on a
  // specific pg configuration.
  const metadata: Record<string, unknown> =
    typeof row.metadata === "string"
      ? safeJsonParse(row.metadata, row.id)
      : (row.metadata ?? {});

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    messageId: row.message_id ?? null,
    eventType: row.event_type,
    outcome: row.outcome ?? null,
    tokens: typeof row.tokens === "string" ? Number(row.tokens) : row.tokens,
    costMicroUsd:
      typeof row.cost_micro_usd === "string"
        ? Number(row.cost_micro_usd)
        : row.cost_micro_usd,
    confidence:
      row.confidence === null
        ? null
        : typeof row.confidence === "string"
          ? Number(row.confidence)
          : row.confidence,
    actorUserId: row.actor_user_id ?? null,
    metadata,
    createdAt: isoString(row.created_at),
    review:
      row.review_verdict === null
        ? null
        : {
            verdict: row.review_verdict,
            note: row.review_note,
            reviewerUserId: row.review_reviewer_user_id,
            createdAt: isoString(row.review_created_at!),
            updatedAt: isoString(row.review_updated_at!),
          },
  };
}

function safeJsonParse(raw: string, rowId: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    // Surface the bad row at `warn` so a data corruption or pg-driver
    // misconfiguration is detectable rather than rendered as a silently
    // empty metadata column in the admin drill-down. Fall back to `{}`
    // so the row still renders — the alternative (drop the row) would
    // hide both the misfire signal AND the bad-row signal.
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        rowId,
        rawPreview: raw.slice(0, 64),
      },
      "proactive_meter_events metadata JSON parse failed — falling back to empty object",
    );
    return {};
  }
}

/**
 * Paginated drill-down list. See `listEvents` on `AnswerMeterShape` for
 * semantics. Returns an empty page when there's no internal DB (the
 * admin route is enterprise-only — a missing internal DB on an EE
 * deploy is misconfiguration; the surface degrades to "empty" rather
 * than throwing so the admin panel renders the empty state).
 */
export async function listMeterEvents(
  workspaceId: string,
  options: ListEventsOptions,
): Promise<ListEventsResult> {
  if (!hasInternalDB()) {
    return { events: [], nextCursor: null };
  }
  const limit = clampLimit(options.limit);
  const cutoff = new Date(Date.now() - options.sinceMs).toISOString();
  const eventTypeFilter = options.eventType ?? "";
  const cursorCreatedAt = options.cursor?.createdAt ?? null;
  const cursorId = options.cursor?.id ?? null;

  // Fetch one extra row to detect "has more" without a separate COUNT.
  const rows = await internalQuery<ProactiveEventDbRow>(EVENTS_PAGE_SQL, [
    workspaceId,
    cutoff,
    eventTypeFilter,
    cursorCreatedAt,
    cursorId,
    limit + 1,
  ]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const events = page.map(normaliseEventRow);

  const lastRow = page[page.length - 1];
  const nextCursor: EventCursor | null =
    hasMore && lastRow
      ? { createdAt: isoString(lastRow.created_at), id: lastRow.id }
      : null;

  return { events, nextCursor };
}

const DEFAULT_EVENT_PAGE_LIMIT = 50;

function clampLimit(raw: number | undefined): number {
  const n = raw ?? DEFAULT_EVENT_PAGE_LIMIT;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_EVENT_PAGE_LIMIT;
  return Math.min(Math.floor(n), MAX_EVENT_PAGE_LIMIT);
}

/**
 * Review-bucket rollup. The classify count overlaps with
 * `summarizeMeterEvents().classifyCount` for the same window — we
 * recompute it here so the misfire-rate tile pulls from one source
 * (single query, single timestamp). Computing the rate client-side
 * across two reads would risk a denominator (classify count) that
 * doesn't match the numerator if a new classify lands between the
 * two queries — the per-row LEFT JOIN here keeps both sides in lockstep.
 */
export async function summarizeReviewVerdicts(
  workspaceId: string,
  sinceMs: number,
): Promise<ProactiveReviewSummary> {
  if (!hasInternalDB()) {
    return {
      classifyCount: 0,
      reviewedCount: 0,
      misfireCount: 0,
      correctCount: 0,
      unsureCount: 0,
    };
  }
  const cutoff = new Date(Date.now() - sinceMs).toISOString();
  const rows = await internalQuery<{
    classify_count: number | string;
    reviewed_count: number | string;
    misfire_count: number | string;
    correct_count: number | string;
    unsure_count: number | string;
  }>(REVIEW_SUMMARY_SQL, [workspaceId, cutoff]);
  const row = rows[0];
  // `COUNT(*)` in pg returns bigint → JS string by default; coerce.
  function toInt(v: number | string | undefined): number {
    if (v === undefined) return 0;
    if (typeof v === "string") return Number(v);
    return v;
  }
  return {
    classifyCount: toInt(row?.classify_count),
    reviewedCount: toInt(row?.reviewed_count),
    misfireCount: toInt(row?.misfire_count),
    correctCount: toInt(row?.correct_count),
    unsureCount: toInt(row?.unsure_count),
  };
}

// ---------------------------------------------------------------------------
// Layer factory
// ---------------------------------------------------------------------------

/**
 * Live AnswerMeter Layer backed by the internal Postgres pool.
 *
 * `Layer.effect` (not `Layer.scoped`) — the service has no finalizer;
 * the underlying pool is owned by `internal.ts`.
 */
export const AnswerMeterLive: Layer.Layer<AnswerMeter> = Layer.effect(
  AnswerMeter,
  Effect.succeed({
    record: recordMeterEvent,
    summary: summarizeMeterEvents,
    listEvents: listMeterEvents,
    reviewSummary: summarizeReviewVerdicts,
  } satisfies AnswerMeterShape),
);
