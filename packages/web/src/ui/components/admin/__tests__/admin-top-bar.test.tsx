import { describe, expect, test, mock } from "bun:test";
import React from "react";
import type { ReactNode } from "react";

let mockedPath = "/admin";
mock.module("next/navigation", () => ({
  usePathname: () => mockedPath,
}));

mock.module("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href }, children),
}));

mock.module("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => React.createElement("button", { "data-testid": "sidebar-trigger" }),
}));

mock.module("@/components/ui/separator", () => ({
  Separator: () => React.createElement("hr"),
}));

// OrgSwitcher hits the auth client at module load — stub to a stable label
// so the breadcrumb is the only thing under test.
mock.module("@/ui/components/org-switcher", () => ({
  OrgSwitcher: () => React.createElement("span", { "data-testid": "org-switcher" }, "Acme"),
}));

mock.module("@/ui/components/user-menu", () => ({
  UserMenu: () => React.createElement("div", { "data-testid": "user-menu" }),
}));

// PendingChangesPill pulls in useAtlasConfig + use-mode-status; stub it out
// here so the breadcrumb test stays focused on path resolution. The pill has
// its own coverage in pending-changes-pill.test.tsx.
mock.module("@/ui/components/admin/pending-changes-pill", () => ({
  PendingChangesPill: () =>
    React.createElement("div", { "data-testid": "pending-changes-pill" }),
}));

import { render, cleanup } from "@testing-library/react";
import { AdminTopBar } from "../admin-top-bar";

function Wrapper({ children }: { children: ReactNode }) {
  return React.createElement(React.Fragment, null, children);
}

describe("AdminTopBar breadcrumb", () => {
  test("/admin renders [org] / Admin Console", () => {
    mockedPath = "/admin";
    cleanup();
    const { container } = render(<AdminTopBar />, { wrapper: Wrapper });
    expect(container.textContent).toContain("Acme");
    expect(container.textContent).toContain("Admin Console");
    expect(container.textContent).not.toContain("Admin /");
  });

  test("/admin/account-security renders [org] / Admin / Security / MFA & Sessions", () => {
    mockedPath = "/admin/account-security";
    cleanup();
    const { container } = render(<AdminTopBar />, { wrapper: Wrapper });
    expect(container.textContent).toContain("Acme");
    expect(container.textContent).toContain("Admin");
    expect(container.textContent).toContain("Security");
    expect(container.textContent).toContain("MFA & Sessions");
    // The "Admin" link goes back to /admin so deep crumbs are navigable.
    const adminLink = container.querySelector('a[href="/admin"]');
    expect(adminLink?.textContent).toBe("Admin");
  });

  test("/admin/semantic/improve resolves the improve-layer leaf, not the parent", () => {
    mockedPath = "/admin/semantic/improve";
    cleanup();
    const { container } = render(<AdminTopBar />, { wrapper: Wrapper });
    expect(container.textContent).toContain("Improve Layer");
    expect(container.textContent).not.toContain("Semantic Layer");
  });

  test("/admin/settings/mcp resolves to MCP, not Settings (#2176 regression — sibling leaf must not collapse the child)", () => {
    mockedPath = "/admin/settings/mcp";
    cleanup();
    const { container } = render(<AdminTopBar />, { wrapper: Wrapper });
    expect(container.textContent).toContain("MCP");
    // "Settings" is the section name (Configuration), not the page label here.
    const text = container.textContent ?? "";
    // Page label MCP appears, and "Configuration" (group) appears, but the
    // sibling "Settings" leaf entry must not collapse the MCP child.
    expect(text.includes("Configuration")).toBe(true);
  });

  test("an unmapped /admin/* path collapses to overview crumb", () => {
    mockedPath = "/admin/totally-not-a-route";
    cleanup();
    const { container } = render(<AdminTopBar />, { wrapper: Wrapper });
    expect(container.textContent).toContain("Admin Console");
  });
});
