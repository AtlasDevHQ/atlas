import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import React from "react";

// Track the session value returned by useSession
let mockSession: {
  data?: { user?: { email?: string; role?: string } } | null;
  isPending?: boolean;
} = { data: null };
const mockSignOut = mock(() => Promise.resolve());

// Mock next/navigation — `mockPathname` is mutable so a single test can
// simulate landing on `/admin/account-security` (the MFA-gate exempt
// route) without re-mocking the module per test.
let mockPathname = "/admin";
mock.module("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: () => {},
  notFound: () => {},
}));

// Mock next/link
mock.module("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

// Mock shadcn sidebar — complex component with deep dependency chain (radix-ui, hooks, etc.)
mock.module("@/components/ui/sidebar", () => {

  return {
    SidebarProvider: ({ children }: { children: React.ReactNode }) => React.createElement("div", { "data-testid": "sidebar-provider" }, children),
    SidebarInset: ({ children }: { children: React.ReactNode }) => React.createElement("main", null, children),
    SidebarTrigger: () => React.createElement("button", { "data-testid": "sidebar-trigger" }),
    Sidebar: ({ children }: { children: React.ReactNode }) => React.createElement("nav", null, children),
    SidebarContent: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
    SidebarFooter: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
    SidebarHeader: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
    SidebarGroup: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
    SidebarGroupLabel: ({ children }: { children: React.ReactNode }) => React.createElement("span", null, children),
    SidebarGroupContent: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
    SidebarMenu: ({ children }: { children: React.ReactNode }) => React.createElement("ul", null, children),
    SidebarMenuItem: ({ children }: { children: React.ReactNode }) => React.createElement("li", null, children),
    SidebarMenuButton: ({ children }: { children: React.ReactNode }) => React.createElement("button", null, children),
    SidebarMenuBadge: ({ children }: { children: React.ReactNode }) => React.createElement("span", null, children),
    SidebarRail: () => React.createElement("div"),
    useSidebar: () => ({ open: true, setOpen: () => {}, toggleSidebar: () => {}, isMobile: false, state: "expanded" }),
  };
});

// Mock shadcn separator
mock.module("@/components/ui/separator", () => {

  return { Separator: () => React.createElement("hr") };
});

// Mock useBranding — no custom branding by default
mock.module("@/ui/hooks/use-branding", () => ({
  useBranding: () => ({ branding: null, loading: false }),
}));

import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AdminLayout } from "../components/admin/admin-layout";
import { AtlasProvider, type AtlasAuthClient } from "../context";

function makeAuthClient(overrides: Partial<AtlasAuthClient> = {}): AtlasAuthClient {
  return {
    signIn: { email: async () => ({}) },
    signUp: { email: async () => ({}) },
    signOut: mockSignOut,
    useSession: () => mockSession,
    ...overrides,
  };
}

let testQueryClient: QueryClient;

function renderLayout(authClient?: AtlasAuthClient) {
  const client = authClient ?? makeAuthClient();
  return render(
    <QueryClientProvider client={testQueryClient}>
      <AtlasProvider config={{ apiUrl: "http://localhost:3001", isCrossOrigin: false, authClient: client }}>
        <AdminLayout>
          <div data-testid="child-content">Admin page content</div>
        </AdminLayout>
      </AtlasProvider>
    </QueryClientProvider>,
  );
}

const originalFetch = globalThis.fetch;

/** Mock fetch that returns 200 with password-status (admin allowed). */
function mockAdminFetch() {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          passwordChangeRequired: false,
          mfaRequired: false,
          enrollmentUrl: "/admin/account-security",
        }),
        { status: 200 },
      ),
    ),
  ) as unknown as typeof fetch;
}

/**
 * #2486 — primary path. 200 response carries `mfaRequired: true` so the
 * admin layout blocks the entire admin tree without depending on a child
 * page's incidental fetch landing on a `mfaRequired`-gated endpoint.
 */
function mockMfaRequired200Fetch() {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          passwordChangeRequired: false,
          mfaRequired: true,
          enrollmentUrl: "/admin/account-security",
        }),
        { status: 200 },
      ),
    ),
  ) as unknown as typeof fetch;
}

/** Mock fetch that returns 403 (admin denied). */
function mockDeniedFetch() {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ error: "forbidden_role" }), { status: 403 })),
  ) as unknown as typeof fetch;
}

/** Mock fetch that returns 403 with `mfa_enrollment_required` body. */
function mockMfaRequiredFetch() {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          error: "mfa_enrollment_required",
          message: "Two-factor authentication is required for admin accounts.",
          enrollmentUrl: "/admin/account-security",
        }),
        { status: 403 },
      ),
    ),
  ) as unknown as typeof fetch;
}

describe("AdminLayout", () => {
  beforeEach(() => {
    testQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    mockSession = { data: null };
    mockPathname = "/admin";
    mockSignOut.mockClear();
    mockAdminFetch();
  });

  afterEach(() => {
    testQueryClient.clear();
    cleanup();
    globalThis.fetch = originalFetch;
  });

  test("shows loading state when session is pending", () => {
    mockSession = { isPending: true };
    const { container } = renderLayout();
    expect(container.textContent).toContain("Checking access");
  });

  test("shows loading when not signed in (proxy handles redirect)", () => {
    mockSession = { data: null };
    const { container } = renderLayout();
    expect(container.textContent).toContain("Checking access");
  });

  test("shows access denied for non-admin users", async () => {
    mockDeniedFetch();
    mockSession = { data: { user: { email: "user@test.com", role: "member" } } };
    const { container } = renderLayout();
    await waitFor(() => {
      expect(container.textContent).toContain("Access denied");
    });
    expect(container.textContent).toContain("admin console requires the admin role");
  });

  test("shows sign-in-as-different-user button for non-admin users", async () => {
    mockDeniedFetch();
    mockSession = { data: { user: { email: "user@test.com", role: "member" } } };
    const { container } = renderLayout();
    await waitFor(() => {
      const button = container.querySelector("button");
      expect(button).not.toBeNull();
      expect(button!.textContent).toContain("Sign in as a different user");
    });
  });

  test("calls signOut when sign-in-as-different-user button is clicked", async () => {
    mockDeniedFetch();
    // Stub window.location.assign to prevent navigation errors in test
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      value: { ...originalLocation, assign: () => {} },
      writable: true,
      configurable: true,
    });
    mockSession = { data: { user: { email: "user@test.com", role: "member" } } };
    const { getByText } = renderLayout();
    await waitFor(() => {
      getByText("Sign in as a different user");
    });
    fireEvent.click(getByText("Sign in as a different user"));
    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalledTimes(1);
    });
    Object.defineProperty(window, "location", { value: originalLocation, writable: true, configurable: true });
  });

  test("renders children for admin users", async () => {
    mockSession = { data: { user: { email: "admin@test.com", role: "admin" } } };
    const { container } = renderLayout();
    await waitFor(() => {
      expect(container.textContent).toContain("Admin page content");
    });
  });

  test("renders Admin Console header for admin users", async () => {
    mockSession = { data: { user: { email: "admin@test.com", role: "admin" } } };
    const { container } = renderLayout();
    await waitFor(() => {
      expect(container.textContent).toContain("Admin Console");
    });
  });

  test("does NOT show 'Access denied' Card on mfa_enrollment_required", async () => {
    // Regression guard for #2081 — the broken behavior was that any 403
    // routed to the "Access denied. Admin role required." Card. The
    // discriminated `usePasswordStatus` result keeps the Card in front of
    // genuine role failures only; missing-second-factor 403s fall through
    // to the gate-all path (#2486) where the full-screen gate + dialog
    // render together.
    mockMfaRequiredFetch();
    mockSession = { data: { user: { email: "admin@test.com", role: "admin" } } };
    const { container } = renderLayout();
    await waitFor(() => {
      expect(container.textContent).toContain("Admin Console");
    });
    expect(container.textContent).not.toContain("admin console requires the admin role");
  });

  test("opens MFA enrollment dialog on mfa_enrollment_required", async () => {
    mockMfaRequiredFetch();
    mockSession = { data: { user: { email: "admin@test.com", role: "admin" } } };
    renderLayout();
    await waitFor(() => {
      expect(document.body.textContent).toContain("Two-factor authentication required");
    });
    expect(document.body.textContent).toContain("Set up second factor");
  });

  // #2486 — gate-all behavior. The three tests below cover:
  //   1. 200 body `mfaRequired:true` is the primary signal (no 403 needed).
  //   2. Page content is replaced by the gate placeholder.
  //   3. /admin/account-security is exempt so the user can complete setup.

  test("blocks admin tree with full-screen gate when mfaRequired:true in 200 body", async () => {
    mockMfaRequired200Fetch();
    mockSession = { data: { user: { email: "admin@test.com", role: "admin" } } };
    const { container, queryByTestId, queryByText } = renderLayout();
    await waitFor(() => {
      expect(queryByTestId("mfa-required-gate")).not.toBeNull();
    });
    // The child page content must NOT render — that's the gate-all promise.
    expect(queryByText("Admin page content")).toBeNull();
    // Sidebar / top bar stay mounted so the user has navigation context.
    expect(container.textContent).toContain("Admin Console");
    expect(container.textContent).toContain("Two-factor required");
  });

  test("renders enrollment page normally pre-MFA (exempt route)", async () => {
    mockPathname = "/admin/account-security";
    // Spy on fetch so we can assert the password-status round-trip actually
    // resolved as mfa-required — without this, the test could pass for the
    // wrong reason (e.g. a future "skip the fetch on exempt routes"
    // optimization would silently pass without ever exercising the
    // exempt-path branch). The assertion below proves we reached the
    // `mfa-required` discriminant AND the layout chose not to render the
    // gate because the pathname is exempt.
    const fetchSpy = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            passwordChangeRequired: false,
            mfaRequired: true,
            enrollmentUrl: "/admin/account-security",
          }),
          { status: 200 },
        ),
      ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    mockSession = { data: { user: { email: "admin@test.com", role: "admin" } } };
    const { queryByTestId, queryByText } = renderLayout();
    await waitFor(() => {
      // The exempt route must render its own content, not the gate.
      expect(queryByText("Admin page content")).not.toBeNull();
    });
    expect(queryByTestId("mfa-required-gate")).toBeNull();
    // Prove the password-status fetch was consumed (no silent skip).
    expect(fetchSpy).toHaveBeenCalled();
    const calledWith = (fetchSpy.mock.calls as unknown[][])[0]?.[0];
    expect(String(calledWith)).toContain("/api/v1/admin/me/password-status");
  });

  // #2486 — concurrent-load race regression guard. When the session
  // resolves BEFORE the password-status fetch, the prior loading guard
  // skipped the LoadingState (because `!session.data?.user` was false) and
  // briefly rendered the page's children before the gate could fire. With
  // the fix, `adminCheck === "pending"` always renders LoadingState so the
  // children never flash pre-gate.
  test("does NOT flash children while password-status is in-flight", async () => {
    // Hold the fetch open so adminCheck stays "pending" for the assertion.
    let resolveFetch!: (res: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    globalThis.fetch = mock(() => pendingFetch) as unknown as typeof fetch;
    mockSession = { data: { user: { email: "admin@test.com", role: "admin" } } };
    const { container, queryByText } = renderLayout();

    // Session is resolved but password-status is still pending — must
    // render the LoadingState, NOT children, NOT the gate.
    await waitFor(() => {
      expect(container.textContent).toContain("Checking access");
    });
    expect(queryByText("Admin page content")).toBeNull();

    // Cleanup — resolve the held fetch so the test doesn't leak a pending
    // promise into the next test's QueryClient.
    resolveFetch(
      new Response(
        JSON.stringify({
          passwordChangeRequired: false,
          mfaRequired: false,
          enrollmentUrl: "/admin/account-security",
        }),
        { status: 200 },
      ),
    );
  });

  test("gate placeholder links to enrollment URL from the server", async () => {
    mockMfaRequired200Fetch();
    mockSession = { data: { user: { email: "admin@test.com", role: "admin" } } };
    const { container } = renderLayout();
    await waitFor(() => {
      expect(container.querySelector('[data-testid="mfa-required-gate"]')).not.toBeNull();
    });
    const link = container.querySelector('[data-testid="mfa-required-gate"] a');
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("/admin/account-security");
  });

  test("shows password change dialog when required", async () => {
    mockSession = { data: { user: { email: "admin@test.com", role: "admin" } } };
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            passwordChangeRequired: true,
            mfaRequired: false,
            enrollmentUrl: "/admin/account-security",
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;
    renderLayout();
    await waitFor(() => {
      expect(document.body.textContent).toContain("Change your password");
    });
  });
});
