"use client";

import { Badge } from "@/components/ui/badge";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { friendlyError } from "@/ui/lib/fetch-error";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Mail, Users } from "lucide-react";
import { RelativeTimestamp } from "@/ui/components/admin/queue";
import { roleBadge } from "./roles";
import { planBadge, statusBadge } from "./statuses";

interface OrgDetail {
  organization: {
    id: string;
    name: string;
    slug: string;
    logo: string | null;
    createdAt: string;
    workspaceStatus: string;
    planTier: string;
    suspendedAt: string | null;
    deletedAt: string | null;
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

/**
 * Owns its own `useAdminFetch` keyed by `orgId` so the request only fires
 * when the parent mounts this component (i.e. on selection) — opening
 * workspace A doesn't refetch workspace B.
 */
function OrgDetailContent({ orgId }: { orgId: string }) {
  const { data, loading, error, refetch } = useAdminFetch<OrgDetail>(
    `/api/v1/admin/organizations/${orgId}`,
  );

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <LoadingState message="Loading organization..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-4">
        <ErrorBanner message={friendlyError(error)} onRetry={() => refetch()} />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
        No organization data to display.
      </div>
    );
  }

  const status = statusBadge(data.organization.workspaceStatus);
  const plan = planBadge(data.organization.planTier);
  const StatusIcon = status.Icon;
  const PlanIcon = plan.Icon;
  const pending = data.invitations.filter((i) => i.status === "pending");

  return (
    <div className="space-y-6 px-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={status.className}>
          <StatusIcon className="mr-1 size-3" />
          {status.label}
        </Badge>
        <Badge variant="outline" className={plan.className}>
          <PlanIcon className="mr-1 size-3" />
          {plan.label}
        </Badge>
        {data.organization.suspendedAt && (
          <span className="text-xs text-muted-foreground">
            Suspended <RelativeTimestamp iso={data.organization.suspendedAt} />
          </span>
        )}
        {data.organization.deletedAt && (
          <span className="text-xs text-muted-foreground">
            Deleted <RelativeTimestamp iso={data.organization.deletedAt} />
          </span>
        )}
      </div>

      <div className="space-y-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Users className="size-4" />
          Members ({data.members.length})
        </h3>
        <div className="space-y-2">
          {data.members.map((m) => {
            const { Icon: RoleIcon, className: badgeClass } = roleBadge(m.role);
            return (
              <div
                key={m.id}
                className="flex items-center justify-between rounded-md border p-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-medium">
                    {m.user.name?.charAt(0)?.toUpperCase() ??
                      m.user.email.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {m.user.name || m.user.email}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      <span>{m.user.email}</span>
                      <span aria-hidden="true"> · </span>
                      <span>Joined </span>
                      <RelativeTimestamp iso={m.createdAt} />
                    </div>
                  </div>
                </div>
                <Badge
                  variant="outline"
                  className={`capitalize shrink-0 ${badgeClass}`}
                >
                  <RoleIcon className="mr-1 size-3" />
                  {m.role}
                </Badge>
              </div>
            );
          })}
        </div>
      </div>

      {pending.length > 0 && (
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
                <div
                  key={inv.id}
                  className="flex items-center justify-between rounded-md border p-3"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {inv.email}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      <span>Expires </span>
                      <RelativeTimestamp iso={inv.expiresAt} />
                      <span aria-hidden="true"> · </span>
                      <span>Sent </span>
                      <RelativeTimestamp iso={inv.createdAt} />
                    </div>
                  </div>
                  <Badge
                    variant="outline"
                    className={`capitalize shrink-0 ${badgeClass}`}
                  >
                    {inv.role}
                  </Badge>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

interface OrgDetailSheetProps {
  orgId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Header fallback when detail hasn't loaded yet — name from the list row. */
  fallbackName?: string;
  fallbackSlug?: string;
}

export function OrgDetailSheet({
  orgId,
  open,
  onOpenChange,
  fallbackName,
  fallbackSlug,
}: OrgDetailSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg overflow-auto">
        <SheetHeader>
          <SheetTitle>{fallbackName ?? "Organization details"}</SheetTitle>
          <SheetDescription>{fallbackSlug ?? ""}</SheetDescription>
        </SheetHeader>
        {orgId ? <OrgDetailContent orgId={orgId} /> : null}
      </SheetContent>
    </Sheet>
  );
}
