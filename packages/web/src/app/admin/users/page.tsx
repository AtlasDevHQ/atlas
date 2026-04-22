"use client";

import { useEffect, useState } from "react";
import { useQueryStates } from "nuqs";
import { z } from "zod";
import { usersSearchParams } from "./search-params";
import { ROLES, isDemotion, removeEndpointForRole, type Role } from "./roles";
import type { ColumnDef } from "@tanstack/react-table";
import { useAtlasConfig } from "@/ui/context";
import { useUserRole } from "@/ui/hooks/use-platform-admin-guard";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/data-table/data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTableSortList } from "@/components/data-table/data-table-sort-list";
import { useDataTable } from "@/hooks/use-data-table";
import {
  getUserColumns,
  getInvitationColumns,
  type User,
  type Invitation,
} from "./columns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { TooltipProvider } from "@/components/ui/tooltip";
import { StatCard } from "@/ui/components/admin/stat-card";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import {
  FormDialog,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/form-dialog";
import {
  useAdminFetch,
  type FetchError,
} from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyErrorOrNull } from "@/ui/lib/fetch-error";
import { UserStatsSchema } from "@/ui/lib/admin-schemas";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  Users,
  Search,
  Shield,
  ShieldCheck,
  Eye,
  MoreHorizontal,
  Ban,
  ShieldOff,
  LogOut,
  Trash2,
  UserPlus,
  Mail,
  Copy,
  Check,
  Clock,
  X,
} from "lucide-react";

// -- Types --

type ConfirmAction =
  | { type: "ban"; user: User }
  | { type: "delete"; user: User }
  | { type: "revoke-sessions"; user: User }
  | { type: "revoke-invitation"; invitation: Invitation }
  | { type: "role-demote"; user: User; newRole: Role }
  | null;

const LIMIT = 50;

const inviteSchema = z.object({
  email: z.string().email("Valid email address is required"),
  role: z.enum(ROLES),
});

export default function UsersPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";
  const userRole = useUserRole();
  const isPlatformAdmin = userRole === "platform_admin";

  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FetchError | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);

  const [params, setParams] = useQueryStates(usersSearchParams);
  const offset = (params.page - 1) * LIMIT;

  // Local search input — pushed to URL on Enter/Apply
  const [searchInput, setSearchInput] = useState(params.search);

  // Admin action mutation (role change, ban, unban, revoke, delete)
  const adminAction = useAdminMutation({
    invalidates: () => setParams((p) => ({ ...p })),
  });

  // -- Invite dialog state --
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ inviteUrl: string; emailSent: boolean; emailError?: string; email: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // Invite mutation
  const invite = useAdminMutation<{ inviteUrl: string; emailSent: boolean; emailError?: string }>({
    path: "/api/v1/admin/users/invite",
    method: "POST",
  });

  // Revoke invitation mutation
  const revokeInvitation = useAdminMutation({
    method: "DELETE",
  });

  // -- Invitations list --
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [invitationsLoading, setInvitationsLoading] = useState(true);
  const [invitationsVersion, setInvitationsVersion] = useState(0);

  const { data: stats, error: statsError } = useAdminFetch(
    "/api/v1/admin/users/stats",
    { schema: UserStatsSchema },
  );

  // Data table columns (actions column uses component callbacks)
  const userColumns: ColumnDef<User>[] = (() => {
    const base = getUserColumns();
    const actionsCol: ColumnDef<User> = {
      id: "actions",
      header: () => null,
      cell: ({ row }) => {
        const user = row.original;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="size-8 p-0">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {ROLES.map((r) => {
                if (r === user.role) return null;
                return (
                  <DropdownMenuItem
                    key={r}
                    onClick={() =>
                      isDemotion(user.role, r)
                        ? setConfirmAction({ type: "role-demote", user, newRole: r })
                        : handleRoleChange(user.id, r)
                    }
                  >
                    <Shield className="mr-2 size-4" />
                    Set {r}
                  </DropdownMenuItem>
                );
              })}
              {/* Workspace admins can't unban (re-invite flow handles re-onboarding),
                  so skip both the separator and the unban row for them when the user
                  is banned — avoids an orphan separator directly under the role items. */}
              {(!user.banned || isPlatformAdmin) && <DropdownMenuSeparator />}
              {user.banned ? (
                isPlatformAdmin ? (
                  <DropdownMenuItem onClick={() => handleUnban(user.id)}>
                    <ShieldOff className="mr-2 size-4" />
                    Unban
                  </DropdownMenuItem>
                ) : null
              ) : (
                <DropdownMenuItem
                  onClick={() => setConfirmAction({ type: "ban", user })}
                >
                  <Ban className="mr-2 size-4" />
                  {removeEndpointForRole(isPlatformAdmin).label}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() => setConfirmAction({ type: "revoke-sessions", user })}
              >
                <LogOut className="mr-2 size-4" />
                Sign out all sessions
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => setConfirmAction({ type: "delete", user })}
              >
                <Trash2 className="mr-2 size-4" />
                Delete user
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
      enableSorting: false,
      enableHiding: false,
      size: 64,
    };
    return [...base, actionsCol];
  })();

  const pageCount = Math.max(1, Math.ceil(total / LIMIT));
  const { table: usersTable } = useDataTable({
    data: users,
    columns: userColumns,
    pageCount,
    initialState: {
      sorting: [{ id: "createdAt", desc: true }],
      pagination: { pageIndex: 0, pageSize: LIMIT },
    },
    getRowId: (row) => row.id,
  });

  // Invitations table
  const invitationColumns: ColumnDef<Invitation>[] = (() => {
    const base = getInvitationColumns();
    const actionsCol: ColumnDef<Invitation> = {
      id: "actions",
      header: () => null,
      cell: ({ row }) => {
        const inv = row.original;
        if (inv.status !== "pending") return null;
        return (
          <Button
            variant="ghost"
            size="sm"
            className="size-8 p-0 text-muted-foreground hover:text-destructive"
            onClick={() =>
              setConfirmAction({ type: "revoke-invitation", invitation: inv })
            }
            title="Revoke invitation"
            aria-label={`Revoke invitation to ${inv.email}`}
          >
            <X className="size-4" />
          </Button>
        );
      },
      enableSorting: false,
      enableHiding: false,
      size: 64,
    };
    return [...base, actionsCol];
  })();

  const { table: invitationsTable } = useDataTable({
    data: invitations,
    columns: invitationColumns,
    pageCount: 1,
    initialState: { pagination: { pageIndex: 0, pageSize: 100 } },
    getRowId: (row) => row.id,
    queryKeys: { page: "invPage", perPage: "invPerPage", sort: "invSort", filters: "invFilters", joinOperator: "invJoin" },
  });

  // Fetch users
  useEffect(() => {
    let cancelled = false;
    async function fetchUsers() {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({
          limit: String(LIMIT),
          offset: String(offset),
        });
        if (params.search) qs.set("search", params.search);
        if (params.role) qs.set("role", params.role);

        const res = await fetch(`${apiUrl}/api/v1/admin/users?${qs}`, { credentials });
        if (!res.ok) {
          if (!cancelled) setError({ message: `HTTP ${res.status}`, status: res.status });
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          setUsers(data.users ?? []);
          setTotal(data.total ?? 0);
        }
      } catch (err) {
        if (!cancelled) {
          setError({ message: err instanceof Error ? err.message : "Failed to load users" });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchUsers();
    return () => { cancelled = true; };
  }, [apiUrl, offset, params.search, params.role, credentials]);

  // Fetch invitations
  const [invitationsError, setInvitationsError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function fetchInvitations() {
      setInvitationsLoading(true);
      setInvitationsError(null);
      try {
        const res = await fetch(`${apiUrl}/api/v1/admin/users/invitations`, { credentials });
        if (!res.ok) {
          if (!cancelled) {
            setInvitations([]);
            setInvitationsError(`Failed to load invitations (HTTP ${res.status})`);
          }
          return;
        }
        const data = await res.json();
        if (!cancelled) setInvitations(data.invitations ?? []);
      } catch (err) {
        if (!cancelled) {
          setInvitations([]);
          setInvitationsError(err instanceof Error ? err.message : "Failed to load invitations");
        }
      } finally {
        if (!cancelled) setInvitationsLoading(false);
      }
    }
    fetchInvitations();
    return () => { cancelled = true; };
  }, [apiUrl, credentials, invitationsVersion]);

  function handleSearch() {
    setParams({ search: searchInput, page: 1 });
  }

  // Destructive-action handlers return `ok` so the confirm AlertDialog stays
  // open on failure (keeping the inline context visible while the mutation
  // error surfaces via MutationErrorSurface above the table). Closing the
  // dialog unconditionally on await would dismiss the operator back to a
  // list where a failure banner may be off-screen.

  async function handleRoleChange(userId: string, newRole: string): Promise<boolean> {
    const result = await adminAction.mutate({
      path: `/api/v1/admin/users/${userId}/role`,
      method: "PATCH",
      body: { role: newRole },
      itemId: userId,
    });
    return result.ok;
  }

  async function handleBan(user: User): Promise<boolean> {
    // Platform admins get the global ban; workspace admins get workspace
    // membership removal — see F-14 in security audit 1.2.3. The branch
    // lives in `removeEndpointForRole` so the contract is unit-testable.
    const endpoint = removeEndpointForRole(isPlatformAdmin);
    const result = await adminAction.mutate({
      path: endpoint.path(user.id),
      method: endpoint.method,
      itemId: user.id,
    });
    return result.ok;
  }

  async function handleUnban(userId: string) {
    await adminAction.mutate({
      path: `/api/v1/admin/users/${userId}/unban`,
      method: "POST",
      itemId: userId,
    });
  }

  async function handleRevoke(userId: string): Promise<boolean> {
    const result = await adminAction.mutate({
      path: `/api/v1/admin/users/${userId}/revoke`,
      method: "POST",
      itemId: userId,
    });
    return result.ok;
  }

  async function handleDelete(user: User): Promise<boolean> {
    const result = await adminAction.mutate({
      path: `/api/v1/admin/users/${user.id}`,
      method: "DELETE",
      itemId: user.id,
    });
    return result.ok;
  }

  // -- Invite handlers --

  function resetInviteDialog() {
    invite.reset();
    setInviteResult(null);
    setCopied(false);
  }

  async function handleInvite(values: z.infer<typeof inviteSchema>) {
    await invite.mutate({
      body: { email: values.email, role: values.role },
      onSuccess: (data) => {
        if (!data) return;
        setInviteResult({ inviteUrl: data.inviteUrl, emailSent: data.emailSent, emailError: data.emailError, email: values.email });
        setInvitationsVersion((v) => v + 1);
      },
    });
  }

  async function handleCopyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // intentionally ignored: clipboard API not available — user can select and copy manually
    }
  }

  async function handleRevokeInvitation(id: string): Promise<boolean> {
    const result = await revokeInvitation.mutate({
      path: `/api/v1/admin/users/invitations/${id}`,
      onSuccess: () => setInvitationsVersion((v) => v + 1),
    });
    return result.ok;
  }

  const pendingInvitations = invitations.filter((i) => i.status === "pending");

  return (
    <TooltipProvider>
    <div className="p-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Users</h1>
          <p className="text-sm text-muted-foreground">
            {isPlatformAdmin ? "Manage all user accounts and roles" : "Manage workspace members and roles"}
          </p>
        </div>
        <Button onClick={() => { resetInviteDialog(); setInviteOpen(true); }}>
          <UserPlus className="mr-1.5 size-4" />
          Invite user
        </Button>
      </div>

      <ErrorBoundary>
      <div className="space-y-6">
        {/* Stats row */}
        {statsError && !statsError.status ? (
          <div className="grid gap-4 sm:grid-cols-4">
            <StatCard title="Total Users" value="unavailable" icon={<Users className="size-4" />} />
            <StatCard title="Owners" value="unavailable" icon={<ShieldCheck className="size-4" />} />
            <StatCard title="Admins" value="unavailable" icon={<Shield className="size-4" />} />
            <StatCard title="Members" value="unavailable" icon={<Eye className="size-4" />} />
          </div>
        ) : stats ? (
          <div className="grid gap-4 sm:grid-cols-4">
            <StatCard
              title="Total Users"
              value={stats.total.toLocaleString()}
              icon={<Users className="size-4" />}
            />
            <StatCard
              title="Owners"
              value={(stats.byRole.owner ?? 0).toLocaleString()}
              icon={<ShieldCheck className="size-4" />}
            />
            <StatCard
              title="Admins"
              value={(stats.byRole.admin ?? 0).toLocaleString()}
              icon={<Shield className="size-4" />}
            />
            <StatCard
              title="Members"
              value={(stats.byRole.member ?? 0).toLocaleString()}
              icon={<Eye className="size-4" />}
            />
          </div>
        ) : null}

        {/* Filter row */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Search</label>
            <div className="flex gap-2">
              <Input
                type="text"
                placeholder="Search by email..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
                className="h-9 w-64"
              />
              <Button size="sm" className="h-9" onClick={handleSearch}>
                <Search className="mr-1.5 size-3.5" />
                Search
              </Button>
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Role</label>
            <Select
              value={params.role || "all"}
              onValueChange={(v) => setParams({ role: v === "all" ? "" : v, page: 1 })}
            >
              <SelectTrigger className="h-9 w-36">
                <SelectValue placeholder="All roles" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All roles</SelectItem>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r} className="capitalize">
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Content */}
        <MutationErrorSurface
          error={adminAction.error}
          feature="Users"
          onRetry={adminAction.clearError}
        />
        <MutationErrorSurface
          error={revokeInvitation.error}
          feature="Users"
          onRetry={revokeInvitation.clearError}
        />

        <AdminContentWrapper
          loading={loading}
          error={error}
          feature="Users"
          onRetry={() => setParams({ page: 1 })}
          loadingMessage="Loading users..."
          emptyIcon={Users}
          emptyTitle="No users yet"
          emptyDescription="Invite your first team member to get started"
          emptyAction={{ label: "Invite user", onClick: () => { resetInviteDialog(); setInviteOpen(true); } }}
          isEmpty={users.length === 0}
          hasFilters={!!(params.search || params.role)}
          onClearFilters={() => setParams({ search: "", role: "", page: 1 })}
        >
          <DataTable table={usersTable}>
            <DataTableToolbar table={usersTable}>
              <DataTableSortList table={usersTable} />
            </DataTableToolbar>
          </DataTable>
        </AdminContentWrapper>

        {/* Pending Invitations */}
        {!invitationsLoading && invitationsError && (
          <ErrorBanner message={invitationsError} onRetry={() => setInvitationsVersion((v) => v + 1)} />
        )}
        {!invitationsLoading && !invitationsError && invitations.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Mail className="size-4 text-muted-foreground" />
              <h2 className="text-lg font-semibold">Invitations</h2>
              {pendingInvitations.length > 0 && (
                <Badge variant="outline">
                  {pendingInvitations.length} pending
                </Badge>
              )}
            </div>
            <DataTable table={invitationsTable} />
          </div>
        )}
      </div>
      </ErrorBoundary>

      {/* Invite user dialog — result phase (plain Dialog) */}
      {inviteResult && (
        <Dialog open={inviteOpen && !!inviteResult} onOpenChange={(open) => { if (!open) setInviteOpen(false); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Invite user</DialogTitle>
              <DialogDescription>
                Invitation has been created for the new user.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              {inviteResult.emailSent ? (
                <div className="flex items-start gap-3 rounded-md border border-green-200 bg-green-50 p-3 dark:border-green-800 dark:bg-green-950">
                  <Mail className="mt-0.5 size-4 text-green-600 dark:text-green-400" />
                  <div className="text-sm">
                    <p className="font-medium text-green-700 dark:text-green-300">Invitation sent!</p>
                    <p className="text-green-600 dark:text-green-400">An email has been sent to {inviteResult.email}.</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
                    <Clock className="mt-0.5 size-4 text-amber-600 dark:text-amber-400" />
                    <div className="text-sm">
                      <p className="font-medium text-amber-700 dark:text-amber-300">
                        {inviteResult.emailError ? "Email delivery failed" : "No email delivery configured"}
                      </p>
                      <p className="text-amber-600 dark:text-amber-400">
                        {inviteResult.emailError ?? "Share the invite link manually."}
                      </p>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Invite link</Label>
                    <div className="flex gap-2">
                      <Input
                        readOnly
                        value={inviteResult.inviteUrl}
                        className="h-9 text-xs"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-9 shrink-0"
                        onClick={() => handleCopyLink(inviteResult.inviteUrl)}
                      >
                        {copied ? <Check className="mr-1.5 size-3.5" /> : <Copy className="mr-1.5 size-3.5" />}
                        {copied ? "Copied" : "Copy"}
                      </Button>
                    </div>
                  </div>
                </div>
              )}
              <DialogFooter>
                <Button onClick={() => setInviteOpen(false)}>Done</Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Invite user dialog — form phase (FormDialog) */}
      {!inviteResult && (
        <FormDialog
          open={inviteOpen && !inviteResult}
          onOpenChange={(open) => { if (!open) setInviteOpen(false); }}
          title="Invite user"
          description="Send an invitation to a new user. They will be assigned the selected role on signup."
          schema={inviteSchema}
          defaultValues={{ email: "", role: "member" }}
          onSubmit={handleInvite}
          submitLabel="Send invitation"
          saving={invite.saving}
          serverError={friendlyErrorOrNull(invite.error)}
          className="sm:max-w-md"
        >
          {(form) => (
            <>
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email address</FormLabel>
                    <FormControl>
                      <Input
                        type="email"
                        placeholder="user@example.com"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="role"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Role</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {ROLES.map((r) => (
                          <SelectItem key={r} value={r} className="capitalize">
                            {r}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </>
          )}
        </FormDialog>
      )}

      {/* Ban / remove-from-workspace confirmation dialog */}
      <AlertDialog
        open={confirmAction?.type === "ban"}
        onOpenChange={(open) => { if (!open) setConfirmAction(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isPlatformAdmin ? "Ban user" : "Remove from workspace"}</AlertDialogTitle>
            <AlertDialogDescription>
              {isPlatformAdmin ? (
                <>
                  This will prevent <strong>{confirmAction?.type === "ban" ? confirmAction.user.email : ""}</strong> from
                  signing in to <em>any</em> workspace and revoke all active sessions. You can unban them later.
                </>
              ) : (
                <>
                  This will remove <strong>{confirmAction?.type === "ban" ? confirmAction.user.email : ""}</strong> from
                  this workspace. Other workspaces they belong to are unaffected. Re-invite them if you want them back.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (confirmAction?.type !== "ban") return;
                const ok = await handleBan(confirmAction.user);
                if (ok) setConfirmAction(null);
              }}
            >
              {isPlatformAdmin ? "Ban user" : "Remove from workspace"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirmation dialog */}
      <AlertDialog
        open={confirmAction?.type === "delete"}
        onOpenChange={(open) => { if (!open) setConfirmAction(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete user</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <strong>{confirmAction?.type === "delete" ? confirmAction.user.email : ""}</strong> and
              all associated sessions. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                if (confirmAction?.type !== "delete") return;
                const ok = await handleDelete(confirmAction.user);
                if (ok) setConfirmAction(null);
              }}
            >
              Delete user
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Revoke sessions confirmation dialog */}
      <AlertDialog
        open={confirmAction?.type === "revoke-sessions"}
        onOpenChange={(open) => { if (!open) setConfirmAction(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out all sessions?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{confirmAction?.type === "revoke-sessions" ? confirmAction.user.email : ""}</strong> will
              be signed out of every active session immediately. They will need to sign in again to continue.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (confirmAction?.type !== "revoke-sessions") return;
                const ok = await handleRevoke(confirmAction.user.id);
                if (ok) setConfirmAction(null);
              }}
            >
              Sign out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Revoke invitation confirmation dialog */}
      <AlertDialog
        open={confirmAction?.type === "revoke-invitation"}
        onOpenChange={(open) => { if (!open) setConfirmAction(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke invitation?</AlertDialogTitle>
            <AlertDialogDescription>
              The invite link for <strong>{confirmAction?.type === "revoke-invitation" ? confirmAction.invitation.email : ""}</strong> will
              stop working immediately. You can send a new invitation at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (confirmAction?.type !== "revoke-invitation") return;
                const ok = await handleRevokeInvitation(confirmAction.invitation.id);
                if (ok) setConfirmAction(null);
              }}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Role demote confirmation dialog */}
      <AlertDialog
        open={confirmAction?.type === "role-demote"}
        onOpenChange={(open) => { if (!open) setConfirmAction(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Change role to {confirmAction?.type === "role-demote" ? confirmAction.newRole : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{confirmAction?.type === "role-demote" ? confirmAction.user.email : ""}</strong> will
              lose access to features available at their current <strong>
                {confirmAction?.type === "role-demote" ? confirmAction.user.role : ""}
              </strong> role. You can restore it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (confirmAction?.type !== "role-demote") return;
                const ok = await handleRoleChange(
                  confirmAction.user.id,
                  confirmAction.newRole,
                );
                if (ok) setConfirmAction(null);
              }}
            >
              Change role
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </TooltipProvider>
  );
}
