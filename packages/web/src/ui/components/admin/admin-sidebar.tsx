"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Database,
  Cable,
  ScrollText,
  Puzzle,
  CalendarClock,
  Zap,
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
  SidebarSeparator,
} from "@/components/ui/sidebar";

const navItems = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/admin/semantic", label: "Semantic Layer", icon: Database },
  { href: "/admin/connections", label: "Connections", icon: Cable },
  { href: "/admin/audit", label: "Audit", icon: ScrollText },
  { href: "/admin/plugins", label: "Plugins", icon: Puzzle },
  { href: "/admin/scheduled-tasks", label: "Scheduled Tasks", icon: CalendarClock },
  { href: "/admin/actions", label: "Actions", icon: Zap },
];

export function AdminSidebar() {
  const pathname = usePathname();

  function isActive(item: (typeof navItems)[number]) {
    if (item.exact) return pathname === item.href;
    return pathname.startsWith(item.href);
  }

  return (
    <Sidebar>
      <SidebarHeader className="px-3 pt-4 pb-2">
        <div className="flex items-center gap-2.5">
          <svg viewBox="0 0 256 256" fill="none" className="size-6 shrink-0" aria-hidden="true">
            <path d="M128 24 L232 208 L24 208 Z" stroke="#23CE9E" strokeWidth="14" fill="none" strokeLinejoin="round" />
            <circle cx="128" cy="28" r="16" fill="#23CE9E" />
          </svg>
          <div>
            <p className="text-sm font-semibold leading-none tracking-tight">Atlas</p>
            <p className="text-xs text-muted-foreground">Admin Console</p>
          </div>
        </div>
      </SidebarHeader>
      <SidebarSeparator />
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton asChild isActive={isActive(item)} tooltip={item.label}>
                    <Link href={item.href}>
                      <item.icon className="size-4" />
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
        <SidebarSeparator />
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Back to Chat">
              <Link href="/">
                <ArrowLeft className="size-4" />
                <span>Back to Chat</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
