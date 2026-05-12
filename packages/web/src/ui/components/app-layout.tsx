"use client";

import type { ReactNode } from "react";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";

// Separate from AdminLayout because admin-role + MFA gating lives there.
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
