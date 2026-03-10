"use client";

import dynamic from "next/dynamic";
import { useQueryStates } from "nuqs";
import { tokenUsageSearchParams } from "./search-params";
import { useAdminFetch, type FetchError } from "@/ui/hooks/use-admin-fetch";
import { useDarkMode } from "@/ui/hooks/use-dark-mode";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatCard } from "@/ui/components/admin/stat-card";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { EmptyState } from "@/ui/components/admin/empty-state";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import { Coins, TrendingUp, Users, MessageSquare, Search } from "lucide-react";
import { useState } from "react";

import type { TrendPoint } from "./token-chart";

// Dynamic import — Recharts is heavy
const TokenChart = dynamic(() => import("./token-chart"), { ssr: false });

// ── Types ─────────────────────────────────────────────────────────

interface TokenSummary {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalRequests: number;
  from: string;
  to: string;
}

interface UserTokenRow {
  userId: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requestCount: number;
}

interface TrendsResponse {
  trends: TrendPoint[];
  from: string;
  to: string;
}

// ── Helpers ───────────────────────────────────────────────────────

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function buildQS(from: string, to: string): string {
  const parts: string[] = [];
  if (from) parts.push(`from=${encodeURIComponent(from)}`);
  if (to) parts.push(`to=${encodeURIComponent(to)}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

function findGateError(...errors: (FetchError | null)[]): FetchError | null {
  for (const err of errors) {
    if (err?.status && [401, 403, 404].includes(err.status)) return err;
  }
  return null;
}

// ── Component ─────────────────────────────────────────────────────

export default function TokenUsagePage() {
  const dark = useDarkMode();
  const [params, setParams] = useQueryStates(tokenUsageSearchParams);
  const [filters, setFilters] = useState({ from: params.from, to: params.to });

  const qs = buildQS(params.from, params.to);

  const { data: summary, loading: summaryLoading, error: summaryError } =
    useAdminFetch<TokenSummary>(`/api/v1/admin/tokens/summary${qs}`, { deps: [qs] });

  const { data: trendsData, loading: trendsLoading, error: trendsError } =
    useAdminFetch<TrendsResponse>(`/api/v1/admin/tokens/trends${qs}`, { deps: [qs] });

  const { data: usersData, loading: usersLoading, error: usersError } =
    useAdminFetch<{ users: UserTokenRow[] }>(`/api/v1/admin/tokens/by-user${qs}`, { deps: [qs] });

  // Gate: auth/availability errors surface as FeatureGate
  const gateError = findGateError(summaryError, trendsError, usersError);
  if (gateError?.status && [401, 403, 404].includes(gateError.status)) {
    return <FeatureGate status={gateError.status as 401 | 403 | 404} feature="Token Usage" />;
  }

  function applyFilters() {
    setParams({ from: filters.from, to: filters.to });
  }

  function clearFilters() {
    setFilters({ from: "", to: "" });
    setParams({ from: "", to: "" });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Token Usage</h1>
        <p className="text-sm text-muted-foreground">
          Track LLM token consumption across users and conversations.
        </p>
      </div>

      {/* Date range filter */}
      <Card className="shadow-none">
        <CardContent className="flex flex-wrap items-end gap-3 pt-4">
          <div className="grid gap-1">
            <label htmlFor="from" className="text-xs text-muted-foreground">From</label>
            <Input
              id="from"
              type="date"
              className="h-8 w-40"
              value={filters.from}
              onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
            />
          </div>
          <div className="grid gap-1">
            <label htmlFor="to" className="text-xs text-muted-foreground">To</label>
            <Input
              id="to"
              type="date"
              className="h-8 w-40"
              value={filters.to}
              onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
            />
          </div>
          <Button size="sm" variant="outline" className="h-8" onClick={applyFilters}>
            <Search className="mr-1 size-3" />
            Apply
          </Button>
          {(params.from || params.to) && (
            <Button size="sm" variant="ghost" className="h-8" onClick={clearFilters}>
              Clear
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Summary cards */}
      {summaryError ? (
        <ErrorBanner message={summaryError.message} />
      ) : summaryLoading ? (
        <LoadingState message="Loading summary..." />
      ) : summary ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title="Total Tokens"
            value={formatNumber(summary.totalTokens)}
            icon={<Coins className="size-4" />}
          />
          <StatCard
            title="Prompt Tokens"
            value={formatNumber(summary.totalPromptTokens)}
            icon={<TrendingUp className="size-4" />}
            description={summary.totalTokens > 0
              ? `${((summary.totalPromptTokens / summary.totalTokens) * 100).toFixed(0)}% of total`
              : undefined}
          />
          <StatCard
            title="Completion Tokens"
            value={formatNumber(summary.totalCompletionTokens)}
            icon={<TrendingUp className="size-4" />}
            description={summary.totalTokens > 0
              ? `${((summary.totalCompletionTokens / summary.totalTokens) * 100).toFixed(0)}% of total`
              : undefined}
          />
          <StatCard
            title="Total Requests"
            value={formatNumber(summary.totalRequests)}
            icon={<MessageSquare className="size-4" />}
            description={summary.totalRequests > 0 && summary.totalTokens > 0
              ? `~${formatNumber(Math.round(summary.totalTokens / summary.totalRequests))} tokens/req`
              : undefined}
          />
        </div>
      ) : null}

      {/* Trends chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUp className="size-4" />
            Token Usage Over Time
          </CardTitle>
        </CardHeader>
        <CardContent>
          {trendsError ? (
            <ErrorBanner message={trendsError.message} />
          ) : trendsLoading ? (
            <div className="flex h-64 items-center justify-center">
              <LoadingState message="Loading trends..." />
            </div>
          ) : !trendsData?.trends?.length ? (
            <EmptyState icon={TrendingUp} message="No token usage data for this period" />
          ) : (
            <TokenChart data={trendsData.trends} dark={dark} />
          )}
        </CardContent>
      </Card>

      {/* Top users table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="size-4" />
            Top Users by Token Consumption
          </CardTitle>
        </CardHeader>
        <CardContent>
          {usersError ? (
            <ErrorBanner message={usersError.message} />
          ) : usersLoading ? (
            <div className="flex h-40 items-center justify-center">
              <LoadingState message="Loading..." />
            </div>
          ) : !usersData?.users?.length ? (
            <EmptyState icon={Users} message="No user data for this period" />
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead className="w-28 text-right">Prompt</TableHead>
                    <TableHead className="w-28 text-right">Completion</TableHead>
                    <TableHead className="w-28 text-right">Total</TableHead>
                    <TableHead className="w-20 text-right">Requests</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {usersData.users.map((u) => (
                    <TableRow key={u.userId}>
                      <TableCell className="text-sm">{u.userId}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {formatNumber(u.promptTokens)}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {formatNumber(u.completionTokens)}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums font-medium">
                        {formatNumber(u.totalTokens)}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {u.requestCount}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
