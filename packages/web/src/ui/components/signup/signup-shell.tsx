"use client";

import { OnboardingShell, type OnboardingShellWidth } from "@/ui/components/onboarding/onboarding-shell";
import { StepIndicator } from "./step-indicator";
import { useSignupContext } from "./signup-context-provider";
import type { SignupStepId } from "./signup-steps";

interface SignupShellProps {
  step: SignupStepId;
  /** Container width for the page body. Connect uses xwide for the two-card layout. */
  width?: OnboardingShellWidth;
  /** Optional back-link target. Renders a back affordance in the top bar. */
  back?: { href: string; label?: string };
  children: React.ReactNode;
}

export function SignupShell({ step, width = "default", back, children }: SignupShellProps) {
  const ctx = useSignupContext();
  const detected = ctx.status === "ready" ? ctx.showRegion : false;
  // If a user lands directly on /signup/region while the availability probe is
  // still loading (or returned false), force the region step into the indicator
  // — otherwise stepsFor() omits it and the active step has no slot.
  const showRegion = detected || step === "region";

  return (
    <OnboardingShell
      width={width}
      back={back}
      indicator={<StepIndicator current={step} showRegion={showRegion} />}
    >
      {children}
    </OnboardingShell>
  );
}
