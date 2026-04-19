"use client";

import { type ComponentType, type ReactNode, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import {
  CompactRow,
  DetailList,
  DetailRow,
  SectionHeading,
  Shell,
  StatusDot,
  type StatusKind,
} from "@/ui/components/admin/compact";
import { useAdminFetch, friendlyError } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { combineMutationErrors } from "@/ui/lib/mutation-errors";
import { useDeployMode } from "@/ui/hooks/use-deploy-mode";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  RegionPickerItemSchema,
  MigrationStatusResponseSchema,
} from "@/ui/lib/admin-schemas";
import type { RegionPickerItem, RegionMigration } from "@/ui/lib/types";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";
import {
  ArrowRight,
  Ban,
  CheckCircle2,
  Clock,
  Globe,
  Loader2,
  MapPin,
  RefreshCw,
  XCircle,
} from "lucide-react";

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

// ── Page-local status pill ────────────────────────────────────────
// The compact Shell only renders default pills for `connected` / `unhealthy`.
// Residency needs custom migration-state pills ("Queued", "Migrating",
// "Migrated", "Cancelled", "Unassigned") which we pass via `trailing`.
function StatusPill({ kind, label }: { kind: StatusKind; label: string }) {
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em]",
        kind === "connected" && "text-primary",
        kind === "ready" && "text-primary/80",
        kind === "transitioning" && "text-amber-600 dark:text-amber-400",
        kind === "unhealthy" && "text-destructive",
        (kind === "disconnected" || kind === "unavailable") &&
          "text-muted-foreground",
      )}
    >
      <StatusDot kind={kind} />
      {label}
    </span>
  );
}

// ── Region picker tile ────────────────────────────────────────────
// Page-specific: the region grid is not a general admin primitive.

function RegionTile({
  region,
  selected,
  disabled,
  onSelect,
}: {
  region: RegionPickerItem;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "group flex items-center gap-3 rounded-xl border bg-card/40 px-3.5 py-2.5 text-left transition-colors",
        "hover:bg-card/70 hover:border-border/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "border-primary/40 bg-primary/5 ring-1 ring-primary/30",
        disabled && "pointer-events-none opacity-60",
      )}
    >
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-lg border bg-background/40",
          selected ? "border-primary/40 text-primary" : "text-muted-foreground",
        )}
      >
        <MapPin className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold leading-tight tracking-tight">
            {region.label}
          </span>
          {region.isDefault && (
            <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Default
            </span>
          )}
        </div>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
          {region.id}
        </span>
      </div>
      {selected && <StatusDot kind="connected" />}
    </button>
  );
}

// ── Page ──────────────────────────────────────────────────────────

export default function ResidencyPage() {
  return (
    <ErrorBoundary>
      <ResidencyPageContent />
    </ErrorBoundary>
  );
}

function ResidencyPageContent() {
  const { deployMode } = useDeployMode();
  const isSaas = deployMode === "saas";

  const { data, loading, error, refetch } = useAdminFetch(
    "/api/v1/admin/residency",
    { schema: ResidencyStatusSchema },
  );

  const {
    data: migrationData,
    error: migrationFetchError,
    refetch: refetchMigration,
  } = useAdminFetch("/api/v1/admin/residency/migration", {
    schema: MigrationStatusResponseSchema,
  });

  const assignMutation = useAdminMutation({
    path: "/api/v1/admin/residency",
    method: "PUT",
    invalidates: refetch,
  });

  const migrateMutation = useAdminMutation({
    path: "/api/v1/admin/residency/migrate",
    method: "POST",
    invalidates: () => {
      refetch();
      refetchMigration();
    },
  });

  const retryMutation = useAdminMutation({
    method: "POST",
    invalidates: () => {
      refetch();
      refetchMigration();
    },
  });

  const cancelMutation = useAdminMutation({
    method: "POST",
    invalidates: () => {
      refetch();
      refetchMigration();
    },
  });

  const mutationError = combineMutationErrors([
    assignMutation.error,
    migrateMutation.error,
    retryMutation.error,
    cancelMutation.error,
  ]);

  function clearMutationError() {
    assignMutation.clearError();
    migrateMutation.clearError();
    retryMutation.clearError();
    cancelMutation.clearError();
    // After a failed migrate/retry/cancel the server state may have
    // advanced to "failed" while our cached migration snapshot is pre-request.
    // Dismissing the banner should resync so the UI doesn't lie.
    refetchMigration();
  }

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

  const migration = migrationData?.migration ?? null;

  return (
    <div className="p-6">
      <div className="mx-auto mb-8 max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">Data Residency</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pin where your workspace data lives so compliance requirements stay predictable.
        </p>
      </div>

      <AdminContentWrapper
        loading={loading}
        error={error}
        isEmpty={!data}
        emptyIcon={Globe}
        emptyTitle="Residency unavailable"
        emptyDescription="Data residency is not available in this deployment."
      >
        <div className="mx-auto max-w-3xl space-y-8">
          {mutationError && (
            <ErrorBanner
              message={mutationError}
              onRetry={clearMutationError}
              actionLabel="Dismiss"
            />
          )}

          {migrationFetchError && (
            <ErrorBanner
              message={friendlyError(migrationFetchError)}
              onRetry={refetchMigration}
            />
          )}

          {data && (
            <section>
              <SectionHeading
                title="Workspace region"
                description="Every byte of workspace data — semantic layer, audit log, settings — lives here."
              />
              {!data.configured ? (
                <NotConfiguredRow isSaas={isSaas} />
              ) : data.region ? (
                <AssignedRegionShell
                  status={data}
                  isSaas={isSaas}
                  migration={migration}
                  onMigrate={handleMigrate}
                  onRetry={handleRetry}
                  onCancel={handleCancel}
                  migrating={migrateMutation.saving}
                  retrying={retryMutation.saving}
                  cancelling={cancelMutation.saving}
                />
              ) : (
                <UnassignedRegionShell
                  status={data}
                  isSaas={isSaas}
                  onAssign={handleAssign}
                  saving={assignMutation.saving}
                />
              )}
            </section>
          )}
        </div>
      </AdminContentWrapper>
    </div>
  );
}

// ── Not-configured state ─────────────────────────────────────────

function NotConfiguredRow({ isSaas }: { isSaas: boolean }) {
  return (
    <CompactRow
      icon={Globe}
      title={isSaas ? "Data residency is being set up" : "No regions configured"}
      description={
        isSaas
          ? "Your account is being provisioned. Check back shortly."
          : "Add regions to atlas.config.ts to enable per-workspace residency."
      }
      status="unavailable"
      action={
        <Button variant="outline" size="sm" asChild>
          <a
            href={
              isSaas
                ? "mailto:support@useatlas.dev"
                : "https://docs.useatlas.dev/deployment/data-residency"
            }
            target={isSaas ? undefined : "_blank"}
            rel={isSaas ? undefined : "noreferrer"}
          >
            {isSaas ? "Contact support" : "View docs"}
          </a>
        </Button>
      }
    />
  );
}

// ── Unassigned state — pick a region ─────────────────────────────

function UnassignedRegionShell({
  status,
  isSaas,
  onAssign,
  saving,
}: {
  status: ResidencyStatus;
  isSaas: boolean;
  onAssign: (region: string) => Promise<boolean>;
  saving: boolean;
}) {
  const [selected, setSelected] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);
  const selectedLabel =
    status.availableRegions.find((r) => r.id === selected)?.label ?? selected;

  const hasRegions = status.availableRegions.length > 0;

  return (
    <Shell
      icon={MapPin}
      title="Choose a region"
      description="Permanent once assigned. All workspace data will be stored in the region you pick."
      status="ready"
      trailing={<StatusPill kind="ready" label="Unassigned" />}
      actions={
        <Button
          size="sm"
          onClick={() => setShowConfirm(true)}
          disabled={!selected || saving || !hasRegions}
        >
          {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
          {isSaas ? "Confirm region" : "Assign region"}
        </Button>
      }
    >
      {!hasRegions ? (
        <p className="text-xs text-muted-foreground">
          No regions are available in this deployment. Contact support for assistance.
        </p>
      ) : isSaas ? (
        <div role="group" aria-label="Data region" className="grid gap-2 sm:grid-cols-2">
          {status.availableRegions.map((region) => (
            <RegionTile
              key={region.id}
              region={region}
              selected={selected === region.id}
              disabled={saving}
              onSelect={() => setSelected(region.id)}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-1.5">
          <Select value={selected} onValueChange={setSelected} disabled={saving}>
            <SelectTrigger aria-label="Data region" className="max-w-sm">
              <SelectValue placeholder="Choose a region…" />
            </SelectTrigger>
            <SelectContent>
              {status.availableRegions.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.label}
                  {r.isDefault ? " (default)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            {status.availableRegions.length} region
            {status.availableRegions.length === 1 ? "" : "s"} available · default{" "}
            <span className="font-mono">{status.defaultRegion}</span>
          </p>
        </div>
      )}

      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm region assignment</AlertDialogTitle>
            <AlertDialogDescription>
              Pin this workspace to{" "}
              <span className="font-semibold">{selectedLabel}</span>. This is
              permanent — all workspace data will be stored in this region.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                const success = await onAssign(selected);
                if (success) setShowConfirm(false);
              }}
            >
              Assign to {selectedLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Shell>
  );
}

// ── Assigned state ───────────────────────────────────────────────

function AssignedRegionShell({
  status,
  isSaas,
  migration,
  onMigrate,
  onRetry,
  onCancel,
  migrating,
  retrying,
  cancelling,
}: {
  status: ResidencyStatus;
  isSaas: boolean;
  migration: RegionMigration | null;
  onMigrate: (targetRegion: string) => Promise<boolean>;
  onRetry: (migrationId: string) => Promise<boolean>;
  onCancel: (migrationId: string) => Promise<boolean>;
  migrating: boolean;
  retrying: boolean;
  cancelling: boolean;
}) {
  const displayLabel = status.regionLabel ?? status.region ?? "Unknown";
  const otherRegions = status.availableRegions.filter((r) => r.id !== status.region);
  const hasPending =
    migration?.status === "pending" || migration?.status === "in_progress";

  const canMigrate = isSaas && otherRegions.length > 0 && !hasPending;
  const shellStatus: StatusKind =
    migration?.status === "in_progress" || migration?.status === "pending"
      ? "transitioning"
      : migration?.status === "failed"
        ? "unhealthy"
        : "connected";
  const pillFor = pillForMigration(migration);

  return (
    <Shell
      icon={MapPin}
      title={displayLabel}
      description={
        isSaas
          ? `All workspace data is stored and processed in ${displayLabel}.`
          : "Region assignment is permanent. Contact support for cross-region migration."
      }
      status={shellStatus}
      trailing={pillFor ?? <StatusPill kind="connected" label="Live" />}
      actions={
        canMigrate && (
          <MigrationDialog
            currentRegion={status.region!}
            currentLabel={displayLabel}
            availableRegions={otherRegions}
            onMigrate={onMigrate}
            migrating={migrating}
          />
        )
      }
    >
      <DetailList>
        <DetailRow label="Region" value={displayLabel} />
        <DetailRow label="Region ID" value={status.region} mono />
        {status.assignedAt && (
          <DetailRow label="Assigned" value={formatDate(status.assignedAt)} />
        )}
      </DetailList>

      {migration && (
        <MigrationInline
          migration={migration}
          onRetry={onRetry}
          onCancel={onCancel}
          retrying={retrying}
          cancelling={cancelling}
        />
      )}
    </Shell>
  );
}

function pillForMigration(migration: RegionMigration | null): ReactNode {
  if (!migration) return null;
  switch (migration.status) {
    case "pending":
    case "in_progress":
      return (
        <StatusPill
          kind="transitioning"
          label={migration.status === "pending" ? "Queued" : "Migrating"}
        />
      );
    case "failed":
      return <StatusPill kind="unhealthy" label="Failed" />;
    case "completed":
      return <StatusPill kind="connected" label="Migrated" />;
    case "cancelled":
      return <StatusPill kind="disconnected" label="Cancelled" />;
    default: {
      // Guard against an API-side status we don't know yet. Fails loudly in
      // dev (exhaustiveness check below) while still rendering something
      // neutral at runtime instead of silently falling through to the
      // default "Live" pill in the shell header.
      const _exhaustive: never = migration.status;
      return <StatusPill kind="unavailable" label={String(_exhaustive)} />;
    }
  }
}

// ── Migration inline panel ───────────────────────────────────────

const MIGRATION_HEADINGS: Record<
  RegionMigration["status"],
  { icon: ComponentType<{ className?: string }>; text: string; spin: boolean }
> = {
  pending: { icon: Clock, text: "Migration requested", spin: false },
  in_progress: { icon: Loader2, text: "Migration in progress", spin: true },
  completed: { icon: CheckCircle2, text: "Migration complete", spin: false },
  failed: { icon: XCircle, text: "Migration failed", spin: false },
  cancelled: { icon: Ban, text: "Migration cancelled", spin: false },
};

function MigrationInline({
  migration,
  onRetry,
  onCancel,
  retrying,
  cancelling,
}: {
  migration: RegionMigration;
  onRetry: (id: string) => Promise<boolean>;
  onCancel: (id: string) => Promise<boolean>;
  retrying: boolean;
  cancelling: boolean;
}) {
  const { status, sourceRegion, targetRegion, errorMessage, completedAt, requestedAt } =
    migration;

  // Fall back to a neutral heading if the API ships a status we don't yet
  // render — an older bundle shouldn't crash the admin page over it.
  const heading = MIGRATION_HEADINGS[status] ?? {
    icon: Clock,
    text: `Migration ${status}`,
    spin: false,
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        <heading.icon className={cn("size-3", heading.spin && "animate-spin")} />
        {heading.text}
      </div>
      <DetailList>
        <DetailRow label="From" value={sourceRegion} mono />
        <DetailRow label="To" value={targetRegion} mono />
        <DetailRow label="Requested" value={formatDate(requestedAt)} />
        {completedAt && (
          <DetailRow
            label={status === "cancelled" ? "Cancelled" : "Completed"}
            value={formatDate(completedAt)}
          />
        )}
      </DetailList>

      {status === "failed" && errorMessage && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {errorMessage}
        </div>
      )}

      {(status === "pending" || status === "failed") && (
        <div className="flex flex-wrap gap-2">
          {status === "failed" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onRetry(migration.id)}
              disabled={retrying}
            >
              {retrying ? (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 size-3.5" />
              )}
              Retry migration
            </Button>
          )}
          {status === "pending" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onCancel(migration.id)}
              disabled={cancelling}
            >
              {cancelling && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
              Cancel migration
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Migration dialog ─────────────────────────────────────────────

function MigrationDialog({
  currentRegion,
  currentLabel,
  availableRegions,
  onMigrate,
  migrating,
}: {
  currentRegion: string;
  currentLabel: string;
  availableRegions: RegionPickerItem[];
  onMigrate: (targetRegion: string) => Promise<boolean>;
  migrating: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);

  const selectedLabel =
    availableRegions.find((r) => r.id === selected)?.label ?? selected;

  async function handleConfirm() {
    const success = await onMigrate(selected);
    if (success) setSelected("");
    // Close regardless of success — failures surface via the page-level
    // ErrorBanner so the dialog doesn't trap the user over a stale form.
    setShowConfirm(false);
    setOpen(false);
  }

  return (
    <>
      <AlertDialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) {
            setSelected("");
            setShowConfirm(false);
          }
        }}
      >
        <AlertDialogTrigger asChild>
          <Button variant="outline" size="sm">
            Change region
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent className="max-w-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Request region migration</AlertDialogTitle>
            <AlertDialogDescription>
              Pick where this workspace should move. Your data stays in{" "}
              <span className="font-semibold">{currentLabel}</span> until the migration runs.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-xs">
              <span className="text-muted-foreground">From</span>
              <span className="font-mono font-medium">{currentRegion}</span>
              <ArrowRight className="size-3 text-muted-foreground" />
              <span className="text-muted-foreground">To</span>
              {selected ? (
                <span className="font-mono font-medium">{selected}</span>
              ) : (
                <span className="italic text-muted-foreground">choose below</span>
              )}
            </div>

            <div role="group" aria-label="Target region" className="grid gap-2 sm:grid-cols-2">
              {availableRegions.map((region) => (
                <RegionTile
                  key={region.id}
                  region={region}
                  selected={selected === region.id}
                  disabled={migrating}
                  onSelect={() => setSelected(region.id)}
                />
              ))}
            </div>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={migrating}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                setShowConfirm(true);
              }}
              disabled={!selected || migrating}
            >
              {migrating && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
              Request migration
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm migration request</AlertDialogTitle>
            <AlertDialogDescription>
              Request to move this workspace from{" "}
              <span className="font-semibold">{currentLabel}</span> to{" "}
              <span className="font-semibold">{selectedLabel}</span>. Some features may
              be temporarily unavailable while we migrate.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={migrating}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirm} disabled={migrating}>
              {migrating ? "Requesting…" : "Confirm migration"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
