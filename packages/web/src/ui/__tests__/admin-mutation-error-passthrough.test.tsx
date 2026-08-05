import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, waitFor, act, cleanup } from "@testing-library/react";
import { createElement, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AtlasProvider, type AtlasAuthClient } from "../context";
import { useAdminMutation } from "../hooks/use-admin-mutation";
import { AdminContentWrapper } from "../components/admin-content-wrapper";
import type { FeatureName } from "../components/admin/feature-registry";
import type { FetchError } from "../lib/fetch-error";

/**
 * Asserts `MutateResult.error` preserves the structured `FetchError` shape
 * end-to-end so `AdminContentWrapper` can:
 *
 * - Render `EnterpriseUpsell` on 403 + `{ error: "enterprise_required" }`
 *   (requires `error.code` to survive the hook's catch).
 * - Render the `friendlyError`-translated copy on 401/403/404/503 (requires
 *   `error.status` to survive), not the raw `HTTP 4xx` string.
 *
 * Since #5068 the gated statuses carry two more fields the wrapper must
 * forward: the server's own `message` and the `requestId`. The bodies below
 * are the envelopes the API actually emits (`middleware.ts`,
 * `admin-router.ts`) rather than invented one-word strings — a fixture whose
 * message reads "Forbidden" cannot distinguish "the server's words reached
 * the screen" from "the canned copy did", because neither contains it.
 */

const stubAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null, isPending: false }),
};

let testQueryClient: QueryClient;

function Wrapper({ children }: { children: ReactNode }) {
  return createElement(
    QueryClientProvider,
    { client: testQueryClient },
    createElement(
      AtlasProvider,
      {
        config: {
          apiUrl: "http://localhost:3001",
          isCrossOrigin: false as const,
          authClient: stubAuthClient,
        },
        children,
      },
    ),
  );
}

/**
 * Minimal page that mirrors the #1595 acceptance surface: runs one mutation
 * on mount, stores the structured `FetchError`, and feeds it straight to
 * `AdminContentWrapper` so the component's EE/FriendlyError branches execute.
 */
function MutationHarness({ feature }: { feature: FeatureName }) {
  const [error, setError] = useState<FetchError | null>(null);
  const [settled, setSettled] = useState(false);
  const { mutate } = useAdminMutation({ path: "/api/v1/admin/test", method: "POST" });

  // Test arms the fetch mock before rendering; first render kicks off the
  // mutation so each case observes a single deterministic outcome.
  if (!settled) {
    setSettled(true);
    void mutate().then((result) => {
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <AdminContentWrapper loading={false} error={error} feature={feature}>
      <div>children</div>
    </AdminContentWrapper>
  );
}

const originalFetch = globalThis.fetch;

function mockFailure(status: number, body: Record<string, unknown>) {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  ) as unknown as typeof fetch;
}

describe("admin mutation error passthrough", () => {
  beforeEach(() => {
    testQueryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });
  });

  afterEach(() => {
    testQueryClient.clear();
    cleanup();
    globalThis.fetch = originalFetch;
  });

  test("403 + enterprise_required renders EnterpriseUpsell, not the generic banner", async () => {
    mockFailure(403, {
      message: "Enterprise features required",
      error: "enterprise_required",
      requestId: "req-ee-123",
    });

    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(<MutationHarness feature="SSO" />, { wrapper: Wrapper });
    });

    await waitFor(() => {
      expect(utils.container.textContent).toContain("SSO requires an enterprise plan");
    });
    // Must not fall through to the generic banner copy.
    expect(utils.container.textContent).not.toContain("Request failed");
    expect(utils.container.textContent).not.toContain("HTTP 403");
  });

  test("403 + mfa_enrollment_required renders MfaRequiredPlaceholder, not 'admin role' copy (#2486)", async () => {
    mockFailure(403, {
      message: "Two-factor authentication is required for admin accounts.",
      error: "mfa_enrollment_required",
      enrollmentUrl: "/admin/account-security",
      requestId: "req-mfa-123",
    });

    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(<MutationHarness feature="AI Provider" />, { wrapper: Wrapper });
    });

    await waitFor(() => {
      expect(utils.container.textContent).toContain("Two-factor required");
    });
    // Regression guard (#2486): on a 403 with `code:"mfa_enrollment_required"`,
    // the MFA-required branch must take precedence over the generic
    // role-denied copy ("You need the admin role to access this page.") —
    // same FetchError shape, different user-facing message.
    expect(utils.container.textContent).not.toContain("admin role");
    expect(utils.container.textContent).not.toContain("Access denied");
    expect(utils.container.textContent).not.toContain("HTTP 403");
    // The copy stays fixed here on purpose — the enrollment CTA is the value,
    // not the server's generic two-factor sentence — so #5068's "prefer the
    // server's words" deliberately does not apply. The correlation id is not
    // copy though: an admin who HAS enrolled and still lands here needs
    // something to hand an operator.
    expect(utils.container.textContent).not.toContain(
      "Two-factor authentication is required for admin accounts.",
    );
    expect(utils.container.textContent).toContain("req-mfa-123");
  });

  test("403 (no enterprise code) renders the server's role message, not 'HTTP 403'", async () => {
    // `middleware.ts` sends "Platform admin role required." for the platform
    // routers — the exact case the canned copy ("You need the admin role")
    // gets WRONG, by naming a role that would not have unlocked the page.
    mockFailure(403, {
      error: "forbidden_role",
      message: "Platform admin role required.",
      requestId: "req-403-abc",
    });

    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(<MutationHarness feature="Users" />, { wrapper: Wrapper });
    });

    // The status-derived headline proves `error.status` survived the hook's
    // catch; the description proves the server's own sentence did.
    await waitFor(() => {
      expect(utils.container.textContent).toContain("Access denied");
    });
    expect(utils.container.textContent).toContain("Platform admin role required.");
    // The role the server did NOT ask for. Before #5068 this line was the
    // whole description, on a refusal only a platform admin could clear.
    expect(utils.container.textContent).not.toContain(
      "You need the admin role to access this page.",
    );
    expect(utils.container.textContent).toContain("req-403-abc");
    expect(utils.container.textContent).not.toContain("HTTP 403");
  });

  test("401 surfaces the server's message, not 'HTTP 401'", async () => {
    mockFailure(401, {
      error: "auth_error",
      message: "Your session expired. Sign in again to continue.",
      requestId: "req-401-abc",
    });

    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(<MutationHarness feature="Audit Log" />, { wrapper: Wrapper });
    });

    await waitFor(() => {
      expect(utils.container.textContent).toContain("Authentication required");
    });
    expect(utils.container.textContent).toContain(
      "Your session expired. Sign in again to continue.",
    );
    // 401 alone appends rather than displaces — the sign-in affordance is
    // true whatever the server said, so losing it would leave an accurate
    // diagnosis with no next step.
    expect(utils.container.textContent).toContain(
      "Please sign in to access the admin console.",
    );
    expect(utils.container.textContent).toContain("req-401-abc");
    expect(utils.container.textContent).not.toContain("HTTP 401");
  });

  test("404 surfaces the server's message, not 'HTTP 404'", async () => {
    // `requireOrgContext()`'s NO_INTERNAL_DB_MESSAGE — the motivating case in
    // #5068. The self-hosted operator on /admin/brain used to be told only to
    // "enable this feature in your server configuration", which names nothing.
    mockFailure(404, {
      error: "not_available",
      message: "No internal database configured.",
      requestId: "req-404-abc",
    });

    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(<MutationHarness feature="Scheduled Tasks" />, { wrapper: Wrapper });
    });

    await waitFor(() => {
      expect(utils.container.textContent).toContain("Scheduled Tasks not enabled");
    });
    expect(utils.container.textContent).toContain("No internal database configured.");
    expect(utils.container.textContent).not.toContain(
      "Enable this feature in your server configuration",
    );
    expect(utils.container.textContent).toContain("req-404-abc");
    expect(utils.container.textContent).not.toContain("HTTP 404");
  });

  test("503 surfaces the server's message and drops the database guess with it", async () => {
    // `permissions_unavailable` (admin-router.ts) is a 503 that has nothing to
    // do with DATABASE_URL. Rendering it under "Internal database not
    // configured" sent an operator to check a variable that was already set,
    // so the headline gives way alongside the description.
    mockFailure(503, {
      error: "permissions_unavailable",
      message:
        "Authorization service is temporarily unavailable. Retry in a moment; if this persists, contact an operator.",
      requestId: "req-503-abc",
    });

    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(<MutationHarness feature="Custom Domains" />, { wrapper: Wrapper });
    });

    await waitFor(() => {
      expect(utils.container.textContent).toContain("Authorization service is temporarily unavailable");
    });
    expect(utils.container.textContent).toContain("Custom Domains is unavailable");
    expect(utils.container.textContent).not.toContain("Internal database not configured");
    expect(utils.container.textContent).not.toContain("DATABASE_URL");
    expect(utils.container.textContent).toContain("req-503-abc");
    expect(utils.container.textContent).not.toContain("HTTP 503");
  });

  test("an EMPTY gated body keeps the canned copy and never renders the placeholder", async () => {
    // The complement of every arm above, and the one that makes them mean
    // something: `extractFetchError` substitutes `HTTP {status}` when the body
    // carries no message, so a wrapper that forwarded `error.message` instead
    // of `serverMessage(error)` would pass all four — and replace the gate's
    // only guidance with a status echo exactly here.
    mockFailure(404, {});

    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(<MutationHarness feature="Scheduled Tasks" />, { wrapper: Wrapper });
    });

    await waitFor(() => {
      expect(utils.container.textContent).toContain("Scheduled Tasks not enabled");
    });
    expect(utils.container.textContent).toContain(
      "Enable this feature in your server configuration to use this page.",
    );
    expect(utils.container.textContent).not.toContain("HTTP 404");
    // No id in the body, so no id line — an empty "Request ID:" label would
    // be worse than none.
    expect(utils.container.textContent).not.toContain("Request ID");
  });

  test("an EMPTY enterprise_required body keeps the upsell's own copy", async () => {
    // Same placeholder hazard on the sibling surface: `EnterpriseUpsell` also
    // renders its `message` prop verbatim as the description.
    mockFailure(403, { error: "enterprise_required" });

    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(<MutationHarness feature="SSO" />, { wrapper: Wrapper });
    });

    await waitFor(() => {
      expect(utils.container.textContent).toContain("SSO requires an enterprise plan");
    });
    expect(utils.container.textContent).toContain("contact sales");
    expect(utils.container.textContent).not.toContain("HTTP 403");
  });
});
