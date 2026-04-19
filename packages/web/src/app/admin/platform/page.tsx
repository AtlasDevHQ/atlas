"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { parseAsString, parseAsStringEnum, useQueryState } from "nuqs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { usePlatformAdminGuard } from "@/ui/hooks/use-platform-admin-guard";
import { StatCard } from "@/ui/components/admin/stat-card";
import { useAdminFetch, friendlyError, useInProgressSet } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import {
  PlatformStatsSchema,
  PlatformWorkspacesResponseSchema,
  PlatformNeighborsResponseSchema,
  PlatformWorkspaceDetailResponseSchema,
} from "@/ui/lib/admin-schemas";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  Building2,
  Users,
  Search,
  DollarSign,
  Activity,
  AlertTriangle,
  Pause,
  Play,
  Trash2,
  ArrowUpDown,
  Loader2,
  Eye,
} from "lucide-react";
import type {
  PlatformWorkspace,
  WorkspaceStatus,
  PlanTier,
} from "@/ui/lib/types";
import { WORKSPACE_STATUSES, PLAN_TIERS } from "@/ui/lib/types";
import { formatDate } from "@/lib/format";

// Dynamic import for Recharts (heavy dependency)
const RechartsBar = dynamic(
  () => import("recharts").then((mod) => {
    const { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } = mod;
    return {
      default: function UsageChart({ data }: { data: Array<{ name: string; queries: number }> }) {
        return (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" />
              <YAxis />
              <Tooltip />
              <Bar dataKey="queries" fill="hsl(var(--primary))" />
            </BarChart>
          </ResponsiveContainer>
        );
      },
    };
  }),
  { ssr: false, loading: () => <div className="h-[300px] animate-pulse rounded bg-muted" /> },
);

// ── Types ─────────────────────────────────────────────────────────

type SortField = "name" | "planTier" | "status" | "queriesLast24h" | "members" | "createdAt";
type SortDir = "asc" | "desc";

// ── Helpers ───────────────────────────────────────────────────────

function statusBadge(status: WorkspaceStatus) {
  switch (status) {
    case "active":
      return <Badge variant="outline" className="gap-1 border-green-500 text-green-600">Active</Badge>;
    case "suspended":
      return <Badge variant="outline" className="gap-1 border-amber-500 text-amber-600">Suspended</Badge>;
    case "deleted":
      return <Badge variant="secondary" className="gap-1">Deleted</Badge>;
  }
}

function planBadge(tier: PlanTier) {
  switch (tier) {
    case "free":
      return <Badge variant="secondary">Free</Badge>;
    case "trial":
      return <Badge variant="outline" className="border-primary/50 text-primary">Trial</Badge>;
    case "starter":
      return <Badge variant="outline" className="border-green-500 text-green-600">Starter</Badge>;
    case "pro":
      return <Badge variant="outline" className="border-purple-500 text-purple-600">Pro</Badge>;
    case "business":
      return <Badge variant="outline" className="border-amber-500 text-amber-600">Business</Badge>;
  }
}

// ── Main Page ─────────────────────────────────────────────────────

export default function PlatformAdminPage() {
  const { blocked } = usePlatformAdminGuard();
  if (blocked) return <LoadingState message="Checking access..." />;
  return (
    <ErrorBoundary>
      <PlatformPageContent />
    </ErrorBoundary>
  );
}

function PlatformPageContent() {
  // URL state
  const [search, setSearch] = useQueryState("q", parseAsString.withDefault(""));
  const [statusFilter, setStatusFilter] = useQueryState("status", parseAsStringEnum(["all", ...WORKSPACE_STATUSES]).withDefault("all"));
  const [planFilter, setPlanFilter] = useQueryState("plan", parseAsStringEnum(["all", ...PLAN_TIERS]).withDefault("all"));
  const [tab, setTab] = useQueryState("tab", parseAsStringEnum(["dashboard", "workspaces", "neighbors"]).withDefault("dashboard"));

  // Sorting
  const [sortField, setSortField] = useState<SortField>("createdAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Data
  const { data: stats, loading: statsLoading, error: statsError } = useAdminFetch(
    "/api/v1/platform/stats",
    { schema: PlatformStatsSchema },
  );
  const { data: wsData, loading: wsLoading, error: wsError, refetch: refetchWorkspaces } = useAdminFetch(
    "/api/v1/platform/workspaces",
    { schema: PlatformWorkspacesResponseSchema },
  );
  const { data: neighborsData, loading: neighborsLoading, error: neighborsError } = useAdminFetch(
    "/api/v1/platform/noisy-neighbors",
    { schema: PlatformNeighborsResponseSchema },
  );

  // Workspace detail dialog
  const [detailId, setDetailId] = useState<string | null>(null);
  const { data: detailData, loading: detailLoading, error: detailError } = useAdminFetch(
    detailId ? `/api/v1/platform/workspaces/${detailId}` : "",
    { schema: PlatformWorkspaceDetailResponseSchema, deps: [detailId] },
  );

  // Confirmation dialog
  const [confirmAction, setConfirmAction] = useState<{ type: "suspend" | "unsuspend" | "delete" | "purge"; workspace: PlatformWorkspace } | null>(null);
  const [purgeConfirmName, setPurgeConfirmName] = useState("");
  const inProgress = useInProgressSet();
  const { mutate: actionMutate, error: actionError, clearError: clearActionError } = useAdminMutation({
    invalidates: refetchWorkspaces,
  });
  const { mutate: planMutate, error: planError, clearError: clearPlanError } = useAdminMutation({
    method: "PATCH",
    invalidates: refetchWorkspaces,
  });

  // Plan change dialog
  const [planChange, setPlanChange] = useState<{ workspace: PlatformWorkspace; newTier: PlanTier } | null>(null);

  // ── Filtering & sorting ──────────────────────────────────────────

  const workspaces = wsData?.workspaces ?? [];
  const filtered = workspaces
    .filter((ws) => {
      if (statusFilter !== "all" && ws.status !== statusFilter) return false;
      if (planFilter !== "all" && ws.planTier !== planFilter) return false;
      if (search && !ws.name.toLowerCase().includes(search.toLowerCase()) && !ws.slug.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    })
    .toSorted((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;
      switch (sortField) {
        case "name": return dir * a.name.localeCompare(b.name);
        case "planTier": return dir * a.planTier.localeCompare(b.planTier);
        case "status": return dir * a.status.localeCompare(b.status);
        case "queriesLast24h": return dir * (a.queriesLast24h - b.queriesLast24h);
        case "members": return dir * (a.members - b.members);
        case "createdAt": return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        default: return 0;
      }
    });

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  }

  // ── Actions ──────────────────────────────────────────────────────

  async function executeAction(type: "suspend" | "unsuspend" | "delete" | "purge", workspaceId: string) {
    clearActionError();
    inProgress.start(workspaceId);

    const method = type === "delete" ? "DELETE" : "POST";
    const path = type === "delete"
      ? `/api/v1/platform/workspaces/${workspaceId}`
      : `/api/v1/platform/workspaces/${workspaceId}/${type}`;

    const result = await actionMutate({ path, method });
    if (result.ok) {
      setConfirmAction(null);
      setPurgeConfirmName("");
    }
    inProgress.stop(workspaceId);
  }

  async function executePlanChange(workspaceId: string, planTier: PlanTier) {
    clearPlanError();
    inProgress.start(workspaceId);

    const result = await planMutate({
      path: `/api/v1/platform/workspaces/${workspaceId}/plan`,
      body: { planTier },
    });
    if (result.ok) {
      setPlanChange(null);
    }
    inProgress.stop(workspaceId);
  }

  // ── Chart data ───────────────────────────────────────────────────

  const topWorkspaces = workspaces
    .toSorted((a, b) => b.queriesLast24h - a.queriesLast24h)
    .slice(0, 10)
    .map((ws) => ({ name: ws.name.length > 15 ? ws.name.slice(0, 15) + "..." : ws.name, queries: ws.queriesLast24h }));

  // ── Render ───────────────────────────────────────────────────────

  if (statsError && wsError) {
    return <ErrorBanner message={friendlyError(statsError)} />;
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Platform Admin</h1>
        <p className="text-muted-foreground">Cross-tenant management console for platform operators.</p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "dashboard" | "workspaces" | "neighbors")}>
        <TabsList>
          <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
          <TabsTrigger value="workspaces">Workspaces</TabsTrigger>
          <TabsTrigger value="neighbors">
            Noisy Neighbors
            {neighborsData && neighborsData.neighbors.length > 0 && (
              <Badge variant="destructive" className="ml-2">{neighborsData.neighbors.length}</Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* ── Dashboard Tab ─────────────────────────────────────── */}
        <TabsContent value="dashboard" className="space-y-6">
          {statsLoading ? (
            <LoadingState message="Loading platform stats..." />
          ) : statsError ? (
            <ErrorBanner message={friendlyError(statsError)} />
          ) : stats ? (
            <>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                <StatCard
                  title="Workspaces"
                  value={stats.totalWorkspaces}
                  icon={<Building2 className="size-4" />}
                  description={`${stats.activeWorkspaces} active, ${stats.suspendedWorkspaces} suspended`}
                />
                <StatCard
                  title="Active Users"
                  value={stats.totalUsers}
                  icon={<Users className="size-4" />}
                />
                <StatCard
                  title="Queries (24h)"
                  value={stats.totalQueries24h.toLocaleString()}
                  icon={<Activity className="size-4" />}
                />
                <StatCard
                  title="MRR"
                  value={`$${stats.mrr.toLocaleString()}`}
                  icon={<DollarSign className="size-4" />}
                />
              </div>

              {topWorkspaces.length > 0 && (
                <Card className="shadow-none">
                  <CardHeader>
                    <CardTitle>Top Workspaces by Queries (24h)</CardTitle>
                    <CardDescription>Most active workspaces in the last 24 hours.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <RechartsBar data={topWorkspaces} />
                  </CardContent>
                </Card>
              )}
            </>
          ) : null}
        </TabsContent>

        {/* ── Workspaces Tab ────────────────────────────────────── */}
        <TabsContent value="workspaces" className="space-y-4">
          <div className="flex items-center gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input
                placeholder="Search workspaces..."
                value={search}
                onChange={(e) => setSearch(e.target.value || null)}
                className="pl-8"
              />
            </div>
            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as WorkspaceStatus | "all")}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="suspended">Suspended</SelectItem>
                <SelectItem value="deleted">Deleted</SelectItem>
              </SelectContent>
            </Select>
            <Select value={planFilter} onValueChange={(v) => setPlanFilter(v as PlanTier | "all")}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="Plan" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All plans</SelectItem>
                <SelectItem value="free">Free</SelectItem>
                <SelectItem value="trial">Trial</SelectItem>
                <SelectItem value="starter">Starter</SelectItem>
                <SelectItem value="pro">Pro</SelectItem>
                <SelectItem value="business">Business</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {wsLoading ? (
            <LoadingState message="Loading workspaces..." />
          ) : wsError ? (
            <ErrorBanner message={friendlyError(wsError)} />
          ) : (
            <Card className="shadow-none">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      <Button variant="ghost" size="sm" onClick={() => toggleSort("name")} className="gap-1">
                        Name <ArrowUpDown className="size-3" />
                      </Button>
                    </TableHead>
                    <TableHead>
                      <Button variant="ghost" size="sm" onClick={() => toggleSort("planTier")} className="gap-1">
                        Plan <ArrowUpDown className="size-3" />
                      </Button>
                    </TableHead>
                    <TableHead>
                      <Button variant="ghost" size="sm" onClick={() => toggleSort("status")} className="gap-1">
                        Status <ArrowUpDown className="size-3" />
                      </Button>
                    </TableHead>
                    <TableHead>
                      <Button variant="ghost" size="sm" onClick={() => toggleSort("members")} className="gap-1">
                        Members <ArrowUpDown className="size-3" />
                      </Button>
                    </TableHead>
                    <TableHead>
                      <Button variant="ghost" size="sm" onClick={() => toggleSort("queriesLast24h")} className="gap-1">
                        Queries (24h) <ArrowUpDown className="size-3" />
                      </Button>
                    </TableHead>
                    <TableHead>
                      <Button variant="ghost" size="sm" onClick={() => toggleSort("createdAt")} className="gap-1">
                        Created <ArrowUpDown className="size-3" />
                      </Button>
                    </TableHead>
                    <TableHead>Region</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                        No workspaces found.
                      </TableCell>
                    </TableRow>
                  ) : (
                    filtered.map((ws) => (
                      <TableRow key={ws.id}>
                        <TableCell className="font-medium">{ws.name}</TableCell>
                        <TableCell>{planBadge(ws.planTier as PlanTier)}</TableCell>
                        <TableCell>{statusBadge(ws.status as WorkspaceStatus)}</TableCell>
                        <TableCell>{ws.members}</TableCell>
                        <TableCell>{ws.queriesLast24h.toLocaleString()}</TableCell>
                        <TableCell>{formatDate(ws.createdAt)}</TableCell>
                        <TableCell>
                          {ws.region ? (
                            <Badge variant="outline" className="text-xs">{ws.region}</Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button variant="ghost" size="icon" onClick={() => setDetailId(ws.id)} title="View details">
                              <Eye className="size-4" />
                            </Button>
                            {ws.status === "active" && (
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => setConfirmAction({ type: "suspend", workspace: ws })}
                                title="Suspend"
                                disabled={inProgress.has(ws.id)}
                              >
                                {inProgress.has(ws.id) ? <Loader2 className="size-4 animate-spin" /> : <Pause className="size-4" />}
                              </Button>
                            )}
                            {ws.status === "suspended" && (
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => setConfirmAction({ type: "unsuspend", workspace: ws })}
                                title="Unsuspend"
                                disabled={inProgress.has(ws.id)}
                              >
                                {inProgress.has(ws.id) ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                              </Button>
                            )}
                            {ws.status !== "deleted" && (
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => setConfirmAction({ type: "delete", workspace: ws })}
                                title="Delete"
                                disabled={inProgress.has(ws.id)}
                                className="text-destructive hover:text-destructive"
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            )}
                            {ws.status === "deleted" && (
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => setConfirmAction({ type: "purge", workspace: ws })}
                                title="Purge all data (GDPR)"
                                disabled={inProgress.has(ws.id)}
                                className="text-destructive hover:text-destructive"
                              >
                                {inProgress.has(ws.id) ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </Card>
          )}
        </TabsContent>

        {/* ── Noisy Neighbors Tab ──────────────────────────────── */}
        <TabsContent value="neighbors" className="space-y-4">
          {neighborsLoading ? (
            <LoadingState message="Analyzing resource usage..." />
          ) : neighborsError ? (
            <ErrorBanner message={friendlyError(neighborsError)} />
          ) : neighborsData && neighborsData.neighbors.length === 0 ? (
            <Card className="shadow-none">
              <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Activity className="mb-2 size-8" />
                <p>No noisy neighbors detected. Resource usage is balanced.</p>
              </CardContent>
            </Card>
          ) : neighborsData ? (
            <>
              <div className="grid gap-4 md:grid-cols-3">
                <StatCard
                  title="Median Queries (monthly)"
                  value={neighborsData.medians.queries.toLocaleString()}
                  icon={<Activity className="size-4" />}
                />
                <StatCard
                  title="Median Tokens (monthly)"
                  value={neighborsData.medians.tokens.toLocaleString()}
                  icon={<Activity className="size-4" />}
                />
                <StatCard
                  title="Median Storage (bytes)"
                  value={neighborsData.medians.storage.toLocaleString()}
                  icon={<Activity className="size-4" />}
                />
              </div>

              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {neighborsData.neighbors.map((n, i) => (
                  <Card key={`${n.workspaceId}-${n.metric}-${i}`} className="shadow-none border-amber-200 dark:border-amber-800">
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-base">{n.workspaceName}</CardTitle>
                        <AlertTriangle className="size-4 text-amber-500" />
                      </div>
                      <CardDescription>{planBadge(n.planTier as PlanTier)}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-1 text-sm">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Metric:</span>
                          <span className="font-medium capitalize">{n.metric}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Value:</span>
                          <span className="font-medium">{n.value.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Median:</span>
                          <span>{n.median.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Ratio:</span>
                          <Badge variant="destructive">{n.ratio}x</Badge>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </>
          ) : null}
        </TabsContent>
      </Tabs>

      {/* ── Workspace Detail Dialog ──────────────────────────────── */}
      <Dialog open={!!detailId} onOpenChange={(open) => { if (!open) setDetailId(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Workspace Details</DialogTitle>
            <DialogDescription>Resource breakdown and user list for this workspace.</DialogDescription>
          </DialogHeader>

          {detailLoading ? (
            <LoadingState message="Loading details..." />
          ) : detailError ? (
            <ErrorBanner message={friendlyError(detailError)} />
          ) : detailData ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <span className="text-sm text-muted-foreground">Name</span>
                  <p className="font-medium">{detailData.workspace.name}</p>
                </div>
                <div>
                  <span className="text-sm text-muted-foreground">Slug</span>
                  <p className="font-medium">{detailData.workspace.slug}</p>
                </div>
                <div>
                  <span className="text-sm text-muted-foreground">Status</span>
                  <p>{statusBadge(detailData.workspace.status as WorkspaceStatus)}</p>
                </div>
                <div>
                  <span className="text-sm text-muted-foreground">Plan</span>
                  <div className="flex items-center gap-2">
                    {planBadge(detailData.workspace.planTier as PlanTier)}
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={() => setPlanChange({
                        workspace: detailData.workspace,
                        newTier: detailData.workspace.planTier as PlanTier,
                      })}
                    >
                      Change
                    </Button>
                  </div>
                </div>
                <div>
                  <span className="text-sm text-muted-foreground">Members</span>
                  <p className="font-medium">{detailData.workspace.members}</p>
                </div>
                <div>
                  <span className="text-sm text-muted-foreground">Conversations</span>
                  <p className="font-medium">{detailData.workspace.conversations}</p>
                </div>
                <div>
                  <span className="text-sm text-muted-foreground">Queries (24h)</span>
                  <p className="font-medium">{detailData.workspace.queriesLast24h.toLocaleString()}</p>
                </div>
                <div>
                  <span className="text-sm text-muted-foreground">Connections</span>
                  <p className="font-medium">{detailData.workspace.connections}</p>
                </div>
                <div>
                  <span className="text-sm text-muted-foreground">Region</span>
                  <p className="font-medium">{detailData.workspace.region ?? "Not assigned"}</p>
                </div>
              </div>

              {detailData.users.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-medium">Users</h3>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Email</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead>Joined</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detailData.users.map((u) => (
                        <TableRow key={u.id}>
                          <TableCell>{u.name}</TableCell>
                          <TableCell className="text-muted-foreground">{u.email}</TableCell>
                          <TableCell><Badge variant="secondary">{u.role}</Badge></TableCell>
                          <TableCell>{formatDate(u.createdAt)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* ── Confirm Action Dialog ────────────────────────────────── */}
      <Dialog open={!!confirmAction} onOpenChange={(open) => { if (!open) { setConfirmAction(null); clearActionError(); setPurgeConfirmName(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmAction?.type === "suspend" && "Suspend Workspace"}
              {confirmAction?.type === "unsuspend" && "Unsuspend Workspace"}
              {confirmAction?.type === "delete" && "Delete Workspace"}
              {confirmAction?.type === "purge" && "Purge All Data (GDPR)"}
            </DialogTitle>
            <DialogDescription>
              {confirmAction?.type === "suspend" && `This will suspend "${confirmAction.workspace.name}", preventing all user access until reactivated.`}
              {confirmAction?.type === "unsuspend" && `This will reactivate "${confirmAction.workspace.name}", restoring user access.`}
              {confirmAction?.type === "delete" && `This will permanently delete "${confirmAction.workspace.name}" and cascade-remove all conversations, semantic entities, learned patterns, suggestions, and scheduled tasks. This action cannot be undone.`}
              {confirmAction?.type === "purge" && `This will permanently and irreversibly remove ALL data for "${confirmAction.workspace.name}" — conversations, messages, audit logs, integrations, connections, members, and orphaned user accounts. This cannot be undone.`}
            </DialogDescription>
          </DialogHeader>
          {confirmAction?.type === "purge" && (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Type <span className="font-mono font-semibold text-foreground">{confirmAction.workspace.name}</span> to confirm.
              </p>
              <Input
                value={purgeConfirmName}
                onChange={(e) => setPurgeConfirmName(e.target.value)}
                placeholder="Workspace name"
              />
            </div>
          )}
          {actionError && <ErrorBanner message={friendlyError(actionError)} />}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setConfirmAction(null); clearActionError(); setPurgeConfirmName(""); }}>Cancel</Button>
            <Button
              variant={confirmAction?.type === "delete" || confirmAction?.type === "purge" ? "destructive" : "default"}
              onClick={() => confirmAction && executeAction(confirmAction.type, confirmAction.workspace.id)}
              disabled={
                (confirmAction ? inProgress.has(confirmAction.workspace.id) : false) ||
                (confirmAction?.type === "purge" && purgeConfirmName !== confirmAction.workspace.name)
              }
            >
              {confirmAction && inProgress.has(confirmAction.workspace.id) ? (
                <><Loader2 className="mr-2 size-4 animate-spin" />Processing...</>
              ) : (
                <>
                  {confirmAction?.type === "suspend" && "Suspend"}
                  {confirmAction?.type === "unsuspend" && "Unsuspend"}
                  {confirmAction?.type === "delete" && "Delete"}
                  {confirmAction?.type === "purge" && "Purge All Data"}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Change Plan Dialog ───────────────────────────────────── */}
      <Dialog open={!!planChange} onOpenChange={(open) => { if (!open) { setPlanChange(null); clearPlanError(); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change Plan Tier</DialogTitle>
            <DialogDescription>
              Update the plan tier for &quot;{planChange?.workspace.name}&quot;.
            </DialogDescription>
          </DialogHeader>
          {planError && <ErrorBanner message={friendlyError(planError)} />}
          <Select
            value={planChange?.newTier ?? "free"}
            onValueChange={(v) => planChange && setPlanChange({ ...planChange, newTier: v as PlanTier })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select plan" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="free">Free</SelectItem>
              <SelectItem value="trial">Trial</SelectItem>
              <SelectItem value="starter">Starter</SelectItem>
              <SelectItem value="pro">Pro</SelectItem>
              <SelectItem value="business">Business</SelectItem>
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setPlanChange(null); clearPlanError(); }}>Cancel</Button>
            <Button
              onClick={() => planChange && executePlanChange(planChange.workspace.id, planChange.newTier)}
              disabled={planChange ? inProgress.has(planChange.workspace.id) : false}
            >
              {planChange && inProgress.has(planChange.workspace.id) ? (
                <><Loader2 className="mr-2 size-4 animate-spin" />Updating...</>
              ) : (
                "Update Plan"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
