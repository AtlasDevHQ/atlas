import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import React from "react";

// Track the session value returned by useSession
let mockSession: {
  data?: { user?: { email?: string; role?: string } } | null;
  isPending?: boolean;
} = { data: null };
const mockSignOut = mock(() => Promise.resolve());

// Mock next/navigation
mock.module("next/navigation", () => ({
  usePathname: () => "/admin",
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
    Promise.resolve(new Response(JSON.stringify({ passwordChangeRequired: false }), { status: 200 })),
  ) as unknown as typeof fetch;
}

/** Mock fetch that returns 403 (admin denied). */
function mockDeniedFetch() {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ error: "forbidden_role" }), { status: 403 })),
  ) as unknown as typeof fetch;
}

describe("AdminLayout", () => {
  beforeEach(() => {
    testQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    mockSession = { data: null };
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

  test("shows password change dialog when required", async () => {
    mockSession = { data: { user: { email: "admin@test.com", role: "admin" } } };
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ passwordChangeRequired: true }), { status: 200 })),
    ) as unknown as typeof fetch;
    renderLayout();
    await waitFor(() => {
      expect(document.body.textContent).toContain("Change your password");
    });
  });
});
