"use client";

/**
 * Admin → Settings → Security
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
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { authClient } from "@/lib/auth/client";
import { getPasskeyClient, type Passkey } from "@/lib/auth/passkey-client";
import { TwoFactorSetup } from "@/ui/components/admin/security/two-factor-setup";
import { PasskeyTile } from "@/ui/components/admin/security/passkey-tile";
import { PasskeyList, type PasskeyRow } from "@/ui/components/admin/security/passkey-list";
import { BackupCodesStatus } from "@/ui/components/admin/security/backup-codes-status";
import { TrustedDevicesList } from "@/ui/components/admin/security/trusted-devices-list";
import { SecurityPosturePanel } from "@/ui/components/admin/security/security-posture-panel";
import { BackupMethodBanner } from "@/ui/components/admin/security/backup-method-banner";

interface SessionUser {
  email: string;
  role: string;
  twoFactorEnabled?: boolean;
}

export default function SecurityPage() {
  const session = authClient.useSession();

  // Better Auth's session reactivity is the source of truth for
  // `twoFactorEnabled`. The cast goes from the plugin-erased session shape
  // to the narrow read above.
  const user = (session.data?.user ?? null) as SessionUser | null;
  const totpEnabled = user?.twoFactorEnabled === true;

  const [passkeys, setPasskeys] = useState<PasskeyRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  // The banner nudges; the tile owns the WebAuthn ceremony. Scrolling
  // (vs. programmatic click) keeps enrollment scoped to a single source
  // of truth.
  const passkeyTileRef = useRef<HTMLDivElement | null>(null);
  function handleEnrollSecondPasskey() {
    passkeyTileRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const refreshPasskeys = useCallback(async () => {
    const client = getPasskeyClient();
    if (!client) {
      setListError("Passkey support couldn't be loaded. Refresh the page and try again.");
      return;
    }
    setListError(null);
    let result: Awaited<ReturnType<typeof client.listUserPasskeys>>;
    try {
      result = await client.listUserPasskeys();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[passkey] listUserPasskeys threw", msg);
      setListError("Could not load your passkeys. Please refresh.");
      return;
    }
    if (result.error) {
      console.warn("[passkey] listUserPasskeys failed", result.error);
      setListError(result.error.message ?? "Could not load your passkeys.");
      return;
    }
    setPasskeys((result.data ?? []) as Passkey[]);
  }, []);

  useEffect(() => {
    void refreshPasskeys();
  }, [refreshPasskeys]);

  const hasPasskey = (passkeys?.length ?? 0) > 0;

  function handleTotpChange() {
    // Better Auth refreshes session state automatically after
    // twoFactor.enable / disable; this hook gives downstream pages
    // a chance to refetch if they cache the flag.
    session.refetch?.();
  }

  function handlePasskeyChange() {
    void refreshPasskeys();
    // Session claims include `passkeyCount` — refetch so the MFA gate
    // sees the new count without a hard reload.
    session.refetch?.();
  }

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
        <BackupMethodBanner onAddPasskey={handleEnrollSecondPasskey} />

        <SecurityPosturePanel />

        <div ref={passkeyTileRef}>
          <PasskeyTile hasPasskey={hasPasskey} onChange={handlePasskeyChange} />
        </div>

        <TwoFactorSetup enabled={totpEnabled} onChange={handleTotpChange} />

        <BackupCodesStatus totpEnabled={totpEnabled} hasPasskey={hasPasskey} />

        <div className="pt-2">
          <PasskeyList passkeys={passkeys ?? []} onChange={handlePasskeyChange} />
          {listError && (
            <p className="mt-2 text-sm text-destructive">{listError}</p>
          )}
        </div>

        <div className="pt-2">
          <TrustedDevicesList />
        </div>
      </div>
    </div>
  );
}
