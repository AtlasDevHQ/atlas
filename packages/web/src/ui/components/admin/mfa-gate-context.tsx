"use client";

/**
 * MFA enrollment gate state — shared across `useAdminFetch` /
 * `useAdminMutation` (which detect `mfa_enrollment_required` 403s) and the
 * dialog mounted in `AdminLayout` (which renders the modal). Keeps the
 * dispatch path React-idiomatic and testable: hooks call
 * `useMfaGate().trigger(...)`, the dialog reads from the same context, no
 * `window` events flying around. See #2081.
 *
 * The provider also handles two policies that don't belong in either the
 * hook layer or the dialog:
 *
 * 1. **Skip on the enrollment page.** When pathname starts with
 *    `/admin/settings/security`, `trigger` is a no-op. Otherwise the
 *    page's own pre-enroll fetches (which may transitively go through
 *    `useAdminFetch` someday) would re-arm the dialog and trap the user
 *    on the page they are already on.
 * 2. **Capture origin path for redirect-back.** Stash the URL that fired
 *    the gate into `sessionStorage` so the security page can bounce the
 *    user back after enrollment completes. `consumeOriginPath()` reads +
 *    clears the slot atomically.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";

const ENROLLMENT_PATH_PREFIX = "/admin/settings/security";

/** sessionStorage key for the redirect-back URL captured at gate time. */
const ORIGIN_PATH_KEY = "atlas:mfa-origin-path";

interface MfaGateState {
  /** Where the API told us to send the user. Always `/admin/settings/security` today. */
  enrollmentUrl: string;
}

export interface MfaGateContextValue {
  /** Non-null while the dialog should be open. */
  state: MfaGateState | null;
  /**
   * Open the dialog. No-op when:
   * - The user is already on the enrollment page (pathname prefix match).
   * - The dialog is already open (idempotent — concurrent failed fetches
   *   shouldn't re-stash origin paths or flicker the dialog).
   */
  trigger: (enrollmentUrl: string) => void;
  /** Close the dialog. Used by the dialog itself + reset hooks in tests. */
  clear: () => void;
}

const MfaGateContext = createContext<MfaGateContextValue | null>(null);

/**
 * Read + clear the origin path captured when the gate fired. Called by the
 * security page after enrollment so the user lands back where they were.
 * Returns `null` when no origin was stashed (e.g. the user navigated to
 * `/admin/settings/security` directly).
 */
export function consumeOriginPath(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.sessionStorage.getItem(ORIGIN_PATH_KEY);
    if (value) {
      window.sessionStorage.removeItem(ORIGIN_PATH_KEY);
    }
    return value;
  } catch {
    // sessionStorage can throw in private browsing on some browsers.
    // The redirect-back is a UX nicety — fail open.
    return null;
  }
}

export function MfaGateProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [state, setState] = useState<MfaGateState | null>(null);

  const trigger = useCallback(
    (enrollmentUrl: string) => {
      // Skip when already on the enrollment page so the page's own fetches
      // can't re-arm the dialog and trap the user on the destination.
      if (pathname?.startsWith(ENROLLMENT_PATH_PREFIX)) return;

      // Idempotent: the first failed fetch wins. Concurrent fan-out
      // (parallel admin queries on a fresh page load) shouldn't stomp the
      // origin path that the first failure captured.
      setState((prev) => {
        if (prev) return prev;
        if (typeof window !== "undefined") {
          try {
            const origin = pathname ?? window.location.pathname;
            window.sessionStorage.setItem(ORIGIN_PATH_KEY, origin);
          } catch {
            // sessionStorage write can throw in private mode — the dialog
            // still opens, the user just doesn't get the redirect-back nicety.
          }
        }
        return { enrollmentUrl };
      });
    },
    [pathname],
  );

  const clear = useCallback(() => {
    setState(null);
  }, []);

  const value = useMemo<MfaGateContextValue>(
    () => ({ state, trigger, clear }),
    [state, trigger, clear],
  );

  return <MfaGateContext.Provider value={value}>{children}</MfaGateContext.Provider>;
}

/**
 * Read the MFA gate. Throws if used outside `MfaGateProvider` — every admin
 * surface mounts the provider, so a missing one is a wiring bug worth
 * surfacing loudly rather than silently no-op-ing the dialog.
 *
 * Public-page consumers that don't have the provider mounted (e.g. shared
 * conversation views) should use {@link useMfaGateOptional} instead.
 */
export function useMfaGate(): MfaGateContextValue {
  const ctx = useContext(MfaGateContext);
  if (!ctx) {
    throw new Error(
      "useMfaGate must be used inside <MfaGateProvider>. Mount it in the admin layout.",
    );
  }
  return ctx;
}

/**
 * Optional variant for hook call sites that may run on either an admin or
 * non-admin surface. Returns a no-op gate when the provider is missing so
 * `useAdminFetch` / `useAdminMutation` can be used outside the admin tree
 * (e.g. embedded in the chat) without throwing on every fetch.
 */
export function useMfaGateOptional(): MfaGateContextValue {
  const ctx = useContext(MfaGateContext);
  return ctx ?? NOOP_GATE;
}

const NOOP_GATE: MfaGateContextValue = {
  state: null,
  trigger: () => {},
  clear: () => {},
};
