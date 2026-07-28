/**
 * Coverage for the passkey enrollment tile + helpers.
 */

import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, waitFor, cleanup, act, screen } from "@testing-library/react";

/** Result shape the tile consumes from better-auth's passkey client — wide
 * enough for the success/error variants the tests stage per call. */
type PasskeyCallResult = {
  data: { id?: string; createdAt?: Date } | null;
  error: { code?: string; message?: string; status?: number } | null;
};
const addPasskeyMock = mock(
  async (_opts?: unknown): Promise<PasskeyCallResult> => ({ data: null, error: null }),
);
const updatePasskeyMock = mock(
  async (_opts?: unknown): Promise<PasskeyCallResult> => ({ data: null, error: null }),
);
const listUserPasskeysMock = mock(async () => ({ data: [], error: null }));
const deletePasskeyMock = mock(async (_opts?: unknown) => ({ data: { status: true }, error: null }));

void mock.module("@/lib/auth/passkey-client", () => ({
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
      data: { twoFactorRedirect?: boolean; user?: Record<string, unknown> } | null;
      error: { message?: string; code?: string } | null;
    },
);
const useSessionMock = mock(() => ({
  data: { user: { email: "admin@useatlas.dev" } },
}));

void mock.module("@/lib/auth/client", () => ({
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

/**
 * testing-library's async default is 1000ms of WALL-CLOCK, not of work. The
 * tile's add-passkey click is fire-and-forget (`handleAdd` does
 * `void runAddPasskey()`), so the click returns before the chain that drives
 * the UI has settled: addPasskey resolves -> setState -> re-render -> the
 * re-auth dialog's portal mounts. On a CI runner executing 300+ web test files
 * in parallel the event loop is starved enough for that chain to exceed 1000ms
 * — observed at 1035ms in run 30355525624, where the same commit passed in a
 * sibling run. Matches the scoped `{ timeout: N }` idiom already used in
 * password-section / use-password-status / use-run-status rather than a global
 * `configure({ asyncUtilTimeout })`, so only the genuinely-async waits get
 * headroom and a real hang still fails the suite.
 */
const SLOW_ENV_TIMEOUT = 5000;

/**
 * Drive the tile from its idle state to an open re-auth dialog and hand back
 * the password input.
 *
 * Waits on the CAUSE before the effect: asserting `addPasskeyMock` ran, then
 * the dialog's own copy, then the input. A timeout therefore names the step
 * that actually stalled ("addPasskey never ran" / "dialog never opened")
 * instead of the generic "unable to find an element with the placeholder
 * text", which is what made the original failure hard to read.
 *
 * Callers must stage an `addPasskeyMock` implementation returning
 * SESSION_NOT_FRESH before calling this.
 */
async function openReauthDialog(): Promise<HTMLElement> {
  const addBtn = await screen.findByRole(
    "button",
    { name: /add a passkey/i },
    { timeout: SLOW_ENV_TIMEOUT },
  );
  await act(async () => {
    fireEvent.click(addBtn);
  });
  await waitFor(() => expect(addPasskeyMock).toHaveBeenCalled(), {
    timeout: SLOW_ENV_TIMEOUT,
  });
  await waitFor(() => expect(document.body.textContent).toContain("Re-enter your password"), {
    timeout: SLOW_ENV_TIMEOUT,
  });
  return screen.findByPlaceholderText(/your password/i, {}, { timeout: SLOW_ENV_TIMEOUT });
}

describe("PasskeyTile", () => {
  test("falls back to unsupported copy when PublicKeyCredential is missing", async () => {
    setPublicKeyCredential(undefined);

    render(<PasskeyTile hasPasskey={false} />);

    await waitFor(() => {
      expect(document.body.textContent).toContain("Passkey unavailable");
    }, { timeout: SLOW_ENV_TIMEOUT });
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
    }, { timeout: SLOW_ENV_TIMEOUT });
    expect(screen.getByRole("button", { name: /add a passkey/i })).toBeDefined();
  });

  test("shows downgraded copy and no recommended badge when only roaming auth is available", async () => {
    setPublicKeyCredential({
      isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(false),
    });

    render(<PasskeyTile hasPasskey={false} />);

    await waitFor(() => {
      expect(document.body.textContent).toContain("Limited support — security key only");
    }, { timeout: SLOW_ENV_TIMEOUT });
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
    }, { timeout: SLOW_ENV_TIMEOUT });
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

    const addBtn = await screen.findByRole(
      "button",
      { name: /add a passkey/i },
      { timeout: SLOW_ENV_TIMEOUT },
    );

    await act(async () => {
      fireEvent.click(addBtn);
    });

    await waitFor(() => {
      expect(addPasskeyMock).toHaveBeenCalledTimes(1);
    }, { timeout: SLOW_ENV_TIMEOUT });

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

    const addBtn = await screen.findByRole(
      "button",
      { name: /add a passkey/i },
      { timeout: SLOW_ENV_TIMEOUT },
    );

    await act(async () => {
      fireEvent.click(addBtn);
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("Origin mismatch");
    }, { timeout: SLOW_ENV_TIMEOUT });
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

    const addBtn = await screen.findByRole(
      "button",
      { name: /add a passkey/i },
      { timeout: SLOW_ENV_TIMEOUT },
    );

    await act(async () => {
      fireEvent.click(addBtn);
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("Name this passkey");
    }, { timeout: SLOW_ENV_TIMEOUT });
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

    const addBtn = await screen.findByRole(
      "button",
      { name: /add a passkey/i },
      { timeout: SLOW_ENV_TIMEOUT },
    );
    await act(async () => {
      fireEvent.click(addBtn);
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("Re-enter your password");
    }, { timeout: SLOW_ENV_TIMEOUT });
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

    // Re-auth dialog appears with a password input + confirm button.
    const passwordInput = await openReauthDialog();
    await act(async () => {
      fireEvent.change(passwordInput, { target: { value: "correct-horse-battery-staple" } });
    });
    const confirmBtn = await screen.findByRole(
      "button",
      { name: /confirm and add passkey/i },
      { timeout: SLOW_ENV_TIMEOUT },
    );
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => expect(signInEmailMock).toHaveBeenCalledTimes(1), {
      timeout: SLOW_ENV_TIMEOUT,
    });
    // addPasskey is called twice: original (rejected) + retry (successful).
    await waitFor(() => expect(addPasskeyMock).toHaveBeenCalledTimes(2), {
      timeout: SLOW_ENV_TIMEOUT,
    });
    // Successful retry should open the rename modal.
    await waitFor(() => expect(document.body.textContent).toContain("Name this passkey"), {
      timeout: SLOW_ENV_TIMEOUT,
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

    const passwordInput = await openReauthDialog();
    await act(async () => {
      fireEvent.change(passwordInput, { target: { value: "wrong" } });
    });
    const confirmBtn = await screen.findByRole(
      "button",
      { name: /confirm and add passkey/i },
      { timeout: SLOW_ENV_TIMEOUT },
    );
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
    }, { timeout: SLOW_ENV_TIMEOUT });
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

    const addBtn = await screen.findByRole(
      "button",
      { name: /add a passkey/i },
      { timeout: SLOW_ENV_TIMEOUT },
    );
    await act(async () => {
      fireEvent.click(addBtn);
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("Name this passkey");
    }, { timeout: SLOW_ENV_TIMEOUT });

    const saveBtn = await screen.findByRole(
      "button",
      { name: /^save$/i },
      { timeout: SLOW_ENV_TIMEOUT },
    );
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    await waitFor(() => {
      expect(updatePasskeyMock).toHaveBeenCalledTimes(1);
    }, { timeout: SLOW_ENV_TIMEOUT });

    // Dialog closes; parent is asked to refetch; recovery hint is visible.
    await waitFor(() => {
      expect(document.body.textContent).not.toContain("Name this passkey");
    }, { timeout: SLOW_ENV_TIMEOUT });
    expect(onChange).toHaveBeenCalled();
    expect(document.body.textContent).toContain("Saved your passkey, but renaming failed");
    expect(document.body.textContent).toContain("DB write timeout");
    expect(document.body.textContent).toContain("rename it from the list below");
  });
});
