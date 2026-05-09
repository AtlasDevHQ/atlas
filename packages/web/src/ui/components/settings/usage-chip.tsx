/**
 * Live MCP rate-limit usage chip for Settings → AI Agents (#2216).
 *
 * Renders "<used>/<ceiling>" against the per-OAuth-client weighted-
 * request quota with three visual tones:
 *
 *   - "ok"     (default, neutral) — below 80% of the ceiling
 *   - "warn"   (amber) — 80% to 99% inclusive
 *   - "danger" (red)  — at or above 100%
 *
 * The chip is informational — the real 429 still comes from the
 * limiter middleware on tool dispatch. Its job is to give the user a
 * pre-emptive signal so they can pace the agent.
 *
 * Display invariants pinned by `usage-chip.test.tsx`:
 *
 *   1. The numeric label is clamped at the ceiling so a hypothetical
 *      over-fill (e.g. limiter regression admitting past the cap)
 *      shows "60/60" rather than "65/60". The accompanying "danger"
 *      tone signals the saturation.
 *   2. `ceiling=0` does not produce NaN%; the chip falls back to the
 *      "ok" tone so a misconfiguration upstream does not paint every
 *      row red.
 *   3. Percentages are integer-rounded — fractional percent text in
 *      the accessible label would defeat the chip's "what your agent
 *      sees this minute" framing.
 */

"use client";

import { cn } from "@/lib/utils";

const SOFT_WARN_PERCENT = 80;
const HARD_CAP_PERCENT = 100;

export type UsageChipTone = "ok" | "warn" | "danger";

export interface UsageChipProps {
  /**
   * Live in-window weighted-request total (the limiter's per-tool
   * weight is already debited — this is the value the API surfaces
   * in `currentMinuteWeightedRequests`).
   */
  used: number;
  /** Resolved per-minute quota (admin override or workspace default). */
  ceiling: number;
  /** Optional aria-describedby target — e.g. a sibling tooltip. */
  describedBy?: string;
  className?: string;
}

function classifyTone(used: number, ceiling: number): UsageChipTone {
  if (ceiling <= 0) return "ok";
  const pct = (used / ceiling) * 100;
  if (pct >= HARD_CAP_PERCENT) return "danger";
  if (pct >= SOFT_WARN_PERCENT) return "warn";
  return "ok";
}

export function UsageChip({
  used,
  ceiling,
  describedBy,
  className,
}: UsageChipProps) {
  const tone = classifyTone(used, ceiling);
  // The displayed numerator is clamped at the ceiling so a saturated
  // chip always reads "ceiling/ceiling" — the tone alone communicates
  // the over-fill state. Negative ceilings collapse to the raw used
  // value (degenerate path, surfaced unmodified for debuggability).
  const displayUsed =
    ceiling > 0 ? Math.max(0, Math.min(used, ceiling)) : used;
  const pctRounded =
    ceiling > 0 ? Math.round((used / ceiling) * 100) : 0;

  return (
    <span
      // `role="img"` + `aria-label` is the standard escape hatch for a
      // pure-presentation chip whose visible text alone wouldn't give
      // a screen reader the percent context. The label includes both
      // the absolute count and the percent so AT users get the same
      // "approaching the limit" signal sighted users do from the tone.
      role="img"
      aria-label={`${pctRounded}% used (${displayUsed} of ${ceiling} weighted requests this minute)`}
      aria-describedby={describedBy}
      data-tone={tone}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px] tabular-nums shrink-0",
        // Neutral resting state — picked up the same dim treatment the
        // surrounding agent-row badges use so the chip reads as
        // metadata, not a control.
        tone === "ok" && "border-border/60 text-muted-foreground",
        // Amber soft-warning — same palette as the `Reconnect required`
        // badge on the same row so the warning vocabulary stays
        // consistent across the page.
        tone === "warn" &&
          "border-amber-500/40 text-amber-700 dark:text-amber-400",
        // Red hard-cap — matches the existing destructive button tones
        // so saturation reads as "you're at the limit" without
        // introducing a new color from outside the design system.
        tone === "danger" && "border-destructive/40 text-destructive",
        className,
      )}
    >
      {displayUsed}/{ceiling}
    </span>
  );
}
