"use client";

import { type ReactNode, useState } from "react";
import { z } from "zod";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { useAdminFetch, friendlyError } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { useDeployMode } from "@/ui/hooks/use-deploy-mode";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { RegionCardGrid, ComplianceBadge } from "@/ui/components/region-picker";
import {
  RegionPickerItemSchema,
  MigrationStatusResponseSchema,
} from "@/ui/lib/admin-schemas";
import type { RegionPickerItem, RegionMigration } from "@/ui/lib/types";
import { formatDate } from "@/lib/format";
import { Globe, MapPin, AlertTriangle, ArrowRight, Clock, Loader2, XCircle, CheckCircle2, RefreshCw, Ban } from "lucide-react";

// ── Schemas ───────────────────────────────────────────────────────

const ResidencyStatusSchema = z.object({
  configured: z.boolean(),
  region: z.string().nullable(),
  regionLabel: z.string().nullable(),
  assignedAt: z.string().nullable(),
  defaultRegion: z.string(),
  availableRegions: z.array(RegionPickerItemSchema),
});
type ResidencyStatus = z.infer<typeof ResidencyStatusSchema>;

// ── Page ──────────────────────────────────────────────────────────

export default function ResidencyPage() {
  const { deployMode } = useDeployMode();
  const isSaas = deployMode === "saas";

  const { data, loading, error, refetch } = useAdminFetch(
    "/api/v1/admin/residency",
    { schema: ResidencyStatusSchema },
  );

  const { data: migrationData, error: migrationFetchError, refetch: refetchMigration } = useAdminFetch(
    "/api/v1/admin/residency/migration",
    { schema: MigrationStatusResponseSchema },
  );

  const assignMutation = useAdminMutation({
    path: "/api/v1/admin/residency",
    method: "PUT",
    invalidates: refetch,
  });

  const migrateMutation = useAdminMutation({
    path: "/api/v1/admin/residency/migrate",
    method: "POST",
    invalidates: () => { refetch(); refetchMigration(); },
  });

  const retryMutation = useAdminMutation({
    method: "POST",
    invalidates: () => { refetch(); refetchMigration(); },
  });

  const cancelMutation = useAdminMutation({
    method: "POST",
    invalidates: () => { refetch(); refetchMigration(); },
  });

  const handleAssign = async (region: string) => {
    const result = await assignMutation.mutate({ body: { region } });
    return result.ok;
  };

  const handleMigrate = async (targetRegion: string) => {
    const result = await migrateMutation.mutate({ body: { targetRegion } });
    return result.ok;
  };

  const handleRetry = async (migrationId: string) => {
    const result = await retryMutation.mutate({
      path: `/api/v1/admin/residency/migrate/${migrationId}/retry`,
    });
    return result.ok;
  };

  const handleCancel = async (migrationId: string) => {
    const result = await cancelMutation.mutate({
      path: `/api/v1/admin/residency/migrate/${migrationId}/cancel`,
    });
    return result.ok;
  };

  return (
    <div className="p-6">
    <ErrorBoundary>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Data Residency</h1>
          <p className="text-muted-foreground">
            Control where your workspace data is stored for compliance
            requirements.
          </p>
        </div>

        {assignMutation.error && (
          <ErrorBanner
            message={assignMutation.error}
            onRetry={() => {
              assignMutation.clearError();
              refetch();
            }}
          />
        )}

        {migrationFetchError && (
          <ErrorBanner
            message={friendlyError(migrationFetchError)}
            onRetry={refetchMigration}
          />
        )}

        {migrateMutation.error && (
          <ErrorBanner
            message={migrateMutation.error}
            onRetry={() => {
              migrateMutation.clearError();
              refetchMigration();
            }}
          />
        )}

        {retryMutation.error && (
          <ErrorBanner
            message={retryMutation.error}
            onRetry={() => {
              retryMutation.clearError();
              refetchMigration();
            }}
          />
        )}

        {cancelMutation.error && (
          <ErrorBanner
            message={cancelMutation.error}
            onRetry={() => {
              cancelMutation.clearError();
              refetchMigration();
            }}
          />
        )}

        <AdminContentWrapper
          loading={loading}
          error={error}
          isEmpty={!data}
          emptyIcon={Globe}
          emptyTitle="Residency unavailable"
          emptyDescription="Data residency is not available in this deployment."
        >
          {data && (
            <ResidencyContent
              data={data}
              isSaas={isSaas}
              migration={migrationData?.migration ?? null}
              onAssign={handleAssign}
              onMigrate={handleMigrate}
              onRetry={handleRetry}
              onCancel={handleCancel}
              saving={assignMutation.saving}
              migrating={migrateMutation.saving}
              retrying={retryMutation.saving}
              cancelling={cancelMutation.saving}
            />
          )}
        </AdminContentWrapper>
      </div>
    </ErrorBoundary>
    </div>
  );
}

// ── Content Router ──────────────────────────────────────────────

function ResidencyContent({
  data,
  isSaas,
  migration,
  onAssign,
  onMigrate,
  onRetry,
  onCancel,
  saving,
  migrating,
  retrying,
  cancelling,
}: {
  data: ResidencyStatus;
  isSaas: boolean;
  migration: RegionMigration | null;
  onAssign: (region: string) => Promise<boolean>;
  onMigrate: (targetRegion: string) => Promise<boolean>;
  onRetry: (migrationId: string) => Promise<boolean>;
  onCancel: (migrationId: string) => Promise<boolean>;
  saving: boolean;
  migrating: boolean;
  retrying: boolean;
  cancelling: boolean;
}) {
  if (!data.configured) {
    return <NotConfiguredCard isSaas={isSaas} />;
  }

  if (data.region) {
    return (
      <div className="space-y-4">
        {migration && (
          <MigrationStatusBanner
            migration={migration}
            onRetry={onRetry}
            onCancel={onCancel}
            retrying={retrying}
            cancelling={cancelling}
          />
        )}
        <AssignedRegionCard
          status={data}
          isSaas={isSaas}
          migration={migration}
          onMigrate={onMigrate}
          migrating={migrating}
        />
      </div>
    );
  }

  return (
    <RegionPickerBase
      status={data}
      onAssign={onAssign}
      saving={saving}
      buttonLabel={isSaas ? "Confirm Region" : "Assign Region"}
    >
      {(selected, setSelected) =>
        isSaas ? (
          <RegionCardGrid
            regions={data.availableRegions}
            selected={selected}
            onSelect={setSelected}
          />
        ) : (
          <SelfHostedRegionSelect
            regions={data.availableRegions}
            defaultRegion={data.defaultRegion}
            selected={selected}
            onSelect={setSelected}
          />
        )
      }
    </RegionPickerBase>
  );
}

// ── Migration Status Banner ──────────────────────────────────────

function MigrationStatusBanner({
  migration,
  onRetry,
  onCancel,
  retrying,
  cancelling,
}: {
  migration: RegionMigration;
  onRetry: (migrationId: string) => Promise<boolean>;
  onCancel: (migrationId: string) => Promise<boolean>;
  retrying: boolean;
  cancelling: boolean;
}) {
  switch (migration.status) {
    case "pending":
      return (
        <div className="flex items-start gap-3 rounded-md border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950/50">
          <Clock className="mt-0.5 h-5 w-5 shrink-0 text-blue-600 dark:text-blue-400" />
          <div className="flex-1 text-sm">
            <p className="font-medium text-blue-800 dark:text-blue-200">
              Migration requested
            </p>
            <p className="mt-1 text-blue-700 dark:text-blue-300">
              Your request to migrate from <strong>{migration.sourceRegion}</strong> to{" "}
              <strong>{migration.targetRegion}</strong> is queued for processing.
            </p>
            <p className="mt-1 text-xs text-blue-600 dark:text-blue-400">
              Requested {formatDate(migration.requestedAt)}
            </p>
            <div className="mt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onCancel(migration.id)}
                disabled={cancelling}
                className="border-blue-300 text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-900"
              >
                {cancelling ? (
                  <>
                    <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                    Cancelling...
                  </>
                ) : (
                  "Cancel Migration"
                )}
              </Button>
            </div>
          </div>
        </div>
      );
    case "in_progress":
      return (
        <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/50">
          <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-amber-600 dark:text-amber-400" />
          <div className="text-sm">
            <p className="font-medium text-amber-800 dark:text-amber-200">
              Migration in progress
            </p>
            <p className="mt-1 text-amber-700 dark:text-amber-300">
              Data is being migrated from <strong>{migration.sourceRegion}</strong> to{" "}
              <strong>{migration.targetRegion}</strong>. Some features may be temporarily
              unavailable.
            </p>
          </div>
        </div>
      );
    case "completed":
      return (
        <div className="flex items-start gap-3 rounded-md border border-green-200 bg-green-50 p-4 dark:border-green-900 dark:bg-green-950/50">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-600 dark:text-green-400" />
          <div className="text-sm">
            <p className="font-medium text-green-800 dark:text-green-200">
              Migration complete
            </p>
            <p className="mt-1 text-green-700 dark:text-green-300">
              Your workspace has been migrated to <strong>{migration.targetRegion}</strong>.
              {migration.completedAt && ` Completed ${formatDate(migration.completedAt)}.`}
            </p>
          </div>
        </div>
      );
    case "failed":
      return (
        <div className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/50">
          <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
          <div className="flex-1 text-sm">
            <p className="font-medium text-red-800 dark:text-red-200">
              Migration failed
            </p>
            <p className="mt-1 text-red-700 dark:text-red-300">
              {migration.errorMessage ?? "The migration could not be completed. Please contact support for assistance."}
            </p>
            <div className="mt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onRetry(migration.id)}
                disabled={retrying}
                className="border-red-300 text-red-700 hover:bg-red-100 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900"
              >
                {retrying ? (
                  <>
                    <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                    Retrying...
                  </>
                ) : (
                  <>
                    <RefreshCw className="mr-1.5 h-3 w-3" />
                    Retry Migration
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      );
    case "cancelled":
      return (
        <div className="flex items-start gap-3 rounded-md border border-border bg-muted/50 p-4">
          <Ban className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="text-sm">
            <p className="font-medium">
              Migration cancelled
            </p>
            <p className="mt-1 text-muted-foreground">
              The migration from <strong>{migration.sourceRegion}</strong> to{" "}
              <strong>{migration.targetRegion}</strong> was cancelled.
              {migration.completedAt && ` Cancelled ${formatDate(migration.completedAt)}.`}
            </p>
          </div>
        </div>
      );
  }
}

// ── Assigned Region Card ─────────────────────────────────────────

function AssignedRegionCard({
  status,
  isSaas,
  migration,
  onMigrate,
  migrating,
}: {
  status: ResidencyStatus;
  isSaas: boolean;
  migration: RegionMigration | null;
  onMigrate: (targetRegion: string) => Promise<boolean>;
  migrating: boolean;
}) {
  const displayLabel = status.regionLabel ?? status.region ?? "Unknown";
  const hasPendingMigration = migration?.status === "pending" || migration?.status === "in_progress";
  const otherRegions = status.availableRegions.filter((r) => r.id !== status.region);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Data Region</CardTitle>
            <CardDescription>
              Your workspace data is stored in this region.
            </CardDescription>
          </div>
          <Badge variant="default" className="bg-green-600 text-xs">
            <MapPin className="mr-1 h-3 w-3" />
            Active
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border bg-muted/50 p-4">
          <div className="grid gap-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Region</span>
              <span className="font-medium">
                {displayLabel}
                {isSaas && status.region && (
                  <ComplianceBadge regionId={status.region} className="ml-2" />
                )}
              </span>
            </div>
            {!isSaas && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Region ID</span>
                <code className="text-xs">{status.region}</code>
              </div>
            )}
            {status.assignedAt && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Assigned</span>
                <span className="font-medium">
                  {formatDate(status.assignedAt)}
                </span>
              </div>
            )}
          </div>
        </div>

        {isSaas && otherRegions.length > 0 ? (
          <div className="mt-4">
            <MigrationDialog
              currentRegion={status.region!}
              currentLabel={displayLabel}
              availableRegions={otherRegions}
              onMigrate={onMigrate}
              migrating={migrating}
              disabled={hasPendingMigration}
            />
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">
            {isSaas
              ? `All workspace data is stored and processed in ${displayLabel}.`
              : "Region assignment is permanent and cannot be changed. Contact support if you need to migrate to a different region."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Migration Dialog ─────────────────────────────────────────────

function MigrationDialog({
  currentRegion,
  currentLabel,
  availableRegions,
  onMigrate,
  migrating,
  disabled,
}: {
  currentRegion: string;
  currentLabel: string;
  availableRegions: RegionPickerItem[];
  onMigrate: (targetRegion: string) => Promise<boolean>;
  migrating: boolean;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);

  const selectedLabel =
    availableRegions.find((r) => r.id === selected)?.label ?? selected;

  async function handleConfirm() {
    const success = await onMigrate(selected);
    if (success) {
      setSelected("");
    }
    // Close both dialogs regardless — on failure the ErrorBanner is visible at page level
    setShowConfirm(false);
    setOpen(false);
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setSelected(""); setShowConfirm(false); } }}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm" disabled={disabled}>
            {disabled ? "Migration in progress..." : "Change Region"}
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Request Region Migration</DialogTitle>
            <DialogDescription>
              Select the region you want to migrate to. Your current region is{" "}
              <strong>{currentLabel}</strong>.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="flex items-center gap-3 rounded-md border bg-muted/50 p-3 text-sm">
              <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="text-muted-foreground">Current:</span>
              <span className="font-medium">{currentLabel}</span>
              <ComplianceBadge regionId={currentRegion} />
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="text-muted-foreground">New:</span>
              {selected ? (
                <>
                  <span className="font-medium">{selectedLabel}</span>
                  <ComplianceBadge regionId={selected} />
                </>
              ) : (
                <span className="italic text-muted-foreground">Select below</span>
              )}
            </div>

            <RegionCardGrid
              regions={availableRegions}
              selected={selected}
              onSelect={setSelected}
              disabled={migrating}
            />
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={migrating}
            >
              Cancel
            </Button>
            <Button
              onClick={() => setShowConfirm(true)}
              disabled={!selected || migrating}
            >
              {migrating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Requesting...
                </>
              ) : (
                "Request Migration"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm migration request</AlertDialogTitle>
            <AlertDialogDescription>
              You are requesting to migrate your workspace from{" "}
              <strong>{currentLabel}</strong> to <strong>{selectedLabel}</strong>.
              Our team will process this request. During migration, some features
              may be temporarily unavailable.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={migrating}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirm} disabled={migrating}>
              {migrating ? "Requesting..." : "Confirm Migration"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ── Region Picker Base (shared state, warning, dialog) ──────────

function RegionPickerBase({
  status,
  onAssign,
  saving,
  buttonLabel,
  children,
}: {
  status: ResidencyStatus;
  onAssign: (region: string) => Promise<boolean>;
  saving: boolean;
  buttonLabel: string;
  children: (selected: string, setSelected: (id: string) => void) => ReactNode;
}) {
  const [selected, setSelected] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);

  const selectedLabel =
    (status.availableRegions.find((r) => r.id === selected)?.label ?? selected) || "Unknown region";

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Select Data Region</CardTitle>
          <CardDescription>
            Choose where your workspace data will be stored. This decision is
            permanent and cannot be changed later.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Warning */}
          <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/50">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="text-sm">
              <p className="font-medium text-amber-800 dark:text-amber-200">
                This action is permanent
              </p>
              <p className="mt-1 text-amber-700 dark:text-amber-300">
                Once a region is assigned, it cannot be changed. All workspace
                data will be stored in the selected region. Choose carefully
                based on your compliance requirements.
              </p>
            </div>
          </div>

          {/* Selection UI (render prop) */}
          {children(selected, setSelected)}

          {/* Assign button */}
          <Button
            onClick={() => setShowConfirm(true)}
            disabled={!selected || saving}
            size="sm"
          >
            {saving ? "Assigning..." : buttonLabel}
          </Button>
        </CardContent>
      </Card>

      {/* Confirmation dialog */}
      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Confirm region assignment
            </AlertDialogTitle>
            <AlertDialogDescription>
              You are about to assign your workspace to{" "}
              <strong>{selectedLabel}</strong>. This action is permanent and
              cannot be undone. All workspace data will be stored in this region.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                const success = await onAssign(selected);
                if (success) {
                  setShowConfirm(false);
                }
              }}
            >
              Assign to {selectedLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ── Self-Hosted Region Select (dropdown) ────────────────────────

function SelfHostedRegionSelect({
  regions,
  defaultRegion,
  selected,
  onSelect,
}: {
  regions: RegionPickerItem[];
  defaultRegion: string;
  selected: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Select value={selected} onValueChange={onSelect}>
        <SelectTrigger aria-label="Data region">
          <SelectValue placeholder="Choose a region..." />
        </SelectTrigger>
        <SelectContent>
          {regions.map((r) => (
            <SelectItem key={r.id} value={r.id}>
              {r.label}
              {r.isDefault ? " (default)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {regions.length === 0
          ? "No regions are configured in this deployment."
          : `${regions.length} region${regions.length === 1 ? "" : "s"} available. Default: ${defaultRegion}.`}
      </p>
    </div>
  );
}

// ── Not Configured Card ──────────────────────────────────────────

function NotConfiguredCard({ isSaas }: { isSaas: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Data Residency</CardTitle>
        <CardDescription>
          Data residency is not configured in this deployment.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          {isSaas
            ? "Data residency is being set up for your account. Check back shortly or contact support."
            : "Contact your platform administrator to configure data residency regions, or refer to the deployment documentation for setup instructions."}
        </p>
      </CardContent>
    </Card>
  );
}
