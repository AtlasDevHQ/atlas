"use client";

/**
 * Shared state for the MFA enrollment gate. Hook layer dispatches via
 * `trigger()`; `MfaEnrollmentDialog` reads the same state and renders the
 * modal.
 *
 * State lives in `useMfaGateStore` (zustand). This file composes the store
 * with two hook-only concerns that can't live in a store action:
 *
 * 1. **Skip on the enrollment page.** When pathname starts with
 *    `/admin/settings/security`, `trigger` is a no-op. Otherwise a
 *    pre-enroll fetch on that page could re-arm the dialog and trap the
 *    user on the page they need to complete enrollment on.
 * 2. **Capture origin path for redirect-back.** Stash the URL that fired
 *    the gate in `sessionStorage` so the security page can bounce the
 *    user back after enrollment completes. `consumeOriginPath()` reads +
 *    clears the slot atomically.
 *
 * `MfaGateProvider` is a thin scope marker — it tracks whether an admin
 * surface is mounted (so `useMfaGate` can throw on misuse) and clears
 * state when the admin tree unmounts (so a stale trigger from elsewhere
 * doesn't auto-open the dialog the next time admin mounts).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { useMfaGateStore } from "@/lib/stores/mfa-gate-store";

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

const ScopeContext = createContext<boolean>(false);

/** Read + clear the origin path. Null when no origin was captured (direct nav). */
export function consumeOriginPath(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.sessionStorage.getItem(ORIGIN_PATH_KEY);
    if (value) {
      window.sessionStorage.removeItem(ORIGIN_PATH_KEY);
    }
    return value;
  } catch {
    // intentionally ignored: sessionStorage throws in private browsing on
    // some browsers; the redirect-back is a UX nicety, fail open.
    return null;
  }
}

export function MfaGateProvider({ children }: { children: ReactNode }) {
  const clear = useMfaGateStore((s) => s.clear);

  // Tie the dialog's lifecycle to the admin layout the way React Context did
  // before this state moved to a global store: when the admin tree unmounts,
  // forget any open gate. The optional-gate variant returns NOOP outside the
  // provider, so non-admin surfaces can't leave stale state behind.
  useEffect(() => () => clear(), [clear]);

  return <ScopeContext.Provider value={true}>{children}</ScopeContext.Provider>;
}

function useTrigger(): (enrollmentUrl: string) => void {
  const pathname = usePathname();
  const state = useMfaGateStore((s) => s.state);
  const setState = useMfaGateStore((s) => s.setState);

  return useCallback(
    (enrollmentUrl: string) => {
      // Skip when already on the enrollment page so the page's own fetches
      // can't re-arm the dialog and trap the user on the destination.
      if (pathname?.startsWith(ENROLLMENT_PATH_PREFIX)) return;

      // Idempotent: the first failed fetch wins. Concurrent fan-out
      // (parallel admin queries on a fresh page load) shouldn't stomp the
      // origin path that the first failure captured.
      if (state) return;

      if (typeof window !== "undefined") {
        try {
          const origin = pathname ?? window.location.pathname;
          window.sessionStorage.setItem(ORIGIN_PATH_KEY, origin);
        } catch {
          // intentionally ignored: sessionStorage write can throw in
          // private mode; the dialog still opens, the user just doesn't
          // get the redirect-back nicety.
        }
      }

      setState({ enrollmentUrl });
    },
    [pathname, state, setState],
  );
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
  const inScope = useContext(ScopeContext);
  const state = useMfaGateStore((s) => s.state);
  const clear = useMfaGateStore((s) => s.clear);
  const trigger = useTrigger();

  if (!inScope) {
    throw new Error(
      "useMfaGate must be used inside <MfaGateProvider>. Mount it in the admin layout.",
    );
  }
  return { state, trigger, clear };
}

/**
 * Optional variant for hook call sites that may run on either an admin or
 * non-admin surface. Returns a no-op gate when the provider is missing so
 * `useAdminFetch` / `useAdminMutation` can be used outside the admin tree
 * (e.g. embedded in the chat) without throwing on every fetch.
 */
export function useMfaGateOptional(): MfaGateContextValue {
  const inScope = useContext(ScopeContext);
  const state = useMfaGateStore((s) => s.state);
  const clear = useMfaGateStore((s) => s.clear);
  const trigger = useTrigger();

  if (!inScope) return NOOP_GATE;
  return { state, trigger, clear };
}

const NOOP_GATE: MfaGateContextValue = {
  state: null,
  trigger: (enrollmentUrl: string) => {
    // The optional variant exists so non-admin surfaces (chat, embedded
    // widget) can use the admin hooks without a provider. But an admin
    // page that forgot to mount the provider would also land here and
    // silently never open the dialog — surface that wiring bug in dev
    // builds without changing runtime behavior. Production stays silent
    // so the no-op stays cheap on the embedded path.
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[mfa-gate] trigger called outside MfaGateProvider — dialog won't open. ` +
          `enrollmentUrl=${enrollmentUrl}. Mount <MfaGateProvider> in this tree if the dialog UX is desired.`,
      );
    }
  },
  clear: () => {},
};
