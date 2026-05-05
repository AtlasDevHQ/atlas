"use client";

/**
 * Admin → Settings → Security
 *
 * Lets the signed-in admin manage every available second factor:
 *
 *   - Passkey (WebAuthn)            — `authClient.passkey.*` (#2082)
 *   - Authenticator app (TOTP)      — `authClient.twoFactor.*` (#1925)
 *   - Backup codes                  — issued inside the TOTP flow only;
 *                                     this page surfaces status, not enrollment.
 *
 * The page is rendered by Next.js, not Atlas's API admin router, so the
 * `mfaRequired` API gate doesn't run on the page itself — admins who
 * haven't enrolled any factor can always reach it to complete enrollment.
 * The Better Auth endpoints the page calls (`/api/auth/two-factor/*`,
 * `/api/auth/passkey/*`) are likewise mounted outside the admin router
 * (see `packages/api/src/api/index.ts` and the file header in
 * `packages/api/src/api/routes/admin-mfa-required.ts`).
 */

import { useCallback, useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { authClient } from "@/lib/auth/client";
import { TwoFactorSetup } from "@/ui/components/admin/security/two-factor-setup";
import { PasskeyTile } from "@/ui/components/admin/security/passkey-tile";
import { PasskeyList, type PasskeyRow } from "@/ui/components/admin/security/passkey-list";
import { BackupCodesStatus } from "@/ui/components/admin/security/backup-codes-status";

interface SessionUser {
  email: string;
  role: string;
  twoFactorEnabled?: boolean;
}

type ClientResult<T> = {
  data: T | null;
  error: { message?: string; code?: string; status?: number } | null;
};

/**
 * Narrow view onto the parts of `authClient.passkey` that this page
 * exercises. Better Auth's plugin-augmented client type doesn't surface
 * `listUserPasskeys` through `createAuthClient`'s generic chain, but the
 * server plugin exposes the endpoint and the client wires it up at
 * runtime (see `@better-auth/passkey/dist/index.mjs`'s endpoint table).
 */
interface PasskeyClient {
  listUserPasskeys: () => Promise<ClientResult<PasskeyRow[]>>;
}

function getPasskeyClient(): PasskeyClient | null {
  const namespace = (authClient as unknown as { passkey?: PasskeyClient }).passkey;
  return namespace ?? null;
}

export default function SecurityPage() {
  const session = authClient.useSession();

  // Better Auth's session reactivity is the source of truth for
  // `twoFactorEnabled`. The cast goes from the plugin-erased session shape
  // to the narrow read above; an `unknown` step would be wider than the
  // value already is, so we cast directly.
  const user = (session.data?.user ?? null) as SessionUser | null;
  const totpEnabled = user?.twoFactorEnabled === true;

  const [passkeys, setPasskeys] = useState<PasskeyRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const refreshPasskeys = useCallback(async () => {
    const client = getPasskeyClient();
    if (!client) {
      setListError("Passkey support is not loaded — refresh the page.");
      return;
    }
    setListError(null);
    let result: ClientResult<PasskeyRow[]>;
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
    setPasskeys(result.data ?? []);
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
    // Session claims include `passkeyCount` (#2082 PR A) — refetch so
    // the MFA gate sees the new count without a hard reload.
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
        <PasskeyTile hasPasskey={hasPasskey} onChange={handlePasskeyChange} />

        <TwoFactorSetup enabled={totpEnabled} onChange={handleTotpChange} />

        <BackupCodesStatus totpEnabled={totpEnabled} hasPasskey={hasPasskey} />

        <div className="pt-2">
          <PasskeyList passkeys={passkeys ?? []} onChange={handlePasskeyChange} />
          {listError && (
            <p className="mt-2 text-sm text-destructive">{listError}</p>
          )}
        </div>
      </div>
    </div>
  );
}
