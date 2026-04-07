"use client";

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
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { usePlatformAdminGuard } from "@/ui/hooks/use-platform-admin-guard";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  ChevronLeft,
  ChevronRight,
  ClipboardList,
} from "lucide-react";
import { useState } from "react";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const AdminActionSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  actorId: z.string(),
  actorEmail: z.string(),
  scope: z.enum(["platform", "workspace"]),
  orgId: z.string().nullable(),
  actionType: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  status: z.enum(["success", "failure"]),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  ipAddress: z.string().nullable(),
  requestId: z.string(),
});

const ActionsResponseSchema = z.object({
  actions: z.array(AdminActionSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

type AdminAction = z.infer<typeof AdminActionSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function scopeBadge(scope: string) {
  return scope === "platform"
    ? <Badge variant="outline" className="text-xs">Platform</Badge>
    : <Badge variant="secondary" className="text-xs">Workspace</Badge>;
}

function statusBadge(status: string) {
  return status === "success"
    ? <Badge variant="outline" className="gap-1 border-green-500 text-green-600 text-xs">Success</Badge>
    : <Badge variant="destructive" className="gap-1 text-xs">Failure</Badge>;
}

function metadataPreview(metadata: Record<string, unknown> | null): string {
  if (!metadata) return "—";
  const entries = Object.entries(metadata).slice(0, 3);
  return entries.map(([k, v]) => `${k}: ${String(v)}`).join(", ");
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const PAGE_SIZE = 50;

function ActionsPageContent() {
  const [offset, setOffset] = useState(0);

  const { data, loading, error, refetch } = useAdminFetch(
    `/api/v1/platform/actions?limit=${PAGE_SIZE}&offset=${offset}`,
    { schema: ActionsResponseSchema },
  );

  const actions: AdminAction[] = data?.actions ?? [];
  const total = data?.total ?? 0;
  const hasNext = offset + PAGE_SIZE < total;
  const hasPrev = offset > 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Action Log</h2>
        <p className="text-muted-foreground">
          All admin actions across the platform. {total > 0 && `${total} total entries.`}
        </p>
      </div>

      <AdminContentWrapper
        loading={loading}
        error={error}
        feature="Action Log"
        onRetry={refetch}
        loadingMessage="Loading action log…"
        emptyIcon={ClipboardList}
        emptyTitle="No actions recorded"
        emptyDescription="Admin actions will appear here once platform or workspace mutations are performed."
        isEmpty={actions.length === 0}
      >
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[140px]">Timestamp</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {actions.map((action) => (
                <TableRow key={action.id}>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    {formatTimestamp(action.timestamp)}
                  </TableCell>
                  <TableCell className="text-sm">{action.actorEmail}</TableCell>
                  <TableCell>
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                      {action.actionType}
                    </code>
                  </TableCell>
                  <TableCell className="text-xs font-mono text-muted-foreground">
                    {action.targetType}/{action.targetId.slice(0, 8)}
                  </TableCell>
                  <TableCell>{scopeBadge(action.scope)}</TableCell>
                  <TableCell>{statusBadge(action.status)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                    {metadataPreview(action.metadata)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between pt-4">
            <p className="text-sm text-muted-foreground">
              Showing {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!hasPrev}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                <ChevronLeft className="size-4 mr-1" />
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!hasNext}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
                <ChevronRight className="size-4 ml-1" />
              </Button>
            </div>
          </div>
        )}
      </AdminContentWrapper>
    </div>
  );
}

export default function ActionsPage() {
  const { blocked } = usePlatformAdminGuard();
  if (blocked) return null;

  return (
    <ErrorBoundary>
      <ActionsPageContent />
    </ErrorBoundary>
  );
}
