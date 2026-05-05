"use client";

/**
 * WebAuthn capability detection for the passkey enrollment flow.
 *
 * The hook returns one of three states. Modelling them as a discriminated
 * union — rather than `boolean | null` for each axis — makes the two
 * unreachable cross-products (`{ supported: false, platformSupported: true }`
 * and `{ supported: null, platformSupported: false }`) impossible to express:
 *
 *   - `unknown`     — pre-effect / SSR. Render disabled-but-determinate
 *                     so there's no hydration mismatch on the tile copy.
 *   - `unsupported` — `window.PublicKeyCredential` is missing entirely.
 *                     No passkey flow at all.
 *   - `supported`   — WebAuthn is available. `platformAuthenticator` tells
 *                     consumers whether Touch ID / Face ID / Windows Hello
 *                     is wired up; `false` means roaming authenticators
 *                     (YubiKey) only — the flow still works, but the UI
 *                     should soften the recommended badge.
 */

import { useEffect, useState } from "react";

export type WebAuthnSupport =
  | { kind: "unknown" }
  | { kind: "unsupported" }
  | { kind: "supported"; platformAuthenticator: boolean };

export function useWebAuthnSupported(): WebAuthnSupport {
  const [state, setState] = useState<WebAuthnSupport>({ kind: "unknown" });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.PublicKeyCredential === "undefined") {
      setState({ kind: "unsupported" });
      return;
    }

    let cancelled = false;
    const probe = window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable;
    if (typeof probe !== "function") {
      // Older WebAuthn implementations expose PublicKeyCredential without the
      // platform-availability probe. Treat platform support as absent so the
      // UI falls back to the roaming-authenticator copy.
      setState({ kind: "supported", platformAuthenticator: false });
      return;
    }

    probe
      .call(window.PublicKeyCredential)
      .then((available) => {
        if (cancelled) return;
        setState({ kind: "supported", platformAuthenticator: available });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        // The probe should never throw, but iframes / privacy modes can
        // reject it. Log and assume no platform authenticator so the user
        // still sees a working — if downgraded — tile.
        console.warn("isUserVerifyingPlatformAuthenticatorAvailable() rejected:", msg);
        setState({ kind: "supported", platformAuthenticator: false });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
