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
  Cpu,
  AlertTriangle,
} from "lucide-react";
import Link from "next/link";

// ── Types ─────────────────────────────────────────────────────────

interface BillingStatus {
  workspaceId: string;
  plan: {
    tier: string;
    displayName: string;
    byot: boolean;
    trialEndsAt: string | null;
    pricePerSeat?: number | null;
    defaultModel?: string | null;
  };
  seats?: {
    count: number;
    max: number | null;
  };
  limits: {
    queriesPerMonth: number | null;
    tokensPerMonth: number | null;
    tokenBudgetPerSeat?: number | null;
    totalTokenBudget?: number | null;
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
  connections?: {
    count: number;
    max: number | null;
  };
  currentModel?: string;
  overagePerQuery?: number | null;
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
    case "business":
      return "default";
    case "team":
    case "pro":
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
  { value: "claude-haiku-4-5", label: "Haiku 4.5 (fastest, lowest cost)" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6 (balanced)" },
  { value: "claude-opus-4-6", label: "Opus 4.6 (most capable)" },
] as const;

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

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
                <PortalCard data={data} />
              </div>

              <div className="grid gap-6 lg:grid-cols-2">
                <TokenUsageCard data={data} />
                <ModelCard data={data} onModelChanged={refetch} />
              </div>

              <ResourcesCard data={data} />

              {data.overagePerQuery != null && data.overagePerQuery > 0 && (
                <OverageCard data={data} />
              )}

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
  const { plan, seats, subscription } = data;
  const pricePerSeat = plan.pricePerSeat ?? null;
  const seatCount = seats?.count ?? 0;

  // Build the pricing summary line: "Pro — $59/seat/mo x 3 seats = $177/mo"
  const pricingSummary =
    pricePerSeat !== null && seatCount > 0
      ? `${formatCurrency(pricePerSeat)}/seat/mo x ${seatCount} seat${seatCount === 1 ? "" : "s"} = ${formatCurrency(pricePerSeat * seatCount)}/mo`
      : null;

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

        {pricingSummary && (
          <p className="text-sm text-muted-foreground">
            {plan.displayName} — {pricingSummary}
          </p>
        )}

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

// ── Token usage card ─────────────────────────────────────────────

function TokenUsageCard({ data }: { data: BillingStatus }) {
  const { usage, limits, plan } = data;
  const isByok = plan.byot;

  // Token budget: use totalTokenBudget (per-seat * seats) or fall back to tokensPerMonth
  const tokenBudget = limits.totalTokenBudget ?? limits.tokensPerMonth;
  const isUnlimitedTokens = tokenBudget === null;

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
      <CardContent className="space-y-4">
        {isByok ? (
          <div className="flex items-center gap-2 rounded-md border border-violet-500/20 bg-violet-50 px-4 py-3 dark:bg-violet-950/20">
            <Badge variant="outline" className="border-violet-500/30 text-violet-600 dark:text-violet-400">
              BYOK
            </Badge>
            <span className="text-sm font-medium">
              Unlimited — using your own API key
            </span>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Tokens used</span>
                {isUnlimitedTokens ? (
                  <Badge variant="outline" className="text-xs">Unlimited</Badge>
                ) : (
                  <span className={`text-sm font-medium ${overageColor(usage.tokenOverageStatus)}`}>
                    {formatNumber(usage.tokenCount)} / {formatNumber(tokenBudget)}
                  </span>
                )}
              </div>
              {!isUnlimitedTokens && (
                <Progress value={Math.min(usage.tokenUsagePercent, 100)} className="h-2" />
              )}
              {limits.tokenBudgetPerSeat != null && (
                <p className="text-xs text-muted-foreground">
                  {formatNumber(limits.tokenBudgetPerSeat)} tokens/seat/mo x {data.seats?.count ?? 0} seats
                </p>
              )}
            </div>

            {/* Query usage row */}
            {limits.queriesPerMonth !== null && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Queries</span>
                  <span className={`text-sm font-medium ${overageColor(usage.queryOverageStatus)}`}>
                    {formatNumber(usage.queryCount)} / {formatNumber(limits.queriesPerMonth)}
                  </span>
                </div>
                <Progress value={Math.min(usage.queryUsagePercent, 100)} className="h-2" />
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Model selector card ──────────────────────────────────────────

function ModelCard({
  data,
  onModelChanged,
}: {
  data: BillingStatus;
  onModelChanged: () => void;
}) {
  const currentModel = data.currentModel ?? data.plan.defaultModel ?? "default";

  const { mutate, saving, error } = useAdminMutation<{ key: string; value: string }>({
    path: "/api/v1/admin/settings/ATLAS_MODEL",
    method: "PUT",
    invalidates: onModelChanged,
  });

  async function handleModelChange(value: string) {
    await mutate({ body: { value } });
  }

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Cpu className="size-4" />
          Model
        </CardTitle>
        <CardDescription>
          Select the AI model used for queries in this workspace.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <ErrorBanner message={error} />}
        <div className="flex items-center gap-3">
          <Select
            value={currentModel}
            onValueChange={handleModelChange}
            disabled={saving}
          >
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Select model" />
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
            <span className="text-xs text-muted-foreground">Saving...</span>
          )}
        </div>
        {data.plan.defaultModel && (
          <p className="text-xs text-muted-foreground">
            Plan default: {data.plan.defaultModel}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Resources card (seats + connections) ─────────────────────────

function ResourcesCard({ data }: { data: BillingStatus }) {
  const seatCount = data.seats?.count ?? 0;
  const seatMax = data.seats?.max ?? data.limits.maxMembers;
  const connCount = data.connections?.count ?? 0;
  const connMax = data.connections?.max ?? data.limits.maxConnections;

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Resources</CardTitle>
        <CardDescription>
          Seats and connections in your workspace.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium">
                <span className="text-muted-foreground"><Users className="size-4" /></span>
                Seats
              </div>
              {seatMax === null ? (
                <Badge variant="outline" className="text-xs">Unlimited</Badge>
              ) : (
                <span className="text-sm font-medium">
                  {seatCount} / {seatMax}
                </span>
              )}
            </div>
            {seatMax !== null && (
              <Progress value={seatMax > 0 ? Math.min((seatCount / seatMax) * 100, 100) : 0} className="h-2" />
            )}
            <p className="text-xs text-muted-foreground">
              <Link href="/admin/users" className="underline underline-offset-2 hover:text-foreground">
                Manage users
              </Link>
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium">
                <span className="text-muted-foreground"><Database className="size-4" /></span>
                Connections
              </div>
              {connMax === null ? (
                <Badge variant="outline" className="text-xs">Unlimited</Badge>
              ) : (
                <span className="text-sm font-medium">
                  {connCount} / {connMax}
                </span>
              )}
            </div>
            {connMax !== null && (
              <Progress value={connMax > 0 ? Math.min((connCount / connMax) * 100, 100) : 0} className="h-2" />
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Overage card ─────────────────────────────────────────────────

function OverageCard({ data }: { data: BillingStatus }) {
  const overageRate = data.overagePerQuery ?? 0;

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="size-4" />
          Overage Pricing
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Queries beyond your included budget are charged at{" "}
          <span className="font-medium text-foreground">
            {formatCurrency(overageRate)}/query
          </span>.
        </p>
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
          instead of using the platform-managed model. Queries are unlimited in BYOK mode.
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
