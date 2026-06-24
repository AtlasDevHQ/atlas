/**
 * Coverage for the client-side AuthGuard's stale-session recovery (#3933, F2).
 *
 * The proxy (`proxy.ts`) does an OPTIMISTIC, presence-only session-cookie
 * check: any cookie-bearing user is admitted to protected routes and bounced
 * AWAY from /login + /signup. When that cookie is expired/invalid/rotated the
 * user is trapped — every authed call 401s ("Failed to load conversations.
 * Please reload"), and /login bounces straight back to /. AuthGuard is the
 * backstop: once `useSession()` resolves with no user on a protected route in
 * managed mode, the cookie is provably stale, so it must CLEAR the cookie
 * (signOut — the cookie is httpOnly, only a server round-trip drops it) and
 * HARD-navigate to /login. A bare soft redirect (the old behavior) left the
 * stale cookie in place, so the proxy bounced it right back → the trap.
 */

// AuthGuard reads NEXT_PUBLIC_ATLAS_AUTH_MODE once at module load. The
// isolated per-file runner gives each file a clean env, so the `??=` hoist
// pins managed mode before the import below without mutating shared state.
process.env.NEXT_PUBLIC_ATLAS_AUTH_MODE ??= "managed";

import { describe, expect, test, mock, beforeEach } from "bun:test";

// ── Mocks ───────────────────────────────────────────────────────────────

let sessionState: {
  data: { user?: { email: string } } | null;
  isPending: boolean;
  error: unknown;
} = { data: null, isPending: false, error: null };

// `signOut`'s behavior is driven by a swappable impl so individual tests can
// model the happy path, a deferred promise (to pin signOut→nav ordering), a
// transport `{ error }` resolution, or a throw — without per-test re-mocking.
type SignOutResult = { data: { success: boolean } | null; error: { message?: string } | null };
const okSignOut = async (): Promise<SignOutResult> => ({ data: { success: true }, error: null });
let signOutImpl: () => Promise<SignOutResult> = okSignOut;
const signOutMock = mock(() => signOutImpl());

mock.module("@/lib/auth/client", () => ({
  authClient: {
    useSession: () => sessionState,
    signOut: signOutMock,
  },
}));

let pathname = "/";
const routerReplaceMock = mock((_path: string) => {});
mock.module("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ replace: routerReplaceMock, push: () => {}, back: () => {} }),
}));

mock.module("@/lib/api-url", () => ({
  getApiUrl: () => "http://localhost:3001",
  isCrossOrigin: () => false,
}));

// Render children directly — the real provider pulls unrelated deps and we
// only care about the guard's recovery effect here.
mock.module("@/ui/context", () => ({
  AtlasProvider: ({ children }: { children: React.ReactNode }) => children,
  useAtlasConfig: () => ({}),
  useActionAuth: () => null,
}));

import React from "react";
import { render, cleanup, waitFor } from "@testing-library/react";
import { AuthGuard } from "../components/auth-guard";

// Stub window.location.assign so the hard-nav recovery is observable without a
// real navigation. Restored in beforeEach via a fresh mock.
let assignMock = mock((_url: string) => {});
const originalLocation = window.location;
function stubLocation() {
  assignMock = mock((_url: string) => {});
  Object.defineProperty(window, "location", {
    value: { ...originalLocation, assign: assignMock },
    writable: true,
    configurable: true,
  });
}

beforeEach(() => {
  cleanup();
  signOutMock.mockClear();
  signOutImpl = okSignOut;
  routerReplaceMock.mockClear();
  pathname = "/";
  sessionState = { data: null, isPending: false, error: null };
  stubLocation();
});

function renderGuard() {
  return render(
    <AuthGuard>
      <div>workspace content</div>
    </AuthGuard>,
  );
}

describe("AuthGuard stale-session recovery", () => {
  test("clears the stale cookie and hard-navigates to /login when the session resolves with no user on a protected route", async () => {
    pathname = "/";
    sessionState = { data: null, isPending: false, error: null };

    renderGuard();

    await waitFor(() => {
      expect(signOutMock).toHaveBeenCalledTimes(1);
    });
    // Cookie cleared BEFORE the redirect, and a hard nav (not a soft
    // router.replace the proxy would bounce back to /).
    expect(assignMock).toHaveBeenCalledWith("/login");
  });

  test("awaits signOut before the hard nav — the cookie clear must land first", async () => {
    pathname = "/";
    sessionState = { data: null, isPending: false, error: null };
    // Hold signOut open so we can observe that the redirect waits for it.
    let resolveSignOut: ((v: SignOutResult) => void) | null = null;
    signOutImpl = () =>
      new Promise<SignOutResult>((resolve) => {
        resolveSignOut = resolve;
      });

    renderGuard();

    await waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));
    // signOut still pending → redirect must NOT have fired (else the proxy
    // bounces the still-cookied user /login → / and the trap returns).
    expect(assignMock).not.toHaveBeenCalled();

    resolveSignOut!({ data: { success: true }, error: null });
    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("/login"));
  });

  test("recovers exactly once even when the effect re-fires (one-shot guard)", async () => {
    pathname = "/";
    sessionState = { data: null, isPending: false, error: null };
    const { rerender } = renderGuard();

    await waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(assignMock).toHaveBeenCalledTimes(1));

    // Navigate to a sibling protected route while still trapped: changes the
    // pathname dep so the effect re-runs. The useRef one-shot must keep it from
    // firing a second signOut + redirect.
    pathname = "/notebook";
    rerender(
      <AuthGuard>
        <div>workspace content</div>
      </AuthGuard>,
    );
    await Promise.resolve();

    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(assignMock).toHaveBeenCalledTimes(1);
  });

  test("still escapes to /login when signOut returns an HTTP error (5xx)", async () => {
    pathname = "/";
    sessionState = { data: null, isPending: false, error: null };
    // An HTTP-error response (server answered 5xx) resolves with `{ error }`
    // rather than throwing. The cookie may be uncleared, but the user must not
    // be frozen on the broken /, so we still bounce.
    signOutImpl = async () => ({ data: null, error: { message: "internal error" } });

    renderGuard();

    await waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("/login"));
  });

  test("still escapes to /login when signOut throws (transport failure)", async () => {
    pathname = "/";
    sessionState = { data: null, isPending: false, error: null };
    // A true transport failure (API down / DNS / CORS) rejects the underlying
    // fetch, so signOut throws — the catch must still bounce.
    signOutImpl = async () => {
      throw new Error("network down");
    };

    renderGuard();

    await waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("/login"));
  });

  test("recovers after a transient get-session error clears (resume-after-blip)", async () => {
    // First resolution: a transient API error → suppressed (don't destroy a
    // possibly-valid session). `session.error` is in the effect dep array, so
    // when a later poll resolves cleanly to no-user the effect re-fires and the
    // genuinely-stale cookie is recovered. Guards the resume path of the trap.
    pathname = "/";
    sessionState = { data: null, isPending: false, error: new Error("blip") };
    const { rerender } = renderGuard();
    await Promise.resolve();
    expect(signOutMock).not.toHaveBeenCalled();

    sessionState = { data: null, isPending: false, error: null };
    rerender(
      <AuthGuard>
        <div>workspace content</div>
      </AuthGuard>,
    );

    await waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("/login"));
  });

  test("does not recover a valid session (happy path unchanged)", async () => {
    pathname = "/";
    sessionState = { data: { user: { email: "ada@example.com" } }, isPending: false, error: null };

    const { container } = renderGuard();
    await waitFor(() => {
      expect(container.textContent).toContain("workspace content");
    });

    expect(signOutMock).not.toHaveBeenCalled();
    expect(assignMock).not.toHaveBeenCalled();
  });

  test("does not recover on a public route even with no session", async () => {
    pathname = "/login";
    sessionState = { data: null, isPending: false, error: null };

    renderGuard();
    // Give the effect a tick to run (or not).
    await Promise.resolve();

    expect(signOutMock).not.toHaveBeenCalled();
    expect(assignMock).not.toHaveBeenCalled();
  });

  test("waits for the session round-trip — no recovery while pending", async () => {
    pathname = "/";
    sessionState = { data: null, isPending: true, error: null };

    renderGuard();
    await Promise.resolve();

    expect(signOutMock).not.toHaveBeenCalled();
    expect(assignMock).not.toHaveBeenCalled();
  });

  test("does not destroy the session on a transient get-session error", async () => {
    pathname = "/";
    sessionState = { data: null, isPending: false, error: new Error("network") };

    renderGuard();
    await Promise.resolve();

    expect(signOutMock).not.toHaveBeenCalled();
    expect(assignMock).not.toHaveBeenCalled();
  });
});
