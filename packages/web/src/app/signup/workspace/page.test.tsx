/**
 * Coverage for the signup workspace step nav target (ADR-0024 §4, #3972).
 *
 * Region now precedes account creation, so after the workspace is created
 * (its region already stamped from the ambient ATLAS_API_REGION at creation,
 * #3969) the flow proceeds to /signup/connect — NOT back to /signup/region as
 * in the pre-reorder flow. This pins that redirect target so a regression can't
 * silently loop a just-created workspace back to the region picker.
 *
 * `mock.module(...)` stubs every named export of the modules it touches (repo
 * rule). The signup shell is a passthrough so the test exercises this page.
 */

import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, waitFor, cleanup, act, screen } from "@testing-library/react";

// ── Mocks ───────────────────────────────────────────────────────────────

const routerPushMock = mock((_path: string) => {});
const routerMock = { push: routerPushMock, replace: () => {}, back: () => {} };
void mock.module("next/navigation", () => ({
  useRouter: () => routerMock,
}));

const orgCreateMock = mock(async (_opts: { name: string; slug: string }) => ({
  data: { id: "org-1" },
  error: null as { message?: string } | null,
}));
const setActiveMock = mock(async (_opts: { organizationId: string }) => ({ data: {}, error: null }));
void mock.module("@/lib/auth/client", () => ({
  authClient: {
    organization: { create: orgCreateMock, setActive: setActiveMock },
  },
}));

void mock.module("@/ui/components/signup/signup-shell", () => ({
  SignupShell: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));

import WorkspacePage from "./page";

beforeEach(() => {
  routerPushMock.mockReset();
  orgCreateMock.mockReset();
  orgCreateMock.mockImplementation(async () => ({ data: { id: "org-1" }, error: null }));
  setActiveMock.mockReset();
  setActiveMock.mockImplementation(async () => ({ data: {}, error: null }));
});

afterEach(() => {
  cleanup();
});

describe("WorkspacePage — proceeds to connect, not region (#3972)", () => {
  test("creating a workspace routes forward to /signup/connect", async () => {
    render(<WorkspacePage />);

    fireEvent.change(screen.getByLabelText(/workspace name/i), { target: { value: "Acme Corp" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    });

    await waitFor(() => {
      expect(orgCreateMock).toHaveBeenCalledTimes(1);
    });
    expect(routerPushMock).toHaveBeenCalledWith("/signup/connect");
    // Must not loop back to the (now-upstream) region step.
    expect(routerPushMock).not.toHaveBeenCalledWith("/signup/region");
  });
});
