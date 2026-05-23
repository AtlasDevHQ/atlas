"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ShieldCheck, ShieldX } from "lucide-react";
import Link from "next/link";
import { AdminSidebar } from "./admin-sidebar";
import { AdminTopBar } from "./admin-top-bar";
import { useAtlasConfig } from "@/ui/context";
import { LoadingState } from "./loading-state";
import { ChangePasswordDialog } from "./change-password-dialog";
import { MfaGateProvider, useMfaGate } from "./mfa-gate-context";
import { MfaEnrollmentDialog } from "./mfa-enrollment-dialog";
import { usePasswordStatus } from "@/ui/hooks/use-password-status";
import { GlobalCommandPalette } from "@/ui/components/palette";

/**
 * Routes that must render normally even when the admin is not yet enrolled
 * in MFA. The enrollment page is the only carve-out today — if we blocked
 * it, the admin would have nowhere to complete enrollment and would be
 * permanently locked out of the console.
 *
 * #2486 — keep this list minimal. Any new "safe pre-MFA" route is a
 * conscious decision: pre-enroll, admin/owner/platform_admin sessions
 * shouldn't see workspace-scoped data even if the page is read-only.
 *
 * Declared `as const` so the readonly tuple type makes accidental
 * `.push("/admin/...")` from neighboring code a compile error rather than
 * a runtime mutation that bypasses the policy comment.
 */
const MFA_GATE_EXEMPT_PREFIXES = ["/admin/account-security"] as const;

function isMfaGateExempt(pathname: string | null): boolean {
  if (!pathname) return false;
  return MFA_GATE_EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

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
  const pathname = usePathname();

  // Shared with AtlasChat — TanStack deduplicates to a single request.
  const { data, isPending, isError } = usePasswordStatus(!!session.data?.user);

  // Dispatch the MFA dialog when password-status surfaces the gate signal
  // (#2486 — primary path is the 200 body `mfaRequired:true`; the hook also
  // maps a defensive 403 fallback). The dialog itself opens on top of the
  // layout-level gate render below.
  useEffect(() => {
    if (data?.kind === "mfa-required") {
      trigger(data.enrollmentUrl);
    }
  }, [data, trigger]);

  // Derive admin check state from the discriminated result. The inner
  // switch on `data.kind` is exhaustive (`never` check below) so a future
  // arm added to `PasswordStatusResult` triggers a compile error instead
  // of silently bucketing into "allowed" — which would silently open the
  // gate (#2486 type-safety guard).
  let adminCheck: "pending" | "allowed" | "denied" | "mfa-required";
  if (!session.data?.user || isPending) {
    adminCheck = "pending";
  } else if (isError || !data) {
    adminCheck = "denied";
  } else {
    switch (data.kind) {
      case "denied":
        adminCheck = "denied";
        break;
      case "mfa-required":
        adminCheck = "mfa-required";
        break;
      case "allowed":
        adminCheck = "allowed";
        break;
      default: {
        const _exhaustive: never = data;
        // Conservative runtime fallback if a future arm slips past the
        // type check (e.g. dist drift on a published consumer of
        // `PasswordStatusResult`): treat unknown as denied so we never
        // render admin content for an unrecognized state.
        void _exhaustive;
        adminCheck = "denied";
      }
    }
  }

  // Loading state. Two cases:
  //   1. Session is still resolving on hard load — show LoadingState so
  //      we don't flash anything before we know who the user is.
  //   2. Session resolved but password-status is still pending — also show
  //      LoadingState so the gate-all promise (#2486) isn't briefly broken
  //      by children rendering before the MFA signal arrives. TanStack
  //      `isPending` is true only on the first fetch (no cached data); on
  //      client-side nav the cache is hydrated and we skip the flash.
  if (adminCheck === "pending") {
    return (
      <main id="main" tabIndex={-1} className="flex h-full items-center justify-center">
        <LoadingState message="Checking access..." />
      </main>
    );
  }

  // Signed in but not admin — inline forbidden UI using shadcn.
  // `mfa-required` is handled below as a full-tree gate (#2486), not here.
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
              onClick={() => {
                authClient.signOut()
                  .then(() => window.location.assign("/login"))
                  .catch((err: unknown) => {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error("Sign out failed:", msg);
                    toast.error("Sign out failed. Try again.");
                  });
              }}
            >
              Sign in as a different user
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  // #2486 — gate-all posture. When the admin is not yet enrolled in MFA,
  // every /admin/* route blocks rendering of its content and shows the
  // enrollment gate instead. The enrollment page is exempt so the user can
  // complete setup. We keep the sidebar + top bar mounted so the user has
  // navigation context (Sign out, jump to /admin/account-security, etc.)
  // and so the page chrome doesn't flash blank between the check and the
  // dialog opening.
  const enrollmentUrl =
    data?.kind === "mfa-required" ? data.enrollmentUrl : "/admin/account-security";
  const gateBlocking =
    adminCheck === "mfa-required" && !isMfaGateExempt(pathname);

  return (
    <SidebarProvider className="!min-h-0 h-full">
      <AdminSidebar />
      <SidebarInset id="main" tabIndex={-1}>
        <AdminTopBar />
        <ScrollArea className="flex-1">
          {gateBlocking ? (
            <MfaRequiredGate enrollmentUrl={enrollmentUrl} />
          ) : (
            children
          )}
        </ScrollArea>
      </SidebarInset>

      <ChangePasswordDialog
        open={data?.kind === "allowed" && data.passwordChangeRequired}
        onComplete={() => { /* Dialog handles its own state */ }}
      />
      <MfaEnrollmentDialog />
      {/*
        Cmd+K palette for admin surfaces. Chat surfaces mount their own
        copy (via workspace-shell) so the shortcut works app-wide; admin
        routes don't load workspace-shell, so we mount the palette here.
        Routes/settings come from the registry; no extra groups needed
        outside chat.
      */}
      <GlobalCommandPalette />
    </SidebarProvider>
  );
}

/**
 * In-tree gate shown when an unenrolled admin lands on a /admin/* route
 * that isn't the enrollment page itself. This card replaces page content
 * entirely so a dismissed dialog doesn't reveal admin data the user
 * shouldn't see pre-enrollment. The MFA enrollment dialog opens on top
 * (triggered by the useEffect in AdminLayoutInner) — its "Set up second
 * factor" CTA mirrors the link below, so the user has two paths to
 * enrollment even if the dialog fails to mount.
 */
function MfaRequiredGate({ enrollmentUrl }: { enrollmentUrl: string }) {
  return (
    <main
      className="flex h-full items-center justify-center bg-background p-4"
      data-testid="mfa-required-gate"
    >
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-lg bg-primary/10">
            <ShieldCheck className="size-6 text-primary" />
          </div>
          <CardTitle className="text-2xl">Two-factor required</CardTitle>
          <CardDescription>
            Enroll an authenticator app or passkey to access the admin console.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button asChild className="w-full">
            <Link href={enrollmentUrl}>Set up two-factor</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

export function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <MfaGateProvider>
      <AdminLayoutInner>{children}</AdminLayoutInner>
    </MfaGateProvider>
  );
}
