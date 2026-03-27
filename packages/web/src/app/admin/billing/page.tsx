"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { formatDate, formatNumber } from "@/lib/format";
import {
  CreditCard,
  ExternalLink,
  Zap,
  Users,
  Database,
  MessageSquare,
  Coins,
  ServerOff,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────

interface BillingStatus {
  workspaceId: string;
  plan: {
    tier: string;
    displayName: string;
    byot: boolean;
    trialEndsAt: string | null;
  };
  limits: {
    queriesPerMonth: number | null;
    tokensPerMonth: number | null;
    maxMembers: number | null;
    maxConnections: number | null;
  };
  usage: {
    queryCount: number;
    tokenCount: number;
    queryUsagePercent: number;
    tokenUsagePercent: number;
    queryOverageStatus: string;
    tokenOverageStatus: string;
    periodStart: string;
    periodEnd: string;
  };
  subscription: {
    stripeSubscriptionId: string;
    plan: string;
    status: string;
  } | null;
}

// ── Helpers ───────────────────────────────────────────────────────

function tierVariant(tier: string): "default" | "secondary" | "outline" {
  switch (tier) {
    case "enterprise":
      return "default";
    case "team":
      return "secondary";
    default:
      return "outline";
  }
}

function overageColor(status: string): string {
  switch (status) {
    case "exceeded":
      return "text-destructive";
    case "warning":
      return "text-amber-600 dark:text-amber-400";
    default:
      return "text-muted-foreground";
  }
}

// ── Component ─────────────────────────────────────────────────────

export default function BillingPage() {
  const { data, loading, error, refetch } = useAdminFetch<BillingStatus>(
    "/api/v1/billing",
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
                <PortalCard data={data} />
              </div>

              <UsageLimitsCard data={data} />

              <ByotCard data={data} onToggled={refetch} />
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
  const { plan, subscription } = data;

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

        {plan.tier === "trial" && plan.trialEndsAt && (
          <p className="text-sm text-muted-foreground">
            Trial ends {formatDate(plan.trialEndsAt)}
          </p>
        )}

        {subscription && (
          <p className="text-sm text-muted-foreground">
            Subscription status:{" "}
            <Badge variant={subscription.status === "active" ? "secondary" : "outline"} className="ml-1 text-xs">
              {subscription.status}
            </Badge>
          </p>
        )}
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

// ── Usage vs limits card ──────────────────────────────────────────

function UsageLimitsCard({ data }: { data: BillingStatus }) {
  const { usage, limits } = data;

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Usage vs Limits</CardTitle>
        <CardDescription>
          Current billing period: {formatDate(usage.periodStart)} – {formatDate(usage.periodEnd)}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-6 sm:grid-cols-2">
          <UsageRow
            label="Queries"
            icon={<MessageSquare className="size-4" />}
            used={usage.queryCount}
            limit={limits.queriesPerMonth}
            percent={usage.queryUsagePercent}
            status={usage.queryOverageStatus}
          />
          <UsageRow
            label="Tokens"
            icon={<Coins className="size-4" />}
            used={usage.tokenCount}
            limit={limits.tokensPerMonth}
            percent={usage.tokenUsagePercent}
            status={usage.tokenOverageStatus}
          />
          <UsageRow
            label="Members"
            icon={<Users className="size-4" />}
            limit={limits.maxMembers}
          />
          <UsageRow
            label="Connections"
            icon={<Database className="size-4" />}
            limit={limits.maxConnections}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function UsageRow({
  label,
  icon,
  used,
  limit,
  percent,
  status,
}: {
  label: string;
  icon: React.ReactNode;
  used?: number;
  limit: number | null;
  percent?: number;
  status?: string;
}) {
  const isUnlimited = limit === null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="text-muted-foreground">{icon}</span>
          {label}
        </div>
        <UsageValue used={used} limit={limit} isUnlimited={isUnlimited} status={status} />
      </div>
      {!isUnlimited && percent !== undefined && (
        <Progress value={Math.min(percent, 100)} className="h-2" />
      )}
    </div>
  );
}

function UsageValue({
  used,
  limit,
  isUnlimited,
  status,
}: {
  used?: number;
  limit: number | null;
  isUnlimited: boolean;
  status?: string;
}) {
  if (isUnlimited) {
    return <Badge variant="outline" className="text-xs">Unlimited</Badge>;
  }
  if (used !== undefined) {
    return (
      <span className={`text-sm font-medium ${overageColor(status ?? "ok")}`}>
        {formatNumber(used)} / {formatNumber(limit!)}
      </span>
    );
  }
  return (
    <span className="text-sm text-muted-foreground">
      Limit: {formatNumber(limit!)}
    </span>
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
