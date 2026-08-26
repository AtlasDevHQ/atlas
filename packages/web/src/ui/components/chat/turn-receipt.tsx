"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";
import { ToolPart } from "./tool-part";
import { parseSuggestions } from "../../lib/helpers";
import {
  answerTrustTiers,
  summarizeActivity,
  type IndexedTurnPart,
  type TextTurnPart,
  type ToolTurnPart,
} from "./turn-partitioner";
import { TierBadge } from "./tier-badge";
import type { PythonProgressData } from "./python-result-card";

/**
 * The collapsed receipt a turn's activity settles into (#4298) — rendered
 * once the answer starts streaming (mid-stream, #4300) and after finish:
 * one muted summary line ("Explored schema · 2 queries") that expands on
 * click to the full activity — tool cards with today's affordances (Show
 * SQL, result views) plus the agent's narration at sub-answer weight.
 *
 * Renders nothing for empty activity (a zero-tool turn has no receipt).
 * `defaultOpen` lets the caller keep the work visible when collapsing would
 * hide the turn's substance — see AgentTurn for the policy.
 */
export function TurnReceipt({
  activity,
  answerBearingArtifact = null,
  pythonProgress,
  defaultOpen = false,
}: {
  activity: readonly IndexedTurnPart<TextTurnPart | ToolTurnPart>[];
  /**
   * The query result `partitionTurn` promoted out of `activity` to sit beside
   * the answer. Passed in ONLY so its tier reaches the chips (#5451): it is
   * rendered next to the answer, never inside this receipt.
   */
  answerBearingArtifact?: IndexedTurnPart<ToolTurnPart> | null;
  pythonProgress?: Map<string, PythonProgressData[]>;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (activity.length === 0) return null;

  // #5451 — on the collapsed row, not inside it. Every card that carries a
  // tier lives in the expanded body, so chips shown only there would leave a
  // finished answer reading exactly as it did when no surface rendered the
  // tier at all: prose, and a summary line the reader has no reason to click.
  // ⚠️ The promoted artifact too. A turn that ran one query has it lifted OUT
  // of `activity`, so activity alone renders no `warehouse` chip on the
  // commonest SURVEYED turn there is.
  const tiers = answerTrustTiers(activity, answerBearingArtifact);

  return (
    <div className="max-w-[95%]" data-testid="turn-receipt">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-zinc-500 transition-colors hover:bg-zinc-100/60 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800/40 dark:hover:text-zinc-300"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
        <span>{summarizeActivity(activity)}</span>
        {tiers.length > 0 && (
          <span
            data-testid="turn-trust-tiers"
            className="inline-flex items-center gap-1"
            // Names the row for assistive tech, so the chips read as one
            // statement about the answer rather than four loose words.
            aria-label={`Grounded in: ${tiers.join(", ")}`}
          >
            {tiers.map((tier) => (
              <TierBadge key={tier} tier={tier} />
            ))}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-1 space-y-2 border-l-2 border-zinc-200 pl-3 dark:border-zinc-800">
          {activity.map(({ part, index }) => {
            if (part.type === "text") {
              const displayText = parseSuggestions(part.text).text;
              if (!displayText.trim()) return null;
              return (
                <div
                  key={index}
                  className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400"
                >
                  <Markdown content={displayText} />
                </div>
              );
            }
            return <ToolPart key={index} part={part} pythonProgress={pythonProgress} />;
          })}
        </div>
      )}
    </div>
  );
}
