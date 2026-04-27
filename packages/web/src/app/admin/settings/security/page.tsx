"use client";

/**
 * Admin → Settings → Security
 *
 * Single-purpose page for managing two-factor authentication on the
 * currently-signed-in account. Backs the `/privacy` §9 + `/dpa` Annex II
 * "MFA-required admin access" claim (#1925).
 *
 * The route is intentionally bypassed by the F-MFA gate (see
 * `packages/api/src/api/routes/admin-mfa-required.ts`) so admins who
 * haven't enrolled yet can still reach this page to complete enrollment.
 */

import { ShieldCheck } from "lucide-react";
import { authClient } from "@/lib/auth/client";
import { TwoFactorSetup } from "@/ui/components/admin/security/two-factor-setup";

interface SessionUser {
  twoFactorEnabled?: boolean;
  email?: string;
  role?: string;
}

export default function SecurityPage() {
  const session = authClient.useSession();

  // Better Auth's session reactivity is the source of truth for
  // `twoFactorEnabled`. Casting through `unknown` because the plugin-augmented
  // client type isn't reachable through createAuthClient's generic chain.
  const user = (session.data?.user ?? null) as SessionUser | null;
  const enabled = user?.twoFactorEnabled === true;

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

      <div className="mx-auto max-w-2xl space-y-6">
        <TwoFactorSetup
          enabled={enabled}
          onChange={() => {
            // Better Auth refreshes session state automatically after
            // twoFactor.enable / disable; this hook gives downstream pages
            // a chance to refetch if they cache the flag.
            session.refetch?.();
          }}
        />
      </div>
    </div>
  );
}
