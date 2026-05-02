"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface StepTrackItem {
  readonly id: string;
  readonly label: string;
}

interface StepTrackProps<T extends StepTrackItem> {
  /** Ordered list of steps. */
  steps: readonly T[];
  /** ID of the active step. Must be present in `steps`. */
  current: T["id"];
  /** Optional aria-label for the nav. Falls back to "Progress". */
  ariaLabel?: string;
  className?: string;
}

/**
 * Throws synchronously if `current` isn't in `steps` so callers can't ship a
 * "Step 1 of N / unknown" indicator if their step id drifts from the list.
 */
export function StepTrack<T extends StepTrackItem>({
  steps,
  current,
  ariaLabel = "Progress",
  className,
}: StepTrackProps<T>) {
  const total = steps.length;
  const activeIndex = steps.findIndex((s) => s.id === current);
  if (activeIndex === -1) {
    throw new Error(`StepTrack: step "${current}" not found in step list`);
  }
  const currentLabel = steps[activeIndex].label;
  const progressPct = total > 1 ? (activeIndex / (total - 1)) * 100 : 100;

  return (
    <nav aria-label={ariaLabel} className={cn("w-full", className)}>
      <div className="sm:hidden">
        <div className="flex items-baseline justify-between text-xs">
          <span className="font-medium text-foreground">
            Step {activeIndex + 1} of {total}
          </span>
          <span className="text-muted-foreground">{currentLabel}</span>
        </div>
        <div
          aria-hidden="true"
          className="mt-2 h-1 overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      <ol className="hidden items-center gap-2 sm:flex">
        {steps.map((step, idx) => {
          const isComplete = idx < activeIndex;
          const isCurrent = idx === activeIndex;
          const showConnector = idx < total - 1;
          return (
            <li key={step.id} className="flex flex-1 items-center gap-2">
              <div
                className="flex items-center gap-2"
                aria-current={isCurrent ? "step" : undefined}
              >
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold transition-colors",
                    isComplete && "border-primary bg-primary text-primary-foreground",
                    isCurrent && "border-primary bg-primary/10 text-primary",
                    !isComplete && !isCurrent && "border-border bg-background text-muted-foreground",
                  )}
                  aria-hidden="true"
                >
                  {isComplete ? <Check className="size-3" /> : idx + 1}
                </span>
                <span
                  className={cn(
                    "text-xs font-medium transition-colors",
                    isCurrent ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {step.label}
                </span>
              </div>
              {showConnector && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-px flex-1 transition-colors",
                    isComplete ? "bg-primary" : "bg-border",
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
