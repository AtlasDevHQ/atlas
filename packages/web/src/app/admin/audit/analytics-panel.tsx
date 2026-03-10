"use client";

import dynamic from "next/dynamic";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
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
import { BarChart3, Clock, AlertTriangle, Users } from "lucide-react";

// Dynamic import — Recharts is heavy
const VolumeChart = dynamic(() => import("./volume-chart"), { ssr: false });
const ErrorChart = dynamic(() => import("./error-chart"), { ssr: false });

// ── Types ─────────────────────────────────────────────────────────

interface VolumePoint {
  day: string;
  count: number;
  errors: number;
}

interface SlowQuery {
  query: string;
  avgDuration: number;
  maxDuration: number;
  count: number;
}

interface ErrorGroup {
  error: string;
  count: number;
}

interface UserStats {
  userId: string;
  count: number;
  avgDuration: number;
  errorCount: number;
  errorRate: number;
}

// ── Component ─────────────────────────────────────────────────────

export function AnalyticsPanel({ from, to }: { from: string; to: string }) {
  const qs = buildQS(from, to);
  const dark = useDarkMode();

  const { data: volumeData, loading: volumeLoading } = useAdminFetch<{ volume: VolumePoint[] }>(
    `/api/v1/admin/audit/analytics/volume${qs}`,
    { deps: [qs] },
  );

  const { data: slowData, loading: slowLoading } = useAdminFetch<{ queries: SlowQuery[] }>(
    `/api/v1/admin/audit/analytics/slow${qs}`,
    { deps: [qs] },
  );

  const { data: errorData, loading: errorLoading } = useAdminFetch<{ errors: ErrorGroup[] }>(
    `/api/v1/admin/audit/analytics/errors${qs}`,
    { deps: [qs] },
  );

  const { data: userData, loading: userLoading } = useAdminFetch<{ users: UserStats[] }>(
    `/api/v1/admin/audit/analytics/users${qs}`,
    { deps: [qs] },
  );

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
          {volumeLoading ? (
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
            {slowLoading ? (
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

        {/* Error breakdown */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="size-4" />
              Error Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent>
            {errorLoading ? (
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
      </div>

      {/* Per-user activity */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="size-4" />
            User Activity
          </CardTitle>
        </CardHeader>
        <CardContent>
          {userLoading ? (
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
                      <TableCell className="text-sm">{u.userId}</TableCell>
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

function buildQS(from: string, to: string): string {
  const parts: string[] = [];
  if (from) parts.push(`from=${encodeURIComponent(from)}`);
  if (to) parts.push(`to=${encodeURIComponent(to)}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}
