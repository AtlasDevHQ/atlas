import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ChangePasswordDialog } from "../components/admin/change-password-dialog";
import { AtlasProvider, type AtlasAuthClient } from "../context";

const stubAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null }),
};

function renderDialog(open: boolean, onComplete?: () => void) {
  return render(
    <AtlasProvider config={{ apiUrl: "http://localhost:3001", isCrossOrigin: false, authClient: stubAuthClient }}>
      <ChangePasswordDialog open={open} onComplete={onComplete ?? (() => {})} />
    </AtlasProvider>,
  );
}

/** AlertDialog portals content to document.body — query there instead of container */
function getInputs() {
  return document.querySelectorAll('input[type="password"]');
}

function getForm() {
  return document.querySelector("form");
}

/** Fill new + confirm password fields and submit the form. */
function fillAndSubmit(newPwd: string, confirmPwd?: string) {
  const inputs = getInputs();
  fireEvent.change(inputs[1], { target: { value: newPwd } });
  fireEvent.change(inputs[2], { target: { value: confirmPwd ?? newPwd } });
  fireEvent.submit(getForm()!);
}

const originalFetch = globalThis.fetch;

describe("ChangePasswordDialog", () => {
  beforeEach(() => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  test("renders dialog content when open", () => {
    renderDialog(true);
    expect(document.body.textContent).toContain("Change your password");
    expect(document.body.textContent).toContain("default dev password");
  });

  test("has current password, new password, and confirm fields", () => {
    renderDialog(true);
    const inputs = getInputs();
    expect(inputs.length).toBe(3);
  });

  test("has submit button", () => {
    renderDialog(true);
    const button = document.querySelector('button[type="submit"]');
    expect(button).not.toBeNull();
    expect(button!.textContent).toContain("Change password");
  });

  test("shows error when new password is too short", async () => {
    renderDialog(true);
    fillAndSubmit("short");

    await waitFor(() => {
      expect(document.body.textContent).toContain("at least 8 characters");
    });
  });

  test("shows error when passwords do not match", async () => {
    renderDialog(true);
    fillAndSubmit("newpassword1", "newpassword2");

    await waitFor(() => {
      expect(document.body.textContent).toContain("do not match");
    });
  });

  test("shows error when new password equals current password", async () => {
    renderDialog(true);
    // Current password defaults to "atlas-dev"
    fillAndSubmit("atlas-dev");

    await waitFor(() => {
      expect(document.body.textContent).toContain("must be different");
    });
  });

  test("calls fetch with correct payload and invokes onComplete", async () => {
    const onComplete = mock(() => {});
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    renderDialog(true, onComplete);
    fillAndSubmit("newpassword123");

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const [url, opts] = (fetchMock as unknown as ReturnType<typeof mock>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/admin/me/password");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body as string)).toEqual({
      currentPassword: "atlas-dev",
      newPassword: "newpassword123",
    });
  });

  test("shows error on API failure with JSON body", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ message: "Wrong current password" }), { status: 400 }),
      ),
    ) as unknown as typeof fetch;

    renderDialog(true);
    fillAndSubmit("newpassword123");

    await waitFor(() => {
      expect(document.body.textContent).toContain("Wrong current password");
    });
  });

  test("shows fallback error on API failure with non-JSON body", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Internal Server Error", { status: 500 })),
    ) as unknown as typeof fetch;

    renderDialog(true);
    fillAndSubmit("newpassword123");

    await waitFor(() => {
      expect(document.body.textContent).toContain("Failed (HTTP 500)");
    });
  });

  test("shows error on network failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("Network error")),
    ) as unknown as typeof fetch;

    renderDialog(true);
    fillAndSubmit("newpassword123");

    await waitFor(() => {
      expect(document.body.textContent).toContain("Network error");
    });
  });
});
