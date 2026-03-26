"use client";

import { useState, useEffect } from "react";
import type { ReactNode } from "react";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { AdminSidebar } from "./admin-sidebar";
import { useRouter } from "next/navigation";
import { useAtlasConfig } from "@/ui/context";
import { LoadingState } from "./loading-state";
import { ChangePasswordDialog } from "./change-password-dialog";

export function AdminLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { authClient, apiUrl, isCrossOrigin } = useAtlasConfig();
  const session = authClient.useSession();
  const [adminCheck, setAdminCheck] = useState<"pending" | "allowed" | "denied">("pending");
  const [passwordChangeRequired, setPasswordChangeRequired] = useState(false);

  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  // Verify admin access by calling the backend, which resolves the effective
  // role (user-level + org member role). This is the source of truth — the
  // Better Auth session only carries the user-level role ("member"), not the
  // org-level role ("owner"), so client-side checks are unreliable.
  useEffect(() => {
    if (!session.data?.user) return;

    async function checkAdminAccess() {
      try {
        const res = await fetch(`${apiUrl}/api/v1/admin/me/password-status`, { credentials });
        if (res.ok) {
          setAdminCheck("allowed");
          const data = await res.json();
          if (data.passwordChangeRequired) setPasswordChangeRequired(true);
        } else if (res.status === 403) {
          setAdminCheck("denied");
        } else {
          // Other errors (401 session expired, 500, etc.) — treat as denied
          setAdminCheck("denied");
        }
      } catch {
        setAdminCheck("denied");
      }
    }
    checkAdminAccess();
  }, [session.data?.user, apiUrl, credentials]);

  // Loading session
  if (session.isPending) {
    return (
      <main id="main" tabIndex={-1} className="flex h-dvh items-center justify-center">
        <LoadingState message="Checking authentication..." />
      </main>
    );
  }

  // Not signed in — redirect to login
  if (!session.data?.user) {
    router.replace("/login");
    return (
      <main id="main" tabIndex={-1} className="flex h-dvh items-center justify-center">
        <LoadingState message="Redirecting to sign in..." />
      </main>
    );
  }

  // Waiting for admin access check
  if (adminCheck === "pending") {
    return (
      <main id="main" tabIndex={-1} className="flex h-dvh items-center justify-center">
        <LoadingState message="Checking admin access..." />
      </main>
    );
  }

  // Signed in but not admin
  if (adminCheck === "denied") {
    const userRole = (session.data.user as Record<string, unknown>).role;
    return (
      <main id="main" tabIndex={-1} className="flex h-dvh items-center justify-center">
        <div className="w-full max-w-sm space-y-3 rounded-lg border border-zinc-200 bg-zinc-50 p-6 text-center dark:border-zinc-700 dark:bg-zinc-900">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            Access Denied
          </h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            The admin console requires the <strong>admin</strong> role. You are signed in
            as <strong>{session.data.user.email}</strong> with role <strong>{String(userRole ?? "member")}</strong>.
          </p>
          <button
            onClick={() => authClient.signOut()}
            className="mt-2 rounded-lg bg-zinc-200 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-300 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-600"
          >
            Sign out
          </button>
        </div>
      </main>
    );
  }

  return (
    <SidebarProvider>
      <AdminSidebar />
      <SidebarInset id="main" tabIndex={-1}>
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
