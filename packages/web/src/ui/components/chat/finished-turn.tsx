"use client";

import { Markdown } from "./markdown";
import { ToolPart } from "./tool-part";
import { parseSuggestions } from "../../lib/helpers";
import { partitionTurn, type TurnPart } from "./turn-partitioner";
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
    ({ part }) => part.type === "text" && parseSuggestions(part.text).text.trim(),
  );

  return (
    <>
      <TurnReceipt
        activity={activity}
        pythonProgress={pythonProgress}
        // With no answer and no artifact, the activity IS the turn (interrupted
        // stream, approval-parked action) — start open so it isn't hidden
        // behind a bare one-line receipt.
        defaultOpen={!hasRenderedAnswer && !answerBearingArtifact}
      />
      {answer.map(({ part, index }) => {
        if (part.type !== "text") return null;
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
