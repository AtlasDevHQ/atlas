"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useUserRole } from "@/ui/hooks/use-platform-admin-guard";
import { useBranding } from "@/ui/hooks/use-branding";
import { useDeployMode } from "@/ui/hooks/use-deploy-mode";
import { useMode } from "@/ui/hooks/use-mode";
import { useAtlasConfig } from "@/ui/context";
import {
  ArrowLeft,
  ChevronRight,
  LayoutDashboard,
  Code,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
  SidebarFooter,
  SidebarRail,
} from "@/components/ui/sidebar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { matchesNavItem, navGroups, type NavGroup } from "./admin-nav";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function usePendingAmendmentCount(): number {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const fetchCount = () => {
      fetch(`${apiUrl}/api/v1/admin/semantic-improve/pending-count`, {
        credentials: isCrossOrigin ? "include" : "same-origin",
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!cancelled && data && typeof data.count === "number") {
            setCount(data.count);
          }
        })
        .catch(() => {
          // intentionally ignored: badge is non-critical
        });
    };
    fetchCount();
    const interval = setInterval(fetchCount, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [apiUrl, isCrossOrigin]);

  return count;
}

export function AdminSidebar() {
  const pathname = usePathname();
  const userRole = useUserRole();
  const { branding } = useBranding();
  const { deployMode } = useDeployMode();
  const { mode, setMode, isAdmin } = useMode();
  const pendingCount = usePendingAmendmentCount();
  const isSaas = deployMode === "saas";

  function isGroupActive(group: NavGroup) {
    return group.items.some((item) => matchesNavItem(item, pathname));
  }

  // Track manually-expanded groups so client-side navigation auto-opens
  // the active group AND respects user-initiated toggles. Using a plain
  // `defaultOpen` is uncontrolled — only respected on first mount — so
  // landing on /admin/x and then navigating to /admin/y left the y-parent
  // collapsed even when y was the active item.
  const [userOpenedGroups, setUserOpenedGroups] = useState<Set<string>>(new Set());
  function isGroupOpen(group: NavGroup): boolean {
    return isGroupActive(group) || userOpenedGroups.has(group.title);
  }
  function handleGroupOpenChange(title: string, open: boolean) {
    setUserOpenedGroups((prev) => {
      const next = new Set(prev);
      if (open) next.add(title);
      else next.delete(title);
      return next;
    });
  }

  const visibleGroups = navGroups
    .filter((group) => !group.requiredRole || group.requiredRole === userRole)
    .map((group) => ({
      ...group,
      items: group.items
        .filter((item) => !item.requiredRole || item.requiredRole === userRole)
        .filter((item) => !item.selfHostedOnly || !isSaas)
        .map((item) =>
          item.href === "/admin/semantic/improve" && pendingCount > 0
            ? { ...item, badge: pendingCount }
            : item,
        ),
    }))
    .filter((group) => group.items.length > 0);

  const showCustomLogo = branding?.logoUrl;

  return (
    <Sidebar collapsible="icon">
      {/*
        Header is logo-only — workspace name + "Admin Console" surface live
        in the top-bar breadcrumb (#2176). Duplicating them here was the
        redundancy the redesign was meant to remove.
      */}
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="Admin home">
              <Link href="/admin" aria-label="Admin home">
                {showCustomLogo ? (
                  <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-muted">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={showCustomLogo as string}
                      alt=""
                      className="size-5 object-contain"
                    />
                  </div>
                ) : (
                  <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                    <svg viewBox="0 0 256 256" fill="none" className="size-4" aria-hidden="true">
                      <path d="M128 24 L232 208 L24 208 Z" stroke="currentColor" strokeWidth="20" fill="none" strokeLinejoin="round" />
                    </svg>
                  </div>
                )}
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {/* Overview — always visible, no group wrapper */}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={pathname === "/admin"} tooltip="Overview">
                  <Link href="/admin">
                    <LayoutDashboard />
                    <span>Overview</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Collapsible nav groups */}
        <SidebarGroup>
          <SidebarGroupLabel>Manage</SidebarGroupLabel>
          <SidebarMenu>
            {visibleGroups.map((group) => (
              <Collapsible
                key={group.title}
                asChild
                open={isGroupOpen(group)}
                onOpenChange={(open) => handleGroupOpenChange(group.title, open)}
                className="group/collapsible"
              >
                <SidebarMenuItem>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuButton tooltip={group.title}>
                      <group.icon />
                      <span>{group.title}</span>
                      <ChevronRight className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                    </SidebarMenuButton>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenuSub>
                      {group.items.map((item) => (
                        <SidebarMenuSubItem key={item.href}>
                          <SidebarMenuSubButton asChild isActive={matchesNavItem(item, pathname)}>
                            <Link href={item.href}>
                              <span>{item.label}</span>
                              {item.badge != null && item.badge > 0 && (
                                <span className="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">
                                  {item.badge > 99 ? "99+" : item.badge}
                                </span>
                              )}
                            </Link>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </SidebarMenuItem>
              </Collapsible>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        {isAdmin && (
          <TooltipProvider delayDuration={250}>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-2 px-2 py-1.5 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
                  <Code className="size-4 shrink-0 text-muted-foreground" />
                  <Label
                    htmlFor="mode-toggle"
                    className="flex-1 cursor-pointer text-xs font-medium text-muted-foreground group-data-[collapsible=icon]:hidden"
                  >
                    Show drafts
                  </Label>
                  <Switch
                    id="mode-toggle"
                    size="sm"
                    checked={mode === "developer"}
                    onCheckedChange={(checked) => setMode(checked ? "developer" : "published")}
                    className="group-data-[collapsible=icon]:hidden"
                  />
                </div>
              </TooltipTrigger>
              {/*
                Mode toggle controls *visibility*, not write semantics
                (#2177). Edits always stage as drafts; the pending-changes
                pill in the top bar surfaces them, and `/api/v1/admin/publish`
                promotes them. The toggle's only job is letting an admin
                preview the staged surface alongside the live one.
              */}
              <TooltipContent side="top" align="start" className="max-w-xs text-xs">
                Preview unpublished drafts alongside the live surface. Saves
                always stage as drafts regardless — flip this off to see the
                workspace exactly as non-admins do.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Back to Chat">
              <Link href="/">
                <ArrowLeft />
                <span>Back to Chat</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
