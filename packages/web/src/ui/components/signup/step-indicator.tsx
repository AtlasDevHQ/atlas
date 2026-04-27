"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { stepIndex, stepsFor, type SignupStepId } from "./signup-steps";

interface StepIndicatorProps {
  current: SignupStepId;
  showRegion: boolean;
  className?: string;
}

/**
 * Numbered, labeled step indicator shared across the signup flow.
 *
 * Mobile (<sm): renders a compact "Step X of Y · Current label" pill plus a
 * decorative progress bar so the indicator never wraps awkwardly.
 *
 * Desktop (>=sm): renders the full named track. Steps before the current step
 * appear as filled circles with a check; the current step is highlighted; later
 * steps are muted. Connectors fill as you progress.
 */
export function StepIndicator({ current, showRegion, className }: StepIndicatorProps) {
  const steps = stepsFor(showRegion);
  const activeIndex = stepIndex(steps, current);
  const total = steps.length;
  const currentLabel = steps[activeIndex].label;
  const progressPct = total > 1 ? (activeIndex / (total - 1)) * 100 : 100;

  return (
    <nav aria-label="Signup progress" className={cn("w-full", className)}>
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
