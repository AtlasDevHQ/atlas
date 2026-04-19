"use client";

import { useEffect, useState } from "react";
import { useQueryStates } from "nuqs";
import { orgsSearchParams } from "./search-params";
import type { ColumnDef } from "@tanstack/react-table";
import { useAtlasConfig } from "@/ui/context";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { usePlatformAdminGuard } from "@/ui/hooks/use-platform-admin-guard";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/data-table/data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTableSortList } from "@/components/data-table/data-table-sort-list";
import { useDataTable } from "@/hooks/use-data-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { StatCard } from "@/ui/components/admin/stat-card";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import type { FetchError } from "@/ui/hooks/use-admin-fetch";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { RelativeTimestamp } from "@/ui/components/admin/queue";
import { TooltipProvider } from "@/components/ui/tooltip";
import { roleBadge } from "./roles";
import {
  Building2,
  Search,
  Users,
  Eye,
  Mail,
} from "lucide-react";

// -- Types --

interface Org {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  createdAt: string;
  memberCount: number;
}

interface OrgDetail {
  organization: {
    id: string;
    name: string;
    slug: string;
    logo: string | null;
    createdAt: string;
  };
  members: Array<{
    id: string;
    userId: string;
    role: string;
    createdAt: string;
    user: { id: string; name: string; email: string; image: string | null };
  }>;
  invitations: Array<{
    id: string;
    email: string;
    role: string;
    status: string;
    expiresAt: string;
    createdAt: string;
  }>;
}

export default function OrganizationsPage() {
  const { blocked } = usePlatformAdminGuard();
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FetchError | null>(null);
  const [params, setParams] = useQueryStates(orgsSearchParams);
  const [searchInput, setSearchInput] = useState(params.search);

  // Detail sheet
  const [selectedOrg, setSelectedOrg] = useState<OrgDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Fetch all organizations once — search is client-side
  const [allOrgs, setAllOrgs] = useState<Org[]>([]);
  useEffect(() => {
    let cancelled = false;
    async function fetchOrgs() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${apiUrl}/api/v1/admin/organizations`, { credentials });
        if (!res.ok) {
          if (!cancelled) setError({ message: `HTTP ${res.status}`, status: res.status });
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          setAllOrgs(data.organizations ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          setError({ message: err instanceof Error ? err.message : "Failed to load organizations" });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchOrgs();
    return () => { cancelled = true; };
  }, [apiUrl, credentials]);

  // Client-side search filtering
  const orgs = params.search
    ? allOrgs.filter((o) => {
        const q = params.search.toLowerCase();
        return o.name.toLowerCase().includes(q) || o.slug.toLowerCase().includes(q);
      })
    : allOrgs;

  async function openDetail(orgId: string) {
    setDetailOpen(true);
    setDetailLoading(true);
    setDetailError(null);
    try {
      const res = await fetch(`${apiUrl}/api/v1/admin/organizations/${orgId}`, { credentials });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setDetailError(body.message ?? `Failed to load organization (HTTP ${res.status})`);
        setSelectedOrg(null);
        return;
      }
      const data = await res.json();
      setSelectedOrg(data);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "Network error loading organization");
      setSelectedOrg(null);
    } finally {
      setDetailLoading(false);
    }
  }

  function handleSearch() {
    setParams({ search: searchInput, page: 1 });
  }

  const columns: ColumnDef<Org>[] = [
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <div className="bg-primary/10 flex size-8 items-center justify-center rounded-md text-sm font-semibold">
            {row.original.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <div className="font-medium">{row.original.name}</div>
            <div className="text-xs text-muted-foreground">{row.original.slug}</div>
          </div>
        </div>
      ),
    },
    {
      accessorKey: "memberCount",
      header: "Members",
      cell: ({ row }) => (
        <Badge variant="outline">
          <Users className="mr-1 size-3" />
          {row.original.memberCount}
        </Badge>
      ),
    },
    {
      accessorKey: "createdAt",
      header: "Created",
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          <RelativeTimestamp iso={row.original.createdAt} />
        </span>
      ),
    },
    {
      id: "actions",
      header: () => null,
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="sm"
          className="size-8 p-0"
          onClick={() => openDetail(row.original.id)}
        >
          <Eye className="size-4" />
        </Button>
      ),
      enableSorting: false,
      size: 64,
    },
  ];

  const { table } = useDataTable({
    data: orgs,
    columns,
    pageCount: 1,
    initialState: {
      sorting: [{ id: "createdAt", desc: true }],
      pagination: { pageIndex: 0, pageSize: 50 },
    },
    getRowId: (row) => row.id,
  });

  if (blocked) return <LoadingState message="Checking access..." />;

  return (
    <TooltipProvider>
    <div className="p-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Organizations</h1>
        <p className="text-sm text-muted-foreground">Manage organizations and tenants</p>
      </div>

      <ErrorBoundary>
        <div className="space-y-6">
          {/* Stats row */}
          <div className="grid gap-4 sm:grid-cols-2">
            <StatCard
              title="Total Organizations"
              value={loading ? "..." : orgs.length.toLocaleString()}
              icon={<Building2 className="size-4" />}
            />
            <StatCard
              title="Total Members"
              value={loading ? "..." : orgs.reduce((sum, o) => sum + o.memberCount, 0).toLocaleString()}
              icon={<Users className="size-4" />}
            />
          </div>

          {/* Filter row */}
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Search</label>
              <div className="flex gap-2">
                <Input
                  type="text"
                  placeholder="Search by name or slug..."
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
          </div>

          {/* Content */}
          <AdminContentWrapper
            loading={loading}
            error={error}
            feature="Organization Management"
            onRetry={() => setParams({ page: 1 })}
            loadingMessage="Loading organizations..."
            emptyIcon={Building2}
            emptyTitle="No organizations yet"
            emptyDescription="Organizations are created when a new user completes signup."
            isEmpty={orgs.length === 0}
            hasFilters={!!params.search}
            onClearFilters={() => setParams({ search: "", page: 1 })}
          >
            <DataTable table={table}>
              <DataTableToolbar table={table}>
                <DataTableSortList table={table} />
              </DataTableToolbar>
            </DataTable>
          </AdminContentWrapper>
        </div>
      </ErrorBoundary>

      {/* Organization detail sheet */}
      <Sheet open={detailOpen} onOpenChange={setDetailOpen}>
        <SheetContent className="w-full sm:max-w-lg overflow-auto">
          <SheetHeader>
            <SheetTitle>
              {detailLoading
                ? "Loading organization…"
                : detailError
                  ? "Could not load organization"
                  : selectedOrg?.organization.name ?? "Organization details"}
            </SheetTitle>
            <SheetDescription>
              {detailLoading
                ? "Fetching members and invitations…"
                : detailError
                  ? "The organization could not be loaded. Try again in a moment."
                  : selectedOrg?.organization.slug ?? ""}
            </SheetDescription>
          </SheetHeader>

          {detailLoading ? (
            <div className="flex h-32 items-center justify-center">
              <LoadingState message="Loading organization..." />
            </div>
          ) : selectedOrg ? (
            <div className="space-y-6 px-4">
              {/* Members */}
              <div className="space-y-3">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <Users className="size-4" />
                  Members ({selectedOrg.members.length})
                </h3>
                <div className="space-y-2">
                  {selectedOrg.members.map((m) => {
                    const { Icon: RoleIcon, className: badgeClass } = roleBadge(m.role);
                    return (
                      <div key={m.id} className="flex items-center justify-between rounded-md border p-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-medium">
                            {m.user.name?.charAt(0)?.toUpperCase() ?? m.user.email.charAt(0).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">{m.user.name || m.user.email}</div>
                            <div className="truncate text-xs text-muted-foreground">
                              <span>{m.user.email}</span>
                              <span aria-hidden="true"> · </span>
                              <span>Joined </span>
                              <RelativeTimestamp iso={m.createdAt} />
                            </div>
                          </div>
                        </div>
                        <Badge variant="outline" className={`capitalize shrink-0 ${badgeClass}`}>
                          <RoleIcon className="mr-1 size-3" />
                          {m.role}
                        </Badge>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Pending invitations */}
              {(() => {
                const pending = selectedOrg.invitations.filter((i) => i.status === "pending");
                if (pending.length === 0) return null;
                return (
                  <div className="space-y-3">
                    <h3 className="flex items-center gap-2 text-sm font-semibold">
                      <Mail className="size-4" />
                      Pending Invitations
                      <Badge variant="outline" className="ml-1 font-normal">
                        {pending.length}
                      </Badge>
                    </h3>
                    <div className="space-y-2">
                      {pending.map((inv) => {
                        const { className: badgeClass } = roleBadge(inv.role);
                        return (
                          <div key={inv.id} className="flex items-center justify-between rounded-md border p-3">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium">{inv.email}</div>
                              <div className="truncate text-xs text-muted-foreground">
                                <span>Expires </span>
                                <RelativeTimestamp iso={inv.expiresAt} />
                                <span aria-hidden="true"> · </span>
                                <span>Sent </span>
                                <RelativeTimestamp iso={inv.createdAt} />
                              </div>
                            </div>
                            <Badge variant="outline" className={`capitalize shrink-0 ${badgeClass}`}>
                              {inv.role}
                            </Badge>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
            </div>
          ) : detailError ? (
            <div className="flex h-32 items-center justify-center px-4 text-center text-sm text-destructive">
              {detailError}
            </div>
          ) : (
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
              No organization data to display.
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
    </TooltipProvider>
  );
}
