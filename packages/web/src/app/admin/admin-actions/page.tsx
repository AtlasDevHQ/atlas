"use client";

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
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAtlasConfig } from "@/ui/context";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { RelativeTimestamp } from "@/ui/components/admin/queue";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Download,
  Search,
  X,
} from "lucide-react";
import { useState } from "react";
import { useQueryStates } from "nuqs";
import { z } from "zod";
import { adminActionsSearchParams } from "./search-params";

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
// Constants
// ---------------------------------------------------------------------------

const ACTION_TYPE_OPTIONS = [
  { value: "settings.update", label: "settings.update" },
  { value: "connection.create", label: "connection.create" },
  { value: "connection.update", label: "connection.update" },
  { value: "connection.delete", label: "connection.delete" },
  { value: "user.invite", label: "user.invite" },
  { value: "user.remove", label: "user.remove" },
  { value: "user.change_role", label: "user.change_role" },
  { value: "sso.configure", label: "sso.configure" },
  { value: "semantic.create_entity", label: "semantic.create_entity" },
  { value: "semantic.update_entity", label: "semantic.update_entity" },
  { value: "semantic.delete_entity", label: "semantic.delete_entity" },
  { value: "pattern.approve", label: "pattern.approve" },
  { value: "pattern.reject", label: "pattern.reject" },
  { value: "integration.enable", label: "integration.enable" },
  { value: "integration.disable", label: "integration.disable" },
  { value: "apikey.create", label: "apikey.create" },
  { value: "apikey.revoke", label: "apikey.revoke" },
];

const TARGET_TYPE_OPTIONS = [
  { value: "connection", label: "Connection" },
  { value: "user", label: "User" },
  { value: "settings", label: "Settings" },
  { value: "sso", label: "SSO" },
  { value: "semantic", label: "Semantic" },
  { value: "pattern", label: "Pattern" },
  { value: "integration", label: "Integration" },
  { value: "apikey", label: "API Key" },
  { value: "schedule", label: "Schedule" },
  { value: "approval", label: "Approval" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusBadge(status: string) {
  return status === "success"
    ? <Badge variant="outline" className="gap-1 border-green-500 text-green-600 text-xs">Success</Badge>
    : <Badge variant="destructive" className="gap-1 text-xs">Failure</Badge>;
}

function metadataPreview(metadata: Record<string, unknown> | null): string {
  if (!metadata) return "\u2014";
  const entries = Object.entries(metadata).slice(0, 3);
  return entries.map(([k, v]) => `${k}: ${String(v)}`).join(", ");
}

function buildFilterQueryString(params: Record<string, string>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) qs.set(k, v);
  }
  return qs.toString();
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const PAGE_SIZE = 50;

function AdminActionsPageContent() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [params, setParams] = useQueryStates(adminActionsSearchParams);
  const offset = (params.page - 1) * PAGE_SIZE;

  const filterQs = buildFilterQueryString({
    actor: params.actor,
    actionType: params.actionType,
    targetType: params.targetType,
    from: params.from,
    to: params.to,
    search: params.search,
  });

  const { data, loading, error, refetch } = useAdminFetch(
    `/api/v1/admin/admin-actions?limit=${PAGE_SIZE}&offset=${offset}${filterQs ? `&${filterQs}` : ""}`,
    { schema: ActionsResponseSchema },
  );

  const actions: AdminAction[] = data?.actions ?? [];
  const total = data?.total ?? 0;
  const hasNext = offset + PAGE_SIZE < total;
  const hasPrev = offset > 0;

  const hasFilters = !!(params.actor || params.actionType || params.targetType || params.from || params.to || params.search);

  function clearFilters() {
    setParams({ actor: "", actionType: "", targetType: "", from: "", to: "", search: "", page: 1 });
  }

  async function handleExport() {
    setExporting(true);
    setExportError(null);
    try {
      const exportQs = buildFilterQueryString({
        actor: params.actor,
        actionType: params.actionType,
        targetType: params.targetType,
        from: params.from,
        to: params.to,
        search: params.search,
      });
      const res = await fetch(
        `${apiUrl}/api/v1/admin/admin-actions/export${exportQs ? `?${exportQs}` : ""}`,
        { credentials },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `admin-actions-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Admin Action Log</h2>
          <p className="text-muted-foreground">
            Admin actions performed in this workspace. {total > 0 && `${total} total entries.`}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-9"
          onClick={handleExport}
          disabled={loading || exporting}
        >
          <Download className="mr-1.5 size-3.5" />
          {exporting ? "Exporting\u2026" : "Export CSV"}
        </Button>
      </div>

      {exportError && (
        <ErrorBanner
          message={exportError}
          onRetry={() => { setExportError(null); handleExport(); }}
        />
      )}

      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
          <Input
            placeholder="Search metadata..."
            value={params.search}
            onChange={(e) => setParams({ search: e.target.value, page: 1 })}
            className="h-9 pl-8"
          />
        </div>

        <Input
          placeholder="Actor email..."
          value={params.actor}
          onChange={(e) => setParams({ actor: e.target.value, page: 1 })}
          className="h-9 w-44"
        />

        <Select
          value={params.actionType || "__all__"}
          onValueChange={(v) => setParams({ actionType: v === "__all__" ? "" : v, page: 1 })}
        >
          <SelectTrigger className="h-9 w-48" aria-label="Filter by action type">
            <SelectValue placeholder="All action types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All action types</SelectItem>
            {ACTION_TYPE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={params.targetType || "__all__"}
          onValueChange={(v) => setParams({ targetType: v === "__all__" ? "" : v, page: 1 })}
        >
          <SelectTrigger className="h-9 w-40" aria-label="Filter by target type">
            <SelectValue placeholder="All targets" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All targets</SelectItem>
            {TARGET_TYPE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          type="date"
          value={params.from}
          onChange={(e) => setParams({ from: e.target.value, page: 1 })}
          className="h-9 w-36"
          aria-label="From date"
        />
        <Input
          type="date"
          value={params.to}
          onChange={(e) => setParams({ to: e.target.value, page: 1 })}
          className="h-9 w-36"
          aria-label="To date"
        />

        {hasFilters && (
          <Button variant="ghost" size="sm" className="h-9" onClick={clearFilters}>
            <X className="mr-1.5 size-3.5" />
            Clear
          </Button>
        )}
      </div>

      <AdminContentWrapper
        loading={loading}
        error={error}
        feature="Admin Action Log"
        onRetry={refetch}
        loadingMessage="Loading admin action log\u2026"
        emptyIcon={ClipboardList}
        emptyTitle="No admin actions recorded"
        emptyDescription="Admin actions will appear here once workspace mutations are performed."
        isEmpty={actions.length === 0}
        hasFilters={hasFilters}
        onClearFilters={clearFilters}
      >
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[140px]">Timestamp</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {actions.map((action) => (
                <TableRow key={action.id}>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    <RelativeTimestamp iso={action.timestamp} />
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
              Showing {offset + 1}\u2013{Math.min(offset + PAGE_SIZE, total)} of {total}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!hasPrev}
                onClick={() => setParams({ page: Math.max(1, params.page - 1) })}
              >
                <ChevronLeft className="size-4 mr-1" />
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!hasNext}
                onClick={() => setParams({ page: params.page + 1 })}
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

export default function AdminActionsPage() {
  return (
    <ErrorBoundary>
      <TooltipProvider>
        <AdminActionsPageContent />
      </TooltipProvider>
    </ErrorBoundary>
  );
}
