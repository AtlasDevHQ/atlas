/**
 * Coverage for the sign-in 2FA challenge page.
 *
 * `unwrapTwoFactorResult` is not re-implemented here — the real helper is
 * imported via `requireActualModule` so a future change to its narrowing
 * doesn't silently keep these tests passing.
 */

import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, waitFor, cleanup, act, screen } from "@testing-library/react";

// Stub out `./client` so loading the real two-factor-client module doesn't
// pull Better Auth's createAuthClient through (network init at import time).
mock.module("@/lib/auth/client", () => ({ authClient: {} }));

// Now safe to import the real module — captured before the override below
// so the spread carries every named export (including `requireTwoFactorClient`,
// which prevents partial-mock SyntaxError if a sibling test ever imports it).
import * as realTwoFactorClient from "@/lib/auth/two-factor-client";

const verifyTotpMock = mock(
  async (_opts: { code: string; trustDevice?: boolean }) => ({
    data: { token: "session-token" },
    error: null,
  }),
);
const verifyBackupCodeMock = mock(
  async (_opts: { code: string; trustDevice?: boolean }) => ({
    data: { token: "session-token" },
    error: null,
  }),
);

const getTwoFactorClientMock = mock(() => ({
  enable: mock(async () => ({ data: null, error: null })),
  disable: mock(async () => ({ data: null, error: null })),
  verifyTotp: verifyTotpMock,
  verifyBackupCode: verifyBackupCodeMock,
  generateBackupCodes: mock(async () => ({ data: null, error: null })),
}));

mock.module("@/lib/auth/two-factor-client", () => ({
  ...realTwoFactorClient,
  getTwoFactorClient: () => getTwoFactorClientMock(),
}));

const routerPushMock = mock((_path: string) => {});
const searchParamsGetMock = mock<(_key: string) => string | null>(() => null);
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: routerPushMock, replace: () => {}, back: () => {} }),
  // Page reads `?callbackURL=...` to bounce the user back to the
  // surface that triggered the 2FA challenge (e.g. /admin/account-security
  // when re-authing for passkey enrollment). Tests assert the safe path
  // policy is enforced.
  useSearchParams: () => ({ get: searchParamsGetMock }),
}));

const signInPasskeyMock = mock(
  async (_opts?: { autoFill?: boolean }): Promise<{
    data: unknown;
    error: { code?: string; message?: string; status?: number } | null;
  }> => ({ data: { session: {}, user: {} }, error: null }),
);

const getPasskeySignInMock = mock<() => typeof signInPasskeyMock | null>(
  () => signInPasskeyMock,
);

mock.module("@/lib/auth/passkey-client", () => ({
  // PasskeyTile + PasskeyList consume getPasskeyClient — the 2FA page only
  // touches the sign-in shim. Keeping both exports stubbed prevents a
  // partial-mock SyntaxError if a sibling test imports the other.
  getPasskeyClient: () => null,
  getPasskeySignIn: () => getPasskeySignInMock(),
}));

const webAuthnSupportMock = mock<() => { kind: "supported" | "unsupported" | "unknown"; platformAuthenticator?: boolean }>(() => ({
  kind: "supported",
  platformAuthenticator: true,
}));

mock.module("@/ui/hooks/use-webauthn-supported", () => ({
  useWebAuthnSupported: () => webAuthnSupportMock(),
}));

import TwoFactorChallengePage from "./page";

beforeEach(() => {
  verifyTotpMock.mockReset();
  verifyBackupCodeMock.mockReset();
  routerPushMock.mockReset();
  searchParamsGetMock.mockReset();
  searchParamsGetMock.mockImplementation(() => null);
  getTwoFactorClientMock.mockReset();
  signInPasskeyMock.mockReset();
  getPasskeySignInMock.mockReset();
  webAuthnSupportMock.mockReset();

  verifyTotpMock.mockImplementation(async () => ({
    data: { token: "session-token" },
    error: null,
  }));
  verifyBackupCodeMock.mockImplementation(async () => ({
    data: { token: "session-token" },
    error: null,
  }));
  getTwoFactorClientMock.mockImplementation(() => ({
    enable: mock(async () => ({ data: null, error: null })),
    disable: mock(async () => ({ data: null, error: null })),
    verifyTotp: verifyTotpMock,
    verifyBackupCode: verifyBackupCodeMock,
    generateBackupCodes: mock(async () => ({ data: null, error: null })),
  }));
  signInPasskeyMock.mockImplementation(async () => ({
    data: { session: {}, user: {} },
    error: null,
  }));
  getPasskeySignInMock.mockImplementation(() => signInPasskeyMock);
  webAuthnSupportMock.mockImplementation(() => ({
    kind: "supported",
    platformAuthenticator: true,
  }));
});

afterEach(() => {
  cleanup();
});

function getCodeInput(): HTMLInputElement {
  return screen.getByLabelText(/authenticator code|backup code/i) as HTMLInputElement;
}

function getTrustCheckbox(): HTMLElement {
  return screen.getByRole("checkbox", { name: /trust this device/i });
}

function getSubmit(): HTMLButtonElement {
  return screen.getByRole("button", { name: /continue|verifying/i }) as HTMLButtonElement;
}

describe("TwoFactorChallengePage — defaults", () => {
  test("renders TOTP mode with empty code, trust-device unchecked, submit disabled", () => {
    render(<TwoFactorChallengePage />);
    expect(document.body.textContent).toContain("Enter your authenticator code");
    expect(getCodeInput().value).toBe("");
    expect(getTrustCheckbox().getAttribute("aria-checked")).toBe("false");
    expect(getSubmit().disabled).toBe(true);
  });

  test("submit button enables only after 6 digits", () => {
    render(<TwoFactorChallengePage />);
    const input = getCodeInput();
    fireEvent.change(input, { target: { value: "123" } });
    expect(getSubmit().disabled).toBe(true);
    fireEvent.change(input, { target: { value: "123456" } });
    expect(getSubmit().disabled).toBe(false);
  });

  test("non-digits are stripped from TOTP input", () => {
    render(<TwoFactorChallengePage />);
    const input = getCodeInput();
    fireEvent.change(input, { target: { value: "12-3a4b56" } });
    expect(input.value).toBe("123456");
  });
});

describe("TwoFactorChallengePage — verifyTotp wiring", () => {
  test("submitting with trust-device unchecked passes trustDevice: false", async () => {
    render(<TwoFactorChallengePage />);
    fireEvent.change(getCodeInput(), { target: { value: "123456" } });
    await act(async () => {
      fireEvent.click(getSubmit());
    });

    await waitFor(() => {
      expect(verifyTotpMock).toHaveBeenCalledTimes(1);
    });
    const call = (verifyTotpMock as unknown as ReturnType<typeof mock>).mock.calls[0] as [
      { code: string; trustDevice?: boolean },
    ];
    expect(call[0]).toEqual({ code: "123456", trustDevice: false });
    await waitFor(() => {
      expect(routerPushMock).toHaveBeenCalledWith("/");
    });
  });

  test("?callbackURL=/admin/account-security routes there after verify (passkey re-auth bounce)", async () => {
    // The callbackURL hand-off is what makes passkey re-auth feel
    // continuous: the user clicks "add passkey" → SESSION_NOT_FRESH →
    // re-auth dialog → twoFactorRedirect → 2FA challenge → bounces
    // BACK to /admin/account-security. Without this assertion, a
    // future refactor that drops the searchParams read would silently
    // drop every TOTP-enabled user at `/` instead.
    searchParamsGetMock.mockImplementation((key: string) =>
      key === "callbackURL" ? "/admin/account-security" : null,
    );
    render(<TwoFactorChallengePage />);
    fireEvent.change(getCodeInput(), { target: { value: "123456" } });

    await act(async () => {
      fireEvent.click(getSubmit());
    });

    await waitFor(() => {
      expect(routerPushMock).toHaveBeenCalledWith("/admin/account-security");
    });
  });

  test.each([
    ["protocol-relative open redirect", "//evil.example.com/phish"],
    ["absolute https URL", "https://evil.example.com/phish"],
    ["javascript: scheme", "javascript:alert(1)"],
    ["data: scheme", "data:text/html,<script>alert(1)</script>"],
    ["backslash smuggle", "/\\evil.example.com"],
    ["empty string", ""],
    ["non-leading-slash path", "admin/settings/security"],
  ])("rejects unsafe ?callbackURL=%s — falls back to '/'", async (_label, raw) => {
    // Defense-in-depth: an attacker who plants a link to
    // /login/two-factor?callbackURL=https://evil.example would phish
    // the post-2FA bounce. The same-origin path allowlist closes that
    // vector even if Better Auth's two-factor cookie itself is leaked.
    searchParamsGetMock.mockImplementation((key: string) => (key === "callbackURL" ? raw : null));
    render(<TwoFactorChallengePage />);
    fireEvent.change(getCodeInput(), { target: { value: "123456" } });

    await act(async () => {
      fireEvent.click(getSubmit());
    });

    await waitFor(() => {
      expect(routerPushMock).toHaveBeenCalledWith("/");
    });
  });

  test("submitting with trust-device toggled passes trustDevice: true", async () => {
    render(<TwoFactorChallengePage />);
    fireEvent.change(getCodeInput(), { target: { value: "654321" } });
    await act(async () => {
      fireEvent.click(getTrustCheckbox());
    });
    expect(getTrustCheckbox().getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      fireEvent.click(getSubmit());
    });

    await waitFor(() => {
      expect(verifyTotpMock).toHaveBeenCalledTimes(1);
    });
    const call = (verifyTotpMock as unknown as ReturnType<typeof mock>).mock.calls[0] as [
      { code: string; trustDevice?: boolean },
    ];
    expect(call[0]).toEqual({ code: "654321", trustDevice: true });
  });

  test("server error surfaces inline and does NOT navigate", async () => {
    verifyTotpMock.mockImplementationOnce(async () => ({
      data: null,
      error: { code: "INVALID_TOTP", message: "That code is wrong.", status: 401 },
    }));

    render(<TwoFactorChallengePage />);
    fireEvent.change(getCodeInput(), { target: { value: "000000" } });
    await act(async () => {
      fireEvent.click(getSubmit());
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("That code is wrong.");
    });
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  test("network failure (TypeError) surfaces friendly copy and does NOT navigate", async () => {
    verifyTotpMock.mockImplementationOnce(async () => {
      throw new TypeError("fetch failed");
    });

    render(<TwoFactorChallengePage />);
    fireEvent.change(getCodeInput(), { target: { value: "111111" } });
    await act(async () => {
      fireEvent.click(getSubmit());
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("Can't reach the server");
    });
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  test("double-click within the same tick fires verifyTotp only once (would burn backup codes otherwise)", async () => {
    // Hold the verify call open so the busy guard is observably true between
    // the two clicks. Without this, the synchronous setBusy(true) wouldn't
    // matter — clicks after the first await would already see the new state.
    let resolve: (v: { data: { token: string }; error: null }) => void = () => {};
    verifyTotpMock.mockImplementationOnce(
      () => new Promise((r) => {
        resolve = r;
      }),
    );

    render(<TwoFactorChallengePage />);
    fireEvent.change(getCodeInput(), { target: { value: "777777" } });
    const submit = getSubmit();

    await act(async () => {
      fireEvent.click(submit);
      fireEvent.click(submit);
      fireEvent.click(submit);
    });

    expect(verifyTotpMock).toHaveBeenCalledTimes(1);

    // Resolve the held promise so the test cleans up cleanly.
    await act(async () => {
      resolve({ data: { token: "x" }, error: null });
    });
  });
});

describe("TwoFactorChallengePage — backup-code mode", () => {
  test("toggling switch swaps mode, clears the code, preserves trust-device choice", async () => {
    render(<TwoFactorChallengePage />);
    fireEvent.change(getCodeInput(), { target: { value: "123" } });
    await act(async () => {
      fireEvent.click(getTrustCheckbox());
    });

    const switchBtn = screen.getByRole("button", { name: /use a backup code instead/i });
    await act(async () => {
      fireEvent.click(switchBtn);
    });

    expect(document.body.textContent).toContain("Enter a backup code");
    expect(getCodeInput().value).toBe("");
    expect(getTrustCheckbox().getAttribute("aria-checked")).toBe("true");
  });

  test("backup-code submit calls verifyBackupCode (not verifyTotp)", async () => {
    render(<TwoFactorChallengePage />);
    const switchBtn = screen.getByRole("button", { name: /use a backup code instead/i });
    await act(async () => {
      fireEvent.click(switchBtn);
    });

    const input = getCodeInput();
    fireEvent.change(input, { target: { value: "abcde-12345" } });
    await act(async () => {
      fireEvent.click(getSubmit());
    });

    await waitFor(() => {
      expect(verifyBackupCodeMock).toHaveBeenCalledTimes(1);
    });
    expect(verifyTotpMock).not.toHaveBeenCalled();
    const call = (verifyBackupCodeMock as unknown as ReturnType<typeof mock>).mock.calls[0] as [
      { code: string; trustDevice?: boolean },
    ];
    expect(call[0]).toEqual({ code: "abcde-12345", trustDevice: false });
  });

  test("backup-mode isComplete boundary — 9 alphanumerics reject, 10 accept (hyphen excluded)", async () => {
    render(<TwoFactorChallengePage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /use a backup code instead/i }));
    });
    const input = getCodeInput();

    fireEvent.change(input, { target: { value: "123456789" } });
    expect(getSubmit().disabled).toBe(true);

    fireEvent.change(input, { target: { value: "1234567890" } });
    expect(getSubmit().disabled).toBe(false);

    // Hyphen is stripped before counting. "abcde-1234" → 9 chars → reject.
    fireEvent.change(input, { target: { value: "abcde-1234" } });
    expect(getSubmit().disabled).toBe(true);

    // "abcde-12345" → 10 chars → accept (matches the placeholder shape).
    fireEvent.change(input, { target: { value: "abcde-12345" } });
    expect(getSubmit().disabled).toBe(false);
  });
});

describe("TwoFactorChallengePage — plugin guard", () => {
  test("missing twoFactor client surfaces actionable banner instead of silent failure", async () => {
    getTwoFactorClientMock.mockImplementationOnce(() => null as unknown as ReturnType<typeof getTwoFactorClientMock>);

    render(<TwoFactorChallengePage />);
    fireEvent.change(getCodeInput(), { target: { value: "123456" } });
    await act(async () => {
      fireEvent.click(getSubmit());
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("Two-factor sign-in is not available");
    });
    expect(verifyTotpMock).not.toHaveBeenCalled();
    expect(routerPushMock).not.toHaveBeenCalled();
  });
});

describe("TwoFactorChallengePage — passkey alternative", () => {
  function getPasskeyButton(): HTMLButtonElement {
    return screen.getByRole("button", { name: /use a passkey/i }) as HTMLButtonElement;
  }

  test("rendered when WebAuthn is supported", () => {
    render(<TwoFactorChallengePage />);
    expect(getPasskeyButton()).toBeDefined();
  });

  test("hidden when WebAuthn is unsupported (no banner — keeps the page clean)", () => {
    webAuthnSupportMock.mockImplementation(() => ({ kind: "unsupported" }));
    render(<TwoFactorChallengePage />);
    expect(screen.queryByRole("button", { name: /use a passkey/i })).toBeNull();
  });

  test("hidden during the pre-effect 'unknown' window to avoid hydration mismatch", () => {
    webAuthnSupportMock.mockImplementation(() => ({ kind: "unknown" }));
    render(<TwoFactorChallengePage />);
    expect(screen.queryByRole("button", { name: /use a passkey/i })).toBeNull();
  });

  test("success calls signIn.passkey() and navigates to '/'", async () => {
    render(<TwoFactorChallengePage />);
    await act(async () => {
      fireEvent.click(getPasskeyButton());
    });

    await waitFor(() => {
      expect(signInPasskeyMock).toHaveBeenCalledTimes(1);
    });
    // No autoFill — explicit click fires the modal authenticator prompt.
    const call = (signInPasskeyMock as unknown as ReturnType<typeof mock>).mock.calls[0] as [
      ({ autoFill?: boolean } | undefined)?,
    ];
    expect(call[0]).toBeUndefined();

    await waitFor(() => {
      expect(routerPushMock).toHaveBeenCalledWith("/");
    });
    // The TOTP path must NOT have fired — passkey is the alternative, not
    // a parallel verification.
    expect(verifyTotpMock).not.toHaveBeenCalled();
  });

  test("user cancellation is silent — no banner, no navigation, TOTP form still usable", async () => {
    signInPasskeyMock.mockImplementationOnce(async () => ({
      data: null,
      error: { code: "AUTH_CANCELLED", message: "cancelled", status: 400 },
    }));

    render(<TwoFactorChallengePage />);
    await act(async () => {
      fireEvent.click(getPasskeyButton());
    });

    await waitFor(() => {
      expect(signInPasskeyMock).toHaveBeenCalledTimes(1);
    });
    expect(routerPushMock).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("NotAllowedError");
    // The TOTP input should remain usable after a cancelled passkey attempt.
    expect(getCodeInput().disabled).toBe(false);
  });

  test("PASSKEY_NOT_FOUND surfaces the friendly 'no passkey for this device' hint", async () => {
    signInPasskeyMock.mockImplementationOnce(async () => ({
      data: null,
      error: { code: "PASSKEY_NOT_FOUND", message: "no passkey", status: 404 },
    }));

    render(<TwoFactorChallengePage />);
    await act(async () => {
      fireEvent.click(getPasskeyButton());
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "No passkey is registered for this device",
      );
    });
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  test("missing passkey plugin surfaces actionable banner instead of silent no-op", async () => {
    getPasskeySignInMock.mockImplementation(() => null);

    render(<TwoFactorChallengePage />);
    await act(async () => {
      fireEvent.click(getPasskeyButton());
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Passkey sign-in is not available right now",
      );
    });
    expect(signInPasskeyMock).not.toHaveBeenCalled();
  });

  test("trust-device toggle stays visible alongside the passkey button", () => {
    render(<TwoFactorChallengePage />);
    expect(getPasskeyButton()).toBeDefined();
    expect(screen.getByRole("checkbox", { name: /trust this device/i })).toBeDefined();
  });

  test("data:null + error:null surfaces the 'refresh the page' banner — does not navigate", async () => {
    signInPasskeyMock.mockImplementation(async () => ({
      data: null,
      error: null,
    }));
    render(<TwoFactorChallengePage />);
    await act(async () => {
      fireEvent.click(getPasskeyButton());
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Passkey signed in but the server didn't return a session",
      );
    });
    expect(routerPushMock).not.toHaveBeenCalled();
    // The TOTP path remains usable after the failed passkey attempt.
    expect(getCodeInput().disabled).toBe(false);
  });
});
