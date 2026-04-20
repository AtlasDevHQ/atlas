"use client";

import { Fragment, useEffect, useState } from "react";
import { useQueryStates } from "nuqs";
import { actionsSearchParams } from "./search-params";
import { bulkDenyConfirmLabel, bulkDenyTitle, summarizeBulkResult } from "./bulk-result";
import { ACTION_TYPE_LABELS, actionTypeIcon, actionTypeLabel } from "./labels";
import { PayloadView } from "./payload-view";
import { coerceRollbackWarning, logUnsurfacedRollbackWarning } from "./rollback-warning";
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
import type { ActionLogEntry } from "@/ui/lib/types";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { EmptyState } from "@/ui/components/admin/empty-state";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import {
  BulkRequestError,
  QueueFilterRow,
  ReasonDialog,
  RelativeTimestamp,
} from "@/ui/components/admin/queue";
import { extractFetchError, type FetchError } from "@/ui/lib/fetch-error";
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
  AlertTriangle,
} from "lucide-react";
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

function WarningBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div role="status" className="flex items-start justify-between gap-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <p className="text-sm text-amber-800 dark:text-amber-300">{message}</p>
      </div>
      <Button variant="outline" size="sm" onClick={onDismiss} className="shrink-0">
        Dismiss
      </Button>
    </div>
  );
}

export default function ActionsPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  const [actions, setActions] = useState<ActionLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FetchError | null>(null);

  // Page-level structured error covers single-row approve/rollback failures
  // (routed through MutationErrorSurface so gated responses render upsell
  // instead of a flattened string). Bulk-approve failures are a local
  // synthesis that can't fit a single FetchError, so they live in
  // `bulkApproveSummary` as a string and render through ErrorBanner.
  // Single-row deny errors live on denyMutation.error (rendered in the dialog).
  // Bulk-deny errors live in bulkError (rendered in the dialog).
  const [mutationError, setMutationError] = useState<FetchError | null>(null);
  const [bulkApproveSummary, setBulkApproveSummary] = useState<string | null>(null);
  // Warnings are explicit-dismiss only — never auto-cleared by the next click.
  // Used for the rollback `{warning}` server contract: 200 OK but the side-
  // effect may not have actually been undone (see api/routes/actions.ts).
  const [mutationWarning, setMutationWarning] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const [{ status: statusFilter, expanded: expandedId }, setParams] = useQueryStates(actionsSearchParams);

  const [refetchKey, setRefetchKey] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<"approve" | "deny" | null>(null);

  const [denyTarget, setDenyTarget] = useState<ActionLogEntry | null>(null);
  const [bulkDenyOpen, setBulkDenyOpen] = useState(false);

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
          setError(await extractFetchError(res));
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

  const pendingActions = actions.filter((a) => a.status === "pending");
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

  /** Single bulk fetch; throws on non-2xx with the same shape useAdminMutation surfaces. */
  async function bulkRequest(id: string, endpoint: "approve" | "deny", body: Record<string, unknown>) {
    const res = await fetch(`${apiUrl}/api/v1/actions/${id}/${endpoint}`, {
      credentials,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const fe = await extractFetchError(res);
      throw new BulkRequestError(fe.message, fe.requestId);
    }
  }

  async function handleApprove(id: string) {
    setMutationError(null);
    setBulkApproveSummary(null);
    const result = await approveMutation.mutate({
      path: `/api/v1/actions/${id}/approve`,
      body: {},
      itemId: id,
    });
    if (!result.ok) setMutationError(result.error);
  }

  async function confirmSingleDeny(reason: string) {
    if (!denyTarget) {
      console.warn("confirmSingleDeny: denyTarget cleared before confirm");
      setMutationError({
        message: "Unable to deny — the target was cleared. Please retry.",
      });
      return;
    }
    const id = denyTarget.id;
    const body: Record<string, unknown> = {};
    if (reason) body.reason = reason;
    const result = await denyMutation.mutate({
      path: `/api/v1/actions/${id}/deny`,
      body,
      itemId: id,
    });
    if (result.ok) setDenyTarget(null);
  }

  async function handleRollback(id: string) {
    setMutationError(null);
    setBulkApproveSummary(null);
    const result = await rollbackMutation.mutate({
      path: `/api/v1/actions/${id}/rollback`,
      body: {},
      itemId: id,
      onSuccess: (data) => {
        // Server returns { warning } on 200 when the rollback persisted but the
        // side-effect may not have actually reversed (e.g. external API has no
        // true undo). Surface to a dismissible warning, not an error; log
        // anything we couldn't surface verbatim for schema-drift detection.
        const body = data as Record<string, unknown> | undefined;
        const raw = body?.warning;
        const warning = coerceRollbackWarning(raw);
        if (warning) setMutationWarning(warning);
        logUnsurfacedRollbackWarning(raw);
      },
    });
    if (!result.ok) setMutationError(result.error);
  }

  async function handleBulkApprove() {
    if (selectedIds.size === 0) return;
    setBulkAction("approve");
    setMutationError(null);
    setBulkApproveSummary(null);
    const ids = [...selectedIds];
    try {
      const results = await Promise.allSettled(
        ids.map((id) => bulkRequest(id, "approve", {})),
      );
      handleBulkResult(results, ids, "approvals");
    } finally {
      setBulkAction(null);
    }
  }

  async function confirmBulkDeny(reason: string) {
    if (selectedIds.size === 0) return;
    setBulkAction("deny");
    setBulkError(null);
    const ids = [...selectedIds];
    const body: Record<string, unknown> = {};
    if (reason) body.reason = reason;
    try {
      const results = await Promise.allSettled(
        ids.map((id) => bulkRequest(id, "deny", body)),
      );
      const { summary, remainingIds } = summarizeBulkResult(results, ids, "denials");
      if (summary === null) {
        setSelectedIds(new Set());
        setBulkDenyOpen(false);
        setRefetchKey((k) => k + 1);
        return;
      }
      // Partial / total failure: narrow selection to failed IDs and surface
      // the summary inside the dialog so a retry click sees the *current*
      // attempt's stats, not the prior one (bulkError clears at fn entry).
      setBulkError(summary);
      setSelectedIds(remainingIds);
      setRefetchKey((k) => k + 1);
    } finally {
      setBulkAction(null);
    }
  }

  /** Page-level summary for bulk approve (no dialog to show it in). */
  function handleBulkResult(
    results: PromiseSettledResult<unknown>[],
    ids: string[],
    noun: string,
  ) {
    const { summary, remainingIds } = summarizeBulkResult(results, ids, noun);
    setBulkApproveSummary(summary);
    setSelectedIds(remainingIds);
    setRefetchKey((k) => k + 1);
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

        <div className="mb-4">
          <QueueFilterRow
            options={FILTER_OPTIONS}
            value={statusFilter}
            onChange={(next) => setParams({ status: next, expanded: null })}
            trailing={
              someSelected && (
                <>
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
              )
            }
          />
        </div>

        <ErrorBoundary>
        <div className="space-y-6">
          <MutationErrorSurface
            error={mutationError}
            feature="Actions"
            onRetry={() => setMutationError(null)}
          />
          {bulkApproveSummary && (
            <ErrorBanner
              message={bulkApproveSummary}
              onRetry={() => setBulkApproveSummary(null)}
            />
          )}
          {mutationWarning && <WarningBanner message={mutationWarning} onDismiss={() => setMutationWarning(null)} />}

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
                        <TableCell className="max-w-55 truncate font-mono text-xs">
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
                          <ActionStatusBadge status={action.status} />
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

        <ReasonDialog
          open={!!denyTarget}
          onOpenChange={(open) => {
            if (!open) {
              setDenyTarget(null);
              denyMutation.clearError();
            }
          }}
          title="Deny action"
          description="Recorded in the audit log alongside your account. Reason is optional but recommended for traceability."
          context={
            denyTarget && (
              <>
                <div className="flex items-center gap-1.5">
                  <span className="rounded border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {ACTION_TYPE_LABELS[denyTarget.action_type] ?? denyTarget.action_type}
                  </span>
                  <span className="truncate font-mono text-muted-foreground">
                    {denyTarget.target}
                  </span>
                </div>
                <p className="mt-1.5 line-clamp-2 text-muted-foreground/80">
                  {denyTarget.summary}
                </p>
              </>
            )
          }
          onConfirm={confirmSingleDeny}
          loading={!!denyTarget && denyMutation.isMutating(denyTarget.id)}
          mutationError={denyMutation.error}
          feature="Actions"
        />

        <ReasonDialog
          open={bulkDenyOpen}
          onOpenChange={(open) => {
            if (!open) {
              setBulkDenyOpen(false);
              setBulkError(null);
            }
          }}
          title={bulkDenyTitle(selectedIds.size)}
          description="Recorded in the audit log alongside your account. Reason is optional but recommended for traceability."
          confirmLabel={bulkDenyConfirmLabel(selectedIds.size)}
          onConfirm={confirmBulkDeny}
          loading={bulkAction === "deny"}
          error={bulkError}
        />
      </div>
    </TooltipProvider>
  );
}
