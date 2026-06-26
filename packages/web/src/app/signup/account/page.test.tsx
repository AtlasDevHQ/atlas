/**
 * Coverage for the signup account step (ADR-0024 §4, #3972).
 *
 * This is the FIRST identity write. On the regional path it is reached after
 * the region step (hard-nav rebuilds the auth client against the regional base);
 * invitees reach it directly from /signup (region skipped) and single-region
 * deploys via the region step's auto-skip. The email comes from the signup
 * draft (it survives the region step's hard reload); a missing draft means a
 * deep link, which bounces back to /signup. These tests pin the draft
 * hydration, the create→navigate path, the OTP interstitial, and the invite
 * routing — the auth client itself is mocked, so they assert orchestration, not
 * which region the network call physically hit (that's the e2e/prod concern).
 *
 * `mock.module(...)` stubs every named export of the modules it touches (repo
 * rule). Shell + OTP form are passthrough/stub so the test exercises this page.
 */

import { describe, expect, test, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { render, fireEvent, waitFor, cleanup, act, screen } from "@testing-library/react";

// ── Mocks ───────────────────────────────────────────────────────────────

const routerReplaceMock = mock((_path: string) => {});
const routerMock = { push: () => {}, replace: routerReplaceMock, back: () => {} };
mock.module("next/navigation", () => ({
  useRouter: () => routerMock,
}));

type SignUpResult = { data?: { token?: string | null } | null; error?: { message?: string } | null };
const signUpEmailMock = mock(async (_opts: { email: string; password: string; name: string }): Promise<SignUpResult> => ({
  data: { token: "tok" },
  error: null,
}));
const signInSocialMock = mock(async (_opts: { provider: string; callbackURL: string }) => ({}));
mock.module("@/lib/auth/client", () => ({
  authClient: {
    signUp: { email: signUpEmailMock },
    signIn: { social: signInSocialMock },
  },
}));

const navigatePostAuthMock = mock((_path: string) => {});
mock.module("@/lib/auth/post-auth-nav", () => ({
  navigatePostAuth: navigatePostAuthMock,
}));

const readDraftMock = mock((): { email: string; invitationId?: string } | null => ({ email: "jane@example.com" }));
const clearDraftMock = mock(() => {});
mock.module("@/lib/signup-draft", () => ({
  readSignupDraft: readDraftMock,
  clearSignupDraft: clearDraftMock,
  saveSignupDraft: () => {},
}));

mock.module("@/ui/components/signup/signup-context-provider", () => ({
  SignupContextProvider: ({ children }: { children: unknown }) => <>{children as never}</>,
  useSignupContext: () => ({ status: "ready", showRegion: true }),
}));

mock.module("@/ui/components/signup/signup-shell", () => ({
  SignupShell: ({ children, back }: { children: unknown; back?: { href: string } }) => (
    <div>
      {back ? <a href={back.href}>Back</a> : null}
      {children as never}
    </div>
  ),
}));

mock.module("@/ui/components/auth/verify-email-otp-form", () => ({
  VerifyEmailOTPForm: ({ onVerified }: { onVerified: () => void }) => (
    <button type="button" onClick={onVerified}>verify-code</button>
  ),
}));

// social-providers probe — configurable per test (default none → no buttons).
let socialProviders: string[] = [];
const fetchMock = mock(async (): Promise<Response> =>
  new Response(JSON.stringify({ providers: socialProviders }), { status: 200, headers: { "content-type": "application/json" } }),
);
const originalFetch = globalThis.fetch;
globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

import AccountPage from "./page";

function fillPassword(value: string) {
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value } });
}

beforeEach(() => {
  routerReplaceMock.mockReset();
  signUpEmailMock.mockReset();
  signUpEmailMock.mockImplementation(async () => ({ data: { token: "tok" }, error: null }));
  signInSocialMock.mockReset();
  navigatePostAuthMock.mockReset();
  readDraftMock.mockReset();
  readDraftMock.mockImplementation(() => ({ email: "jane@example.com" }));
  clearDraftMock.mockReset();
  fetchMock.mockClear();
  socialProviders = [];
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("AccountPage — draft hydration (#3972)", () => {
  test("a missing signup draft bounces back to /signup (no deep-linking past email)", async () => {
    readDraftMock.mockImplementation(() => null);
    render(<AccountPage />);
    await waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith("/signup");
    });
  });

  test("renders the draft email so the user knows which account they're creating", async () => {
    render(<AccountPage />);
    await waitFor(() => {
      expect(screen.getByText("jane@example.com")).toBeDefined();
    });
  });

  test("Back goes to the region step for a fresh signup (residency configured)", async () => {
    // useSignupContext mock reports showRegion: true; a non-invitee passed
    // through the region step, so Back returns there.
    render(<AccountPage />);
    await screen.findByText("jane@example.com");
    const back = screen.getByRole("link", { name: /back/i }) as HTMLAnchorElement;
    expect(back.getAttribute("href")).toBe("/signup/region");
  });

  test("Back goes to /signup for an invitee even on a multi-region deploy (region skipped)", async () => {
    readDraftMock.mockImplementation(() => ({ email: "teammate@acme.com", invitationId: "inv-9" }));
    render(<AccountPage />);
    await screen.findByText("teammate@acme.com");
    const back = screen.getByRole("link", { name: /back/i }) as HTMLAnchorElement;
    expect(back.getAttribute("href")).toBe("/signup");
  });
});

describe("AccountPage — create account on the regional client (#3972)", () => {
  test("submitting creates the account for the draft email, clears the draft, and hard-navigates to workspace", async () => {
    render(<AccountPage />);
    await screen.findByText("jane@example.com");

    fillPassword("hunter2hunter2");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    });

    await waitFor(() => {
      expect(signUpEmailMock).toHaveBeenCalledTimes(1);
    });
    const arg = signUpEmailMock.mock.calls[0][0];
    expect(arg.email).toBe("jane@example.com");
    expect(arg.password).toBe("hunter2hunter2");
    expect(clearDraftMock).toHaveBeenCalled();
    expect(navigatePostAuthMock).toHaveBeenCalledWith("/signup/workspace");
  });

  test("verification-required (no token) shows the OTP interstitial; verifying then navigates", async () => {
    signUpEmailMock.mockImplementation(async () => ({ data: { token: null }, error: null }));
    render(<AccountPage />);
    await screen.findByText("jane@example.com");

    fillPassword("hunter2hunter2");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/enter your code/i)).toBeDefined();
    });
    // Not navigated yet — waiting on the code.
    expect(navigatePostAuthMock).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /verify-code/i }));
    });
    expect(navigatePostAuthMock).toHaveBeenCalledWith("/signup/workspace");
  });

  test("an invitee is routed to /accept-invitation after creating the account", async () => {
    readDraftMock.mockImplementation(() => ({ email: "teammate@acme.com", invitationId: "inv-9" }));
    render(<AccountPage />);
    await screen.findByText("teammate@acme.com");

    fillPassword("hunter2hunter2");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    });

    await waitFor(() => {
      expect(navigatePostAuthMock).toHaveBeenCalledWith("/accept-invitation/inv-9");
    });
  });

  test("a signup error is surfaced and does NOT navigate or clear the draft", async () => {
    signUpEmailMock.mockImplementation(async () => ({ data: null, error: { message: "Email already in use" } }));
    render(<AccountPage />);
    await screen.findByText("jane@example.com");

    fillPassword("hunter2hunter2");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    });

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("Email already in use");
    });
    expect(navigatePostAuthMock).not.toHaveBeenCalled();
    expect(clearDraftMock).not.toHaveBeenCalled();
  });

  test("a network failure shows the connection-specific message", async () => {
    signUpEmailMock.mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });
    render(<AccountPage />);
    await screen.findByText("jane@example.com");

    fillPassword("hunter2hunter2");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    });

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/unable to reach the server/i);
    });
    expect(navigatePostAuthMock).not.toHaveBeenCalled();
  });
});

describe("AccountPage — social sign-in runs post-region (#3972)", () => {
  test("clicking a social provider clears the draft and signs in with the workspace callback", async () => {
    socialProviders = ["google"];
    render(<AccountPage />);
    await screen.findByText("jane@example.com");

    const googleBtn = await screen.findByRole("button", { name: /continue with google/i });
    await act(async () => {
      fireEvent.click(googleBtn);
    });

    await waitFor(() => {
      expect(signInSocialMock).toHaveBeenCalledTimes(1);
    });
    expect(signInSocialMock.mock.calls[0][0]).toEqual({ provider: "google", callbackURL: "/signup/workspace" });
    // Draft cleared before handing off to the provider redirect.
    expect(clearDraftMock).toHaveBeenCalled();
  });

  test("an invitee's social sign-in carries the accept-invitation callback", async () => {
    socialProviders = ["google"];
    readDraftMock.mockImplementation(() => ({ email: "teammate@acme.com", invitationId: "inv-9" }));
    render(<AccountPage />);
    await screen.findByText("teammate@acme.com");

    const googleBtn = await screen.findByRole("button", { name: /continue with google/i });
    await act(async () => {
      fireEvent.click(googleBtn);
    });

    await waitFor(() => {
      expect(signInSocialMock.mock.calls[0][0]).toEqual({ provider: "google", callbackURL: "/accept-invitation/inv-9" });
    });
  });
});
