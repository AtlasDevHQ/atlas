"use client";

import { useState } from "react";
import { useQueryStates } from "nuqs";
import { orgsSearchParams } from "./search-params";
import type { ColumnDef } from "@tanstack/react-table";
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
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { RelativeTimestamp } from "@/ui/components/admin/queue";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PLAN_TIERS } from "@useatlas/types";
import type { PlanTier } from "@useatlas/types";
import { OrgDetailSheet } from "./detail-sheet";
import { planBadge, statusBadge } from "./statuses";
import {
  Building2,
  Search,
  Users,
  Eye,
  MoreHorizontal,
  Pause,
  Play,
  Trash2,
  CreditCard,
} from "lucide-react";

// -- Types --

interface Org {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  createdAt: string;
  memberCount: number;
  workspaceStatus: string;
  planTier: string;
  suspendedAt: string | null;
  deletedAt: string | null;
}

interface OrgListResponse {
  organizations: Org[];
  total: number;
}

type ConfirmAction =
  | { type: "suspend"; org: Org }
  | { type: "activate"; org: Org }
  | { type: "delete"; org: Org }
  | { type: "plan"; org: Org }
  | null;

export default function OrganizationsPage() {
  const { blocked } = usePlatformAdminGuard();

  const [params, setParams] = useQueryStates(orgsSearchParams);
  const [searchInput, setSearchInput] = useState(params.search);

  // Open + selected tracked separately so the sheet header keeps the row's
  // name visible during the detail fetch instead of flashing "Loading…".
  const [selectedOrg, setSelectedOrg] = useState<Org | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const [planTierSelection, setPlanTierSelection] = useState<PlanTier | "">("");

  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);

  const { data, loading, error, refetch } = useAdminFetch<OrgListResponse>(
    "/api/v1/admin/organizations",
  );
  const allOrgs = data?.organizations ?? [];

  // Single hook so all four actions share one in-flight set and one per-row
  // error map — `errorFor(org.id)` works across actions for any given row.
  const orgAction = useAdminMutation<{ message: string }>({
    invalidates: refetch,
  });

  const orgs = params.search
    ? allOrgs.filter((o) => {
        const q = params.search.toLowerCase();
        return o.name.toLowerCase().includes(q) || o.slug.toLowerCase().includes(q);
      })
    : allOrgs;

  function openDetail(org: Org) {
    setSelectedOrg(org);
    setDetailOpen(true);
  }

  function handleSearch() {
    setParams({ search: searchInput, page: 1 });
  }

  // Returns `ok` so destructive confirms stay open on failure — the inline
  // `MutationErrorSurface` inside each dialog body shows the operator why.
  async function handleSuspend(org: Org): Promise<boolean> {
    const result = await orgAction.mutate({
      path: `/api/v1/admin/organizations/${org.id}/suspend`,
      method: "PATCH",
      itemId: org.id,
    });
    return result.ok;
  }

  async function handleActivate(org: Org): Promise<boolean> {
    const result = await orgAction.mutate({
      path: `/api/v1/admin/organizations/${org.id}/activate`,
      method: "PATCH",
      itemId: org.id,
    });
    return result.ok;
  }

  async function handleDelete(org: Org): Promise<boolean> {
    const result = await orgAction.mutate({
      path: `/api/v1/admin/organizations/${org.id}`,
      method: "DELETE",
      itemId: org.id,
    });
    return result.ok;
  }

  async function handleChangePlan(org: Org, tier: PlanTier): Promise<boolean> {
    const result = await orgAction.mutate({
      path: `/api/v1/admin/organizations/${org.id}/plan`,
      method: "PATCH",
      body: { planTier: tier },
      itemId: org.id,
    });
    return result.ok;
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
      accessorKey: "workspaceStatus",
      header: "Status",
      cell: ({ row }) => {
        const { Icon, className, label } = statusBadge(row.original.workspaceStatus);
        return (
          <Badge variant="outline" className={className}>
            <Icon className="mr-1 size-3" />
            {label}
          </Badge>
        );
      },
    },
    {
      accessorKey: "planTier",
      header: "Plan",
      cell: ({ row }) => {
        const { Icon, className, label } = planBadge(row.original.planTier);
        return (
          <Badge variant="outline" className={className}>
            <Icon className="mr-1 size-3" />
            {label}
          </Badge>
        );
      },
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
      cell: ({ row }) => {
        const org = row.original;
        // Soft-deleted workspaces 409 on every action except view.
        const isDeleted = org.workspaceStatus === "deleted";
        return (
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="size-8 p-0"
              onClick={() => openDetail(org)}
              aria-label={`View ${org.name}`}
            >
              <Eye className="size-4" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-8 p-0"
                  disabled={isDeleted}
                  aria-label={`Actions for ${org.name}`}
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {org.workspaceStatus === "active" && (
                  <DropdownMenuItem
                    onClick={() => setConfirmAction({ type: "suspend", org })}
                  >
                    <Pause className="mr-2 size-4" />
                    Suspend workspace
                  </DropdownMenuItem>
                )}
                {org.workspaceStatus === "suspended" && (
                  <DropdownMenuItem
                    onClick={() => setConfirmAction({ type: "activate", org })}
                  >
                    <Play className="mr-2 size-4" />
                    Activate workspace
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={() => {
                    setPlanTierSelection(
                      (PLAN_TIERS as readonly string[]).includes(org.planTier)
                        ? (org.planTier as PlanTier)
                        : "",
                    );
                    setConfirmAction({ type: "plan", org });
                  }}
                >
                  <CreditCard className="mr-2 size-4" />
                  Change plan
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => setConfirmAction({ type: "delete", org })}
                >
                  <Trash2 className="mr-2 size-4" />
                  Delete workspace
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
      enableSorting: false,
      enableHiding: false,
      size: 96,
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

          <MutationErrorSurface
            error={orgAction.error}
            feature="Organizations"
            onRetry={orgAction.clearError}
          />

          {/* Content */}
          <AdminContentWrapper
            loading={loading}
            error={error}
            feature="Organization Management"
            onRetry={refetch}
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
      <OrgDetailSheet
        orgId={selectedOrg?.id ?? null}
        open={detailOpen}
        onOpenChange={(open) => {
          setDetailOpen(open);
          if (!open) setSelectedOrg(null);
        }}
        fallbackName={selectedOrg?.name}
        fallbackSlug={selectedOrg?.slug}
      />

      {/* Suspend confirmation dialog */}
      <AlertDialog
        open={confirmAction?.type === "suspend"}
        onOpenChange={(open) => { if (!open) setConfirmAction(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Suspend workspace</AlertDialogTitle>
            <AlertDialogDescription>
              This will block all queries from{" "}
              <strong>{confirmAction?.type === "suspend" ? confirmAction.org.name : ""}</strong>{" "}
              and drain its connection pools. You can reactivate it at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmAction?.type === "suspend" && (
            <MutationErrorSurface
              error={orgAction.errorFor(confirmAction.org.id) ?? null}
              feature="Suspend workspace"
              variant="inline"
              inlinePrefix="Suspend failed."
            />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={
                confirmAction?.type === "suspend" &&
                orgAction.isMutating(confirmAction.org.id)
              }
              onClick={async () => {
                if (confirmAction?.type !== "suspend") return;
                const ok = await handleSuspend(confirmAction.org);
                if (ok) setConfirmAction(null);
              }}
            >
              Suspend
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Activate confirmation dialog */}
      <AlertDialog
        open={confirmAction?.type === "activate"}
        onOpenChange={(open) => { if (!open) setConfirmAction(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Activate workspace</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{confirmAction?.type === "activate" ? confirmAction.org.name : ""}</strong>{" "}
              will resume normal operations and queries will be unblocked immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmAction?.type === "activate" && (
            <MutationErrorSurface
              error={orgAction.errorFor(confirmAction.org.id) ?? null}
              feature="Activate workspace"
              variant="inline"
              inlinePrefix="Activate failed."
            />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={
                confirmAction?.type === "activate" &&
                orgAction.isMutating(confirmAction.org.id)
              }
              onClick={async () => {
                if (confirmAction?.type !== "activate") return;
                const ok = await handleActivate(confirmAction.org);
                if (ok) setConfirmAction(null);
              }}
            >
              Activate
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
            <AlertDialogTitle>Delete workspace</AlertDialogTitle>
            <AlertDialogDescription>
              This will soft-delete{" "}
              <strong>{confirmAction?.type === "delete" ? confirmAction.org.name : ""}</strong>{" "}
              and run cascading cleanup (drain pools, flush cache, remove associated data).
              The workspace cannot be reactivated after deletion.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmAction?.type === "delete" && (
            <MutationErrorSurface
              error={orgAction.errorFor(confirmAction.org.id) ?? null}
              feature="Delete workspace"
              variant="inline"
              inlinePrefix="Delete failed."
            />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={
                confirmAction?.type === "delete" &&
                orgAction.isMutating(confirmAction.org.id)
              }
              onClick={async () => {
                if (confirmAction?.type !== "delete") return;
                const ok = await handleDelete(confirmAction.org);
                if (ok) setConfirmAction(null);
              }}
            >
              Delete workspace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Plain Dialog — not destructive (sibling actions use AlertDialog). */}
      <Dialog
        open={confirmAction?.type === "plan"}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmAction(null);
            setPlanTierSelection("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Change plan tier</DialogTitle>
            <DialogDescription>
              Update the plan tier for{" "}
              <strong>{confirmAction?.type === "plan" ? confirmAction.org.name : ""}</strong>.
              This takes effect immediately and invalidates the workspace's plan cache.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Select
              value={planTierSelection}
              onValueChange={(v) => setPlanTierSelection(v as PlanTier)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a plan tier" />
              </SelectTrigger>
              <SelectContent>
                {PLAN_TIERS.map((t) => (
                  <SelectItem key={t} value={t} className="capitalize">
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {confirmAction?.type === "plan" &&
              planTierSelection &&
              planTierSelection === confirmAction.org.planTier && (
                <p className="text-xs text-muted-foreground">
                  This is already the workspace's current plan.
                </p>
              )}
            {confirmAction?.type === "plan" && (
              <MutationErrorSurface
                error={orgAction.errorFor(confirmAction.org.id) ?? null}
                feature="Change plan"
                variant="inline"
                inlinePrefix="Plan change failed."
              />
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setConfirmAction(null);
                setPlanTierSelection("");
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={
                !planTierSelection ||
                (confirmAction?.type === "plan" &&
                  (planTierSelection === confirmAction.org.planTier ||
                    orgAction.isMutating(confirmAction.org.id)))
              }
              onClick={async () => {
                if (confirmAction?.type !== "plan" || !planTierSelection) return;
                const ok = await handleChangePlan(
                  confirmAction.org,
                  planTierSelection,
                );
                if (ok) {
                  setConfirmAction(null);
                  setPlanTierSelection("");
                }
              }}
            >
              Update plan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </TooltipProvider>
  );
}
