/**
 * Coverage for the passkey enrollment tile + helpers.
 */

import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, waitFor, cleanup, act, screen } from "@testing-library/react";

const addPasskeyMock = mock(async (_opts?: unknown) => ({ data: null, error: null }));
const updatePasskeyMock = mock(async (_opts?: unknown) => ({ data: null, error: null }));
const listUserPasskeysMock = mock(async () => ({ data: [], error: null }));
const deletePasskeyMock = mock(async (_opts?: unknown) => ({ data: { status: true }, error: null }));

mock.module("@/lib/auth/passkey-client", () => ({
  getPasskeyClient: () => ({
    addPasskey: addPasskeyMock,
    updatePasskey: updatePasskeyMock,
    listUserPasskeys: listUserPasskeysMock,
    deletePasskey: deletePasskeyMock,
  }),
  // Stubbed to satisfy the `mock.module() must mock every named export`
  // rule — the enrollment tile never calls signIn.passkey() itself.
  getPasskeySignIn: () => null,
}));

const signInEmailMock = mock(
  async (_opts: { email: string; password: string }) =>
    ({ data: null, error: null }) as {
      data: { twoFactorRedirect?: boolean } | null;
      error: { message?: string; code?: string } | null;
    },
);
const useSessionMock = mock(() => ({
  data: { user: { email: "admin@useatlas.dev" } },
}));

mock.module("@/lib/auth/client", () => ({
  authClient: {
    useSession: useSessionMock,
    signIn: { email: signInEmailMock },
  },
}));

import { PasskeyTile } from "../components/admin/security/passkey-tile";
import { deriveDeviceName } from "@/lib/auth/derive-device-name";

const originalPublicKeyCredential = (
  globalThis as unknown as { PublicKeyCredential?: unknown }
).PublicKeyCredential;

function setPublicKeyCredential(value: unknown): void {
  Object.defineProperty(globalThis, "PublicKeyCredential", {
    value,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, "PublicKeyCredential", {
    value,
    writable: true,
    configurable: true,
  });
}

function restorePublicKeyCredential(): void {
  setPublicKeyCredential(originalPublicKeyCredential);
}

beforeEach(() => {
  addPasskeyMock.mockReset();
  updatePasskeyMock.mockReset();
  signInEmailMock.mockReset();
  useSessionMock.mockReset();
  // Default no-op resolves so tests don't accidentally see a leaked impl.
  addPasskeyMock.mockImplementation(async () => ({ data: null, error: null }));
  updatePasskeyMock.mockImplementation(async () => ({ data: null, error: null }));
  signInEmailMock.mockImplementation(async () => ({ data: null, error: null }));
  useSessionMock.mockImplementation(() => ({
    data: { user: { email: "admin@useatlas.dev" } },
  }));
});

afterEach(() => {
  cleanup();
  restorePublicKeyCredential();
});

describe("deriveDeviceName", () => {
  test("recognizes Mac Safari", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
    expect(deriveDeviceName(ua)).toBe("Mac · Safari");
  });

  test("recognizes Windows Chrome", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    expect(deriveDeviceName(ua)).toBe("Windows PC · Chrome");
  });

  test("recognizes iPhone Safari", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    expect(deriveDeviceName(ua)).toBe("iPhone · Safari");
  });

  test("falls back when nothing matches", () => {
    expect(deriveDeviceName("ExoticHttpBot/1.0")).toBe("This device");
  });

  test("handles bare device without browser", () => {
    expect(deriveDeviceName("Mozilla/5.0 (Android; Mobile)")).toBe("Android");
  });
});

describe("PasskeyTile", () => {
  test("falls back to unsupported copy when PublicKeyCredential is missing", async () => {
    setPublicKeyCredential(undefined);

    render(<PasskeyTile hasPasskey={false} />);

    await waitFor(() => {
      expect(document.body.textContent).toContain("Passkey unavailable");
    });
    expect(document.body.textContent).toContain("Your browser doesn't support passkeys");
  });

  test("button is disabled while WebAuthn capability is still unknown", () => {
    // Intentionally never resolve the platform-availability probe so the
    // hook stays in the `unknown` state for the duration of the test.
    setPublicKeyCredential({
      isUserVerifyingPlatformAuthenticatorAvailable: () => new Promise(() => {}),
    });

    render(<PasskeyTile hasPasskey={false} />);

    const addBtn = screen.getByRole("button", { name: /add a passkey/i }) as HTMLButtonElement;
    expect(addBtn.disabled).toBe(true);
  });

  test("shows recommended badge when no passkey is enrolled and platform auth is available", async () => {
    setPublicKeyCredential({
      isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true),
    });

    render(<PasskeyTile hasPasskey={false} />);

    await waitFor(() => {
      expect(document.body.textContent).toContain("Recommended");
    });
    expect(screen.getByRole("button", { name: /add a passkey/i })).toBeDefined();
  });

  test("shows downgraded copy and no recommended badge when only roaming auth is available", async () => {
    setPublicKeyCredential({
      isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(false),
    });

    render(<PasskeyTile hasPasskey={false} />);

    await waitFor(() => {
      expect(document.body.textContent).toContain("Limited support — security key only");
    });
    expect(document.body.textContent).not.toContain("Recommended");
    const addBtn = screen.getByRole("button", { name: /add a passkey/i }) as HTMLButtonElement;
    expect(addBtn.disabled).toBe(false);
  });

  test('"Add another passkey" replaces the primary CTA when one is already enrolled', async () => {
    setPublicKeyCredential({
      isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true),
    });

    render(<PasskeyTile hasPasskey={true} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /add another passkey/i })).toBeDefined();
    });
    expect(document.body.textContent).not.toContain("Recommended");
  });

  test("user cancellation on the OS prompt does not surface an error", async () => {
    setPublicKeyCredential({
      isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true),
    });
    addPasskeyMock.mockImplementationOnce(async () => ({
      data: null,
      error: { code: "REGISTRATION_CANCELLED", message: "cancelled" },
    }));

    render(<PasskeyTile hasPasskey={false} />);

    const addBtn = await screen.findByRole("button", { name: /add a passkey/i });

    await act(async () => {
      fireEvent.click(addBtn);
    });

    await waitFor(() => {
      expect(addPasskeyMock).toHaveBeenCalledTimes(1);
    });

    expect(document.body.textContent).not.toContain("Could not register that passkey");
    expect(document.body.textContent).not.toContain("Name this passkey");
  });

  test("real server error surfaces a banner with the message", async () => {
    setPublicKeyCredential({
      isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true),
    });
    addPasskeyMock.mockImplementationOnce(async () => ({
      data: null,
      error: { code: "BAD_RP_ID", message: "Origin mismatch", status: 400 },
    }));

    render(<PasskeyTile hasPasskey={false} />);

    const addBtn = await screen.findByRole("button", { name: /add a passkey/i });

    await act(async () => {
      fireEvent.click(addBtn);
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("Origin mismatch");
    });
    expect(document.body.textContent).not.toContain("Name this passkey");
  });

  test("addPasskey() success opens the rename modal with a derived default", async () => {
    setPublicKeyCredential({
      isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true),
    });
    addPasskeyMock.mockImplementationOnce(async () => ({
      data: { id: "pk_123", createdAt: new Date() },
      error: null,
    }));

    render(<PasskeyTile hasPasskey={false} />);

    const addBtn = await screen.findByRole("button", { name: /add a passkey/i });

    await act(async () => {
      fireEvent.click(addBtn);
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("Name this passkey");
    });
  });

  test("SESSION_NOT_FRESH opens the re-auth dialog instead of surfacing a banner", async () => {
    setPublicKeyCredential({
      isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true),
    });
    addPasskeyMock.mockImplementationOnce(async () => ({
      data: null,
      error: { code: "SESSION_NOT_FRESH", message: "Session is not fresh", status: 403 },
    }));

    render(<PasskeyTile hasPasskey={false} />);

    const addBtn = await screen.findByRole("button", { name: /add a passkey/i });
    await act(async () => {
      fireEvent.click(addBtn);
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("Re-enter your password");
    });
    // The freshness branch must NOT surface the generic enrollment-failure
    // banner — that would be a confusing double signal alongside the dialog.
    expect(document.body.textContent).not.toContain("Could not register that passkey");
  });

  test("re-auth with correct password retries addPasskey and proceeds to naming", async () => {
    setPublicKeyCredential({
      isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true),
    });
    // First attempt: blocked by freshness. Second attempt (after re-auth):
    // succeeds and returns the new passkey envelope so the rename modal opens.
    addPasskeyMock
      .mockImplementationOnce(async () => ({
        data: null,
        error: { code: "SESSION_NOT_FRESH", message: "Session is not fresh", status: 403 },
      }))
      .mockImplementationOnce(async () => ({
        data: { id: "pk_999", createdAt: new Date() },
        error: null,
      }));
    signInEmailMock.mockImplementationOnce(async () => ({ data: { user: {} }, error: null }));

    render(<PasskeyTile hasPasskey={false} />);

    const addBtn = await screen.findByRole("button", { name: /add a passkey/i });
    await act(async () => {
      fireEvent.click(addBtn);
    });

    // Re-auth dialog appears with a password input + confirm button.
    const passwordInput = await screen.findByPlaceholderText(/your password/i);
    await act(async () => {
      fireEvent.change(passwordInput, { target: { value: "correct-horse-battery-staple" } });
    });
    const confirmBtn = await screen.findByRole("button", { name: /confirm and add passkey/i });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(signInEmailMock).toHaveBeenCalledTimes(1);
    });
    // addPasskey is called twice: original (rejected) + retry (successful).
    await waitFor(() => {
      expect(addPasskeyMock).toHaveBeenCalledTimes(2);
    });
    // Successful retry should open the rename modal.
    await waitFor(() => {
      expect(document.body.textContent).toContain("Name this passkey");
    });
  });

  test("re-auth with wrong password shows OAuth-aware fallback hint", async () => {
    setPublicKeyCredential({
      isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true),
    });
    addPasskeyMock.mockImplementationOnce(async () => ({
      data: null,
      error: { code: "SESSION_NOT_FRESH", message: "Session is not fresh", status: 403 },
    }));
    signInEmailMock.mockImplementationOnce(async () => ({
      data: null,
      error: { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" },
    }));

    render(<PasskeyTile hasPasskey={false} />);

    const addBtn = await screen.findByRole("button", { name: /add a passkey/i });
    await act(async () => {
      fireEvent.click(addBtn);
    });

    const passwordInput = await screen.findByPlaceholderText(/your password/i);
    await act(async () => {
      fireEvent.change(passwordInput, { target: { value: "wrong" } });
    });
    const confirmBtn = await screen.findByRole("button", { name: /confirm and add passkey/i });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      // The hint must point OAuth-only users at sign-out / sign-back-in.
      // INVALID_EMAIL_OR_PASSWORD covers both wrong-password and OAuth-only
      // users (no `credential` account); we use the same copy for both.
      expect(document.body.textContent).toContain(
        "If you signed up with Google, GitHub, or SSO",
      );
    });
    // Ensure addPasskey was NOT retried — re-auth failed.
    expect(addPasskeyMock).toHaveBeenCalledTimes(1);
  });

  test("rename failure after successful enrollment fires onChange and shows recovery hint", async () => {
    setPublicKeyCredential({
      isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true),
    });
    addPasskeyMock.mockImplementationOnce(async () => ({
      data: { id: "pk_456", createdAt: new Date() },
      error: null,
    }));
    updatePasskeyMock.mockImplementationOnce(async () => ({
      data: null,
      error: { code: "FAILED_TO_UPDATE_PASSKEY", message: "DB write timeout", status: 500 },
    }));

    const onChange = mock(() => {});
    render(<PasskeyTile hasPasskey={false} onChange={onChange} />);

    const addBtn = await screen.findByRole("button", { name: /add a passkey/i });
    await act(async () => {
      fireEvent.click(addBtn);
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("Name this passkey");
    });

    const saveBtn = await screen.findByRole("button", { name: /^save$/i });
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    await waitFor(() => {
      expect(updatePasskeyMock).toHaveBeenCalledTimes(1);
    });

    // Dialog closes; parent is asked to refetch; recovery hint is visible.
    await waitFor(() => {
      expect(document.body.textContent).not.toContain("Name this passkey");
    });
    expect(onChange).toHaveBeenCalled();
    expect(document.body.textContent).toContain("Saved your passkey, but renaming failed");
    expect(document.body.textContent).toContain("DB write timeout");
    expect(document.body.textContent).toContain("rename it from the list below");
  });
});
