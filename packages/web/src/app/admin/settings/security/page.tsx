"use client";

/**
 * Admin → Settings → Security
 *
 * Single-purpose page for managing two-factor authentication on the
 * currently-signed-in account.
 *
 * This page is rendered by Next.js, not by Atlas's API admin router, so
 * the `mfaRequired` API gate doesn't run on the page itself — admins who
 * haven't enrolled can always reach the page to complete enrollment.
 * The Better Auth TOTP endpoints (`/api/auth/two-factor/*`) the page
 * calls are likewise mounted outside the admin router (see
 * `packages/api/src/api/index.ts:153` and the file header in
 * `packages/api/src/api/routes/admin-mfa-required.ts`).
 */

import { ShieldCheck } from "lucide-react";
import { authClient } from "@/lib/auth/client";
import { TwoFactorSetup } from "@/ui/components/admin/security/two-factor-setup";

/**
 * Narrow read of `session.data.user`. Better Auth's session always
 * populates `email` and `role` when the session exists, but the
 * plugin-augmented client type isn't reachable through
 * `createAuthClient`'s generic chain — `twoFactorEnabled` arrives via
 * the `twoFactor` plugin and is missing on accounts that never enrolled,
 * so it stays optional.
 */
interface SessionUser {
  email: string;
  role: string;
  twoFactorEnabled?: boolean;
}

export default function SecurityPage() {
  const session = authClient.useSession();

  // Better Auth's session reactivity is the source of truth for
  // `twoFactorEnabled`. The cast goes from the plugin-erased session shape
  // to the narrow read above; an `unknown` step would be wider than the
  // value already is, so we cast directly.
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
