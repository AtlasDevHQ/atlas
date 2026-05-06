/**
 * Coverage for the login page — passkey-first paths.
 *
 * The existing email/password + social-provider behavior is exercised end-
 * to-end by `e2e/browser/auth.spec.ts`; this file pins the unit-level
 * passkey wiring so a refactor of `useWebAuthnSupported` or
 * `getPasskeySignIn` can't silently turn the new sign-in path into a
 * no-op.
 *
 * `mock.module(...)` covers every named export of the modules it stubs
 * (per repo rule) so a sibling test file that imports a different export
 * doesn't trip a partial-mock SyntaxError.
 */

import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, waitFor, cleanup, act, screen } from "@testing-library/react";

// ── Mocks ───────────────────────────────────────────────────────────────

mock.module("@/lib/auth/client", () => ({ authClient: {} }));

const signInPasskeyMock = mock(
  async (_opts?: { autoFill?: boolean }): Promise<{
    data: unknown;
    error: { code?: string; message?: string; status?: number } | null;
  }> => ({ data: { session: {}, user: {} }, error: null }),
);

mock.module("@/lib/auth/passkey-client", () => ({
  // PasskeyTile + PasskeyList consume getPasskeyClient — the login page only
  // needs the sign-in shim. Both are mocked so a sibling test that imports
  // either module-export still resolves something callable.
  getPasskeyClient: () => null,
  getPasskeySignIn: () => signInPasskeyMock,
}));

const webAuthnSupportMock = mock<() => { kind: "supported" | "unsupported" | "unknown"; platformAuthenticator?: boolean }>(() => ({
  kind: "supported",
  platformAuthenticator: true,
}));

mock.module("@/ui/hooks/use-webauthn-supported", () => ({
  useWebAuthnSupported: () => webAuthnSupportMock(),
}));

const routerPushMock = mock((_path: string) => {});
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: routerPushMock, replace: () => {}, back: () => {} }),
}));

// `LoginPage` fetches the social-provider list + password-reset status
// from the API on mount. Stub `globalThis.fetch` so the network never
// fires from the test runner.
const fetchMock = mock(async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === "string" ? input : input.toString();
  if (url.includes("/api/v1/onboarding/social-providers")) {
    return new Response(JSON.stringify({ providers: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.includes("/api/v1/onboarding/password-reset-status")) {
    return new Response(JSON.stringify({ enabled: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response("not found", { status: 404 });
});
const originalFetch = globalThis.fetch;
globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

import LoginPage from "./page";

beforeEach(() => {
  signInPasskeyMock.mockReset();
  routerPushMock.mockReset();
  webAuthnSupportMock.mockReset();
  fetchMock.mockClear();
  signInPasskeyMock.mockImplementation(async () => ({
    data: { session: {}, user: {} },
    error: null,
  }));
  webAuthnSupportMock.mockImplementation(() => ({
    kind: "supported",
    platformAuthenticator: true,
  }));
});

afterEach(() => {
  cleanup();
});

// Run after the suite — restore the real fetch so unrelated test files
// in the same bun subprocess (under the project's isolated runner each
// file is its own process, but defensive cleanup is cheap) aren't left
// with our mock.
import { afterAll } from "bun:test";
afterAll(() => {
  globalThis.fetch = originalFetch;
});

// ── Tests ───────────────────────────────────────────────────────────────

describe("LoginPage — passkey button visibility", () => {
  test("hidden on unsupported browsers (no banner — keeps the page clean)", async () => {
    webAuthnSupportMock.mockImplementation(() => ({ kind: "unsupported" }));
    render(<LoginPage />);
    // Wait for the on-mount fetches to settle so the first paint isn't
    // racing the assertion.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /sign in with a passkey/i })).toBeNull();
    });
    expect(document.body.textContent).not.toContain("Passkey unavailable");
  });

  test("hidden during the pre-effect 'unknown' window to avoid hydration mismatch", async () => {
    webAuthnSupportMock.mockImplementation(() => ({ kind: "unknown" }));
    render(<LoginPage />);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /sign in with a passkey/i })).toBeNull();
    });
  });

  test("rendered when WebAuthn is supported", async () => {
    render(<LoginPage />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /sign in with a passkey/i })).toBeDefined();
    });
  });
});

describe("LoginPage — email input autocomplete", () => {
  test("opts into 'username webauthn' for conditional UI when supported", async () => {
    render(<LoginPage />);
    const email = (await screen.findByLabelText(/^email$/i)) as HTMLInputElement;
    expect(email.getAttribute("autocomplete")).toBe("username webauthn");
  });

  test("falls back to plain 'email' when WebAuthn is unsupported", async () => {
    webAuthnSupportMock.mockImplementation(() => ({ kind: "unsupported" }));
    render(<LoginPage />);
    const email = (await screen.findByLabelText(/^email$/i)) as HTMLInputElement;
    expect(email.getAttribute("autocomplete")).toBe("email");
  });
});

describe("LoginPage — passkey button click", () => {
  test("success calls signIn.passkey() and navigates to '/'", async () => {
    render(<LoginPage />);
    const btn = await screen.findByRole("button", { name: /sign in with a passkey/i });
    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() => {
      // First call is the auto-fill effect on mount; the click adds another.
      expect(signInPasskeyMock).toHaveBeenCalledTimes(2);
    });
    // The explicit click does NOT pass autoFill: true.
    const explicitCall = (signInPasskeyMock as unknown as ReturnType<typeof mock>).mock.calls[1] as [
      ({ autoFill?: boolean } | undefined)?,
    ];
    expect(explicitCall[0]).toBeUndefined();

    await waitFor(() => {
      expect(routerPushMock).toHaveBeenCalledWith("/");
    });
  });

  test("user cancellation (AUTH_CANCELLED) is silent — no banner, no navigation", async () => {
    signInPasskeyMock.mockImplementation(async () => ({
      data: null,
      error: { code: "AUTH_CANCELLED", message: "cancelled", status: 400 },
    }));
    render(<LoginPage />);
    const btn = await screen.findByRole("button", { name: /sign in with a passkey/i });
    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(signInPasskeyMock).toHaveBeenCalledTimes(2);
    });
    expect(routerPushMock).not.toHaveBeenCalled();
    // Crucial: no NotAllowedError leak. The renderer must NOT show the
    // raw cancellation message.
    expect(document.body.textContent).not.toContain("NotAllowedError");
    expect(document.body.textContent).not.toContain("cancelled");
  });

  test("server error surfaces friendly copy, never the raw NotAllowedError shape", async () => {
    signInPasskeyMock.mockImplementation(async () => ({
      data: null,
      error: {
        code: "AUTHENTICATION_FAILED",
        message: "raw NotAllowedError verbose blob",
        status: 400,
      },
    }));
    render(<LoginPage />);
    const btn = await screen.findByRole("button", { name: /sign in with a passkey/i });
    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() => {
      // Friendly copy from `parsePasskeySignInError` for AUTHENTICATION_FAILED.
      expect(document.body.textContent).toContain("couldn't verify that passkey");
    });
    expect(document.body.textContent).not.toContain("raw NotAllowedError verbose blob");
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  test("network failure (TypeError) surfaces 'can't reach the server' copy", async () => {
    signInPasskeyMock.mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });
    render(<LoginPage />);
    const btn = await screen.findByRole("button", { name: /sign in with a passkey/i });
    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("Can't reach the server");
    });
    expect(routerPushMock).not.toHaveBeenCalled();
  });
});

describe("LoginPage — conditional UI autofill on mount", () => {
  test("supported browser fires signIn.passkey({ autoFill: true }) once on mount", async () => {
    render(<LoginPage />);
    await waitFor(() => {
      expect(signInPasskeyMock).toHaveBeenCalledTimes(1);
    });
    const call = (signInPasskeyMock as unknown as ReturnType<typeof mock>).mock.calls[0] as [
      { autoFill?: boolean } | undefined,
    ];
    expect(call[0]).toEqual({ autoFill: true });
  });

  test("autofill success navigates the user — no need for a button click", async () => {
    render(<LoginPage />);
    await waitFor(() => {
      expect(routerPushMock).toHaveBeenCalledWith("/");
    });
  });

  test("does NOT fire on unsupported browsers", async () => {
    webAuthnSupportMock.mockImplementation(() => ({ kind: "unsupported" }));
    render(<LoginPage />);
    // Give the effect a chance to run if it were going to.
    await new Promise((r) => setTimeout(r, 20));
    expect(signInPasskeyMock).not.toHaveBeenCalled();
  });
});
