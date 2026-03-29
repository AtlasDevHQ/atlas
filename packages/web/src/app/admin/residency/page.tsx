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
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { useDeployMode } from "@/ui/hooks/use-deploy-mode";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";
import { Globe, MapPin, AlertTriangle, Info } from "lucide-react";

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
    <ErrorBoundary>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Data Residency</h1>
          <p className="text-muted-foreground">
            {isSaas
              ? "Choose where your data is stored to meet regulatory requirements."
              : "Control where your workspace data is stored for compliance requirements."}
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
                  <SaasRegionSelector
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
              <NotConfiguredCard />
            )
          )}
        </AdminContentWrapper>
      </div>
    </ErrorBoundary>
  );
}

// ── Assigned Region Card ─────────────────────────────────────────

function AssignedRegionCard({
  status,
  isSaas,
}: {
  status: ResidencyStatus;
  isSaas: boolean;
}) {
  const regionDisplay = getRegionDisplay(status.region ?? "");
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
                {isSaas && regionDisplay.flag
                  ? `${regionDisplay.flag} ${status.regionLabel}`
                  : status.regionLabel}
              </span>
            </div>
            {!isSaas && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Region ID</span>
                <code className="text-xs">{status.region}</code>
              </div>
            )}
            {isSaas && regionDisplay.compliance && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Compliance</span>
                <span className="text-xs font-medium">
                  {regionDisplay.compliance}
                </span>
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
        <p className="mt-3 text-xs text-muted-foreground">
          Region assignment is permanent and cannot be changed. Contact support
          if you need to migrate to a different region.
        </p>
      </CardContent>
    </Card>
  );
}

// ── Region display info ──────────────────────────────────────────

const REGION_DISPLAY: Record<
  string,
  { flag: string; description: string; compliance: string | null }
> = {
  "us-east-1": {
    flag: "\u{1F1FA}\u{1F1F8}",
    description: "Virginia, United States",
    compliance: "SOC 2, HIPAA eligible",
  },
  "us-west-2": {
    flag: "\u{1F1FA}\u{1F1F8}",
    description: "Oregon, United States",
    compliance: "SOC 2, HIPAA eligible",
  },
  "eu-west-1": {
    flag: "\u{1F1EA}\u{1F1FA}",
    description: "Ireland, European Union",
    compliance: "GDPR-compliant",
  },
  "eu-central-1": {
    flag: "\u{1F1EA}\u{1F1FA}",
    description: "Frankfurt, European Union",
    compliance: "GDPR-compliant",
  },
  "ap-southeast-1": {
    flag: "\u{1F30F}",
    description: "Singapore, Asia Pacific",
    compliance: "PDPA-compliant",
  },
  "ap-northeast-1": {
    flag: "\u{1F1EF}\u{1F1F5}",
    description: "Tokyo, Japan",
    compliance: "APPI-compliant",
  },
};

function getRegionDisplay(regionId: string) {
  return (
    REGION_DISPLAY[regionId] ?? {
      flag: "\u{1F310}",
      description: regionId,
      compliance: null,
    }
  );
}

// ── SaaS Region Selector ─────────────────────────────────────────

function SaasRegionSelector({
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

  const selectedRegion = status.availableRegions.find(
    (r) => r.id === selected,
  );
  const selectedLabel = selectedRegion?.label ?? selected;
  const selectedDisplay = getRegionDisplay(selected);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Select Data Region</CardTitle>
          <CardDescription>
            Choose where your workspace data will be stored and processed to
            meet your regulatory requirements.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Context */}
          <div className="flex items-start gap-3 rounded-md border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950/50">
            <Info className="mt-0.5 h-5 w-5 shrink-0 text-blue-600 dark:text-blue-400" />
            <p className="text-sm text-blue-700 dark:text-blue-300">
              Your data is stored and processed entirely within the selected
              region. This choice is permanent and ensures compliance with local
              regulations.
            </p>
          </div>

          {/* Region cards */}
          <div className="grid gap-3 sm:grid-cols-2">
            {status.availableRegions.map((region) => {
              const display = getRegionDisplay(region.id);
              const isSelected = selected === region.id;
              return (
                <button
                  key={region.id}
                  type="button"
                  className={cn(
                    "flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors hover:bg-accent/50",
                    isSelected && "ring-2 ring-primary border-primary",
                  )}
                  onClick={() => setSelected(region.id)}
                >
                  <div className="flex w-full items-center gap-2">
                    <span className="text-lg" role="img" aria-label={region.label}>
                      {display.flag}
                    </span>
                    <span className="text-sm font-medium">{region.label}</span>
                    {region.isDefault && (
                      <Badge
                        variant="secondary"
                        className="ml-auto text-[10px]"
                      >
                        Default
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {display.description}
                  </p>
                  {display.compliance && (
                    <Badge variant="outline" className="text-[10px]">
                      {display.compliance}
                    </Badge>
                  )}
                </button>
              );
            })}
          </div>

          {/* Assign button */}
          <Button
            onClick={() => setShowConfirm(true)}
            disabled={!selected || saving}
            size="sm"
          >
            {saving ? "Assigning..." : "Select Region"}
          </Button>
        </CardContent>
      </Card>

      {/* Confirmation dialog */}
      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm data region</AlertDialogTitle>
            <AlertDialogDescription>
              Your workspace data will be stored in{" "}
              <strong>
                {selectedDisplay.flag} {selectedLabel}
              </strong>
              . This decision is permanent. Changing your data region later
              requires contacting support.
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
              Confirm {selectedLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ── Region Picker Card (self-hosted) ─────────────────────────────

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

function NotConfiguredCard() {
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
          Contact your platform administrator to configure data residency
          regions, or refer to the deployment documentation for setup
          instructions.
        </p>
      </CardContent>
    </Card>
  );
}
