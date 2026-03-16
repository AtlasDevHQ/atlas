"use client";

import { useEffect, useState } from "react";
import { useQueryStates } from "nuqs";
import { orgsSearchParams } from "./search-params";
import type { ColumnDef } from "@tanstack/react-table";
import { useAtlasConfig } from "@/ui/context";
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
import { EmptyState } from "@/ui/components/admin/empty-state";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import {
  friendlyError,
  type FetchError,
} from "@/ui/hooks/use-admin-fetch";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  Building2,
  Search,
  Users,
  Eye,
  Shield,
  ShieldCheck,
  Crown,
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

const ROLE_ICONS: Record<string, typeof Crown> = {
  owner: Crown,
  admin: ShieldCheck,
  member: Shield,
};

export default function OrganizationsPage() {
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
      cell: ({ row }) => new Date(row.original.createdAt).toLocaleDateString(),
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

  // Gate: 401/403/404
  if (!loading && error?.status && [401, 403, 404].includes(error.status)) {
    return (
      <div className="flex h-[calc(100dvh-3rem)] flex-col">
        <div className="border-b px-6 py-4">
          <h1 className="text-2xl font-bold tracking-tight">Organizations</h1>
          <p className="text-sm text-muted-foreground">Manage organizations and tenants</p>
        </div>
        <FeatureGate status={error.status as 401 | 403 | 404} feature="Organization Management" />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Organizations</h1>
          <p className="text-sm text-muted-foreground">Manage organizations and tenants</p>
        </div>
      </div>

      <ErrorBoundary>
        <div className="flex-1 overflow-auto p-6 space-y-6">
          {/* Stats row */}
          <div className="grid gap-4 sm:grid-cols-3">
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
          {error && error.status !== 401 && error.status !== 403 && error.status !== 404 ? (
            <ErrorBanner message={friendlyError(error)} onRetry={() => setParams({ page: 1 })} />
          ) : loading ? (
            <div className="flex h-64 items-center justify-center">
              <LoadingState message="Loading organizations..." />
            </div>
          ) : orgs.length === 0 ? (
            params.search ? (
              <EmptyState
                icon={Search}
                title="No organizations match your search"
                description="Try adjusting your search terms"
                action={{ label: "Clear search", onClick: () => setParams({ search: "", page: 1 }) }}
              />
            ) : (
              <EmptyState
                icon={Building2}
                title="No organizations yet"
                description="Organizations are created when users sign up and go through the first-run flow"
              />
            )
          ) : (
            <DataTable table={table}>
              <DataTableToolbar table={table}>
                <DataTableSortList table={table} />
              </DataTableToolbar>
            </DataTable>
          )}
        </div>
      </ErrorBoundary>

      {/* Organization detail sheet */}
      <Sheet open={detailOpen} onOpenChange={setDetailOpen}>
        <SheetContent className="w-full sm:max-w-lg overflow-auto">
          <SheetHeader>
            <SheetTitle>
              {selectedOrg?.organization.name ?? "Organization Details"}
            </SheetTitle>
            <SheetDescription>
              {selectedOrg?.organization.slug ?? "Loading..."}
            </SheetDescription>
          </SheetHeader>

          {detailLoading ? (
            <div className="flex h-32 items-center justify-center">
              <LoadingState message="Loading..." />
            </div>
          ) : selectedOrg ? (
            <div className="mt-6 space-y-6">
              {/* Members */}
              <div className="space-y-3">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <Users className="size-4" />
                  Members ({selectedOrg.members.length})
                </h3>
                <div className="space-y-2">
                  {selectedOrg.members.map((m) => {
                    const RoleIcon = ROLE_ICONS[m.role] ?? Shield;
                    return (
                      <div key={m.id} className="flex items-center justify-between rounded-md border p-3">
                        <div className="flex items-center gap-3">
                          <div className="bg-muted flex size-8 items-center justify-center rounded-full text-xs font-medium">
                            {m.user.name?.charAt(0)?.toUpperCase() ?? m.user.email.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <div className="text-sm font-medium">{m.user.name || m.user.email}</div>
                            <div className="text-xs text-muted-foreground">{m.user.email}</div>
                          </div>
                        </div>
                        <Badge variant="outline" className="capitalize">
                          <RoleIcon className="mr-1 size-3" />
                          {m.role}
                        </Badge>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Pending invitations */}
              {selectedOrg.invitations.filter((i) => i.status === "pending").length > 0 && (
                <div className="space-y-3">
                  <h3 className="flex items-center gap-2 text-sm font-semibold">
                    <Mail className="size-4" />
                    Pending Invitations
                  </h3>
                  <div className="space-y-2">
                    {selectedOrg.invitations
                      .filter((i) => i.status === "pending")
                      .map((inv) => (
                        <div key={inv.id} className="flex items-center justify-between rounded-md border p-3">
                          <div>
                            <div className="text-sm font-medium">{inv.email}</div>
                            <div className="text-xs text-muted-foreground">
                              Expires {new Date(inv.expiresAt).toLocaleDateString()}
                            </div>
                          </div>
                          <Badge variant="outline" className="capitalize">{inv.role}</Badge>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          ) : detailError ? (
            <div className="flex h-32 items-center justify-center text-sm text-destructive">
              {detailError}
            </div>
          ) : (
            <div className="flex h-32 items-center justify-center text-muted-foreground">
              No data available
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
