/**
 * Coverage for the `/claim` trial-claim interstitial (#4135).
 *
 * The real WebAuthn round-trip is covered by `e2e/browser/claim-passkey.spec.ts`
 * (Playwright virtual authenticator), which isn't a required CI check. This file
 * pins the page's BRANCHING LOGIC in required CI — the verified-session re-entry,
 * region routing, the passkey-enroll cancel-vs-error distinction, the ToS/finish
 * gating, and the non-WebAuthn fallback (including that a real password-reset
 * error keeps the user on the credential step rather than promising a phantom
 * email) — so a refactor can't silently break the MCP/CLI→full-trial funnel.
 *
 * `mock.module(...)` covers every named export the page's import graph uses (per
 * repo rule) so a sibling test file importing a different export doesn't trip a
 * partial-mock SyntaxError. `api-url` spreads its real exports and overrides only
 * the seams the test drives; `login-frontdoor` is left real (its `isLikelyEmail`
 * is pure).
 */

import { describe, expect, test, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { render, fireEvent, waitFor, cleanup, screen } from "@testing-library/react";

// ── Mocks ───────────────────────────────────────────────────────────────

// api-url: real exports, but isCrossOrigin / getActiveRegion / applyRegionSignal
// are seams the bootstrap drives.
import * as realApiUrl from "@/lib/api-url";
const isCrossOriginMock = mock((): boolean => false);
const getActiveRegionMock = mock((): string | null => null);
const applyRegionSignalMock = mock((_region: string, _apiUrl: string): boolean => true);
mock.module("@/lib/api-url", () => ({
  ...realApiUrl,
  isCrossOrigin: () => isCrossOriginMock(),
  getActiveRegion: () => getActiveRegionMock(),
  applyRegionSignal: (region: string, apiUrl: string) => applyRegionSignalMock(region, apiUrl),
}));

type SessionResult = { data: { user: unknown } | null };
const getSessionMock = mock(async (): Promise<SessionResult> => ({ data: { user: null } }));
const sendVerificationOtpMock = mock(
  async (_opts: { email: string; type: string }): Promise<{ error: { message?: string } | null }> => ({
    error: null,
  }),
);
const requestPasswordResetMock = mock(
  async (_opts: { email: string; redirectTo: string }): Promise<{ error: { message?: string } | null }> => ({
    error: null,
  }),
);
mock.module("@/lib/auth/client", () => ({
  authClient: {
    getSession: () => getSessionMock(),
    emailOtp: {
      sendVerificationOtp: (opts: { email: string; type: string }) => sendVerificationOtpMock(opts),
      verifyEmail: async () => ({ error: null }),
    },
    requestPasswordReset: (opts: { email: string; redirectTo: string }) => requestPasswordResetMock(opts),
  },
}));

const addPasskeyMock = mock(
  async (): Promise<{ data?: unknown; error: { code?: string; message?: string } | null }> => ({
    data: { id: "pk_1" },
    error: null,
  }),
);
const getPasskeyClientMock = mock((): { addPasskey: typeof addPasskeyMock } | null => ({
  addPasskey: addPasskeyMock,
}));
mock.module("@/lib/auth/passkey-client", () => ({
  getPasskeyClient: () => getPasskeyClientMock(),
  getPasskeySignIn: () => null,
}));

const webAuthnSupportMock = mock<
  () => { kind: "supported" | "unsupported" | "unknown"; platformAuthenticator?: boolean }
>(() => ({ kind: "supported", platformAuthenticator: true }));
mock.module("@/ui/hooks/use-webauthn-supported", () => ({
  useWebAuthnSupported: () => webAuthnSupportMock(),
}));

const navigatePostAuthMock = mock((_path: string) => {});
mock.module("@/lib/auth/post-auth-nav", () => ({ navigatePostAuth: navigatePostAuthMock }));

// VerifyEmailOTPForm is already unit-covered; stub it to a button that fires
// onVerified so the OTP→secure transition is driven deterministically without a
// real OTP round-trip.
mock.module("@/ui/components/auth/verify-email-otp-form", () => ({
  VerifyEmailOTPForm: ({ email, onVerified }: { email: string; onVerified: () => void }) => (
    <button type="button" data-email={email} onClick={onVerified}>
      stub-verify
    </button>
  ),
}));

const searchParamsStore: Record<string, string | null> = { email: null };
mock.module("next/navigation", () => ({
  useSearchParams: () => ({ get: (k: string) => searchParamsStore[k] ?? null }),
}));

const reloadMock = mock(() => {});
Object.defineProperty(window, "location", {
  value: { ...window.location, origin: "https://app.test", reload: reloadMock },
  configurable: true,
});

const fetchMock = mock(async (): Promise<Response> => new Response("{}"));
const originalFetch = globalThis.fetch;
globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

function respondWith(body: unknown, status = 200): void {
  fetchMock.mockImplementationOnce(
    async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

const { default: ClaimPage } = await import("./page");

beforeEach(() => {
  isCrossOriginMock.mockReset();
  isCrossOriginMock.mockImplementation(() => false);
  getActiveRegionMock.mockReset();
  getActiveRegionMock.mockImplementation(() => null);
  applyRegionSignalMock.mockReset();
  applyRegionSignalMock.mockImplementation(() => true);
  getSessionMock.mockReset();
  getSessionMock.mockImplementation(async () => ({ data: { user: null } }));
  sendVerificationOtpMock.mockReset();
  sendVerificationOtpMock.mockImplementation(async () => ({ error: null }));
  requestPasswordResetMock.mockReset();
  requestPasswordResetMock.mockImplementation(async () => ({ error: null }));
  addPasskeyMock.mockReset();
  addPasskeyMock.mockImplementation(async () => ({ data: { id: "pk_1" }, error: null }));
  getPasskeyClientMock.mockReset();
  getPasskeyClientMock.mockImplementation(() => ({ addPasskey: addPasskeyMock }));
  webAuthnSupportMock.mockReset();
  webAuthnSupportMock.mockImplementation(() => ({ kind: "supported", platformAuthenticator: true }));
  navigatePostAuthMock.mockReset();
  reloadMock.mockReset();
  fetchMock.mockClear();
  searchParamsStore.email = null;
});

afterEach(() => cleanup());
afterAll(() => {
  globalThis.fetch = originalFetch;
});

/** Drive the verified-session path so a test lands directly on the `secure` step. */
function verifiedSession(email = "owner@acme.com"): void {
  getSessionMock.mockImplementation(async () => ({ data: { user: { email, emailVerified: true } } }));
}

// ── Entry routing ─────────────────────────────────────────────────────────

describe("ClaimPage — entry routing", () => {
  test("a verified session resumes at the credential step (OTP skipped)", async () => {
    verifiedSession();
    render(<ClaimPage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create a passkey" })).toBeTruthy(),
    );
    expect(screen.queryByText(/Enter your code/i)).toBeNull();
    expect(sendVerificationOtpMock).not.toHaveBeenCalled();
  });

  test("a getSession hiccup falls through to the OTP path (non-fatal)", async () => {
    getSessionMock.mockImplementation(async () => {
      throw new Error("network");
    });
    searchParamsStore.email = "owner@acme.com";
    render(<ClaimPage />);
    await waitFor(() => expect(screen.getByText(/Enter your code/i)).toBeTruthy());
    expect(sendVerificationOtpMock).toHaveBeenCalledTimes(1);
  });

  test("an email in the URL (no session) dispatches an OTP and shows the code form", async () => {
    searchParamsStore.email = "owner@acme.com";
    render(<ClaimPage />);
    await waitFor(() => expect(screen.getByText(/Enter your code/i)).toBeTruthy());
    expect(sendVerificationOtpMock).toHaveBeenCalledWith({
      email: "owner@acme.com",
      type: "email-verification",
    });
  });

  test("no email and no session → asks for the email first (no premature OTP)", async () => {
    render(<ClaimPage />);
    await waitFor(() => expect(screen.getByText(/What's your email\?/i)).toBeTruthy());
    expect(sendVerificationOtpMock).not.toHaveBeenCalled();
  });

  test("submitting the email-entry form dispatches an OTP and advances; invalid input is a no-op", async () => {
    render(<ClaimPage />);
    const input = (await screen.findByLabelText(/Email/i)) as HTMLInputElement;

    // Invalid email → the submit guard keeps the user on the entry step.
    fireEvent.change(input, { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByRole("button", { name: /Send code/i }));
    expect(sendVerificationOtpMock).not.toHaveBeenCalled();
    expect(screen.getByText(/What's your email\?/i)).toBeTruthy();

    // Valid email → dispatch + advance to the OTP step.
    fireEvent.change(input, { target: { value: "owner@acme.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Send code/i }));
    await waitFor(() => expect(screen.getByText(/Enter your code/i)).toBeTruthy());
    expect(sendVerificationOtpMock).toHaveBeenCalledWith({
      email: "owner@acme.com",
      type: "email-verification",
    });
  });

  test("verifying the OTP advances to the credential step", async () => {
    searchParamsStore.email = "owner@acme.com";
    render(<ClaimPage />);
    const verifyStub = await screen.findByText("stub-verify");
    fireEvent.click(verifyStub);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create a passkey" })).toBeTruthy(),
    );
  });
});

// ── Region routing (cross-origin SaaS) ──────────────────────────────────────

describe("ClaimPage — region routing", () => {
  test("a single regional hit pins the region and reloads", async () => {
    isCrossOriginMock.mockImplementation(() => true);
    searchParamsStore.email = "owner@acme.com";
    respondWith({ outcome: "single", region: "eu", apiUrl: "https://api-eu.test" });
    render(<ClaimPage />);
    await waitFor(() => expect(applyRegionSignalMock).toHaveBeenCalledWith("eu", "https://api-eu.test"));
    expect(reloadMock).toHaveBeenCalledTimes(1);
    // No OTP yet — the reload re-runs the bootstrap on the regional base.
    expect(sendVerificationOtpMock).not.toHaveBeenCalled();
  });

  test("a non-multi-region 'skip' proceeds to OTP on the current base", async () => {
    isCrossOriginMock.mockImplementation(() => true);
    searchParamsStore.email = "owner@acme.com";
    respondWith({ outcome: "skip" });
    render(<ClaimPage />);
    await waitFor(() => expect(screen.getByText(/Enter your code/i)).toBeTruthy());
    expect(reloadMock).not.toHaveBeenCalled();
    expect(sendVerificationOtpMock).toHaveBeenCalledTimes(1);
  });

  test("an inconclusive front-door surfaces a retryable error (no OTP, no reload)", async () => {
    isCrossOriginMock.mockImplementation(() => true);
    searchParamsStore.email = "owner@acme.com";
    respondWith({ outcome: "error", message: "directory unreachable" });
    render(<ClaimPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Try again/i })).toBeTruthy());
    expect(sendVerificationOtpMock).not.toHaveBeenCalled();
    expect(reloadMock).not.toHaveBeenCalled();
  });
});

// ── Credential step: passkey enrollment ─────────────────────────────────────

describe("ClaimPage — passkey enrollment + ToS gating", () => {
  async function renderAtSecure(): Promise<void> {
    verifiedSession();
    render(<ClaimPage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create a passkey" })).toBeTruthy(),
    );
  }

  test("Finish is gated on BOTH a passkey and ToS", async () => {
    await renderAtSecure();
    const finish = screen.getByRole("button", { name: /Finish & go to your workspace/i });
    expect((finish as HTMLButtonElement).disabled).toBe(true);

    // Passkey only — still gated (ToS unchecked).
    fireEvent.click(screen.getByRole("button", { name: "Create a passkey" }));
    await waitFor(() => expect(screen.getByText(/Passkey added/i)).toBeTruthy());
    expect((finish as HTMLButtonElement).disabled).toBe(true);

    // + ToS → enabled → finishing hard-navs into the app.
    fireEvent.click(screen.getByRole("checkbox", { name: /Terms of Service/i }));
    await waitFor(() => expect((finish as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(finish);
    expect(navigatePostAuthMock).toHaveBeenCalledWith("/");
  });

  test("a cancelled WebAuthn ceremony shows no error banner and leaves Finish gated", async () => {
    addPasskeyMock.mockImplementation(async () => ({ error: { code: "NotAllowedError" } }));
    await renderAtSecure();
    fireEvent.click(screen.getByRole("button", { name: "Create a passkey" }));
    // Give the click handler a tick; nothing should advance.
    await waitFor(() => expect(addPasskeyMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Passkey added/i)).toBeNull();
    expect(screen.queryByText(/couldn't create that passkey/i)).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: /Terms of Service/i }));
    expect(
      (screen.getByRole("button", { name: /Finish & go to your workspace/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("a real enrollment error surfaces a banner", async () => {
    addPasskeyMock.mockImplementation(async () => ({ error: { code: "ConstraintError" } }));
    await renderAtSecure();
    fireEvent.click(screen.getByRole("button", { name: "Create a passkey" }));
    await waitFor(() => expect(screen.getByText(/couldn't create that passkey/i)).toBeTruthy());
  });

  test("an unavailable passkey client surfaces a distinct 'not available' message", async () => {
    getPasskeyClientMock.mockImplementation(() => null);
    await renderAtSecure();
    fireEvent.click(screen.getByRole("button", { name: "Create a passkey" }));
    await waitFor(() => expect(screen.getByText(/Passkeys aren't available right now/i)).toBeTruthy());
    expect(addPasskeyMock).not.toHaveBeenCalled();
  });
});

// ── Credential step: non-WebAuthn fallback ──────────────────────────────────

describe("ClaimPage — non-WebAuthn fallback", () => {
  async function renderUnsupportedSecure(): Promise<void> {
    webAuthnSupportMock.mockImplementation(() => ({ kind: "unsupported" }));
    verifiedSession();
    render(<ClaimPage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Set a password instead/i })).toBeTruthy(),
    );
  }

  test("WebAuthn-unsupported hides the passkey button and gates the fallback on ToS", async () => {
    await renderUnsupportedSecure();
    expect(screen.queryByRole("button", { name: "Create a passkey" })).toBeNull();
    const fallback = screen.getByRole("button", { name: /Set a password instead/i });
    expect((fallback as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /Terms of Service/i }));
    await waitFor(() => expect((fallback as HTMLButtonElement).disabled).toBe(false));
  });

  test("a successful reset request advances to the check-your-email screen", async () => {
    await renderUnsupportedSecure();
    fireEvent.click(screen.getByRole("checkbox", { name: /Terms of Service/i }));
    const fallback = screen.getByRole("button", { name: /Set a password instead/i });
    await waitFor(() => expect((fallback as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(fallback);
    await waitFor(() => expect(screen.getByText(/Check your email/i)).toBeTruthy());
    expect(requestPasswordResetMock).toHaveBeenCalledTimes(1);
  });

  test("a POPULATED reset error stays on the credential step and surfaces it (no phantom email)", async () => {
    requestPasswordResetMock.mockImplementation(async () => ({ error: { message: "rate limited" } }));
    await renderUnsupportedSecure();
    fireEvent.click(screen.getByRole("checkbox", { name: /Terms of Service/i }));
    const fallback = screen.getByRole("button", { name: /Set a password instead/i });
    await waitFor(() => expect((fallback as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(fallback);
    await waitFor(() => expect(screen.getByText(/couldn't send the password link/i)).toBeTruthy());
    // Did NOT advance to the misleading confirmation.
    expect(screen.queryByText(/Check your email/i)).toBeNull();
  });
});
