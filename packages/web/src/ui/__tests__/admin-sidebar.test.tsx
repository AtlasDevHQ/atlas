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

  test("renders Atlas branding", () => {
    const { container } = render(<AdminSidebar />, { wrapper: Wrapper });
    expect(container.textContent).toContain("Atlas");
    expect(container.textContent).toContain("Admin Console");
  });

  test("renders overview and back-to-chat hrefs", () => {
    const { container } = render(<AdminSidebar />, { wrapper: Wrapper });
    const links = container.querySelectorAll("a");
    const hrefs = Array.from(links).map((a) => a.getAttribute("href"));
    // Overview link and back-to-chat are always rendered
    expect(hrefs).toContain("/admin");
    expect(hrefs).toContain("/");
  });
});
