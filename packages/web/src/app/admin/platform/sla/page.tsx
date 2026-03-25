"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { parseAsStringEnum, useQueryState } from "nuqs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { StatCard } from "@/ui/components/admin/stat-card";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { useAdminFetch, friendlyError } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  Activity,
  AlertTriangle,
  ArrowUpDown,
  Bell,
  BellOff,
  CheckCircle2,
  Clock,
  Eye,
  Loader2,
  Settings2,
  Timer,
  XCircle,
} from "lucide-react";
import type {
  WorkspaceSLASummary,
  WorkspaceSLADetail,
  SLAAlert,
  SLAAlertStatus,
  SLAThresholds,
} from "@/ui/lib/types";

// Dynamic import for Recharts (heavy dependency)
const RechartsLine = dynamic(
  () => import("recharts").then((mod) => {
    const { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } = mod;
    return {
      default: function MetricChart({ data, dataKey, color, unit }: { data: Array<{ name: string; value: number }>; dataKey: string; color: string; unit: string }) {
        return (
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" fontSize={12} />
              <YAxis fontSize={12} />
              <Tooltip formatter={(value: number | undefined) => [`${value ?? 0}${unit}`, dataKey]} />
              <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        );
      },
    };
  }),
  { ssr: false, loading: () => <div className="h-[250px] animate-pulse rounded bg-muted" /> },
);

// ── Types ─────────────────────────────────────────────────────────

type SortField = "workspaceName" | "latencyP99Ms" | "errorRatePct" | "uptimePct" | "totalQueries";
type SortDir = "asc" | "desc";

// ── Helpers ───────────────────────────────────────────────────────

function alertStatusBadge(status: SLAAlertStatus) {
  switch (status) {
    case "firing":
      return <Badge variant="destructive" className="gap-1"><XCircle className="size-3" />Firing</Badge>;
    case "resolved":
      return <Badge variant="outline" className="gap-1 border-green-500 text-green-600"><CheckCircle2 className="size-3" />Resolved</Badge>;
    case "acknowledged":
      return <Badge variant="outline" className="gap-1 border-amber-500 text-amber-600"><Bell className="size-3" />Acknowledged</Badge>;
  }
}

function uptimeBadge(pct: number) {
  if (pct >= 99.9) return <Badge variant="outline" className="border-green-500 text-green-600">{pct.toFixed(1)}%</Badge>;
  if (pct >= 99) return <Badge variant="outline" className="border-amber-500 text-amber-600">{pct.toFixed(1)}%</Badge>;
  return <Badge variant="destructive">{pct.toFixed(1)}%</Badge>;
}

function latencyBadge(ms: number, threshold: number) {
  if (ms <= threshold * 0.5) return <Badge variant="outline" className="border-green-500 text-green-600">{ms}ms</Badge>;
  if (ms <= threshold) return <Badge variant="outline" className="border-amber-500 text-amber-600">{ms}ms</Badge>;
  return <Badge variant="destructive">{ms}ms</Badge>;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatHour(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

// ── Main Page ─────────────────────────────────────────────────────

export default function SLAMonitoringPage() {
  return (
    <ErrorBoundary>
      <SLAPageContent />
    </ErrorBoundary>
  );
}

function SLAPageContent() {
  // ── All hooks must be called before any conditional returns ──
  const [tab, setTab] = useQueryState("tab", parseAsStringEnum(["overview", "alerts"]).withDefault("overview"));

  // Data
  const { data: slaData, loading: slaLoading, error: slaError } = useAdminFetch<{ workspaces: WorkspaceSLASummary[]; hoursBack: number }>(
    "/api/v1/platform/sla",
  );
  const { data: alertsData, loading: alertsLoading, error: alertsError, refetch: refetchAlerts } = useAdminFetch<{ alerts: SLAAlert[] }>(
    "/api/v1/platform/sla/alerts",
  );
  const { data: thresholdsData, loading: thresholdsLoading, refetch: refetchThresholds } = useAdminFetch<SLAThresholds>(
    "/api/v1/platform/sla/thresholds",
  );

  // Sorting
  const [sortField, setSortField] = useState<SortField>("totalQueries");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Workspace detail dialog
  const [detailId, setDetailId] = useState<string | null>(null);
  const { data: detailData, loading: detailLoading, error: detailError } = useAdminFetch<WorkspaceSLADetail>(
    detailId ? `/api/v1/platform/sla/${detailId}` : "",
    { deps: [detailId] },
  );

  // Threshold edit dialog
  const [thresholdDialogOpen, setThresholdDialogOpen] = useState(false);
  const [editThresholds, setEditThresholds] = useState<SLAThresholds | null>(null);
  const { mutate: thresholdMutate, saving: thresholdSaving, error: thresholdError, clearError: clearThresholdError } = useAdminMutation({
    method: "PUT",
    path: "/api/v1/platform/sla/thresholds",
    invalidates: refetchThresholds,
  });

  // Acknowledge mutation
  const { mutate: ackMutate } = useAdminMutation({ invalidates: refetchAlerts });

  // Evaluate mutation
  const { mutate: evalMutate, saving: evalSaving } = useAdminMutation({ invalidates: refetchAlerts });

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  }

  const workspaces = slaData?.workspaces ?? [];
  const sorted = workspaces.toSorted((a, b) => {
    const dir = sortDir === "asc" ? 1 : -1;
    switch (sortField) {
      case "workspaceName": return dir * a.workspaceName.localeCompare(b.workspaceName);
      case "latencyP99Ms": return dir * (a.latencyP99Ms - b.latencyP99Ms);
      case "errorRatePct": return dir * (a.errorRatePct - b.errorRatePct);
      case "uptimePct": return dir * (a.uptimePct - b.uptimePct);
      case "totalQueries": return dir * (a.totalQueries - b.totalQueries);
      default: return 0;
    }
  });

  function openThresholdDialog() {
    setEditThresholds(thresholdsData ?? { latencyP99Ms: 5000, errorRatePct: 5 });
    clearThresholdError();
    setThresholdDialogOpen(true);
  }

  async function saveThresholds() {
    if (!editThresholds) return;
    const result = await thresholdMutate({ body: editThresholds as unknown as Record<string, unknown> });
    if (result.ok) {
      setThresholdDialogOpen(false);
    }
  }

  async function acknowledgeAlert(alertId: string) {
    await ackMutate({ path: `/api/v1/platform/sla/alerts/${alertId}/acknowledge` });
  }

  async function triggerEvaluation() {
    await evalMutate({ path: "/api/v1/platform/sla/evaluate" });
  }

  // Aggregate stats
  const firingAlerts = alertsData?.alerts.filter((a) => a.status === "firing") ?? [];
  const avgLatencyP99 = workspaces.length > 0
    ? Math.round(workspaces.reduce((sum, w) => sum + w.latencyP99Ms, 0) / workspaces.length)
    : 0;
  const avgUptime = workspaces.length > 0
    ? Math.round(workspaces.reduce((sum, w) => sum + w.uptimePct, 0) / workspaces.length * 100) / 100
    : 100;
  const defaultThreshold = thresholdsData?.latencyP99Ms ?? 5000;

  return (
    <AdminContentWrapper
      loading={false}
      error={slaError}
      feature="SLA Monitoring"
      onRetry={() => {}}
    >
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">SLA Monitoring</h1>
          <p className="text-muted-foreground">Per-workspace uptime, latency, and error rate visibility.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={openThresholdDialog} disabled={thresholdsLoading}>
            <Settings2 className="mr-2 size-4" />
            Thresholds
          </Button>
          <Button variant="outline" size="sm" onClick={triggerEvaluation} disabled={evalSaving}>
            {evalSaving ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Activity className="mr-2 size-4" />}
            Evaluate Now
          </Button>
        </div>
      </div>

      {/* Stat cards */}
      {!slaLoading && !slaError && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title="Monitored Workspaces"
            value={workspaces.length}
            icon={<Activity className="size-4" />}
          />
          <StatCard
            title="Avg P99 Latency"
            value={`${avgLatencyP99}ms`}
            icon={<Timer className="size-4" />}
          />
          <StatCard
            title="Avg Uptime"
            value={`${avgUptime}%`}
            icon={<CheckCircle2 className="size-4" />}
          />
          <StatCard
            title="Active Alerts"
            value={firingAlerts.length}
            icon={<AlertTriangle className="size-4" />}
            description={firingAlerts.length > 0 ? `${firingAlerts.length} firing` : "All clear"}
          />
        </div>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as "overview" | "alerts")}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="alerts">
            Alerts
            {firingAlerts.length > 0 && (
              <Badge variant="destructive" className="ml-2">{firingAlerts.length}</Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* ── Overview Tab ───────────────────────────────────────── */}
        <TabsContent value="overview" className="space-y-4">
          {slaLoading ? (
            <LoadingState message="Loading SLA metrics..." />
          ) : slaError ? (
            <ErrorBanner message={friendlyError(slaError)} />
          ) : workspaces.length === 0 ? (
            <Card className="shadow-none">
              <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Activity className="mb-2 size-8" />
                <p>No SLA metrics recorded yet. Metrics are collected as queries are executed.</p>
              </CardContent>
            </Card>
          ) : (
            <Card className="shadow-none">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      <Button variant="ghost" size="sm" onClick={() => toggleSort("workspaceName")} className="gap-1">
                        Workspace <ArrowUpDown className="size-3" />
                      </Button>
                    </TableHead>
                    <TableHead>P50</TableHead>
                    <TableHead>P95</TableHead>
                    <TableHead>
                      <Button variant="ghost" size="sm" onClick={() => toggleSort("latencyP99Ms")} className="gap-1">
                        P99 <ArrowUpDown className="size-3" />
                      </Button>
                    </TableHead>
                    <TableHead>
                      <Button variant="ghost" size="sm" onClick={() => toggleSort("errorRatePct")} className="gap-1">
                        Error Rate <ArrowUpDown className="size-3" />
                      </Button>
                    </TableHead>
                    <TableHead>
                      <Button variant="ghost" size="sm" onClick={() => toggleSort("uptimePct")} className="gap-1">
                        Uptime <ArrowUpDown className="size-3" />
                      </Button>
                    </TableHead>
                    <TableHead>
                      <Button variant="ghost" size="sm" onClick={() => toggleSort("totalQueries")} className="gap-1">
                        Queries <ArrowUpDown className="size-3" />
                      </Button>
                    </TableHead>
                    <TableHead className="text-right">Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((ws) => (
                    <TableRow key={ws.workspaceId}>
                      <TableCell className="font-medium">{ws.workspaceName}</TableCell>
                      <TableCell>{ws.latencyP50Ms}ms</TableCell>
                      <TableCell>{ws.latencyP95Ms}ms</TableCell>
                      <TableCell>{latencyBadge(ws.latencyP99Ms, defaultThreshold)}</TableCell>
                      <TableCell>
                        <Badge variant={ws.errorRatePct > (thresholdsData?.errorRatePct ?? 5) ? "destructive" : "outline"}>
                          {ws.errorRatePct.toFixed(1)}%
                        </Badge>
                      </TableCell>
                      <TableCell>{uptimeBadge(ws.uptimePct)}</TableCell>
                      <TableCell>{ws.totalQueries.toLocaleString()}</TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="icon" onClick={() => setDetailId(ws.workspaceId)} title="View detail">
                          <Eye className="size-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </TabsContent>

        {/* ── Alerts Tab ─────────────────────────────────────────── */}
        <TabsContent value="alerts" className="space-y-4">
          {alertsLoading ? (
            <LoadingState message="Loading alerts..." />
          ) : alertsError ? (
            <ErrorBanner message={friendlyError(alertsError)} />
          ) : (alertsData?.alerts ?? []).length === 0 ? (
            <Card className="shadow-none">
              <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <BellOff className="mb-2 size-8" />
                <p>No SLA alerts. All workspaces are within thresholds.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {(alertsData?.alerts ?? []).map((alert) => (
                <Card key={alert.id} className={`shadow-none ${alert.status === "firing" ? "border-destructive/50" : ""}`}>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <CardTitle className="text-base">{alert.workspaceName}</CardTitle>
                        {alertStatusBadge(alert.status)}
                      </div>
                      {alert.status === "firing" && (
                        <Button variant="outline" size="sm" onClick={() => acknowledgeAlert(alert.id)}>
                          Acknowledge
                        </Button>
                      )}
                    </div>
                    <CardDescription>{alert.message}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="flex gap-6 text-sm text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <AlertTriangle className="size-3" />
                        Type: <span className="font-medium text-foreground capitalize">{alert.type.replace("_", " ")}</span>
                      </span>
                      <span className="flex items-center gap-1">
                        <Activity className="size-3" />
                        Value: <span className="font-medium text-foreground">{alert.currentValue.toFixed(1)}</span>
                        {" / Threshold: "}
                        <span className="font-medium text-foreground">{alert.threshold}</span>
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock className="size-3" />
                        Fired: {formatTimestamp(alert.firedAt)}
                      </span>
                      {alert.resolvedAt && (
                        <span>Resolved: {formatTimestamp(alert.resolvedAt)}</span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* ── Workspace Detail Dialog ──────────────────────────────── */}
      <Dialog open={!!detailId} onOpenChange={(open) => { if (!open) setDetailId(null); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Workspace SLA Detail</DialogTitle>
            <DialogDescription>
              Latency and error rate timeline for {detailData?.summary.workspaceName ?? "this workspace"}.
            </DialogDescription>
          </DialogHeader>

          {detailLoading ? (
            <LoadingState message="Loading detail..." />
          ) : detailError ? (
            <ErrorBanner message={friendlyError(detailError)} />
          ) : detailData ? (
            <div className="space-y-6">
              {/* Summary stats */}
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <div>
                  <span className="text-sm text-muted-foreground">P50 Latency</span>
                  <p className="text-lg font-semibold">{detailData.summary.latencyP50Ms}ms</p>
                </div>
                <div>
                  <span className="text-sm text-muted-foreground">P95 Latency</span>
                  <p className="text-lg font-semibold">{detailData.summary.latencyP95Ms}ms</p>
                </div>
                <div>
                  <span className="text-sm text-muted-foreground">P99 Latency</span>
                  <p className="text-lg font-semibold">{detailData.summary.latencyP99Ms}ms</p>
                </div>
                <div>
                  <span className="text-sm text-muted-foreground">Error Rate</span>
                  <p className="text-lg font-semibold">{detailData.summary.errorRatePct.toFixed(1)}%</p>
                </div>
              </div>

              {/* Latency chart */}
              {detailData.latencyTimeline.length > 0 && (
                <Card className="shadow-none">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium">P99 Latency (hourly)</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <RechartsLine
                      data={detailData.latencyTimeline.map((p) => ({ name: formatHour(p.timestamp), value: p.value }))}
                      dataKey="P99 Latency"
                      color="hsl(var(--primary))"
                      unit="ms"
                    />
                  </CardContent>
                </Card>
              )}

              {/* Error rate chart */}
              {detailData.errorTimeline.length > 0 && (
                <Card className="shadow-none">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium">Error Rate (hourly)</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <RechartsLine
                      data={detailData.errorTimeline.map((p) => ({ name: formatHour(p.timestamp), value: p.value }))}
                      dataKey="Error Rate"
                      color="hsl(var(--destructive))"
                      unit="%"
                    />
                  </CardContent>
                </Card>
              )}

              {detailData.latencyTimeline.length === 0 && detailData.errorTimeline.length === 0 && (
                <p className="text-center text-sm text-muted-foreground py-6">
                  No time-series data available for this window.
                </p>
              )}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* ── Threshold Configuration Dialog ───────────────────────── */}
      <Dialog open={thresholdDialogOpen} onOpenChange={(open) => { if (!open) { setThresholdDialogOpen(false); clearThresholdError(); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Alert Thresholds</DialogTitle>
            <DialogDescription>
              Configure the default SLA alert thresholds. Alerts fire when metrics exceed these values.
            </DialogDescription>
          </DialogHeader>
          {thresholdError && <ErrorBanner message={thresholdError} />}
          {editThresholds && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="latency">P99 Latency Threshold (ms)</Label>
                <Input
                  id="latency"
                  type="number"
                  min={0}
                  value={editThresholds.latencyP99Ms}
                  onChange={(e) => setEditThresholds({ ...editThresholds, latencyP99Ms: parseFloat(e.target.value) || 0 })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="errorRate">Error Rate Threshold (%)</Label>
                <Input
                  id="errorRate"
                  type="number"
                  min={0}
                  max={100}
                  step={0.1}
                  value={editThresholds.errorRatePct}
                  onChange={(e) => setEditThresholds({ ...editThresholds, errorRatePct: parseFloat(e.target.value) || 0 })}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setThresholdDialogOpen(false); clearThresholdError(); }}>Cancel</Button>
            <Button onClick={saveThresholds} disabled={thresholdSaving}>
              {thresholdSaving ? <><Loader2 className="mr-2 size-4 animate-spin" />Saving...</> : "Save Thresholds"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </AdminContentWrapper>
  );
}
