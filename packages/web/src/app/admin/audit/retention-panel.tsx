"use client";

import { useState } from "react";
import type { AuditRetentionPolicy } from "@useatlas/types";
import { useAtlasConfig } from "@/ui/context";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { useConfigForm } from "@/ui/hooks/use-config-form";
import { extractFetchError } from "@/ui/lib/fetch-error";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatISODate, parseISODate } from "@/lib/format";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { StatCard } from "@/ui/components/admin/stat-card";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import { RelativeTimestamp } from "@/ui/components/admin/queue";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { Shield, Clock, Trash2, Download } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────

// Wire shape comes from `@useatlas/types` — single source across the EE
// library, API route schemas, and both retention panels.
type RetentionPolicy = AuditRetentionPolicy;

type RetentionPreset = "30" | "90" | "365" | "custom" | "unlimited";

function presetFromDays(days: number | null): RetentionPreset {
  if (days === null) return "unlimited";
  if (days === 30) return "30";
  if (days === 90) return "90";
  if (days === 365) return "365";
  return "custom";
}

function daysFromPreset(preset: RetentionPreset, customDays: number): number | null {
  if (preset === "unlimited") return null;
  if (preset === "30") return 30;
  if (preset === "90") return 90;
  if (preset === "365") return 365;
  return customDays;
}

// Wire + form shapes for the policy config-form loop. The GET response is
// typed (not Zod-validated) to match the previous behavior of casting the
// parsed JSON — the canonical shape lives in `@useatlas/types`.
interface PolicyResponse {
  policy: RetentionPolicy | null;
}

interface RetentionFormValues extends Record<string, unknown> {
  preset: RetentionPreset;
  customDays: number;
  hardDeleteDelay: number;
}

// ── Component ─────────────────────────────────────────────────────

export function RetentionPanel() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  const [saveSuccess, setSaveSuccess] = useState(false);

  const form = useConfigForm<
    PolicyResponse,
    RetentionFormValues,
    { policy: RetentionPolicy }
  >({
    path: "/api/v1/admin/audit/retention",
    saveMethod: "PUT",
    toForm: (d) => {
      if (!d.policy) {
        return { preset: "unlimited", customDays: 90, hardDeleteDelay: 30 };
      }
      const pr = presetFromDays(d.policy.retentionDays);
      return {
        preset: pr,
        customDays:
          pr === "custom" && d.policy.retentionDays !== null
            ? d.policy.retentionDays
            : 90,
        hardDeleteDelay: d.policy.hardDeleteDelayDays,
      };
    },
    toPayload: (v) => ({
      retentionDays: daysFromPreset(v.preset, v.customDays),
      hardDeleteDelayDays: v.hardDeleteDelay,
    }),
  });

  const policy = form.data?.policy ?? null;

  // Export state
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportFormat, setExportFormat] = useState<"csv" | "json">("csv");
  const [exportStartDate, setExportStartDate] = useState("");
  const [exportEndDate, setExportEndDate] = useState("");

  // Purge state
  const [purgeResult, setPurgeResult] = useState<string | null>(null);

  const { mutate: purgeMutate, saving: purging, error: purgeError, clearError: clearPurgeError } =
    useAdminMutation<{ results: Array<{ orgId: string; softDeletedCount: number }> }>({
      path: "/api/v1/admin/audit/retention/purge",
      method: "POST",
    });

  async function handleSave() {
    setSaveSuccess(false);
    const result = await form.save();
    if (result.ok) {
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    }
  }

  async function handleExport() {
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch(`${apiUrl}/api/v1/admin/audit/retention/export`, {
        method: "POST",
        credentials,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format: exportFormat,
          ...(exportStartDate && { startDate: exportStartDate }),
          ...(exportEndDate && { endDate: exportEndDate }),
        }),
      });
      if (!res.ok) {
        const e = await extractFetchError(res);
        setExportError(e.message);
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const ext = exportFormat === "csv" ? "csv" : "json";
      a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  async function handlePurge() {
    setPurgeResult(null);
    const result = await purgeMutate();
    if (result.ok && result.data) {
      const total = result.data.results.reduce((sum, r) => sum + r.softDeletedCount, 0);
      setPurgeResult(total > 0
        ? `Successfully purged ${total.toLocaleString()} expired entries.`
        : "No expired entries to purge."
      );
    }
  }

  if (form.loading) {
    return <LoadingState message="Loading retention settings..." />;
  }

  if (form.loadError) {
    return (
      <ErrorBanner
        message={
          form.loadError.code === "enterprise_required"
            ? "Enterprise license required for audit retention settings."
            : form.loadError.message
        }
      />
    );
  }

  if (!form.fields) {
    return <LoadingState message="Loading retention settings..." />;
  }
  const { fields } = form;

  return (
    <div className="space-y-6">
      {/* Status cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          title="Retention Period"
          value={policy?.retentionDays ? `${policy.retentionDays} days` : "Unlimited"}
          icon={<Shield className="size-4" />}
        />
        <StatCard
          title="Hard Delete Delay"
          value={`${policy?.hardDeleteDelayDays ?? 30} days`}
          icon={<Clock className="size-4" />}
        />
        <StatCard
          title="Last Purge"
          value={policy?.lastPurgeAt
            ? `${policy.lastPurgeCount?.toLocaleString() ?? 0} entries`
            : "Never"
          }
          description={
            policy?.lastPurgeAt
              ? <RelativeTimestamp iso={policy.lastPurgeAt} />
              : undefined
          }
          icon={<Trash2 className="size-4" />}
        />
      </div>

      {/* Retention config */}
      <Card>
        <CardHeader>
          <CardTitle>Retention Policy</CardTitle>
          <CardDescription>
            Configure how long audit log entries are retained before automatic purge.
            Purged entries are soft-deleted first, then permanently removed after the hard-delete delay.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="retention-preset">Retention period</Label>
              <Select
                value={fields.preset.value}
                onValueChange={(v) => fields.preset.set(v as RetentionPreset)}
              >
                <SelectTrigger id="retention-preset" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="30">30 days</SelectItem>
                  <SelectItem value="90">90 days</SelectItem>
                  <SelectItem value="365">1 year</SelectItem>
                  <SelectItem value="custom">Custom</SelectItem>
                  <SelectItem value="unlimited">Unlimited</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {fields.preset.value === "custom" && (
              <div className="space-y-2">
                <Label htmlFor="custom-days">Custom days (min 7)</Label>
                <Input
                  id="custom-days"
                  type="number"
                  min={7}
                  value={fields.customDays.value}
                  onChange={(e) => fields.customDays.set(parseInt(e.target.value, 10) || 7)}
                  className="w-full"
                />
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="hard-delete-delay">Hard delete delay (days)</Label>
              <Input
                id="hard-delete-delay"
                type="number"
                min={0}
                value={fields.hardDeleteDelay.value}
                onChange={(e) => fields.hardDeleteDelay.set(parseInt(e.target.value, 10) || 0)}
                className="w-full"
              />
              <p className="text-xs text-muted-foreground">
                Days after soft-delete before permanent removal. Default 30.
              </p>
            </div>
          </div>

          <MutationErrorSurface
            error={form.error}
            feature="Audit Retention"
            onRetry={form.clearError}
          />
          {saveSuccess && (
            <p className="text-sm text-green-600">Retention policy saved successfully.</p>
          )}

          <div className="flex items-center gap-3">
            <Button onClick={handleSave} disabled={form.saving}>
              {form.saving ? "Saving..." : "Save Policy"}
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" disabled={purging}>
                  <Trash2 className="mr-1.5 size-3.5" />
                  {purging ? "Purging..." : "Run Purge Now"}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Purge expired audit entries?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Soft-deletes all entries past the retention window. Entries become
                    permanently unrecoverable after the hard-delete delay elapses.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handlePurge}>Run purge</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>

          <MutationErrorSurface
            error={purgeError}
            feature="Audit Retention"
            onRetry={clearPurgeError}
          />
          {purgeResult && (
            <p className="text-sm text-muted-foreground">{purgeResult}</p>
          )}
        </CardContent>
      </Card>

      {/* Compliance export */}
      <Card>
        <CardHeader>
          <CardTitle>Compliance Export</CardTitle>
          <CardDescription>
            Export audit log entries in SOC2-ready format for compliance review.
            Excludes soft-deleted entries.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-2">
              <Label htmlFor="export-format">Format</Label>
              <Select
                value={exportFormat}
                onValueChange={(v) => setExportFormat(v as "csv" | "json")}
              >
                <SelectTrigger id="export-format" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="csv">CSV</SelectItem>
                  <SelectItem value="json">JSON</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="export-start">Start date</Label>
              <DatePicker
                id="export-start"
                value={parseISODate(exportStartDate)}
                onChange={(d) => setExportStartDate(formatISODate(d))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="export-end">End date</Label>
              <DatePicker
                id="export-end"
                value={parseISODate(exportEndDate)}
                onChange={(d) => setExportEndDate(formatISODate(d))}
              />
            </div>
            <Button onClick={handleExport} disabled={exporting} className="h-10">
              <Download className="mr-1.5 size-3.5" />
              {exporting ? "Exporting..." : "Export"}
            </Button>
          </div>

          {exportError && <ErrorBanner message={exportError} />}
        </CardContent>
      </Card>
    </div>
  );
}
