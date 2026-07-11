"use client";

import { CopyButton } from "./copy-button";
import { Markdown } from "./markdown";
import { ToolPart } from "./tool-part";
import { parseSuggestions } from "../../lib/helpers";
import { activityAwaitsUser, partitionTurn, type TurnPart } from "./turn-partitioner";
import { TurnReceipt } from "./turn-receipt";
import { WorkingActivity } from "./working-activity";
import type { PythonProgressData } from "./python-result-card";
import type { PreviousExecution } from "./result-card-types";

/**
 * Answer-first rendering of an agent turn across its whole lifecycle
 * (#4298 finished shape, #4300 live phases — CONTEXT.md § Chat turn
 * presentation):
 *
 * - **Working phase** (`streaming`, no answer text yet): the live
 *   `WorkingActivity` feed — one compact line per step, results collapsed.
 * - **Settled, still streaming** (answer text has begun): the activity
 *   settles into the collapsed `TurnReceipt` and the answer streams as the
 *   dominant element. The would-be promoted artifact stays inside the
 *   receipt until the stream ends — expanding a chart mid-flight is exactly
 *   the layout churn this design removes, and the v1 partition heuristic can
 *   still reclassify trailing narration as activity if another step follows.
 * - **Finished** (`streaming` false, the default): receipt → answer → at
 *   most one promoted answer-bearing artifact.
 *
 * The transcript renders every assistant message through this one component
 * (the streaming flag flips on the last turn) so the receipt's open state and
 * the state of cards that stay inside it survive the stream settling — a
 * receipt expanded mid-stream stays expanded. (The promoted artifact's card
 * remounts when it leaves the receipt at stream end, so its own toggles reset
 * — mid-stream it is deliberately not rendered in its promoted position.) The
 * suggestion chips and Save/Share row stay with the caller
 * (they belong to the transcript row, not the turn's parts). Consumed by
 * both the chat transcript and the dashboard bound editor's drawer (#4301) —
 * the shared seam that keeps the two surfaces from drifting in formatting.
 */
export function AgentTurn({
  parts,
  pythonProgress,
  previousExecution,
  streaming = false,
}: {
  parts: readonly TurnPart[] | undefined;
  pythonProgress?: Map<string, PythonProgressData[]>;
  /**
   * Caller-supplied prior-execution snapshot for a rerun comparison (mirrors
   * the published `@useatlas/react` prop of the same name). Deliberately bound
   * to the promoted artifact's SQL card only — the snapshot describes the
   * answer-bearing result, not the intermediate queries inside the receipt.
   * The artifact isn't rendered while `streaming`, so combining the two props
   * is a harmless no-op, not a supported state.
   */
  previousExecution?: PreviousExecution;
  /** True while this turn's stream is still open (#4300 live rendering). */
  streaming?: boolean;
}) {
  const { activity, answer, answerBearingArtifact } = partitionTurn(parts);

  // A text part can be all <suggestions> block — stripped, it renders nothing.
  const hasRenderedAnswer = answer.some(
    ({ part }) => parseSuggestions(part.text).text.trim(),
  );

  // What the copy affordance writes (#4296): the answer's markdown SOURCE with
  // the <suggestions> block stripped — the same source text the Markdown
  // blocks below render (trimmed per part), joined across parts, not the
  // rendered DOM text.
  const answerCopyText = answer
    .map(({ part }) => parseSuggestions(part.text).text.trim())
    .filter(Boolean)
    .join("\n\n");

  // Working phase: the answer hasn't begun, the live feed is the whole turn.
  if (streaming && !hasRenderedAnswer) {
    return <WorkingActivity parts={parts ?? []} pythonProgress={pythonProgress} />;
  }

  // Mid-stream the artifact is not promoted out (see the doc comment above):
  // fold it back into the receipt at its original position so the work stays
  // inspectable and the summary counts every query that ran.
  const receiptActivity =
    streaming && answerBearingArtifact
      ? [...activity, answerBearingArtifact].toSorted((a, b) => a.index - b.index)
      : activity;

  return (
    <>
      <TurnReceipt
        activity={receiptActivity}
        pythonProgress={pythonProgress}
        // Start expanded when collapsing would hide the turn's substance:
        // (a) no answer and no artifact — the activity IS the turn (e.g. an
        // interrupted stream); (b) the activity holds an interactive card
        // awaiting a user decision (action approval, staged change, REST write
        // confirmation) — its buttons are the turn's point even when trailing
        // answer text exists.
        defaultOpen={
          (!hasRenderedAnswer && !answerBearingArtifact) ||
          activityAwaitsUser(receiptActivity)
        }
      />
      {hasRenderedAnswer && (
        // Named group so the hover reveal can't be hijacked by a bare `group`
        // ancestor (same guard as conversations/conversation-item.tsx).
        // space-y-2 matches the spacing both consumers' containers put between
        // answer parts. The wrapper is
        // unconditional across the stream settling so the answer blocks keep
        // their DOM position (no remount) when the copy row appears.
        <div className="group/turn-answer space-y-2">
          {answer.map(({ part, index }) => {
            const displayText = parseSuggestions(part.text).text;
            if (!displayText.trim()) return null;
            return (
              <div
                key={index}
                data-testid="turn-answer"
                className="max-w-[90%] text-[0.9375rem] leading-relaxed text-zinc-800 dark:text-zinc-200"
              >
                <Markdown content={displayText} />
              </div>
            );
          })}
          {/* #4296 — copy the answer's markdown source. Finished turns only:
              a still-streaming answer is incomplete, so offering to copy it
              would hand out a truncated snapshot. Always visible below the
              md: breakpoint (proxy for touch layouts); revealed on
              hover/focus from md: up. */}
          {!streaming && (
            <div className="opacity-100 transition-opacity md:opacity-0 md:group-focus-within/turn-answer:opacity-100 md:group-hover/turn-answer:opacity-100">
              <CopyButton text={answerCopyText} label="Copy answer" />
            </div>
          )}
        </div>
      )}
      {!streaming && answerBearingArtifact && (
        <div className="max-w-[95%]" data-testid="answer-artifact">
          <ToolPart
            part={answerBearingArtifact.part}
            pythonProgress={pythonProgress}
            previousExecution={previousExecution}
          />
        </div>
      )}
    </>
  );
}
