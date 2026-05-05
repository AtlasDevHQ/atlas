"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
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
import { MfaGateProvider, useMfaGate } from "./mfa-gate-context";
import { MfaEnrollmentDialog } from "./mfa-enrollment-dialog";
import { usePasswordStatus } from "@/ui/hooks/use-password-status";

/**
 * Inner layout — runs inside `MfaGateProvider` so it can dispatch the
 * gate when password-status returns `mfa-required`. Splitting the provider
 * out from the layout content keeps the trigger effect colocated with the
 * data fetch instead of fanning out to every page.
 */
function AdminLayoutInner({ children }: { children: ReactNode }) {
  const { authClient } = useAtlasConfig();
  const session = authClient.useSession();
  const { trigger } = useMfaGate();

  // Shared with AtlasChat — TanStack deduplicates to a single request.
  const { data, isPending, isError } = usePasswordStatus(!!session.data?.user);

  // The password-status endpoint is not behind `mfaRequired` today — the
  // dispatch is defensive so the gate fires correctly if that ever changes,
  // instead of falling through to the denied Card below.
  useEffect(() => {
    if (data?.kind === "mfa-required") {
      trigger(data.enrollmentUrl);
    }
  }, [data, trigger]);

  // Derive admin check state from the discriminated result.
  let adminCheck: "pending" | "allowed" | "denied" | "mfa-required";
  if (!session.data?.user || isPending) {
    adminCheck = "pending";
  } else if (isError || !data) {
    adminCheck = "denied";
  } else if (data.kind === "denied") {
    adminCheck = "denied";
  } else if (data.kind === "mfa-required") {
    adminCheck = "mfa-required";
  } else {
    adminCheck = "allowed";
  }

  // Loading session — only show loading on hard navigation (no cached session).
  // On client-side nav, session.data persists so we skip the flash.
  if (!session.data?.user && (session.isPending || adminCheck === "pending")) {
    return (
      <main id="main" tabIndex={-1} className="flex h-full items-center justify-center">
        <LoadingState message="Checking access..." />
      </main>
    );
  }

  // Signed in but not admin — inline forbidden UI using shadcn.
  // mfa-required falls through — the dialog below is the gating UI, not this Card.
  if (adminCheck === "denied") {
    return (
      <main id="main" tabIndex={-1} className="flex h-full items-center justify-center bg-background p-4">
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
    <SidebarProvider className="!min-h-0 h-full">
      <AdminSidebar />
      <SidebarInset id="main" tabIndex={-1}>
        <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
          <div className="flex items-center gap-2 px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 h-4" />
            <span className="text-sm font-medium text-muted-foreground">Admin Console</span>
          </div>
        </header>
        <ScrollArea className="flex-1">{children}</ScrollArea>
      </SidebarInset>

      <ChangePasswordDialog
        open={data?.kind === "allowed" && data.passwordChangeRequired}
        onComplete={() => { /* Dialog handles its own state */ }}
      />
      <MfaEnrollmentDialog />
    </SidebarProvider>
  );
}

export function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <MfaGateProvider>
      <AdminLayoutInner>{children}</AdminLayoutInner>
    </MfaGateProvider>
  );
}
