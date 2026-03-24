"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  ShieldAlert,
  RotateCcw,
  Loader2,
  AlertTriangle,
  Activity,
  Settings2,
} from "lucide-react";
import type { AbuseStatus, AbuseThresholdConfig } from "@/ui/lib/types";

// ── Types ─────────────────────────────────────────────────────────

interface AbuseListResponse {
  workspaces: AbuseStatus[];
  total: number;
}

// ── Level badge colors ────────────────────────────────────────────

function levelBadge(level: string) {
  switch (level) {
    case "warning":
      return <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300">Warning</Badge>;
    case "throttled":
      return <Badge variant="outline" className="border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300">Throttled</Badge>;
    case "suspended":
      return <Badge variant="destructive">Suspended</Badge>;
    default:
      return <Badge variant="outline">None</Badge>;
  }
}

function triggerLabel(trigger: string | null) {
  switch (trigger) {
    case "query_rate": return "Excessive queries";
    case "error_rate": return "High error rate";
    case "unique_tables": return "Unusual table access";
    case "manual": return "Manual action";
    default: return "-";
  }
}

// ── Reinstate Dialog ──────────────────────────────────────────────

function ReinstateDialog({
  workspace,
  open,
  onOpenChange,
  onReinstated,
}: {
  workspace: AbuseStatus | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReinstated: () => void;
}) {
  const { mutate, saving: loading, error, reset } = useAdminMutation({
    method: "POST",
    invalidates: onReinstated,
  });

  function handleOpen(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleReinstate() {
    if (!workspace) return;
    const result = await mutate({
      path: `/api/v1/admin/abuse/${encodeURIComponent(workspace.workspaceId)}/reinstate`,
    });
    if (result.ok) {
      handleOpen(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reinstate Workspace</DialogTitle>
          <DialogDescription>
            This will clear the abuse flag and allow the workspace to resume normal operations.
          </DialogDescription>
        </DialogHeader>

        {workspace && (
          <div className="space-y-3 py-2">
            <div className="rounded-md bg-muted p-3">
              <p className="text-sm font-medium">{workspace.workspaceName ?? workspace.workspaceId}</p>
              <div className="mt-1 flex items-center gap-2">
                {levelBadge(workspace.level)}
                <span className="text-xs text-muted-foreground">{triggerLabel(workspace.trigger)}</span>
              </div>
              {workspace.message && (
                <p className="mt-1 text-xs text-muted-foreground">{workspace.message}</p>
              )}
            </div>

            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Reinstating resets all abuse counters for this workspace. If the abusive pattern continues, the workspace will be flagged again.
              </p>
            </div>

            {error && (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleReinstate} disabled={loading}>
            {loading && <Loader2 className="mr-1 size-3 animate-spin" />}
            Reinstate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Page ─────────────────────────────────────────────────────

export default function AbusePage() {
  const [reinstateTarget, setReinstateTarget] = useState<AbuseStatus | null>(null);

  const { data, loading, error, refetch } = useAdminFetch<AbuseListResponse>(
    "/api/v1/admin/abuse",
    { transform: (json) => json as AbuseListResponse },
  );

  const { data: config } = useAdminFetch<AbuseThresholdConfig>(
    "/api/v1/admin/abuse/config",
    { transform: (json) => json as AbuseThresholdConfig },
  );

  const workspaces = data?.workspaces ?? [];

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Abuse Prevention</h1>
          <p className="text-sm text-muted-foreground">
            Monitor anomalous query patterns and manage workspace suspensions
          </p>
        </div>
      </div>

      <ErrorBoundary>
        <div className="flex-1 overflow-auto p-6 space-y-6">
          {/* Threshold config summary */}
          {config && (
            <Card className="shadow-none">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Settings2 className="size-4" />
                  Detection Thresholds
                </CardTitle>
                <CardDescription>
                  Configure via environment variables. See the abuse prevention guide for details.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <div>
                    <p className="text-xs text-muted-foreground">Query Rate Limit</p>
                    <p className="text-sm font-medium">{config.queryRateLimit} / {config.queryRateWindowSeconds}s</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Error Rate Threshold</p>
                    <p className="text-sm font-medium">{(config.errorRateThreshold * 100).toFixed(0)}%</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Unique Tables Limit</p>
                    <p className="text-sm font-medium">{config.uniqueTablesLimit}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Throttle Delay</p>
                    <p className="text-sm font-medium">{config.throttleDelayMs}ms</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Flagged workspaces */}
          <AdminContentWrapper
            loading={loading}
            error={error}
            feature="Abuse Prevention"
            onRetry={refetch}
            loadingMessage="Loading abuse flags..."
            emptyIcon={ShieldAlert}
            emptyTitle="No workspaces flagged"
            emptyDescription="All workspaces are operating within normal parameters. Anomalous query patterns will be automatically detected and shown here."
            isEmpty={workspaces.length === 0}
          >
            <Card className="shadow-none">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Activity className="size-4" />
                  Flagged Workspaces
                </CardTitle>
                <CardDescription>
                  Workspaces with active abuse warnings, throttling, or suspensions.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Workspace</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Trigger</TableHead>
                      <TableHead>Details</TableHead>
                      <TableHead>Updated</TableHead>
                      <TableHead className="w-[80px]" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {workspaces.map((ws) => (
                      <TableRow key={ws.workspaceId}>
                        <TableCell className="font-mono text-sm">
                          {ws.workspaceName ?? ws.workspaceId}
                        </TableCell>
                        <TableCell>{levelBadge(ws.level)}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {triggerLabel(ws.trigger)}
                        </TableCell>
                        <TableCell className="max-w-[200px] truncate text-xs text-muted-foreground">
                          {ws.message ?? "-"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {new Date(ws.updatedAt).toLocaleString()}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => setReinstateTarget(ws)}
                          >
                            <RotateCcw className="mr-1 size-3" />
                            Reinstate
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </AdminContentWrapper>
        </div>
      </ErrorBoundary>

      <ReinstateDialog
        workspace={reinstateTarget}
        open={!!reinstateTarget}
        onOpenChange={(open) => !open && setReinstateTarget(null)}
        onReinstated={refetch}
      />
    </div>
  );
}
