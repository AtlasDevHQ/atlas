import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";

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

import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type React from "react";
import { AdminLayout } from "../components/admin/admin-layout";
import { AtlasUIProvider, type AtlasAuthClient } from "../context";

function makeAuthClient(overrides: Partial<AtlasAuthClient> = {}): AtlasAuthClient {
  return {
    signIn: { email: async () => ({}) },
    signUp: { email: async () => ({}) },
    signOut: mockSignOut,
    useSession: () => mockSession,
    ...overrides,
  };
}

function renderLayout(authClient?: AtlasAuthClient) {
  const client = authClient ?? makeAuthClient();
  return render(
    <AtlasUIProvider config={{ apiUrl: "http://localhost:3001", isCrossOrigin: false, authClient: client }}>
      <AdminLayout>
        <div data-testid="child-content">Admin page content</div>
      </AdminLayout>
    </AtlasUIProvider>,
  );
}

const originalFetch = globalThis.fetch;

describe("AdminLayout", () => {
  beforeEach(() => {
    mockSession = { data: null };
    mockSignOut.mockClear();
    // Mock fetch for password-status check
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ passwordChangeRequired: false }), { status: 200 })),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  test("shows loading state when session is pending", () => {
    mockSession = { isPending: true };
    const { container } = renderLayout();
    expect(container.textContent).toContain("Checking authentication");
  });

  test("shows auth card when not signed in", () => {
    mockSession = { data: null };
    const { container } = renderLayout();
    // ManagedAuthCard renders sign-in form
    expect(container.textContent).toContain("Sign in to Atlas");
  });

  test("shows access denied for non-admin users", () => {
    mockSession = { data: { user: { email: "user@test.com", role: "member" } } };
    const { container } = renderLayout();
    expect(container.textContent).toContain("Access Denied");
    expect(container.textContent).toContain("user@test.com");
    expect(container.textContent).toContain("member");
  });

  test("shows sign out button for non-admin users", () => {
    mockSession = { data: { user: { email: "user@test.com", role: "member" } } };
    const { container } = renderLayout();
    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button!.textContent).toContain("Sign out");
  });

  test("calls signOut when sign out button is clicked", () => {
    mockSession = { data: { user: { email: "user@test.com", role: "member" } } };
    const { container } = renderLayout();
    const button = container.querySelector("button")!;
    fireEvent.click(button);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
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
