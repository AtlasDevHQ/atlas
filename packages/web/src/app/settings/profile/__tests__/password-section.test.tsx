/**
 * Regression guard for `<PasswordSection>` (#2261).
 *
 * PR #2256 (the original `/settings/profile` ship) flagged two coverage gaps.
 * This file pins the password side:
 *
 *   1. The four cross-field validation branches run in a specific order —
 *      empty current → length → mismatch → equals-current. Reordering or
 *      dropping the equals-current check would silently accept a weak
 *      password reuse, so every branch gets its own assertion.
 *
 *   2. When the auth mode probe denies (the simple-key / byot 404 path),
 *      the section renders nothing rather than a form that always 404s on
 *      submit. That's the "friendly error" — no broken form, no scary
 *      message; the surface disappears entirely.
 *
 * `mock.module(...)` mocks the entire `@/lib/auth/client` surface so a
 * sibling test importing any other export from it doesn't trip a
 * partial-mock SyntaxError.
 */

import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

mock.module("@/lib/auth/client", () => ({ authClient: {} }));

import { PasswordSection } from "@/ui/components/settings/password-section";
import { AtlasProvider, type AtlasAuthClient } from "@/ui/context";

const stubAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null, isPending: false }),
};

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(
      AtlasProvider,
      {
        config: {
          apiUrl: "http://localhost:3001",
          isCrossOrigin: false as const,
          authClient: stubAuthClient,
        },
      },
      children,
    ),
  );
}

function renderSection() {
  return render(<PasswordSection />, { wrapper });
}

/** Three password inputs render in source order: current, new, confirm. */
function getInputs() {
  return document.querySelectorAll<HTMLInputElement>('input[type="password"]');
}

function getForm() {
  return document.querySelector("form");
}

function fill({
  current,
  next,
  confirm,
}: {
  current: string;
  next: string;
  confirm: string;
}) {
  const inputs = getInputs();
  fireEvent.change(inputs[0], { target: { value: current } });
  fireEvent.change(inputs[1], { target: { value: next } });
  fireEvent.change(inputs[2], { target: { value: confirm } });
}

function submit() {
  // act-wrap so synchronous validation paths don't trip the React warning;
  // success/error paths await `waitFor` for the async settle.
  act(() => {
    fireEvent.submit(getForm()!);
  });
}

/**
 * Pull the validation banner text. The form's description copy contains
 * phrases like "at least 8 characters" — asserting against the whole body
 * would let a regression that swapped two banners pass. Scope every
 * order-of-rules assertion to `[role="alert"]`.
 */
function getErrorBannerText(): string {
  return document.querySelector('[role="alert"]')?.textContent ?? "";
}

/**
 * Mock fetch with a per-URL routing function. The password-status probe is
 * driven separately from the change-password POST so each test can pin
 * exactly what state PasswordSection is rendering against.
 */
function mockFetch(opts: {
  statusKind?: "allowed" | "denied" | "mfa-required";
  changeResponse?: () => Response;
}): ReturnType<typeof mock> {
  const { statusKind = "allowed", changeResponse } = opts;
  return mock(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/v1/admin/me/password-status")) {
      if (statusKind === "denied") {
        return new Response(JSON.stringify({ error: "forbidden_role" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      if (statusKind === "mfa-required") {
        return new Response(
          JSON.stringify({
            error: "mfa_enrollment_required",
            enrollmentUrl: "/admin/account-security",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ passwordChangeRequired: false }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/api/v1/admin/me/password")) {
      return (
        changeResponse?.() ??
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    }
    return new Response("not found", { status: 404 });
  });
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
});

afterEach(() => {
  queryClient.clear();
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("PasswordSection — auth-mode gating", () => {
  test("renders nothing while the password-status probe is pending (no flash)", () => {
    // A fetch that never resolves keeps the probe in flight forever.
    globalThis.fetch = mock(
      () => new Promise(() => {}),
    ) as unknown as typeof fetch;

    const { container } = renderSection();
    expect(container.textContent).toBe("");
  });

  test("renders nothing on denied (simple-key / byot 404 friendly path)", async () => {
    globalThis.fetch = mockFetch({ statusKind: "denied" }) as unknown as typeof fetch;

    const { container } = renderSection();

    // The probe resolves to `denied`, the section short-circuits to null.
    // No form, no error banner, no scary "Password changes aren't available"
    // copy — the surface simply disappears in this auth mode.
    await waitFor(() => {
      expect(container.textContent).toBe("");
    });
    expect(getForm()).toBeNull();
  });

  test("renders the form when allowed", async () => {
    globalThis.fetch = mockFetch({ statusKind: "allowed" }) as unknown as typeof fetch;

    renderSection();

    await waitFor(() => {
      expect(getInputs().length).toBe(3);
    });
    expect(document.body.textContent).toContain("Password");
    expect(document.body.textContent).toContain(
      "Use a unique password",
    );
  });

  test("renders the form when mfa-required (rotation must still be possible mid-enrollment)", async () => {
    globalThis.fetch = mockFetch({ statusKind: "mfa-required" }) as unknown as typeof fetch;

    renderSection();

    await waitFor(() => {
      expect(getInputs().length).toBe(3);
    });
  });
});

describe("PasswordSection — cross-field validation order", () => {
  beforeEach(() => {
    globalThis.fetch = mockFetch({ statusKind: "allowed" }) as unknown as typeof fetch;
  });

  test("(a) empty current password short-circuits before any other check", async () => {
    renderSection();
    await waitFor(() => expect(getInputs().length).toBe(3));

    // New and confirm intentionally trip other rules — if the order
    // regresses, this test will start asserting on a downstream message.
    fill({ current: "", next: "short", confirm: "different" });
    submit();

    await waitFor(() => {
      expect(getErrorBannerText()).toContain(
        "Enter your current password to confirm.",
      );
    });
    expect(getErrorBannerText()).not.toContain("at least 8");
    expect(getErrorBannerText()).not.toContain("do not match");
  });

  test("(b) new < MIN_PASSWORD is reported before the mismatch / equals-current checks", async () => {
    renderSection();
    await waitFor(() => expect(getInputs().length).toBe(3));

    fill({ current: "old-secret", next: "short", confirm: "mismatch" });
    submit();

    await waitFor(() => {
      expect(getErrorBannerText()).toContain("at least 8 characters");
    });
    expect(getErrorBannerText()).not.toContain("do not match");
    expect(getErrorBannerText()).not.toContain("must be different");
  });

  test("(c) new ≠ confirm is reported before the equals-current check", async () => {
    renderSection();
    await waitFor(() => expect(getInputs().length).toBe(3));

    // If the equals-current rule shadowed the mismatch rule, this case
    // (next === current, but confirm differs) would surface the wrong
    // banner. Pin the mismatch path.
    fill({
      current: "same-as-current-12",
      next: "same-as-current-12",
      confirm: "totally-different-99",
    });
    submit();

    await waitFor(() => {
      expect(getErrorBannerText()).toContain("do not match");
    });
    expect(getErrorBannerText()).not.toContain("must be different");
  });

  test("(d) new === current is rejected (regression guard — dropping this branch silently accepts password reuse)", async () => {
    renderSection();
    await waitFor(() => expect(getInputs().length).toBe(3));

    fill({
      current: "same-secret-12",
      next: "same-secret-12",
      confirm: "same-secret-12",
    });
    submit();

    await waitFor(() => {
      expect(getErrorBannerText()).toContain(
        "must be different from your current one",
      );
    });
  });
});

describe("PasswordSection — submit + error paths", () => {
  test("POSTs to /api/v1/admin/me/password with the typed payload on success", async () => {
    const fetchMock = mockFetch({ statusKind: "allowed" });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderSection();
    await waitFor(() => expect(getInputs().length).toBe(3));

    fill({
      current: "old-secret",
      next: "new-secret-123",
      confirm: "new-secret-123",
    });
    submit();

    await waitFor(() => {
      expect(document.body.textContent).toContain("Password updated.");
    });

    const calls = (fetchMock as unknown as ReturnType<typeof mock>).mock.calls as Array<[
      string,
      RequestInit,
    ]>;
    const postCall = calls.find((c) => c[1]?.method === "POST");
    expect(postCall).toBeDefined();
    expect(postCall![0]).toContain("/api/v1/admin/me/password");
    expect(JSON.parse(postCall![1].body as string)).toEqual({
      currentPassword: "old-secret",
      newPassword: "new-secret-123",
    });
  });

  test("surfaces the API error message on non-ok JSON response", async () => {
    globalThis.fetch = mockFetch({
      statusKind: "allowed",
      changeResponse: () =>
        new Response(JSON.stringify({ message: "Wrong current password" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    }) as unknown as typeof fetch;

    renderSection();
    await waitFor(() => expect(getInputs().length).toBe(3));

    fill({
      current: "wrong-secret",
      next: "new-secret-123",
      confirm: "new-secret-123",
    });
    submit();

    await waitFor(() => {
      expect(document.body.textContent).toContain("Wrong current password");
    });
  });

  test("falls back to a status-code error when the body isn't parseable", async () => {
    const originalWarn = console.warn;
    console.warn = mock(() => {}) as typeof console.warn;
    try {
      globalThis.fetch = mockFetch({
        statusKind: "allowed",
        changeResponse: () => new Response("Internal Server Error", { status: 500 }),
      }) as unknown as typeof fetch;

      renderSection();
      await waitFor(() => expect(getInputs().length).toBe(3));

      fill({
        current: "old-secret",
        next: "new-secret-123",
        confirm: "new-secret-123",
      });
      submit();

      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "Failed to change password (HTTP 500)",
        );
      });
    } finally {
      console.warn = originalWarn;
    }
  });
});
