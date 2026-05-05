/**
 * Coverage for the sign-in 2FA challenge page.
 *
 * The page is the only UI surface for the half-authenticated state
 * (#2082 PR C.1). Test cases verify:
 *   1. Default state — TOTP mode, trust-device unchecked, code empty
 *   2. trustDevice=false flows through verifyTotp when checkbox left alone
 *   3. trustDevice=true flows through verifyTotp when checkbox toggled
 *   4. Server failure surfaces inline error (no router.push)
 *   5. Toggle to backup mode + submit calls verifyBackupCode (not verifyTotp)
 *   6. Plugin missing client-side surfaces a recoverable banner
 */

import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, waitFor, cleanup, act, screen } from "@testing-library/react";

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

// `getTwoFactorClient()` is what the page imports. Test default returns the
// stubbed namespace; individual tests override per-call via `mockImplementationOnce`.
const getTwoFactorClientMock = mock(() => ({
  enable: mock(async () => ({ data: null, error: null })),
  disable: mock(async () => ({ data: null, error: null })),
  verifyTotp: verifyTotpMock,
  verifyBackupCode: verifyBackupCodeMock,
  generateBackupCodes: mock(async () => ({ data: null, error: null })),
}));

mock.module("@/lib/auth/two-factor-client", () => ({
  // Re-export the real `unwrapTwoFactorResult` — pure data helper, no need
  // to mock its branching.
  unwrapTwoFactorResult: <T,>(
    result: { data: T | null; error: { message?: string } | null },
    fallback: string,
  ) => {
    if (result.error) {
      return { ok: false as const, message: result.error.message ?? fallback, raw: result.error };
    }
    if (!result.data) {
      return { ok: false as const, message: fallback, raw: null };
    }
    return { ok: true as const, data: result.data };
  },
  getTwoFactorClient: () => getTwoFactorClientMock(),
}));

const routerPushMock = mock((_path: string) => {});
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: routerPushMock, replace: () => {}, back: () => {} }),
}));

import TwoFactorChallengePage from "./page";

beforeEach(() => {
  verifyTotpMock.mockReset();
  verifyBackupCodeMock.mockReset();
  routerPushMock.mockReset();
  getTwoFactorClientMock.mockReset();

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
});

afterEach(() => {
  cleanup();
});

/** Type the input element rather than `as` everywhere — bun:test/RTL types lose this through `getByLabelText`. */
function getCodeInput(): HTMLInputElement {
  return screen.getByLabelText(/authenticator code|backup code/i) as HTMLInputElement;
}

function getTrustCheckbox(): HTMLElement {
  // Radix Checkbox renders a button[role=checkbox] with aria-checked, NOT a real <input>.
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
    // Radix exposes state via aria-checked; "false" is unchecked.
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
});

describe("TwoFactorChallengePage — backup-code mode", () => {
  test("toggling switch swaps mode, clears the code, preserves trust-device choice", async () => {
    render(<TwoFactorChallengePage />);
    // Set trust-device + a partial TOTP code, then switch.
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
    // trustDevice MUST persist — otherwise switching modes silently undoes the
    // security choice the user already made.
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
