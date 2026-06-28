/**
 * AnswerMeter — proactive-chat per-event meter (CORE Tag + type surface).
 *
 * Records every classify / react / offer / accept / feedback event for
 * the proactive chat layer; drives eventual billing wiring and the admin
 * analytics rollups.
 *
 * ## Why this file is split (#3999 / WS5 of #3984)
 *
 * Proactive chat is a paid EE surface, so the meter's **implementation**
 * (SQL, the `recordMeterEvent`/`summarize*`/`listMeterEvents` readers,
 * the pure `aggregateRows` roller, and `AnswerMeterLive`) lives in
 * `@atlas/ee/proactive/answer-meter`. This core file keeps only the
 * declarative surface that core consumers reference without importing
 * `@atlas/ee`:
 *
 *   - the `AnswerMeter` Context.Tag + `AnswerMeterShape` (the admin
 *     analytics + events routes `yield* AnswerMeter`),
 *   - every meter/event/cursor type the routes + `__test-utils__` use,
 *   - `MAX_EVENT_PAGE_LIMIT` (the events route clamps to it),
 *   - `createAnswerMeterTestLayer` (core route tests substitute a fake),
 *   - `NoopAnswerMeterLayer` (the non-EE default — never reached through
 *     a route, which 403s at `ProactiveGate` first; present so the app
 *     layer can bind the Tag on a non-EE deploy).
 *
 * The EE `AnswerMeterLive` is bound onto the Tag via `ee/src/layers.ts`
 * and overrides the Noop when enterprise is enabled, exactly like every
 * other EE subsystem.
 */

import { Context, Layer } from "effect";
import { EnterpriseError } from "@atlas/api/lib/effect/errors";
import type {
  ProactiveMeterEventType as ProactiveEventType,
  ProactiveMeterOutcome as ProactiveOutcome,
  ProactiveMeterEvent,
} from "@useatlas/types";

// Re-export with the local alias names so existing imports keep
// working. Canonical shapes live in `@useatlas/types/proactive`.
export type { ProactiveEventType, ProactiveOutcome, ProactiveMeterEvent };

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
  /**
   * Paginated drill-down (#2622). Returns up to `limit` events from the
   * lookback window joined with the review verdict (if any). Keyset
   * cursor — pass `cursor` from the previous page's `nextCursor` to
   * continue.
   */
  listEvents(
    workspaceId: string,
    options: ListEventsOptions,
  ): Promise<ListEventsResult>;
  /**
   * Labelled-misfire summary (#2622) — classify-count vs reviewed-count
   * vs verdict buckets over the same lookback window. Surfaced as a
   * tile on the existing aggregate panel.
   */
  reviewSummary(
    workspaceId: string,
    sinceMs: number,
  ): Promise<ProactiveReviewSummary>;
}

// ---------------------------------------------------------------------------
// Drill-down event row + pagination
// ---------------------------------------------------------------------------

/** Verdict captured by an admin reviewer. */
export type ProactiveReviewVerdict = "misfire" | "correct" | "unsure";

/** One row returned by `listEvents` — meter row + optional verdict. */
export interface ProactiveEventRow {
  id: string;
  workspaceId: string;
  channelId: string;
  messageId: string | null;
  eventType: ProactiveEventType;
  outcome: ProactiveOutcome | null;
  tokens: number;
  costMicroUsd: number;
  /** Classifier confidence in `[0, 1]` to 2 d.p. Null for non-classify rows. */
  confidence: number | null;
  actorUserId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  /** Verdict if one has been recorded for this `(workspaceId, messageId)`. */
  review: ProactiveEventReview | null;
}

/** Embedded review payload — null when no verdict exists yet. */
export interface ProactiveEventReview {
  verdict: ProactiveReviewVerdict;
  note: string | null;
  reviewerUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Cursor handed back to the client for "fetch next page". */
export interface EventCursor {
  /** ISO timestamp of the cursor row. */
  createdAt: string;
  /** Row id — the keyset tie-breaker. */
  id: string;
}

export interface ListEventsOptions {
  /** Lookback window in ms. The same parser the analytics route uses applies upstream. */
  sinceMs: number;
  /** Filter to one meter event type. Default: include every type. */
  eventType?: ProactiveEventType;
  /** Maximum rows per page. Clamped to `[1, MAX_EVENT_PAGE_LIMIT]`. Default 50. */
  limit?: number;
  /** Opaque cursor from a previous page. */
  cursor?: EventCursor | null;
}

export interface ListEventsResult {
  events: ProactiveEventRow[];
  /** Non-null when more rows exist past `events[events.length - 1]`. */
  nextCursor: EventCursor | null;
}

/** Hard cap so a misbehaving client cannot paginate huge windows in one call. */
export const MAX_EVENT_PAGE_LIMIT = 200;

export interface ProactiveReviewSummary {
  /** Total classify rows in the window. */
  classifyCount: number;
  /** Classify rows that have a verdict in `proactive_classification_review`. */
  reviewedCount: number;
  /** Subset of `reviewedCount` labelled `misfire`. */
  misfireCount: number;
  /** Subset of `reviewedCount` labelled `correct`. */
  correctCount: number;
  /** Subset of `reviewedCount` labelled `unsure`. */
  unsureCount: number;
}

export class AnswerMeter extends Context.Tag("AnswerMeter")<
  AnswerMeter,
  AnswerMeterShape
>() {}

// ---------------------------------------------------------------------------
// Layer factories
// ---------------------------------------------------------------------------

const NOT_AVAILABLE_MESSAGE =
  "AnswerMeter requires enterprise features (proactive chat) to be enabled.";

/**
 * No-op default for non-EE deploys. Proactive chat is enterprise-gated,
 * so a route reaching the meter has already passed `ProactiveGate`
 * (which fails closed with `EnterpriseError` → 403 when EE is off) — the
 * Noop methods are therefore never invoked through a route. They reject
 * with a descriptive `EnterpriseError` so an unguarded non-route caller
 * fails loudly rather than silently mis-recording / returning empty
 * data. The EE `AnswerMeterLive` (`ee/src/proactive/answer-meter.ts`)
 * overrides this Tag when enterprise is enabled.
 */
export const NoopAnswerMeterLayer: Layer.Layer<AnswerMeter> = Layer.succeed(
  AnswerMeter,
  {
    record: () => Promise.reject(new EnterpriseError(NOT_AVAILABLE_MESSAGE)),
    summary: () => Promise.reject(new EnterpriseError(NOT_AVAILABLE_MESSAGE)),
    listEvents: () => Promise.reject(new EnterpriseError(NOT_AVAILABLE_MESSAGE)),
    reviewSummary: () =>
      Promise.reject(new EnterpriseError(NOT_AVAILABLE_MESSAGE)),
  } satisfies AnswerMeterShape,
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
    listEvents:
      partial.listEvents ??
      (async () => {
        throw new Error(
          "AnswerMeter test stub: listEvents() called but not provided in createAnswerMeterTestLayer()",
        );
      }),
    reviewSummary:
      partial.reviewSummary ??
      (async () => {
        throw new Error(
          "AnswerMeter test stub: reviewSummary() called but not provided in createAnswerMeterTestLayer()",
        );
      }),
  };
  return Layer.succeed(AnswerMeter, stub);
}
