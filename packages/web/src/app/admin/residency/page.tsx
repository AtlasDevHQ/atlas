"use client";

import { useState } from "react";
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
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { useDeployMode } from "@/ui/hooks/use-deploy-mode";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Globe, MapPin, AlertTriangle, Check } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────

interface Region {
  id: string;
  label: string;
  isDefault: boolean;
}

interface ResidencyStatus {
  configured: boolean;
  region: string | null;
  regionLabel: string | null;
  assignedAt: string | null;
  defaultRegion: string;
  availableRegions: Region[];
}

// ── Page ──────────────────────────────────────────────────────────

export default function ResidencyPage() {
  const { deployMode } = useDeployMode();
  const isSaas = deployMode === "saas";

  const { data, loading, error, refetch } = useAdminFetch<ResidencyStatus>(
    "/api/v1/admin/residency",
    { transform: (json) => json as ResidencyStatus },
  );

  const assignMutation = useAdminMutation({
    path: "/api/v1/admin/residency",
    method: "PUT",
    invalidates: refetch,
  });

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

        <AdminContentWrapper
          loading={loading}
          error={error}
          isEmpty={!data}
          emptyIcon={Globe}
          emptyTitle="Residency unavailable"
          emptyDescription="Data residency is not available in this deployment."
        >
          {data && (
            data.configured ? (
              data.region ? (
                <AssignedRegionCard status={data} isSaas={isSaas} />
              ) : (
                isSaas ? (
                  <SaasRegionPicker
                    status={data}
                    onAssign={async (region) => {
                      await assignMutation.mutate({ body: { region } });
                    }}
                    saving={assignMutation.saving}
                  />
                ) : (
                  <RegionPickerCard
                    status={data}
                    onAssign={async (region) => {
                      await assignMutation.mutate({ body: { region } });
                    }}
                    saving={assignMutation.saving}
                  />
                )
              )
            ) : (
              <NotConfiguredCard isSaas={isSaas} />
            )
          )}
        </AdminContentWrapper>
      </div>
    </ErrorBoundary>
    </div>
  );
}

// ── Assigned Region Card ─────────────────────────────────────────

function AssignedRegionCard({ status, isSaas }: { status: ResidencyStatus; isSaas: boolean }) {
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
                {status.regionLabel}
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
        {isSaas ? (
          <p className="mt-3 text-sm text-muted-foreground">
            All workspace data is stored and processed in {status.regionLabel}.
          </p>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">
            Region assignment is permanent and cannot be changed. Contact support
            if you need to migrate to a different region.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Region Picker Card ───────────────────────────────────────────

function RegionPickerCard({
  status,
  onAssign,
  saving,
}: {
  status: ResidencyStatus;
  onAssign: (region: string) => Promise<void>;
  saving: boolean;
}) {
  const [selected, setSelected] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);

  const selectedLabel =
    status.availableRegions.find((r) => r.id === selected)?.label ?? selected;

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

          {/* Selector */}
          <div className="space-y-2">
            <Select value={selected} onValueChange={setSelected}>
              <SelectTrigger aria-label="Data region">
                <SelectValue placeholder="Choose a region..." />
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
            <p className="text-xs text-muted-foreground">
              {status.availableRegions.length === 0
                ? "No regions are configured in this deployment."
                : `${status.availableRegions.length} region${status.availableRegions.length === 1 ? "" : "s"} available. Default: ${status.defaultRegion}.`}
            </p>
          </div>

          {/* Assign button */}
          <Button
            onClick={() => setShowConfirm(true)}
            disabled={!selected || saving}
            size="sm"
          >
            {saving ? "Assigning..." : "Assign Region"}
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
                setShowConfirm(false);
                await onAssign(selected);
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

// ── Compliance Badge ────────────────────────────────────────────

function getComplianceLabel(regionId: string): string | null {
  const lower = regionId.toLowerCase();
  if (lower.includes("eu")) return "GDPR compliant";
  if (lower.includes("us")) return "SOC 2 compliant";
  return null;
}

function ComplianceBadge({
  regionId,
  className,
}: {
  regionId: string;
  className?: string;
}) {
  const label = getComplianceLabel(regionId);
  if (!label) return null;
  return (
    <Badge variant="secondary" className={cn("text-xs", className)}>
      {label}
    </Badge>
  );
}

// ── SaaS Region Picker ──────────────────────────────────────────

function SaasRegionPicker({
  status,
  onAssign,
  saving,
}: {
  status: ResidencyStatus;
  onAssign: (region: string) => Promise<void>;
  saving: boolean;
}) {
  const [selected, setSelected] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);

  const selectedLabel =
    status.availableRegions.find((r) => r.id === selected)?.label ?? selected;

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

          {/* Region cards */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {status.availableRegions.map((region) => (
              <Card
                key={region.id}
                className={cn(
                  "relative cursor-pointer transition-all hover:shadow-md",
                  selected === region.id
                    ? "ring-2 ring-primary border-primary"
                    : "hover:border-muted-foreground/30",
                )}
                onClick={() => setSelected(region.id)}
              >
                <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
                  <MapPin className="h-8 w-8 text-muted-foreground" />
                  <div className="space-y-1">
                    <p className="font-medium">{region.label}</p>
                    <div className="flex flex-wrap items-center justify-center gap-1.5">
                      {region.isDefault && (
                        <Badge variant="outline" className="text-xs">
                          Default
                        </Badge>
                      )}
                      <ComplianceBadge regionId={region.id} />
                    </div>
                  </div>
                  {selected === region.id && (
                    <Badge variant="default" className="absolute right-3 top-3">
                      <Check className="h-3 w-3" />
                    </Badge>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>

          {status.availableRegions.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No regions are available. Contact support for assistance.
            </p>
          )}

          {/* Assign button */}
          <Button
            onClick={() => setShowConfirm(true)}
            disabled={!selected || saving}
            size="sm"
          >
            {saving ? "Assigning..." : "Confirm Region"}
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
                setShowConfirm(false);
                await onAssign(selected);
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
