import { describe, expect, test, mock } from "bun:test";
import type React from "react";
import type { ReactNode } from "react";

// Mock next/navigation — must mock ALL named exports used
mock.module("next/navigation", () => ({
  usePathname: () => "/admin",
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: () => {},
  notFound: () => {},
}));

// Mock next/link to render a plain anchor
mock.module("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

// Mock useBranding — no custom branding by default
mock.module("@/ui/hooks/use-branding", () => ({
  useBranding: () => ({ branding: null, loading: false }),
}));

import { render } from "@testing-library/react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AtlasUIProvider, type AtlasAuthClient } from "../context";
import { AdminSidebar } from "../components/admin/admin-sidebar";

const stubAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: { user: { email: "admin@test.com" } }, isPending: false }),
};

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <AtlasUIProvider config={{ apiUrl: "http://localhost:3001", isCrossOrigin: false, authClient: stubAuthClient }}>
      <SidebarProvider>{children}</SidebarProvider>
    </AtlasUIProvider>
  );
}

describe("AdminSidebar", () => {
  test("renders all navigation items", () => {
    const { container } = render(<AdminSidebar />, { wrapper: Wrapper });
    const labels = [
      "Overview", "Semantic Layer", "Connections", "Audit",
      "Users", "Sessions", "Plugins", "Scheduled Tasks", "Actions",
    ];
    for (const label of labels) {
      expect(container.textContent).toContain(label);
    }
  });

  test("renders back to chat link", () => {
    const { container } = render(<AdminSidebar />, { wrapper: Wrapper });
    expect(container.textContent).toContain("Back to Chat");
  });

  test("renders Atlas branding", () => {
    const { container } = render(<AdminSidebar />, { wrapper: Wrapper });
    expect(container.textContent).toContain("Atlas");
    expect(container.textContent).toContain("Admin Console");
  });

  test("renders correct navigation hrefs", () => {
    const { container } = render(<AdminSidebar />, { wrapper: Wrapper });
    const links = container.querySelectorAll("a");
    const hrefs = Array.from(links).map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/admin");
    expect(hrefs).toContain("/admin/semantic");
    expect(hrefs).toContain("/admin/connections");
    expect(hrefs).toContain("/admin/audit");
    expect(hrefs).toContain("/admin/users");
    expect(hrefs).toContain("/admin/sessions");
    expect(hrefs).toContain("/admin/plugins");
    expect(hrefs).toContain("/admin/scheduled-tasks");
    expect(hrefs).toContain("/admin/actions");
    expect(hrefs).toContain("/");
  });
});
