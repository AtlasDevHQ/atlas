"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { usePlatformAdminGuard } from "@/ui/hooks/use-platform-admin-guard";
import { StatCard } from "@/ui/components/admin/stat-card";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { RegionsResponseSchema, AssignmentsResponseSchema } from "@/ui/lib/admin-schemas";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import type { WorkspaceRegion } from "@/ui/lib/types";
import {
  Globe,
  MapPin,
  CheckCircle2,
  XCircle,
  Loader2,
} from "lucide-react";

// ── Page ──────────────────────────────────────────────────────────

function ResidencyPageContent() {
  const {
    data: regionsData,
    loading: regionsLoading,
    error: regionsError,
    refetch: refetchRegions,
  } = useAdminFetch("/api/v1/platform/residency/regions", { schema: RegionsResponseSchema });

  const {
    data: assignmentsData,
    loading: assignmentsLoading,
    error: assignmentsError,
    refetch: refetchAssignments,
  } = useAdminFetch("/api/v1/platform/residency/assignments", { schema: AssignmentsResponseSchema });

  const { mutate: assignRegion, saving: assigning, error: assignError, clearError: clearAssignError } = useAdminMutation<WorkspaceRegion>({
    invalidates: () => { refetchRegions(); refetchAssignments(); },
  });

  const [assignDialog, setAssignDialog] = useState<{ workspaceId: string; workspaceName?: string } | null>(null);
  const [selectedRegion, setSelectedRegion] = useState<string>("");

  const regions = regionsData?.regions ?? [];
  const defaultRegion = regionsData?.defaultRegion ?? "";
  const assignments = assignmentsData?.assignments ?? [];
  const totalWorkspaces = regions.reduce((sum, r) => sum + r.workspaceCount, 0);

  async function handleAssign() {
    if (!assignDialog || !selectedRegion) return;
    const result = await assignRegion({
      path: `/api/v1/platform/residency/workspaces/${assignDialog.workspaceId}/region`,
      method: "POST",
      body: { region: selectedRegion },
    });
    if (result.ok) {
      setAssignDialog(null);
      setSelectedRegion("");
    }
  }

  // 404 means enterprise residency is not configured — show a helpful message instead of an error
  const isNotConfigured = regionsError?.status === 404;

  if (isNotConfigured) {
    return (
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Data Residency</h1>
          <p className="text-sm text-muted-foreground">
            Manage region assignments for workspaces.
          </p>
        </div>
        <Card>
          <CardContent className="py-8 text-center">
            <Globe className="mx-auto mb-3 size-10 text-muted-foreground" />
            <h3 className="text-lg font-semibold">Not configured</h3>
            <p className="mt-1 text-sm text-muted-foreground max-w-md mx-auto">
              Data residency requires enterprise features and region configuration.
              See the deployment documentation for setup instructions.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <AdminContentWrapper
      loading={regionsLoading}
      error={regionsError}
      feature="Data Residency"
      onRetry={refetchRegions}
      loadingMessage="Loading regions..."
    >
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Data Residency</h1>
          <p className="text-sm text-muted-foreground">
            Manage region assignments for workspaces. Region is immutable after assignment.
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard
          title="Configured Regions"
          value={regions.length}
          icon={<Globe className="size-4" />}
        />
        <StatCard
          title="Assigned Workspaces"
          value={totalWorkspaces}
          icon={<MapPin className="size-4" />}
        />
        <StatCard
          title="Default Region"
          value={defaultRegion || "—"}
          icon={<MapPin className="size-4" />}
        />
      </div>

      {/* Regions table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Region</TableHead>
                <TableHead>Label</TableHead>
                <TableHead className="text-right">Workspaces</TableHead>
                <TableHead className="text-center">Health</TableHead>
                <TableHead className="text-center">Default</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {regions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    No regions configured. Add regions to your atlas.config.ts residency section.
                  </TableCell>
                </TableRow>
              ) : (
                regions.map((r) => (
                  <TableRow key={r.region}>
                    <TableCell className="font-mono text-sm">{r.region}</TableCell>
                    <TableCell>{r.label}</TableCell>
                    <TableCell className="text-right">{r.workspaceCount}</TableCell>
                    <TableCell className="text-center">
                      {r.healthy ? (
                        <Badge variant="default" className="bg-green-600 text-xs">
                          <CheckCircle2 className="mr-1 h-3 w-3" />
                          Healthy
                        </Badge>
                      ) : (
                        <Badge variant="destructive" className="text-xs">
                          <XCircle className="mr-1 h-3 w-3" />
                          Unhealthy
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      {r.region === defaultRegion && (
                        <Badge variant="secondary" className="text-xs">Default</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Workspace region assignments */}
      <div>
        <h2 className="mb-4 text-lg font-semibold">Workspace Assignments</h2>
        {assignmentsLoading ? (
          <LoadingState message="Loading assignments..." />
        ) : assignmentsError ? (
          <ErrorBanner message={assignmentsError.message} />
        ) : (
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Workspace ID</TableHead>
                    <TableHead>Region</TableHead>
                    <TableHead>Assigned At</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {assignments.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                        No workspaces have been assigned to regions yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    assignments.map((a) => (
                      <TableRow key={a.workspaceId}>
                        <TableCell className="font-mono text-sm">{a.workspaceId}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{a.region}</Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {new Date(a.assignedAt).toLocaleString()}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Assign region dialog */}
      <Dialog open={!!assignDialog} onOpenChange={(open) => { if (!open) { setAssignDialog(null); setSelectedRegion(""); clearAssignError(); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign Region</DialogTitle>
            <DialogDescription>
              Select a region for workspace <span className="font-mono">{assignDialog?.workspaceId}</span>.
              This cannot be changed after assignment.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="region-select">Region</Label>
              <Select value={selectedRegion} onValueChange={setSelectedRegion}>
                <SelectTrigger id="region-select">
                  <SelectValue placeholder="Select a region..." />
                </SelectTrigger>
                <SelectContent>
                  {regions.map((r) => (
                    <SelectItem key={r.region} value={r.region}>
                      {r.label} ({r.region})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {assignError && <ErrorBanner message={assignError} />}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setAssignDialog(null); setSelectedRegion(""); clearAssignError(); }}>
              Cancel
            </Button>
            <Button onClick={handleAssign} disabled={!selectedRegion || assigning}>
              {assigning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Assign Region
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </AdminContentWrapper>
  );
}

export default function ResidencyPage() {
  const { blocked } = usePlatformAdminGuard();
  if (blocked) return <LoadingState message="Checking access..." />;
  return (
    <ErrorBoundary>
      <ResidencyPageContent />
    </ErrorBoundary>
  );
}
