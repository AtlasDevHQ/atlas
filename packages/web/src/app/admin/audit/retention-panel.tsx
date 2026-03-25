"use client";

import { useEffect, useState } from "react";
import { useAtlasConfig } from "@/ui/context";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { extractFetchError } from "@/ui/lib/fetch-error";
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StatCard } from "@/ui/components/admin/stat-card";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { Shield, Clock, Trash2, Download } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────

interface RetentionPolicy {
  orgId: string;
  retentionDays: number | null;
  hardDeleteDelayDays: number;
  updatedAt: string;
  updatedBy: string | null;
  lastPurgeAt: string | null;
  lastPurgeCount: number | null;
}

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

// ── Component ─────────────────────────────────────────────────────

export function RetentionPanel() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  const [policy, setPolicy] = useState<RetentionPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Form state
  const [preset, setPreset] = useState<RetentionPreset>("unlimited");
  const [customDays, setCustomDays] = useState(90);
  const [hardDeleteDelay, setHardDeleteDelay] = useState(30);

  // Export state
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportFormat, setExportFormat] = useState<"csv" | "json">("csv");
  const [exportStartDate, setExportStartDate] = useState("");
  const [exportEndDate, setExportEndDate] = useState("");

  // Purge state
  const [purgeResult, setPurgeResult] = useState<string | null>(null);

  // Mutation hooks
  const { mutate: saveMutate, saving, error: saveError, clearError: clearSaveError } =
    useAdminMutation<{ policy: RetentionPolicy }>({
      path: "/api/v1/admin/audit/retention",
      method: "PUT",
    });

  const { mutate: purgeMutate, saving: purging, error: purgeError } =
    useAdminMutation<{ results: Array<{ orgId: string; softDeletedCount: number }> }>({
      path: "/api/v1/admin/audit/retention/purge",
      method: "POST",
    });

  // Fetch current policy
  useEffect(() => {
    let cancelled = false;
    async function fetchPolicy() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${apiUrl}/api/v1/admin/audit/retention`, { credentials });
        if (!res.ok) {
          if (res.status === 403) {
            if (!cancelled) setError("Enterprise license required for audit retention settings.");
            return;
          }
          const e = await extractFetchError(res);
          if (!cancelled) setError(e.message);
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          const p = data.policy as RetentionPolicy | null;
          setPolicy(p);
          if (p) {
            const pr = presetFromDays(p.retentionDays);
            setPreset(pr);
            if (pr === "custom" && p.retentionDays !== null) {
              setCustomDays(p.retentionDays);
            }
            setHardDeleteDelay(p.hardDeleteDelayDays);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load retention policy");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchPolicy();
    return () => { cancelled = true; };
  }, [apiUrl, credentials]);

  async function handleSave() {
    setSaveSuccess(false);
    clearSaveError();
    const retentionDays = daysFromPreset(preset, customDays);
    const result = await saveMutate({
      body: { retentionDays, hardDeleteDelayDays: hardDeleteDelay },
    });
    if (result.ok && result.data) {
      setPolicy(result.data.policy);
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

  if (loading) {
    return <LoadingState message="Loading retention settings..." />;
  }

  if (error) {
    return <ErrorBanner message={error} />;
  }

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
            ? `${policy.lastPurgeCount?.toLocaleString() ?? 0} entries at ${new Date(policy.lastPurgeAt).toLocaleDateString()}`
            : "Never"
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
                value={preset}
                onValueChange={(v) => setPreset(v as RetentionPreset)}
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

            {preset === "custom" && (
              <div className="space-y-2">
                <Label htmlFor="custom-days">Custom days (min 7)</Label>
                <Input
                  id="custom-days"
                  type="number"
                  min={7}
                  value={customDays}
                  onChange={(e) => setCustomDays(parseInt(e.target.value, 10) || 7)}
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
                value={hardDeleteDelay}
                onChange={(e) => setHardDeleteDelay(parseInt(e.target.value, 10) || 0)}
                className="w-full"
              />
              <p className="text-xs text-muted-foreground">
                Days after soft-delete before permanent removal. Default 30.
              </p>
            </div>
          </div>

          {saveError && <ErrorBanner message={saveError} />}
          {saveSuccess && (
            <p className="text-sm text-green-600">Retention policy saved successfully.</p>
          )}

          <div className="flex items-center gap-3">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : "Save Policy"}
            </Button>
            <Button variant="outline" onClick={handlePurge} disabled={purging}>
              <Trash2 className="mr-1.5 size-3.5" />
              {purging ? "Purging..." : "Run Purge Now"}
            </Button>
          </div>

          {purgeError && <ErrorBanner message={purgeError} />}
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
              <Input
                id="export-start"
                type="date"
                value={exportStartDate}
                onChange={(e) => setExportStartDate(e.target.value)}
                className="w-40"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="export-end">End date</Label>
              <Input
                id="export-end"
                type="date"
                value={exportEndDate}
                onChange={(e) => setExportEndDate(e.target.value)}
                className="w-40"
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
