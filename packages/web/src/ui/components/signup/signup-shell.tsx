"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { StepIndicator } from "./step-indicator";
import { useSignupContext } from "./signup-context-provider";
import type { SignupStepId } from "./signup-steps";

const WIDTHS = {
  default: "max-w-md",
  wide: "max-w-2xl",
  xwide: "max-w-4xl",
} as const;

type ShellWidth = keyof typeof WIDTHS;

interface SignupShellProps {
  step: SignupStepId;
  /** Container width for the page body. Connect uses xwide for the two-card layout. */
  width?: ShellWidth;
  /** Optional back-link target. Renders a back affordance in the top bar. */
  back?: { href: string; label?: string };
  children: React.ReactNode;
}

const AtlasMark = (
  <svg viewBox="0 0 256 256" fill="none" className="h-6 w-6 text-primary" aria-hidden="true">
    <path
      d="M128 24 L232 208 L24 208 Z"
      stroke="currentColor"
      strokeWidth="14"
      fill="none"
      strokeLinejoin="round"
    />
    <circle cx="128" cy="28" r="16" fill="currentColor" />
  </svg>
);

/**
 * Shared chrome for the signup flow. Provides the page header (logo + step
 * indicator + optional back link) and a centered content slot. Pages drop into
 * the `children` slot without supplying their own outer Card wrapper for the
 * indicator — the indicator lives in the shell and stays visually consistent
 * across all four routes.
 */
export function SignupShell({ step, width = "default", back, children }: SignupShellProps) {
  const ctx = useSignupContext();
  const detected = ctx.status === "ready" ? ctx.showRegion : false;
  // If a user lands directly on /signup/region while the availability probe is
  // still loading (or returned false), force the region step into the indicator
  // — otherwise stepsFor() omits it and the active step has no slot.
  const showRegion = detected || step === "region";

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-3 px-4 py-3 sm:px-6 sm:py-4">
          <Link
            href="/"
            className="flex shrink-0 items-center gap-2 rounded-md outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Atlas home"
          >
            {AtlasMark}
            <span className="text-sm font-semibold tracking-tight">Atlas</span>
          </Link>
          <div className="ml-auto flex w-full max-w-xl flex-1">
            <StepIndicator current={step} showRegion={showRegion} />
          </div>
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center px-4 py-8 sm:py-12">
        <div className={cn("w-full", WIDTHS[width])}>
          {back && (
            <div className="mb-3">
              <Link
                href={back.href}
                className="inline-flex items-center gap-1 rounded text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ArrowLeft className="size-3" />
                {back.label ?? "Back"}
              </Link>
            </div>
          )}
          {children}
        </div>
      </main>
    </div>
  );
}
