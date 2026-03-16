"use client";

import { useState, useEffect } from "react";
import { ChevronsUpDown, Check, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAtlasConfig } from "@/ui/context";

interface OrgOption {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
}

export function OrgSwitcher() {
  const { authClient } = useAtlasConfig();
  const session = authClient.useSession();
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [loading, setLoading] = useState(true);

  const activeOrgId = (session.data?.session as Record<string, unknown> | undefined)?.activeOrganizationId as string | undefined;

  useEffect(() => {
    if (!session.data?.user) return;
    let cancelled = false;

    async function fetchOrgs() {
      try {
        const result = await authClient.organization.list();
        if (!cancelled && result.data) {
          setOrgs(result.data as OrgOption[]);
        }
      } catch {
        // Silently fail — org list may not be available
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchOrgs();
    return () => { cancelled = true; };
  }, [session.data?.user, authClient]);

  const activeOrg = orgs.find((o) => o.id === activeOrgId);

  async function switchOrg(orgId: string) {
    try {
      await authClient.organization.setActive({ organizationId: orgId });
      // Reload to re-fetch scoped data
      window.location.reload();
    } catch {
      // Silently fail
    }
  }

  // Don't render if no session or no orgs
  if (!session.data?.user || (orgs.length <= 1 && !loading)) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="w-full justify-start gap-2 px-3 py-2 text-left"
        >
          <div className="bg-primary/10 flex size-6 items-center justify-center rounded text-xs font-semibold">
            {activeOrg?.name.charAt(0).toUpperCase() ?? <Building2 className="size-3.5" />}
          </div>
          <span className="flex-1 truncate text-sm font-medium">
            {activeOrg?.name ?? "Select organization"}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
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
  );
}
