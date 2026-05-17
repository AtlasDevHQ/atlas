/**
 * AnswerMeter — proactive-chat per-event meter.
 *
 * Records every classify / react / offer / accept / feedback event for
 * the proactive chat layer. Drives:
 *
 * - Eventual billing wiring (cost-per-classify shows up here first; the
 *   billing aggregator joins on `workspace_id` + `created_at`).
 * - Admin analytics: per-channel rollups, monthly counts, helpful /
 *   not-helpful split.
 *
 * Pairs with the audit log (new `proactive.*` action types in
 * `audit/actions.ts`) — the meter is the per-event row with cost; audit
 * is the human-readable forensic trail. We deliberately do NOT collapse
 * them: meter writes are high-volume per-classify (one per message); the
 * admin trail wants one human-readable row per state transition.
 *
 * Effect contract: `AnswerMeter` Context.Tag with a `Layer.effect`
 * factory so future Effect-based routes can `yield* AnswerMeter`. The
 * Live layer talks to the internal Postgres pool via `internalQuery`;
 * tests use `createAnswerMeterTestLayer(...)` from
 * `__test-utils__/layers.ts`.
 */

import { Context, Effect, Layer } from "effect";
import {
  hasInternalDB,
  internalQuery,
} from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("answer-meter");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Lifecycle stages a proactive interaction passes through.
 *
 * `public_refused` (#2297) is emitted when an unlinked asker reaches
 * the answer flow but the question's referenced entities aren't on
 * the workspace's curated public dataset. The discoverability rollup
 * in the admin console groups these by `metadata.entityName` so an
 * admin can see "what topic do non-linked askers keep trying" and
 * one-click widen the allowlist.
 */
export type ProactiveEventType =
  | "classify"
  | "react"
  | "offer"
  | "accept"
  | "feedback"
  | "public_refused";

/**
 * Outcomes captured on `feedback` events. `no-feedback` covers the
 * inactivity timeout — distinguishing "user thumb'd nothing" from
 * "user thumb-down'd" is important for the admin analytics panel.
 */
export type ProactiveOutcome =
  | "helpful"
  | "not-helpful"
  | "wrong-data"
  | "no-feedback";

/** One row in `proactive_meter_events`. */
export interface ProactiveMeterEvent {
  workspaceId: string;
  channelId: string;
  messageId?: string | null;
  eventType: ProactiveEventType;
  outcome?: ProactiveOutcome | null;
  /** LLM tokens consumed. 0 for non-classify or prefilter-rejected. */
  tokens?: number;
  /** Cost estimate in micro-USD (1e-6 USD). 0 until pricing wires. */
  costMicroUsd?: number;
  /** Classifier confidence in [0, 1], 2 decimal precision. */
  confidence?: number | null;
  /** Asker (classify/react/offer/accept) or feedback giver (feedback). */
  actorUserId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Per-channel rollup row returned by `summary`. Mirrors the top-level
 * shape so the admin UI can render channel cards next to the global
 * counts without a second query.
 */
export interface ChannelSummary {
  channelId: string;
  classifyCount: number;
  reactCount: number;
  offerCount: number;
  acceptCount: number;
  feedbackByOutcome: Record<ProactiveOutcome, number>;
  totalCostMicroUsd: number;
}

/** Whole-workspace rollup returned by `summary`. */
export interface ProactiveMeterSummary {
  classifyCount: number;
  reactCount: number;
  offerCount: number;
  acceptCount: number;
  feedbackByOutcome: Record<ProactiveOutcome, number>;
  totalCostMicroUsd: number;
  byChannel: ChannelSummary[];
}

/** Database row shape for `aggregateRows`. Snake_case mirrors the SQL. */
export interface ProactiveMeterRow {
  channel_id: string;
  event_type: ProactiveEventType;
  outcome: ProactiveOutcome | null;
  cost_micro_usd: number;
  /** Index signature so the row threads through `internalQuery<T>`. */
  [key: string]: unknown;
}

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
// Service shape + tag
// ---------------------------------------------------------------------------

export interface AnswerMeterShape {
  /** Insert one event row. Resolves once written (or no-op'd). */
  record(event: ProactiveMeterEvent): Promise<void>;
  /**
   * Aggregate events for a workspace over a recent window.
   *
   * `sinceMs` is the lookback window in milliseconds (e.g. 30 days =
   * `30 * 24 * 60 * 60 * 1000`). The cutoff is computed at call time so
   * the same lookback period yields a moving window.
   */
  summary(workspaceId: string, sinceMs: number): Promise<ProactiveMeterSummary>;
}

export class AnswerMeter extends Context.Tag("AnswerMeter")<
  AnswerMeter,
  AnswerMeterShape
>() {}

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

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

/**
 * Real implementation backing the AnswerMeter service. Exported so the
 * plugin host (which lives outside Effect) can wire the meter callback
 * to the database without booting a full Effect runtime.
 */
export async function recordMeterEvent(event: ProactiveMeterEvent): Promise<void> {
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

// ---------------------------------------------------------------------------
// Layer factories
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
  } satisfies AnswerMeterShape),
);

/**
 * Test layer factory — substitutes a partial implementation. Methods
 * not provided throw with a descriptive error so a test that exercises
 * an unmocked code path fails fast.
 */
export function createAnswerMeterTestLayer(
  partial: Partial<AnswerMeterShape> = {},
): Layer.Layer<AnswerMeter> {
  const stub: AnswerMeterShape = {
    record:
      partial.record ??
      (async () => {
        throw new Error(
          "AnswerMeter test stub: record() called but not provided in createAnswerMeterTestLayer()",
        );
      }),
    summary:
      partial.summary ??
      (async () => {
        throw new Error(
          "AnswerMeter test stub: summary() called but not provided in createAnswerMeterTestLayer()",
        );
      }),
  };
  return Layer.succeed(AnswerMeter, stub);
}
