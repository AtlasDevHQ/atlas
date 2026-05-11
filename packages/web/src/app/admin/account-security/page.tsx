"use client";

/**
 * Admin → Security
 *
 * Top-level admin page for the signed-in user's own MFA + session posture.
 * #2175 — promoted out of `/admin/settings/security` so security stops
 * feeling like an optional config-tab item. Pre-launch, no redirect
 * from the old path is needed (zero existing bookmarks to preserve).
 *
 * Lets the signed-in admin manage every available second factor:
 *
 *   - Passkey (WebAuthn)            — `authClient.passkey.*`
 *   - Authenticator app (TOTP)      — `authClient.twoFactor.*`
 *   - Backup codes                  — issued inside the TOTP flow only;
 *                                     this page surfaces status, not enrollment.
 *
 * The page is rendered by Next.js, not Atlas's API admin router, so the
 * `mfaRequired` API gate doesn't run on the page itself — admins who
 * haven't enrolled any factor can always reach it to complete enrollment.
 *
 * The tile composition lives in `<MfaPanel />`, shared with
 * `/settings/profile` so MFA-flow changes ship to both surfaces at once.
 */

import { ShieldCheck } from "lucide-react";
import { authClient } from "@/lib/auth/client";
import { MfaPanel } from "@/ui/components/admin/security/mfa-panel";
import { SecurityPosturePanel } from "@/ui/components/admin/security/security-posture-panel";

interface SessionUser {
  email: string;
}

export default function SecurityPage() {
  const session = authClient.useSession();
  const user = (session.data?.user ?? null) as SessionUser | null;

  return (
    <div className="p-6">
      <div className="mx-auto mb-8 flex max-w-2xl items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Security</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Two-factor authentication for {user?.email ?? "your account"}.
          </p>
        </div>
        <span
          className="grid size-10 shrink-0 place-items-center rounded-xl border bg-card/40 text-muted-foreground"
          aria-hidden
        >
          <ShieldCheck className="size-5" />
        </span>
      </div>

      <div className="mx-auto max-w-2xl space-y-4">
        <SecurityPosturePanel />
        <MfaPanel reauthRedirectTo="/admin/account-security" />
      </div>
    </div>
  );
}
