"use client";

import { useEffect, useState } from "react";
import type { AuditRetentionPolicy } from "@useatlas/types";
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
import { ShieldAlert, Clock, Trash2, UserX } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────

// Wire shape is the canonical `AuditRetentionPolicy` from `@useatlas/types`
// — imported rather than re-declared so a column rename in the EE layer
// breaks the panel at `tsc` time instead of drifting silently.

// Two common compliance windows (7y SOC 2 / HIPAA, 5y NIST) plus unlimited /
// custom. The 7-year / 2555-day default is the Phase 1 design-doc recommendation
// (see ee/src/audit/retention.ts + design/admin-action-log-retention.md).
const RETENTION_PRESETS = ["2555", "1825", "365", "custom", "unlimited"] as const;
type RetentionPreset = (typeof RETENTION_PRESETS)[number];

function isRetentionPreset(v: string): v is RetentionPreset {
  return (RETENTION_PRESETS as readonly string[]).includes(v);
}

function presetFromDays(days: number | null): RetentionPreset {
  if (days === null) return "unlimited";
  if (days === 2555) return "2555";
  if (days === 1825) return "1825";
  if (days === 365) return "365";
  return "custom";
}

function daysFromPreset(preset: RetentionPreset, customDays: number): number | null {
  if (preset === "unlimited") return null;
  if (preset === "2555") return 2555;
  if (preset === "1825") return 1825;
  if (preset === "365") return 365;
  return customDays;
}

const INITIATED_BY_UI_VALUES = ["self_request", "dsr_request"] as const;
type InitiatedBy = (typeof INITIATED_BY_UI_VALUES)[number];

function isInitiatedBy(v: string): v is InitiatedBy {
  return (INITIATED_BY_UI_VALUES as readonly string[]).includes(v);
}

/**
 * Parse `res.json()` with a typed fallback. A misconfigured proxy can return
 * a 2xx with a non-JSON body — `res.json()` throws an unhelpful
 * "Unexpected token" error that surfaces as a generic banner. Returns
 * `undefined` on parse failure so the caller decides the fallback message.
 * Mirrors the starter-prompts fix (PR #1511).
 */
async function safeJson<T>(res: Response): Promise<T | undefined> {
  try {
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

// ── Component ─────────────────────────────────────────────────────

export function AdminActionRetentionPanel() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  const [policy, setPolicy] = useState<AuditRetentionPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Policy form state
  const [preset, setPreset] = useState<RetentionPreset>("2555");
  const [customDays, setCustomDays] = useState(2555);
  const [hardDeleteDelay, setHardDeleteDelay] = useState(30);

  // Purge state
  const [purgeResult, setPurgeResult] = useState<string | null>(null);

  // Erase state
  const [eraseUserId, setEraseUserId] = useState("");
  const [eraseInitiatedBy, setEraseInitiatedBy] = useState<InitiatedBy>("dsr_request");
  const [erasePreviewCount, setErasePreviewCount] = useState<number | null>(null);
  const [erasePreviewError, setErasePreviewError] = useState<string | null>(null);
  const [erasePreviewLoading, setErasePreviewLoading] = useState(false);
  const [eraseResult, setEraseResult] = useState<string | null>(null);
  const [eraseDialogOpen, setEraseDialogOpen] = useState(false);

  // Mutation hooks
  const { mutate: saveMutate, saving, error: saveError, clearError: clearSaveError } =
    useAdminMutation<{ policy: AuditRetentionPolicy }>({
      path: "/api/v1/admin/audit/admin-action-retention",
      method: "PUT",
    });

  const { mutate: purgeMutate, saving: purging, error: purgeError, clearError: clearPurgeError } =
    useAdminMutation<{ results: Array<{ orgId: string; deletedCount: number }> }>({
      path: "/api/v1/admin/audit/admin-action-retention/purge",
      method: "POST",
    });

  const { mutate: eraseMutate, saving: erasing, error: eraseError, clearError: clearEraseError } =
    useAdminMutation<{ anonymizedRowCount: number }>({
      path: "/api/v1/admin/audit/erase-user",
      method: "POST",
    });

  // Fetch current policy
  useEffect(() => {
    let cancelled = false;
    async function fetchPolicy() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${apiUrl}/api/v1/admin/audit/admin-action-retention`, { credentials });
        if (!res.ok) {
          if (res.status === 403) {
            if (!cancelled) setError("Enterprise license required for admin-action retention settings.");
            return;
          }
          const e = await extractFetchError(res);
          if (!cancelled) setError(e.message);
          return;
        }
        const data = await safeJson<{ policy: AuditRetentionPolicy | null }>(res);
        if (!data) {
          if (!cancelled) setError("Server returned a non-JSON response. Check your proxy / deploy configuration.");
          return;
        }
        if (!cancelled) {
          const p = data.policy;
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
          setError(err instanceof Error ? err.message : "Failed to load admin-action retention policy");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchPolicy();
    return () => { cancelled = true; };
  }, [apiUrl, credentials]);

  // Clear the transient save-success banner on unmount so a state update
  // doesn't land on a disposed component if the user navigates away mid-flash.
  useEffect(() => {
    if (!saveSuccess) return;
    const handle = setTimeout(() => setSaveSuccess(false), 3000);
    return () => clearTimeout(handle);
  }, [saveSuccess]);

  async function handleSave() {
    setSaveSuccess(false);
    clearSaveError();
    const retentionDays = daysFromPreset(preset, customDays);
    const result = await saveMutate({
      body: { retentionDays, hardDeleteDelayDays: hardDeleteDelay },
    });
    if (result.ok && result.data) {
      setPolicy(result.data.policy);
      // Banner auto-clears via the unmount-safe effect above.
      setSaveSuccess(true);
    }
  }

  async function handlePurge() {
    setPurgeResult(null);
    const result = await purgeMutate();
    if (result.ok && result.data) {
      const total = result.data.results.reduce((sum, r) => sum + r.deletedCount, 0);
      setPurgeResult(total > 0
        ? `Successfully purged ${total.toLocaleString()} admin-action entries past the retention window.`
        : "No admin-action entries past the retention window.");
    }
  }

  // Preview the row count before opening the confirm dialog. Reveals the
  // erasure's blast radius (N rows across scope=platform + scope=workspace)
  // so an admin doesn't click through on a typo'd userId. A zero-row
  // preview still opens the dialog — the erasure's `user.erase` audit row
  // is forensic evidence the request was processed even if nothing scrubs.
  async function handleLoadPreview() {
    setErasePreviewCount(null);
    setErasePreviewError(null);
    setEraseResult(null);
    clearEraseError();
    const trimmed = eraseUserId.trim();
    if (!trimmed) {
      setErasePreviewError("Enter a user ID to preview.");
      return;
    }
    setErasePreviewLoading(true);
    try {
      const qs = new URLSearchParams({ userId: trimmed });
      const res = await fetch(
        `${apiUrl}/api/v1/admin/audit/erase-user/preview?${qs.toString()}`,
        { credentials },
      );
      if (!res.ok) {
        const e = await extractFetchError(res);
        setErasePreviewError(e.message);
        return;
      }
      const data = await safeJson<{ anonymizableRowCount: number }>(res);
      if (!data || typeof data.anonymizableRowCount !== "number") {
        setErasePreviewError("Preview response was malformed. Try again, or contact support if this persists.");
        return;
      }
      setErasePreviewCount(data.anonymizableRowCount);
      setEraseDialogOpen(true);
    } catch (err) {
      setErasePreviewError(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setErasePreviewLoading(false);
    }
  }

  async function handleErase() {
    const trimmed = eraseUserId.trim();
    if (!trimmed) return;
    const result = await eraseMutate({
      body: { userId: trimmed, initiatedBy: eraseInitiatedBy },
    });
    setEraseDialogOpen(false);
    if (result.ok && result.data) {
      setEraseResult(
        result.data.anonymizedRowCount > 0
          ? `Scrubbed ${result.data.anonymizedRowCount.toLocaleString()} admin-action row${result.data.anonymizedRowCount === 1 ? "" : "s"} for user ${trimmed}.`
          : `No admin-action rows to scrub for user ${trimmed}. Erasure request still recorded.`,
      );
      setErasePreviewCount(null);
    }
  }

  if (loading) {
    return <LoadingState message="Loading admin-action retention settings..." />;
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
          value={policy?.retentionDays ? `${policy.retentionDays.toLocaleString()} days` : "Unlimited"}
          icon={<ShieldAlert className="size-4" />}
          description={
            policy?.retentionDays === 2555
              ? "7 years (recommended)"
              : policy?.retentionDays === 1825
                ? "5 years"
                : policy?.retentionDays === 365
                  ? "1 year"
                  : undefined
          }
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
            : "Never"}
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
          <CardTitle>Admin Action Retention Policy</CardTitle>
          <CardDescription>
            Governs how long entries in the admin-action audit log are retained before hard-delete.
            Recommended default is 7 years (2555 days) to match SOC 2 / HIPAA / ISO 27001 for
            privileged-action logs. Admin-action purge is a direct hard-delete — no soft-delete
            recovery stage.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="admin-action-retention-preset">Retention period</Label>
              <Select
                value={preset}
                onValueChange={(v) => {
                  // Runtime guard — SelectItem `value` strings and the
                  // `RETENTION_PRESETS` tuple are two sources of truth;
                  // an invalid value can only mean a future SelectItem
                  // typo, which we swallow rather than cast-and-pray.
                  if (isRetentionPreset(v)) setPreset(v);
                }}
              >
                <SelectTrigger id="admin-action-retention-preset" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="2555">7 years (recommended)</SelectItem>
                  <SelectItem value="1825">5 years</SelectItem>
                  <SelectItem value="365">1 year</SelectItem>
                  <SelectItem value="custom">Custom</SelectItem>
                  <SelectItem value="unlimited">Unlimited</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {preset === "custom" && (
              <div className="space-y-2">
                <Label htmlFor="admin-action-custom-days">Custom days (min 7)</Label>
                <Input
                  id="admin-action-custom-days"
                  type="number"
                  min={7}
                  value={customDays}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "") return;
                    const n = Number.parseInt(v, 10);
                    if (Number.isFinite(n) && n >= 7) setCustomDays(n);
                  }}
                  className="w-full"
                />
                <p className="text-xs text-muted-foreground">
                  Server rejects values below 7 days. Type a valid integer.
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="admin-action-hard-delete-delay">Hard delete delay (days)</Label>
              <Input
                id="admin-action-hard-delete-delay"
                type="number"
                min={0}
                value={hardDeleteDelay}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "") return;
                  const n = Number.parseInt(v, 10);
                  if (Number.isFinite(n) && n >= 0) setHardDeleteDelay(n);
                }}
                className="w-full"
              />
              <p className="text-xs text-muted-foreground">
                Reserved for future parity with audit-log retention. Default 30.
              </p>
            </div>
          </div>

          <MutationErrorSurface
            error={saveError}
            feature="Admin Action Retention"
            onRetry={clearSaveError}
          />
          {saveSuccess && (
            <p className="text-sm text-green-600">Admin-action retention policy saved successfully.</p>
          )}

          <div className="flex items-center gap-3">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : "Save Policy"}
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
                  <AlertDialogTitle>Purge expired admin-action entries?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Permanently deletes admin-action log entries past the retention window.
                    This is a direct hard-delete — there is no soft-delete recovery window for
                    the admin-action log.
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
            feature="Admin Action Retention"
            onRetry={clearPurgeError}
          />
          {purgeResult && (
            <p className="text-sm text-muted-foreground">{purgeResult}</p>
          )}
        </CardContent>
      </Card>

      {/* User erasure */}
      <Card>
        <CardHeader>
          <CardTitle>Erase user (right-to-erasure)</CardTitle>
          <CardDescription>
            Scrubs <code>actor_id</code> and <code>actor_email</code> from every admin-action log
            row the user authored. Rows survive so the sequence of admin actions remains
            reconstructable without the identifier. Use for GDPR / CCPA DSR processing.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="erase-user-id">User ID</Label>
              <Input
                id="erase-user-id"
                value={eraseUserId}
                onChange={(e) => setEraseUserId(e.target.value)}
                placeholder="e.g. usr_abc123"
                className="w-full"
              />
              <p className="text-xs text-muted-foreground">
                Find user IDs in the <code>/admin/users</code> page or in an audit-log row.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="erase-initiated-by">Initiator</Label>
              <Select
                value={eraseInitiatedBy}
                onValueChange={(v) => {
                  if (isInitiatedBy(v)) setEraseInitiatedBy(v);
                }}
              >
                <SelectTrigger id="erase-initiated-by" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="dsr_request">DSR request (admin-processed)</SelectItem>
                  <SelectItem value="self_request">Self-service (user-initiated)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Identifiers are removed from the audit log. Pino / operational logs are controlled
            by your log-aggregator retention policy.
          </p>

          <div className="flex items-center gap-3">
            <AlertDialog open={eraseDialogOpen} onOpenChange={setEraseDialogOpen}>
              <Button
                variant="destructive"
                disabled={erasePreviewLoading || erasing || !eraseUserId.trim()}
                onClick={handleLoadPreview}
              >
                <UserX className="mr-1.5 size-3.5" />
                {erasePreviewLoading ? "Loading preview..." : erasing ? "Erasing..." : "Erase user"}
              </Button>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Erase user {eraseUserId.trim() || ""}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    {/*
                     * `erasePreviewCount === null` is unreachable here — the
                     * dialog only opens after `handleLoadPreview` sets the
                     * count. Kept as a defensive branch so a future refactor
                     * that decouples "load preview" from "open dialog"
                     * doesn't render a blank body.
                     */}
                    {erasePreviewCount === null
                      ? "Loading preview..."
                      : erasePreviewCount === 0
                        ? "No admin-action rows authored by this user. The erasure request will still be recorded in the audit trail as processed."
                        : `This will permanently scrub ${erasePreviewCount.toLocaleString()} admin-action row${erasePreviewCount === 1 ? "" : "s"} authored by this user. actor_id and actor_email become NULL; the row itself survives with anonymized_at = now().`}
                    <br />
                    <br />
                    <strong>Initiator:</strong> {eraseInitiatedBy === "dsr_request" ? "DSR request (admin-processed)" : "Self-service (user-initiated)"}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleErase}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Confirm erasure
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>

          {erasePreviewError && <ErrorBanner message={erasePreviewError} />}
          <MutationErrorSurface
            error={eraseError}
            feature="User Erasure"
            onRetry={clearEraseError}
          />
          {eraseResult && (
            <p className="text-sm text-muted-foreground">{eraseResult}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
