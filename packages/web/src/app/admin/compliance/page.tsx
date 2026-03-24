"use client";

import { useState } from "react";
import { useQueryStates } from "nuqs";
import { useAtlasConfig } from "@/ui/context";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  FormDialog,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/form-dialog";
import { z } from "zod";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  ShieldCheck,
  Eye,
  EyeOff,
  CheckCircle2,
  XCircle,
  Loader2,
  Hash,
  AlertTriangle,
  FileText,
  Download,
  Search,
} from "lucide-react";
import type {
  PIIColumnClassification,
  PIICategory,
  MaskingStrategy,
  PIIConfidence,
  DataAccessReport,
  UserActivityReport,
  ComplianceReportType,
} from "@/ui/lib/types";
import { PII_CATEGORIES, MASKING_STRATEGIES } from "@/ui/lib/types";
import { complianceSearchParams } from "./search-params";

// ── Types ─────────────────────────────────────────────────────────

interface ClassificationsResponse {
  classifications: PIIColumnClassification[];
}

const CATEGORY_LABELS: Record<PIICategory, string> = {
  email: "Email",
  phone: "Phone",
  ssn: "SSN",
  credit_card: "Credit Card",
  name: "Name",
  ip_address: "IP Address",
  date_of_birth: "Date of Birth",
  address: "Address",
  passport: "Passport",
  driver_license: "Driver License",
  other: "Other",
};

const STRATEGY_LABELS: Record<MaskingStrategy, string> = {
  full: "Full Mask (***)",
  partial: "Partial Mask",
  hash: "Hash",
  redact: "Redact",
};

function confidenceBadge(confidence: PIIConfidence) {
  switch (confidence) {
    case "high":
      return <Badge variant="outline" className="gap-1 border-red-500 text-red-600"><AlertTriangle className="size-3" />High</Badge>;
    case "medium":
      return <Badge variant="outline" className="gap-1 border-yellow-500 text-yellow-600"><AlertTriangle className="size-3" />Medium</Badge>;
    case "low":
      return <Badge variant="secondary" className="gap-1">Low</Badge>;
  }
}

function strategyIcon(strategy: MaskingStrategy) {
  switch (strategy) {
    case "full":
      return <EyeOff className="size-4" />;
    case "partial":
      return <Eye className="size-4" />;
    case "hash":
      return <Hash className="size-4" />;
    case "redact":
      return <XCircle className="size-4" />;
  }
}

function defaultDateRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 30);
  return {
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
  };
}

// ── Main Page ─────────────────────────────────────────────────────

export default function CompliancePage() {
  return (
    <ErrorBoundary>
      <CompliancePageContent />
    </ErrorBoundary>
  );
}

function CompliancePageContent() {
  const [params, setParams] = useQueryStates(complianceSearchParams);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Compliance</h1>
        <p className="text-muted-foreground text-sm">
          PII classifications, data access reports, and user activity audits.
        </p>
      </div>

      <Tabs value={params.tab} onValueChange={(v) => setParams({ tab: v as "classifications" | "reports" })}>
        <TabsList>
          <TabsTrigger value="classifications" className="gap-1.5">
            <ShieldCheck className="size-4" />
            PII Classifications
          </TabsTrigger>
          <TabsTrigger value="reports" className="gap-1.5">
            <FileText className="size-4" />
            Reports
          </TabsTrigger>
        </TabsList>

        <TabsContent value="classifications" className="mt-6">
          <ClassificationsTab />
        </TabsContent>

        <TabsContent value="reports" className="mt-6">
          <ReportsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

const classificationEditSchema = z.object({
  category: z.string().min(1, "Category is required"),
  maskingStrategy: z.string().min(1, "Strategy is required"),
});

// ── Classifications Tab ───────────────────────────────────────────

function ClassificationsTab() {
  const { data, loading, error, refetch } = useAdminFetch<ClassificationsResponse>(
    "/api/v1/admin/compliance/classifications",
    { transform: (json) => json as ClassificationsResponse },
  );

  const [editingId, setEditingId] = useState<string | null>(null);

  const { mutate, saving, error: actionError } = useAdminMutation({
    method: "PUT",
    invalidates: refetch,
  });

  if (error?.status === 401 || error?.status === 403 || error?.status === 404) {
    return <FeatureGate status={error.status} feature="PII Compliance" />;
  }

  const classifications = data?.classifications ?? [];

  async function handleUpdate(id: string, values: { category: string; maskingStrategy: string }) {
    const result = await mutate({
      path: `/api/v1/admin/compliance/classifications/${id}`,
      body: {
        category: values.category || undefined,
        maskingStrategy: values.maskingStrategy || undefined,
        reviewed: true,
      },
    });
    if (result !== undefined) {
      setEditingId(null);
    }
  }

  async function handleDismiss(id: string) {
    await mutate({
      path: `/api/v1/admin/compliance/classifications/${id}`,
      body: { dismissed: true, reviewed: true },
    });
  }

  async function handleBulkReview() {
    const unreviewed = classifications.filter((c) => !c.reviewed);
    await Promise.all(
      unreviewed.map((cls) =>
        mutate({
          path: `/api/v1/admin/compliance/classifications/${cls.id}`,
          body: { reviewed: true },
        }),
      ),
    );
  }

  const unreviewedCount = classifications.filter((c) => !c.reviewed).length;
  const editingItem = classifications.find((c) => c.id === editingId);

  return (
    <div className="space-y-6">
      {unreviewedCount > 0 && (
        <div className="flex justify-end">
          <Button onClick={handleBulkReview} disabled={saving} size="sm" variant="outline">
            {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : <CheckCircle2 className="mr-2 size-4" />}
            Mark All Reviewed ({unreviewedCount})
          </Button>
        </div>
      )}

      {actionError && <ErrorBanner message={actionError} />}

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total PII Columns</CardDescription>
            <CardTitle className="text-2xl">{loading ? "—" : classifications.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>High Confidence</CardDescription>
            <CardTitle className="text-2xl text-red-600">
              {loading ? "—" : classifications.filter((c) => c.confidence === "high").length}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Unreviewed</CardDescription>
            <CardTitle className="text-2xl text-yellow-600">
              {loading ? "—" : unreviewedCount}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Tables Affected</CardDescription>
            <CardTitle className="text-2xl">
              {loading ? "—" : new Set(classifications.map((c) => c.tableName)).size}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Classifications table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-5" />
            Detected PII Columns
          </CardTitle>
          <CardDescription>
            Columns detected as containing personally identifiable information during profiling.
            Review classifications and adjust masking strategies as needed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <LoadingState message="Loading PII classifications..." />
          ) : classifications.length === 0 ? (
            <p className="text-muted-foreground py-8 text-center text-sm">
              No PII columns detected. Run the profiler to scan your database.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Table</TableHead>
                  <TableHead>Column</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Confidence</TableHead>
                  <TableHead>Masking</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {classifications.map((cls) => (
                  <TableRow key={cls.id}>
                    <TableCell className="font-mono text-sm">{cls.tableName}</TableCell>
                    <TableCell className="font-mono text-sm">{cls.columnName}</TableCell>
                    <TableCell>{CATEGORY_LABELS[cls.category] ?? cls.category}</TableCell>
                    <TableCell>{confidenceBadge(cls.confidence)}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        {strategyIcon(cls.maskingStrategy)}
                        <span className="text-sm">{STRATEGY_LABELS[cls.maskingStrategy] ?? cls.maskingStrategy}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {cls.reviewed ? (
                        <Badge variant="outline" className="gap-1 border-green-500 text-green-600">
                          <CheckCircle2 className="size-3" />Reviewed
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="gap-1 border-yellow-500 text-yellow-600">
                          Pending
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditingId(cls.id)}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-muted-foreground"
                          onClick={() => handleDismiss(cls.id)}
                          disabled={saving}
                        >
                          Dismiss
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Edit dialog */}
      <FormDialog
        open={!!editingId}
        onOpenChange={(open) => { if (!open) setEditingId(null); }}
        title="Edit PII Classification"
        description={editingItem ? `${editingItem.tableName}.${editingItem.columnName}` : ""}
        schema={classificationEditSchema}
        defaultValues={{
          category: editingItem?.category ?? "",
          maskingStrategy: editingItem?.maskingStrategy ?? "",
        }}
        onSubmit={async (values) => {
          if (editingId) await handleUpdate(editingId, values);
        }}
        submitLabel="Save Changes"
        saving={saving}
        serverError={actionError}
      >
        {() => (
          <>
            <FormField
              name="category"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>PII Category</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {PII_CATEGORIES.map((cat) => (
                        <SelectItem key={cat} value={cat}>
                          {CATEGORY_LABELS[cat]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              name="maskingStrategy"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Masking Strategy</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {MASKING_STRATEGIES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {STRATEGY_LABELS[s]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </>
        )}
      </FormDialog>
    </div>
  );
}

// ── Reports Tab ──────────────────────────────────────────────────

function ReportsTab() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";
  const [params, setParams] = useQueryStates(complianceSearchParams);

  const defaults = defaultDateRange();
  const from = params.from || defaults.from;
  const to = params.to || defaults.to;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dataAccessReport, setDataAccessReport] = useState<DataAccessReport | null>(null);
  const [userActivityReport, setUserActivityReport] = useState<UserActivityReport | null>(null);

  async function fetchReport() {
    setLoading(true);
    setError(null);
    setDataAccessReport(null);
    setUserActivityReport(null);

    const qs = new URLSearchParams({
      startDate: from,
      endDate: to,
      format: "json",
    });
    if (params.userId) qs.set("userId", params.userId);
    if (params.role) qs.set("role", params.role);
    if (params.table) qs.set("table", params.table);

    const endpoint = params.reportType === "data-access"
      ? "data-access"
      : "user-activity";

    try {
      const res = await fetch(
        `${apiUrl}/api/v1/admin/compliance/reports/${endpoint}?${qs}`,
        { credentials },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as Record<string, string>).message ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (params.reportType === "data-access") {
        setDataAccessReport(data as DataAccessReport);
      } else {
        setUserActivityReport(data as UserActivityReport);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const [exporting, setExporting] = useState(false);

  async function exportCSV() {
    setExporting(true);
    setError(null);

    const qs = new URLSearchParams({
      startDate: from,
      endDate: to,
      format: "csv",
    });
    if (params.userId) qs.set("userId", params.userId);
    if (params.role) qs.set("role", params.role);
    if (params.table) qs.set("table", params.table);

    const endpoint = params.reportType === "data-access"
      ? "data-access"
      : "user-activity";

    try {
      const res = await fetch(
        `${apiUrl}/api/v1/admin/compliance/reports/${endpoint}?${qs}`,
        { credentials },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as Record<string, string>).message ?? `HTTP ${res.status}: ${res.statusText}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${endpoint}-report-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }

  function exportJSON() {
    if (params.reportType === "data-access" && dataAccessReport) {
      downloadJSON(dataAccessReport, "data-access-report");
    } else if (params.reportType === "user-activity" && userActivityReport) {
      downloadJSON(userActivityReport, "user-activity-report");
    } else {
      setError("No report data to export. Generate a report first.");
    }
  }

  return (
    <div className="space-y-6">
      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Search className="size-5" />
            Report Filters
          </CardTitle>
          <CardDescription>
            Configure filters and generate a compliance report.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-2">
              <label className="text-sm font-medium">Report Type</label>
              <Select
                value={params.reportType}
                onValueChange={(v) => {
                  setParams({ reportType: v as ComplianceReportType });
                  setDataAccessReport(null);
                  setUserActivityReport(null);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="data-access">Data Access Report</SelectItem>
                  <SelectItem value="user-activity">User Activity Report</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Start Date</label>
              <Input
                type="date"
                value={from}
                onChange={(e) => setParams({ from: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">End Date</label>
              <Input
                type="date"
                value={to}
                onChange={(e) => setParams({ to: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">User ID</label>
              <Input
                placeholder="Filter by user ID..."
                value={params.userId}
                onChange={(e) => setParams({ userId: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Role</label>
              <Select
                value={params.role || "all"}
                onValueChange={(v) => setParams({ role: v === "all" ? "" : v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All roles</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="owner">Owner</SelectItem>
                  <SelectItem value="member">Member</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Table</label>
              <Input
                placeholder="Filter by table name..."
                value={params.table}
                onChange={(e) => setParams({ table: e.target.value })}
              />
            </div>
          </div>
          <div className="flex gap-2 pt-2">
            <Button onClick={fetchReport} disabled={loading}>
              {loading ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Search className="mr-2 size-4" />}
              Generate Report
            </Button>
            {(dataAccessReport || userActivityReport) && (
              <>
                <Button variant="outline" onClick={exportCSV} disabled={exporting}>
                  {exporting ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Download className="mr-2 size-4" />}
                  Export CSV
                </Button>
                <Button variant="outline" onClick={exportJSON}>
                  <Download className="mr-2 size-4" />
                  Export JSON
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {error && <ErrorBanner message={error} />}

      {loading && <LoadingState message="Generating compliance report..." />}

      {/* Data Access Report Results */}
      {dataAccessReport && (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-4">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Total Queries</CardDescription>
                <CardTitle className="text-2xl">{dataAccessReport.summary.totalQueries.toLocaleString()}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Unique Users</CardDescription>
                <CardTitle className="text-2xl">{dataAccessReport.summary.uniqueUsers}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Unique Tables</CardDescription>
                <CardTitle className="text-2xl">{dataAccessReport.summary.uniqueTables}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>PII Tables Accessed</CardDescription>
                <CardTitle className="text-2xl text-red-600">{dataAccessReport.summary.piiTablesAccessed}</CardTitle>
              </CardHeader>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Data Access Details</CardTitle>
              <CardDescription>
                {dataAccessReport.rows.length} entries for {dataAccessReport.filters.startDate} to {dataAccessReport.filters.endDate}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {dataAccessReport.rows.length === 0 ? (
                <p className="text-muted-foreground py-8 text-center text-sm">
                  No data access records found for the selected period.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Table</TableHead>
                      <TableHead>User</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Queries</TableHead>
                      <TableHead>Columns</TableHead>
                      <TableHead>PII</TableHead>
                      <TableHead>First Access</TableHead>
                      <TableHead>Last Access</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {dataAccessReport.rows.map((row, i) => (
                      <TableRow key={`${row.tableName}-${row.userId}-${i}`}>
                        <TableCell className="font-mono text-sm">{row.tableName}</TableCell>
                        <TableCell>
                          <div className="text-sm">{row.userEmail ?? row.userId}</div>
                        </TableCell>
                        <TableCell>
                          {row.userRole ? (
                            <Badge variant="outline">{row.userRole}</Badge>
                          ) : (
                            <span className="text-muted-foreground text-sm">—</span>
                          )}
                        </TableCell>
                        <TableCell>{row.queryCount.toLocaleString()}</TableCell>
                        <TableCell>
                          <span className="text-muted-foreground text-sm">
                            {row.uniqueColumns.length > 0 ? row.uniqueColumns.join(", ") : "—"}
                          </span>
                        </TableCell>
                        <TableCell>
                          {row.hasPII ? (
                            <Badge variant="outline" className="border-red-500 text-red-600">PII</Badge>
                          ) : (
                            <span className="text-muted-foreground text-sm">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">{new Date(row.firstAccess).toLocaleDateString()}</TableCell>
                        <TableCell className="text-sm">{new Date(row.lastAccess).toLocaleDateString()}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* User Activity Report Results */}
      {userActivityReport && (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Total Users</CardDescription>
                <CardTitle className="text-2xl">{userActivityReport.summary.totalUsers}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Active Users</CardDescription>
                <CardTitle className="text-2xl">{userActivityReport.summary.activeUsers}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Total Queries</CardDescription>
                <CardTitle className="text-2xl">{userActivityReport.summary.totalQueries.toLocaleString()}</CardTitle>
              </CardHeader>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>User Activity Details</CardTitle>
              <CardDescription>
                {userActivityReport.rows.length} users for {userActivityReport.filters.startDate} to {userActivityReport.filters.endDate}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {userActivityReport.rows.length === 0 ? (
                <p className="text-muted-foreground py-8 text-center text-sm">
                  No user activity found for the selected period.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Total Queries</TableHead>
                      <TableHead>Tables Accessed</TableHead>
                      <TableHead>Last Active</TableHead>
                      <TableHead>Last Login</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {userActivityReport.rows.map((row) => (
                      <TableRow key={row.userId}>
                        <TableCell>
                          <div className="text-sm">{row.userEmail ?? row.userId}</div>
                        </TableCell>
                        <TableCell>
                          {row.role ? (
                            <Badge variant="outline">{row.role}</Badge>
                          ) : (
                            <span className="text-muted-foreground text-sm">—</span>
                          )}
                        </TableCell>
                        <TableCell>{row.totalQueries.toLocaleString()}</TableCell>
                        <TableCell>
                          <span className="text-muted-foreground text-sm">
                            {row.tablesAccessed.length > 0 ? row.tablesAccessed.join(", ") : "—"}
                          </span>
                        </TableCell>
                        <TableCell className="text-sm">
                          {row.lastActiveAt ? new Date(row.lastActiveAt).toLocaleDateString() : "—"}
                        </TableCell>
                        <TableCell className="text-sm">
                          {row.lastLoginAt ? new Date(row.lastLoginAt).toLocaleDateString() : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────

function downloadJSON(data: unknown, prefix: string) {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${prefix}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
