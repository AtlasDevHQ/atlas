"use client";

/**
 * Modal that fires when an admin/owner/platform_admin session hits an
 * `mfa_enrollment_required` 403 anywhere on `/admin/*` or
 * `/admin/platform/*`. State lives in {@link MfaGateContext} — the
 * `useAdminFetch` / `useAdminMutation` hooks dispatch the trigger; this
 * component renders the modal off the same context.
 *
 * Non-dismissable by design (matches `ChangePasswordDialog`): the user
 * either enrolls or signs out. Closing via Escape / outside-click is
 * suppressed, and there is no close X. Re-mounting on every page keep is
 * deliberate — the modal is the single intended exit from the gate state.
 */

import { ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAtlasConfig } from "@/ui/context";
import { useMfaGate } from "./mfa-gate-context";

export function MfaEnrollmentDialog() {
  const { state, clear } = useMfaGate();
  const { authClient } = useAtlasConfig();
  const router = useRouter();

  const open = state !== null;

  function handleEnroll() {
    if (!state) return;
    // Clear gate state before navigating so the destination page renders
    // without the dialog stacked on top — the security page is its own
    // surface and the skip-on-security-page rule in the provider keeps
    // the gate from re-arming there.
    clear();
    router.push(state.enrollmentUrl);
  }

  function handleSignOut() {
    void authClient
      .signOut()
      .then(() => window.location.assign("/login"))
      .catch(() => window.location.assign("/login"));
  }

  return (
    <AlertDialog open={open}>
      <AlertDialogContent
        className="sm:max-w-md"
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <AlertDialogHeader>
          <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-lg bg-amber-500/10">
            <ShieldAlert className="size-6 text-amber-600 dark:text-amber-400" />
          </div>
          <AlertDialogTitle className="text-center">
            Two-factor authentication required
          </AlertDialogTitle>
          <AlertDialogDescription className="text-center">
            Admin accounts must enroll a second factor before accessing the
            admin console. Set up an authenticator app to continue.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="sm:flex-col sm:gap-2 sm:space-x-0">
          <AlertDialogAction onClick={handleEnroll}>
            Enroll authenticator
          </AlertDialogAction>
          <AlertDialogCancel onClick={handleSignOut} className="mt-0">
            Sign out
          </AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
