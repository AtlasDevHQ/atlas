"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

const WIDTHS = {
  default: "max-w-md",
  wide: "max-w-2xl",
  xwide: "max-w-4xl",
} as const;

export type OnboardingShellWidth = keyof typeof WIDTHS;

interface OnboardingShellProps {
  /** Container width for the page body. */
  width?: OnboardingShellWidth;
  /** Optional back-link target. Renders a back affordance above the content. */
  back?: { href: string; label?: string };
  /** Optional skip-link rendered in the top right. */
  skip?: { href: string; label: string };
  /** The step indicator slot. */
  indicator: React.ReactNode;
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
 * The shell is intentionally agnostic to step shape — callers pass an
 * `indicator` node so different flows can use different step layouts without
 * forcing a shared step type into this file.
 */
export function OnboardingShell({
  width = "default",
  back,
  skip,
  indicator,
  children,
}: OnboardingShellProps) {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        {/*
         * Equal-flex side columns keep the indicator centered regardless
         * of logo or skip-link width. `minmax(0,1fr)` lets columns shrink
         * below intrinsic content size on narrow viewports.
         */}
        <div className="mx-auto grid w-full max-w-5xl grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-4 py-3 sm:px-6 sm:py-4">
          <Link
            href="/"
            className="flex shrink-0 items-center gap-2 justify-self-start rounded-md outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Atlas home"
          >
            {AtlasMark}
            <span className="text-sm font-semibold tracking-tight">Atlas</span>
          </Link>
          <div className="flex w-full max-w-xl justify-self-center">{indicator}</div>
          <div className="flex justify-self-end">
            {skip && (
              <Link
                href={skip.href}
                className="hidden shrink-0 rounded text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:inline-flex"
              >
                {skip.label}
              </Link>
            )}
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
