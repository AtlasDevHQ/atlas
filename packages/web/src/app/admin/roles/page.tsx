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
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyErrorOrNull } from "@/ui/lib/fetch-error";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { KeyRound, Plus, Pencil, Trash2, Loader2, Lock, Users } from "lucide-react";

// ── Schemas ───────────────────────────────────────────────────────

const CustomRoleSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  description: z.string(),
  permissions: z.array(z.string()),
  isBuiltin: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
type CustomRole = z.infer<typeof CustomRoleSchema>;

const RolesResponseSchema = z.object({
  roles: z.array(CustomRoleSchema),
  permissions: z.array(z.string()),
  total: z.number(),
});

// ── Permission labels ────────────────────────────────────────────

/**
 * ⚠️ NOT exhaustive over the flag union, and that is a KNOWN GAP rather than a
 * choice (#5191).
 *
 * `Record<Permission, string>` would make a missing label a COMPILE error in
 * both directions, which is what this map wants — as `Record<string, …>` a
 * missing label is a raw id rendered inside a badge, which is how
 * `dashboards:read`/`dashboards:write` reached the editor as literal strings
 * before anyone noticed.
 *
 * The union is not reachable here: the web speaks HTTP and cannot import from
 * `@atlas/api`, and moving `PERMISSIONS` to `@useatlas/types` is gated on a
 * `/publish` of that package landing first — `create-atlas` builds
 * `packages/api` against the PUBLISHED copy, so the move failed Deploy
 * Validation with `Export PERMISSIONS doesn't exist in target module`. See the
 * note in `lib/auth/permissions.ts` and the follow-up issue.
 *
 * Until then the runtime test in `__tests__/permission-grouping.test.ts` is
 * what holds the map honest — it asserts every known flag has real copy.
 */
const PERMISSION_LABELS = {
  "query": "Query data",
  "query:raw_data": "View raw row data",
  "dashboards:read": "View dashboards",
  "dashboards:write": "Create and edit dashboards",
  // #5192 — the label says "public" because that is the whole of what this
  // grants and the part an admin must weigh. Sharing to the workspace rides on
  // "Create and edit dashboards"; this one puts a dashboard on a URL that
  // anyone can open with no account.
  "dashboards:share": "Publish dashboards to a public link",
  "admin:users": "Manage users",
  "admin:connections": "Manage connections",
  "admin:settings": "Manage settings",
  "admin:audit": "View audit logs",
  "admin:roles": "Manage roles",
  "admin:semantic": "Edit semantic layer",
};

/**
 * The label map keyed for a FREE-STRING lookup.
 *
 * ⚠️ A `Map`, not the object — for the same reason `permission-resolve.ts`
 * looks legacy roles up through one. `PERMISSION_LABELS[p]` on an object
 * literal reaches `Object.prototype`, so `permissionLabel("toString")` returned
 * a **Function** and `permissionLabel("__proto__")` an **Object**, past a
 * `?? p` fallback that can never fire for an inherited key — from a function
 * declaring `: string`. React then throws *"Objects are not valid as a React
 * child"* and takes out the roles page instead of rendering an unknown badge.
 * A `Map` has no prototype keys, and `.get()` is typed `string | undefined`, so
 * the fallback becomes honest rather than dead-per-the-type.
 */
const LABEL_BY_ID: ReadonlyMap<string, string> = new Map(Object.entries(PERMISSION_LABELS));

/**
 * A label for a flag the SERVER named, which is a `string` and not a
 * `Permission` (#5191).
 *
 * The two facts sit in tension and both are deliberate: `PERMISSION_LABELS` is
 * exhaustive over the compile-time union so a missing label fails the build,
 * while the editor is driven by the list the API returned — which may name a
 * flag this build has never heard of, and must still render it rather than
 * dropping it (that silent drop is the #5189 defect this file exists to
 * prevent). One narrowing point, so `Record<string, …>` does not creep back in
 * to paper over the gap.
 */
export function permissionLabel(p: string): string {
  return LABEL_BY_ID.get(p) ?? p;
}

/**
 * Display ORDER only — not the set of grantable flags.
 *
 * #5189 — this used to be the set, because the editor iterates these groups and
 * filters them by what the server returned. A flag the server offers but this
 * map omits was therefore invisible and ungrantable, which is exactly what
 * happened to the dashboards pair: the API listed them, the checkbox list did
 * not, and an EE admin had no way to author a dashboard-capable role. Anything
 * unclaimed here now falls into "Other" rather than disappearing.
 */
const PERMISSION_GROUPS: Record<string, string[]> = {
  "Data Access": ["query", "query:raw_data"],
  "Dashboards": ["dashboards:read", "dashboards:write", "dashboards:share"],
  "Administration": ["admin:users", "admin:connections", "admin:settings", "admin:audit", "admin:roles", "admin:semantic"],
};

/**
 * The permission set the editor may offer, from a fetch that may not have
 * landed.
 *
 * ⚠️ Exists so this decision is TESTABLE. It was inline as
 * `data?.permissions ?? Object.keys(PERMISSION_LABELS)`, and the fallback was
 * the hardcoded-map-as-truth coupling this file exists to remove, surviving on
 * the error path — a failed fetch, a schema mismatch and the loading state were
 * indistinguishable from success. Measured: with the decision inline, restoring
 * that `??` broke NO test, because the only coverage was of `groupPermissions`
 * one layer down.
 */
export function offerablePermissions(
  serverPermissions: string[] | undefined,
): string[] {
  return serverPermissions ?? [];
}

/**
 * Groups every server-known permission, with anything this file has no opinion
 * about collected under "Other". Takes the API's list as the source of truth so
 * a newly shipped flag degrades to "shown with its raw id" instead of "silently
 * not offered".
 */
export function groupPermissions(allPermissions: string[]): Array<[string, string[]]> {
  const claimed = new Set<string>(Object.values(PERMISSION_GROUPS).flat());
  const groups: Array<[string, string[]]> = Object.entries(PERMISSION_GROUPS).map(
    ([name, perms]) => [name, perms.filter((p) => allPermissions.includes(p))],
  );
  const unclaimed = allPermissions.filter((p) => !claimed.has(p));
  if (unclaimed.length > 0) groups.push(["Other", unclaimed]);
  return groups.filter(([, perms]) => perms.length > 0);
}

function PermissionBadges({
  permissions,
  allPermissions,
}: {
  permissions: string[];
  allPermissions: string[];
}) {
  // #5189 — was `permissions.length === Object.keys(PERMISSION_LABELS).length`,
  // which compared a role's size against a HARDCODED label map. It was correct
  // only while the two lists happened to be the same length. Adding two server
  // flags WITHOUT also adding two labels — one careless edit away, and this
  // change had to add both — breaks it in either direction: a genuinely
  // all-permissions role stops showing the badge, and any role holding as many
  // flags as the map has labels starts showing it falsely.
  const all = new Set(allPermissions);
  if (
    all.size > 0 &&
    permissions.length === all.size &&
    permissions.every((p) => all.has(p))
  ) {
    return <Badge variant="default" className="text-[10px]">All permissions</Badge>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {permissions.map((p) => (
        <Badge key={p} variant="secondary" className="text-[10px]">
          {permissionLabel(p)}
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
      serverError={friendlyErrorOrNull(saveMutation.error)}
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
              {groupPermissions(allPermissions).map(([group, perms]) => (
                <div key={group} className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{group}</p>
                  {/* Don't wrap <Checkbox> in <label> — Radix Checkbox is a button, and
                      a wrapping label dispatches a synthetic activation click on its
                      labelable descendant when the descendant itself is clicked, double-
                      firing onCheckedChange and net-toggling back. Use htmlFor. (#2170) */}
                  <div className="space-y-1.5">
                    {perms.map((perm) => (
                      <div
                        key={perm}
                        className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50"
                      >
                        <Checkbox
                          id={`perm-${perm}`}
                          checked={selectedPerms.includes(perm)}
                          onCheckedChange={() => togglePermission(perm)}
                        />
                        <label
                          htmlFor={`perm-${perm}`}
                          className="flex flex-1 items-center gap-2 cursor-pointer select-none"
                        >
                          <span className="text-sm">{permissionLabel(perm)}</span>
                          <span className="text-xs text-muted-foreground font-mono ml-auto">{perm}</span>
                        </label>
                      </div>
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

        <MutationErrorSurface error={error} feature="Custom Roles" variant="inline" />

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

  const { data, loading, error, refetch } = useAdminFetch(
    "/api/v1/admin/roles",
    { schema: RolesResponseSchema },
  );

  const roles = data?.roles ?? [];
  // NO fallback to a client-side list — see `offerablePermissions`.
  const allPermissions = offerablePermissions(data?.permissions);
  const builtinRoles = roles.filter((r) => r.isBuiltin);
  const customRoles = roles.filter((r) => !r.isBuiltin);

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Roles</h1>
          <p className="text-sm text-muted-foreground">
            Manage roles and permissions (enterprise)
          </p>
        </div>
        {/* Disabled until the server's permission list arrives: the editor
            offers exactly what the server knows, so opening it with an empty
            list would present a role form that can grant nothing. */}
        <Button
          onClick={() => setCreateDialogOpen(true)}
          size="sm"
          disabled={allPermissions.length === 0}
          title={
            allPermissions.length === 0
              ? "Permissions are still loading, or could not be fetched"
              : undefined
          }
        >
          <Plus className="mr-1 size-3.5" />
          Create Role
        </Button>
      </div>

      <ErrorBoundary>
        <div>
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
                              <PermissionBadges permissions={role.permissions} allPermissions={allPermissions} />
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
                              <PermissionBadges permissions={role.permissions} allPermissions={allPermissions} />
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
