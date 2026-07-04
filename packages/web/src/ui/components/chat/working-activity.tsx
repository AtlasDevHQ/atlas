"use client";

import { Check } from "lucide-react";
import { getToolName, isToolUIPart } from "ai";
import type { UIMessage } from "ai";
import { Markdown } from "./markdown";
import { ToolPart } from "./tool-part";
import { parseSuggestions } from "../../lib/helpers";
import {
  isFailedToolPart,
  isPendingInteractivePart,
  type ToolTurnPart,
  type TurnPart,
} from "./turn-partitioner";
import type { PythonProgressData } from "./python-result-card";

/**
 * Per-step feed copy: what a tool execution is doing / has done, in the
 * user's vocabulary (CONTEXT.md § Chat turn presentation — "activity", not
 * "tool calls"). Unknown tools (plugin actions and other dynamic tools) fall
 * back to their wire name rather than hiding the step.
 */
function stepLabel(part: ToolTurnPart): { active: string; done: string } {
  const name = getToolName(part);
  switch (name) {
    case "explore":
      return { active: "Reading semantic layer", done: "Read semantic layer" };
    case "executeSQL":
      return { active: "Running query", done: "Ran query" };
    case "executePython":
      return { active: "Running Python", done: "Ran Python" };
    case "createDashboard":
      return { active: "Creating dashboard", done: "Created dashboard" };
    // #2365 — bound-editor destructive edits stage rather than commit.
    case "removeCard":
    case "updateCardSql":
      return { active: "Staging dashboard edit", done: "Staged dashboard edit" };
    // #2929 — REST datasource operations (reads here; writes stage a
    // confirmation envelope that renders at full card weight instead).
    case "executeRestOperation":
      return { active: "Calling REST datasource", done: "Called REST datasource" };
    default:
      return { active: `Running ${name}`, done: `Finished ${name}` };
  }
}

/**
 * True when the transcript should render the standalone pre-stream feed: a
 * turn is in flight but its assistant message hasn't mounted yet (#4300 — the
 * working phase begins at send, not at first stream part). Deliberately no
 * message-count gate, so the very first send of a fresh conversation shows it
 * too; once the assistant message mounts (even with zero parts), the
 * streaming turn's own feed takes over at the same visual position.
 */
export function showPreStreamActivity(
  isLoading: boolean,
  lastMessageRole: UIMessage["role"] | undefined,
): boolean {
  return isLoading && lastMessageRole !== "assistant";
}

/** A tool part whose execution has settled (result or error arrived). */
function isStepDone(part: ToolTurnPart): boolean {
  return part.state === "output-available" || part.state === "output-error";
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-3.5 shrink-0 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 dark:border-zinc-600 dark:border-t-zinc-300"
    />
  );
}

/**
 * The live activity feed of the working phase (#4300, CONTEXT.md § Chat turn
 * presentation): one compact line per step, ticking as steps complete, with
 * results accumulating collapsed — no chart/table ever expands mid-flight.
 * Renders from the moment of send (empty `parts` shows a lone "Working…"
 * line, so the first turn never opens with dead air) until the answer starts
 * streaming, at which point the caller settles it into the `TurnReceipt`.
 *
 * Two part kinds break the one-line rule on purpose:
 * - Pending interactive cards (action approvals, staged changes, REST write
 *   confirmations) render at full card weight — their buttons are the point,
 *   and the agent is parked on them.
 * - Narration text renders as muted sub-answer prose, same weight as inside
 *   the receipt it will settle into.
 */
export function WorkingActivity({
  parts,
  pythonProgress,
}: {
  parts: readonly TurnPart[];
  pythonProgress?: Map<string, PythonProgressData[]>;
}) {
  // While a step is executing its own line carries the pulse; between steps
  // (model composing the next move, or nothing streamed yet) a trailing
  // "Working…" line keeps the container visibly alive.
  const hasInFlightStep = parts.some(
    (part) => isToolUIPart(part) && !isStepDone(part),
  );

  return (
    <div className="max-w-[95%] space-y-1.5" data-testid="working-activity">
      {parts.map((part, index) => {
        if (part.type === "text") {
          const displayText = parseSuggestions(part.text).text;
          if (!displayText.trim()) return null;
          return (
            <div
              key={index}
              className="pl-6 pr-1.5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400"
            >
              <Markdown content={displayText} />
            </div>
          );
        }
        if (!isToolUIPart(part)) return null;
        if (isPendingInteractivePart(part)) {
          return (
            <div key={index} className="max-w-full">
              <ToolPart part={part} pythonProgress={pythonProgress} />
            </div>
          );
        }
        const done = isStepDone(part);
        const label = stepLabel(part);
        return (
          <div
            key={index}
            data-testid="activity-step"
            className="flex items-center gap-1.5 px-1.5 text-xs text-zinc-500 dark:text-zinc-400"
          >
            {done ? (
              <Check
                aria-hidden="true"
                className="size-3.5 shrink-0 text-zinc-400 dark:text-zinc-500"
              />
            ) : (
              <Spinner />
            )}
            <span>{done ? label.done : `${label.active}…`}</span>
            {done && isFailedToolPart(part) && (
              <span className="text-red-600 dark:text-red-400">· failed</span>
            )}
          </div>
        );
      })}
      {!hasInFlightStep && (
        <div
          data-testid="activity-working"
          className="flex items-center gap-1.5 px-1.5 text-xs text-zinc-500 dark:text-zinc-400"
        >
          <Spinner />
          <span>Working…</span>
        </div>
      )}
    </div>
  );
}
