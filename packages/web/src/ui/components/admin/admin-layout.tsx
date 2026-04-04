"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ShieldX } from "lucide-react";
import Link from "next/link";
import { AdminSidebar } from "./admin-sidebar";
import { useAtlasConfig } from "@/ui/context";
import { LoadingState } from "./loading-state";
import { ChangePasswordDialog } from "./change-password-dialog";

interface PasswordStatusResponse {
  passwordChangeRequired?: boolean;
}

export function AdminLayout({ children }: { children: ReactNode }) {
  const { authClient, apiUrl, isCrossOrigin } = useAtlasConfig();
  const session = authClient.useSession();
  const [passwordChangeRequired, setPasswordChangeRequired] = useState(false);

  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  // Verify admin access by calling the backend, which resolves the effective
  // role (user-level + org member role). This is the source of truth.
  // Shared query key with AtlasChat — TanStack deduplicates the request.
  const { data: adminStatus, isPending: adminPending } = useQuery<"allowed" | "denied">({
    queryKey: ["admin", "me", "password-status"],
    queryFn: async ({ signal }) => {
      const res = await fetch(`${apiUrl}/api/v1/admin/me/password-status`, {
        credentials,
        signal,
      });
      if (!res.ok) return "denied";
      const data: PasswordStatusResponse = await res.json();
      if (data.passwordChangeRequired) setPasswordChangeRequired(true);
      return "allowed";
    },
    enabled: !!session.data?.user,
    retry: false,
  });

  const adminCheck = !session.data?.user ? "pending"
    : adminPending ? "pending"
    : (adminStatus ?? "pending");

  // Loading session (proxy already handled unauthenticated)
  if (session.isPending || adminCheck === "pending") {
    return (
      <main id="main" tabIndex={-1} className="flex h-dvh items-center justify-center">
        <LoadingState message="Checking access..." />
      </main>
    );
  }

  // Signed in but not admin — inline forbidden UI using shadcn
  if (adminCheck === "denied") {
    return (
      <main id="main" tabIndex={-1} className="flex h-dvh items-center justify-center bg-background p-4">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-lg bg-destructive/10">
              <ShieldX className="size-6 text-destructive" />
            </div>
            <CardTitle className="text-2xl">Access denied</CardTitle>
            <CardDescription>
              The admin console requires the admin role.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button asChild variant="outline" className="w-full">
              <Link href="/">Back to chat</Link>
            </Button>
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => authClient.signOut().then(() => window.location.assign("/login"))}
            >
              Sign in as a different user
            </Button>
          </CardContent>
        </Card>
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
