import { describe, expect, test, mock, afterEach, beforeEach } from "bun:test";

const replaceCalls: string[] = [];
const pushCalls: string[] = [];

void mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: (url: string) => pushCalls.push(url),
    replace: (url: string) => replaceCalls.push(url),
    back: () => {},
  }),
  usePathname: () => "/dashboards",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: () => {},
  notFound: () => {},
}));

import { render, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import DashboardsPage from "../page";
import {
  dashboardsWrapper,
  stubDashboardsFetch,
  stubDashboardsFetchWithCreate,
} from "../../../../ui/components/dashboards/__tests__/_fixtures";

const originalFetch = globalThis.fetch;

/** Stub the dashboards list endpoint with an arbitrary status / body. */
function stubDashboardsStatus(status: number, body: unknown = {}) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    if (url.endsWith("/api/v1/dashboards")) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

describe("DashboardsPage (redirect index)", () => {
  beforeEach(() => {
    replaceCalls.length = 0;
    pushCalls.length = 0;
  });
  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  test("redirects to the most-recently-updated dashboard", async () => {
    stubDashboardsFetch([
      { id: "d-old", title: "Old", updatedAt: "2026-04-24T10:00:00Z", cardCount: 1 },
      { id: "d-new", title: "New", updatedAt: "2026-04-25T10:00:00Z", cardCount: 2 },
    ]);

    render(<DashboardsPage />, { wrapper: dashboardsWrapper });

    await waitFor(() =>
      expect(replaceCalls).toContain("/dashboards/d-new"),
    );
    // AC#1: a logged-in user with dashboards is NEVER bounced to /login.
    expect(replaceCalls).not.toContain("/login?redirect=/dashboards");
  });

  test("renders the empty state when there are no dashboards", async () => {
    stubDashboardsFetch([]);

    render(<DashboardsPage />, { wrapper: dashboardsWrapper });

    await screen.findByText("No dashboards yet");
    // The genuine empty state is NOT a redirect — no navigation should fire.
    expect(replaceCalls).toHaveLength(0);
  });

  // #4563 — surface-native creation: the empty state invites building right
  // here (no "Go to chat" bounce), and creating lands on the new board's
  // canvas with the bound editor open (`?openChat=true`).
  test("the empty state has no 'Go to chat' bounce", async () => {
    stubDashboardsFetch([]);

    render(<DashboardsPage />, { wrapper: dashboardsWrapper });

    await screen.findByText("No dashboards yet");
    expect(screen.queryByText(/Go to chat/i)).toBeNull();
  });

  test("creating from the empty state navigates to the canvas with the bound editor open", async () => {
    stubDashboardsFetchWithCreate([], {
      id: "d-9",
      title: "Fresh",
      updatedAt: "2026-07-16T10:00:00Z",
      cardCount: 0,
    });

    render(<DashboardsPage />, { wrapper: dashboardsWrapper });
    await screen.findByText("No dashboards yet");

    fireEvent.click(
      screen.getByRole("button", { name: /Create your first dashboard/ }),
    );
    const input = await screen.findByPlaceholderText("Dashboard title");
    fireEvent.change(input, { target: { value: "Fresh" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(pushCalls).toContain("/dashboards/d-9?openChat=true"),
    );

    // The redirect-index effect must CONVERGE after the creation handoff: the
    // post-creation list refetch flips `targetId` to the new board, and an
    // un-gated `router.replace("/dashboards/d-9")` would clobber the
    // `?openChat=true` push before the canvas consumed it (the drawer would
    // silently not open — caught live, 2026-07-16). Instead the effect
    // re-issues the same intent-preserving URL — waiting for that converged
    // replace is the deterministic signal that the refetch → effect chain has
    // run, so the bare-URL assertion below can't pass vacuously on a slow box.
    await waitFor(() =>
      expect(replaceCalls).toContain("/dashboards/d-9?openChat=true"),
    );
    expect(replaceCalls).not.toContain("/dashboards/d-9");
  });

  test("bounces an unauthenticated visitor (401) to /login", async () => {
    stubDashboardsStatus(401, { error: "auth_required", message: "Not authenticated" });

    render(<DashboardsPage />, { wrapper: dashboardsWrapper });

    await waitFor(() =>
      expect(replaceCalls).toContain("/login?redirect=/dashboards"),
    );
  });

  // #5188 — these three replace a single test that asserted ALL 403s bounce to
  // /login. That assertion is what shipped the prod loop green: signing in
  // again cannot clear a 403, so the bounce returned the user to the page that
  // 403'd them, every ~5s, with no error and no way forward.
  //
  // 401 keeps the bounce (above). The two 403 shapes below must NOT bounce, and
  // they must not share an outcome either — one has a destination that resolves
  // it, the other has none.

  test("routes an MFA-enrollment 403 to the SERVER's enrollment URL, never to /login", async () => {
    // Deliberately NOT "/admin/account-security". Stubbing the same string the
    // `??` fallback uses makes "used the server's value" and "used the default"
    // indistinguishable — deleting `error.enrollmentUrl ??` would then keep both
    // this test and the fallback test below green, which is the pair they exist
    // to tell apart.
    stubDashboardsStatus(403, {
      error: "mfa_enrollment_required",
      message: "Enroll a second factor to continue.",
      enrollmentUrl: "/admin/account-security?from=dashboards",
    });

    render(<DashboardsPage />, { wrapper: dashboardsWrapper });

    await waitFor(() =>
      expect(replaceCalls).toContain("/admin/account-security?from=dashboards"),
    );
    expect(replaceCalls).not.toContain("/admin/account-security");
    expect(replaceCalls).not.toContain("/login?redirect=/dashboards");
    // On the way out it must show the skeleton, never flash the error card —
    // `isNavigatingAway` is what gates that, and nothing else asserts it.
    expect(screen.queryByText("You don’t have access to dashboards")).toBeNull();
  });

  test("refuses an off-origin enrollment URL and uses the default instead", async () => {
    // `enrollmentUrl` reaches `router.replace()` from a response body.
    // `extractFetchError`'s `sameOriginPath` is what refuses an off-origin
    // value; this asserts the page's end-to-end OUTCOME — the default is used
    // and the hostile URL is never navigated to.
    stubDashboardsStatus(403, {
      error: "mfa_enrollment_required",
      message: "Enroll a second factor to continue.",
      enrollmentUrl: "https://evil.example.com/harvest",
    });

    render(<DashboardsPage />, { wrapper: dashboardsWrapper });

    await waitFor(() =>
      expect(replaceCalls).toContain("/admin/account-security"),
    );
    expect(replaceCalls).not.toContain("https://evil.example.com/harvest");
  });

  test("refuses a protocol-relative enrollment URL", async () => {
    // `//evil.example.com` starts with "/" and is still off-origin — the arm a
    // `startsWith("/")` check alone lets through.
    stubDashboardsStatus(403, {
      error: "mfa_enrollment_required",
      message: "Enroll a second factor to continue.",
      enrollmentUrl: "//evil.example.com/harvest",
    });

    render(<DashboardsPage />, { wrapper: dashboardsWrapper });

    await waitFor(() =>
      expect(replaceCalls).toContain("/admin/account-security"),
    );
    expect(replaceCalls).not.toContain("//evil.example.com/harvest");
  });

  test("falls back to the default enrollment URL when the 403 body omits one", async () => {
    // The body is well-formed today, but `enrollmentUrl` is optional on
    // FetchError — a server that stops sending it must not strand the user on a
    // page whose only recovery path is the URL that went missing.
    stubDashboardsStatus(403, {
      error: "mfa_enrollment_required",
      message: "Enroll a second factor to continue.",
    });

    render(<DashboardsPage />, { wrapper: dashboardsWrapper });

    await waitFor(() =>
      expect(replaceCalls).toContain("/admin/account-security"),
    );
  });

  test("shows an access card for a permission 403 — no navigation, no retry button", async () => {
    stubDashboardsStatus(403, {
      error: "insufficient_permissions",
      message: 'This action requires the "dashboards:read" permission.',
    });

    render(<DashboardsPage />, { wrapper: dashboardsWrapper });

    await screen.findByText("You don’t have access to dashboards");
    // Navigating away is the bug. Staying put with an explanation is the fix.
    expect(replaceCalls).toHaveLength(0);
    // "Try again" cannot resolve a permission answer — offering it is the
    // affordance that made the old dead end feel like a transient failure.
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    // The server's own sentence survives, so the user learns WHICH permission
    // and support gets the requestId `friendlyError` appends.
    await screen.findByText(/dashboards:read/);
  });

  // #5188 round 1 — `GET /api/v1/dashboards` answers 403 for at least four
  // reasons, and only the permission ones are about roles. Collapsing them all
  // into "ask an administrator" reproduces this issue's defect one level down:
  // a user who could fix it themselves is sent to someone else, and the
  // server's remedy is thrown away.
  // ⚠️ The `error` codes below are the WIRE shapes, not the internal names.
  // `authErrorCode` rewrites the auth-gate failures to `auth_error` /
  // `session_expired` before they leave the server, so a fixture built from the
  // internal name (`password_change_required`) tests a body that never occurs.
  // `ip_not_allowed` is minted directly and does reach the client under its own
  // name — the two are not symmetric, which is exactly why they are both here.
  for (const tc of [
    {
      name: "a password-change gate (arrives as auth_error)",
      body: {
        error: "auth_error",
        message:
          "Your password must be changed before continuing. Change it via the web app.",
      },
      expect: /password must be changed/,
    },
    {
      name: "ip_not_allowed",
      body: {
        error: "ip_not_allowed",
        message: "Your IP address is not in the workspace's allowlist.",
      },
      expect: /allowlist/,
    },
  ]) {
    test(`renders the server's own remedy for ${tc.name}`, async () => {
      stubDashboardsStatus(403, tc.body);

      render(<DashboardsPage />, { wrapper: dashboardsWrapper });

      await screen.findByText("Couldn’t load your dashboards");
      await screen.findByText(tc.expect);
      expect(
        screen.queryByText("You don’t have access to dashboards"),
      ).toBeNull();
      expect(replaceCalls).toHaveLength(0);
      // No retry on ANY 403 — none of them are transient, and offering the
      // button is handing the user an action that re-fails identically. This is
      // the arm the first version of the fix got wrong: `ip_not_allowed` is
      // clearable only from an admin-only page, so "Try again" was a dead end
      // wearing the same shape as the loop this issue exists to remove.
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    });
  }

  // #5191 — the one 403 that has an action after all.
  describe("SSO-enforcement 403", () => {
    const SSO_BODY = {
      error: "auth_error",
      message: "Your workspace requires SSO. Sign in with your identity provider.",
      ssoRedirectUrl: "https://idp.example.com/sso/saml",
    };

    test("offers the workspace's identity provider as a link", async () => {
      stubDashboardsStatus(403, SSO_BODY);

      render(<DashboardsPage />, { wrapper: dashboardsWrapper });

      const link = await screen.findByRole("link", {
        name: "Sign in with your identity provider",
      });
      expect(link.getAttribute("href")).toBe("https://idp.example.com/sso/saml");
      // The server's own sentence still renders — the link is an addition, not
      // a replacement for the explanation. Matched on the whole sentence, not
      // on `/identity provider/`: that substring is also in the link's own
      // label, so the loose regex passed by finding the element it was meant
      // to be independent of.
      await screen.findByText(/Your workspace requires SSO\./);
      // And no automatic bounce: leaving the workspace for a third party is
      // the user's click to make.
      expect(replaceCalls).toHaveLength(0);
      expect(pushCalls).toHaveLength(0);
      // Still no "Try again" — this 403 is no more transient than the others.
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    });

    test("refuses a javascript: redirect target", async () => {
      // `externalRedirectUrl` allows an EXTERNAL origin, which is the whole
      // reason it is not `sameOriginPath` — so the protocol allowlist is the
      // only thing standing between it and `javascript:`, and it parses as a
      // perfectly valid absolute URL.
      stubDashboardsStatus(403, {
        ...SSO_BODY,
        ssoRedirectUrl: "javascript:alert(1)",
      });

      render(<DashboardsPage />, { wrapper: dashboardsWrapper });

      await screen.findByText("Couldn’t load your dashboards");
      expect(
        screen.queryByRole("link", { name: "Sign in with your identity provider" }),
      ).toBeNull();
    });

    test("refuses a relative path", async () => {
      // The mirror of the `enrollmentUrl` rule: a RELATIVE value here means the
      // server sent something that is not an IdP, so it is not a destination.
      stubDashboardsStatus(403, { ...SSO_BODY, ssoRedirectUrl: "/admin/settings" });

      render(<DashboardsPage />, { wrapper: dashboardsWrapper });

      await screen.findByText("Couldn’t load your dashboards");
      expect(
        screen.queryByRole("link", { name: "Sign in with your identity provider" }),
      ).toBeNull();
    });

    test("offers no link when the 403 carries no ssoRedirectUrl", async () => {
      // The negative control: without it, a link rendered unconditionally would
      // pass the first test.
      stubDashboardsStatus(403, {
        error: "auth_error",
        message: "Your workspace requires SSO.",
      });

      render(<DashboardsPage />, { wrapper: dashboardsWrapper });

      await screen.findByText("Couldn’t load your dashboards");
      expect(
        screen.queryByRole("link", { name: "Sign in with your identity provider" }),
      ).toBeNull();
    });
  });

  test("shows an error card (not a /login bounce) on a server error", async () => {
    stubDashboardsStatus(500, { message: "Internal error" });

    render(<DashboardsPage />, { wrapper: dashboardsWrapper });

    await screen.findByText("Couldn’t load your dashboards");
    // The server-authored body message reaches the card via friendlyError() —
    // the page renders the real error, not a canned "HTTP 500" fallback.
    await screen.findByText("Internal error");
    expect(replaceCalls).toHaveLength(0);
  });

  test("the error card's Try again button refetches and then redirects", async () => {
    stubDashboardsStatus(500, { message: "Internal error" });

    render(<DashboardsPage />, { wrapper: dashboardsWrapper });
    await screen.findByText("Couldn’t load your dashboards");

    // Recover the endpoint, then click retry — refetch() must re-run the query
    // and the now-successful list redirects to the most-recent dashboard.
    stubDashboardsFetch([
      { id: "d-1", title: "Recovered", updatedAt: "2026-04-25T10:00:00Z", cardCount: 1 },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(replaceCalls).toContain("/dashboards/d-1"));
  });
});
