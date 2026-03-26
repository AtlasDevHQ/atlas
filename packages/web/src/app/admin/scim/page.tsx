"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FormDialog,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
  FormDescription,
} from "@/components/form-dialog";
import { z } from "zod";
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
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { RefreshCw, Trash2, Plus, Cable, Users, ArrowRightLeft, Loader2 } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────

interface SCIMConnection {
  id: string;
  providerId: string;
  organizationId: string | null;
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
  const [addMappingOpen, setAddMappingOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ type: "connection" | "mapping"; id: string; label: string } | null>(null);

  const { data: statusData, loading: statusLoading, error: statusError, refetch: refetchStatus } =
    useAdminFetch<SCIMStatusResponse>("/api/v1/admin/scim", {
      transform: (json) => json as SCIMStatusResponse,
    });

  const { data: mappingsData, loading: mappingsLoading, error: mappingsError, refetch: refetchMappings } =
    useAdminFetch<GroupMappingsResponse>("/api/v1/admin/scim/group-mappings", {
      transform: (json) => json as GroupMappingsResponse,
    });

  const { mutate: deleteMutate, saving: deleting, error: mutationError, clearError: clearMutationError } =
    useAdminMutation({
      method: "DELETE",
      invalidates: [refetchStatus, refetchMappings],
    });

  const loading = statusLoading || mappingsLoading;
  const error = statusError ?? mappingsError;
  const connections = statusData?.connections ?? [];
  const syncStatus = statusData?.syncStatus ?? { connections: 0, provisionedUsers: 0, lastSyncAt: null };
  const mappings = mappingsData?.mappings ?? [];

  async function handleDelete() {
    if (!deleteTarget) return;
    const path = deleteTarget.type === "connection"
      ? `/api/v1/admin/scim/connections/${deleteTarget.id}`
      : `/api/v1/admin/scim/group-mappings/${deleteTarget.id}`;

    const result = await deleteMutate({ path });
    setDeleteTarget(null);
    // error is captured by the hook
    void result;
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">SCIM</h1>
        <p className="text-sm text-muted-foreground">
          Directory sync for automated user provisioning
        </p>
      </div>

      <ErrorBoundary>
        <div>
          {mutationError && (
            <ErrorBanner message={mutationError} onRetry={clearMutationError} />
          )}
          <AdminContentWrapper
            loading={loading}
            error={error}
            feature="SCIM"
            onRetry={() => { refetchStatus(); refetchMappings(); }}
            loadingMessage="Loading SCIM configuration..."
            emptyIcon={Cable}
            emptyTitle="No SCIM configuration"
            isEmpty={false}
          >
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
          </AdminContentWrapper>
        </div>
      </ErrorBoundary>

      {/* Add Mapping Dialog */}
      <AddMappingDialog
        open={addMappingOpen}
        onOpenChange={setAddMappingOpen}
        onAdded={() => { refetchMappings(); }}
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

const mappingSchema = z.object({
  scimGroupName: z.string().min(1, "SCIM group name is required"),
  roleName: z.string().min(1, "Role name is required"),
});

function AddMappingDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) {
  const saveMutation = useAdminMutation({
    path: "/api/v1/admin/scim/group-mappings",
    method: "POST",
    invalidates: onAdded,
  });

  function handleOpenChange(next: boolean) {
    if (next) saveMutation.reset();
    onOpenChange(next);
  }

  async function handleSubmit(values: z.infer<typeof mappingSchema>) {
    const result = await saveMutation.mutate({
      body: {
        scimGroupName: values.scimGroupName.trim(),
        roleName: values.roleName.trim(),
      },
    });
    if (result.ok) {
      onOpenChange(false);
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Add Group Mapping"
      description="Map a SCIM group from your identity provider to an Atlas custom role."
      schema={mappingSchema}
      defaultValues={{ scimGroupName: "", roleName: "" }}
      onSubmit={handleSubmit}
      submitLabel="Create Mapping"
      saving={saveMutation.saving}
      serverError={saveMutation.error}
    >
      {(form) => (
        <>
          <FormField
            control={form.control}
            name="scimGroupName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>SCIM Group Name</FormLabel>
                <FormControl>
                  <Input
                    placeholder="e.g. Engineers, Data Science Team"
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  The display name of the group as it appears in your IdP.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="roleName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Atlas Role Name</FormLabel>
                <FormControl>
                  <Input
                    placeholder="e.g. analyst, viewer"
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  The custom role to assign. Must already exist in{" "}
                  <a href="/admin/roles" className="underline">Roles</a>.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </>
      )}
    </FormDialog>
  );
}
