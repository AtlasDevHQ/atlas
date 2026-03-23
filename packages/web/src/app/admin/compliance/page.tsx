"use client";

import { useState } from "react";
import { useAtlasConfig } from "@/ui/context";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
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
} from "lucide-react";
import type {
  PIIColumnClassification,
  PIICategory,
  MaskingStrategy,
  PIIConfidence,
} from "@/ui/lib/types";
import { PII_CATEGORIES, MASKING_STRATEGIES } from "@/ui/lib/types";

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

// ── Main Page ─────────────────────────────────────────────────────

export default function CompliancePage() {
  return (
    <ErrorBoundary>
      <CompliancePageContent />
    </ErrorBoundary>
  );
}

function CompliancePageContent() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  const { data, loading, error, refetch } = useAdminFetch<ClassificationsResponse>(
    "/api/v1/admin/compliance/classifications",
    { transform: (json) => json as ClassificationsResponse },
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editCategory, setEditCategory] = useState<string>("");
  const [editStrategy, setEditStrategy] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (error?.status === 401 || error?.status === 403 || error?.status === 404) {
    return <FeatureGate status={error.status} feature="PII Compliance" />;
  }

  const classifications = data?.classifications ?? [];

  async function handleUpdate(id: string) {
    setSaving(true);
    setActionError(null);
    try {
      const res = await fetch(`${apiUrl}/api/v1/admin/compliance/classifications/${id}`, {
        method: "PUT",
        credentials,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: editCategory || undefined,
          maskingStrategy: editStrategy || undefined,
          reviewed: true,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as Record<string, string>).message ?? `HTTP ${res.status}`);
      }
      setEditingId(null);
      refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDismiss(id: string) {
    setSaving(true);
    setActionError(null);
    try {
      const res = await fetch(`${apiUrl}/api/v1/admin/compliance/classifications/${id}`, {
        method: "PUT",
        credentials,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dismissed: true, reviewed: true }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as Record<string, string>).message ?? `HTTP ${res.status}`);
      }
      refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleBulkReview() {
    setSaving(true);
    setActionError(null);
    const unreviewed = classifications.filter((c) => !c.reviewed);
    try {
      await Promise.all(
        unreviewed.map((cls) =>
          fetch(`${apiUrl}/api/v1/admin/compliance/classifications/${cls.id}`, {
            method: "PUT",
            credentials,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reviewed: true }),
          }),
        ),
      );
      refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const unreviewedCount = classifications.filter((c) => !c.reviewed).length;
  const editingItem = classifications.find((c) => c.id === editingId);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">PII Compliance</h1>
          <p className="text-muted-foreground text-sm">
            Review and manage PII column classifications and masking rules.
          </p>
        </div>
        {unreviewedCount > 0 && (
          <Button onClick={handleBulkReview} disabled={saving} size="sm" variant="outline">
            {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : <CheckCircle2 className="mr-2 size-4" />}
            Mark All Reviewed ({unreviewedCount})
          </Button>
        )}
      </div>

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
                          onClick={() => {
                            setEditingId(cls.id);
                            setEditCategory(cls.category);
                            setEditStrategy(cls.maskingStrategy);
                          }}
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
      <Dialog open={!!editingId} onOpenChange={(open) => !open && setEditingId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit PII Classification</DialogTitle>
            <DialogDescription>
              {editingItem && `${editingItem.tableName}.${editingItem.columnName}`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">PII Category</label>
              <Select value={editCategory} onValueChange={setEditCategory}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PII_CATEGORIES.map((cat) => (
                    <SelectItem key={cat} value={cat}>
                      {CATEGORY_LABELS[cat]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Masking Strategy</label>
              <Select value={editStrategy} onValueChange={setEditStrategy}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MASKING_STRATEGIES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {STRATEGY_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingId(null)}>Cancel</Button>
            <Button onClick={() => editingId && handleUpdate(editingId)} disabled={saving}>
              {saving && <Loader2 className="mr-2 size-4 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
