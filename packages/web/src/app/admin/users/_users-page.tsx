"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryStates } from "nuqs";
import { z } from "zod";
import { usersSearchParams } from "./search-params";
import { ROLES, isDemotion, removeEndpointForRole, type Role } from "./roles";
import { useOrgRoles } from "./use-org-roles";
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
import { authClient } from "@/lib/auth/client";
import { UserStatsSchema } from "@/ui/lib/admin-schemas";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  Users,
  Search,
  Shield,
  ShieldAlert,
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

// Platform-scope adds an org selector. Cross-org invites hit a separate
// endpoint (`POST /api/v1/platform/invitations`) — the native
// `authClient.organization.inviteMember()` enforces a membership gate the
// platform admin can't satisfy when the target is an org they don't belong
// to. See #2876.
const platformInviteSchema = inviteSchema.extend({
  organizationId: z.string().min(1, "Pick an organization"),
});

interface OrgListItem {
  id: string;
  name: string;
  slug: string;
}

/**
 * Scope of the users page. Driven by the route that mounts it, NOT by
 * the caller's role:
 *
 *   - "workspace" — `/admin/users`. Members of the active org. Destructive
 *     verb is "Remove from workspace" (membership-only).
 *   - "platform" — `/platform/users`. All users globally. Destructive verb
 *     is "Ban" (global). Route is gated to platform_admin via
 *     `usePlatformAdminGuard` at the wrapper level.
 *
 * Driving from the URL (not the role) means the same component renders
 * deterministically — a platform admin standing on `/admin/users` sees
 * workspace data, not cross-tenant data, which matches the URL they're
 * looking at. Conflated role-driven behavior was the audit finding from
 * the multi-agent review on #2305.
 */
export interface UsersPageProps {
  scope: "workspace" | "platform";
}

export function UsersPage({ scope }: UsersPageProps) {
  const router = useRouter();
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";
  const isPlatformScope = scope === "platform";

  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FetchError | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);

  // #3157 — when a platform admin changes the role of a user who belongs to
  // more than one workspace, the backend returns 400 `workspace_ambiguous`
  // with the candidates. We surface them here as a picker and retry with an
  // explicit `organizationId` rather than dead-ending on the error.
  const [workspacePick, setWorkspacePick] = useState<{
    userId: string;
    newRole: string;
    workspaces: ReadonlyArray<{ id: string; name: string | null }>;
  } | null>(null);
  const [pickedOrgId, setPickedOrgId] = useState<string | undefined>(undefined);

  const [params, setParams] = useQueryStates(usersSearchParams);
  const offset = (params.page - 1) * LIMIT;

  // Local search input — pushed to URL on Enter/Apply
  const [searchInput, setSearchInput] = useState(params.search);

  // Admin action mutation (role change, ban, unban, revoke, delete)
  const adminAction = useAdminMutation({
    invalidates: () => setParams((p) => ({ ...p })),
  });

  // -- Invite dialog state --
  // The dialog runs the Better Auth org client directly — the legacy
  // /api/v1/admin/users/invite endpoint was removed when the invitation
  // flow cut over to `authClient.organization.inviteMember()` (see
  // `lib/auth/server.ts:organizationHooks`). The hooks layer handles
  // seat-limit, audit, and email delivery on the server.
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ inviteUrl: string; email: string } | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSaving, setInviteSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  // -- Invitations list --
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [invitationsLoading, setInvitationsLoading] = useState(true);
  const [invitationsVersion, setInvitationsVersion] = useState(0);

  // -- Cross-org invite (platform scope only) --
  // The platform-scope dialog includes an org selector. When workspace
  // scope the orgs list isn't fetched (the dialog always targets the
  // caller's active org through the native Better Auth flow).
  const [orgs, setOrgs] = useState<OrgListItem[]>([]);
  const [orgsLoading, setOrgsLoading] = useState(false);
  const [orgsError, setOrgsError] = useState<string | null>(null);

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
              {(!user.banned || isPlatformScope) && <DropdownMenuSeparator />}
              {user.banned ? (
                isPlatformScope ? (
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
                  {removeEndpointForRole(isPlatformScope).label}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() => setConfirmAction({ type: "revoke-sessions", user })}
              >
                <LogOut className="mr-2 size-4" />
                Sign out all sessions
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => router.push(`/admin/users/${user.id}`)}
              >
                <ShieldAlert className="mr-2 size-4" />
                Manage authentication…
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

  // Fetch invitations via Better Auth's `listInvitations` (the
  // legacy /api/v1/admin/users/invitations endpoint was removed). Scoped
  // to the caller's active org by default; explicit `organizationId`
  // could thread through here once the platform-scope org-selector ships
  // (tracked as a follow-up).
  const [invitationsError, setInvitationsError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function fetchInvitations() {
      setInvitationsLoading(true);
      setInvitationsError(null);
      try {
        const result = await authClient.organization.listInvitations();
        if (cancelled) return;
        if (result.error) {
          setInvitations([]);
          setInvitationsError(result.error.message ?? "Failed to load invitations.");
          return;
        }
        setInvitations(
          (result.data ?? []).map((inv) => ({
            id: inv.id,
            organizationId: inv.organizationId,
            email: inv.email,
            role: inv.role,
            status: inv.status,
            inviterId: inv.inviterId,
            expiresAt: inv.expiresAt,
            createdAt: inv.createdAt,
          })),
        );
      } catch (err) {
        if (!cancelled) {
          setInvitations([]);
          setInvitationsError(err instanceof Error ? err.message : "Failed to load invitations.");
        }
      } finally {
        if (!cancelled) setInvitationsLoading(false);
      }
    }
    fetchInvitations();
    return () => { cancelled = true; };
  }, [invitationsVersion]);

  // Fetch the orgs list for the platform-scope org selector. Lazy-loaded
  // when the invite dialog opens so the page-mount cost stays unchanged
  // for the much more common workspace-scope path.
  useEffect(() => {
    if (!isPlatformScope || !inviteOpen) return;
    if (orgs.length > 0) return;
    let cancelled = false;
    async function fetchOrgs() {
      setOrgsLoading(true);
      setOrgsError(null);
      try {
        const res = await fetch(`${apiUrl}/api/v1/admin/organizations`, { credentials });
        if (!res.ok) {
          if (!cancelled) setOrgsError(`Failed to load organizations (HTTP ${res.status})`);
          return;
        }
        const data = (await res.json()) as { organizations?: OrgListItem[] };
        if (!cancelled) setOrgs(data.organizations ?? []);
      } catch (err) {
        if (!cancelled) {
          setOrgsError(err instanceof Error ? err.message : "Failed to load organizations");
        }
      } finally {
        if (!cancelled) setOrgsLoading(false);
      }
    }
    fetchOrgs();
    return () => { cancelled = true; };
  }, [isPlatformScope, inviteOpen, apiUrl, credentials, orgs.length]);

  function handleSearch() {
    setParams({ search: searchInput, page: 1 });
  }

  // Destructive-action handlers return `ok` so the confirm AlertDialog stays
  // open on failure (keeping the inline context visible while the mutation
  // error surfaces via MutationErrorSurface above the table). Closing the
  // dialog unconditionally on await would dismiss the operator back to a
  // list where a failure banner may be off-screen.

  async function handleRoleChange(
    userId: string,
    newRole: string,
    organizationId?: string,
  ): Promise<boolean> {
    const result = await adminAction.mutate({
      path: `/api/v1/admin/users/${userId}/role`,
      method: "PATCH",
      body: organizationId ? { role: newRole, organizationId } : { role: newRole },
      itemId: userId,
    });
    // #3157 — a multi-workspace target (platform scope) comes back as
    // `workspace_ambiguous` with the candidate workspaces. Swap the error
    // banner for a picker and retry with the chosen `organizationId`; close any
    // role-demote confirm dialog so only the picker is shown.
    if (
      !result.ok &&
      result.error.code === "workspace_ambiguous" &&
      result.error.workspaces &&
      result.error.workspaces.length > 0
    ) {
      const candidates = result.error.workspaces;
      adminAction.clearErrorFor(userId);
      setConfirmAction(null);
      setPickedOrgId(candidates[0]?.id);
      setWorkspacePick({ userId, newRole, workspaces: candidates });
    }
    return result.ok;
  }

  async function handleBan(user: User): Promise<boolean> {
    // Platform admins get the global ban; workspace admins get workspace
    // membership removal — see F-14 in security audit 1.2.3. The branch
    // lives in `removeEndpointForRole` so the contract is unit-testable.
    const endpoint = removeEndpointForRole(isPlatformScope);
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
    setInviteResult(null);
    setInviteError(null);
    setCopied(false);
  }

  async function handleInvite(values: z.infer<typeof inviteSchema>) {
    setInviteError(null);
    setInviteSaving(true);
    try {
      const result = await authClient.organization.inviteMember({
        email: values.email,
        role: values.role,
      });
      if (result.error || !result.data) {
        setInviteError(result.error?.message ?? "Failed to send invitation.");
        return;
      }
      // Compute the link client-side so we can offer "Copy link" as a
      // fallback when email delivery isn't configured (matches the
      // accept page route `/accept-invitation/[id]`).
      const inviteUrl = `${window.location.origin}/accept-invitation/${result.data.id}`;
      setInviteResult({ inviteUrl, email: values.email });
      setInvitationsVersion((v) => v + 1);
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : "Failed to send invitation.");
    } finally {
      setInviteSaving(false);
    }
  }

  /**
   * Cross-org invite from `/platform/users`. Routes through the new
   * platform endpoint (#2876) instead of `authClient.organization.inviteMember`
   * because the native flow's membership gate would 403 a platform admin
   * who isn't a member of the target org.
   */
  async function handlePlatformInvite(values: z.infer<typeof platformInviteSchema>) {
    setInviteError(null);
    setInviteSaving(true);
    try {
      const res = await fetch(`${apiUrl}/api/v1/platform/invitations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials,
        body: JSON.stringify({
          organizationId: values.organizationId,
          email: values.email,
          role: values.role,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { id?: string; email?: string; message?: string }
        | null;
      if (!res.ok || !data?.id) {
        setInviteError(data?.message ?? `Failed to send invitation (HTTP ${res.status}).`);
        return;
      }
      const inviteUrl = `${window.location.origin}/accept-invitation/${data.id}`;
      setInviteResult({ inviteUrl, email: values.email });
      // The platform endpoint targets a different org than the caller's
      // active one — the local invitations list won't reflect the new
      // row (it's scoped to the caller's active org). Bump anyway in
      // case the admin happened to invite into their own active org.
      setInvitationsVersion((v) => v + 1);
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : "Failed to send invitation.");
    } finally {
      setInviteSaving(false);
    }
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
    setRevokeError(null);
    try {
      if (isPlatformScope) {
        // Better Auth's native cancelInvitation enforces the same
        // caller-org-membership gate as createInvitation — platform
        // admins viewing /platform/users see cross-org rows they can't
        // satisfy. Route through the platform endpoint (symmetric to
        // the create-side workaround at handlePlatformInvite above).
        const res = await fetch(`${apiUrl}/api/v1/platform/invitations/${id}`, {
          method: "DELETE",
          credentials,
        });
        if (!res.ok) {
          // intentionally ignored: non-JSON error bodies fall back to the HTTP status message below
          const data = (await res.json().catch(() => null)) as { message?: string } | null;
          setRevokeError(data?.message ?? `Failed to revoke invitation (HTTP ${res.status}).`);
          return false;
        }
        setInvitationsVersion((v) => v + 1);
        return true;
      }
      const result = await authClient.organization.cancelInvitation({ invitationId: id });
      if (result.error) {
        setRevokeError(result.error.message ?? "Failed to revoke invitation.");
        return false;
      }
      setInvitationsVersion((v) => v + 1);
      return true;
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : "Failed to revoke invitation.");
      return false;
    }
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
            {isPlatformScope ? "Manage all user accounts and roles" : "Manage workspace members and roles"}
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
          error={revokeError ? { message: revokeError } : null}
          feature="Users"
          onRetry={() => setRevokeError(null)}
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
              {/* Better Auth fires `sendInvitationEmail` asynchronously after
                  the row inserts — by the time we return here the email
                  has at least been handed off to the delivery layer. Show
                  a confirmation and the invite link as a manual share
                  fallback (operators without email delivery configured
                  copy this and paste it into Slack / DM). */}
              <div className="flex items-start gap-3 rounded-md border border-green-200 bg-green-50 p-3 dark:border-green-800 dark:bg-green-950">
                <Mail className="mt-0.5 size-4 text-green-600 dark:text-green-400" />
                <div className="text-sm">
                  <p className="font-medium text-green-700 dark:text-green-300">Invitation sent!</p>
                  <p className="text-green-600 dark:text-green-400">An email is on its way to {inviteResult.email}.</p>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Invite link (share manually if needed)</Label>
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
              <DialogFooter>
                <Button onClick={() => setInviteOpen(false)}>Done</Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Invite user dialog — workspace-scope form phase. */}
      {!inviteResult && !isPlatformScope && (
        <FormDialog
          open={inviteOpen && !inviteResult}
          onOpenChange={(open) => { if (!open) setInviteOpen(false); }}
          title="Invite user"
          description="Send an invitation to a new user. They will be assigned the selected role on signup."
          schema={inviteSchema}
          defaultValues={{ email: "", role: "member" }}
          onSubmit={handleInvite}
          submitLabel="Send invitation"
          saving={inviteSaving}
          serverError={inviteError}
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

      {/* Invite user dialog — platform-scope form phase (#2876).
          Adds an org selector and routes through the cross-org
          `POST /api/v1/platform/invitations` endpoint so the platform
          admin can invite into orgs they're not a member of. */}
      {!inviteResult && isPlatformScope && (
        <PlatformInviteDialogContent
          open={inviteOpen}
          onOpenChange={(open) => { if (!open) setInviteOpen(false); }}
          orgs={orgs}
          orgsLoading={orgsLoading}
          orgsError={orgsError}
          saving={inviteSaving}
          serverError={inviteError}
          onSubmit={handlePlatformInvite}
        />
      )}

      {/* Ban / remove-from-workspace confirmation dialog */}
      <AlertDialog
        open={confirmAction?.type === "ban"}
        onOpenChange={(open) => { if (!open) setConfirmAction(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isPlatformScope ? "Ban user" : "Remove from workspace"}</AlertDialogTitle>
            <AlertDialogDescription>
              {isPlatformScope ? (
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
              {isPlatformScope ? "Ban user" : "Remove from workspace"}
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

      {/* Workspace picker for a multi-workspace target (#3157). Only ever
          opens in platform scope — the backend returns `workspace_ambiguous`
          only for a platform_admin caller whose target belongs to more than
          one workspace. */}
      <AlertDialog
        open={workspacePick !== null}
        onOpenChange={(open) => {
          if (!open) {
            setWorkspacePick(null);
            setPickedOrgId(undefined);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Which workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              This user belongs to multiple workspaces. Pick the one whose role
              to change to{" "}
              <strong>{workspacePick?.newRole}</strong>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-2">
            <Label htmlFor="workspace-pick" className="sr-only">
              Workspace
            </Label>
            <Select value={pickedOrgId} onValueChange={setPickedOrgId}>
              <SelectTrigger id="workspace-pick" className="w-full">
                <SelectValue placeholder="Select a workspace" />
              </SelectTrigger>
              <SelectContent>
                {workspacePick?.workspaces.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name ?? w.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!pickedOrgId || adminAction.isMutating(workspacePick?.userId ?? "")}
              onClick={async (e) => {
                // Keep the dialog open if the retry fails (e.g. the target left
                // the workspace) so the error banner stays in context.
                e.preventDefault();
                if (!workspacePick || !pickedOrgId) return;
                const ok = await handleRoleChange(
                  workspacePick.userId,
                  workspacePick.newRole,
                  pickedOrgId,
                );
                if (ok) {
                  setWorkspacePick(null);
                  setPickedOrgId(undefined);
                }
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

// ---------------------------------------------------------------------------
// PlatformInviteDialogContent
// ---------------------------------------------------------------------------

interface PlatformInviteDialogContentProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgs: OrgListItem[];
  orgsLoading: boolean;
  orgsError: string | null;
  saving: boolean;
  serverError: string | null;
  onSubmit: (values: z.infer<typeof platformInviteSchema>) => Promise<void>;
}

/**
 * Platform-scope invite dialog. Extracted so the role dropdown can re-bind
 * via `useOrgRoles(selectedOrgId)` when the org changes — putting that
 * binding on the parent component would force a re-render of the whole
 * users page on every selector change.
 */
function PlatformInviteDialogContent({
  open,
  onOpenChange,
  orgs,
  orgsLoading,
  orgsError,
  saving,
  serverError,
  onSubmit,
}: PlatformInviteDialogContentProps) {
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Invite user"
      description="Pick a workspace, then invite the user. The platform_admin role is never assignable through invitations."
      schema={platformInviteSchema}
      defaultValues={{ email: "", role: "member", organizationId: "" }}
      onSubmit={onSubmit}
      submitLabel="Send invitation"
      saving={saving}
      serverError={serverError ?? orgsError}
      className="sm:max-w-md"
    >
      {(form) => {
        const selectedOrgId = form.watch("organizationId");
        const roles = useOrgRoles(selectedOrgId || null);
        return (
          <>
            <FormField
              control={form.control}
              name="organizationId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Workspace</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    disabled={orgsLoading || orgs.length === 0}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder={orgsLoading ? "Loading…" : "Select a workspace"} />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {orgs.map((o) => (
                        <SelectItem key={o.id} value={o.id}>
                          {o.name} <span className="text-muted-foreground">({o.slug})</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email address</FormLabel>
                  <FormControl>
                    <Input type="email" placeholder="user@example.com" {...field} />
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
                      {roles.map((r) => (
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
        );
      }}
    </FormDialog>
  );
}
