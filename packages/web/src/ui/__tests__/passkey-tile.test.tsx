/**
 * Coverage for the passkey enrollment tile + helpers (#2082 PR B).
 *
 * Covers:
 *  - `deriveDefaultPasskeyName` — userAgent parsing fallbacks
 *  - WebAuthn capability fallback (browser missing PublicKeyCredential)
 *  - addPasskey() user-cancellation must not surface an error
 *  - addPasskey() success opens the rename modal with the derived default
 */

import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, waitFor, cleanup, act } from "@testing-library/react";

const addPasskeyMock = mock(async (_opts?: unknown) => ({ data: null, error: null }));
const updatePasskeyMock = mock(async (_opts?: unknown) => ({ data: null, error: null }));

mock.module("@/lib/auth/client", () => ({
  authClient: {
    passkey: {
      addPasskey: addPasskeyMock,
      updatePasskey: updatePasskeyMock,
    },
  },
}));

import {
  PasskeyTile,
  deriveDefaultPasskeyName,
} from "../components/admin/security/passkey-tile";

const originalPublicKeyCredential = (
  globalThis as unknown as { PublicKeyCredential?: unknown }
).PublicKeyCredential;

function setPublicKeyCredential(value: unknown): void {
  Object.defineProperty(globalThis, "PublicKeyCredential", {
    value,
    writable: true,
    configurable: true,
  });
  // happy-dom mirrors `window`/`globalThis`, but defining on globalThis can
  // skip the window proxy. Set it explicitly so the hook's typeof check sees it.
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
  addPasskeyMock.mockClear();
  updatePasskeyMock.mockClear();
});

afterEach(() => {
  cleanup();
  restorePublicKeyCredential();
});

describe("deriveDefaultPasskeyName", () => {
  test("recognizes Mac Safari", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
    expect(deriveDefaultPasskeyName(ua)).toBe("Mac · Safari");
  });

  test("recognizes Windows Chrome", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    expect(deriveDefaultPasskeyName(ua)).toBe("Windows PC · Chrome");
  });

  test("recognizes iPhone Safari", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    expect(deriveDefaultPasskeyName(ua)).toBe("iPhone · Safari");
  });

  test("falls back when nothing matches", () => {
    expect(deriveDefaultPasskeyName("ExoticHttpBot/1.0")).toBe("This device");
  });

  test("handles bare device without browser", () => {
    expect(deriveDefaultPasskeyName("Mozilla/5.0 (Android; Mobile)")).toBe("Android");
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

  test("shows recommended badge when no passkey is enrolled and platform auth is available", async () => {
    setPublicKeyCredential({
      isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true),
    });

    render(<PasskeyTile hasPasskey={false} />);

    await waitFor(() => {
      expect(document.body.textContent).toContain("Recommended");
    });
    expect(document.body.textContent).toContain("Add a passkey");
  });

  test('"Add another passkey" replaces the primary CTA when one is already enrolled', async () => {
    setPublicKeyCredential({
      isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true),
    });

    render(<PasskeyTile hasPasskey={true} />);

    await waitFor(() => {
      expect(document.body.textContent).toContain("Add another passkey");
    });
    // The recommended badge should not appear when a passkey exists.
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

    await waitFor(() => {
      expect(document.body.textContent).toContain("Add a passkey");
    });

    const addBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Add a passkey"),
    );

    await act(async () => {
      fireEvent.click(addBtn!);
    });

    await waitFor(() => {
      expect(addPasskeyMock).toHaveBeenCalledTimes(1);
    });

    // No error banner; the rename dialog should not open.
    expect(document.body.textContent).not.toContain("Could not register that passkey");
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

    await waitFor(() => {
      expect(document.body.textContent).toContain("Add a passkey");
    });

    const addBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Add a passkey"),
    );

    await act(async () => {
      fireEvent.click(addBtn!);
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("Name this passkey");
    });
  });
});
