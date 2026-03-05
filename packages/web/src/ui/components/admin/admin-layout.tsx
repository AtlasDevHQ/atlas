"use client";

import { useState, useEffect } from "react";
import type { ReactNode } from "react";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { AdminSidebar } from "./admin-sidebar";
import { useAtlasConfig } from "@/ui/context";
import { ManagedAuthCard } from "@/ui/components/chat/managed-auth-card";
import { LoadingState } from "./loading-state";
import { ChangePasswordDialog } from "./change-password-dialog";

export function AdminLayout({ children }: { children: ReactNode }) {
  const { authClient, apiUrl, isCrossOrigin } = useAtlasConfig();
  const session = authClient.useSession();
  const [passwordChangeRequired, setPasswordChangeRequired] = useState(false);

  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  // Check if password change is required after session loads
  useEffect(() => {
    if (!session.data?.user) return;

    async function checkPasswordStatus() {
      try {
        const res = await fetch(`${apiUrl}/api/v1/admin/me/password-status`, { credentials });
        if (!res.ok) return;
        const data = await res.json();
        if (data.passwordChangeRequired) setPasswordChangeRequired(true);
      } catch {
        // Non-critical — skip silently
      }
    }
    checkPasswordStatus();
  }, [session.data?.user, apiUrl, credentials]);

  // Loading session
  if (session.isPending) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <LoadingState message="Checking authentication..." />
      </div>
    );
  }

  // Not signed in
  if (!session.data?.user) {
    return <ManagedAuthCard />;
  }

  // Signed in but not admin
  const role = (session.data.user as Record<string, unknown>).role;
  if (role !== "admin") {
    return (
      <div className="flex h-dvh items-center justify-center">
        <div className="w-full max-w-sm space-y-3 rounded-lg border border-zinc-200 bg-zinc-50 p-6 text-center dark:border-zinc-700 dark:bg-zinc-900">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            Access Denied
          </h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            The admin console requires the <strong>admin</strong> role. You are signed in
            as <strong>{session.data.user.email}</strong> with role <strong>{String(role ?? "viewer")}</strong>.
          </p>
          <button
            onClick={() => authClient.signOut()}
            className="mt-2 rounded-lg bg-zinc-200 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-600"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  return (
    <SidebarProvider>
      <AdminSidebar />
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
          <div className="flex items-center gap-2 px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 h-4" />
            <span className="text-sm font-medium text-muted-foreground">Admin Console</span>
          </div>
        </header>
        <div className="flex-1 overflow-auto">{children}</div>
      </SidebarInset>

      <ChangePasswordDialog
        open={passwordChangeRequired}
        onComplete={() => setPasswordChangeRequired(false)}
      />
    </SidebarProvider>
  );
}
