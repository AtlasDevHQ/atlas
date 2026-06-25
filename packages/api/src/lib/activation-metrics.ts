/**
 * Cold-start activation funnel metrics (#3925).
 *
 * The launch-readiness conversion metric is *time-to-first-answer from a cold
 * click* — how long a brand-new visitor waits between asking their first
 * question and seeing a real answer. The two surfaces that produce that first
 * answer are the zero-signup public demo (`/api/v1/demo/chat`) and the authed
 * first-run chat (`/api/v1/chat`). Both emit a structured
 * `activation.first_answer_latency` event when an answer finishes streaming
 * *successfully* so the metric is measurable in logs / OTel without standing up
 * a separate analytics pipeline (there is no PostHog/Segment wired today).
 *
 * The caller gates the emit: `createUIMessageStream`'s `onFinish` fires even
 * after `onError` writes an error frame (a mid-stream provider failure) and on
 * client abort, so the routes skip those finishes (`isAborted` /
 * `finishReason === "error"`) — otherwise a turn that errored would be counted
 * as a delivered answer with a meaningless latency, corrupting the conversion
 * metric. Only a *pre-stream* throw (runAgent failing before the stream is
 * returned) bypasses `onFinish` entirely.
 *
 * `firstTurn` (see {@link isFirstTurn}) approximates the conversation's opening
 * user message — the cold-start "aha" — from the user-message count in the
 * request payload, which is exact because these surfaces post the full message
 * history. Downstream dashboards filter on it to isolate time-to-first-answer
 * from steady-state turn latency.
 *
 * The builder is a pure function (no clock, no IO) so the event shape is unit
 * testable; the route supplies `Date.now()` readings at request-entry and at
 * stream `onFinish`.
 */
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("activation");

/** The funnel surface that produced the answer. */
export type ActivationSurface = "chat" | "demo";

export interface FirstAnswerLatencyEvent {
  /** Stable discriminator for log/OTel queries. */
  readonly event: "activation.first_answer_latency";
  readonly surface: ActivationSurface;
  /** Wall-clock ms from request entry to answer-stream completion. */
  readonly latencyMs: number;
  /** True when this is the conversation's first user turn (the cold-start answer). */
  readonly firstTurn: boolean;
  readonly requestId: string;
  readonly conversationId?: string;
  readonly runId?: string;
}

export interface FirstAnswerLatencyInput {
  readonly surface: ActivationSurface;
  /** `Date.now()` captured at request entry. */
  readonly startedAtMs: number;
  /** `Date.now()` captured when the answer stream finished. */
  readonly finishedAtMs: number;
  readonly firstTurn: boolean;
  readonly requestId: string;
  readonly conversationId?: string;
  readonly runId?: string;
}

/**
 * Whether a chat request is the conversation's opening user turn. Both
 * first-answer surfaces post the full `useChat` message history, so the opening
 * turn carries exactly one user message and later turns carry the growing
 * history. Extracted (rather than inlined at each route) so the two surfaces
 * cannot silently disagree on what "first turn" means, and so the contract is
 * pinned by a test — if a future transport ever posts only the latest turn,
 * that test is where the breakage surfaces. `<= 1` (not `=== 1`) is defensive:
 * a malformed zero-user-message payload counts as a first turn rather than
 * throwing off the boundary.
 */
export function isFirstTurn(
  messages: ReadonlyArray<{ readonly role: string }>,
): boolean {
  return messages.filter((m) => m.role === "user").length <= 1;
}

/**
 * Whether an agent turn actually *answered* a data question — i.e. `executeSQL`
 * ran a query that came back successfully. Gates the onboarding
 * `first_query_executed` milestone (#3962): the milestone must reflect a query
 * the user got a real answer to, not merely "a chat turn happened". Firing it at
 * stream-creation on any turn (the prior behavior) marked the milestone even for
 * a turn whose SQL was rejected by the table whitelist (#3961), errored, or
 * never touched the database — none of which is a first answer.
 *
 * Reads the success-discriminated `executeSQL` tool output (`{ success: true, … }`
 * for an answered query; `{ success: false, error }` for a rejected/failed one —
 * see `lib/tools/sql.ts`). Pure over the resolved agent steps, so it is unit
 * testable without driving the route.
 */
export function turnAnsweredQuery(
  steps: ReadonlyArray<{
    readonly toolResults?: ReadonlyArray<{ readonly toolName: string; readonly output: unknown }>;
  }>,
): boolean {
  return steps.some((step) =>
    (step.toolResults ?? []).some(
      (tr) =>
        tr.toolName === "executeSQL" &&
        typeof tr.output === "object" &&
        tr.output !== null &&
        (tr.output as { success?: unknown }).success === true,
    ),
  );
}

/**
 * Shape the structured first-answer-latency event. Pure: clamps to a
 * non-negative integer (a backwards clock or a finish reading taken before the
 * start must never emit a negative latency) and omits correlation ids that
 * weren't supplied rather than emitting `undefined` keys.
 */
export function buildFirstAnswerLatencyEvent(
  input: FirstAnswerLatencyInput,
): FirstAnswerLatencyEvent {
  const latencyMs = Math.max(0, Math.round(input.finishedAtMs - input.startedAtMs));
  return {
    event: "activation.first_answer_latency",
    surface: input.surface,
    latencyMs,
    firstTurn: input.firstTurn,
    requestId: input.requestId,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
  };
}

/**
 * Emit the first-answer-latency event. Called from the chat/demo stream
 * `onFinish` after the caller has gated out aborted/errored finishes, so the
 * metric counts only answers a visitor actually received.
 *
 * Fire-and-forget telemetry must never throw into the stream lifecycle: the
 * body is trivially safe today (pure builder + a fail-open pino call), but the
 * try/catch makes that contract self-defending so a future edit that adds
 * throwing work here can't break the very cold-start path it measures.
 */
export function logFirstAnswerLatency(input: FirstAnswerLatencyInput): void {
  try {
    const evt = buildFirstAnswerLatencyEvent(input);
    log.info(
      evt,
      "Activation funnel: %s answer delivered in %dms (firstTurn=%s)",
      evt.surface,
      evt.latencyMs,
      String(evt.firstTurn),
    );
  } catch (err) {
    // Telemetry is best-effort — never let it surface into the response stream.
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "first-answer-latency emit failed",
    );
  }
}
