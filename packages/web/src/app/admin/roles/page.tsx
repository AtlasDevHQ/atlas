"use client";

import { useState } from "react";
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
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
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

const roleCreateSchema = z.object({
  name: z.string().min(1, "Role name is required"),
  description: z.string(),
  permissions: z.array(z.string()).min(1, "At least one permission is required"),
});

const roleEditSchema = z.object({
  name: z.string(),
  description: z.string(),
  permissions: z.array(z.string()).min(1, "At least one permission is required"),
});

function RoleDialog({
  open,
  onOpenChange,
  onSaved,
  editingRole,
  allPermissions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  editingRole: CustomRole | null;
  allPermissions: string[];
}) {
  const isEditing = !!editingRole;

  const saveMutation = useAdminMutation({
    invalidates: onSaved,
  });

  const schema = isEditing ? roleEditSchema : roleCreateSchema;

  const defaultValues = isEditing && editingRole
    ? { name: editingRole.name, description: editingRole.description, permissions: editingRole.permissions }
    : { name: "", description: "", permissions: [] as string[] };

  function handleOpenChange(next: boolean) {
    if (next) saveMutation.reset();
    onOpenChange(next);
  }

  async function handleSubmit(values: z.infer<typeof roleCreateSchema | typeof roleEditSchema>) {
    const path = isEditing
      ? `/api/v1/admin/roles/${encodeURIComponent(editingRole!.id)}`
      : `/api/v1/admin/roles`;

    const body = isEditing
      ? { description: values.description, permissions: values.permissions }
      : { name: values.name.trim(), description: values.description, permissions: values.permissions };

    const result = await saveMutation.mutate({
      path,
      method: isEditing ? "PUT" : "POST",
      body,
    });
    if (result.ok) {
      onOpenChange(false);
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={isEditing ? "Edit Role" : "Create Role"}
      description={
        isEditing
          ? "Update the role's description and permissions."
          : "Create a new custom role with specific permissions."
      }
      schema={schema}
      defaultValues={defaultValues}
      onSubmit={handleSubmit}
      submitLabel={isEditing ? "Save Changes" : "Create Role"}
      saving={saveMutation.saving}
      serverError={saveMutation.error}
      className="max-w-lg"
    >
      {(form) => {
        const selectedPerms = form.watch("permissions") ?? [];

        function togglePermission(perm: string) {
          const current: string[] = form.getValues("permissions") ?? [];
          if (current.includes(perm)) {
            form.setValue("permissions", current.filter((p) => p !== perm), { shouldValidate: true });
          } else {
            form.setValue("permissions", [...current, perm], { shouldValidate: true });
          }
        }

        return (
          <>
            {!isEditing && (
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. data-engineer" autoFocus {...field} />
                    </FormControl>
                    <FormDescription>
                      Lowercase letters, numbers, hyphens, and underscores. 1-63 characters.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Input placeholder="What this role is for" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="space-y-3">
              <FormLabel>Permissions</FormLabel>
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
                          checked={selectedPerms.includes(perm)}
                          onCheckedChange={() => togglePermission(perm)}
                        />
                        <span className="text-sm">{PERMISSION_LABELS[perm] ?? perm}</span>
                        <span className="text-xs text-muted-foreground font-mono ml-auto">{perm}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
              {form.formState.errors.permissions && (
                <p className="text-sm text-destructive">{form.formState.errors.permissions.message}</p>
              )}
            </div>
          </>
        );
      }}
    </FormDialog>
  );
}

// ── Delete Dialog ────────────────────────────────────────────────

function DeleteRoleDialog({
  role,
  open,
  onOpenChange,
  onDeleted,
}: {
  role: CustomRole | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const { mutate, saving: deleting, error, reset } = useAdminMutation({
    method: "DELETE",
    invalidates: onDeleted,
  });

  function handleOpen(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleDelete() {
    if (!role) return;
    const result = await mutate({
      path: `/api/v1/admin/roles/${encodeURIComponent(role.id)}`,
    });
    if (result.ok) {
      handleOpen(false);
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
          <AdminContentWrapper
            loading={loading}
            error={error}
            feature="Custom Roles"
            onRetry={refetch}
            loadingMessage="Loading roles..."
            emptyIcon={KeyRound}
            emptyTitle="No roles configured"
            isEmpty={false}
          >
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
          </AdminContentWrapper>
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
        allPermissions={allPermissions}
      />

      <DeleteRoleDialog
        role={deleteRole}
        open={!!deleteRole}
        onOpenChange={(open) => !open && setDeleteRole(null)}
        onDeleted={refetch}
      />
    </div>
  );
}
