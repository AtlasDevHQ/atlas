import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import React, { useEffect } from "react";
import { MfaGateProvider, useMfaGate } from "../components/admin/mfa-gate-context";
import { MfaEnrollmentDialog } from "../components/admin/mfa-enrollment-dialog";
import { AtlasProvider, type AtlasAuthClient } from "../context";

const routerPush = mock((_path: string) => {});
const routerReplace = mock(() => {});
const mockSignOut = mock(() => Promise.resolve());

mock.module("next/navigation", () => ({
  usePathname: () => "/admin/users",
  useRouter: () => ({ push: routerPush, replace: routerReplace, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

function makeAuthClient(overrides: Partial<AtlasAuthClient> = {}): AtlasAuthClient {
  return {
    signIn: { email: async () => ({}) },
    signUp: { email: async () => ({}) },
    signOut: mockSignOut,
    useSession: () => ({ data: null }),
    ...overrides,
  };
}

/**
 * Helper component — triggers the gate immediately on mount so the dialog
 * has state to render. Lets us exercise the dialog without spinning up the
 * full hook + fetch path.
 */
function GateTrigger({ enrollmentUrl }: { enrollmentUrl: string }) {
  const { trigger } = useMfaGate();
  useEffect(() => {
    trigger(enrollmentUrl);
  }, [trigger, enrollmentUrl]);
  return null;
}

function renderDialog(enrollmentUrl = "/admin/settings/security") {
  return render(
    <AtlasProvider
      config={{
        apiUrl: "http://localhost:3001",
        isCrossOrigin: false,
        authClient: makeAuthClient(),
      }}
    >
      <MfaGateProvider>
        <GateTrigger enrollmentUrl={enrollmentUrl} />
        <MfaEnrollmentDialog />
      </MfaGateProvider>
    </AtlasProvider>,
  );
}

const originalAssign = window.location.assign;

beforeEach(() => {
  routerPush.mockClear();
  routerReplace.mockClear();
  mockSignOut.mockClear();
  Object.defineProperty(window, "location", {
    value: { ...window.location, assign: mock(() => {}) },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "location", {
    value: { ...window.location, assign: originalAssign },
    writable: true,
    configurable: true,
  });
});

describe("MfaEnrollmentDialog", () => {
  test("opens with the gate state", async () => {
    renderDialog();
    await waitFor(() => {
      expect(document.body.textContent).toContain("Two-factor authentication required");
    });
  });

  test('"Enroll authenticator" routes to enrollmentUrl and clears gate state', async () => {
    const { container } = renderDialog("/admin/settings/security");

    await waitFor(() => {
      expect(document.body.textContent).toContain("Enroll authenticator");
    });

    const enrollBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Enroll authenticator"),
    );
    expect(enrollBtn).toBeTruthy();

    await act(async () => {
      fireEvent.click(enrollBtn!);
    });

    expect(routerPush).toHaveBeenCalledWith("/admin/settings/security");

    // After click, dialog should close (gate.state cleared).
    await waitFor(() => {
      expect(container.textContent).not.toContain("Two-factor authentication required");
    });
  });

  test('"Sign out" calls authClient.signOut and navigates to /login', async () => {
    renderDialog();

    await waitFor(() => {
      expect(document.body.textContent).toContain("Sign out");
    });

    const signOutBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.trim() === "Sign out",
    );
    expect(signOutBtn).toBeTruthy();

    await act(async () => {
      fireEvent.click(signOutBtn!);
    });

    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(window.location.assign).toHaveBeenCalledWith("/login");
    });
  });

  test("Sign-out failure still navigates to /login (recovery)", async () => {
    const failingSignOut = mock(() => Promise.reject(new Error("network down")));
    const originalWarn = console.warn;
    console.warn = mock(() => {}) as typeof console.warn;

    try {
      render(
        <AtlasProvider
          config={{
            apiUrl: "http://localhost:3001",
            isCrossOrigin: false,
            authClient: makeAuthClient({ signOut: failingSignOut }),
          }}
        >
          <MfaGateProvider>
            <GateTrigger enrollmentUrl="/admin/settings/security" />
            <MfaEnrollmentDialog />
          </MfaGateProvider>
        </AtlasProvider>,
      );

      await waitFor(() => {
        expect(document.body.textContent).toContain("Sign out");
      });
      const signOutBtn = Array.from(document.querySelectorAll("button")).find((b) =>
        b.textContent?.trim() === "Sign out",
      );

      await act(async () => {
        fireEvent.click(signOutBtn!);
      });

      await waitFor(() => {
        expect(window.location.assign).toHaveBeenCalledWith("/login");
      });
      expect(console.warn).toHaveBeenCalled();
    } finally {
      console.warn = originalWarn;
    }
  });
});
