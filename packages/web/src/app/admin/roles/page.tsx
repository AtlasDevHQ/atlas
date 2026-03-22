"use client";

import { useState } from "react";
import { useAtlasConfig } from "@/ui/context";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
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
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import { useAdminFetch, friendlyError } from "@/ui/hooks/use-admin-fetch";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { KeyRound, Plus, Pencil, Trash2, Loader2, Lock, Users } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────

interface CustomRole {
  id: string;
  orgId: string;
  name: string;
  description: string;
  permissions: string[];
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

interface RolesResponse {
  roles: CustomRole[];
  permissions: string[];
  total: number;
}

// ── Permission labels ────────────────────────────────────────────

const PERMISSION_LABELS: Record<string, string> = {
  "query": "Query data",
  "query:raw_data": "View raw row data",
  "admin:users": "Manage users",
  "admin:connections": "Manage connections",
  "admin:settings": "Manage settings",
  "admin:audit": "View audit logs",
  "admin:roles": "Manage roles",
  "admin:semantic": "Edit semantic layer",
};

const PERMISSION_GROUPS: Record<string, string[]> = {
  "Data Access": ["query", "query:raw_data"],
  "Administration": ["admin:users", "admin:connections", "admin:settings", "admin:audit", "admin:roles", "admin:semantic"],
};

function PermissionBadges({ permissions }: { permissions: string[] }) {
  if (permissions.length === Object.keys(PERMISSION_LABELS).length) {
    return <Badge variant="default" className="text-[10px]">All permissions</Badge>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {permissions.map((p) => (
        <Badge key={p} variant="secondary" className="text-[10px]">
          {PERMISSION_LABELS[p] ?? p}
        </Badge>
      ))}
    </div>
  );
}

// ── Create/Edit Dialog ───────────────────────────────────────────

function RoleDialog({
  open,
  onOpenChange,
  onSaved,
  editingRole,
  apiUrl,
  credentials,
  allPermissions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  editingRole: CustomRole | null;
  apiUrl: string;
  credentials: RequestCredentials;
  allPermissions: string[];
}) {
  const isEditing = !!editingRole;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedPerms, setSelectedPerms] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleOpen(next: boolean) {
    if (next) {
      if (editingRole) {
        setName(editingRole.name);
        setDescription(editingRole.description);
        setSelectedPerms(new Set(editingRole.permissions));
      } else {
        setName("");
        setDescription("");
        setSelectedPerms(new Set());
      }
      setError(null);
    }
    onOpenChange(next);
  }

  function togglePermission(perm: string) {
    setSelectedPerms((prev) => {
      const next = new Set(prev);
      if (next.has(perm)) {
        next.delete(perm);
      } else {
        next.add(perm);
      }
      return next;
    });
  }

  async function handleSave() {
    if (!isEditing && !name.trim()) {
      setError("Role name is required.");
      return;
    }
    if (selectedPerms.size === 0) {
      setError("At least one permission is required.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const url = isEditing
        ? `${apiUrl}/api/v1/admin/roles/${encodeURIComponent(editingRole.id)}`
        : `${apiUrl}/api/v1/admin/roles`;

      const body = isEditing
        ? { description, permissions: [...selectedPerms] }
        : { name: name.trim(), description, permissions: [...selectedPerms] };

      const res = await fetch(url, {
        method: isEditing ? "PUT" : "POST",
        credentials,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data: unknown = await res.json().catch(() => null);
        const msg = typeof data === "object" && data !== null && "message" in data
          ? String((data as Record<string, unknown>).message)
          : `HTTP ${res.status}`;
        throw new Error(msg);
      }
      onSaved();
      handleOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save role");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Role" : "Create Role"}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Update the role's description and permissions."
              : "Create a new custom role with specific permissions."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {!isEditing && (
            <div className="space-y-1.5">
              <label htmlFor="role-name" className="text-sm font-medium">Name</label>
              <Input
                id="role-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. data-engineer"
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                Lowercase letters, numbers, hyphens, and underscores. 1-63 characters.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <label htmlFor="role-description" className="text-sm font-medium">Description</label>
            <Input
              id="role-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this role is for"
            />
          </div>

          <div className="space-y-3">
            <label className="text-sm font-medium">Permissions</label>
            {Object.entries(PERMISSION_GROUPS).map(([group, perms]) => (
              <div key={group} className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{group}</p>
                <div className="space-y-1.5">
                  {perms.filter((p) => allPermissions.includes(p)).map((perm) => (
                    <label
                      key={perm}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50 cursor-pointer"
                    >
                      <Checkbox
                        checked={selectedPerms.has(perm)}
                        onCheckedChange={() => togglePermission(perm)}
                      />
                      <span className="text-sm">{PERMISSION_LABELS[perm] ?? perm}</span>
                      <span className="text-xs text-muted-foreground font-mono ml-auto">{perm}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {error && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="mr-1 size-3 animate-spin" />}
            {isEditing ? "Save Changes" : "Create Role"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Delete Dialog ────────────────────────────────────────────────

function DeleteRoleDialog({
  role,
  open,
  onOpenChange,
  onDeleted,
  apiUrl,
  credentials,
}: {
  role: CustomRole | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
  apiUrl: string;
  credentials: RequestCredentials;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleOpen(next: boolean) {
    if (!next) setError(null);
    onOpenChange(next);
  }

  async function handleDelete() {
    if (!role) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(
        `${apiUrl}/api/v1/admin/roles/${encodeURIComponent(role.id)}`,
        { method: "DELETE", credentials },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(
          (data as Record<string, unknown> | null)?.message
            ? String((data as Record<string, unknown>).message)
            : `HTTP ${res.status}`,
        );
      }
      onDeleted();
      handleOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete role");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Role</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete the role &ldquo;{role?.name}&rdquo;?
            Users assigned to this role will need to be reassigned.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {error && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={deleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {deleting && <Loader2 className="mr-1 size-3 animate-spin" />}
            Delete Role
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Main Page ─────────────────────────────────────────────────────

export default function RolesPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<CustomRole | null>(null);
  const [deleteRole, setDeleteRole] = useState<CustomRole | null>(null);

  const { data, loading, error, refetch } = useAdminFetch<RolesResponse>(
    "/api/v1/admin/roles",
    {
      transform: (json) => json as RolesResponse,
    },
  );

  const roles = data?.roles ?? [];
  const allPermissions = data?.permissions ?? Object.keys(PERMISSION_LABELS);
  const builtinRoles = roles.filter((r) => r.isBuiltin);
  const customRoles = roles.filter((r) => !r.isBuiltin);

  // Gate: 401/403/404
  if (!loading && error?.status && [401, 403, 404].includes(error.status)) {
    return (
      <div className="flex h-[calc(100dvh-3rem)] flex-col">
        <div className="border-b px-6 py-4">
          <h1 className="text-2xl font-bold tracking-tight">Roles</h1>
          <p className="text-sm text-muted-foreground">Manage roles and permissions</p>
        </div>
        <FeatureGate status={error.status as 401 | 403 | 404} feature="Custom Roles" />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Roles</h1>
          <p className="text-sm text-muted-foreground">
            Manage roles and permissions (enterprise)
          </p>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)} size="sm">
          <Plus className="mr-1 size-3.5" />
          Create Role
        </Button>
      </div>

      <ErrorBoundary>
        <div className="flex-1 overflow-auto p-6">
          {error && <ErrorBanner message={friendlyError(error)} onRetry={refetch} />}

          {loading ? (
            <LoadingState message="Loading roles..." />
          ) : (
            <div className="space-y-6">
              {/* Built-in Roles */}
              <Card className="shadow-none">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Lock className="size-4" />
                    Built-in Roles
                    <Badge variant="outline" className="text-[10px] text-muted-foreground">
                      {builtinRoles.length}
                    </Badge>
                  </CardTitle>
                  <CardDescription>
                    Predefined roles that cannot be modified or deleted. These provide sensible defaults
                    for common access patterns.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {builtinRoles.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">
                      Built-in roles are created when the enterprise feature is first used.
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Name</TableHead>
                          <TableHead>Description</TableHead>
                          <TableHead>Permissions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {builtinRoles.map((role) => (
                          <TableRow key={role.id}>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <span className="font-medium font-mono text-sm">{role.name}</span>
                                <Badge variant="outline" className="text-[10px]">built-in</Badge>
                              </div>
                            </TableCell>
                            <TableCell className="text-muted-foreground text-sm">
                              {role.description}
                            </TableCell>
                            <TableCell>
                              <PermissionBadges permissions={role.permissions} />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>

              {/* Custom Roles */}
              <Card className="shadow-none">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <KeyRound className="size-4" />
                    Custom Roles
                    <Badge variant="outline" className="text-[10px] text-muted-foreground">
                      {customRoles.length}
                    </Badge>
                  </CardTitle>
                  <CardDescription>
                    Organization-specific roles with custom permission sets.
                    Assign these to users for fine-grained access control.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {customRoles.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 text-center">
                      <Users className="mb-3 size-10 text-muted-foreground/50" />
                      <p className="text-sm text-muted-foreground">
                        No custom roles defined yet.
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Create a custom role to define specific permission sets for your team.
                      </p>
                      <Button
                        className="mt-4"
                        size="sm"
                        onClick={() => setCreateDialogOpen(true)}
                      >
                        <Plus className="mr-1 size-3.5" />
                        Create First Role
                      </Button>
                    </div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Name</TableHead>
                          <TableHead>Description</TableHead>
                          <TableHead>Permissions</TableHead>
                          <TableHead className="w-[100px]" />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {customRoles.map((role) => (
                          <TableRow key={role.id}>
                            <TableCell>
                              <span className="font-medium font-mono text-sm">{role.name}</span>
                            </TableCell>
                            <TableCell className="text-muted-foreground text-sm max-w-xs truncate">
                              {role.description || "-"}
                            </TableCell>
                            <TableCell>
                              <PermissionBadges permissions={role.permissions} />
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 w-7 p-0 text-muted-foreground"
                                  onClick={() => setEditingRole(role)}
                                >
                                  <Pencil className="size-3.5" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                                  onClick={() => setDeleteRole(role)}
                                >
                                  <Trash2 className="size-3.5" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </ErrorBoundary>

      <RoleDialog
        open={createDialogOpen || !!editingRole}
        onOpenChange={(open) => {
          if (!open) {
            setCreateDialogOpen(false);
            setEditingRole(null);
          }
        }}
        onSaved={refetch}
        editingRole={editingRole}
        apiUrl={apiUrl}
        credentials={credentials}
        allPermissions={allPermissions}
      />

      <DeleteRoleDialog
        role={deleteRole}
        open={!!deleteRole}
        onOpenChange={(open) => !open && setDeleteRole(null)}
        onDeleted={refetch}
        apiUrl={apiUrl}
        credentials={credentials}
      />
    </div>
  );
}
