"use client";

import { Fragment, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryStates } from "nuqs";
import { z } from "zod";
import { approvalSearchParams } from "./search-params";
import { useAtlasConfig } from "@/ui/context";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { EmptyState } from "@/ui/components/admin/empty-state";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import {
  bulkFailureSummary,
  failedIdsFrom,
  QueueFilterRow,
  ReasonDialog,
  RelativeTimestamp,
  useQueueRow,
} from "@/ui/components/admin/queue";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { extractFetchError } from "@/ui/lib/fetch-error";
import { ApprovalRuleSchema } from "@/ui/lib/admin-schemas";
import type { ApprovalRequest, ApprovalRule, ApprovalRuleType, ApprovalStatus } from "@/ui/lib/types";
import {
  AlertCircle,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Inbox,
  Loader2,
  Plus,
  ShieldAlert,
  Trash2,
  X,
  XCircle,
} from "lucide-react";

type StatusFilter = "pending" | "approved" | "denied" | "expired" | "all";

const FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "denied", label: "Denied" },
  { value: "expired", label: "Expired" },
  { value: "all", label: "All" },
];

const EMPTY_MESSAGES: Record<StatusFilter, string> = {
  pending: "No requests awaiting approval.",
  approved: "No approved requests yet.",
  denied: "No denied requests.",
  expired: "No expired requests.",
  all: "No approval requests recorded.",
};

const RulesResponseSchema = z.object({ rules: z.array(ApprovalRuleSchema) });

const RULE_TYPES: { value: ApprovalRuleType; label: string; description: string }[] = [
  { value: "table", label: "Table", description: "Match queries accessing a specific table" },
  { value: "column", label: "Column", description: "Match queries accessing a specific column" },
  { value: "cost", label: "Cost", description: "Match queries exceeding a cost threshold" },
];

const createRuleSchema = z
  .object({
    name: z.string().min(1, "Rule name is required"),
    ruleType: z.enum(["table", "column", "cost"]),
    pattern: z.string(),
    threshold: z.string(),
  })
  .refine(
    (data) => data.ruleType === "cost" || data.pattern.trim().length > 0,
    { message: "Pattern is required for table/column rules", path: ["pattern"] },
  )
  .refine(
    (data) => data.ruleType !== "cost" || (data.threshold.trim().length > 0 && !isNaN(Number(data.threshold))),
    { message: "A valid numeric threshold is required", path: ["threshold"] },
  );

function statusBadge(status: ApprovalStatus) {
  switch (status) {
    case "pending":
      return (
        <Badge variant="outline" className="gap-1">
          <Clock className="size-3" />
          Pending
        </Badge>
      );
    case "approved":
      return (
        <Badge variant="outline" className="gap-1 border-green-500 text-green-600">
          <CheckCircle2 className="size-3" />
          Approved
        </Badge>
      );
    case "denied":
      return (
        <Badge variant="outline" className="gap-1 border-red-500 text-red-600">
          <XCircle className="size-3" />
          Denied
        </Badge>
      );
    case "expired":
      return (
        <Badge variant="secondary" className="gap-1">
          <AlertCircle className="size-3" />
          Expired
        </Badge>
      );
  }
}

export default function ApprovalWorkflowsPage() {
  return (
    <ErrorBoundary>
      <TooltipProvider>
        <ApprovalPageContent />
      </TooltipProvider>
    </ErrorBoundary>
  );
}

function ApprovalPageContent() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Approval Workflows</h1>
        <p className="text-sm text-muted-foreground">
          Require sign-off for queries touching sensitive tables, columns, or exceeding cost thresholds.
        </p>
      </div>

      <RulesSection />
      <QueueSection />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 *  Rules section
 * ──────────────────────────────────────────────────────────────────────── */

function RulesSection() {
  const [showCreateForm, setShowCreateForm] = useState(false);

  const ruleForm = useForm<z.infer<typeof createRuleSchema>>({
    resolver: zodResolver(createRuleSchema),
    defaultValues: { name: "", ruleType: "table", pattern: "", threshold: "" },
  });

  const { data, loading, error, refetch } = useAdminFetch("/api/v1/admin/approval/rules", {
    schema: RulesResponseSchema,
  });

  const createMutation = useAdminMutation({
    path: "/api/v1/admin/approval/rules",
    method: "POST",
    invalidates: refetch,
  });
  const toggleMutation = useAdminMutation({ method: "PUT", invalidates: refetch });
  const deleteMutation = useAdminMutation({ method: "DELETE", invalidates: refetch });

  const mutationError = createMutation.error ?? toggleMutation.error ?? deleteMutation.error;

  function clearMutationError() {
    createMutation.clearError();
    toggleMutation.clearError();
    deleteMutation.clearError();
  }

  async function handleCreateRule(values: z.infer<typeof createRuleSchema>) {
    const result = await createMutation.mutate({
      body: {
        name: values.name,
        ruleType: values.ruleType,
        pattern: values.pattern,
        threshold: values.ruleType === "cost" ? Number(values.threshold) : null,
        enabled: true,
      },
    });
    if (result.ok) {
      ruleForm.reset();
      setShowCreateForm(false);
    }
  }

  async function handleToggleRule(rule: ApprovalRule) {
    await toggleMutation.mutate({
      path: `/api/v1/admin/approval/rules/${rule.id}`,
      body: { enabled: !rule.enabled },
    });
  }

  async function handleDeleteRule(ruleId: string) {
    await deleteMutation.mutate({ path: `/api/v1/admin/approval/rules/${ruleId}` });
  }

  const rules = data?.rules ?? [];

  return (
    <AdminContentWrapper
      loading={loading}
      error={error}
      feature="Approval Workflows"
      onRetry={refetch}
    >
      {mutationError && <ErrorBanner message={mutationError} onRetry={clearMutationError} />}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="size-5" />
              Approval Rules
            </CardTitle>
            <CardDescription>
              Define which queries require approval before execution.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setShowCreateForm((v) => !v)}>
            <Plus className="mr-1 size-4" />
            Add rule
          </Button>
        </CardHeader>
        <CardContent>
          {showCreateForm && (
            <Form {...ruleForm}>
              <form
                onSubmit={ruleForm.handleSubmit(handleCreateRule)}
                className="mb-6 rounded-lg border p-4 space-y-4"
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    control={ruleForm.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Rule Name</FormLabel>
                        <FormControl>
                          <Input placeholder="e.g., Require approval for PII tables" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={ruleForm.control}
                    name="ruleType"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Rule Type</FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {RULE_TYPES.map((t) => (
                              <SelectItem key={t.value} value={t.value}>
                                {t.label} — {t.description}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                {ruleForm.watch("ruleType") !== "cost" ? (
                  <FormField
                    control={ruleForm.control}
                    name="pattern"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          {ruleForm.watch("ruleType") === "table" ? "Table Name" : "Column Name"}
                        </FormLabel>
                        <FormControl>
                          <Input
                            placeholder={ruleForm.watch("ruleType") === "table" ? "e.g., users" : "e.g., ssn"}
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                ) : (
                  <FormField
                    control={ruleForm.control}
                    name="threshold"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Cost Threshold (row estimate)</FormLabel>
                        <FormControl>
                          <Input type="number" placeholder="e.g., 100000" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={createMutation.saving}>
                    {createMutation.saving && <Loader2 className="mr-1 size-4 animate-spin" />}
                    Create Rule
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowCreateForm(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            </Form>
          )}

          {rules.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No approval rules configured. Click "Add rule" to create one.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Pattern / Threshold</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead className="w-[80px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.map((rule) => (
                  <TableRow key={rule.id}>
                    <TableCell className="font-medium">{rule.name}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{rule.ruleType}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {rule.ruleType === "cost" ? `> ${rule.threshold}` : rule.pattern}
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={rule.enabled}
                        onCheckedChange={() => handleToggleRule(rule)}
                        aria-label={`Toggle rule ${rule.name}`}
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => handleDeleteRule(rule.id)}
                        aria-label={`Delete rule ${rule.name}`}
                      >
                        <Trash2 className="size-4 text-muted-foreground" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </AdminContentWrapper>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 *  Queue section
 * ──────────────────────────────────────────────────────────────────────── */

function QueueSection() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  const [{ status: statusFilter, expanded: expandedId }, setParams] = useQueryStates(approvalSearchParams);

  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [refetchKey, setRefetchKey] = useState(0);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<"approve" | "deny" | null>(null);
  const [bulkDenyOpen, setBulkDenyOpen] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const [denyTarget, setDenyTarget] = useState<ApprovalRequest | null>(null);

  const reviewMutation = useAdminMutation<{ request: ApprovalRequest }>({ method: "POST" });
  const { runOptimistic, inProgress } = useQueueRow<ApprovalRequest>({
    rows: requests,
    setRows: setRequests,
    getId: (r) => r.id,
  });

  useEffect(() => {
    setSelectedIds(new Set());
  }, [statusFilter]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setBannerError(null);
      try {
        const qs = new URLSearchParams();
        if (statusFilter !== "all") qs.set("status", statusFilter);
        const res = await fetch(
          `${apiUrl}/api/v1/admin/approval/queue${qs.size ? `?${qs}` : ""}`,
          { credentials },
        );
        if (cancelled) return;
        if (!res.ok) {
          const fe = await extractFetchError(res);
          setBannerError(fe.requestId ? `${fe.message} (Request ID: ${fe.requestId})` : fe.message);
          return;
        }
        const data = await res.json();
        if (!cancelled) setRequests(data.requests ?? []);
      } catch (err) {
        if (!cancelled) {
          setBannerError(err instanceof Error ? err.message : "Failed to load approval queue");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiUrl, credentials, statusFilter, refetchKey]);

  const pendingRequests = requests.filter((r) => r.status === "pending");
  const allSelectableSelected =
    pendingRequests.length > 0 && pendingRequests.every((r) => selectedIds.has(r.id));
  const someSelected = selectedIds.size > 0;
  const bulkInProgress = bulkAction !== null;

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
      setSelectedIds(new Set(pendingRequests.map((r) => r.id)));
    }
  }

  async function handleApprove(id: string, comment?: string) {
    setBannerError(null);
    const result = await runOptimistic(
      id,
      (r) => ({
        ...r,
        status: "approved" as const,
        reviewedAt: new Date().toISOString(),
      }),
      () =>
        reviewMutation.mutate({
          path: `/api/v1/admin/approval/queue/${id}`,
          body: { action: "approve", comment },
          itemId: id,
          onSuccess: (data) => {
            if (data?.request) {
              setRequests((prev) => prev.map((r) => (r.id === id ? data.request : r)));
            }
          },
        }),
    );
    if (!result.ok) {
      setBannerError(result.error);
    }
  }

  async function confirmSingleDeny(reason: string) {
    if (!denyTarget) return;
    const id = denyTarget.id;
    setBannerError(null);
    const result = await runOptimistic(
      id,
      (r) => ({
        ...r,
        status: "denied" as const,
        reviewedAt: new Date().toISOString(),
        reviewComment: reason || null,
      }),
      () =>
        reviewMutation.mutate({
          path: `/api/v1/admin/approval/queue/${id}`,
          body: { action: "deny", ...(reason ? { comment: reason } : {}) },
          itemId: id,
          onSuccess: (data) => {
            if (data?.request) {
              setRequests((prev) => prev.map((r) => (r.id === id ? data.request : r)));
            }
          },
        }),
    );
    if (result.ok) {
      setDenyTarget(null);
    }
    // On failure, reviewMutation.error is surfaced in-dialog via `error` prop.
  }

  /**
   * Bulk approve uses client-side Promise.allSettled because there's no
   * atomic bulk approval endpoint on the server. Tracked under #1590 as a
   * follow-up: convergent POST /api/v1/admin/approval/queue/bulk would let
   * us collapse this into a single useAdminMutation + bulkPartialSummary
   * path like /admin/learned-patterns.
   */
  async function bulkRequest(id: string, action: "approve" | "deny", body: Record<string, unknown>) {
    const res = await fetch(`${apiUrl}/api/v1/admin/approval/queue/${id}`, {
      credentials,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...body }),
    });
    if (!res.ok) {
      const fe = await extractFetchError(res);
      const msg = fe.requestId ? `${fe.message} (Request ID: ${fe.requestId})` : fe.message;
      throw new Error(msg);
    }
  }

  async function handleBulkApprove() {
    if (selectedIds.size === 0) return;
    setBulkAction("approve");
    setBannerError(null);
    const ids = [...selectedIds];
    try {
      const results = await Promise.allSettled(ids.map((id) => bulkRequest(id, "approve", {})));
      const failedIds = failedIdsFrom(results, ids);
      if (failedIds.length > 0) {
        setBannerError(bulkFailureSummary(results, ids, "approvals"));
        setSelectedIds(new Set(failedIds));
      } else {
        setSelectedIds(new Set());
      }
      setRefetchKey((k) => k + 1);
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
    if (reason) body.comment = reason;
    try {
      const results = await Promise.allSettled(ids.map((id) => bulkRequest(id, "deny", body)));
      const failedIds = failedIdsFrom(results, ids);
      if (failedIds.length === 0) {
        setSelectedIds(new Set());
        setBulkDenyOpen(false);
        setRefetchKey((k) => k + 1);
        return;
      }
      setBulkError(bulkFailureSummary(results, ids, "denials"));
      setSelectedIds(new Set(failedIds));
      setRefetchKey((k) => k + 1);
    } finally {
      setBulkAction(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Approval Queue</CardTitle>
        <CardDescription>
          Review and approve or deny pending query requests.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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

        {bannerError && (
          <ErrorBanner message={bannerError} onRetry={() => setBannerError(null)} />
        )}

        {loading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading approval queue...</p>
        ) : requests.length === 0 ? (
          <EmptyState icon={statusFilter === "pending" ? Inbox : ShieldAlert} title={EMPTY_MESSAGES[statusFilter]}>
            {statusFilter === "pending" && (
              <p className="mt-1 text-xs text-muted-foreground/70">
                Requests requiring approval will appear here.
              </p>
            )}
          </EmptyState>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10 pl-4">
                    {pendingRequests.length > 0 && (
                      <Checkbox
                        checked={allSelectableSelected}
                        onCheckedChange={toggleSelectAll}
                        aria-label="Select all pending requests"
                      />
                    )}
                  </TableHead>
                  <TableHead className="w-6" />
                  <TableHead>Requester</TableHead>
                  <TableHead>Rule</TableHead>
                  <TableHead>Requested</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requests.map((req) => {
                  const isExpanded = expandedId === req.id;
                  const isPending = req.status === "pending";
                  const isSelected = selectedIds.has(req.id);
                  const isBusy = inProgress.has(req.id);
                  return (
                    <Fragment key={req.id}>
                      <TableRow
                        data-state={isSelected ? "selected" : undefined}
                        className="cursor-pointer"
                        onClick={() =>
                          setParams({ expanded: isExpanded ? null : req.id })
                        }
                      >
                        <TableCell className="pl-4" onClick={(e) => e.stopPropagation()}>
                          {isPending && (
                            <Checkbox
                              checked={isSelected}
                              onCheckedChange={() => toggleSelect(req.id)}
                              aria-label={`Select request ${req.id}`}
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
                        <TableCell className="max-w-xs truncate text-sm">
                          {req.requesterEmail ?? req.requesterId}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {req.ruleName}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm">
                          <RelativeTimestamp iso={req.createdAt} />
                        </TableCell>
                        <TableCell>{statusBadge(req.status)}</TableCell>
                        <TableCell
                          className="text-right"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {isPending && (
                            <div className="flex justify-end gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={isBusy || bulkInProgress}
                                onClick={() => handleApprove(req.id)}
                                aria-label="Approve"
                              >
                                {isBusy ? (
                                  <Loader2 className="size-4 animate-spin" />
                                ) : (
                                  <Check className="size-4" />
                                )}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={isBusy || bulkInProgress}
                                onClick={() => setDenyTarget(req)}
                                aria-label="Deny with reason"
                              >
                                <X className="size-4" />
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <TableRow>
                          <TableCell colSpan={7} className="bg-muted/30 p-4">
                            <ExpandedRequestDetails
                              req={req}
                              disabled={isBusy || bulkInProgress}
                              onApprove={() => handleApprove(req.id)}
                              onDeny={() => setDenyTarget(req)}
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
        )}
      </CardContent>

      <ReasonDialog
        open={!!denyTarget}
        onOpenChange={(open) => {
          if (!open) {
            setDenyTarget(null);
            reviewMutation.clearError();
          }
        }}
        title="Deny approval request"
        description="Recorded in the audit log alongside your account. Reason is optional but recommended for traceability."
        context={
          denyTarget && (
            <>
              <div className="flex items-center gap-1.5">
                <span className="rounded border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {denyTarget.ruleName}
                </span>
                <span className="truncate text-muted-foreground">
                  {denyTarget.requesterEmail ?? denyTarget.requesterId}
                </span>
              </div>
              {denyTarget.explanation && (
                <p className="mt-1.5 line-clamp-2 text-muted-foreground/80">
                  {denyTarget.explanation}
                </p>
              )}
            </>
          )
        }
        onConfirm={confirmSingleDeny}
        loading={!!denyTarget && reviewMutation.isMutating(denyTarget.id)}
        error={reviewMutation.error}
      />

      <ReasonDialog
        open={bulkDenyOpen}
        onOpenChange={(open) => {
          if (!open) {
            setBulkDenyOpen(false);
            setBulkError(null);
          }
        }}
        title={`Deny ${selectedIds.size} request${selectedIds.size === 1 ? "" : "s"}`}
        description="Recorded in the audit log alongside your account. Reason is optional but recommended for traceability."
        confirmLabel={`Deny ${selectedIds.size}`}
        onConfirm={confirmBulkDeny}
        loading={bulkAction === "deny"}
        error={bulkError}
      />
    </Card>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 *  Expanded row body
 * ──────────────────────────────────────────────────────────────────────── */

function ExpandedRequestDetails({
  req,
  disabled,
  onApprove,
  onDeny,
}: {
  req: ApprovalRequest;
  disabled: boolean;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const isPending = req.status === "pending";
  return (
    <div className="space-y-3 text-sm">
      {req.explanation && (
        <div>
          <span className="font-medium">Explanation:</span>{" "}
          <span className="text-muted-foreground">{req.explanation}</span>
        </div>
      )}

      <div>
        <span className="font-medium">Query:</span>
        <pre className="mt-1 overflow-auto rounded border bg-muted/60 p-2 font-mono text-xs leading-relaxed">
          {req.querySql}
        </pre>
      </div>

      {req.tablesAccessed.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Tables:</span>
          {req.tablesAccessed.map((t) => (
            <Badge key={t} variant="outline" className="text-xs">
              {t}
            </Badge>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-muted-foreground">
        <RelativeTimestamp iso={req.createdAt} label="Requested" />
        <RelativeTimestamp iso={req.expiresAt} label="Expires" />
        {req.reviewedAt && <RelativeTimestamp iso={req.reviewedAt} label="Reviewed" />}
      </div>

      {req.reviewerId && (
        <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Reviewed by {req.reviewerEmail ?? req.reviewerId}
          {req.reviewComment && <span> — "{req.reviewComment}"</span>}
        </div>
      )}

      {isPending && (
        <div className="flex gap-2 pt-2 border-t">
          <Button size="sm" onClick={onApprove} disabled={disabled}>
            <Check className="mr-1 size-4" />
            Approve
          </Button>
          <Button size="sm" variant="destructive" onClick={onDeny} disabled={disabled}>
            <X className="mr-1 size-4" />
            Deny with reason
          </Button>
        </div>
      )}
    </div>
  );
}
