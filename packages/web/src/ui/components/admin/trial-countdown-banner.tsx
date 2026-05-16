"use client";

import { AlertTriangle, Clock, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { BillingPlan } from "@useatlas/schemas";

/**
 * Trial countdown banner (PRD #2464 slice 3/4, issue #2467).
 *
 * Renders above the plan card on `/admin/billing` when the workspace is on
 * a trial. Three visual states keyed on days remaining (Math.ceil rounds
 * up, so a remainder of exactly 3.0 days routes to the amber bucket):
 *
 *   > 3 days left → info / blue, secondary "Upgrade"
 *   1–3 days left → warning / amber, primary "Upgrade"
 *   expired       → danger / red, primary "Upgrade"
 *
 * Hidden for any non-trial tier so paid workspaces don't see trial copy.
 *
 * The Upgrade CTA is intentionally a v1 placeholder — it scrolls to the
 * plan card already on the page. Stripe Checkout wiring is v2.
 *
 * Visual chrome matches the raw-div + tone-classed pattern used by
 * IncidentBanner and BackupMethodBanner; the shadcn Alert primitive pins
 * title/description into `col-start-2` of its grid, which fights a
 * trailing right-aligned button.
 */

const MS_PER_DAY = 86_400_000;

/** Anchor target the Upgrade button scrolls to. */
export const TRIAL_BANNER_PLAN_ANCHOR_ID = "trial-banner-plan-anchor";

type BannerState =
  | { kind: "early"; daysLeft: number }
  | { kind: "ending"; daysLeft: number }
  | { kind: "expired" };

// Total — never returns null. An unparseable `trialEndsAt` (would only
// happen on an upstream Zod-schema bug, since `BillingPlanSchema` types it
// as `z.string().nullable()` without `.datetime()`) fails closed into the
// `expired` state so the user still sees the upgrade nudge rather than a
// silently-skipped banner.
function resolveState(trialEndsAt: string, now: number): BannerState {
  const endMs = Date.parse(trialEndsAt);
  if (!Number.isFinite(endMs) || endMs < now) return { kind: "expired" };
  const daysLeft = Math.ceil((endMs - now) / MS_PER_DAY);
  if (daysLeft <= 3) return { kind: "ending", daysLeft };
  return { kind: "early", daysLeft };
}

function scrollToPlanCard() {
  if (typeof document === "undefined") return;
  const el = document.getElementById(TRIAL_BANNER_PLAN_ANCHOR_ID);
  el?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export interface TrialCountdownBannerProps {
  plan: Pick<BillingPlan, "tier" | "trialEndsAt">;
  /** Injectable clock for tests. Defaults to `Date.now()`. */
  now?: number;
}

export function TrialCountdownBanner({ plan, now }: TrialCountdownBannerProps) {
  if (plan.tier !== "trial" || !plan.trialEndsAt) return null;
  const state = resolveState(plan.trialEndsAt, now ?? Date.now());

  if (state.kind === "early") {
    return (
      <BannerShell
        tone="info"
        icon={<Sparkles className="size-4 shrink-0" aria-hidden />}
        title={`You're on a 14-day Atlas trial. ${state.daysLeft} days left.`}
        buttonVariant="secondary"
      />
    );
  }

  if (state.kind === "ending") {
    return (
      <BannerShell
        tone="warning"
        icon={<Clock className="size-4 shrink-0" aria-hidden />}
        title={`Trial ending in ${state.daysLeft} days.`}
        buttonVariant="default"
      />
    );
  }

  return (
    <BannerShell
      tone="danger"
      icon={<AlertTriangle className="size-4 shrink-0" aria-hidden />}
      title="Your trial has expired. Upgrade to keep using Atlas."
      buttonVariant="default"
    />
  );
}

type Tone = "info" | "warning" | "danger";

const TONE_CLASSES: Record<Tone, string> = {
  info: "border-blue-500/30 bg-blue-500/5 text-blue-900 dark:border-blue-400/30 dark:bg-blue-400/5 dark:text-blue-200",
  warning:
    "border-amber-500/40 bg-amber-500/5 text-amber-900 dark:border-amber-400/40 dark:bg-amber-400/5 dark:text-amber-200",
  danger:
    "border-red-500/40 bg-red-500/5 text-red-900 dark:border-red-400/40 dark:bg-red-400/5 dark:text-red-200",
};

function BannerShell({
  tone,
  icon,
  title,
  buttonVariant,
}: {
  tone: Tone;
  icon: React.ReactNode;
  title: string;
  buttonVariant: "default" | "secondary";
}) {
  return (
    <div
      role="alert"
      data-testid="trial-countdown-banner"
      data-tone={tone}
      className={cn(
        "flex items-center justify-between gap-4 rounded-lg border px-4 py-3 text-sm",
        TONE_CLASSES[tone],
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {icon}
        <p className="truncate font-medium">{title}</p>
      </div>
      <Button
        size="sm"
        variant={buttonVariant}
        onClick={scrollToPlanCard}
        className="shrink-0"
      >
        Upgrade
      </Button>
    </div>
  );
}
