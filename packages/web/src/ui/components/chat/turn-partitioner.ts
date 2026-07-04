/**
 * Turn partitioner (#4298) — the single seam that decides how a finished agent
 * turn is presented, per CONTEXT.md § Chat turn presentation. A pure function
 * (no React, no DOM) so both the chat transcript and the notebook renderer
 * (#4301) partition identically, and the live working phase (#4300) can settle
 * into the same shape.
 *
 * Boundary rules (v1 — all of them live here, nowhere else):
 * - Everything up to and including the last tool part is **activity** (tool
 *   executions plus the narration text around them). It renders inside the
 *   receipt.
 * - Text parts after the last tool part are the **answer**. A zero-tool turn is
 *   all answer; an interrupted stream can have an empty answer.
 * - The last *successful* `executeSQL` result is promoted as the
 *   **answer-bearing artifact** and excluded from `activity` — it sits with the
 *   answer, everything else stays in the receipt.
 * - Reasoning parts are never surfaced in any bucket — the receipt is activity,
 *   not chain-of-thought. Non-renderable parts (step-start, data, source, file)
 *   are dropped, matching what the transcript rendered before this seam.
 *
 * If this heuristic misfires in practice, the planned escape hatch is an
 * explicit agent-emitted answer marker (see PRD #4292) — not more rules here.
 */

import {
  isToolUIPart,
  getToolName,
  type UIMessagePart,
  type UIDataTypes,
  type UITools,
  type ToolUIPart,
  type DynamicToolUIPart,
} from "ai";
import { isActionToolResult } from "../../lib/action-types";
import { isRestWriteConfirmResult } from "../../lib/rest-operation-types";

/** One part of an assistant message, as delivered by the AI SDK. */
export type TurnPart = UIMessagePart<UIDataTypes, UITools>;

/** The text arm of {@link TurnPart} — what `answer` and narration are made of. */
export type TextTurnPart = Extract<TurnPart, { type: "text" }>;

/** The tool arms of {@link TurnPart} — exactly what `isToolUIPart` narrows to. */
export type ToolTurnPart = ToolUIPart<UITools> | DynamicToolUIPart;

/**
 * A part paired with its index in the original `parts` array. The index is the
 * stable React key: partition output arrays re-shuffle across buckets, but the
 * source position of a part never changes once streamed.
 */
export interface IndexedTurnPart<P extends TurnPart = TurnPart> {
  readonly part: P;
  readonly index: number;
}

/** The three presentation buckets of a finished turn. */
export interface PartitionedTurn {
  /**
   * What the agent did on the way to the answer — tool parts plus narration
   * text — excluding the promoted artifact. Rendered inside the receipt.
   */
  readonly activity: readonly IndexedTurnPart<TextTurnPart | ToolTurnPart>[];
  /**
   * The turn's user-facing text: non-empty text parts after the last tool
   * part. Empty for an interrupted stream that never reached the answer.
   */
  readonly answer: readonly IndexedTurnPart<TextTurnPart>[];
  /**
   * The at-most-one query result promoted to sit with the answer, or null
   * when no successful `executeSQL` ran.
   */
  readonly answerBearingArtifact: IndexedTurnPart<ToolTurnPart> | null;
}

/** A completed executeSQL whose output reported success — the only promotable shape (v1). */
function isPromotableQueryResult(part: TurnPart): part is ToolTurnPart {
  if (!isToolUIPart(part)) return false;
  if (getToolName(part) !== "executeSQL") return false;
  if (part.state !== "output-available") return false;
  const output = part.output;
  return (
    output != null &&
    typeof output === "object" &&
    Boolean((output as { success?: unknown }).success)
  );
}

function isNonEmptyText(part: TurnPart): part is TextTurnPart {
  return part.type === "text" && part.text.trim().length > 0;
}

/**
 * Split a finished assistant turn's parts into
 * `{ activity, answer, answerBearingArtifact }`.
 *
 * Total over any parts array (in-progress tool parts are activity; a
 * still-streaming trailing text part is the answer), but this slice only
 * consumes it for completed turns — streaming turns keep the live renderer.
 */
export function partitionTurn(parts: readonly TurnPart[] | undefined): PartitionedTurn {
  if (!parts || parts.length === 0) {
    return { activity: [], answer: [], answerBearingArtifact: null };
  }

  let lastToolIndex = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (isToolUIPart(parts[i])) {
      lastToolIndex = i;
      break;
    }
  }

  let answerBearingArtifact: IndexedTurnPart<ToolTurnPart> | null = null;
  for (let i = lastToolIndex; i >= 0; i--) {
    const part = parts[i];
    if (isPromotableQueryResult(part)) {
      answerBearingArtifact = { part, index: i };
      break;
    }
  }

  const activity: IndexedTurnPart<TextTurnPart | ToolTurnPart>[] = [];
  const answer: IndexedTurnPart<TextTurnPart>[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i <= lastToolIndex) {
      if (i === answerBearingArtifact?.index) continue; // promoted out of the receipt
      if (isToolUIPart(part) || isNonEmptyText(part)) {
        activity.push({ part, index: i });
      }
    } else if (isNonEmptyText(part)) {
      answer.push({ part, index: i });
    }
  }

  return { activity, answer, answerBearingArtifact };
}

/**
 * True when `output` is one of the interactive tool envelopes that waits on a
 * user decision: a pending action approval, a staged dashboard change
 * (#2365 `stage_required` — the card validates the full payload, the kind
 * alone identifies the envelope family), or a REST write confirmation (#2929).
 */
function isPendingInteractiveResult(output: unknown): boolean {
  if (output == null || typeof output !== "object") return false;
  if ((output as { kind?: unknown }).kind === "stage_required") return true;
  if (isRestWriteConfirmResult(output)) return true;
  return isActionToolResult(output) && output.status === "pending";
}

/**
 * True when any activity part is an interactive card awaiting the user
 * (action approval, staged change, write confirmation). The receipt must not
 * collapse these out of sight — even when the turn also has answer text
 * ("I need your approval to…"), the decision buttons are the turn's point.
 */
export function activityAwaitsUser(
  activity: readonly IndexedTurnPart<TextTurnPart | ToolTurnPart>[],
): boolean {
  return activity.some(
    ({ part }) =>
      isToolUIPart(part) &&
      part.state === "output-available" &&
      isPendingInteractiveResult(part.output),
  );
}

/**
 * A tool execution that ended in failure: the AI SDK's `output-error` state,
 * or a completed result envelope reporting `success: false` (the executeSQL /
 * executePython family). Action envelopes have their own resolved-failure
 * states rendered by their cards; the receipt marker covers the common
 * query-failure case.
 */
function isFailedToolPart(part: ToolTurnPart): boolean {
  if (part.state === "output-error") return true;
  if (part.state !== "output-available") return false;
  const output = part.output;
  return (
    output != null &&
    typeof output === "object" &&
    (output as { success?: unknown }).success === false
  );
}

/**
 * The receipt's one-line summary of what stayed in it, e.g.
 * "Explored schema · 2 queries". Counts describe the receipt's own contents —
 * the promoted artifact is visible next to the answer, not re-counted here.
 * Failed executions append a "· N failed" marker so a collapsed receipt never
 * reads identically to a clean run. Returns "" for empty activity (the
 * receipt doesn't render then).
 */
export function summarizeActivity(
  activity: readonly IndexedTurnPart<TextTurnPart | ToolTurnPart>[],
): string {
  if (activity.length === 0) return "";

  let explores = 0;
  let queries = 0;
  let pythonRuns = 0;
  let otherSteps = 0;
  let failed = 0;
  for (const { part } of activity) {
    if (!isToolUIPart(part)) continue;
    if (isFailedToolPart(part)) failed++;
    switch (getToolName(part)) {
      case "explore":
        explores++;
        break;
      case "executeSQL":
        queries++;
        break;
      case "executePython":
        pythonRuns++;
        break;
      default:
        otherSteps++;
    }
  }

  const segments: string[] = [];
  if (explores > 0) segments.push("Explored schema");
  if (queries > 0) segments.push(queries === 1 ? "1 query" : `${queries} queries`);
  if (pythonRuns > 0) {
    segments.push(pythonRuns === 1 ? "1 Python run" : `${pythonRuns} Python runs`);
  }
  if (otherSteps > 0) {
    segments.push(otherSteps === 1 ? "1 more step" : `${otherSteps} more steps`);
  }
  if (failed > 0) segments.push(`${failed} failed`);

  // Narration-only receipts (the lone query was promoted) still need a label.
  return segments.length > 0 ? segments.join(" · ") : "Working notes";
}
