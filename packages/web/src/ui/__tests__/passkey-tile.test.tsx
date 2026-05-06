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
  // Default no-op resolves so tests don't accidentally see a leaked impl.
  addPasskeyMock.mockImplementation(async () => ({ data: null, error: null }));
  updatePasskeyMock.mockImplementation(async () => ({ data: null, error: null }));
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
