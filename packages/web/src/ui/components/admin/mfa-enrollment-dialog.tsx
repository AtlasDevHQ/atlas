"use client";

/**
 * Modal that fires when an admin session hits an `mfa_enrollment_required`
 * 403 anywhere on `/admin/*` or `/admin/platform/*`. State lives in
 * {@link MfaGateContext}; the admin hooks dispatch the trigger and this
 * component renders the modal off the same context.
 *
 * Non-dismissable by design (matches `ChangePasswordDialog`): the user
 * either enrolls or signs out. Escape / outside-click are suppressed, no
 * close X.
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
    // Clear before navigating — destination's own fetches must not re-arm
    // the dialog (the provider's skip-on-security-page rule covers that).
    clear();
    router.push(state.enrollmentUrl);
  }

  function handleSignOut() {
    void authClient
      .signOut()
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        // Recovery is the same either way (navigate to /login), but log the
        // failure so an underlying issue (auth proxy 5xx, broken plugin
        // chain, network error) doesn't disappear into a silent redirect.
        console.warn("MFA dialog sign-out failed; navigating to /login anyway:", msg);
      })
      .finally(() => window.location.assign("/login"));
  }

  return (
    <AlertDialog open={open}>
      <AlertDialogContent
        className="sm:max-w-md"
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        {/*
         * shadcn's AlertDialogHeader switches to `sm:place-items-start
         * sm:text-left` at the `sm:` breakpoint when the content size is
         * `default`. The title's grid cell shrink-wraps and pins to the
         * left, so a bare `text-center` on the title doesn't visually
         * center it. `w-full` on Title + Description makes each fill its
         * grid cell so the inline `text-center` lands.
         */}
        <AlertDialogHeader>
          <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-lg bg-amber-500/10">
            <ShieldAlert className="size-6 text-amber-600 dark:text-amber-400" />
          </div>
          <AlertDialogTitle className="w-full text-center">
            Two-factor authentication required
          </AlertDialogTitle>
          <AlertDialogDescription className="w-full text-center">
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
