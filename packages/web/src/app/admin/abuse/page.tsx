"use client";

import { Fragment } from "react";
import { useQueryStates } from "nuqs";
import { z } from "zod";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { usePlatformAdminGuard } from "@/ui/hooks/use-platform-admin-guard";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { LoadingState } from "@/ui/components/admin/loading-state";
import {
  QueueFilterRow,
  RelativeTimestamp,
} from "@/ui/components/admin/queue";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Settings2,
  ShieldAlert,
} from "lucide-react";
import type { AbuseStatus } from "@/ui/lib/types";
import { AbuseStatusSchema, AbuseThresholdConfigSchema } from "@/ui/lib/admin-schemas";
import { abuseSearchParams } from "./search-params";
import { AbuseDetailPanel } from "./detail-panel";
import { levelBadge, triggerLabel } from "./helpers";

// ── Schemas ───────────────────────────────────────────────────────

const AbuseListResponseSchema = z.object({
  workspaces: z.array(AbuseStatusSchema),
  total: z.number(),
});

type LevelFilter = "all" | "warning" | "throttled" | "suspended";

const FILTER_OPTIONS: { value: LevelFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "warning", label: "Warning" },
  { value: "throttled", label: "Throttled" },
  { value: "suspended", label: "Suspended" },
];

// ── Main Page ─────────────────────────────────────────────────────

export default function AbusePage() {
  return (
    <ErrorBoundary>
      <TooltipProvider>
        <AbusePageContent />
      </TooltipProvider>
    </ErrorBoundary>
  );
}

function AbusePageContent() {
  const { blocked } = usePlatformAdminGuard();
  const [{ level: levelFilter, expanded: expandedId }, setParams] = useQueryStates(
    abuseSearchParams,
  );

  const { data, loading, error, refetch } = useAdminFetch(
    "/api/v1/admin/abuse",
    { schema: AbuseListResponseSchema },
  );

  const { data: config } = useAdminFetch(
    "/api/v1/admin/abuse/config",
    { schema: AbuseThresholdConfigSchema },
  );

  const workspaces: AbuseStatus[] = data?.workspaces ?? [];
  const filtered =
    levelFilter === "all"
      ? workspaces
      : workspaces.filter((w) => w.level === levelFilter);

  if (blocked) {
    return <LoadingState message="Checking access..." />;
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Abuse Prevention</h1>
        <p className="text-sm text-muted-foreground">
          Monitor anomalous query patterns and manage workspace suspensions.
        </p>
      </div>

      <div className="space-y-6">
        {/* Threshold config summary — env-only, read-only. */}
        {config && (
          <Card className="shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Settings2 className="size-4" />
                Detection Thresholds
              </CardTitle>
              <CardDescription>
                Configured via environment variables. See the abuse prevention guide for details.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div>
                  <p className="text-xs text-muted-foreground">Query Rate Limit</p>
                  <p className="text-sm font-medium">
                    {config.queryRateLimit} / {config.queryRateWindowSeconds}s
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Error Rate Threshold</p>
                  <p className="text-sm font-medium">
                    {(config.errorRateThreshold * 100).toFixed(0)}%
                  </p>
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
        <div className="space-y-3">
          <QueueFilterRow
            options={FILTER_OPTIONS}
            value={levelFilter}
            onChange={(next) => setParams({ level: next, expanded: null })}
          />

          <AdminContentWrapper
            loading={loading}
            error={error}
            feature="Abuse Prevention"
            onRetry={refetch}
            loadingMessage="Loading abuse flags..."
            emptyIcon={ShieldAlert}
            emptyTitle={
              levelFilter === "all"
                ? "No workspaces flagged"
                : `No workspaces at level ${levelFilter}`
            }
            emptyDescription={
              levelFilter === "all"
                ? "All workspaces are operating within normal parameters. Anomalous query patterns will be automatically detected and shown here."
                : "Try a different filter, or switch to All to see other flagged workspaces."
            }
            isEmpty={filtered.length === 0}
          >
            <Card className="shadow-none">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Activity className="size-4" />
                  Flagged Workspaces
                </CardTitle>
                <CardDescription>
                  Click a row to open the investigation panel. Reinstate from the panel footer
                  after reviewing counters and timeline.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-6" />
                        <TableHead>Workspace</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Trigger</TableHead>
                        <TableHead>Details</TableHead>
                        <TableHead>Updated</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filtered.map((ws) => {
                        const isExpanded = expandedId === ws.workspaceId;
                        return (
                          <Fragment key={ws.workspaceId}>
                            <TableRow
                              className="cursor-pointer"
                              onClick={() =>
                                setParams({
                                  expanded: isExpanded ? null : ws.workspaceId,
                                })
                              }
                              aria-expanded={isExpanded}
                            >
                              <TableCell>
                                {isExpanded ? (
                                  <ChevronDown className="size-4 text-muted-foreground" />
                                ) : (
                                  <ChevronRight className="size-4 text-muted-foreground" />
                                )}
                              </TableCell>
                              <TableCell className="font-mono text-sm">
                                {ws.workspaceName ?? ws.workspaceId}
                              </TableCell>
                              <TableCell>{levelBadge(ws.level)}</TableCell>
                              <TableCell className="text-sm text-muted-foreground">
                                {triggerLabel(ws.trigger)}
                              </TableCell>
                              <TableCell className="max-w-[260px] truncate text-xs text-muted-foreground">
                                {ws.message ?? "—"}
                              </TableCell>
                              <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                                <RelativeTimestamp iso={ws.updatedAt} />
                              </TableCell>
                            </TableRow>
                            {isExpanded && (
                              <TableRow>
                                <TableCell colSpan={6} className="bg-muted/30 p-4">
                                  <AbuseDetailPanel
                                    workspaceId={ws.workspaceId}
                                    onReinstated={refetch}
                                  />
                                </TableCell>
                              </TableRow>
                            )}
                          </Fragment>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </AdminContentWrapper>
        </div>
      </div>
    </div>
  );
}
