"use client";

import { useState } from "react";
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
  InlineError,
  SectionHeading,
  Shell,
  type StatusKind,
  useDisclosure,
} from "@/ui/components/admin/compact";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyError } from "@/ui/lib/fetch-error";
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import { BillingStatusSchema } from "@/ui/lib/admin-schemas";
import { formatDate, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { BillingStatus } from "@useatlas/schemas";
import {
  Bot,
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

function tierVariant(tier: string): "default" | "secondary" | "outline" {
  switch (tier) {
    case "business":
      return "default";
    case "pro":
    case "starter":
      return "secondary";
    default:
      return "outline";
  }
}

function overageColor(status: string): string {
  switch (status) {
    case "exceeded":
    case "hard_limit":
      return "text-destructive";
    case "warning":
    case "soft_limit":
      return "text-amber-600 dark:text-amber-400";
    default:
      return "text-muted-foreground";
  }
}

const MODEL_OPTIONS = [
  { value: "claude-haiku-4-5", label: "Haiku 4.5", hint: "fastest, lowest cost" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6", hint: "balanced" },
  { value: "claude-opus-4-6", label: "Opus 4.6", hint: "most capable" },
] as const;

function modelLabel(value: string): string {
  return MODEL_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

// ── Component ─────────────────────────────────────────────────────

export default function BillingPage() {
  const { data, loading, error, refetch } = useAdminFetch("/api/v1/billing", {
    schema: BillingStatusSchema,
  });

  // Framework-level 404 (billing routes not mounted) means self-hosted / no Stripe.
  // API-level 404s ("Workspace not found", "no internal database") have descriptive
  // messages and should surface as real errors, not the self-hosted card.
  const isSelfHosted =
    !loading &&
    !data &&
    error?.status === 404 &&
    (error.message === "Not Found" || error.message === "HTTP 404");

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
          loading={loading}
          error={error}
          feature="Billing"
          onRetry={refetch}
          loadingMessage="Loading billing details..."
        >
          {data && (
            <div className="space-y-10">
              <section>
                <SectionHeading
                  title="Plan"
                  description="Your current subscription and limits"
                />
                <PlanShell data={data} />
              </section>

              <section>
                <SectionHeading
                  title="Usage"
                  description={`Current period · ${formatDate(data.usage.periodStart)} – ${formatDate(data.usage.periodEnd)}`}
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

  if (plan.tier === "trial" && plan.trialEndsAt) {
    return `Trial · ends ${formatDate(plan.trialEndsAt)}`;
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
  const [portalError, setPortalError] = useState<string | null>(null);
  const { plan, usage, subscription } = data;
  const seatCount = data.seats?.count ?? usage.seatCount;
  const totalMonthly = plan.pricePerSeat * seatCount;
  const overage = data.overagePerMillionTokens ?? 0;

  const { mutate, saving, error: portalMutationError } = useAdminMutation<{
    url?: string;
  }>({
    path: "/api/v1/billing/portal",
    method: "POST",
  });

  async function openBillingPortal() {
    setPortalError(null);
    const result = await mutate({ body: { returnUrl: window.location.href } });
    if (!result.ok) return;
    if (result.data?.url) {
      window.location.href = result.data.url;
    } else {
      console.warn("Billing portal: 200 response but no URL returned", result.data);
      setPortalError("Billing portal URL was not returned. Please contact support.");
    }
  }

  // portalError covers the 200-but-missing-URL edge case (set locally when
  // the server returns success but no portal link); portalMutationError
  // covers all non-2xx responses. Use `||` so an empty-string
  // friendlyError() result falls through to portalError rather than
  // suppressing it.
  const mutationCopy = portalMutationError ? friendlyError(portalMutationError) : "";
  const combinedError = mutationCopy || portalError;
  const status: StatusKind = subscription?.status === "active" ? "connected" : "disconnected";

  return (
    <Shell
      icon={CreditCard}
      title={plan.displayName}
      description={
        plan.pricePerSeat > 0
          ? `$${plan.pricePerSeat}/seat/mo \u00B7 ${seatCount} ${seatCount === 1 ? "seat" : "seats"}`
          : "No charges — all features included"
      }
      status={status}
      actions={
        subscription ? (
          <Button onClick={openBillingPortal} disabled={saving} size="sm">
            <CreditCard className="mr-1.5 size-3.5" />
            {saving ? "Opening…" : "Open billing portal"}
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
        {plan.tier === "trial" && plan.trialEndsAt && (
          <DetailRow label="Trial ends" value={formatDate(plan.trialEndsAt)} />
        )}
        {subscription && (
          <DetailRow
            label="Subscription"
            value={
              <Badge
                variant={subscription.status === "active" ? "secondary" : "outline"}
                className="text-[10px]"
              >
                {subscription.status}
              </Badge>
            }
          />
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

      <InlineError>{combinedError}</InlineError>
      {!subscription && plan.pricePerSeat > 0 && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          No active subscription — portal access opens after you subscribe.
        </p>
      )}
    </Shell>
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
      </DetailList>
    </Shell>
  );
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
  const currentModel = data.currentModel ?? data.plan.defaultModel ?? "claude-sonnet-4-6";
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

// ── BYOT row (inline switch) ──────────────────────────────────────

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
    </div>
  );
}
