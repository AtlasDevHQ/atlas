"use client";

import { useState } from "react";
import { useAtlasConfig } from "@/ui/context";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
} from "@/components/ui/dialog";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import { useAdminFetch, friendlyError } from "@/ui/hooks/use-admin-fetch";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { RefreshCw, Trash2, Plus, Cable, Users, ArrowRightLeft, Loader2 } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────

interface SCIMConnection {
  id: string;
  providerId: string;
  organizationId: string | null;
  createdAt: string;
}

interface SCIMSyncStatus {
  connections: number;
  provisionedUsers: number;
  lastSyncAt: string | null;
}

interface SCIMStatusResponse {
  connections: SCIMConnection[];
  syncStatus: SCIMSyncStatus;
}

interface SCIMGroupMapping {
  id: string;
  orgId: string;
  scimGroupName: string;
  roleName: string;
  createdAt: string;
}

interface GroupMappingsResponse {
  mappings: SCIMGroupMapping[];
  total: number;
}

// ── Main Page ─────────────────────────────────────────────────────

export default function SCIMPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [addMappingOpen, setAddMappingOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ type: "connection" | "mapping"; id: string; label: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const { data: statusData, loading: statusLoading, error: statusError, refetch: refetchStatus } =
    useAdminFetch<SCIMStatusResponse>("/api/v1/admin/scim", {
      transform: (json) => json as SCIMStatusResponse,
    });

  const { data: mappingsData, loading: mappingsLoading, error: mappingsError, refetch: refetchMappings } =
    useAdminFetch<GroupMappingsResponse>("/api/v1/admin/scim/group-mappings", {
      transform: (json) => json as GroupMappingsResponse,
    });

  const loading = statusLoading || mappingsLoading;
  const error = statusError ?? mappingsError;
  const connections = statusData?.connections ?? [];
  const syncStatus = statusData?.syncStatus ?? { connections: 0, provisionedUsers: 0, lastSyncAt: null };
  const mappings = mappingsData?.mappings ?? [];

  // Gate: 401/403/404
  if (!loading && error?.status && [401, 403, 404].includes(error.status)) {
    return (
      <div className="flex h-[calc(100dvh-3rem)] flex-col">
        <div className="border-b px-6 py-4">
          <h1 className="text-2xl font-bold tracking-tight">SCIM</h1>
          <p className="text-sm text-muted-foreground">Directory sync for automated user provisioning</p>
        </div>
        <FeatureGate status={error.status as 401 | 403 | 404} feature="SCIM" />
      </div>
    );
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setMutationError(null);
    try {
      const endpoint = deleteTarget.type === "connection"
        ? `${apiUrl}/api/v1/admin/scim/connections/${deleteTarget.id}`
        : `${apiUrl}/api/v1/admin/scim/group-mappings/${deleteTarget.id}`;

      const res = await fetch(endpoint, {
        method: "DELETE",
        credentials,
      });
      if (!res.ok) {
        const data: unknown = await res.json().catch(() => null);
        const msg = typeof data === "object" && data !== null && "message" in data
          ? String((data as Record<string, unknown>).message)
          : `HTTP ${res.status}`;
        throw new Error(msg);
      }
      refetchStatus();
      refetchMappings();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      <div className="border-b px-6 py-4">
        <h1 className="text-2xl font-bold tracking-tight">SCIM</h1>
        <p className="text-sm text-muted-foreground">
          Directory sync for automated user provisioning
        </p>
      </div>

      <ErrorBoundary>
        <div className="flex-1 overflow-auto p-6">
          {error && <ErrorBanner message={friendlyError(error)} onRetry={() => { refetchStatus(); refetchMappings(); }} />}
          {mutationError && (
            <ErrorBanner message={mutationError} onRetry={() => setMutationError(null)} />
          )}

          {loading ? (
            <LoadingState message="Loading SCIM configuration..." />
          ) : (
            <div className="space-y-6">
              {/* Sync Status Card */}
              <Card className="shadow-none">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <RefreshCw className="size-4" />
                    Sync Status
                  </CardTitle>
                  <CardDescription>
                    Overview of SCIM directory sync activity for this workspace.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="rounded-md border px-4 py-3">
                      <p className="text-2xl font-bold">{syncStatus.connections}</p>
                      <p className="text-xs text-muted-foreground">Active Connections</p>
                    </div>
                    <div className="rounded-md border px-4 py-3">
                      <p className="text-2xl font-bold">{syncStatus.provisionedUsers}</p>
                      <p className="text-xs text-muted-foreground">Provisioned Users</p>
                    </div>
                    <div className="rounded-md border px-4 py-3">
                      <p className="text-sm font-medium">
                        {syncStatus.lastSyncAt
                          ? new Date(syncStatus.lastSyncAt).toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : "Never"}
                      </p>
                      <p className="text-xs text-muted-foreground">Last Sync</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Connections Card */}
              <Card className="shadow-none">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Cable className="size-4" />
                    SCIM Connections
                    <Badge variant="outline" className="text-[10px] text-muted-foreground">
                      {connections.length}
                    </Badge>
                  </CardTitle>
                  <CardDescription>
                    Identity provider connections configured for SCIM provisioning.
                    Generate tokens via the Better Auth SCIM API at{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-[11px]">/api/auth/scim/generate-token</code>.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {connections.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 text-center">
                      <Cable className="mb-3 size-10 text-muted-foreground/50" />
                      <p className="text-sm text-muted-foreground">
                        No SCIM connections configured.
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Use the SCIM token API to generate a bearer token for your IdP.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {connections.map((conn) => (
                        <div
                          key={conn.id}
                          className="flex items-center justify-between rounded-md border px-4 py-3"
                        >
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">{conn.providerId}</span>
                              <Badge variant="default" className="text-[10px]">Active</Badge>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              Created {new Date(conn.createdAt).toLocaleDateString()}
                            </p>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => setDeleteTarget({ type: "connection", id: conn.id, label: conn.providerId })}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Group Mappings Card */}
              <Card className="shadow-none">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2 text-base">
                        <ArrowRightLeft className="size-4" />
                        Group Mappings
                        <Badge variant="outline" className="text-[10px] text-muted-foreground">
                          {mappings.length}
                        </Badge>
                      </CardTitle>
                      <CardDescription>
                        Map SCIM group names from your IdP to Atlas custom roles.
                      </CardDescription>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setAddMappingOpen(true)}
                    >
                      <Plus className="mr-1 size-3" />
                      Add Mapping
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  {mappings.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 text-center">
                      <Users className="mb-3 size-10 text-muted-foreground/50" />
                      <p className="text-sm text-muted-foreground">
                        No group mappings configured.
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Map SCIM groups to Atlas roles so provisioned users get the correct permissions.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {mappings.map((mapping) => (
                        <div
                          key={mapping.id}
                          className="flex items-center justify-between rounded-md border px-4 py-3"
                        >
                          <div className="flex items-center gap-3">
                            <div className="space-y-0.5">
                              <span className="text-sm font-medium">{mapping.scimGroupName}</span>
                              <p className="text-xs text-muted-foreground">SCIM Group</p>
                            </div>
                            <ArrowRightLeft className="size-3 text-muted-foreground" />
                            <div className="space-y-0.5">
                              <Badge variant="secondary" className="text-xs">{mapping.roleName}</Badge>
                              <p className="text-xs text-muted-foreground">Atlas Role</p>
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => setDeleteTarget({ type: "mapping", id: mapping.id, label: mapping.scimGroupName })}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </ErrorBoundary>

      {/* Add Mapping Dialog */}
      <AddMappingDialog
        open={addMappingOpen}
        onOpenChange={setAddMappingOpen}
        onAdded={() => { refetchMappings(); }}
        apiUrl={apiUrl}
        credentials={credentials}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleteTarget?.type === "connection" ? "SCIM Connection" : "Group Mapping"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.type === "connection"
                ? `This will revoke the SCIM connection "${deleteTarget.label}" and invalidate its bearer token. The IdP will no longer be able to sync users.`
                : `This will remove the mapping for SCIM group "${deleteTarget?.label}". Users already assigned via this mapping keep their current role.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting && <Loader2 className="mr-1 size-3 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Add Mapping Dialog ────────────────────────────────────────────

function AddMappingDialog({
  open,
  onOpenChange,
  onAdded,
  apiUrl,
  credentials,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
  apiUrl: string;
  credentials: RequestCredentials;
}) {
  const [scimGroupName, setScimGroupName] = useState("");
  const [roleName, setRoleName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleOpen(v: boolean) {
    if (!v) {
      setScimGroupName("");
      setRoleName("");
      setError(null);
    }
    onOpenChange(v);
  }

  async function handleSave() {
    if (!scimGroupName.trim()) {
      setError("SCIM group name is required.");
      return;
    }
    if (!roleName.trim()) {
      setError("Role name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/api/v1/admin/scim/group-mappings`, {
        method: "POST",
        credentials,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scimGroupName: scimGroupName.trim(),
          roleName: roleName.trim(),
        }),
      });
      if (!res.ok) {
        const data: unknown = await res.json().catch(() => null);
        throw new Error(
          (data as Record<string, unknown> | null)?.message
            ? String((data as Record<string, unknown>).message)
            : `HTTP ${res.status}`,
        );
      }
      onAdded();
      handleOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create mapping");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Group Mapping</DialogTitle>
          <DialogDescription>
            Map a SCIM group from your identity provider to an Atlas custom role.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="scim-group-name">SCIM Group Name</Label>
            <Input
              id="scim-group-name"
              placeholder="e.g. Engineers, Data Science Team"
              value={scimGroupName}
              onChange={(e) => setScimGroupName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              The display name of the group as it appears in your IdP.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="role-name">Atlas Role Name</Label>
            <Input
              id="role-name"
              placeholder="e.g. analyst, viewer"
              value={roleName}
              onChange={(e) => setRoleName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              The custom role to assign. Must already exist in{" "}
              <a href="/admin/roles" className="underline">Roles</a>.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="mr-1 size-3 animate-spin" />}
            Create Mapping
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
