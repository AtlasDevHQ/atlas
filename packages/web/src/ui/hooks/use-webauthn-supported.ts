"use client";

/**
 * WebAuthn capability detection for the passkey enrollment flow on
 * /admin/settings/security (#2082 PR B).
 *
 * Two checks are surfaced separately because they fail independently:
 *
 *   - `supported`         — `window.PublicKeyCredential` exists. Required
 *                            for any passkey flow at all (platform OR
 *                            cross-platform / security key).
 *   - `platformSupported` — `isUserVerifyingPlatformAuthenticatorAvailable()`
 *                            resolved `true`. Required for Touch ID / Face ID
 *                            / Windows Hello. A `false` answer doesn't kill
 *                            the flow — roaming authenticators (YubiKey) still
 *                            work — but lets the UI soften the recommended
 *                            badge ("limited support — security key only").
 *
 * Both default to `null` while the platform-availability promise is in flight
 * so the page can render a determinate state from SSR (no hydration mismatch
 * on the tile copy) and only flip to a concrete answer once the answer is
 * actually known.
 */

import { useEffect, useState } from "react";

export interface WebAuthnSupport {
  /** `window.PublicKeyCredential` is defined. `null` until first effect runs. */
  supported: boolean | null;
  /** Platform authenticator (Touch ID / Windows Hello) is available. `null` while the promise is in flight. */
  platformSupported: boolean | null;
}

export function useWebAuthnSupported(): WebAuthnSupport {
  const [state, setState] = useState<WebAuthnSupport>({
    supported: null,
    platformSupported: null,
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.PublicKeyCredential === "undefined") {
      setState({ supported: false, platformSupported: false });
      return;
    }

    let cancelled = false;
    setState((prev) => ({ ...prev, supported: true }));

    const probe = window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable;
    if (typeof probe !== "function") {
      // Older WebAuthn implementations expose PublicKeyCredential without the
      // platform-availability probe. Treat platform support as unknown-false
      // so the UI falls back to the neutral copy.
      setState({ supported: true, platformSupported: false });
      return;
    }

    probe
      .call(window.PublicKeyCredential)
      .then((available) => {
        if (cancelled) return;
        setState({ supported: true, platformSupported: available });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        // The probe should never throw, but iframes / privacy modes can
        // reject it. Log and assume no platform authenticator so the user
        // still sees a working — if downgraded — tile.
        console.warn("isUserVerifyingPlatformAuthenticatorAvailable() rejected:", msg);
        setState({ supported: true, platformSupported: false });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
