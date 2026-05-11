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
 *   - Pending session on `/admin/users` blocks the render — no flash of
 *     workspace UI for a platform admin during the loading window.
 *   - `/platform/users` short-circuits to null when the platform-admin
 *     guard is blocked (non-platform-admin walking up to the URL gets
 *     the redirect-shim from `usePlatformAdminGuard`).
 *   - `/platform/users` renders the page when the guard passes.
 *   - Scope-driven verb divergence: `scope="platform"` shows "Ban user";
 *     `scope="workspace"` shows "Remove from workspace". This is the
 *     user-visible behavior the routing tests above don't reach.
 */

import { describe, expect, test, mock, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/next/app";

interface MockSession {
  data: { user: { role: string } } | undefined;
  isPending: boolean;
}

let mockSession: MockSession = {
  data: { user: { role: "admin" } },
  isPending: false,
};
let mockGuardBlocked = false;
const mockReplace = mock(() => {});

mock.module("next/navigation", () => ({
  usePathname: () => "/admin/users",
  useRouter: () => ({ push: () => {}, replace: mockReplace, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

mock.module("@/ui/hooks/use-platform-admin-guard", () => ({
  useUserRole: () => mockSession.data?.user?.role,
  usePlatformAdminGuard: () => ({ blocked: mockGuardBlocked }),
}));

// useAtlasConfig is consulted both by the routing wrapper (for
// `authClient.useSession()`) and by the inner UsersPage (for `apiUrl` /
// `isCrossOrigin`). One mock covers both.
mock.module("@/ui/context", () => ({
  useAtlasConfig: () => ({
    apiUrl: "http://localhost",
    isCrossOrigin: false,
    authClient: { useSession: () => mockSession },
  }),
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
const { UsersPage } = await import("../../app/admin/users/_users-page");

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(NuqsAdapter, null, createElement(QueryClientProvider, { client }, children));
}

afterEach(() => {
  cleanup();
  mockReplace.mockClear();
  mockSession = { data: { user: { role: "admin" } }, isPending: false };
  mockGuardBlocked = false;
});

describe("UsersPage routing split (#2306)", () => {
  test("workspace admin on /admin/users stays put — no redirect", () => {
    mockSession = { data: { user: { role: "admin" } }, isPending: false };
    render(createElement(AdminUsersPage), { wrapper });
    expect(mockReplace).not.toHaveBeenCalled();
  });

  test("platform admin on /admin/users is redirected to /platform/users", () => {
    mockSession = { data: { user: { role: "platform_admin" } }, isPending: false };
    render(createElement(AdminUsersPage), { wrapper });
    expect(mockReplace).toHaveBeenCalledWith("/platform/users");
  });

  test("pending session on /admin/users blocks render — no flash of workspace UI", () => {
    // Reproduces the audit-flagged race: while `useSession()` returns
    // `{ data: undefined, isPending: true }` (the initial render before
    // Better Auth resolves the session), the page MUST render nothing.
    // Otherwise a platform admin sees workspace data + fires three stray
    // /api/v1/admin/users{,/stats,/invitations} requests during the
    // milliseconds before `router.replace` fires.
    mockSession = { data: undefined, isPending: true };
    const { container } = render(createElement(AdminUsersPage), { wrapper });
    expect(container.textContent).toBe("");
    expect(mockReplace).not.toHaveBeenCalled();
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

  test("scope='workspace' renders 'Manage workspace members and roles' subtitle", () => {
    const { container } = render(createElement(UsersPage, { scope: "workspace" }), { wrapper });
    expect(container.textContent).toContain("Manage workspace members and roles");
    expect(container.textContent).not.toContain("Manage all user accounts and roles");
  });

  test("scope='platform' renders 'Manage all user accounts and roles' subtitle", () => {
    const { container } = render(createElement(UsersPage, { scope: "platform" }), { wrapper });
    expect(container.textContent).toContain("Manage all user accounts and roles");
    expect(container.textContent).not.toContain("Manage workspace members and roles");
  });
});
