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
 *      message; the surface disappears entirely. The 5xx-probe path is
 *      tested separately because it lands in the same null-render branch
 *      but via `isError` instead of `denied`.
 *
 * `mock.module(...)` mocks the entire `@/lib/auth/client` surface so a
 * sibling test importing any other export from it doesn't trip a
 * partial-mock SyntaxError.
 */

import { describe, expect, test, mock, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
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

/**
 * Resolve the three password inputs by their stable IDs (assigned in the
 * source: profile-current-password / profile-new-password / profile-confirm-
 * password). Earlier revisions of this file used `querySelectorAll('input
 * [type="password"]')[i]`, which would silently shift indices if a new
 * password-type input ever lands above the three rows — IDs fail loudly
 * with a clear error instead.
 */
function getCurrentInput(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>("#profile-current-password");
  if (!el) throw new Error("current-password input not rendered");
  return el;
}
function getNewInput(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>("#profile-new-password");
  if (!el) throw new Error("new-password input not rendered");
  return el;
}
function getConfirmInput(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>("#profile-confirm-password");
  if (!el) throw new Error("confirm-password input not rendered");
  return el;
}

function getForm(): HTMLFormElement | null {
  return document.querySelector<HTMLFormElement>("form");
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
  fireEvent.change(getCurrentInput(), { target: { value: current } });
  fireEvent.change(getNewInput(), { target: { value: next } });
  fireEvent.change(getConfirmInput(), { target: { value: confirm } });
}

function submit() {
  // act-wrap so synchronous validation paths don't trip the React warning;
  // success/error paths await `waitFor` for the async settle.
  act(() => {
    fireEvent.submit(getForm()!);
  });
}

/** Wait until the form has mounted (probe resolved, allowed branch). */
async function waitForFormMounted(): Promise<void> {
  await waitFor(() => expect(getForm()).not.toBeNull());
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
  statusKind?: "allowed" | "denied" | "mfa-required" | "error-500";
  changeResponse?: () => Response | Promise<Response>;
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
      if (statusKind === "error-500") {
        return new Response("upstream down", { status: 500 });
      }
      return new Response(
        JSON.stringify({
          passwordChangeRequired: false,
          mfaRequired: false,
          enrollmentUrl: "/admin/account-security",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/api/v1/admin/me/password")) {
      return (
        (await changeResponse?.()) ??
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    }
    return new Response("not found", { status: 404 });
  });
}

// Hoist `originalFetch` / `originalWarn` capture to file scope so a thrown
// `mockFetch(...)` constructor can't leave the previous suite's stub
// installed. `afterEach` restores fetch; the warn stub is restored per-test.
const originalFetch = globalThis.fetch;
const originalWarn = console.warn;

beforeAll(() => {
  // Silence the parse-failure log that the non-JSON 500 fallback path
  // emits — keeps the test output focused on assertion failures.
  console.warn = mock(() => {}) as typeof console.warn;
});

afterAll(() => {
  console.warn = originalWarn;
});

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

  test("renders nothing on probe transient failure (5xx → isError → same null branch)", async () => {
    // `usePasswordStatus` is configured with `retry: 1`, so a persistent 500
    // turns the query into `isError: true` after the retry window. The
    // section then short-circuits via `!canChangePassword`. Without this
    // test, a user on a flaky network would see the section vanish with
    // zero indication why — keep the null-on-error branch pinned.
    const fetchMock = mockFetch({ statusKind: "error-500" });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { container } = renderSection();

    await waitFor(
      () => {
        // After retries settle, the form must NOT be rendered.
        expect(getForm()).toBeNull();
      },
      { timeout: 5000 },
    );
    expect(container.textContent).toBe("");
    // Sanity: the probe was actually attempted (otherwise this test would
    // pass with any pre-flight null branch).
    expect(
      (fetchMock as unknown as ReturnType<typeof mock>).mock.calls.length,
    ).toBeGreaterThan(0);
  });

  test("renders the form when allowed", async () => {
    globalThis.fetch = mockFetch({ statusKind: "allowed" }) as unknown as typeof fetch;

    renderSection();

    await waitForFormMounted();
    expect(document.body.textContent).toContain("Password");
    expect(document.body.textContent).toContain(
      "Use a unique password",
    );
  });

  test("renders the form when mfa-required (rotation must still be possible mid-enrollment)", async () => {
    globalThis.fetch = mockFetch({ statusKind: "mfa-required" }) as unknown as typeof fetch;

    renderSection();

    await waitForFormMounted();
  });
});

describe("PasswordSection — cross-field validation order", () => {
  beforeEach(() => {
    globalThis.fetch = mockFetch({ statusKind: "allowed" }) as unknown as typeof fetch;
  });

  test("(a) empty current password short-circuits before any other check", async () => {
    renderSection();
    await waitForFormMounted();

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
    await waitForFormMounted();

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
    await waitForFormMounted();

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
    await waitForFormMounted();

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
  test("POSTs the typed payload, shows confirmation, AND clears the three inputs", async () => {
    const fetchMock = mockFetch({ statusKind: "allowed" });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderSection();
    await waitForFormMounted();

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

    // `reset()` on success — without this, the user's password sits in
    // three plaintext inputs after submit. Pin the field clear so a
    // refactor that drops `reset()` is loud, not silent.
    expect(getCurrentInput().value).toBe("");
    expect(getNewInput().value).toBe("");
    expect(getConfirmInput().value).toBe("");
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
    await waitForFormMounted();

    fill({
      current: "wrong-secret",
      next: "new-secret-123",
      confirm: "new-secret-123",
    });
    submit();

    await waitFor(() => {
      expect(getErrorBannerText()).toContain("Wrong current password");
    });

    // On error the form keeps the user's draft so they can correct just
    // the current-password field without retyping the new one.
    expect(getCurrentInput().value).toBe("wrong-secret");
    expect(getNewInput().value).toBe("new-secret-123");
  });

  test("falls back to a status-code error when the body isn't parseable", async () => {
    globalThis.fetch = mockFetch({
      statusKind: "allowed",
      changeResponse: () => new Response("Internal Server Error", { status: 500 }),
    }) as unknown as typeof fetch;

    renderSection();
    await waitForFormMounted();

    fill({
      current: "old-secret",
      next: "new-secret-123",
      confirm: "new-secret-123",
    });
    submit();

    await waitFor(() => {
      expect(getErrorBannerText()).toContain(
        "Failed to change password (HTTP 500)",
      );
    });
  });

  test("network rejection on submit surfaces as a typed error in the banner", async () => {
    // Pins the `catch` branch in PasswordSection.handleSubmit — without
    // coverage, a future refactor that swaps `setError(message)` for
    // `setError(null)` would silently swallow connectivity errors. Use a
    // changeResponse that rejects to drive that path; the probe still
    // resolves "allowed" so the form is mounted.
    globalThis.fetch = mockFetch({
      statusKind: "allowed",
      changeResponse: async () => {
        throw new Error("net::ERR_CONNECTION_REFUSED");
      },
    }) as unknown as typeof fetch;

    renderSection();
    await waitForFormMounted();

    fill({
      current: "old-secret",
      next: "new-secret-123",
      confirm: "new-secret-123",
    });
    submit();

    await waitFor(() => {
      expect(getErrorBannerText()).toContain("net::ERR_CONNECTION_REFUSED");
    });
  });
});
