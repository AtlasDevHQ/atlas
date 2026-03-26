"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { useDarkMode } from "@/ui/hooks/use-dark-mode";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { StatCard } from "@/ui/components/admin/stat-card";
import { EmptyState } from "@/ui/components/admin/empty-state";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { DataTable } from "@/components/data-table/data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTableSortList } from "@/components/data-table/data-table-sort-list";
import { getUserUsageColumns, type UserUsageRow } from "./columns";
import { formatNumber } from "./format";
import { useDataTable } from "@/hooks/use-data-table";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  BarChart3,
  MessageSquare,
  Coins,
  Users,
  TrendingUp,
  ExternalLink,
  CreditCard,
} from "lucide-react";
import type { ReactNode } from "react";

import type { DailyUsagePoint } from "./usage-chart";

// Dynamic import — Recharts is heavy
const UsageChart = dynamic(() => import("./usage-chart"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[300px] items-center justify-center text-sm text-muted-foreground">
      Loading chart...
    </div>
  ),
});

// ── Types ─────────────────────────────────────────────────────────

interface UsageSummary {
  workspaceId: string;
  current: {
    queryCount: number;
    tokenCount: number;
    activeUsers: number;
    periodStart: string;
    periodEnd: string;
  };
  plan: {
    tier: string;
    displayName: string;
    trialEndsAt: string | null;
  };
  limits: {
    queriesPerMonth: number | null;
    tokensPerMonth: number | null;
    maxMembers: number | null;
    maxConnections: number | null;
  };
  history: DailyUsagePoint[];
  users: UserUsageRow[];
  hasStripe: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────

/** Returns usage percentage (0–100), or null if limit is null (unlimited). */
function pct(used: number, limit: number | null): number | null {
  if (limit === null) return null;
  if (limit === 0) return 100;
  return Math.min(Math.round((used / limit) * 100), 100);
}

function formatPeriod(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  return `${s.toLocaleDateString(undefined, { month: "long", year: "numeric" })} (${s.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${e.toLocaleDateString(undefined, { month: "short", day: "numeric" })})`;
}

// ── Component ─────────────────────────────────────────────────────

export default function UsageDashboardPage() {
  const dark = useDarkMode();

  const { data, loading, error, refetch } = useAdminFetch<UsageSummary>(
    "/api/v1/admin/usage/summary",
  );

  const { mutate: portalMutate, saving: portalLoading, error: portalError } =
    useAdminMutation<{ url?: string }>({
      path: "/api/v1/billing/portal",
      method: "POST",
    });
  const [portalUrlError, setPortalUrlError] = useState<string | null>(null);

  // Data table for user breakdown
  const columns = getUserUsageColumns();
  const userData = data?.users ?? [];
  const { table } = useDataTable({
    data: userData,
    columns,
    pageCount: 1,
    initialState: {
      sorting: [{ id: "query_count", desc: true }],
      pagination: { pageIndex: 0, pageSize: 25 },
    },
    getRowId: (row) => row.user_id,
  });

  async function openBillingPortal() {
    const result = await portalMutate({
      body: { returnUrl: window.location.href },
    });
    if (result.ok && result.data?.url) {
      window.location.href = result.data.url;
    } else if (result.ok && !result.data?.url) {
      setPortalUrlError("Billing portal URL was not returned. Please contact support.");
    }
  }

  return (
    <ErrorBoundary>
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Usage</h1>
          <p className="text-sm text-muted-foreground">
            {data
              ? `${data.plan.displayName} plan — ${formatPeriod(data.current.periodStart, data.current.periodEnd)}`
              : "Monitor workspace consumption relative to plan limits."}
          </p>
        </div>
        {data?.hasStripe && (
          <Button
            variant="outline"
            size="sm"
            onClick={openBillingPortal}
            disabled={portalLoading}
          >
            <CreditCard className="mr-1.5 size-3.5" />
            {portalLoading ? "Opening..." : "Manage Plan"}
            <ExternalLink className="ml-1.5 size-3" />
          </Button>
        )}
      </div>

      <div className="space-y-6">
        {/* Portal error */}
        {(portalError ?? portalUrlError) && <ErrorBanner message={(portalError ?? portalUrlError)!} onRetry={() => { setPortalUrlError(null); openBillingPortal(); }} />}

        <AdminContentWrapper
          loading={loading}
          error={error}
          feature="Usage Dashboard"
          onRetry={refetch}
          loadingMessage="Loading usage data..."
        >
          {data && <>
            {/* Usage metrics with progress toward limits */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <UsageMetricCard
                title="Queries"
                used={data.current.queryCount}
                limit={data.limits.queriesPerMonth}
                icon={<MessageSquare className="size-4" />}
              />
              <UsageMetricCard
                title="Tokens"
                used={data.current.tokenCount}
                limit={data.limits.tokensPerMonth}
                icon={<Coins className="size-4" />}
              />
              <StatCard
                title="Active Users"
                value={data.current.activeUsers.toLocaleString()}
                icon={<Users className="size-4" />}
                description={
                  data.limits.maxMembers !== null
                    ? `of ${formatNumber(data.limits.maxMembers)} allowed`
                    : "Unlimited"
                }
              />
              <StatCard
                title="Plan"
                value={data.plan.displayName}
                icon={<CreditCard className="size-4" />}
                description={
                  data.plan.trialEndsAt
                    ? `Trial ends ${new Date(data.plan.trialEndsAt).toLocaleDateString()}`
                    : undefined
                }
              />
            </div>

            {/* Historical chart */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <TrendingUp className="size-4" />
                  Daily Usage — Last 30 Days
                </CardTitle>
              </CardHeader>
              <CardContent>
                {!data.history.length ? (
                  <EmptyState icon={BarChart3} title="No usage data yet" description="Usage will appear here as queries are made." />
                ) : (
                  <UsageChart data={data.history} dark={dark} />
                )}
              </CardContent>
            </Card>

            {/* Per-user breakdown */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Users className="size-4" />
                  Usage by User
                </CardTitle>
              </CardHeader>
              <CardContent>
                {!data.users.length ? (
                  <EmptyState icon={Users} title="No user data yet" />
                ) : (
                  <DataTable table={table}>
                    <DataTableToolbar table={table}>
                      <DataTableSortList table={table} />
                    </DataTableToolbar>
                  </DataTable>
                )}
              </CardContent>
            </Card>
          </>}
        </AdminContentWrapper>
      </div>
    </div>
    </ErrorBoundary>
  );
}

// ── Usage metric card with progress bar ───────────────────────────

function UsageMetricCard({
  title,
  used,
  limit,
  icon,
}: {
  title: string;
  used: number;
  limit: number | null;
  icon: ReactNode;
}) {
  const percentage = pct(used, limit);

  return (
    <Card className="shadow-none">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <span className="text-muted-foreground">{icon}</span>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{formatNumber(used)}</div>
        {limit !== null ? (
          <div className="mt-2 space-y-1">
            <Progress value={percentage ?? 0} className="h-2" />
            <p className="text-xs text-muted-foreground">
              {formatNumber(used)} of {formatNumber(limit)} ({percentage}%)
            </p>
          </div>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">Unlimited</p>
        )}
      </CardContent>
    </Card>
  );
}
