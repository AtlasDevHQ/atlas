"use client";

import { useEffect, useState } from "react";
import { useQueryStates } from "nuqs";
import { usersSearchParams } from "./search-params";
import { useAtlasConfig } from "@/ui/context";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
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
  useInProgressSet,
  friendlyError,
  type FetchError,
} from "@/ui/hooks/use-admin-fetch";
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

interface User {
  id: string;
  email: string;
  name: string | null;
  role: string;
  banned: boolean;
  banReason: string | null;
  banExpires: string | null;
  createdAt: string;
}

interface UserStats {
  total: number;
  banned: number;
  byRole: Record<string, number>;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  status: string;
  invited_by: string | null;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
}

type ConfirmAction =
  | { type: "ban"; user: User }
  | { type: "delete"; user: User }
  | null;

const LIMIT = 50;
const ROLES = ["viewer", "analyst", "admin"] as const;

const roleBadge: Record<string, { variant: "outline"; className: string }> = {
  admin: { variant: "outline", className: "border-red-300 text-red-700 dark:border-red-700 dark:text-red-400" },
  analyst: { variant: "outline", className: "border-blue-300 text-blue-700 dark:border-blue-700 dark:text-blue-400" },
  viewer: { variant: "outline", className: "border-zinc-300 text-zinc-600 dark:border-zinc-600 dark:text-zinc-400" },
};

const inviteStatusBadge: Record<string, { variant: "outline"; className: string }> = {
  pending: { variant: "outline", className: "border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400" },
  accepted: { variant: "outline", className: "border-green-300 text-green-700 dark:border-green-700 dark:text-green-400" },
  revoked: { variant: "outline", className: "border-zinc-300 text-zinc-600 dark:border-zinc-600 dark:text-zinc-400" },
  expired: { variant: "outline", className: "border-zinc-300 text-zinc-500 dark:border-zinc-600 dark:text-zinc-500" },
};

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

  const busy = useInProgressSet();

  // -- Invite dialog state --
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<string>("analyst");
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteResult, setInviteResult] = useState<{ inviteUrl: string; emailSent: boolean; emailError?: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // -- Invitations list --
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [invitationsLoading, setInvitationsLoading] = useState(true);
  const [invitationsVersion, setInvitationsVersion] = useState(0);

  const { data: stats, error: statsError } = useAdminFetch<UserStats>(
    "/api/v1/admin/users/stats",
  );

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

  async function adminAction(
    userId: string,
    path: string,
    method: string,
    body?: Record<string, unknown>,
  ) {
    busy.start(userId);
    try {
      const res = await fetch(`${apiUrl}/api/v1/admin/users/${userId}${path}`, {
        method,
        credentials,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError({ message: data.message ?? `Action failed (HTTP ${res.status})`, status: res.status });
        return;
      }
      // Refresh the list
      setParams((p) => ({ ...p }));
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : "Action failed" });
    } finally {
      busy.stop(userId);
    }
  }

  async function handleRoleChange(userId: string, newRole: string) {
    await adminAction(userId, "/role", "PATCH", { role: newRole });
  }

  async function handleBan(user: User) {
    await adminAction(user.id, "/ban", "POST");
    setConfirmAction(null);
  }

  async function handleUnban(userId: string) {
    await adminAction(userId, "/unban", "POST");
  }

  async function handleRevoke(userId: string) {
    await adminAction(userId, "/revoke", "POST");
  }

  async function handleDelete(user: User) {
    await adminAction(user.id, "", "DELETE");
    setConfirmAction(null);
  }

  // -- Invite handlers --

  function resetInviteDialog() {
    setInviteEmail("");
    setInviteRole("analyst");
    setInviteError(null);
    setInviteResult(null);
    setInviteLoading(false);
    setCopied(false);
  }

  async function handleInvite() {
    setInviteLoading(true);
    setInviteError(null);
    try {
      const res = await fetch(`${apiUrl}/api/v1/admin/users/invite`, {
        method: "POST",
        credentials,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });
      const data = await res.json();
      if (!res.ok) {
        setInviteError(data.message ?? `Failed (HTTP ${res.status})`);
        return;
      }
      setInviteResult({ inviteUrl: data.inviteUrl, emailSent: data.emailSent, emailError: data.emailError });
      setInvitationsVersion((v) => v + 1);
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : "Failed to send invitation");
    } finally {
      setInviteLoading(false);
    }
  }

  async function handleCopyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setInviteError("Could not copy to clipboard. Please select and copy the link manually.");
    }
  }

  async function handleRevokeInvitation(id: string) {
    try {
      const res = await fetch(`${apiUrl}/api/v1/admin/users/invitations/${id}`, {
        method: "DELETE",
        credentials,
      });
      if (res.ok) {
        setInvitationsVersion((v) => v + 1);
      } else {
        const data = await res.json().catch(() => ({}));
        setError({ message: data.message ?? `Failed to revoke invitation (HTTP ${res.status})`, status: res.status });
      }
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : "Failed to revoke invitation" });
    }
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

  const page = params.page;
  const totalPages = Math.max(1, Math.ceil(total / LIMIT));
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
            <StatCard title="Admins" value="unavailable" icon={<ShieldCheck className="size-4" />} />
            <StatCard title="Analysts" value="unavailable" icon={<Shield className="size-4" />} />
            <StatCard title="Viewers" value="unavailable" icon={<Eye className="size-4" />} />
          </div>
        ) : stats ? (
          <div className="grid gap-4 sm:grid-cols-4">
            <StatCard
              title="Total Users"
              value={stats.total.toLocaleString()}
              icon={<Users className="size-4" />}
            />
            <StatCard
              title="Admins"
              value={(stats.byRole.admin ?? 0).toLocaleString()}
              icon={<ShieldCheck className="size-4" />}
            />
            <StatCard
              title="Analysts"
              value={(stats.byRole.analyst ?? 0).toLocaleString()}
              icon={<Shield className="size-4" />}
            />
            <StatCard
              title="Viewers"
              value={(stats.byRole.viewer ?? 0).toLocaleString()}
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
        {error && error.status !== 401 && error.status !== 403 && error.status !== 404 ? (
          <ErrorBanner message={friendlyError(error)} onRetry={() => setParams({ page: 1 })} />
        ) : loading ? (
          <div className="flex h-64 items-center justify-center">
            <LoadingState message="Loading users..." />
          </div>
        ) : users.length === 0 ? (
          <EmptyState icon={Users} message="No users found" />
        ) : (
          <>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead className="w-32">Name</TableHead>
                    <TableHead className="w-32">Role</TableHead>
                    <TableHead className="w-24">Status</TableHead>
                    <TableHead className="w-36">Created</TableHead>
                    <TableHead className="w-16" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((user) => (
                    <TableRow key={user.id} className={busy.has(user.id) ? "opacity-50" : ""}>
                      <TableCell className="text-sm font-medium">{user.email}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {user.name || "\u2014"}
                      </TableCell>
                      <TableCell>
                        <Badge {...(roleBadge[user.role] ?? roleBadge.viewer)}>
                          {user.role}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {user.banned ? (
                          <Badge variant="outline" className="border-yellow-300 text-yellow-700 dark:border-yellow-700 dark:text-yellow-400">
                            Banned
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="border-green-300 text-green-700 dark:border-green-700 dark:text-green-400">
                            Active
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(user.createdAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </TableCell>
                      <TableCell>
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
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Page {page} of {totalPages} ({total} total)
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setParams((p) => ({ page: p.page - 1 }))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setParams((p) => ({ page: p.page + 1 }))}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
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
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead className="w-32">Role</TableHead>
                    <TableHead className="w-28">Status</TableHead>
                    <TableHead className="w-36">Expires</TableHead>
                    <TableHead className="w-36">Sent</TableHead>
                    <TableHead className="w-16" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invitations.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell className="text-sm font-medium">{inv.email}</TableCell>
                      <TableCell>
                        <Badge {...(roleBadge[inv.role] ?? roleBadge.viewer)}>
                          {inv.role}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge {...(inviteStatusBadge[inv.status] ?? inviteStatusBadge.pending)}>
                          {inv.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(inv.expires_at).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(inv.created_at).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </TableCell>
                      <TableCell>
                        {inv.status === "pending" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="size-8 p-0 text-muted-foreground hover:text-destructive"
                            onClick={() => handleRevokeInvitation(inv.id)}
                            title="Revoke invitation"
                          >
                            <X className="size-4" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
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
              {inviteError && (
                <p className="text-sm text-destructive">{inviteError}</p>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => setInviteOpen(false)}>Cancel</Button>
                <Button onClick={handleInvite} disabled={inviteLoading || !inviteEmail}>
                  {inviteLoading ? "Sending..." : "Send invitation"}
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
