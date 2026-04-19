"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { useQueryStates } from "nuqs";
import { actionsSearchParams } from "./search-params";
import { actionTypeIcon, actionTypeLabel } from "./labels";
import { DenyActionDialog } from "./deny-dialog";
import { useAtlasConfig } from "@/ui/context";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ActionStatusBadge } from "@/ui/components/actions/action-status-badge";
import type { ActionDisplayStatus } from "@/ui/lib/action-types";
import type { ActionLogEntry } from "@/ui/lib/types";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { EmptyState } from "@/ui/components/admin/empty-state";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import {
  Zap,
  Check,
  X,
  Loader2,
  MessageSquare,
  CheckCheck,
  XCircle,
  Inbox,
  Undo2,
} from "lucide-react";
import type { FetchError } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBoundary } from "@/ui/components/error-boundary";

type StatusFilter = "pending" | "executed" | "denied" | "failed" | "rolled_back" | "all";

const FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "executed", label: "Executed" },
  { value: "denied", label: "Denied" },
  { value: "failed", label: "Failed" },
  { value: "rolled_back", label: "Rolled Back" },
  { value: "all", label: "All" },
];

function mapStatus(status: ActionLogEntry["status"]): ActionDisplayStatus {
  return status === "pending" ? "pending_approval" : status;
}

function absoluteTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const RTF = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function relativeTime(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  const absSec = Math.abs(Math.round(diffMs / 1000));
  if (absSec < 60) return RTF.format(Math.round(diffMs / 1000), "second");
  const absMin = Math.abs(Math.round(diffMs / 60000));
  if (absMin < 60) return RTF.format(Math.round(diffMs / 60000), "minute");
  const absHr = Math.abs(Math.round(diffMs / 3600000));
  if (absHr < 24) return RTF.format(Math.round(diffMs / 3600000), "hour");
  return RTF.format(Math.round(diffMs / 86400000), "day");
}

function RelativeTimestamp({ iso, label }: { iso: string; label?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>{label ? `${label}: ` : ""}{relativeTime(iso)}</span>
      </TooltipTrigger>
      <TooltipContent>{absoluteTimestamp(iso)}</TooltipContent>
    </Tooltip>
  );
}

function ActionTypeIcon({ type }: { type: string }) {
  const Icon = actionTypeIcon(type);
  return <Icon className="size-3.5" />;
}

const EMPTY_MESSAGES: Record<StatusFilter, string> = {
  pending: "No actions awaiting approval.",
  executed: "No executed actions yet.",
  denied: "No denied actions.",
  failed: "No failed actions.",
  rolled_back: "No rolled back actions.",
  all: "No actions recorded yet.",
};

/* ────────────────────────────────────────────────────────────────────────
 *  PayloadView — branches on action_type to render structured payload
 *  fields when the shape is known. Falls back to JSON for unknown
 *  shapes so a new tool's payload is never silently hidden.
 * ──────────────────────────────────────────────────────────────────────── */

function PayloadView({ type, payload }: { type: string; payload: Record<string, unknown> }) {
  const t = type.toLowerCase();

  if ((t === "sql_write" || t === "sql") && typeof payload.sql === "string") {
    return (
      <pre className="overflow-auto rounded border bg-muted/60 p-2 font-mono text-xs leading-relaxed">
        {payload.sql}
      </pre>
    );
  }

  if (t === "api_call" || t === "api") {
    const method = typeof payload.method === "string" ? payload.method : null;
    const url = typeof payload.url === "string" ? payload.url : null;
    if (method || url) {
      const body = payload.body;
      return (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 rounded border bg-muted/60 px-2 py-1.5 font-mono text-xs">
            {method && (
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                {method}
              </span>
            )}
            {url && <span className="truncate text-foreground">{url}</span>}
          </div>
          {body != null && (
            <pre className="overflow-auto rounded border bg-muted/40 p-2 text-xs">
              {typeof body === "string" ? body : JSON.stringify(body, null, 2)}
            </pre>
          )}
        </div>
      );
    }
  }

  if ((t === "file_write" || t === "file") && typeof payload.path === "string") {
    return (
      <div className="space-y-1.5">
        <div className="rounded border bg-muted/60 px-2 py-1.5 font-mono text-xs">
          {payload.path}
        </div>
        {typeof payload.content === "string" && (
          <pre className="overflow-auto rounded border bg-muted/40 p-2 font-mono text-xs">
            {payload.content}
          </pre>
        )}
      </div>
    );
  }

  return (
    <pre className="overflow-auto rounded border bg-muted/40 p-2 text-xs">
      {JSON.stringify(payload, null, 2)}
    </pre>
  );
}

export default function ActionsPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  const [actions, setActions] = useState<ActionLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FetchError | null>(null);
  // Page-level mutation error — funnels approve/deny/rollback failures into
  // a single banner instead of stacking up to four. Resets on next mutation.
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [{ status: statusFilter, expanded: expandedId }, setParams] = useQueryStates(actionsSearchParams);

  const [refetchKey, setRefetchKey] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<"approve" | "deny" | null>(null);

  // Deny dialog state — single-row deny opens with `denyTarget` set;
  // bulk deny opens with `bulkDenyOpen` true.
  const [denyTarget, setDenyTarget] = useState<ActionLogEntry | null>(null);
  const [bulkDenyOpen, setBulkDenyOpen] = useState(false);

  // Mutation hooks for per-item actions
  const approveMutation = useAdminMutation({
    method: "POST",
    invalidates: () => setRefetchKey((k) => k + 1),
  });
  const denyMutation = useAdminMutation({
    method: "POST",
    invalidates: () => setRefetchKey((k) => k + 1),
  });
  const rollbackMutation = useAdminMutation({
    method: "POST",
    invalidates: () => setRefetchKey((k) => k + 1),
  });

  const bulkInProgress = bulkAction !== null;

  // Clear selection when filter changes
  useEffect(() => {
    setSelectedIds(new Set());
  }, [statusFilter]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: "100" });
        if (statusFilter !== "all") params.set("status", statusFilter);
        const res = await fetch(`${apiUrl}/api/v1/actions?${params}`, { credentials });
        if (cancelled) return;
        if (!res.ok) {
          let serverMessage = `HTTP ${res.status}`;
          try {
            const body = await res.json();
            if (body?.message) serverMessage = body.message;
          } catch { /* intentionally ignored: response may not be JSON */ }
          setError({ message: serverMessage, status: res.status });
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        setActions(data.actions ?? []);
      } catch (err) {
        if (cancelled) return;
        setError({
          message: err instanceof Error ? err.message : "Failed to fetch actions",
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [apiUrl, statusFilter, refetchKey, credentials]);

  const pendingActions = useMemo(() => actions.filter((a) => a.status === "pending"), [actions]);
  const allSelectableSelected = pendingActions.length > 0 && pendingActions.every((a) => selectedIds.has(a.id));
  const someSelected = selectedIds.size > 0;

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (allSelectableSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(pendingActions.map((a) => a.id)));
    }
  }

  async function handleApprove(id: string) {
    setMutationError(null);
    const result = await approveMutation.mutate({
      path: `/api/v1/actions/${id}/approve`,
      body: {},
      itemId: id,
    });
    if (!result.ok) setMutationError(result.error);
  }

  async function confirmSingleDeny(reason: string) {
    if (!denyTarget) return;
    setMutationError(null);
    const id = denyTarget.id;
    const body: Record<string, unknown> = {};
    if (reason) body.reason = reason;
    const result = await denyMutation.mutate({
      path: `/api/v1/actions/${id}/deny`,
      body,
      itemId: id,
    });
    if (!result.ok) {
      setMutationError(result.error);
      return;
    }
    setDenyTarget(null);
  }

  async function handleRollback(id: string) {
    setMutationError(null);
    const result = await rollbackMutation.mutate({
      path: `/api/v1/actions/${id}/rollback`,
      body: {},
      itemId: id,
      onSuccess: (data) => {
        // Server returns { warning } when rollback succeeded but with caveats
        // (e.g. external API didn't expose a true undo). Surface as a warning
        // banner so the operator can investigate.
        const body = data as Record<string, unknown> | undefined;
        if (body?.warning && typeof body.warning === "string") {
          setMutationError(body.warning);
        }
      },
    });
    if (!result.ok) setMutationError(result.error);
  }

  async function handleBulkApprove() {
    if (selectedIds.size === 0) return;
    setBulkAction("approve");
    setMutationError(null);
    const ids = [...selectedIds];
    try {
      const results = await Promise.allSettled(
        ids.map((id) =>
          fetch(`${apiUrl}/api/v1/actions/${id}/approve`, {
            credentials,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          }).then(async (res) => {
            if (!res.ok) {
              let serverMessage = `HTTP ${res.status}`;
              try {
                const errBody = await res.json();
                if (errBody?.message) serverMessage = errBody.message;
              } catch { /* intentionally ignored: response may not be JSON */ }
              throw new Error(serverMessage);
            }
          }),
        ),
      );
      handleBulkResult(results, ids, "approvals");
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : `Bulk approve failed`);
    } finally {
      setBulkAction(null);
    }
  }

  async function confirmBulkDeny(reason: string) {
    if (selectedIds.size === 0) return;
    setBulkAction("deny");
    setMutationError(null);
    const ids = [...selectedIds];
    const body: Record<string, unknown> = {};
    if (reason) body.reason = reason;
    const bodyJson = JSON.stringify(body);
    try {
      const results = await Promise.allSettled(
        ids.map((id) =>
          fetch(`${apiUrl}/api/v1/actions/${id}/deny`, {
            credentials,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: bodyJson,
          }).then(async (res) => {
            if (!res.ok) {
              let serverMessage = `HTTP ${res.status}`;
              try {
                const errBody = await res.json();
                if (errBody?.message) serverMessage = errBody.message;
              } catch { /* intentionally ignored: response may not be JSON */ }
              throw new Error(serverMessage);
            }
          }),
        ),
      );
      handleBulkResult(results, ids, "denials");
      // Close the dialog only on full success; partial failure leaves the
      // selection narrowed to failed IDs so operator can see what's left.
      const failedCount = results.filter((r) => r.status === "rejected").length;
      if (failedCount === 0) setBulkDenyOpen(false);
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : `Bulk deny failed`);
    } finally {
      setBulkAction(null);
    }
  }

  /** Shared partial-failure handling for bulk approve / deny. */
  function handleBulkResult(
    results: PromiseSettledResult<unknown>[],
    ids: string[],
    noun: string,
  ) {
    const failedIds = new Set(
      results
        .map((r, i) => (r.status === "rejected" ? ids[i] : null))
        .filter((id): id is string => id !== null),
    );
    if (failedIds.size > 0) {
      const reasons = [...new Set(
        results
          .filter((r): r is PromiseRejectedResult => r.status === "rejected")
          .map((r) => (r.reason instanceof Error ? r.reason.message : "Unknown error")),
      )];
      setMutationError(`${failedIds.size} of ${ids.length} ${noun} failed: ${reasons.join(", ")}`);
      setSelectedIds(failedIds);
    } else {
      setSelectedIds(new Set());
    }
    setRefetchKey((k) => k + 1);
  }

  // Single banner — fetch error is rendered by AdminContentWrapper, this
  // covers all mutation paths (approve/deny/rollback + bulk + warnings).
  function clearMutationError() {
    setMutationError(null);
  }

  return (
    <TooltipProvider>
      <div className="p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">Actions</h1>
          <p className="text-sm text-muted-foreground">
            Review and manage action approvals.
          </p>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          {FILTER_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              size="sm"
              variant={statusFilter === opt.value ? "secondary" : "ghost"}
              onClick={() => setParams({ status: opt.value, expanded: null })}
            >
              {opt.label}
            </Button>
          ))}

          {someSelected && (
            <>
              <div className="mx-2 h-4 w-px bg-border" />
              <span className="text-sm text-muted-foreground">
                {selectedIds.size} selected
              </span>
              <Button
                size="sm"
                variant="default"
                disabled={bulkInProgress}
                onClick={handleBulkApprove}
              >
                {bulkAction === "approve" ? (
                  <Loader2 className="mr-1 size-4 animate-spin" />
                ) : (
                  <CheckCheck className="mr-1 size-4" />
                )}
                Approve selected
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={bulkInProgress}
                onClick={() => setBulkDenyOpen(true)}
              >
                <XCircle className="mr-1 size-4" />
                Deny selected
              </Button>
            </>
          )}
        </div>

        <ErrorBoundary>
        <div className="space-y-6">
          {mutationError && <ErrorBanner message={mutationError} onRetry={clearMutationError} />}

          <AdminContentWrapper
            loading={loading}
            error={error}
            feature="Actions"
            onRetry={() => setRefetchKey((k) => k + 1)}
            loadingMessage="Loading actions..."
            isEmpty={false}
          >
            {actions.length === 0 ? (
              <EmptyState
                icon={statusFilter === "pending" ? Inbox : Zap}
                title={EMPTY_MESSAGES[statusFilter]}
              >
                {statusFilter === "pending" && (
                  <p className="mt-1 text-xs text-muted-foreground/70">
                    Actions requiring approval will appear here.
                  </p>
                )}
              </EmptyState>
            ) : (
            <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10 pl-4">
                    {pendingActions.length > 0 && (
                      <Checkbox
                        checked={allSelectableSelected}
                        onCheckedChange={toggleSelectAll}
                        aria-label="Select all pending actions"
                      />
                    )}
                  </TableHead>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Summary</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {actions.map((action) => {
                  const isExpanded = expandedId === action.id;
                  const isPending = action.status === "pending";
                  const isSelected = selectedIds.has(action.id);
                  return (
                    <Fragment key={action.id}>
                      <TableRow
                        className="cursor-pointer"
                        data-state={isSelected ? "selected" : undefined}
                        onClick={() =>
                          setParams({ expanded: isExpanded ? null : action.id })
                        }
                      >
                        <TableCell className="pl-4" onClick={(e) => e.stopPropagation()}>
                          {isPending && (
                            <Checkbox
                              checked={isSelected}
                              onCheckedChange={() => toggleSelect(action.id)}
                              aria-label={`Select action ${action.id}`}
                            />
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm">
                          <RelativeTimestamp iso={action.requested_at} />
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="gap-1">
                            <ActionTypeIcon type={action.action_type} />
                            {actionTypeLabel(action.action_type)}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-[220px] truncate font-mono text-xs">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="block truncate">{action.target}</span>
                            </TooltipTrigger>
                            <TooltipContent>{action.target}</TooltipContent>
                          </Tooltip>
                        </TableCell>
                        <TableCell className="max-w-xs truncate text-sm">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="block truncate">{action.summary}</span>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-md">{action.summary}</TooltipContent>
                          </Tooltip>
                        </TableCell>
                        <TableCell>
                          <ActionStatusBadge status={mapStatus(action.status)} />
                        </TableCell>
                        <TableCell className="text-right">
                          {isPending && (
                            <div
                              className="flex justify-end gap-1"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={approveMutation.isMutating(action.id) || bulkInProgress}
                                    onClick={() => handleApprove(action.id)}
                                    aria-label="Approve action"
                                  >
                                    {approveMutation.isMutating(action.id) ? (
                                      <Loader2 className="size-4 animate-spin" />
                                    ) : (
                                      <Check className="size-4" />
                                    )}
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Approve</TooltipContent>
                              </Tooltip>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={denyMutation.isMutating(action.id) || bulkInProgress}
                                    onClick={() => setDenyTarget(action)}
                                    aria-label="Deny action"
                                  >
                                    {denyMutation.isMutating(action.id) ? (
                                      <Loader2 className="size-4 animate-spin" />
                                    ) : (
                                      <X className="size-4" />
                                    )}
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Deny with reason</TooltipContent>
                              </Tooltip>
                            </div>
                          )}
                          {(action.status === "executed" || action.status === "auto_approved") && action.rollback_info && (
                            <div
                              className="flex justify-end gap-1"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={rollbackMutation.isMutating(action.id)}
                                    onClick={() => handleRollback(action.id)}
                                    aria-label="Rollback action"
                                  >
                                    {rollbackMutation.isMutating(action.id) ? (
                                      <Loader2 className="size-4 animate-spin" />
                                    ) : (
                                      <Undo2 className="size-4" />
                                    )}
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Rollback this action</TooltipContent>
                              </Tooltip>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <TableRow>
                          <TableCell colSpan={7} className="bg-muted/30 p-4">
                            <div className="space-y-3 text-sm">
                              <div>
                                <span className="font-medium">Summary:</span>{" "}
                                {action.summary}
                              </div>
                              <div>
                                <span className="font-medium">Payload:</span>
                                <div className="mt-1">
                                  <PayloadView type={action.action_type} payload={action.payload} />
                                </div>
                              </div>
                              <div className="flex flex-wrap gap-x-6 gap-y-1 text-muted-foreground">
                                <RelativeTimestamp iso={action.requested_at} label="Requested" />
                                {action.resolved_at && (
                                  <RelativeTimestamp iso={action.resolved_at} label="Resolved" />
                                )}
                                {action.executed_at && (
                                  <RelativeTimestamp iso={action.executed_at} label="Executed" />
                                )}
                              </div>
                              {action.conversation_id && (
                                <div>
                                  <a
                                    href={`/conversations/${action.conversation_id}`}
                                    className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <MessageSquare className="size-3.5" />
                                    View conversation
                                  </a>
                                </div>
                              )}
                              {action.error && (
                                <div className="text-destructive">
                                  <span className="font-medium">Error:</span>{" "}
                                  {action.error}
                                </div>
                              )}
                              {isPending && (
                                <div className="flex gap-2 pt-2">
                                  <Button
                                    size="sm"
                                    disabled={approveMutation.isMutating(action.id) || bulkInProgress}
                                    onClick={() => handleApprove(action.id)}
                                  >
                                    {approveMutation.isMutating(action.id) ? (
                                      <Loader2 className="mr-1 size-4 animate-spin" />
                                    ) : (
                                      <Check className="mr-1 size-4" />
                                    )}
                                    Approve
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="destructive"
                                    disabled={denyMutation.isMutating(action.id) || bulkInProgress}
                                    onClick={() => setDenyTarget(action)}
                                  >
                                    <X className="mr-1 size-4" />
                                    Deny
                                  </Button>
                                </div>
                              )}
                              {(action.status === "executed" || action.status === "auto_approved") && action.rollback_info && (
                                <div className="flex gap-2 pt-2">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={rollbackMutation.isMutating(action.id)}
                                    onClick={() => handleRollback(action.id)}
                                  >
                                    {rollbackMutation.isMutating(action.id) ? (
                                      <Loader2 className="mr-1 size-4 animate-spin" />
                                    ) : (
                                      <Undo2 className="mr-1 size-4" />
                                    )}
                                    Rollback
                                  </Button>
                                </div>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
            </div>
            )}
          </AdminContentWrapper>
        </div>
        </ErrorBoundary>

        <DenyActionDialog
          open={!!denyTarget}
          onOpenChange={(open) => { if (!open) setDenyTarget(null); }}
          action={denyTarget}
          onConfirm={confirmSingleDeny}
          loading={!!denyTarget && denyMutation.isMutating(denyTarget.id)}
          error={mutationError}
        />

        <DenyActionDialog
          open={bulkDenyOpen}
          onOpenChange={(open) => { if (!open) setBulkDenyOpen(false); }}
          bulkCount={selectedIds.size}
          onConfirm={confirmBulkDeny}
          loading={bulkAction === "deny"}
          error={mutationError}
        />
      </div>
    </TooltipProvider>
  );
}
