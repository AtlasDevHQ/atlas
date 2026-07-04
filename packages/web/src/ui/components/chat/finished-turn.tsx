"use client";

import { Markdown } from "./markdown";
import { ToolPart } from "./tool-part";
import { parseSuggestions } from "../../lib/helpers";
import { activityAwaitsUser, partitionTurn, type TurnPart } from "./turn-partitioner";
import { TurnReceipt } from "./turn-receipt";
import type { PythonProgressData } from "./python-result-card";

/**
 * Answer-first rendering of a completed assistant turn (#4298): the activity
 * collapses into a `TurnReceipt`, the answer is the dominant element, and at
 * most one promoted answer-bearing artifact sits with it. Streaming turns keep
 * the live part-by-part renderer — this component is for finished turns only.
 * The suggestion chips and Save/Share row stay with the caller (they belong to
 * the transcript row, not the turn's parts).
 */
export function FinishedTurn({
  parts,
  pythonProgress,
}: {
  parts: readonly TurnPart[] | undefined;
  pythonProgress?: Map<string, PythonProgressData[]>;
}) {
  const { activity, answer, answerBearingArtifact } = partitionTurn(parts);

  // A text part can be all <suggestions> block — stripped, it renders nothing.
  const hasRenderedAnswer = answer.some(
    ({ part }) => parseSuggestions(part.text).text.trim(),
  );

  return (
    <>
      <TurnReceipt
        activity={activity}
        pythonProgress={pythonProgress}
        // Start expanded when collapsing would hide the turn's substance:
        // (a) no answer and no artifact — the activity IS the turn (e.g. an
        // interrupted stream); (b) the activity holds an interactive card
        // awaiting a user decision (action approval, staged change, REST write
        // confirmation) — its buttons are the turn's point even when trailing
        // answer text exists.
        defaultOpen={
          (!hasRenderedAnswer && !answerBearingArtifact) || activityAwaitsUser(activity)
        }
      />
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
      {answerBearingArtifact && (
        <div className="max-w-[95%]" data-testid="answer-artifact">
          <ToolPart part={answerBearingArtifact.part} pythonProgress={pythonProgress} />
        </div>
      )}
    </>
  );
}
