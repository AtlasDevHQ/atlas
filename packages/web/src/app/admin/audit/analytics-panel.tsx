"use client";

import dynamic from "next/dynamic";
import { useAdminFetch, type FetchError } from "@/ui/hooks/use-admin-fetch";
import { useDarkMode } from "@/ui/hooks/use-dark-mode";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { EmptyState } from "@/ui/components/admin/empty-state";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import { BarChart3, Clock, AlertTriangle, Users, Repeat } from "lucide-react";

// Dynamic import — Recharts is heavy
const VolumeChart = dynamic(() => import("./volume-chart"), { ssr: false });
const ErrorChart = dynamic(() => import("./error-chart"), { ssr: false });

// ── Types (exported for chart components) ─────────────────────────

export interface VolumePoint {
  day: string;
  count: number;
  errors: number;
}

export interface SlowQuery {
  query: string;
  avgDuration: number;
  maxDuration: number;
  count: number;
}

export interface FrequentQuery {
  query: string;
  count: number;
  avgDuration: number;
  errorCount: number;
}

export interface ErrorGroup {
  error: string;
  count: number;
}

export interface AuditUserStats {
  userId: string;
  userEmail?: string | null;
  count: number;
  avgDuration: number;
  errorCount: number;
  errorRate: number;
}

// ── Helpers ───────────────────────────────────────────────────────

function buildQS(from: string, to: string): string {
  const parts: string[] = [];
  if (from) parts.push(`from=${encodeURIComponent(from)}`);
  if (to) parts.push(`to=${encodeURIComponent(to)}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

/** Check if any fetch error is an auth/availability gate error. */
function findGateError(...errors: (FetchError | null)[]): FetchError | null {
  for (const err of errors) {
    if (err?.status && [401, 403, 404].includes(err.status)) return err;
  }
  return null;
}

// ── Component ─────────────────────────────────────────────────────

export function AnalyticsPanel({ from, to }: { from: string; to: string }) {
  const qs = buildQS(from, to);
  const dark = useDarkMode();

  const { data: volumeData, loading: volumeLoading, error: volumeError } = useAdminFetch<{ volume: VolumePoint[] }>(
    `/api/v1/admin/audit/analytics/volume${qs}`,
    { deps: [qs] },
  );

  const { data: slowData, loading: slowLoading, error: slowError } = useAdminFetch<{ queries: SlowQuery[] }>(
    `/api/v1/admin/audit/analytics/slow${qs}`,
    { deps: [qs] },
  );

  const { data: frequentData, loading: frequentLoading, error: frequentError } = useAdminFetch<{ queries: FrequentQuery[] }>(
    `/api/v1/admin/audit/analytics/frequent${qs}`,
    { deps: [qs] },
  );

  const { data: errorData, loading: errorLoading, error: errorsError } = useAdminFetch<{ errors: ErrorGroup[] }>(
    `/api/v1/admin/audit/analytics/errors${qs}`,
    { deps: [qs] },
  );

  const { data: userData, loading: userLoading, error: userError } = useAdminFetch<{ users: AuditUserStats[] }>(
    `/api/v1/admin/audit/analytics/users${qs}`,
    { deps: [qs] },
  );

  // Gate: auth/availability errors surface as FeatureGate
  const gateError = findGateError(volumeError, slowError, frequentError, errorsError, userError);
  if (gateError?.status && [401, 403, 404].includes(gateError.status)) {
    return <FeatureGate status={gateError.status as 401 | 403 | 404} feature="Query Analytics" />;
  }

  return (
    <div className="space-y-6">
      {/* Query volume chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="size-4" />
            Query Volume
          </CardTitle>
        </CardHeader>
        <CardContent>
          {volumeError ? (
            <ErrorBanner message={volumeError.message} />
          ) : volumeLoading ? (
            <div className="flex h-64 items-center justify-center">
              <LoadingState message="Loading volume data..." />
            </div>
          ) : !volumeData?.volume?.length ? (
            <EmptyState icon={BarChart3} message="No query data for this period" />
          ) : (
            <VolumeChart data={volumeData.volume} dark={dark} />
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Slowest queries */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="size-4" />
              Slowest Queries
            </CardTitle>
          </CardHeader>
          <CardContent>
            {slowError ? (
              <ErrorBanner message={slowError.message} />
            ) : slowLoading ? (
              <div className="flex h-40 items-center justify-center">
                <LoadingState message="Loading..." />
              </div>
            ) : !slowData?.queries?.length ? (
              <EmptyState icon={Clock} message="No query data" />
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Query</TableHead>
                      <TableHead className="w-20 text-right">Avg</TableHead>
                      <TableHead className="w-20 text-right">Max</TableHead>
                      <TableHead className="w-16 text-right">Runs</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {slowData.queries.map((q, i) => (
                      <TableRow key={i}>
                        <TableCell className="max-w-xs truncate font-mono text-xs">
                          {q.query}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {q.avgDuration}ms
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {q.maxDuration}ms
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {q.count}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Most frequent queries */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Repeat className="size-4" />
              Most Frequent Queries
            </CardTitle>
          </CardHeader>
          <CardContent>
            {frequentError ? (
              <ErrorBanner message={frequentError.message} />
            ) : frequentLoading ? (
              <div className="flex h-40 items-center justify-center">
                <LoadingState message="Loading..." />
              </div>
            ) : !frequentData?.queries?.length ? (
              <EmptyState icon={Repeat} message="No query data" />
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Query</TableHead>
                      <TableHead className="w-16 text-right">Runs</TableHead>
                      <TableHead className="w-20 text-right">Avg</TableHead>
                      <TableHead className="w-16 text-right">Errors</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {frequentData.queries.map((q, i) => (
                      <TableRow key={i}>
                        <TableCell className="max-w-xs truncate font-mono text-xs">
                          {q.query}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {q.count}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {q.avgDuration}ms
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {q.errorCount}
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

      {/* Error breakdown */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="size-4" />
            Error Breakdown
          </CardTitle>
        </CardHeader>
        <CardContent>
          {errorsError ? (
            <ErrorBanner message={errorsError.message} />
          ) : errorLoading ? (
            <div className="flex h-40 items-center justify-center">
              <LoadingState message="Loading..." />
            </div>
          ) : !errorData?.errors?.length ? (
            <EmptyState icon={AlertTriangle} message="No errors recorded" />
          ) : (
            <ErrorChart data={errorData.errors} dark={dark} />
          )}
        </CardContent>
      </Card>

      {/* Per-user activity */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="size-4" />
            User Activity
          </CardTitle>
        </CardHeader>
        <CardContent>
          {userError ? (
            <ErrorBanner message={userError.message} />
          ) : userLoading ? (
            <div className="flex h-40 items-center justify-center">
              <LoadingState message="Loading..." />
            </div>
          ) : !userData?.users?.length ? (
            <EmptyState icon={Users} message="No user data" />
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead className="w-20 text-right">Queries</TableHead>
                    <TableHead className="w-24 text-right">Avg Duration</TableHead>
                    <TableHead className="w-16 text-right">Errors</TableHead>
                    <TableHead className="w-24 text-right">Error Rate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {userData.users.map((u) => (
                    <TableRow key={u.userId}>
                      <TableCell className="text-sm">{u.userEmail ?? u.userId}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {u.count.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {u.avgDuration}ms
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {u.errorCount}
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge
                          variant="outline"
                          className={
                            u.errorRate > 0.1
                              ? "border-red-300 text-red-700 dark:border-red-700 dark:text-red-400"
                              : "border-green-300 text-green-700 dark:border-green-700 dark:text-green-400"
                          }
                        >
                          {(u.errorRate * 100).toFixed(1)}%
                        </Badge>
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
