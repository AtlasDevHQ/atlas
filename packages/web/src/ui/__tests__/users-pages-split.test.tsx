/**
 * Smoke tests for the /admin/users + /platform/users split (#PR4).
 *
 * Pins the URL-vs-role contract so a future refactor can't accidentally
 * re-conflate the two surfaces:
 *
 *   - Workspace admin landing on `/admin/users` renders the page (UsersPage
 *     mounts; no router.replace fires).
 *   - Platform admin landing on `/admin/users` is redirected to
 *     `/platform/users` so the URL matches the data they're operating on.
 *   - `/platform/users` short-circuits to null when the platform-admin
 *     guard is blocked (non-platform-admin walking up to the URL gets
 *     the redirect-shim from `usePlatformAdminGuard`).
 *   - `/platform/users` renders the page when the guard passes.
 */

import { describe, expect, test, mock, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/next/app";

let mockUserRole: "admin" | "platform_admin" | null = "admin";
let mockGuardBlocked = false;
const mockReplace = mock(() => {});

mock.module("next/navigation", () => ({
  usePathname: () => "/admin/users",
  useRouter: () => ({ push: () => {}, replace: mockReplace, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

mock.module("@/ui/hooks/use-platform-admin-guard", () => ({
  useUserRole: () => mockUserRole,
  usePlatformAdminGuard: () => ({ blocked: mockGuardBlocked }),
}));

// Stub everything the inner UsersPage tries to render so the smoke tests
// stay focused on the routing/scoping shell.
mock.module("@/ui/context", () => ({
  useAtlasConfig: () => ({ apiUrl: "http://localhost", isCrossOrigin: false }),
}));
mock.module("@/ui/hooks/use-admin-fetch", () => ({
  useAdminFetch: () => ({ data: null, loading: false, error: null, refetch: () => {} }),
  useInProgressSet: () => ({ has: () => false, add: () => {}, remove: () => {} }),
  friendlyError: (err: { message?: string }) => err?.message ?? "error",
}));
mock.module("@/ui/hooks/use-admin-mutation", () => ({
  useAdminMutation: () => ({
    mutate: async () => ({ ok: true }),
    saving: false,
    error: null,
    clearError: () => {},
    reset: () => {},
  }),
}));

const AdminUsersPage = (await import("../../app/admin/users/page")).default;
const PlatformUsersPage = (await import("../../app/platform/users/page")).default;

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(NuqsAdapter, null, createElement(QueryClientProvider, { client }, children));
}

afterEach(() => {
  cleanup();
  mockReplace.mockClear();
  mockUserRole = "admin";
  mockGuardBlocked = false;
});

describe("UsersPage routing split (#PR4)", () => {
  test("workspace admin on /admin/users stays put — no redirect", () => {
    mockUserRole = "admin";
    render(createElement(AdminUsersPage), { wrapper });
    expect(mockReplace).not.toHaveBeenCalled();
  });

  test("platform admin on /admin/users is redirected to /platform/users", () => {
    mockUserRole = "platform_admin";
    render(createElement(AdminUsersPage), { wrapper });
    expect(mockReplace).toHaveBeenCalledWith("/platform/users");
  });

  test("/platform/users short-circuits to null when the guard is blocked", () => {
    mockGuardBlocked = true;
    const { container } = render(createElement(PlatformUsersPage), { wrapper });
    // Renders nothing — the guard's redirect-shim handles the bounce.
    expect(container.textContent).toBe("");
  });

  test("/platform/users renders the page when the guard passes", () => {
    mockGuardBlocked = false;
    const { container } = render(createElement(PlatformUsersPage), { wrapper });
    // Header is the first user-visible string from the underlying UsersPage.
    expect(container.textContent).toContain("Users");
  });
});
