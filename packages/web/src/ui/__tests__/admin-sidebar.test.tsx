import { describe, expect, test, mock } from "bun:test";
import React from "react";
import type { ReactNode } from "react";

// Mock next/navigation — must mock ALL named exports used
void mock.module("next/navigation", () => ({
  usePathname: () => "/admin",
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: () => {},
  notFound: () => {},
}));

// Mock next/link to render a plain anchor
void mock.module("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

// Mock useBranding — no custom branding by default
void mock.module("@/ui/hooks/use-branding", () => ({
  useBranding: () => ({ branding: null, loading: false }),
}));

// Mock useDeployMode — default to self-hosted
void mock.module("@/ui/hooks/use-deploy-mode", () => ({
  useDeployMode: () => ({ deployMode: "self-hosted", loading: false, error: null, resolved: true }),
}));

// Mock shadcn sidebar — complex component with deep dependency chain (radix-ui, hooks, etc.)
void mock.module("@/components/ui/sidebar", () => {

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
    SidebarMenuSub: ({ children }: { children: React.ReactNode }) => React.createElement("ul", null, children),
    SidebarMenuSubItem: ({ children }: { children: React.ReactNode }) => React.createElement("li", null, children),
    SidebarMenuSubButton: ({ children, asChild: _, ...rest }: { children: React.ReactNode; asChild?: boolean; isActive?: boolean }) => React.createElement("button", rest, children),
    SidebarRail: () => React.createElement("div"),
    useSidebar: () => ({ open: true, setOpen: () => {}, toggleSidebar: () => {}, isMobile: false, state: "expanded" }),
  };
});

// Mock shadcn collapsible
void mock.module("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
  CollapsibleTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => React.createElement("div", null, children),
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
}));

// Mock shadcn separator
void mock.module("@/components/ui/separator", () => {

  return { Separator: () => React.createElement("hr") };
});

import { render } from "@testing-library/react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AtlasProvider, type AtlasAuthClient } from "../context";
import { AdminSidebar } from "../components/admin/admin-sidebar";

const stubAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: { user: { email: "admin@test.com" } }, isPending: false }),
};

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <AtlasProvider config={{ apiUrl: "http://localhost:3001", isCrossOrigin: false, authClient: stubAuthClient }}>
      <SidebarProvider>{children}</SidebarProvider>
    </AtlasProvider>
  );
}

// An ADMIN session — `role: "admin"` is in ADMIN_ROLES, so `useMode().isAdmin`
// is true and the pending-amendment badge poll is enabled (#4517).
const adminAuthClient: AtlasAuthClient = {
  ...stubAuthClient,
  useSession: () => ({ data: { user: { email: "admin@test.com", role: "admin" } }, isPending: false }),
};

function AdminWrapper({ children }: { children: ReactNode }) {
  return (
    <AtlasProvider config={{ apiUrl: "http://localhost:3001", isCrossOrigin: false, authClient: adminAuthClient }}>
      <SidebarProvider>{children}</SidebarProvider>
    </AtlasProvider>
  );
}

const PENDING_COUNT_URL = "/api/v1/admin/semantic-improve/pending-count";
const LEARNED_PENDING_COUNT_URL = "/api/v1/admin/learned-patterns/pending-count";

/** Render with `fetch` spied; return which badge-count URLs were requested. */
function renderWithFetchSpy(wrapper: ({ children }: { children: ReactNode }) => React.JSX.Element) {
  const fetchSpy = mock(async (_url: string | URL, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => ({ count: 0 }),
  }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  try {
    const { unmount } = render(<AdminSidebar />, { wrapper });
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    const polledPendingCount = urls.some((u) => u.includes(PENDING_COUNT_URL));
    const polledLearnedCount = urls.some((u) => u.includes(LEARNED_PENDING_COUNT_URL));
    unmount();
    return { polledPendingCount, polledLearnedCount };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("AdminSidebar", () => {
  test("renders group titles and overview", () => {
    const { container } = render(<AdminSidebar />, { wrapper: Wrapper });
    // Group titles are always visible in collapsed sidebar
    const groups = ["Overview", "Data", "Intelligence", "Users & Access", "Security", "Monitoring", "Configuration"];
    for (const label of groups) {
      expect(container.textContent).toContain(label);
    }
  });

  test("renders back to chat link", () => {
    const { container } = render(<AdminSidebar />, { wrapper: Wrapper });
    expect(container.textContent).toContain("Back to Chat");
  });

  test("sidebar header renders the logo affordance, not duplicated workspace text", () => {
    // Workspace name + "Admin Console" live in the top-bar breadcrumb now
    // (#2176). The sidebar header is logo-only — the link still navigates
    // home but doesn't repeat the labels.
    const { container } = render(<AdminSidebar />, { wrapper: Wrapper });
    const homeLink = container.querySelector('a[aria-label="Admin home"]');
    expect(homeLink).not.toBeNull();
    expect(homeLink?.getAttribute("href")).toBe("/admin");
  });

  test("renders overview and back-to-chat hrefs", () => {
    const { container } = render(<AdminSidebar />, { wrapper: Wrapper });
    const links = container.querySelectorAll("a");
    const hrefs = Array.from(links).map((a) => a.getAttribute("href"));
    // Overview link and back-to-chat are always rendered
    expect(hrefs).toContain("/admin");
    expect(hrefs).toContain("/");
  });

  // #4517 — the pending-amendment badge poll is gated on the admin role, since
  // `/pending-count` requires the `admin:semantic` permission. A non-admin
  // polling it every 60s produced silent 403 spam.
  test("does NOT poll the pending-count badge for a non-admin", () => {
    // The default stub session carries no role → isAdmin false → no poll.
    expect(renderWithFetchSpy(Wrapper).polledPendingCount).toBe(false);
  });

  test("polls the pending-count badge for an admin", () => {
    expect(renderWithFetchSpy(AdminWrapper).polledPendingCount).toBe(true);
  });

  // #4578 — the Learned Patterns nav entry gets a reviewable-pending badge so the
  // queue announces itself. Same admin gate as the amendment badge.
  test("polls the learned-patterns reviewable-pending count for an admin, not for a non-admin", () => {
    expect(renderWithFetchSpy(AdminWrapper).polledLearnedCount).toBe(true);
    expect(renderWithFetchSpy(Wrapper).polledLearnedCount).toBe(false);
  });
});
