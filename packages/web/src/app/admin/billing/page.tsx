"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryStates } from "nuqs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  CompactRow,
  DetailList,
  DetailRow,
  SectionHeading,
  Shell,
  type StatusKind,
  useDisclosure,
} from "@/ui/components/admin/compact";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { useBillingPortal } from "@/ui/hooks/use-billing-portal";
import { usePlanCheckout } from "@/ui/hooks/use-plan-checkout";
import { useDeployMode } from "@/ui/hooks/use-deploy-mode";
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import {
  TrialCountdownBanner,
  TRIAL_BANNER_PLAN_ANCHOR_ID,
} from "@/ui/components/admin/trial-countdown-banner";
import { BillingStatusSchema } from "@/ui/lib/admin-schemas";
import { ModelProviderSection } from "@/ui/components/admin/model-provider-section";
import { formatDate, formatNumber } from "@/lib/format";
import { consumePlanIntent, PAID_TIERS } from "@/lib/billing/plan-intent";
import { effectiveTrialEnd, isTrialEndPast } from "@/lib/billing/trial-copy";
import {
  cancelAtPeriodEndNotice,
  hasActiveSubscription,
  subscriptionPresentation,
} from "@/lib/billing/subscription-status";
import { cn } from "@/lib/utils";
import { billingSearchParams } from "./search-params";
import type { BillingStatus } from "@useatlas/schemas";
import {
  Bot,
  CheckCircle2,
  Coins,
  CreditCard,
  DollarSign,
  ExternalLink,
  Loader2,
  Plus,
  ServerOff,
  Zap,
} from "lucide-react";

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Label the metering window under the Usage section (#3431).
 *
 * `periodEnd` is the **exclusive** upper bound, so the displayed range ends
 * the day before. UTC-month windows render in UTC so a browser west of UTC
 * doesn't slip the boundary back a day; Stripe-anchored windows are real
 * invoice-clock instants and render in local time. The leading label says
 * "Billing period" only when actually anchored on the subscription —
 * otherwise "Current period", so the copy never implies invoice alignment
 * the meter isn't honoring.
 */
function formatBillingPeriod(
  start: string,
  end: string,
  source: "stripe" | "utc-month" | undefined,
): string {
  if (!start || !end) return "Current period";
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return "Current period";
  const lastDay = new Date(e.getTime() - 1);
  const tz = source === "stripe" ? undefined : "UTC";
  const opts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: tz,
  };
  const label = source === "stripe" ? "Billing period" : "Current period";
  return `${label} · ${s.toLocaleDateString(undefined, opts)} – ${lastDay.toLocaleDateString(undefined, opts)}`;
}

function tierVariant(tier: string): "default" | "secondary" | "outline" | "destructive" {
  switch (tier) {
    case "business":
      return "default";
    case "pro":
    case "starter":
      return "secondary";
    // Churn landing tier (#3421) — zero entitlements until resubscribe.
    case "locked":
      return "destructive";
    default:
      return "outline";
  }
}

// Param is typed to the wire enum (not bare `string`) so an OverageStatus
// member added in @useatlas/schemas surfaces here as a missing case rather
// than silently falling through to the muted default. The dead "exceeded"
// arm — never a member of OverageStatus — was removed in #3438.
function overageColor(status: BillingStatus["usage"]["tokenOverageStatus"]): string {
  switch (status) {
    case "hard_limit":
      return "text-destructive";
    case "warning":
    case "soft_limit":
      return "text-amber-600 dark:text-amber-400";
    default:
      return "text-muted-foreground";
  }
}

// Values are Vercel AI Gateway model IDs (slash+dot) — SaaS resolves
// through the gateway, so the picker must write IDs the gateway will
// recognize. Older hyphen-format settings (`claude-opus-4-6`) are
// migrated lazily by `modelLabel` and the equivalence check below so
// existing workspaces don't lose their selection on first load.
const MODEL_OPTIONS = [
  { value: "anthropic/claude-haiku-4.5", label: "Haiku 4.5", hint: "fastest, lowest cost" },
  { value: "anthropic/claude-sonnet-4.6", label: "Sonnet 4.6", hint: "balanced" },
  { value: "anthropic/claude-opus-4.8", label: "Opus 4.8", hint: "most capable" },
] as const;

// Atlas previously stored model settings in the Anthropic-direct hyphen
// format (`claude-opus-4-6`); the gateway accepts the slash+dot form
// (`anthropic/claude-opus-4.6`). When we see a legacy hyphen value
// stored in `ATLAS_MODEL`, map it to the canonical gateway ID so the
// picker selects the right row and the agent loop sees a working ID.
//
// Two kinds of migration live here:
//   1. Format canonicalization — hyphen → slash+dot (e.g. `claude-sonnet-4-6`).
//   2. Version roll-forward — a deprecated Opus version that no longer has its
//      own picker row (4.6, the prior 4.7 default) is mapped to the current
//      flagship `anthropic/claude-opus-4.8`. This is a version upgrade, not
//      just a format change, so the Select highlights a valid option instead
//      of rendering blank for workspaces still on the old default (#3076).
const LEGACY_MODEL_ALIASES: Record<string, string> = {
  "claude-haiku-4-5": "anthropic/claude-haiku-4.5",
  "claude-sonnet-4-6": "anthropic/claude-sonnet-4.6",
  "claude-opus-4-6": "anthropic/claude-opus-4.8",
  "claude-opus-4-7": "anthropic/claude-opus-4.8",
  "anthropic/claude-opus-4.7": "anthropic/claude-opus-4.8",
};

function canonicalizeModel(value: string): string {
  return LEGACY_MODEL_ALIASES[value] ?? value;
}

function modelLabel(value: string): string {
  const canonical = canonicalizeModel(value);
  return MODEL_OPTIONS.find((o) => o.value === canonical)?.label ?? canonical;
}

// ── Component ─────────────────────────────────────────────────────

export default function BillingPage() {
  const { data, loading, error, refetch } = useAdminFetch("/api/v1/billing", {
    schema: BillingStatusSchema,
  });
  const { deployMode, error: modeError, resolved: modeResolved } = useDeployMode();
  const [{ checkout, plan: planParam }, setParams] = useQueryStates(billingSearchParams);

  // Pricing-page plan intent (#3418): /signup?plan=… stashes the choice in
  // localStorage (the signup flow spans five hard navs); surface it here as
  // the ?plan= URL param so the picker preselects and the URL is shareable.
  useEffect(() => {
    if (planParam) return;
    const intent = consumePlanIntent();
    if (intent) void setParams({ plan: intent });
    // Mount-only: consumePlanIntent is one-shot (read-and-clear), so the
    // effect must not re-run when planParam/setParams identities change.
  }, []);

  // Framework-level 404 (billing routes not mounted) means self-hosted / no Stripe.
  // API-level 404s ("Workspace not found", "no internal database") have descriptive
  // messages and should surface as real errors, not the self-hosted card.
  //
  // Gate on deployMode too: on a SaaS deployment a 404 here means the billing
  // system is misconfigured (Stripe plugin not mounted, internal DB
  // unavailable), NOT that the deployment is self-hosted. Showing the
  // "Self-hosted · no billing" card in that case lies to the user — let the
  // generic error path surface the failure so it's visible to operators.
  //
  // `modeResolved` makes this view swap commit only to the server-confirmed
  // mode (deploy-mode parity contract Rule 2, #3378): while the mode is
  // still a hostname guess (loading / settings-fetch error), fall through to
  // the generic loading/error path instead of the self-hosted empty state.
  const isFramework404 =
    !loading &&
    !data &&
    error?.status === 404 &&
    (error.message === "Not Found" || error.message === "HTTP 404");
  const isSelfHosted = modeResolved && deployMode === "self-hosted" && isFramework404;
  // While the mode is still resolving, a framework 404 is ambiguous — the
  // self-hosted empty state on a healthy deploy, or a SaaS misconfiguration.
  // Hold the neutral loading state instead of flashing the 404 error and
  // then swapping to the card (#3391 review). A settings-fetch error ends
  // the hold: the ambiguity is then surfaced as the real error below.
  const holdForMode = isFramework404 && !modeResolved && !modeError;

  if (isSelfHosted) {
    return (
      <ErrorBoundary>
        <div className="mx-auto max-w-3xl px-6 py-10">
          <Hero stat={null} />
          <SelfHostedEmptyState />
        </div>
      </ErrorBoundary>
    );
  }

  const stat = data ? heroStat(data) : null;

  return (
    <ErrorBoundary>
      <div className="mx-auto max-w-3xl px-6 py-10">
        <Hero stat={stat} />

        <AdminContentWrapper
          loading={loading || holdForMode}
          error={holdForMode ? null : error}
          feature="Billing"
          onRetry={refetch}
          loadingMessage="Loading billing details..."
        >
          {data && (
            <div className="space-y-10">
              <TrialCountdownBanner plan={data.plan} />
              {checkout && (
                <CheckoutReturnBanner
                  state={checkout}
                  targetPlan={planParam}
                  data={data}
                  refetch={refetch}
                  onDone={() => void setParams({ checkout: null })}
                />
              )}
              <section id={TRIAL_BANNER_PLAN_ANCHOR_ID} className="scroll-mt-6">
                <SectionHeading
                  title="Plan"
                  description="Your current subscription and limits"
                />
                <PlanShell data={data} />
              </section>

              <section>
                <SectionHeading
                  title={hasActiveSubscription(data.subscription) ? "Change plan" : "Choose a plan"}
                  description={
                    hasActiveSubscription(data.subscription)
                      ? "Upgrades apply immediately (prorated); downgrades take effect at the end of the billing period"
                      : "Subscribe to keep using Atlas after your trial"
                  }
                />
                <PlanPicker data={data} highlight={planParam} />
              </section>

              <section>
                <SectionHeading
                  title="Usage"
                  description={formatBillingPeriod(data.usage.periodStart, data.usage.periodEnd, data.usage.periodSource)}
                />
                <UsageShell data={data} />
              </section>

              <section>
                <SectionHeading
                  title="Configuration"
                  description="Workspace-level defaults"
                />
                <div className="space-y-2">
                  <ModelRow data={data} onSaved={refetch} />
                  <ByotRow data={data} onToggled={refetch} />
                </div>
              </section>
            </div>
          )}
        </AdminContentWrapper>
      </div>
    </ErrorBoundary>
  );
}

// ── Hero ──────────────────────────────────────────────────────────

function heroStat(data: BillingStatus): string {
  const { plan, usage } = data;
  const seatCount = data.seats?.count ?? usage.seatCount;

  // Effective end (#3434): trial_ends_at with enforcement's createdAt +
  // TRIAL_DAYS fallback — so a NULL-trial_ends_at workspace still sees its
  // real clock here.
  const trialEnds = effectiveTrialEnd(plan);
  if (plan.tier === "trial" && trialEnds) {
    return isTrialEndPast(trialEnds)
      ? `Trial · expired ${formatDate(trialEnds)}`
      : `Trial · ends ${formatDate(trialEnds)}`;
  }
  if (plan.pricePerSeat > 0) {
    return `$${plan.pricePerSeat * seatCount}/mo`;
  }
  return plan.displayName;
}

function Hero({ stat }: { stat: string | null }) {
  return (
    <header className="mb-10 flex flex-col gap-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        Atlas · Admin
      </p>
      <div className="flex items-baseline justify-between gap-6">
        <h1 className="text-3xl font-semibold tracking-tight">Billing</h1>
        {stat && (
          <p className="shrink-0 font-mono text-sm tabular-nums text-foreground">
            {stat}
          </p>
        )}
      </div>
      <p className="max-w-xl text-sm text-muted-foreground">
        Manage your plan, view usage, and access billing settings.
      </p>
    </header>
  );
}

// ── Self-hosted empty state ───────────────────────────────────────

function SelfHostedEmptyState() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border bg-card/40 py-14 text-center">
      <span className="grid size-10 place-items-center rounded-lg border bg-background/40 text-muted-foreground">
        <ServerOff className="size-4" />
      </span>
      <div>
        <h2 className="text-sm font-semibold tracking-tight">Self-hosted · no billing</h2>
        <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
          This instance has no Stripe subscription configured. All features are
          unlimited.
        </p>
      </div>
    </div>
  );
}

// ── Plan shell ────────────────────────────────────────────────────

function PlanShell({ data }: { data: BillingStatus }) {
  const { plan, usage, subscription } = data;
  const seatCount = data.seats?.count ?? usage.seatCount;
  const totalMonthly = plan.pricePerSeat * seatCount;
  const overage = data.overagePerMillionTokens ?? 0;

  // #3417 — the portal goes through the Better Auth Stripe plugin
  // (authClient.subscription.billingPortal), not an Atlas route. The
  // plugin returns structured error codes that the hook flattens to
  // actionable copy; there is no enterprise_required arm on this
  // endpoint, so a plain ErrorBanner suffices.
  const { openPortal, opening, error: portalError } = useBillingPortal();

  // #3429 — present the subscription state instead of treating anything
  // that isn't "active" as broken/hidden. past_due / unpaid → "Fix payment"
  // CTA via the portal; canceled stays visible; trialing reads as healthy.
  // `null` only when the workspace has never subscribed.
  const sub = subscription ? subscriptionPresentation(subscription) : null;
  const cancelNotice = subscription
    ? cancelAtPeriodEndNotice(subscription, formatDate)
    : null;

  // The plan-card status dot: prefer the subscription's derived state; with
  // no subscription, fall back to "connected" for a self-hosted/free tier so
  // the card doesn't read as disconnected when nothing is wrong.
  const status: StatusKind = sub
    ? sub.statusKind
    : plan.pricePerSeat > 0
      ? "disconnected"
      : "connected";

  // Trial gets its own description (#3434) — the pricePerSeat === 0 copy
  // ("No charges — all features included") is true for the self-hosted free
  // tier but a lie for an expired trial, whose chat is 403-blocked. Dates
  // use the server-computed effective end (trial_ends_at with enforcement's
  // createdAt + TRIAL_DAYS fallback), so a NULL-trial_ends_at workspace
  // still sees its real clock.
  const trialEnds = effectiveTrialEnd(plan);
  const trialExpired = plan.tier === "trial" && isTrialEndPast(trialEnds);
  const planDescription =
    plan.tier === "trial"
      ? trialExpired
        ? `Trial ended${trialEnds ? ` ${formatDate(trialEnds)}` : ""} — chat and queries are paused. Choose a plan below to restore access.`
        : `Free trial${trialEnds ? ` \u00B7 ends ${formatDate(trialEnds)}` : ""} \u00B7 no charges until you pick a plan`
      : plan.pricePerSeat > 0
        ? `$${plan.pricePerSeat}/seat/mo \u00B7 ${seatCount} ${seatCount === 1 ? "seat" : "seats"}`
        : "No charges — all features included";

  return (
    <Shell
      icon={CreditCard}
      title={plan.displayName}
      description={planDescription}
      status={status}
      actions={
        sub?.showPortal ? (
          <Button
            onClick={openPortal}
            disabled={opening}
            size="sm"
            variant={sub.isDelinquent ? "destructive" : "default"}
          >
            <CreditCard className="mr-1.5 size-3.5" />
            {opening ? "Opening…" : sub.portalLabel}
            <ExternalLink className="ml-1.5 size-3" />
          </Button>
        ) : undefined
      }
    >
      <DetailList>
        <DetailRow
          label="Tier"
          value={
            <span className="inline-flex items-center gap-2">
              <Badge variant={tierVariant(plan.tier)} className="text-[10px]">
                {plan.tier}
              </Badge>
              {plan.byot && (
                <Badge
                  variant="outline"
                  className="border-violet-500/30 text-[10px] text-violet-600 dark:text-violet-400"
                >
                  BYOT
                </Badge>
              )}
            </span>
          }
        />
        {plan.pricePerSeat > 0 && (
          <DetailRow
            label="Monthly"
            value={
              <span>
                <span className="text-muted-foreground">{`$${plan.pricePerSeat} × ${seatCount} = `}</span>
                <span className="font-semibold">${totalMonthly}</span>
              </span>
            }
          />
        )}
        {plan.tier === "trial" && trialEnds && (
          <DetailRow
            label={trialExpired ? "Trial ended" : "Trial ends"}
            value={formatDate(trialEnds)}
          />
        )}
        {subscription && sub && (
          <DetailRow
            label="Subscription"
            value={
              <Badge variant={sub.badgeVariant} className="text-[10px]">
                {subscription.status}
              </Badge>
            }
          />
        )}
        {cancelNotice && (
          <DetailRow label="Scheduled" value={cancelNotice} />
        )}
        {overage > 0 && (
          <DetailRow
            label="Overage"
            value={
              <span className="inline-flex items-center gap-1">
                <DollarSign className="size-3 text-muted-foreground" />
                {overage.toFixed(2)}/M tokens
              </span>
            }
          />
        )}
      </DetailList>

      {/* #3429 — a delinquent subscription must shout: the customer has to
          reach the portal to fix payment, and the old UI hid it. */}
      {sub?.isDelinquent && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <CreditCard className="size-3.5 shrink-0" aria-hidden />
          <span>
            Payment failed — your subscription is {subscription?.status}. Open the
            billing portal to update your payment method and restore access.
          </span>
        </div>
      )}
      {sub?.isEnded && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Your subscription has ended. Choose a plan below to resubscribe, or
          open the billing portal to view past invoices.
        </p>
      )}
      {portalError && <ErrorBanner message={portalError} />}
      {!subscription && plan.pricePerSeat > 0 && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          No active subscription — portal access opens after you subscribe.
        </p>
      )}
    </Shell>
  );
}

// ── Checkout return banner (#3418) ────────────────────────────────

// The plan tier is written by Stripe webhooks, which race the redirect.
// The server caches plan reads for 60s, so the poll must outlive that
// TTL or a webhook landing at t=45s against a warm cache strands the
// user on "refresh in a minute" (#3418 triage: "a refetch poll past the
// 60s plan-cache TTL"). 25 × 3s = 75s.
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 25;

/**
 * Shown after the user returns from Stripe — covering all three
 * journeys:
 *   - `success` — first-subscription Checkout; polls until a paid tier
 *     (or active/trialing subscription) appears.
 *   - `changed` — immediate plan change on an existing subscription;
 *     polls until the target tier (from `?plan=`) appears.
 *   - `scheduled` — period-end downgrade; static notice, nothing to poll.
 *   - `cancelled` — dismissable no-charge notice.
 * If the webhook outlives the poll window, the copy degrades to
 * "refresh in a minute" instead of spinning forever.
 */
function CheckoutReturnBanner({
  state,
  targetPlan,
  data,
  refetch,
  onDone,
}: {
  state: "success" | "cancelled" | "changed" | "scheduled";
  targetPlan: string | null;
  data: BillingStatus;
  refetch: () => void;
  onDone: () => void;
}) {
  const landed =
    state === "changed" && targetPlan
      ? data.plan.tier === targetPlan
      : (PAID_TIERS as readonly string[]).includes(data.plan.tier) ||
        data.subscription?.status === "active" ||
        data.subscription?.status === "trialing";
  const [slow, setSlow] = useState(false);
  const attempts = useRef(0);

  // refetch's identity changes per render (useAdminFetch recreates it), so
  // depending on it directly would tear down and restart the interval on
  // every poll-driven render. Route through a ref kept fresh each render.
  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  });

  const polling = state === "success" || state === "changed";
  useEffect(() => {
    if (!polling || landed) return;
    const interval = setInterval(() => {
      attempts.current += 1;
      if (attempts.current > POLL_MAX_ATTEMPTS) {
        setSlow(true);
        clearInterval(interval);
        return;
      }
      refetchRef.current();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [polling, landed]);

  if (state === "scheduled") {
    return (
      <div
        role="status"
        className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 px-4 py-3 text-sm"
      >
        <p className="text-muted-foreground">
          Plan change scheduled — {data.plan.displayName} stays active until the
          end of the current billing period.
        </p>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Dismiss
        </Button>
      </div>
    );
  }

  if (state === "cancelled") {
    return (
      <div
        role="status"
        className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 px-4 py-3 text-sm"
      >
        <p className="text-muted-foreground">
          Checkout cancelled — no charges were made. Pick a plan below whenever
          you&apos;re ready.
        </p>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Dismiss
        </Button>
      </div>
    );
  }

  if (landed) {
    return (
      <div
        role="status"
        className="flex items-center justify-between gap-4 rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-900 dark:text-emerald-200"
      >
        <p className="flex items-center gap-2 font-medium">
          <CheckCircle2 className="size-4 shrink-0" aria-hidden />
          {state === "changed"
            ? `Plan updated — you're now on ${data.plan.displayName}.`
            : `Subscription active — welcome to ${data.plan.displayName}.`}
        </p>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Dismiss
        </Button>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="flex items-center justify-between gap-4 rounded-lg border border-blue-500/30 bg-blue-500/5 px-4 py-3 text-sm text-blue-900 dark:text-blue-200"
    >
      <p className="flex items-center gap-2 font-medium">
        {slow ? (
          <>Payment received — your plan will update shortly. Refresh in a minute.</>
        ) : (
          <>
            <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
            Finalizing your subscription…
          </>
        )}
      </p>
      <Button size="sm" variant="ghost" onClick={onDone}>
        Dismiss
      </Button>
    </div>
  );
}

// ── Plan picker (#3418) ───────────────────────────────────────────

/**
 * Order used to classify a plan change as upgrade vs downgrade. Derived
 * from PAID_TIERS (the web-side tier source of truth in plan-intent.ts)
 * so a new tier can't silently rank as 0 here while the picker shows it.
 */
const TIER_RANK: Record<string, number> = Object.fromEntries(
  PAID_TIERS.map((tier, i) => [tier, i + 1]),
);

function PlanPicker({
  data,
  highlight,
}: {
  data: BillingStatus;
  highlight: string | null;
}) {
  const { startCheckout, pendingPlan, error, clearError } = usePlanCheckout();
  const plans = data.availablePlans ?? [];
  // An older published schema (scaffolds pinned to a pre-#3418
  // @useatlas/schemas) strips availablePlans at parse time — hide the
  // picker rather than render an empty grid.
  if (plans.length === 0) return null;

  const currentTier = data.plan.tier;
  // A canceled / expired subscription is visible (#3429) but isn't a live
  // plan to change — treat it as "no subscription" so the picker offers
  // Subscribe rather than Upgrade/Downgrade against a dead plan.
  const hasSubscription = hasActiveSubscription(data.subscription);
  const currentRank = TIER_RANK[currentTier] ?? 0;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        {plans.map((plan) => {
          const isCurrent = hasSubscription && plan.tier === currentTier;
          const isDowngrade = hasSubscription && TIER_RANK[plan.tier] < currentRank;
          const busy = pendingPlan === plan.tier;
          const label = isCurrent
            ? "Current plan"
            : !hasSubscription
              ? "Subscribe"
              : isDowngrade
                ? "Downgrade"
                : "Upgrade";
          return (
            <div
              key={plan.tier}
              data-testid={`plan-card-${plan.tier}`}
              className={cn(
                "flex flex-col gap-3 rounded-xl border bg-card/40 p-4",
                highlight === plan.tier && "border-primary ring-1 ring-primary",
                isCurrent && "border-primary/40",
              )}
            >
              <div className="flex items-baseline justify-between">
                <h3 className="text-sm font-semibold tracking-tight">{plan.displayName}</h3>
                {isCurrent && (
                  <Badge variant="secondary" className="text-[10px]">
                    Current
                  </Badge>
                )}
              </div>
              <p>
                <span className="text-2xl font-semibold tabular-nums">${plan.pricePerSeat}</span>
                <span className="text-xs text-muted-foreground"> /seat/mo</span>
              </p>
              <ul className="space-y-1 text-xs text-muted-foreground">
                <li>
                  {plan.tokenBudgetPerSeat === null
                    ? "Unlimited tokens"
                    : `${formatNumber(plan.tokenBudgetPerSeat)} tokens/seat/mo`}
                </li>
                <li>{plan.maxSeats === null ? "Unlimited seats" : `Up to ${plan.maxSeats} seats`}</li>
                <li>
                  {plan.maxConnections === null
                    ? "Unlimited connections"
                    : `${plan.maxConnections} ${plan.maxConnections === 1 ? "connection" : "connections"}`}
                </li>
              </ul>
              <Button
                size="sm"
                variant={isCurrent ? "outline" : isDowngrade ? "outline" : "default"}
                disabled={isCurrent || !plan.configured || pendingPlan !== null}
                onClick={() =>
                  startCheckout({ plan: plan.tier, scheduleAtPeriodEnd: isDowngrade })
                }
                className="mt-auto"
              >
                {busy ? (
                  <>
                    <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                    Redirecting…
                  </>
                ) : (
                  label
                )}
              </Button>
              {!plan.configured && (
                <p className="text-[11px] text-muted-foreground">
                  Not available on this deployment.
                </p>
              )}
            </div>
          );
        })}
      </div>
      {error && <ErrorBanner message={error} onRetry={clearError} />}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Billing is per seat ({data.seats?.count ?? data.usage.seatCount}{" "}
        {(data.seats?.count ?? data.usage.seatCount) === 1 ? "member" : "members"} today) and the
        seat count stays in sync as members join or leave. Upgrades are prorated immediately;
        downgrades take effect at the end of the current billing period.
      </p>
    </div>
  );
}

// ── Usage shell ───────────────────────────────────────────────────

function UsageShell({ data }: { data: BillingStatus }) {
  const { usage, limits, plan } = data;
  const seats = data.seats ?? {
    count: usage.seatCount,
    max: data.limits.maxSeats,
  };
  const connections = data.connections ?? {
    count: 0,
    max: data.limits.maxConnections,
  };

  return (
    <Shell
      icon={Coins}
      title="Token usage"
      description={
        plan.byot
          ? "Unlimited — using your own LLM API key"
          : limits.totalTokenBudget === null
          ? "Unlimited"
          : `${formatNumber(usage.tokenCount)} of ${formatNumber(limits.totalTokenBudget)} tokens used`
      }
      status={plan.byot ? "connected" : "disconnected"}
    >
      {plan.byot ? (
        <div className="flex items-center gap-2 rounded-lg border border-violet-500/30 bg-violet-50/60 px-3 py-2 text-xs text-violet-700 dark:bg-violet-950/20 dark:text-violet-300">
          <Zap className="size-3.5" />
          <span>{formatNumber(usage.tokenCount)} tokens consumed this period</span>
        </div>
      ) : limits.totalTokenBudget === null ? (
        <div className="rounded-lg border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          {formatNumber(usage.tokenCount)} tokens consumed · no cap
        </div>
      ) : (
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-muted-foreground">Token budget</span>
            <span
              className={cn(
                "font-mono font-medium tabular-nums",
                overageColor(usage.tokenOverageStatus),
              )}
            >
              {formatNumber(usage.tokenCount)}
              <span className="opacity-50">{" / "}</span>
              {formatNumber(limits.totalTokenBudget)}
            </span>
          </div>
          <Progress
            value={Math.min(usage.tokenUsagePercent, 100)}
            className="h-1.5"
          />
          {limits.tokenBudgetPerSeat !== null && (
            <p className="text-[11px] text-muted-foreground">
              {formatNumber(limits.tokenBudgetPerSeat)} tokens/seat ×{" "}
              {seats.count} {seats.count === 1 ? "seat" : "seats"}
            </p>
          )}
        </div>
      )}

      <DetailList>
        <DetailRow label="Seats" value={<ResourceValue count={seats.count} max={seats.max} />} />
        <DetailRow
          label="Connections"
          value={<ResourceValue count={connections.count} max={connections.max} />}
        />
        {/* Chat-integration cap (#3438). The wire shape carries only the cap
            (`limits.maxChatIntegrations`), not a current count — the install
            gate enforces it server-side — so render the limit alone rather
            than a count/max ratio. */}
        <DetailRow label="Chat integrations" value={<CapValue max={limits.maxChatIntegrations} />} />
      </DetailList>
    </Shell>
  );
}

/**
 * Render a plan cap that has no current-count companion in the wire shape
 * (e.g. chat integrations, #3438): "Unlimited" when null, otherwise the
 * bare limit. Unlike {@link ResourceValue} there is no count/max ratio or
 * near-limit warning — enforcement happens server-side at install time.
 */
function CapValue({ max }: { max: number | null }) {
  if (max === null) {
    return <span className="text-muted-foreground">Unlimited</span>;
  }
  return <span className="font-mono tabular-nums">{max}</span>;
}

function ResourceValue({ count, max }: { count: number; max: number | null }) {
  if (max === null) {
    return <span className="text-muted-foreground">Unlimited</span>;
  }
  const percent = max === 0 ? 0 : Math.round((count / max) * 100);
  const warn = percent >= 90;
  return (
    <span
      className={cn(
        "font-mono tabular-nums",
        warn && "text-amber-600 dark:text-amber-400",
      )}
    >
      {count}
      <span className="opacity-50">{" / "}</span>
      {max}
    </span>
  );
}

// ── Model row (progressive disclosure) ────────────────────────────

function ModelRow({ data, onSaved }: { data: BillingStatus; onSaved: () => void }) {
  // SSOT (#3098): the API resolves `currentModel` to exactly what the agent
  // runs when nothing is saved — the same value the gateway provider default
  // produces — so display it verbatim. NO hardcoded fallback here: a cosmetic
  // default that disagrees with the resolver is the exact bug this fixes
  // (the row showed "Sonnet 4.6" while unset workspaces ran Opus 4.8).
  // canonicalize() only maps legacy-hyphen / deprecated-version values onto a
  // picker row so an older `claude-sonnet-4-6` setting still highlights its row.
  const currentModel = canonicalizeModel(data.currentModel);
  const currentLabel = modelLabel(currentModel);

  const { mutate, saving, error, clearError } = useAdminMutation({
    path: "/api/v1/admin/settings/ATLAS_MODEL",
    method: "PUT",
    invalidates: onSaved,
  });

  const { expanded, setExpanded, collapse, triggerRef, panelRef, panelId } =
    useDisclosure({ onCollapseCleanup: clearError });

  async function handleModelChange(value: string) {
    await mutate({ body: { value } });
  }

  if (!expanded) {
    return (
      <CompactRow
        icon={Bot}
        title="Default AI model"
        description={currentLabel}
        status="disconnected"
        action={
          <Button
            ref={triggerRef}
            size="sm"
            variant="outline"
            aria-expanded={false}
            onClick={() => setExpanded(true)}
          >
            <Plus className="mr-1.5 size-3.5" />
            Change
          </Button>
        }
      />
    );
  }

  return (
    <Shell
      id={panelId}
      panelRef={panelRef}
      icon={Bot}
      title="Default AI model"
      description="Applied to every chat unless a workspace member overrides it."
      status="disconnected"
      onCollapse={collapse}
    >
      <Select value={currentModel} onValueChange={handleModelChange} disabled={saving}>
        <SelectTrigger aria-label="AI model">
          <SelectValue placeholder="Select a model" />
        </SelectTrigger>
        <SelectContent>
          {MODEL_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              <span className="font-medium">{opt.label}</span>
              <span className="ml-2 text-xs text-muted-foreground">— {opt.hint}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {saving && (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Saving…
        </p>
      )}
      <MutationErrorSurface error={error} feature="AI Model" variant="inline" />
    </Shell>
  );
}

// ── BYOT row (toggle + inline provider section) ───────────────────

function ByotRow({
  data,
  onToggled,
}: {
  data: BillingStatus;
  onToggled: () => void;
}) {
  const { mutate, saving, error } = useAdminMutation<{
    workspaceId: string;
    byot: boolean;
  }>({
    path: "/api/v1/billing/byot",
    method: "POST",
    invalidates: onToggled,
  });

  async function handleToggle(enabled: boolean) {
    await mutate({ body: { enabled } });
  }

  return (
    <div className="space-y-2">
      <CompactRow
        icon={Zap}
        title="Bring your own token"
        description={
          data.plan.byot
            ? "Workspace members supply their own LLM API keys"
            : "Use the platform-managed model (default)"
        }
        status={data.plan.byot ? "connected" : "disconnected"}
        action={
          <div className="flex items-center gap-2">
            {saving && (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            )}
            <Switch
              checked={data.plan.byot}
              onCheckedChange={handleToggle}
              disabled={saving}
              aria-label="Bring your own token"
            />
          </div>
        }
      />
      <MutationErrorSurface error={error} feature="BYOT" variant="inline" />
      {/* Inline provider section keeps BYOT setup on the same surface as
          the toggle — toggling on no longer hands the user off to a
          separate /admin/model-config page. The dedicated page still
          exists (sidebar destination, deep link) and mounts the same
          component.
          Parent-gated on `data.plan.byot` so the inline section never has
          to render its own "Enable BYOT" gate row — `showByotGate={false}`
          tells the section it can skip that affordance because this row's
          toggle (above) is the affordance. Don't drop either half of this
          contract: removing the `data.plan.byot &&` guard would surface
          the form to users who haven't enabled BYOT; removing
          `showByotGate={false}` would double-prompt them. */}
      {data.plan.byot && <ModelProviderSection showByotGate={false} />}
      <p className="text-[11px] text-muted-foreground">
        <a
          href="https://docs.useatlas.dev/guides/billing-and-plans#byot-bring-your-own-token"
          target="_blank"
          rel="noreferrer"
          className="underline-offset-2 hover:underline"
        >
          Learn about BYOT
        </a>
      </p>
    </div>
  );
}
