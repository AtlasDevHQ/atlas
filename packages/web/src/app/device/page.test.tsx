/**
 * Coverage for the device-approval page — the claim-before-approve fix (#4167).
 *
 * Better Auth's device plugin rejects `/device/approve` (and `/device/deny`)
 * until a verifying session has *claimed* the code via GET `/device`. The page
 * must fire that claim (`authClient.device({ query: { user_code } })`) before
 * the decision, or a signed-in human's first Approve always errors "Device code
 * has not been claimed…". These tests pin the ordering and the error surfacing.
 *
 * `mock.module(...)` covers every named export it stubs (per repo rule) so a
 * sibling test importing a different export doesn't trip a partial-mock error.
 */

import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, waitFor, cleanup, act, screen } from "@testing-library/react";

// ── Mocks ───────────────────────────────────────────────────────────────

// Ordered log so we can assert claim precedes the decision on the same click.
const callLog: string[] = [];

type Envelope = { data: unknown; error: { error_description?: string; message?: string } | null };

const deviceClaimMock = mock(async (_opts: { query: { user_code: string } }): Promise<Envelope> => {
  callLog.push("claim");
  return { data: { user_code: _opts.query.user_code, status: "pending" }, error: null };
});
const deviceApproveMock = mock(async (_opts: { userCode: string }): Promise<Envelope> => {
  callLog.push("approve");
  return { data: { success: true }, error: null };
});
const deviceDenyMock = mock(async (_opts: { userCode: string }): Promise<Envelope> => {
  callLog.push("deny");
  return { data: { success: true }, error: null };
});
// `authClient.device` is the callable deviceVerify (GET /device) AND carries
// `.approve`/`.deny` — mirror that shape by hanging the sub-actions off the fn.
Object.assign(deviceClaimMock, { approve: deviceApproveMock, deny: deviceDenyMock });

type Session = { isPending: boolean; data: { user: { email: string } } | null };
const sessionStore: { value: Session } = {
  value: { isPending: false, data: { user: { email: "dev@useatlas.dev" } } },
};

mock.module("@/lib/auth/client", () => ({
  authClient: {
    useSession: () => sessionStore.value,
    device: deviceClaimMock,
  },
}));

const searchParamsStore: Record<string, string | null> = { user_code: "SRVPR7QG" };
mock.module("next/navigation", () => ({
  useSearchParams: () => ({ get: (k: string) => searchParamsStore[k] ?? null }),
}));

import DevicePage from "./page";

beforeEach(() => {
  callLog.length = 0;
  deviceClaimMock.mockClear();
  deviceApproveMock.mockClear();
  deviceDenyMock.mockClear();
  deviceClaimMock.mockImplementation(async (opts: { query: { user_code: string } }) => {
    callLog.push("claim");
    return { data: { user_code: opts.query.user_code, status: "pending" }, error: null };
  });
  deviceApproveMock.mockImplementation(async () => {
    callLog.push("approve");
    return { data: { success: true }, error: null };
  });
  deviceDenyMock.mockImplementation(async () => {
    callLog.push("deny");
    return { data: { success: true }, error: null };
  });
  sessionStore.value = { isPending: false, data: { user: { email: "dev@useatlas.dev" } } };
  searchParamsStore.user_code = "SRVPR7QG";
});

afterEach(() => {
  cleanup();
});

// ── Tests ───────────────────────────────────────────────────────────────

describe("DevicePage — claim before approve (#4167)", () => {
  test("Approve first claims the code (GET /device), THEN approves", async () => {
    render(<DevicePage />);
    const btn = await screen.findByRole("button", { name: /approve/i });
    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(deviceApproveMock).toHaveBeenCalledTimes(1);
    });
    // The claim must precede the decision — that's the whole bug.
    expect(callLog).toEqual(["claim", "approve"]);
    expect(deviceClaimMock).toHaveBeenCalledWith({ query: { user_code: "SRVPR7QG" } });
    expect(deviceApproveMock).toHaveBeenCalledWith({ userCode: "SRVPR7QG" });

    await waitFor(() => {
      expect(document.body.textContent).toContain("Device approved");
    });
  });

  test("Deny also claims first, then denies", async () => {
    render(<DevicePage />);
    const btn = await screen.findByRole("button", { name: /deny/i });
    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(deviceDenyMock).toHaveBeenCalledTimes(1);
    });
    expect(callLog).toEqual(["claim", "deny"]);
  });

  test("a failed claim surfaces the error and never calls approve", async () => {
    deviceClaimMock.mockImplementation(async () => {
      callLog.push("claim");
      return {
        data: null,
        error: { error_description: "That code is invalid or has expired." },
      };
    });

    render(<DevicePage />);
    const btn = await screen.findByRole("button", { name: /approve/i });
    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("That code is invalid or has expired.");
    });
    // Approve must NOT fire when the claim failed.
    expect(deviceApproveMock).not.toHaveBeenCalled();
    expect(callLog).toEqual(["claim"]);
  });
});
