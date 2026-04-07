import { describe, expect, test, mock } from "bun:test";
import React from "react";
import type { ReactNode } from "react";

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

// Mock useBranding
mock.module("@/ui/hooks/use-branding", () => ({
  useBranding: () => ({ branding: null, loading: false }),
}));

// Mock useDeployMode — SaaS mode for this test file
mock.module("@/ui/hooks/use-deploy-mode", () => ({
  useDeployMode: () => ({ deployMode: "saas", loading: false }),
}));

// Mock shadcn sidebar
mock.module("@/components/ui/sidebar", () => ({
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
}));

// Mock collapsible
mock.module("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
  CollapsibleTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => React.createElement("div", null, children),
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
}));

// Mock org-switcher
mock.module("@/ui/components/org-switcher", () => ({
  OrgSwitcher: () => React.createElement("div", { "data-testid": "org-switcher" }),
}));

// Mock separator
mock.module("@/components/ui/separator", () => ({
  Separator: () => React.createElement("hr"),
}));

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

describe("AdminSidebar (SaaS mode)", () => {
  test("hides selfHostedOnly items in SaaS mode", () => {
    const { container } = render(<AdminSidebar />, { wrapper: Wrapper });
    const text = container.textContent ?? "";

    // selfHostedOnly items should be hidden
    expect(text).not.toContain("Plugins");

    // Other Configuration items should still be present
    expect(text).toContain("Integrations");
    expect(text).toContain("Billing");
    expect(text).toContain("Settings");
  });
});
