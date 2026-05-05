/**
 * Coverage for the enrolled-passkey list (#2082 PR B).
 *
 * Covers:
 *  - Empty state copy
 *  - Row rendering (name + createdAt)
 *  - Rename dialog round-trip → calls updatePasskey + onChange
 *  - Delete dialog round-trip → calls deletePasskey + onChange
 */

import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, waitFor, cleanup, act } from "@testing-library/react";

const updatePasskeyMock = mock(async (_opts?: unknown) => ({
  data: { passkey: { id: "pk_123", name: "Renamed", createdAt: new Date() } },
  error: null,
}));
const deletePasskeyMock = mock(async (_opts?: unknown) => ({
  data: { status: true },
  error: null,
}));

mock.module("@/lib/auth/client", () => ({
  authClient: {
    passkey: {
      updatePasskey: updatePasskeyMock,
      deletePasskey: deletePasskeyMock,
    },
  },
}));

import { PasskeyList } from "../components/admin/security/passkey-list";

beforeEach(() => {
  updatePasskeyMock.mockClear();
  deletePasskeyMock.mockClear();
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

    const renameBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      b.getAttribute("aria-label")?.startsWith("Rename"),
    );
    expect(renameBtn).toBeTruthy();

    await act(async () => {
      fireEvent.click(renameBtn!);
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("Rename passkey");
    });

    const input = document.querySelector('input[maxlength="80"]') as HTMLInputElement | null;
    expect(input).toBeTruthy();
    fireEvent.change(input!, { target: { value: "New name" } });

    const saveBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.trim() === "Save",
    );

    await act(async () => {
      fireEvent.click(saveBtn!);
    });

    await waitFor(() => {
      expect(updatePasskeyMock).toHaveBeenCalledTimes(1);
    });
    expect(updatePasskeyMock.mock.calls[0]?.[0]).toEqual({ id: "pk_1", name: "New name" });
    expect(onChange).toHaveBeenCalled();
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

    const deleteBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      b.getAttribute("aria-label")?.startsWith("Delete"),
    );
    expect(deleteBtn).toBeTruthy();

    await act(async () => {
      fireEvent.click(deleteBtn!);
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("Delete passkey?");
    });

    // Confirm dialog presents the Delete action; click it.
    const confirmBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.trim() === "Delete",
    );

    await act(async () => {
      fireEvent.click(confirmBtn!);
    });

    await waitFor(() => {
      expect(deletePasskeyMock).toHaveBeenCalledTimes(1);
    });
    expect(deletePasskeyMock.mock.calls[0]?.[0]).toEqual({ id: "pk_1" });
    expect(onChange).toHaveBeenCalled();
  });
});
