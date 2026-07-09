"use client";

import { useRouter } from "next/navigation";
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
 * The Upgrade CTA scrolls to the plan picker when its anchor is on the
 * current page (/admin/billing), and otherwise navigates to
 * /admin/billing with the anchor hash — the banner is also mounted on
 * /admin, where the anchor doesn't exist and the old scroll-only CTA was
 * a literal no-op click (#3418).
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

/**
 * Scroll to the plan picker if it's on this page; otherwise route to the
 * billing page with the anchor hash (Next scrolls to it after nav).
 */
function goToPlanPicker(push: (href: string) => void) {
  if (typeof document === "undefined") return;
  const el = document.getElementById(TRIAL_BANNER_PLAN_ANCHOR_ID);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    push(`/admin/billing#${TRIAL_BANNER_PLAN_ANCHOR_ID}`);
  }
}

export interface TrialCountdownBannerProps {
  plan: Pick<BillingPlan, "tier" | "trialEndsAt" | "trialEndsAtEffective" | "trialDays">;
  /** Injectable clock for tests. Defaults to `Date.now()`. */
  now?: number;
}

function pluralDays(n: number): string {
  return n === 1 ? "day" : "days";
}

export function TrialCountdownBanner({ plan, now }: TrialCountdownBannerProps) {
  // Prefer the server-computed *effective* end (#3434) — trial_ends_at with
  // the createdAt + TRIAL_DAYS fallback enforcement uses — so a workspace
  // with a NULL trial_ends_at still gets a countdown instead of a silent
  // day-14 cutoff. `trialEndsAt` remains as a fallback for an older API
  // that doesn't send the effective field yet.
  const endsAt = plan.trialEndsAtEffective ?? plan.trialEndsAt;
  if (plan.tier !== "trial" || !endsAt) return null;
  const state = resolveState(endsAt, now ?? Date.now());

  if (state.kind === "early") {
    // Trial length comes off the wire (plan.trialDays) — never hardcode the
    // number here, it would silently drift from the API's TRIAL_DAYS.
    const lengthLabel =
      plan.trialDays != null ? `a ${plan.trialDays}-day Atlas trial` : "an Atlas trial";
    return (
      <BannerShell
        tone="info"
        icon={<Sparkles className="size-4 shrink-0" aria-hidden />}
        title={`You're on ${lengthLabel}. ${state.daysLeft} ${pluralDays(state.daysLeft)} left.`}
        buttonVariant="secondary"
      />
    );
  }

  if (state.kind === "ending") {
    return (
      <BannerShell
        tone="warning"
        icon={<Clock className="size-4 shrink-0" aria-hidden />}
        title={`Trial ending in ${state.daysLeft} ${pluralDays(state.daysLeft)}.`}
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
  const router = useRouter();
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
        onClick={() => goToPlanPicker((href) => router.push(href))}
        className="shrink-0"
      >
        Upgrade
      </Button>
    </div>
  );
}
