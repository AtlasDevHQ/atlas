"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { useAdminFetch, friendlyError } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  ShieldAlert,
  Plus,
  Trash2,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  AlertCircle,
} from "lucide-react";
import type { ApprovalRule, ApprovalRuleType, ApprovalRequest, ApprovalStatus } from "@/ui/lib/types";

// ── Types ─────────────────────────────────────────────────────────

interface RulesResponse {
  rules: ApprovalRule[];
}

interface QueueResponse {
  requests: ApprovalRequest[];
}

const RULE_TYPES: { value: ApprovalRuleType; label: string; description: string }[] = [
  { value: "table", label: "Table", description: "Match queries accessing a specific table" },
  { value: "column", label: "Column", description: "Match queries accessing a specific column" },
  { value: "cost", label: "Cost", description: "Match queries exceeding a cost threshold" },
];

const createRuleSchema = z.object({
  name: z.string().min(1, "Rule name is required"),
  ruleType: z.enum(["table", "column", "cost"]),
  pattern: z.string(),
  threshold: z.string(),
}).refine(
  (data) => data.ruleType === "cost" || data.pattern.trim().length > 0,
  { message: "Pattern is required for table/column rules", path: ["pattern"] },
).refine(
  (data) => data.ruleType !== "cost" || (data.threshold.trim().length > 0 && !isNaN(Number(data.threshold))),
  { message: "A valid numeric threshold is required", path: ["threshold"] },
);

function statusBadge(status: ApprovalStatus) {
  switch (status) {
    case "pending":
      return <Badge variant="outline" className="gap-1"><Clock className="size-3" />Pending</Badge>;
    case "approved":
      return <Badge variant="outline" className="gap-1 border-green-500 text-green-600"><CheckCircle2 className="size-3" />Approved</Badge>;
    case "denied":
      return <Badge variant="outline" className="gap-1 border-red-500 text-red-600"><XCircle className="size-3" />Denied</Badge>;
    case "expired":
      return <Badge variant="secondary" className="gap-1"><AlertCircle className="size-3" />Expired</Badge>;
  }
}

// ── Main Page ─────────────────────────────────────────────────────

export default function ApprovalWorkflowsPage() {
  return (
    <ErrorBoundary>
      <ApprovalPageContent />
    </ErrorBoundary>
  );
}

function ApprovalPageContent() {
  // Rule form
  const ruleForm = useForm<z.infer<typeof createRuleSchema>>({
    resolver: zodResolver(createRuleSchema),
    defaultValues: { name: "", ruleType: "table", pattern: "", threshold: "" },
  });
  const [showCreateForm, setShowCreateForm] = useState(false);

  // Review state — per-request comments to avoid cross-contamination
  const [reviewComments, setReviewComments] = useState<Record<string, string>>({});

  // Queue filter
  const [statusFilter, setStatusFilter] = useState<string>("all");

  // Fetch rules
  const { data: rulesData, loading: rulesLoading, error: rulesError, refetch: refetchRules } =
    useAdminFetch<RulesResponse>("/api/v1/admin/approval/rules", {
      transform: (json) => json as RulesResponse,
    });

  // Fetch queue
  const queuePath = statusFilter === "all"
    ? "/api/v1/admin/approval/queue"
    : `/api/v1/admin/approval/queue?status=${statusFilter}`;
  const { data: queueData, loading: queueLoading, error: queueError, refetch: refetchQueue } =
    useAdminFetch<QueueResponse>(queuePath, {
      transform: (json) => json as QueueResponse,
      deps: [statusFilter],
    });

  // Mutation hooks
  const { mutate: createRule, saving: creatingRule, error: createError, clearError: clearCreateError } =
    useAdminMutation({
      path: "/api/v1/admin/approval/rules",
      method: "POST",
      invalidates: refetchRules,
    });

  const { mutate: toggleRule, error: toggleError, clearError: clearToggleError } =
    useAdminMutation({
      method: "PUT",
      invalidates: refetchRules,
    });

  const { mutate: deleteRule, error: deleteError, clearError: clearDeleteError } =
    useAdminMutation({
      method: "DELETE",
      invalidates: refetchRules,
    });

  const { mutate: reviewRequest, error: reviewError, clearError: clearReviewError, isMutating: isReviewing } =
    useAdminMutation({
      method: "POST",
      invalidates: refetchQueue,
    });

  const mutationError = createError ?? toggleError ?? deleteError ?? reviewError;

  function clearMutationError() {
    clearCreateError();
    clearToggleError();
    clearDeleteError();
    clearReviewError();
  }

  const gateError = rulesError ?? queueError;

  // Create rule handler
  async function handleCreateRule(values: z.infer<typeof createRuleSchema>) {
    const result = await createRule({
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

  // Toggle rule enabled
  async function handleToggleRule(rule: ApprovalRule) {
    await toggleRule({
      path: `/api/v1/admin/approval/rules/${rule.id}`,
      body: { enabled: !rule.enabled },
    });
  }

  // Delete rule
  async function handleDeleteRule(ruleId: string) {
    await deleteRule({
      path: `/api/v1/admin/approval/rules/${ruleId}`,
    });
  }

  // Review approval request
  async function handleReview(requestId: string, action: "approve" | "deny") {
    const result = await reviewRequest({
      path: `/api/v1/admin/approval/queue/${requestId}`,
      body: { action, comment: reviewComments[requestId] || undefined },
      itemId: requestId,
    });
    if (result.ok) {
      setReviewComments((prev) => { const next = { ...prev }; delete next[requestId]; return next; });
    }
  }

  const rules = rulesData?.rules ?? [];
  const requests = queueData?.requests ?? [];
  const pendingCount = requests.filter((r) => r.status === "pending").length;
  const isLoading = rulesLoading || queueLoading;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Approval Workflows</h1>
        <p className="text-sm text-muted-foreground">
          Require sign-off for queries touching sensitive tables, columns, or exceeding cost thresholds.
        </p>
      </div>

      {mutationError && <ErrorBanner message={mutationError} onRetry={clearMutationError} />}

      <AdminContentWrapper
        loading={isLoading}
        error={gateError?.status && [401, 403, 404].includes(gateError.status) ? gateError : null}
        feature="Approval Workflows"
        onRetry={() => { refetchRules(); refetchQueue(); }}
      >
        {rulesError && !(rulesError.status && [401, 403, 404].includes(rulesError.status)) && (
          <ErrorBanner message={friendlyError(rulesError)} />
        )}
        {queueError && !(queueError.status && [401, 403, 404].includes(queueError.status)) && (
          <ErrorBanner message={friendlyError(queueError)} />
        )}

        <Tabs defaultValue="rules">
        <TabsList>
          <TabsTrigger value="rules">Rules</TabsTrigger>
          <TabsTrigger value="queue">
            Approval Queue
            {pendingCount > 0 && (
              <Badge variant="destructive" className="ml-2 size-5 justify-center rounded-full p-0 text-xs">
                {pendingCount}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* ── Rules Tab ───────────────────────────────────────────── */}
        <TabsContent value="rules" className="space-y-4">
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
              <Button size="sm" onClick={() => setShowCreateForm(!showCreateForm)}>
                <Plus className="mr-1 size-4" />
                Add Rule
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
                      <Button type="submit" size="sm" disabled={creatingRule}>
                        {creatingRule && <Loader2 className="mr-1 size-4 animate-spin" />}
                        Create Rule
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setShowCreateForm(false)}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                </Form>
              )}

              {isLoading ? (
                <LoadingState message="Loading approval rules..." />
              ) : rules.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No approval rules configured. Click "Add Rule" to create one.
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
        </TabsContent>

        {/* ── Queue Tab ───────────────────────────────────────────── */}
        <TabsContent value="queue" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Approval Queue</CardTitle>
                <CardDescription>
                  Review and approve or deny pending query requests.
                </CardDescription>
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder="Filter by status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="denied">Denied</SelectItem>
                  <SelectItem value="expired">Expired</SelectItem>
                </SelectContent>
              </Select>
            </CardHeader>
            <CardContent>
              {queueLoading ? (
                <LoadingState message="Loading approval queue..." />
              ) : requests.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No approval requests found.
                </p>
              ) : (
                <div className="space-y-4">
                  {requests.map((req) => (
                    <div key={req.id} className="rounded-lg border p-4 space-y-3">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            {statusBadge(req.status)}
                            <span className="text-xs text-muted-foreground">
                              Rule: {req.ruleName}
                            </span>
                          </div>
                          <p className="mt-1 text-sm">
                            <span className="font-medium">Requester:</span>{" "}
                            {req.requesterEmail ?? req.requesterId}
                          </p>
                          {req.explanation && (
                            <p className="mt-1 text-sm text-muted-foreground">
                              {req.explanation}
                            </p>
                          )}
                        </div>
                        <div className="text-right text-xs text-muted-foreground whitespace-nowrap">
                          <div>{new Date(req.createdAt).toLocaleString()}</div>
                          <div>Expires: {new Date(req.expiresAt).toLocaleString()}</div>
                        </div>
                      </div>

                      <div className="rounded bg-muted p-3 font-mono text-xs overflow-x-auto">
                        {req.querySql}
                      </div>

                      <div className="flex flex-wrap gap-1">
                        {req.tablesAccessed.map((t) => (
                          <Badge key={t} variant="outline" className="text-xs">
                            {t}
                          </Badge>
                        ))}
                      </div>

                      {req.status === "pending" && (
                        <div className="flex items-end gap-2 pt-2 border-t">
                          <div className="flex-1">
                            <Label htmlFor={`comment-${req.id}`} className="text-xs">
                              Comment (optional)
                            </Label>
                            <Textarea
                              id={`comment-${req.id}`}
                              placeholder="Add a comment..."
                              className="mt-1 h-16"
                              value={reviewComments[req.id] ?? ""}
                              onChange={(e) => {
                                setReviewComments((prev) => ({ ...prev, [req.id]: e.target.value }));
                              }}
                            />
                          </div>
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              onClick={() => handleReview(req.id, "approve")}
                              disabled={isReviewing(req.id)}
                            >
                              {isReviewing(req.id) ? (
                                <Loader2 className="mr-1 size-4 animate-spin" />
                              ) : (
                                <CheckCircle2 className="mr-1 size-4" />
                              )}
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => handleReview(req.id, "deny")}
                              disabled={isReviewing(req.id)}
                            >
                              <XCircle className="mr-1 size-4" />
                              Deny
                            </Button>
                          </div>
                        </div>
                      )}

                      {req.reviewerId && (
                        <div className="text-xs text-muted-foreground border-t pt-2">
                          Reviewed by {req.reviewerEmail ?? req.reviewerId}
                          {req.reviewedAt && ` on ${new Date(req.reviewedAt).toLocaleString()}`}
                          {req.reviewComment && ` — "${req.reviewComment}"`}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      </AdminContentWrapper>
    </div>
  );
}
