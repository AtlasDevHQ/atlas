"use client";

import type { ReactNode } from "react";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";

/**
 * Shared shell for `/`, `/notebook`, `/dashboards`. Mirrors `AdminLayout` —
 * one `SidebarProvider` per page, sidebar passed in as a slot so each route
 * can wire its own conversation handlers without lifting state.
 *
 * `/admin` and `/platform` keep their own `AdminLayout` (admin-role + MFA
 * gating live there, not here).
 */
export function AppLayout({
  sidebar,
  children,
}: {
  sidebar: ReactNode;
  children: ReactNode;
}) {
  return (
    <SidebarProvider className="!min-h-0 h-full">
      {sidebar}
      <SidebarInset id="main" tabIndex={-1}>
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
