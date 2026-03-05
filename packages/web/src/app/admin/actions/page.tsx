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
import { ActionStatusBadge } from "@/ui/components/actions/action-status-badge";
import type { ActionStatus } from "@/ui/lib/action-types";
import { EmptyState } from "@/ui/components/admin/empty-state";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import { Zap, Check, X, Loader2, ChevronDown, ChevronRight } from "lucide-react";
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

function mapStatus(status: ActionLogEntry["status"]): ActionStatus {
  return status === "pending" ? "pending_approval" : status;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

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

  return (
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
      </div>

      <div className="flex-1 overflow-auto">
        {error && <ErrorBanner message={friendlyError(error)} onRetry={() => setRefetchKey((k) => k + 1)} />}
        {mutationError && <ErrorBanner message={mutationError} onRetry={() => setMutationError(null)} />}

        {loading ? (
          <LoadingState message="Loading actions..." />
        ) : actions.length === 0 && !error ? (
          <EmptyState icon={Zap} message="No actions found." />
        ) : actions.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
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
                return (
                  <Fragment key={action.id}>
                    <TableRow
                      className="cursor-pointer"
                      onClick={() =>
                        setParams({ expanded: isExpanded ? null : action.id })
                      }
                    >
                      <TableCell>
                        {isExpanded ? (
                          <ChevronDown className="size-4 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="size-4 text-muted-foreground" />
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        {formatTimestamp(action.requested_at)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{action.action_type}</Badge>
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
                              disabled={approving.has(action.id)}
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
                              disabled={denying.has(action.id)}
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
                        <TableCell colSpan={7} className="bg-muted/30 p-4">
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
                              <span>
                                Requested: {formatTimestamp(action.requested_at)}
                              </span>
                              {action.resolved_at && (
                                <span>
                                  Resolved:{" "}
                                  {formatTimestamp(action.resolved_at)}
                                </span>
                              )}
                              {action.executed_at && (
                                <span>
                                  Executed:{" "}
                                  {formatTimestamp(action.executed_at)}
                                </span>
                              )}
                            </div>
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
                                  disabled={approving.has(action.id)}
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
                                  disabled={denying.has(action.id)}
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
  );
}
