"use client";

import { useEffect, useState } from "react";
import { useQueryStates } from "nuqs";
import { usersSearchParams } from "./search-params";
import type { ColumnDef } from "@tanstack/react-table";
import { useAtlasConfig } from "@/ui/context";
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
import { StatCard } from "@/ui/components/admin/stat-card";
import { EmptyState } from "@/ui/components/admin/empty-state";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import {
  useAdminFetch,
  friendlyError,
  type FetchError,
} from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
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

interface UserStats {
  total: number;
  banned: number;
  byRole: Record<string, number>;
}

type ConfirmAction =
  | { type: "ban"; user: User }
  | { type: "delete"; user: User }
  | null;

const LIMIT = 50;
const ROLES = ["member", "admin", "owner"] as const;

export default function UsersPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

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
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<string>("member");
  const [inviteResult, setInviteResult] = useState<{ inviteUrl: string; emailSent: boolean; emailError?: string } | null>(null);
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

  const { data: stats, error: statsError } = useAdminFetch<UserStats>(
    "/api/v1/admin/users/stats",
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
              {ROLES.map((r) =>
                r !== user.role ? (
                  <DropdownMenuItem
                    key={r}
                    onClick={() => handleRoleChange(user.id, r)}
                  >
                    <Shield className="mr-2 size-4" />
                    Set {r}
                  </DropdownMenuItem>
                ) : null,
              )}
              <DropdownMenuSeparator />
              {user.banned ? (
                <DropdownMenuItem onClick={() => handleUnban(user.id)}>
                  <ShieldOff className="mr-2 size-4" />
                  Unban
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  onClick={() => setConfirmAction({ type: "ban", user })}
                >
                  <Ban className="mr-2 size-4" />
                  Ban user
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => handleRevoke(user.id)}>
                <LogOut className="mr-2 size-4" />
                Revoke sessions
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
            onClick={() => handleRevokeInvitation(inv.id)}
            title="Revoke invitation"
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

  async function handleRoleChange(userId: string, newRole: string) {
    await adminAction.mutate({
      path: `/api/v1/admin/users/${userId}/role`,
      method: "PATCH",
      body: { role: newRole },
      itemId: userId,
    });
  }

  async function handleBan(user: User) {
    await adminAction.mutate({
      path: `/api/v1/admin/users/${user.id}/ban`,
      method: "POST",
      itemId: user.id,
    });
    setConfirmAction(null);
  }

  async function handleUnban(userId: string) {
    await adminAction.mutate({
      path: `/api/v1/admin/users/${userId}/unban`,
      method: "POST",
      itemId: userId,
    });
  }

  async function handleRevoke(userId: string) {
    await adminAction.mutate({
      path: `/api/v1/admin/users/${userId}/revoke`,
      method: "POST",
      itemId: userId,
    });
  }

  async function handleDelete(user: User) {
    await adminAction.mutate({
      path: `/api/v1/admin/users/${user.id}`,
      method: "DELETE",
      itemId: user.id,
    });
    setConfirmAction(null);
  }

  // -- Invite handlers --

  function resetInviteDialog() {
    setInviteEmail("");
    setInviteRole("member");
    invite.reset();
    setInviteResult(null);
    setCopied(false);
  }

  async function handleInvite() {
    await invite.mutate({
      body: { email: inviteEmail, role: inviteRole },
      onSuccess: (data) => {
        setInviteResult({ inviteUrl: data.inviteUrl, emailSent: data.emailSent, emailError: data.emailError });
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
      // intentionally ignored: clipboard API not available — show manual copy hint via invite error
      invite.clearError();
    }
  }

  async function handleRevokeInvitation(id: string) {
    await revokeInvitation.mutate({
      path: `/api/v1/admin/users/invitations/${id}`,
      onSuccess: () => setInvitationsVersion((v) => v + 1),
    });
  }

  // Gate: 401/403/404
  if (!loading && error?.status && [401, 403, 404].includes(error.status)) {
    return (
      <div className="flex h-[calc(100dvh-3rem)] flex-col">
        <div className="border-b px-6 py-4">
          <h1 className="text-2xl font-bold tracking-tight">Users</h1>
          <p className="text-sm text-muted-foreground">Manage user accounts and roles</p>
        </div>
        <FeatureGate status={error.status as 401 | 403 | 404} feature="User Management" />
      </div>
    );
  }

  const pendingInvitations = invitations.filter((i) => i.status === "pending");

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Users</h1>
          <p className="text-sm text-muted-foreground">Manage user accounts and roles</p>
        </div>
        <Button onClick={() => { resetInviteDialog(); setInviteOpen(true); }}>
          <UserPlus className="mr-1.5 size-4" />
          Invite user
        </Button>
      </div>

      <ErrorBoundary>
      <div className="flex-1 overflow-auto p-6 space-y-6">
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
        {adminAction.error && <ErrorBanner message={adminAction.error} onRetry={adminAction.clearError} />}
        {revokeInvitation.error && <ErrorBanner message={revokeInvitation.error} onRetry={revokeInvitation.clearError} />}
        {error && error.status !== 401 && error.status !== 403 && error.status !== 404 ? (
          <ErrorBanner message={friendlyError(error)} onRetry={() => setParams({ page: 1 })} />
        ) : loading ? (
          <div className="flex h-64 items-center justify-center">
            <LoadingState message="Loading users..." />
          </div>
        ) : users.length === 0 ? (
          params.search || params.role ? (
            <EmptyState
              icon={Search}
              title="No users match your filters"
              description="Try adjusting your search or role filter"
              action={{ label: "Clear filters", onClick: () => setParams({ search: "", role: "", page: 1 }) }}
            />
          ) : (
            <EmptyState
              icon={Users}
              title="No users yet"
              description="Invite your first team member to get started"
              action={{ label: "Invite user", onClick: () => { resetInviteDialog(); setInviteOpen(true); } }}
            />
          )
        ) : (
          <DataTable table={usersTable}>
            <DataTableToolbar table={usersTable}>
              <DataTableSortList table={usersTable} />
            </DataTableToolbar>
          </DataTable>
        )}

        {/* Pending Invitations */}
        {!invitationsLoading && invitationsError && (
          <ErrorBanner message={invitationsError} onRetry={() => setInvitationsVersion((v) => v + 1)} />
        )}
        {!invitationsLoading && !invitationsError && invitations.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Mail className="size-4 text-muted-foreground" />
              <h2 className="text-lg font-semibold">Pending Invitations</h2>
              {pendingInvitations.length > 0 && (
                <Badge variant="outline">{pendingInvitations.length}</Badge>
              )}
            </div>
            <DataTable table={invitationsTable} />
          </div>
        )}
      </div>
      </ErrorBoundary>

      {/* Invite user dialog */}
      <Dialog open={inviteOpen} onOpenChange={(open) => { if (!open) setInviteOpen(false); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Invite user</DialogTitle>
            <DialogDescription>
              Send an invitation to a new user. They will be assigned the selected role on signup.
            </DialogDescription>
          </DialogHeader>
          {inviteResult ? (
            <div className="space-y-4">
              {inviteResult.emailSent ? (
                <div className="flex items-start gap-3 rounded-md border border-green-200 bg-green-50 p-3 dark:border-green-800 dark:bg-green-950">
                  <Mail className="mt-0.5 size-4 text-green-600 dark:text-green-400" />
                  <div className="text-sm">
                    <p className="font-medium text-green-700 dark:text-green-300">Invitation sent!</p>
                    <p className="text-green-600 dark:text-green-400">An email has been sent to {inviteEmail}.</p>
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
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="invite-email">Email address</Label>
                <Input
                  id="invite-email"
                  type="email"
                  placeholder="user@example.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && inviteEmail) handleInvite(); }}
                />
              </div>
              <div className="space-y-2">
                <Label>Role</Label>
                <Select value={inviteRole} onValueChange={setInviteRole}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLES.map((r) => (
                      <SelectItem key={r} value={r} className="capitalize">
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {invite.error && (
                <p className="text-sm text-destructive">{invite.error}</p>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => setInviteOpen(false)}>Cancel</Button>
                <Button onClick={handleInvite} disabled={invite.saving || !inviteEmail}>
                  {invite.saving ? "Sending..." : "Send invitation"}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Ban confirmation dialog */}
      <AlertDialog
        open={confirmAction?.type === "ban"}
        onOpenChange={(open) => { if (!open) setConfirmAction(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ban user</AlertDialogTitle>
            <AlertDialogDescription>
              This will prevent <strong>{confirmAction?.type === "ban" ? confirmAction.user.email : ""}</strong> from
              signing in and revoke all active sessions. You can unban them later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (confirmAction?.type === "ban") handleBan(confirmAction.user); }}
            >
              Ban user
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
              onClick={() => { if (confirmAction?.type === "delete") handleDelete(confirmAction.user); }}
            >
              Delete user
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
