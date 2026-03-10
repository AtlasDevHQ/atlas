"use client";

import { Fragment, useEffect, useState, useTransition } from "react";
import { useQueryStates } from "nuqs";
import { actionsSearchParams } from "./search-params";
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
import type { ActionStatus } from "@/ui/lib/action-types";
import { EmptyState } from "@/ui/components/admin/empty-state";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import {
  Zap,
  Check,
  X,
  Loader2,
  ChevronDown,
  ChevronRight,
  Database,
  Globe,
  FilePenLine,
  Terminal,
  MessageSquare,
  CheckCheck,
  XCircle,
  Inbox,
} from "lucide-react";
import { useInProgressSet, type FetchError, friendlyError } from "@/ui/hooks/use-admin-fetch";

interface ActionLogEntry {
  id: string;
  requested_at: string;
  resolved_at: string | null;
  executed_at: string | null;
  requested_by: string | null;
  approved_by: string | null;
  auth_mode: string;
  action_type: string;
  target: string;
  summary: string;
  payload: Record<string, unknown>;
  status:
    | "pending"
    | "approved"
    | "denied"
    | "executed"
    | "failed"
    | "timed_out"
    | "auto_approved";
  result: unknown;
  error: string | null;
  rollback_info: object | null;
  conversation_id: string | null;
  request_id: string | null;
}

type StatusFilter = "pending" | "executed" | "denied" | "failed" | "all";

const FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "executed", label: "Executed" },
  { value: "denied", label: "Denied" },
  { value: "failed", label: "Failed" },
  { value: "all", label: "All" },
];

const ACTION_TYPE_ICONS: Record<string, typeof Database> = {
  sql_write: Database,
  sql: Database,
  api_call: Globe,
  api: Globe,
  file_write: FilePenLine,
  file: FilePenLine,
  shell: Terminal,
  command: Terminal,
};

function mapStatus(status: ActionLogEntry["status"]): ActionStatus {
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
  const Icon = ACTION_TYPE_ICONS[type.toLowerCase()] ?? Zap;
  return <Icon className="size-3.5" />;
}

const EMPTY_MESSAGES: Record<StatusFilter, string> = {
  pending: "No actions awaiting approval.",
  executed: "No executed actions yet.",
  denied: "No denied actions.",
  failed: "No failed actions.",
  all: "No actions recorded yet.",
};

export default function ActionsPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  const [actions, setActions] = useState<ActionLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FetchError | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [{ status: statusFilter, expanded: expandedId }, setParams] = useQueryStates(actionsSearchParams);
  const [, startTransition] = useTransition();
  const approving = useInProgressSet();
  const denying = useInProgressSet();

  const [refetchKey, setRefetchKey] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<"approve" | "deny" | null>(null);

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
          setError({ message: `HTTP ${res.status}`, status: res.status });
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

  // Gate: 401/403/404
  if (!loading && error?.status && [401, 403, 404].includes(error.status)) {
    return (
      <div className="flex h-[calc(100dvh-3rem)] flex-col">
        <div className="border-b px-6 py-4">
          <h1 className="text-2xl font-bold tracking-tight">Actions</h1>
          <p className="text-sm text-muted-foreground">Review and manage action approvals.</p>
        </div>
        <FeatureGate status={error.status as 401 | 403 | 404} feature="Actions" />
      </div>
    );
  }

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

  async function handleApprove(id: string) {
    approving.start(id);
    setMutationError(null);
    try {
      const res = await fetch(`${apiUrl}/api/v1/actions/${id}/approve`, {
        credentials,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`Approve failed (HTTP ${res.status})`);
      setRefetchKey((k) => k + 1);
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : "Approve failed");
    } finally {
      approving.stop(id);
    }
  }

  async function handleDeny(id: string) {
    denying.start(id);
    setMutationError(null);
    try {
      const res = await fetch(`${apiUrl}/api/v1/actions/${id}/deny`, {
        credentials,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Denied by admin" }),
      });
      if (!res.ok) throw new Error(`Deny failed (HTTP ${res.status})`);
      setRefetchKey((k) => k + 1);
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : "Deny failed");
    } finally {
      denying.stop(id);
    }
  }

  async function handleBulkAction(action: "approve" | "deny") {
    if (selectedIds.size === 0) return;
    setBulkAction(action);
    setMutationError(null);
    const ids = [...selectedIds];
    const endpoint = action === "approve" ? "approve" : "deny";
    const body = action === "approve" ? {} : { reason: "Bulk denied by admin" };
    const noun = action === "approve" ? "approvals" : "denials";
    try {
      const results = await Promise.allSettled(
        ids.map((id) =>
          fetch(`${apiUrl}/api/v1/actions/${id}/${endpoint}`, {
            credentials,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }).then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
          }),
        ),
      );
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
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : `Bulk ${action} failed`);
    } finally {
      setBulkAction(null);
    }
  }

  return (
    <TooltipProvider>
      <div className="flex h-[calc(100dvh-3rem)] flex-col">
        <div className="border-b px-6 py-4">
          <h1 className="text-2xl font-bold tracking-tight">Actions</h1>
          <p className="text-sm text-muted-foreground">
            Review and manage action approvals.
          </p>
        </div>

        <div className="flex items-center gap-2 border-b px-6 py-3">
          {FILTER_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              size="sm"
              variant={statusFilter === opt.value ? "secondary" : "ghost"}
              onClick={() => {
                startTransition(() => {
                  setParams({ status: opt.value, expanded: null });
                });
              }}
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
                onClick={() => handleBulkAction("approve")}
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
                onClick={() => handleBulkAction("deny")}
              >
                {bulkAction === "deny" ? (
                  <Loader2 className="mr-1 size-4 animate-spin" />
                ) : (
                  <XCircle className="mr-1 size-4" />
                )}
                Deny selected
              </Button>
            </>
          )}
        </div>

        <div className="flex-1 overflow-auto">
          {error && <ErrorBanner message={friendlyError(error)} onRetry={() => setRefetchKey((k) => k + 1)} />}
          {mutationError && <ErrorBanner message={mutationError} onRetry={() => setMutationError(null)} />}

          {loading ? (
            <LoadingState message="Loading actions..." />
          ) : actions.length === 0 && !error ? (
            <EmptyState
              icon={statusFilter === "pending" ? Inbox : Zap}
              message={EMPTY_MESSAGES[statusFilter]}
            >
              {statusFilter === "pending" && (
                <p className="mt-1 text-xs text-muted-foreground/70">
                  Actions requiring approval will appear here.
                </p>
              )}
            </EmptyState>
          ) : actions.length > 0 ? (
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
                  <TableHead className="w-8" />
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
                        <TableCell>
                          {isExpanded ? (
                            <ChevronDown className="size-4 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="size-4 text-muted-foreground" />
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm">
                          <RelativeTimestamp iso={action.requested_at} />
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="gap-1">
                            <ActionTypeIcon type={action.action_type} />
                            {action.action_type}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm">{action.target}</TableCell>
                        <TableCell className="max-w-xs truncate text-sm">
                          {action.summary}
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
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={approving.has(action.id) || bulkInProgress}
                                onClick={() => handleApprove(action.id)}
                              >
                                {approving.has(action.id) ? (
                                  <Loader2 className="size-4 animate-spin" />
                                ) : (
                                  <Check className="size-4" />
                                )}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={denying.has(action.id) || bulkInProgress}
                                onClick={() => handleDeny(action.id)}
                              >
                                {denying.has(action.id) ? (
                                  <Loader2 className="size-4 animate-spin" />
                                ) : (
                                  <X className="size-4" />
                                )}
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <TableRow>
                          <TableCell colSpan={8} className="bg-muted/30 p-4">
                            <div className="space-y-3 text-sm">
                              <div>
                                <span className="font-medium">Summary:</span>{" "}
                                {action.summary}
                              </div>
                              <div>
                                <span className="font-medium">Payload:</span>
                                <pre className="mt-1 overflow-auto rounded bg-muted p-2 text-xs">
                                  {JSON.stringify(action.payload, null, 2)}
                                </pre>
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
                                    disabled={approving.has(action.id) || bulkInProgress}
                                    onClick={() => handleApprove(action.id)}
                                  >
                                    {approving.has(action.id) ? (
                                      <Loader2 className="mr-1 size-4 animate-spin" />
                                    ) : (
                                      <Check className="mr-1 size-4" />
                                    )}
                                    Approve
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="destructive"
                                    disabled={denying.has(action.id) || bulkInProgress}
                                    onClick={() => handleDeny(action.id)}
                                  >
                                    {denying.has(action.id) ? (
                                      <Loader2 className="mr-1 size-4 animate-spin" />
                                    ) : (
                                      <X className="mr-1 size-4" />
                                    )}
                                    Deny
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
          ) : null}
        </div>
      </div>
    </TooltipProvider>
  );
}
