/**
 * Coverage for the enrolled-passkey list.
 */

import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, waitFor, cleanup, act, screen } from "@testing-library/react";

const updatePasskeyMock = mock(async (_opts?: unknown) => ({
  data: { passkey: { id: "pk_123", name: "Renamed", createdAt: new Date() } },
  error: null,
}));
const deletePasskeyMock = mock(async (_opts?: unknown) => ({
  data: { status: true },
  error: null,
}));
const addPasskeyMock = mock(async (_opts?: unknown) => ({ data: null, error: null }));
const listUserPasskeysMock = mock(async () => ({ data: [], error: null }));

mock.module("@/lib/auth/passkey-client", () => ({
  getPasskeyClient: () => ({
    addPasskey: addPasskeyMock,
    updatePasskey: updatePasskeyMock,
    listUserPasskeys: listUserPasskeysMock,
    deletePasskey: deletePasskeyMock,
  }),
  // Stubbed to satisfy the `mock.module() must mock every named export`
  // rule — the list view never calls signIn.passkey() itself.
  getPasskeySignIn: () => null,
}));

import { PasskeyList } from "../components/admin/security/passkey-list";

beforeEach(() => {
  updatePasskeyMock.mockReset();
  deletePasskeyMock.mockReset();
  updatePasskeyMock.mockImplementation(async () => ({
    data: { passkey: { id: "pk_123", name: "Renamed", createdAt: new Date() } },
    error: null,
  }));
  deletePasskeyMock.mockImplementation(async () => ({ data: { status: true }, error: null }));
});

afterEach(() => {
  cleanup();
});

describe("PasskeyList", () => {
  test("empty state points at the tile", () => {
    render(<PasskeyList passkeys={[]} />);
    expect(document.body.textContent).toContain("No passkeys yet");
    expect(document.body.textContent).toContain("Use the Passkey tile above");
  });

  test("renders each row with name + createdAt", () => {
    render(
      <PasskeyList
        passkeys={[
          { id: "pk_1", name: "MacBook · Safari", createdAt: new Date("2026-04-01T12:00:00Z") },
          { id: "pk_2", name: "iPhone · Safari", createdAt: new Date("2026-04-15T12:00:00Z") },
        ]}
      />,
    );
    expect(document.body.textContent).toContain("MacBook · Safari");
    expect(document.body.textContent).toContain("iPhone · Safari");
    expect(document.body.textContent).toMatch(/Added\s+\w+/);
  });

  test("rename dialog calls updatePasskey and onChange", async () => {
    const onChange = mock(() => {});
    render(
      <PasskeyList
        passkeys={[
          { id: "pk_1", name: "Old name", createdAt: new Date("2026-04-01T12:00:00Z") },
        ]}
        onChange={onChange}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /rename Old name/i }));
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("Rename passkey");
    });

    const input = document.querySelector('input[maxlength="80"]') as HTMLInputElement | null;
    expect(input).toBeTruthy();
    fireEvent.change(input!, { target: { value: "New name" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    });

    await waitFor(() => {
      expect(updatePasskeyMock).toHaveBeenCalledTimes(1);
    });
    expect(updatePasskeyMock.mock.calls[0]?.[0]).toEqual({ id: "pk_1", name: "New name" });
    expect(onChange).toHaveBeenCalled();
  });

  test("rename guard blocks empty / whitespace-only names", async () => {
    render(
      <PasskeyList
        passkeys={[
          { id: "pk_1", name: "Old name", createdAt: new Date("2026-04-01T12:00:00Z") },
        ]}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /rename Old name/i }));
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("Rename passkey");
    });

    const input = document.querySelector('input[maxlength="80"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });

    const saveBtn = screen.getByRole("button", { name: /^save$/i }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    // Pressing Enter inside the input must not slip through the guard.
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(updatePasskeyMock).not.toHaveBeenCalled();
  });

  test("delete dialog calls deletePasskey and onChange", async () => {
    const onChange = mock(() => {});
    render(
      <PasskeyList
        passkeys={[
          { id: "pk_1", name: "Doomed key", createdAt: new Date("2026-04-01T12:00:00Z") },
        ]}
        onChange={onChange}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /delete Doomed key/i }));
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("Delete passkey?");
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    });

    await waitFor(() => {
      expect(deletePasskeyMock).toHaveBeenCalledTimes(1);
    });
    expect(deletePasskeyMock.mock.calls[0]?.[0]).toEqual({ id: "pk_1" });
    expect(onChange).toHaveBeenCalled();
  });
});
