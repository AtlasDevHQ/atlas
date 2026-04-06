"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { BillingStatusSchema } from "@/ui/lib/admin-schemas";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { formatDate, formatNumber } from "@/lib/format";
import {
  CreditCard,
  ExternalLink,
  Zap,
  Users,
  Database,
  Coins,
  ServerOff,
  Bot,
  DollarSign,
} from "lucide-react";
import Link from "next/link";

// ── Types ─────────────────────────────────────────────────────────

interface BillingStatus {
  workspaceId: string;
  plan: {
    tier: string;
    displayName: string;
    pricePerSeat: number;
    defaultModel: string;
    byot: boolean;
    trialEndsAt: string | null;
  };
  limits: {
    tokenBudgetPerSeat: number | null;
    totalTokenBudget: number | null;
    maxSeats: number | null;
    maxConnections: number | null;
  };
  usage: {
    queryCount: number;
    tokenCount: number;
    seatCount: number;
    tokenUsagePercent: number;
    tokenOverageStatus: string;
    periodStart: string;
    periodEnd: string;
  };
  seats?: {
    count: number;
    max: number | null;
  };
  connections?: {
    count: number;
    max: number | null;
  };
  currentModel?: string;
  overagePerMillionTokens?: number;
  subscription: {
    stripeSubscriptionId: string;
    plan: string;
    status: string;
  } | null;
}

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
  { value: "claude-haiku-4-5", label: "Haiku 4.5 \u2014 fastest, lowest cost" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6 \u2014 balanced" },
  { value: "claude-opus-4-6", label: "Opus 4.6 \u2014 most capable" },
] as const;

// ── Component ─────────────────────────────────────────────────────

export default function BillingPage() {
  const { data, loading, error, refetch } = useAdminFetch(
    "/api/v1/billing",
    { schema: BillingStatusSchema },
  );

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
        <div className="p-6">
          <PageHeader />
          <SelfHostedCard />
        </div>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <div className="p-6">
        <PageHeader />

        <AdminContentWrapper
          loading={loading}
          error={error}
          feature="Billing"
          onRetry={refetch}
          loadingMessage="Loading billing details..."
        >
          {data && (
            <div className="space-y-6">
              <div className="grid gap-6 lg:grid-cols-2">
                <PlanCard data={data} />
                <TokenUsageCard data={data} />
              </div>

              <div className="grid gap-6 lg:grid-cols-2">
                <ModelCard data={data} onSaved={refetch} />
                <ResourcesCard data={data} />
              </div>

              {(data.overagePerMillionTokens ?? 0) > 0 && (
                <OverageCard data={data} />
              )}

              <div className="grid gap-6 lg:grid-cols-2">
                <PortalCard data={data} />
                <ByotCard data={data} onToggled={refetch} />
              </div>
            </div>
          )}
        </AdminContentWrapper>
      </div>
    </ErrorBoundary>
  );
}

// ── Page header ───────────────────────────────────────────────────

function PageHeader() {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-bold tracking-tight">Billing</h1>
      <p className="text-sm text-muted-foreground">
        Manage your plan, view usage, and access billing settings.
      </p>
    </div>
  );
}

// ── Self-hosted fallback ──────────────────────────────────────────

function SelfHostedCard() {
  return (
    <Card className="shadow-none">
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <ServerOff className="size-10 text-muted-foreground" />
        <div>
          <h2 className="text-lg font-semibold">Self-Hosted — No Billing</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            This instance is self-hosted with no billing configured.
            All features are unlimited.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Plan card ─────────────────────────────────────────────────────

function PlanCard({ data }: { data: BillingStatus }) {
  const { plan, usage } = data;
  const seatCount = data.seats?.count ?? usage.seatCount;
  const totalMonthly = plan.pricePerSeat * seatCount;

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CreditCard className="size-4" />
          Current Plan
        </CardTitle>
        <CardDescription>Your workspace subscription details.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="text-2xl font-bold">{plan.displayName}</span>
          <Badge variant={tierVariant(plan.tier)}>{plan.tier}</Badge>
          {plan.byot && (
            <Badge variant="outline" className="border-violet-500/30 text-violet-600 dark:text-violet-400">
              BYOT
            </Badge>
          )}
        </div>

        {plan.pricePerSeat > 0 && (
          <p className="text-sm text-muted-foreground">
            ${plan.pricePerSeat}/seat/mo &times; {seatCount} {seatCount === 1 ? "seat" : "seats"} = <span className="font-semibold text-foreground">${totalMonthly}/mo</span>
          </p>
        )}

        {plan.tier === "trial" && plan.trialEndsAt && (
          <p className="text-sm text-muted-foreground">
            Trial ends {formatDate(plan.trialEndsAt)}
          </p>
        )}

        {data.subscription && (
          <p className="text-sm text-muted-foreground">
            Subscription status:{" "}
            <Badge variant={data.subscription.status === "active" ? "secondary" : "outline"} className="ml-1 text-xs">
              {data.subscription.status}
            </Badge>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Token usage card ────────────────────────────────────────────

function TokenUsageCard({ data }: { data: BillingStatus }) {
  const { usage, limits, plan } = data;

  if (plan.byot) {
    return (
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Coins className="size-4" />
            Token Usage
          </CardTitle>
          <CardDescription>
            Current billing period: {formatDate(usage.periodStart)} – {formatDate(usage.periodEnd)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 rounded-md border border-violet-200 bg-violet-50 px-4 py-3 dark:border-violet-800 dark:bg-violet-950/30">
            <Zap className="size-4 text-violet-600 dark:text-violet-400" />
            <span className="text-sm font-medium text-violet-700 dark:text-violet-300">
              Unlimited — using your own API key
            </span>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            Tokens used this period: {formatNumber(usage.tokenCount)}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Coins className="size-4" />
          Token Usage
        </CardTitle>
        <CardDescription>
          Current billing period: {formatDate(usage.periodStart)} – {formatDate(usage.periodEnd)}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">Token Budget</span>
          <span className={`font-medium ${overageColor(usage.tokenOverageStatus)}`}>
            {limits.totalTokenBudget !== null
              ? `${formatNumber(usage.tokenCount)} / ${formatNumber(limits.totalTokenBudget)}`
              : formatNumber(usage.tokenCount)}
          </span>
        </div>
        {limits.totalTokenBudget !== null && (
          <Progress value={Math.min(usage.tokenUsagePercent, 100)} className="h-2" />
        )}
        {limits.totalTokenBudget === null && (
          <Badge variant="outline" className="text-xs">Unlimited</Badge>
        )}
        {limits.tokenBudgetPerSeat !== null && (
          <p className="text-xs text-muted-foreground">
            {formatNumber(limits.tokenBudgetPerSeat)} tokens/seat &times; {data.seats?.count ?? usage.seatCount} seats
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Model card ──────────────────────────────────────────────────

function ModelCard({ data, onSaved }: { data: BillingStatus; onSaved: () => void }) {
  const currentModel = data.currentModel ?? data.plan.defaultModel ?? "default";

  const { mutate, saving, error } = useAdminMutation({
    path: "/api/v1/admin/settings/ATLAS_MODEL",
    method: "PUT",
    invalidates: onSaved,
  });

  async function handleModelChange(value: string) {
    await mutate({ body: { value } });
  }

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Bot className="size-4" />
          AI Model
        </CardTitle>
        <CardDescription>
          Select the default model for this workspace.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <ErrorBanner message={error} />}
        <Select value={currentModel} onValueChange={handleModelChange} disabled={saving}>
          <SelectTrigger aria-label="AI Model">
            <SelectValue placeholder="Select a model" />
          </SelectTrigger>
          <SelectContent>
            {MODEL_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {saving && (
          <p className="text-xs text-muted-foreground">Saving...</p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Resources card ──────────────────────────────────────────────

function ResourcesCard({ data }: { data: BillingStatus }) {
  const seats = data.seats ?? { count: data.usage.seatCount, max: data.limits.maxSeats };
  const connections = data.connections ?? { count: 0, max: data.limits.maxConnections };

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="size-4" />
          Resources
        </CardTitle>
        <CardDescription>Seat and connection usage vs plan limits.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <ResourceRow
          label="Seats"
          icon={<Users className="size-4" />}
          count={seats.count}
          max={seats.max}
          href="/admin/users"
        />
        <ResourceRow
          label="Connections"
          icon={<Database className="size-4" />}
          count={connections.count}
          max={connections.max}
        />
      </CardContent>
    </Card>
  );
}

function ResourceRow({
  label,
  icon,
  count,
  max,
  href,
}: {
  label: string;
  icon: React.ReactNode;
  count: number;
  max: number | null;
  href?: string;
}) {
  const isUnlimited = max === null;
  const percent = isUnlimited ? 0 : Math.round((count / max) * 100);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="text-muted-foreground">{icon}</span>
          {href ? (
            <Link href={href} className="underline-offset-4 hover:underline">
              {label}
            </Link>
          ) : (
            label
          )}
        </div>
        {isUnlimited ? (
          <Badge variant="outline" className="text-xs">Unlimited</Badge>
        ) : (
          <span className="text-sm font-medium">
            {count} / {max}
          </span>
        )}
      </div>
      {!isUnlimited && (
        <Progress value={Math.min(percent, 100)} className="h-2" />
      )}
    </div>
  );
}

// ── Overage card ────────────────────────────────────────────────

function OverageCard({ data }: { data: BillingStatus }) {
  const rate = data.overagePerMillionTokens ?? 0;

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <DollarSign className="size-4" />
          Overage Pricing
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Usage beyond your included token budget is billed at{" "}
          <span className="font-semibold text-foreground">
            ${rate.toFixed(2)}/million tokens
          </span>.
        </p>
      </CardContent>
    </Card>
  );
}

// ── Portal card ───────────────────────────────────────────────────

function PortalCard({ data }: { data: BillingStatus }) {
  const [portalUrlError, setPortalUrlError] = useState<string | null>(null);

  const { mutate: portalMutate, saving: portalLoading, error: portalError } =
    useAdminMutation<{ url?: string }>({
      path: "/api/v1/billing/portal",
      method: "POST",
    });

  async function openBillingPortal() {
    setPortalUrlError(null);
    const result = await portalMutate({
      body: { returnUrl: window.location.href },
    });
    if (!result.ok) {
      // Error is already surfaced by useAdminMutation → portalError.
      return;
    }
    if (result.data?.url) {
      window.location.href = result.data.url;
    } else {
      console.warn("Billing portal: 200 response but no URL returned", result.data);
      setPortalUrlError("Billing portal URL was not returned. Please contact support.");
    }
  }

  const combinedError = portalError ?? portalUrlError;

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Zap className="size-4" />
          Manage Subscription
        </CardTitle>
        <CardDescription>
          {data.subscription
            ? "Open the Stripe Customer Portal to update payment methods, change plans, or view invoices."
            : "Subscribe to a plan to access the billing portal."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {combinedError !== null && (
          <ErrorBanner
            message={combinedError}
            onRetry={() => {
              setPortalUrlError(null);
              openBillingPortal();
            }}
          />
        )}
        <Button
          onClick={openBillingPortal}
          disabled={portalLoading || !data.subscription}
        >
          <CreditCard className="mr-1.5 size-3.5" />
          {portalLoading ? "Opening..." : "Open Billing Portal"}
          <ExternalLink className="ml-1.5 size-3" />
        </Button>
        {!data.subscription && (
          <p className="text-xs text-muted-foreground">
            No active subscription. Subscribe to a plan to enable portal access.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── BYOT toggle card ──────────────────────────────────────────────

function ByotCard({
  data,
  onToggled,
}: {
  data: BillingStatus;
  onToggled: () => void;
}) {
  const { mutate, saving, error } = useAdminMutation<{ workspaceId: string; byot: boolean }>({
    path: "/api/v1/billing/byot",
    method: "POST",
    invalidates: onToggled,
  });

  async function handleToggle(enabled: boolean) {
    await mutate({ body: { enabled } });
  }

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Bring Your Own Token (BYOT)</CardTitle>
        <CardDescription>
          When enabled, workspace members can provide their own LLM API keys
          instead of using the platform-managed model.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <ErrorBanner message={error} />}
        <div className="flex items-center gap-3">
          <Switch
            checked={data.plan.byot}
            onCheckedChange={handleToggle}
            disabled={saving}
          />
          <span className="text-sm">
            {data.plan.byot ? "Enabled" : "Disabled"}
          </span>
          {saving && (
            <span className="text-xs text-muted-foreground">Saving...</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
