/**
 * Regression guard for the bug this PR fixes.
 *
 * The audit pattern that produced #2305 (moved `/admin/model-config` to
 * `/platform/model-config` because it imported `usePlatformAdminGuard`) can
 * trivially repeat: a future review pass sees `/admin/model-config` and
 * pattern-matches on neighboring platform pages, then re-adds the guard.
 * Lint + type-check + the `every-nav-href-has-a-page-on-disk` walker would
 * all pass, and workspace admins would once again get bounced to `/admin`
 * the moment they try to configure their own BYOT key.
 *
 * BYOT is per-workspace. The API at `/api/v1/admin/model-config` is
 * org-scoped (uses `createAdminRouter()` + `requirePermission("admin:settings")`,
 * not `createPlatformRouter()`). Workspace admins MUST be able to render
 * this page without redirect.
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
const mockReplace = mock(() => {});

mock.module("next/navigation", () => ({
  usePathname: () => "/admin/model-config",
  useRouter: () => ({ push: () => {}, replace: mockReplace, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

mock.module("@/ui/context", () => ({
  useAtlasConfig: () => ({
    apiUrl: "http://localhost",
    isCrossOrigin: false,
    authClient: { useSession: () => mockSession },
  }),
}));

// All three useAdminFetch call sites in the page wrapper + the embedded
// ModelProviderSection (billing, model-config GET, gateway catalog, etc.)
// resolve through this single mock. Tests below only care about routing,
// not render content — a benign empty payload keeps the page mounted
// without firing real network requests.
mock.module("@/ui/hooks/use-admin-fetch", () => ({
  useAdminFetch: () => ({ data: null, loading: false, error: null, refetch: () => {} }),
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

const ModelConfigPage = (await import("../page")).default;

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(NuqsAdapter, null, createElement(QueryClientProvider, { client }, children));
}

afterEach(() => {
  cleanup();
  mockReplace.mockClear();
  mockSession = { data: { user: { role: "admin" } }, isPending: false };
});

describe("/admin/model-config — workspace-scoped, no platform guard", () => {
  test("workspace admin renders without redirect", () => {
    mockSession = { data: { user: { role: "admin" } }, isPending: false };
    const { container } = render(createElement(ModelConfigPage), { wrapper });
    expect(mockReplace).not.toHaveBeenCalled();
    // Header is the first user-visible string — page mounted.
    expect(container.textContent).toContain("AI Provider");
  });

  test("platform admin renders without redirect (page is workspace-tier, not platform-tier)", () => {
    // BYOT is per-workspace. A platform admin viewing their own workspace's
    // model config is a perfectly valid case — not a redirect.
    mockSession = { data: { user: { role: "platform_admin" } }, isPending: false };
    render(createElement(ModelConfigPage), { wrapper });
    expect(mockReplace).not.toHaveBeenCalled();
  });

  test("pending session does not redirect", () => {
    // Better Auth's initial render returns `{ data: undefined, isPending: true }`.
    // No role gating on this page means no redirect during that window either —
    // distinct from `/platform/*` pages where the pending state must NOT flash
    // workspace UI.
    mockSession = { data: undefined, isPending: true };
    render(createElement(ModelConfigPage), { wrapper });
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
