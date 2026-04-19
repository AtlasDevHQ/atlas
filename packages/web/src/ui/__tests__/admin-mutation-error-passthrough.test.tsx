import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, waitFor, act, cleanup } from "@testing-library/react";
import { createElement, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AtlasProvider, type AtlasAuthClient } from "../context";
import { useAdminMutation } from "../hooks/use-admin-mutation";
import { AdminContentWrapper } from "../components/admin-content-wrapper";
import type { FetchError } from "../lib/fetch-error";

/**
 * Regression guard for #1595 — asserts the full passthrough from a mutation
 * failure through `MutateResult.error` into `AdminContentWrapper`:
 *
 * - 403 + `{ error: "enterprise_required" }` → renders `EnterpriseUpsell`,
 *   not the generic error banner (requires `error.code` to survive the
 *   hook's catch, which the pre-#1595 string-flattened shape destroyed).
 * - 401/403/404/503 → renders the `friendlyError`-translated copy, not the
 *   raw `HTTP 4xx` status the hook used to emit.
 */

const stubAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null }),
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
      },
      children,
    ),
  );
}

/**
 * Minimal page that mirrors the #1595 acceptance surface: runs one mutation
 * on mount, stores the structured `FetchError`, and feeds it straight to
 * `AdminContentWrapper` so the component's EE/FriendlyError branches execute.
 */
function MutationHarness({ feature }: { feature: string }) {
  const [error, setError] = useState<FetchError | null>(null);
  const [settled, setSettled] = useState(false);
  const { mutate } = useAdminMutation({ path: "/api/v1/admin/test", method: "POST" });

  // Fire once on mount — test drives the fetch mock before rendering.
  if (!settled) {
    setSettled(true);
    mutate().then((result) => {
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

describe("admin mutation error passthrough (#1595)", () => {
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

  test("403 (no enterprise code) renders friendlyError admin-role copy, not 'HTTP 403'", async () => {
    mockFailure(403, { message: "Forbidden" });

    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(<MutationHarness feature="Users" />, { wrapper: Wrapper });
    });

    // AdminContentWrapper routes 403 to <FeatureGate> when a `feature` prop is
    // set — that path also relies on `error.status` surviving, which is the
    // same data the pre-#1595 string flatten erased. Either the FeatureGate
    // access-denied copy or the friendlyError fallback is acceptable; both
    // prove the structured status reached the component.
    await waitFor(() => {
      const text = utils.container.textContent ?? "";
      expect(
        text.includes("Access denied") || text.includes("admin role"),
      ).toBe(true);
    });
    expect(utils.container.textContent).not.toContain("HTTP 403");
  });

  test("401 surfaces friendlyError 'sign in' copy, not 'HTTP 401'", async () => {
    mockFailure(401, { message: "Unauthorized" });

    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(<MutationHarness feature="Audit" />, { wrapper: Wrapper });
    });

    await waitFor(() => {
      const text = utils.container.textContent ?? "";
      expect(
        text.includes("Authentication required") || text.includes("sign in"),
      ).toBe(true);
    });
    expect(utils.container.textContent).not.toContain("HTTP 401");
  });

  test("404 surfaces friendlyError feature-not-enabled copy, not 'HTTP 404'", async () => {
    mockFailure(404, { message: "Not found" });

    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(<MutationHarness feature="Scheduled Tasks" />, { wrapper: Wrapper });
    });

    await waitFor(() => {
      const text = utils.container.textContent ?? "";
      expect(text).toContain("Scheduled Tasks not enabled");
    });
    expect(utils.container.textContent).not.toContain("HTTP 404");
  });

  test("503 surfaces friendlyError service-unavailable copy, not 'HTTP 503'", async () => {
    mockFailure(503, { message: "Unavailable" });

    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(<MutationHarness feature="Custom Domains" />, { wrapper: Wrapper });
    });

    await waitFor(() => {
      const text = utils.container.textContent ?? "";
      expect(text).toContain("Internal database not configured");
    });
    expect(utils.container.textContent).not.toContain("HTTP 503");
  });
});
