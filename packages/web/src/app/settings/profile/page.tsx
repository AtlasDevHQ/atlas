"use client";

/**
 * Settings → Profile (#2255).
 *
 * User-scoped settings page surfaced from the avatar dropdown on both the chat
 * and admin surfaces. Every section is per-user (no admin role required) — the
 * MFA tiles reuse the same components as `/admin/security` because the
 * underlying endpoints (`/api/v1/admin/me/*`, `/api/v1/sessions`) are
 * authenticated-only, not admin-gated.
 *
 * Sections, top to bottom:
 *
 *   1. Identity     — display name + email
 *   2. Password     — change password (managed-auth only)
 *   3. Security     — passkeys, TOTP, backup codes, trusted devices
 *   4. Sessions     — active sessions + sign-out-everywhere
 *
 * The MFA wrapper here intentionally leans on the same components admins see
 * on `/admin/security` so a feature added there shows up for end-users too,
 * without a parallel maintenance surface.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth/client";
import { getPasskeyClient, type Passkey } from "@/lib/auth/passkey-client";
import { TwoFactorSetup } from "@/ui/components/admin/security/two-factor-setup";
import { PasskeyTile } from "@/ui/components/admin/security/passkey-tile";
import { PasskeyList, type PasskeyRow } from "@/ui/components/admin/security/passkey-list";
import { BackupCodesStatus } from "@/ui/components/admin/security/backup-codes-status";
import { TrustedDevicesList } from "@/ui/components/admin/security/trusted-devices-list";
import { BackupMethodBanner } from "@/ui/components/admin/security/backup-method-banner";
import { SectionHeading } from "@/ui/components/admin/compact";
import { IdentitySection } from "@/ui/components/settings/identity-section";
import { PasswordSection } from "@/ui/components/settings/password-section";
import { SessionsSection } from "@/ui/components/settings/sessions-section";

interface SessionUser {
  email: string;
  role: string;
  twoFactorEnabled?: boolean;
}

export default function ProfilePage() {
  const session = authClient.useSession();
  const user = (session.data?.user ?? null) as SessionUser | null;
  const totpEnabled = user?.twoFactorEnabled === true;

  const [passkeys, setPasskeys] = useState<PasskeyRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
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
    session.refetch?.();
  }

  function handlePasskeyChange() {
    void refreshPasskeys();
    session.refetch?.();
  }

  if (!user) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <p className="text-sm text-muted-foreground">Sign in to manage your profile.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-10 flex flex-col gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Atlas · Settings
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Profile</h1>
        <p className="max-w-xl text-sm text-muted-foreground">
          Identity, password, multi-factor authentication, and active sessions for{" "}
          <span className="font-medium text-foreground">{user.email}</span>.
        </p>
      </header>

      <div className="space-y-10">
        <IdentitySection />

        <PasswordSection />

        <section>
          <SectionHeading
            title="Multi-factor authentication"
            description="Add a second factor — passkey, authenticator app, or both — so a stolen password isn't enough."
          />
          <div className="space-y-4">
            <BackupMethodBanner onAddPasskey={handleEnrollSecondPasskey} />

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
        </section>

        <SessionsSection />
      </div>
    </div>
  );
}
