"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { ChevronsUpDown, Check, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth/client";
import { cn } from "@/lib/utils";

interface OrgOption {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
}

export interface OrgSwitcherProps {
  /**
   * `sidebar` — full-width sidebar block (default).
   * `inline` — compact button suited to a top-bar / breadcrumb root.
   */
  variant?: "sidebar" | "inline";
}

export function OrgSwitcher({ variant = "sidebar" }: OrgSwitcherProps) {
  const session = authClient.useSession();
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [switchError, setSwitchError] = useState<string | null>(null);

  // Better Auth's typed session covers the base shape; `activeOrganization*`
  // are custom fields configured via `session.fields` in the auth setup, so
  // they're not on the inferred interface — narrow them at the read.
  const sessionExtra = session.data?.session as
    | { activeOrganizationId?: string; activeOrganizationName?: string }
    | undefined;
  const activeOrgId = sessionExtra?.activeOrganizationId;

  useEffect(() => {
    if (!session.data?.user) return;
    let cancelled = false;

    async function fetchOrgs() {
      try {
        const result = await authClient.organization.list();
        if (!cancelled && result.data) {
          setOrgs(result.data as OrgOption[]);
        }
      } catch (err) {
        // Log fetch failure — component gracefully hides when no orgs
        console.error("Failed to load organizations:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchOrgs();
    return () => { cancelled = true; };
  }, [session.data?.user]);

  const activeOrg = orgs.find((o) => o.id === activeOrgId);
  // Fall back to session metadata for the active org name when the list hasn't loaded
  const sessionOrgName = sessionExtra?.activeOrganizationName;
  const displayName = activeOrg?.name ?? sessionOrgName ?? "Workspace";

  async function switchOrg(orgId: string) {
    setSwitchError(null);
    try {
      await authClient.organization.setActive({ organizationId: orgId });
      window.location.reload();
    } catch (err) {
      console.error("Failed to switch organization:", err);
      // Sidebar variant has room for an inline banner; inline (top bar) doesn't,
      // so it routes through sonner. Both surface the failure — neither swallows.
      const message = "Failed to switch organization. Please try again.";
      if (variant === "inline") {
        toast.error(message);
      } else {
        setSwitchError(message);
      }
    }
  }

  // Don't render until we have something to show
  if (!session.data?.user) return null;
  if (loading) return null;
  if (orgs.length === 0 && !activeOrgId) return null;

  const canSwitch = orgs.length > 1;
  const isInline = variant === "inline";
  const initial = displayName.charAt(0).toUpperCase();

  const orgLabel = isInline ? (
    <div className="flex items-center gap-2">
      <div
        aria-hidden
        className="bg-primary/10 flex size-5 shrink-0 items-center justify-center rounded text-[10px] font-semibold"
      >
        {initial}
      </div>
      <span className="max-w-[10rem] truncate text-sm font-medium">{displayName}</span>
      {canSwitch && <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />}
    </div>
  ) : (
    <div className="flex w-full items-center gap-2 px-3 py-2">
      <div className="bg-primary/10 flex size-6 items-center justify-center rounded text-xs font-semibold">
        {initial}
      </div>
      <span className="flex-1 truncate text-sm font-medium">
        {displayName}
      </span>
      {canSwitch && <ChevronsUpDown className="size-4 shrink-0 opacity-50" />}
    </div>
  );

  if (!canSwitch) {
    return <div className={cn(isInline && "px-1")}>{orgLabel}</div>;
  }

  return (
    <div className={cn(isInline && "inline-flex")}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className={cn(
              isInline
                ? "h-7 gap-1 px-1.5 text-left"
                : "w-full justify-start gap-0 p-0 text-left",
            )}
          >
            {orgLabel}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56" align="start">
          <DropdownMenuLabel>Organizations</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {orgs.map((org) => (
            <DropdownMenuItem
              key={org.id}
              onClick={() => switchOrg(org.id)}
              className="gap-2"
            >
              <div className="bg-primary/10 flex size-6 items-center justify-center rounded text-xs font-semibold">
                {org.name.charAt(0).toUpperCase()}
              </div>
              <span className="flex-1 truncate">{org.name}</span>
              {org.id === activeOrgId && <Check className="size-4" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {switchError && !isInline && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-destructive">
          <AlertCircle className="size-3 shrink-0" />
          <span>{switchError}</span>
        </div>
      )}
    </div>
  );
}
