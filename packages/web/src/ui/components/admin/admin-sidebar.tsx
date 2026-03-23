"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAtlasConfig } from "@/ui/context";
import { useBranding } from "@/ui/hooks/use-branding";
import {
  Ban,
  LayoutDashboard,
  Database,
  GitCompareArrows,
  Cable,
  ScrollText,
  Users,
  Building2,
  Monitor,
  Puzzle,
  CalendarClock,
  Zap,
  Coins,
  BarChart3,
  HardDrive,
  Brain,
  BookOpen,
  ShieldCheck,
  ShieldAlert,
  RefreshCw,
  Settings,
  Shield,
  KeyRound,
  Cpu,
  Globe,
  Fingerprint,
  Paintbrush,
  ArrowLeft,
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
  SidebarFooter,
  SidebarRail,
} from "@/components/ui/sidebar";

const navItems = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/admin/semantic", label: "Semantic Layer", icon: Database },
  { href: "/admin/schema-diff", label: "Schema Diff", icon: GitCompareArrows },
  { href: "/admin/connections", label: "Connections", icon: Cable },
  { href: "/admin/audit", label: "Audit", icon: ScrollText },
  { href: "/admin/organizations", label: "Organizations", icon: Building2 },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/sessions", label: "Sessions", icon: Monitor },
  { href: "/admin/plugins", label: "Plugins", icon: Puzzle },
  { href: "/admin/scheduled-tasks", label: "Scheduled Tasks", icon: CalendarClock },
  { href: "/admin/token-usage", label: "Token Usage", icon: Coins },
  { href: "/admin/usage", label: "Usage", icon: BarChart3 },
  { href: "/admin/cache", label: "Cache", icon: HardDrive },
  { href: "/admin/learned-patterns", label: "Learned Patterns", icon: Brain },
  { href: "/admin/prompts", label: "Prompt Library", icon: BookOpen },
  { href: "/admin/roles", label: "Roles", icon: KeyRound },
  { href: "/admin/ip-allowlist", label: "IP Allowlist", icon: Shield },
  { href: "/admin/abuse", label: "Abuse Prevention", icon: Ban },
  { href: "/admin/actions", label: "Actions", icon: Zap },
  { href: "/admin/approval", label: "Approval Workflows", icon: ShieldAlert },
  { href: "/admin/compliance", label: "PII Compliance", icon: Fingerprint },
  { href: "/admin/model-config", label: "AI Provider", icon: Cpu },
  { href: "/admin/sso", label: "SSO", icon: ShieldCheck },
  { href: "/admin/scim", label: "SCIM", icon: RefreshCw },
  { href: "/admin/branding", label: "Branding", icon: Paintbrush },
  { href: "/admin/settings", label: "Settings", icon: Settings },
  { href: "/admin/platform", label: "Platform Admin", icon: Globe, requiredRole: "platform_admin" as const },
];

export function AdminSidebar() {
  const pathname = usePathname();
  const { authClient } = useAtlasConfig();
  const session = authClient.useSession();
  const userRole = (session.data?.user as Record<string, unknown> | undefined)?.role as string | undefined;
  const { branding } = useBranding();

  function isActive(item: (typeof navItems)[number]) {
    if (item.exact) return pathname === item.href;
    return pathname.startsWith(item.href);
  }

  const visibleItems = navItems.filter((item) =>
    !item.requiredRole || item.requiredRole === userRole,
  );

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
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {visibleItems.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton asChild isActive={isActive(item)} tooltip={item.label}>
                    <Link href={item.href}>
                      <item.icon />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
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
