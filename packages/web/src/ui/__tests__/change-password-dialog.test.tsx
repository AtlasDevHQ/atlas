import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ChangePasswordDialog } from "../components/admin/change-password-dialog";
import { AtlasUIProvider, type AtlasAuthClient } from "../context";

const stubAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null }),
};

function renderDialog(open: boolean, onComplete?: () => void) {
  return render(
    <AtlasUIProvider config={{ apiUrl: "http://localhost:3001", isCrossOrigin: false, authClient: stubAuthClient }}>
      <ChangePasswordDialog open={open} onComplete={onComplete ?? (() => {})} />
    </AtlasUIProvider>,
  );
}

/** AlertDialog portals content to document.body — query there instead of container */
function getInputs() {
  return document.querySelectorAll('input[type="password"]');
}

function getForm() {
  return document.querySelector("form");
}

const originalFetch = globalThis.fetch;

describe("ChangePasswordDialog", () => {
  beforeEach(() => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
    ) as typeof fetch;
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
    const inputs = getInputs();
    fireEvent.change(inputs[1], { target: { value: "short" } });
    fireEvent.change(inputs[2], { target: { value: "short" } });

    const form = getForm()!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(document.body.textContent).toContain("at least 8 characters");
    });
  });

  test("shows error when passwords do not match", async () => {
    renderDialog(true);
    const inputs = getInputs();
    fireEvent.change(inputs[1], { target: { value: "newpassword1" } });
    fireEvent.change(inputs[2], { target: { value: "newpassword2" } });

    const form = getForm()!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(document.body.textContent).toContain("do not match");
    });
  });

  test("shows error when new password equals current password", async () => {
    renderDialog(true);
    const inputs = getInputs();
    // Current password defaults to "atlas-dev"
    fireEvent.change(inputs[1], { target: { value: "atlas-dev" } });
    fireEvent.change(inputs[2], { target: { value: "atlas-dev" } });

    const form = getForm()!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(document.body.textContent).toContain("must be different");
    });
  });

  test("calls fetch and onComplete on successful submit", async () => {
    const onComplete = mock(() => {});
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
    ) as typeof fetch;

    renderDialog(true, onComplete);
    const inputs = getInputs();
    fireEvent.change(inputs[1], { target: { value: "newpassword123" } });
    fireEvent.change(inputs[2], { target: { value: "newpassword123" } });

    const form = getForm()!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledTimes(1);
    });
  });

  test("shows error on API failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ message: "Wrong current password" }), { status: 400 }),
      ),
    ) as typeof fetch;

    renderDialog(true);
    const inputs = getInputs();
    fireEvent.change(inputs[1], { target: { value: "newpassword123" } });
    fireEvent.change(inputs[2], { target: { value: "newpassword123" } });

    const form = getForm()!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(document.body.textContent).toContain("Wrong current password");
    });
  });
});
