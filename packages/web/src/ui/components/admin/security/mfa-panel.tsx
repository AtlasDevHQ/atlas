"use client";

/**
 * Shared MFA tile composition for `/admin/account-security` and
 * `/settings/profile`. Owns the passkey list state, the tile-ref scroll
 * helper, and the BackupMethodBanner → PasskeyTile → TwoFactorSetup →
 * BackupCodesStatus → PasskeyList → TrustedDevicesList stack so future MFA
 * changes ship to both surfaces at once.
 *
 * Callers control outer chrome (page header, SecurityPosturePanel,
 * section wrapper). The only per-surface difference is `reauthRedirectTo`,
 * which the PasskeyTile uses to bounce back after a 2FA challenge during
 * re-auth — admins land back on `/admin/account-security`, profile users
 * on `/settings/profile` (a 403 if non-admins are sent to the admin path).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth/client";
import { getPasskeyClient, type Passkey } from "@/lib/auth/passkey-client";
import { BackupCodesStatus } from "@/ui/components/admin/security/backup-codes-status";
import { BackupMethodBanner } from "@/ui/components/admin/security/backup-method-banner";
import { PasskeyList, type PasskeyRow } from "@/ui/components/admin/security/passkey-list";
import { PasskeyTile } from "@/ui/components/admin/security/passkey-tile";
import { TrustedDevicesList } from "@/ui/components/admin/security/trusted-devices-list";
import { TwoFactorSetup } from "@/ui/components/admin/security/two-factor-setup";

interface SessionUser {
  twoFactorEnabled?: boolean;
}

export interface MfaPanelProps {
  /** Where the PasskeyTile's re-auth flow returns after a 2FA challenge. */
  reauthRedirectTo: string;
}

export function MfaPanel({ reauthRedirectTo }: MfaPanelProps) {
  const session = authClient.useSession();

  // Better Auth's session reactivity is the source of truth for
  // `twoFactorEnabled`. The cast goes from the plugin-erased session shape
  // to the narrow read here.
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
    // twoFactor.enable / disable; this hook gives downstream pages a
    // chance to refetch if they cache the flag.
    session.refetch?.();
  }

  function handlePasskeyChange() {
    void refreshPasskeys();
    // Session claims include `passkeyCount` — refetch so the MFA gate
    // sees the new count without a hard reload.
    session.refetch?.();
  }

  return (
    <div className="space-y-4">
      <BackupMethodBanner onAddPasskey={handleEnrollSecondPasskey} />

      <div ref={passkeyTileRef}>
        <PasskeyTile
          hasPasskey={hasPasskey}
          onChange={handlePasskeyChange}
          reauthRedirectTo={reauthRedirectTo}
        />
      </div>

      <TwoFactorSetup enabled={totpEnabled} onChange={handleTotpChange} />

      <BackupCodesStatus totpEnabled={totpEnabled} hasPasskey={hasPasskey} />

      <div className="pt-2">
        <PasskeyList passkeys={passkeys ?? []} onChange={handlePasskeyChange} />
        {listError && <p className="mt-2 text-sm text-destructive">{listError}</p>}
      </div>

      <div className="pt-2">
        <TrustedDevicesList />
      </div>
    </div>
  );
}
