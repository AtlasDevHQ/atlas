"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useUserRole } from "@/ui/hooks/use-platform-admin-guard";
import { useBranding } from "@/ui/hooks/use-branding";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  ChevronRight,
  LayoutDashboard,
  Database,
  Users,
  BarChart3,
  Brain,
  Settings,
  Shield,
  Globe,
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

// ---------------------------------------------------------------------------
// Nav data
// ---------------------------------------------------------------------------

interface NavSubItem {
  href: string;
  label: string;
  /** When true, only highlight on exact pathname match (no prefix matching). */
  exact?: boolean;
  /** When set, only users with this role see this item. */
  requiredRole?: "platform_admin";
}

interface NavGroup {
  title: string;
  icon: LucideIcon;
  items: NavSubItem[];
  requiredRole?: "platform_admin";
}

const navGroups: NavGroup[] = [
  {
    title: "Data",
    icon: Database,
    items: [
      { href: "/admin/semantic", label: "Semantic Layer" },
      { href: "/admin/schema-diff", label: "Schema Diff" },
      { href: "/admin/connections", label: "Connections" },
      { href: "/admin/cache", label: "Cache" },
    ],
  },
  {
    title: "Intelligence",
    icon: Brain,
    items: [
      { href: "/admin/model-config", label: "AI Provider", requiredRole: "platform_admin" },
      { href: "/admin/learned-patterns", label: "Learned Patterns" },
      { href: "/admin/prompts", label: "Prompt Library" },
      { href: "/admin/actions", label: "Actions" },
    ],
  },
  {
    title: "Users & Access",
    icon: Users,
    items: [
      { href: "/admin/users", label: "Users" },
      { href: "/admin/organizations", label: "Organizations", requiredRole: "platform_admin" },
      { href: "/admin/roles", label: "Roles" },
      { href: "/admin/sessions", label: "Sessions" },
      { href: "/admin/api-keys", label: "API Keys" },
    ],
  },
  {
    title: "Security",
    icon: Shield,
    items: [
      { href: "/admin/sso", label: "SSO" },
      { href: "/admin/scim", label: "SCIM" },
      { href: "/admin/ip-allowlist", label: "IP Allowlist" },
      { href: "/admin/abuse", label: "Abuse Prevention", requiredRole: "platform_admin" },
      { href: "/admin/approval", label: "Approval Workflows" },
      { href: "/admin/compliance", label: "PII Compliance" },
    ],
  },
  {
    title: "Monitoring",
    icon: BarChart3,
    items: [
      { href: "/admin/audit", label: "Audit Log" },
      { href: "/admin/token-usage", label: "Token Usage" },
      { href: "/admin/usage", label: "Usage" },
      { href: "/admin/scheduled-tasks", label: "Scheduled Tasks" },
    ],
  },
  {
    title: "Configuration",
    icon: Settings,
    items: [
      { href: "/admin/plugins", label: "Plugins" },
      { href: "/admin/billing", label: "Billing" },
      { href: "/admin/branding", label: "Branding" },
      { href: "/admin/settings", label: "Settings" },
    ],
  },
  {
    title: "Platform",
    icon: Globe,
    requiredRole: "platform_admin",
    items: [
      { href: "/admin/platform", label: "Overview", exact: true },
      { href: "/admin/platform/sla", label: "SLA Monitoring" },
      { href: "/admin/platform/backups", label: "Backups" },
      { href: "/admin/platform/residency", label: "Data Residency" },
      { href: "/admin/platform/domains", label: "Custom Domains" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AdminSidebar() {
  const pathname = usePathname();
  const userRole = useUserRole();
  const { branding } = useBranding();

  function isSubItemActive(item: NavSubItem) {
    if (item.exact) return pathname === item.href;
    return pathname === item.href || pathname.startsWith(item.href + "/");
  }

  function isGroupActive(group: NavGroup) {
    return group.items.some((item) => isSubItemActive(item));
  }

  const visibleGroups = navGroups
    .filter((group) => !group.requiredRole || group.requiredRole === userRole)
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) => !item.requiredRole || item.requiredRole === userRole,
      ),
    }))
    .filter((group) => group.items.length > 0);

  const showCustomLogo = branding?.logoUrl;
  const headerTitle = branding?.hideAtlasBranding
    ? (branding.logoText || "Admin")
    : (branding?.logoText || "Atlas");
  const headerSubtitle = branding?.hideAtlasBranding ? "" : "Admin Console";

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href="/admin">
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
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">{headerTitle}</span>
                  {headerSubtitle && <span className="truncate text-xs">{headerSubtitle}</span>}
                </div>
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
                defaultOpen={isGroupActive(group)}
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
                          <SidebarMenuSubButton asChild isActive={isSubItemActive(item)}>
                            <Link href={item.href}>
                              <span>{item.label}</span>
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
