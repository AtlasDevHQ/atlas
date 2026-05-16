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

// All useAdminFetch call sites in the page wrapper + the embedded
// ModelProviderSection (billing, model-config GET, gateway catalog, etc.)
// resolve through this single mock. Routing tests only care that the page
// mounts — benign empty payloads suffice. Content tests (e.g. the
// free-tier-unconfigured CTA below) override `billingData` per-test so
// only the `/api/v1/billing` call returns shaped data; siblings stay null.
let billingData: unknown = null;
mock.module("@/ui/hooks/use-admin-fetch", () => ({
  useAdminFetch: (path: string) => ({
    data: path === "/api/v1/billing" ? billingData : null,
    loading: false,
    error: null,
    refetch: () => {},
  }),
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
  billingData = null;
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

describe("/admin/model-config — free-tier placeholder copy (#2468)", () => {
  // Regression guard. The free-tier plan default in `plans.ts` is the literal
  // sentinel `"user-configured"`. The API returns it as `currentModel` when no
  // ATLAS_MODEL setting exists, and pre-fix the page rendered that string as
  // the platform-baseline title. If `plans.ts` renames the sentinel, or the
  // page's tier check tightens incorrectly, this test surfaces the regression.
  test("free-tier workspace with no ATLAS_MODEL renders the CTA, not the placeholder", () => {
    billingData = {
      workspaceId: "ws_test",
      plan: {
        tier: "free",
        displayName: "Self-Hosted",
        pricePerSeat: 0,
        defaultModel: "user-configured",
        byot: false,
        trialEndsAt: null,
      },
      limits: { tokenBudgetPerSeat: null, totalTokenBudget: null, maxSeats: null, maxConnections: null },
      usage: {
        queryCount: 0,
        tokenCount: 0,
        seatCount: 1,
        tokenUsagePercent: 0,
        tokenOverageStatus: "ok",
        periodStart: "2026-05-01T00:00:00.000Z",
        periodEnd: "2026-06-01T00:00:00.000Z",
      },
      seats: { count: 1, max: null },
      connections: { count: 0, max: null },
      currentModel: "user-configured",
      overagePerMillionTokens: 0,
      subscription: null,
    };
    const { container } = render(createElement(ModelConfigPage), { wrapper });
    expect(container.textContent).toContain("No default model configured");
    expect(container.textContent).toContain("Set ATLAS_MODEL");
    expect(container.textContent).not.toContain("user-configured");
  });

  test("free-tier workspace with ATLAS_MODEL set renders the configured model", () => {
    billingData = {
      workspaceId: "ws_test",
      plan: {
        tier: "free",
        displayName: "Self-Hosted",
        pricePerSeat: 0,
        defaultModel: "user-configured",
        byot: false,
        trialEndsAt: null,
      },
      limits: { tokenBudgetPerSeat: null, totalTokenBudget: null, maxSeats: null, maxConnections: null },
      usage: {
        queryCount: 0,
        tokenCount: 0,
        seatCount: 1,
        tokenUsagePercent: 0,
        tokenOverageStatus: "ok",
        periodStart: "2026-05-01T00:00:00.000Z",
        periodEnd: "2026-06-01T00:00:00.000Z",
      },
      seats: { count: 1, max: null },
      connections: { count: 0, max: null },
      currentModel: "anthropic/claude-haiku-4.5",
      overagePerMillionTokens: 0,
      subscription: null,
    };
    const { container } = render(createElement(ModelConfigPage), { wrapper });
    expect(container.textContent).toContain("Haiku 4.5");
    expect(container.textContent).not.toContain("No default model configured");
    expect(container.textContent).not.toContain("user-configured");
  });
});
