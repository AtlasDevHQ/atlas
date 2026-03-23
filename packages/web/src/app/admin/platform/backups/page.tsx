"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import { StatCard } from "@/ui/components/admin/stat-card";
import { useAdminFetch, friendlyError } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import type { BackupEntry, BackupConfig, BackupStatus } from "@/ui/lib/types";
import {
  Archive,
  CheckCircle2,
  Clock,
  Database,
  HardDrive,
  Loader2,
  RotateCcw,
  Settings2,
  ShieldCheck,
  XCircle,
} from "lucide-react";

// ── Helpers ───────────────────────────────────────────────────────

function statusBadge(status: BackupStatus) {
  switch (status) {
    case "completed":
      return <Badge variant="outline" className="gap-1 border-green-500 text-green-600"><CheckCircle2 className="size-3" />Completed</Badge>;
    case "verified":
      return <Badge variant="outline" className="gap-1 border-blue-500 text-blue-600"><ShieldCheck className="size-3" />Verified</Badge>;
    case "in_progress":
      return <Badge variant="outline" className="gap-1 border-amber-500 text-amber-600"><Loader2 className="size-3 animate-spin" />In Progress</Badge>;
    case "failed":
      return <Badge variant="destructive" className="gap-1"><XCircle className="size-3" />Failed</Badge>;
  }
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(ms / (1000 * 60 * 60));
  if (hours < 1) return "< 1 hour ago";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ── Main Page ─────────────────────────────────────────────────────

export default function BackupsPage() {
  return (
    <ErrorBoundary>
      <BackupsPageContent />
    </ErrorBoundary>
  );
}

function BackupsPageContent() {
  // Data
  const { data: backupsData, loading: backupsLoading, error: backupsError, refetch: refetchBackups } = useAdminFetch<{ backups: BackupEntry[] }>(
    "/api/v1/platform/backups",
  );
  const { data: configData, loading: configLoading, refetch: refetchConfig } = useAdminFetch<BackupConfig>(
    "/api/v1/platform/backups/config",
  );

  // Mutations
  const { mutate: createMutate, saving: creating } = useAdminMutation({ invalidates: refetchBackups });
  const { mutate: verifyMutate } = useAdminMutation({ invalidates: refetchBackups });
  const { mutate: restoreRequestMutate } = useAdminMutation({});
  const { mutate: restoreConfirmMutate, saving: restoring } = useAdminMutation({ invalidates: refetchBackups });
  const { mutate: configMutate, saving: configSaving, error: configError, clearError: clearConfigError } = useAdminMutation({
    method: "PUT",
    path: "/api/v1/platform/backups/config",
    invalidates: refetchConfig,
  });

  // Config dialog
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [editConfig, setEditConfig] = useState<BackupConfig | null>(null);

  // Restore dialog
  const [restoreBackupId, setRestoreBackupId] = useState<string | null>(null);
  const [confirmToken, setConfirmToken] = useState<string | null>(null);

  // Feature gate (after all hooks)
  if (backupsError?.status === 404) return <FeatureGate status={404} feature="Backups" />;
  if (backupsError?.status === 403) return <FeatureGate status={403} feature="Backups" />;
  if (backupsError?.status === 401) return <FeatureGate status={401} feature="Backups" />;

  const backups = backupsData?.backups ?? [];
  const completedBackups = backups.filter((b) => b.status === "completed" || b.status === "verified");
  const totalSize = backups.reduce((sum, b) => sum + (b.sizeBytes ?? 0), 0);
  const lastBackup = backups[0];

  async function handleCreateBackup() {
    await createMutate({ path: "/api/v1/platform/backups" });
  }

  async function handleVerify(id: string) {
    await verifyMutate({ path: `/api/v1/platform/backups/${id}/verify` });
  }

  async function handleRequestRestore(id: string) {
    setRestoreBackupId(id);
    const result = await restoreRequestMutate({ path: `/api/v1/platform/backups/${id}/restore` });
    if (result && typeof result === "object" && "confirmationToken" in result) {
      setConfirmToken((result as { confirmationToken: string }).confirmationToken);
    }
  }

  async function handleConfirmRestore() {
    if (!restoreBackupId || !confirmToken) return;
    await restoreConfirmMutate({
      path: `/api/v1/platform/backups/${restoreBackupId}/restore/confirm`,
      body: { confirmationToken: confirmToken },
    });
    setRestoreBackupId(null);
    setConfirmToken(null);
  }

  function openConfigDialog() {
    setEditConfig(configData ?? { schedule: "0 3 * * *", retentionDays: 30, storagePath: "./backups" });
    clearConfigError();
    setConfigDialogOpen(true);
  }

  async function saveConfig() {
    if (!editConfig) return;
    const result = await configMutate({ body: editConfig as unknown as Record<string, unknown> });
    if (result !== undefined) {
      setConfigDialogOpen(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Backups</h1>
          <p className="text-muted-foreground">Automated backups and disaster recovery for the internal database.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={openConfigDialog} disabled={configLoading}>
            <Settings2 className="mr-2 size-4" />
            Schedule
          </Button>
          <Button size="sm" onClick={handleCreateBackup} disabled={creating}>
            {creating ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Database className="mr-2 size-4" />}
            Create Backup
          </Button>
        </div>
      </div>

      {/* Stat cards */}
      {!backupsLoading && !backupsError && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title="Total Backups"
            value={backups.length}
            icon={<Archive className="size-4" />}
          />
          <StatCard
            title="Restorable"
            value={completedBackups.length}
            icon={<CheckCircle2 className="size-4" />}
          />
          <StatCard
            title="Total Size"
            value={formatSize(totalSize)}
            icon={<HardDrive className="size-4" />}
          />
          <StatCard
            title="Last Backup"
            value={lastBackup ? timeAgo(lastBackup.createdAt) : "Never"}
            icon={<Clock className="size-4" />}
            description={configData ? `Schedule: ${configData.schedule}` : undefined}
          />
        </div>
      )}

      {/* Backups table */}
      {backupsLoading ? (
        <LoadingState message="Loading backups..." />
      ) : backupsError ? (
        <ErrorBanner message={friendlyError(backupsError)} />
      ) : backups.length === 0 ? (
        <Card className="shadow-none">
          <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <Database className="mb-2 size-8" />
            <p>No backups yet. Create your first backup to protect your data.</p>
          </CardContent>
        </Card>
      ) : (
        <Card className="shadow-none">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Age</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {backups.map((backup) => (
                <TableRow key={backup.id}>
                  <TableCell className="font-medium">{formatTimestamp(backup.createdAt)}</TableCell>
                  <TableCell>
                    {statusBadge(backup.status)}
                    {backup.errorMessage && (
                      <p className="mt-1 text-xs text-destructive">{backup.errorMessage}</p>
                    )}
                  </TableCell>
                  <TableCell>{formatSize(backup.sizeBytes)}</TableCell>
                  <TableCell>{timeAgo(backup.createdAt)}</TableCell>
                  <TableCell>{formatTimestamp(backup.retentionExpiresAt)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {(backup.status === "completed") && (
                        <Button variant="ghost" size="sm" onClick={() => handleVerify(backup.id)} title="Verify integrity">
                          <ShieldCheck className="size-4" />
                        </Button>
                      )}
                      {(backup.status === "completed" || backup.status === "verified") && (
                        <Button variant="ghost" size="sm" onClick={() => handleRequestRestore(backup.id)} title="Restore from this backup">
                          <RotateCcw className="size-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* Restore confirmation dialog */}
      <AlertDialog open={!!confirmToken} onOpenChange={(open) => { if (!open) { setConfirmToken(null); setRestoreBackupId(null); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Database Restore</AlertDialogTitle>
            <AlertDialogDescription>
              This will restore the database from backup. A pre-restore backup will be created automatically as a safety net.
              This action cannot be easily undone. Are you sure you want to proceed?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmRestore} disabled={restoring}>
              {restoring ? <><Loader2 className="mr-2 size-4 animate-spin" />Restoring...</> : "Restore Database"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Schedule configuration dialog */}
      <Dialog open={configDialogOpen} onOpenChange={(open) => { if (!open) { setConfigDialogOpen(false); clearConfigError(); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Backup Schedule</DialogTitle>
            <DialogDescription>
              Configure automated backup schedule, retention policy, and storage location.
            </DialogDescription>
          </DialogHeader>
          {configError && <ErrorBanner message={configError} />}
          {editConfig && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="schedule">Schedule (cron expression, UTC)</Label>
                <Input
                  id="schedule"
                  value={editConfig.schedule}
                  onChange={(e) => setEditConfig({ ...editConfig, schedule: e.target.value })}
                  placeholder="0 3 * * *"
                />
                <p className="text-xs text-muted-foreground">Default: &quot;0 3 * * *&quot; (daily at 03:00 UTC)</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="retention">Retention (days)</Label>
                <Input
                  id="retention"
                  type="number"
                  min={1}
                  max={365}
                  value={editConfig.retentionDays}
                  onChange={(e) => setEditConfig({ ...editConfig, retentionDays: parseInt(e.target.value, 10) || 30 })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="storagePath">Storage Path</Label>
                <Input
                  id="storagePath"
                  value={editConfig.storagePath}
                  onChange={(e) => setEditConfig({ ...editConfig, storagePath: e.target.value })}
                  placeholder="./backups"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setConfigDialogOpen(false); clearConfigError(); }}>Cancel</Button>
            <Button onClick={saveConfig} disabled={configSaving}>
              {configSaving ? <><Loader2 className="mr-2 size-4 animate-spin" />Saving...</> : "Save Configuration"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
