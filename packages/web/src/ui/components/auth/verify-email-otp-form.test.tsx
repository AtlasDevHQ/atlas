/**
 * #4018 — the OTP-verify step must hydrate the Better Auth session from the
 * cookie `verifyEmail` establishes (`autoSignInAfterVerification`) BEFORE it
 * hands off, mirroring the login front-door's post-signIn `getSession`. Without
 * it the post-signup app carries no settled session into the cross-origin region
 * API, so every bootstrap call 401s and a reload bounces the just-verified user
 * to /login. These pin the ordering (verify → getSession → onVerified), that a
 * FAILED verify neither hydrates nor advances, and that a hydration hiccup never
 * traps the user (it still advances).
 *
 * `mock.module(...)` stubs every named export of the modules it touches (repo
 * rule). The OTP input is mocked to a single controlled <input> so a full-length
 * change deterministically fires the form's auto-submit without the real
 * `input-otp` library's DOM-measurement quirks under happy-dom.
 */

import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, waitFor, cleanup, act, screen } from "@testing-library/react";

// ── Mocks ───────────────────────────────────────────────────────────────

mock.module("@/components/ui/input-otp", () => ({
  InputOTP: ({
    value,
    onChange,
    maxLength,
  }: {
    value: string;
    onChange: (v: string) => void;
    maxLength: number;
    children?: unknown;
  }) => (
    <input
      aria-label="Verification code"
      value={value}
      maxLength={maxLength}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
  InputOTPGroup: ({ children }: { children?: unknown }) => <div>{children as never}</div>,
  InputOTPSlot: () => <span />,
  InputOTPSeparator: () => <span />,
}));

const callOrder: string[] = [];
const verifyEmailMock = mock(async (_opts: { email: string; otp: string }) => {
  callOrder.push("verify");
  return { data: {}, error: null } as { data: unknown; error: { code?: string } | null };
});
const sendVerificationOtpMock = mock(async () => ({ data: {}, error: null }));
const getSessionMock = mock(async () => {
  callOrder.push("getSession");
  return { data: { user: { id: "u1" } } };
});

mock.module("@/lib/auth/client", () => ({
  authClient: {
    emailOtp: { verifyEmail: verifyEmailMock, sendVerificationOtp: sendVerificationOtpMock },
    getSession: getSessionMock,
  },
}));

import { VerifyEmailOTPForm } from "./verify-email-otp-form";

const CODE = "12345678";

beforeEach(() => {
  callOrder.length = 0;
  verifyEmailMock.mockReset();
  getSessionMock.mockReset();
  verifyEmailMock.mockImplementation(async () => {
    callOrder.push("verify");
    return { data: {}, error: null };
  });
  getSessionMock.mockImplementation(async () => {
    callOrder.push("getSession");
    return { data: { user: { id: "u1" } } };
  });
});

afterEach(() => {
  cleanup();
});

// ── Tests ───────────────────────────────────────────────────────────────

describe("VerifyEmailOTPForm — session hydration (#4018)", () => {
  test("hydrates the session after a successful verify, before onVerified", async () => {
    const onVerified = mock(() => {
      callOrder.push("onVerified");
    });
    render(<VerifyEmailOTPForm email="a@b.co" onVerified={onVerified} />);

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Verification code"), {
        target: { value: CODE },
      });
    });

    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
    expect(verifyEmailMock).toHaveBeenCalledWith({ email: "a@b.co", otp: CODE });
    expect(getSessionMock).toHaveBeenCalledTimes(1);
    // Ordering is the invariant: the cookie is hydrated into the store before
    // the caller navigates into the guarded app.
    expect(callOrder).toEqual(["verify", "getSession", "onVerified"]);
  });

  test("a FAILED verify neither hydrates nor advances", async () => {
    verifyEmailMock.mockImplementation(async () => {
      callOrder.push("verify");
      return { data: null, error: { code: "INVALID_OTP" } };
    });
    const onVerified = mock(() => {
      callOrder.push("onVerified");
    });
    render(<VerifyEmailOTPForm email="a@b.co" onVerified={onVerified} />);

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Verification code"), {
        target: { value: CODE },
      });
    });

    await waitFor(() => expect(verifyEmailMock).toHaveBeenCalled());
    expect(getSessionMock).not.toHaveBeenCalled();
    expect(onVerified).not.toHaveBeenCalled();
  });

  test("a verify that THROWS (network) neither hydrates nor advances", async () => {
    verifyEmailMock.mockImplementation(async () => {
      callOrder.push("verify");
      throw new Error("network");
    });
    const onVerified = mock(() => {
      callOrder.push("onVerified");
    });
    render(<VerifyEmailOTPForm email="a@b.co" onVerified={onVerified} />);

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Verification code"), {
        target: { value: CODE },
      });
    });

    await waitFor(() => expect(verifyEmailMock).toHaveBeenCalled());
    // The outer catch surfaces actionable copy and must NOT hydrate or advance.
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Could not verify the code"),
    );
    expect(getSessionMock).not.toHaveBeenCalled();
    expect(onVerified).not.toHaveBeenCalled();
  });

  test("a hydration hiccup never traps the user — still advances after getSession throws", async () => {
    getSessionMock.mockImplementation(async () => {
      callOrder.push("getSession");
      throw new Error("network");
    });
    const onVerified = mock(() => {
      callOrder.push("onVerified");
    });
    render(<VerifyEmailOTPForm email="a@b.co" onVerified={onVerified} />);

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Verification code"), {
        target: { value: CODE },
      });
    });

    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
    expect(callOrder).toEqual(["verify", "getSession", "onVerified"]);
  });
});
