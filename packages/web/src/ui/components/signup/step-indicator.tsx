"use client";

import { StepTrack } from "@/ui/components/onboarding/step-track";
import { stepsFor, type SignupStepId } from "./signup-steps";

interface StepIndicatorProps {
  current: SignupStepId;
  showRegion: boolean;
  className?: string;
}

/**
 * Signup-specific wrapper around the shared `<StepTrack />`. Picks the right
 * step list based on whether multi-region residency is configured.
 */
export function StepIndicator({ current, showRegion, className }: StepIndicatorProps) {
  return (
    <StepTrack
      steps={stepsFor(showRegion)}
      current={current}
      ariaLabel="Signup progress"
      className={className}
    />
  );
}
