import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import React, { type ReactNode } from "react";

let currentPathname = "/";

mock.module("next/navigation", () => ({
  usePathname: () => currentPathname,
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: () => {},
  notFound: () => {},
}));

mock.module("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: ReactNode;
  }) =>
    React.createElement("a", { href, ...rest }, children as React.ReactNode),
}));

mock.module("@/ui/components/conversations/conversation-list", () => ({
  ConversationList: ({
    conversations,
    emptyMessage,
  }: {
    conversations: { id: string; title?: string | null }[];
    emptyMessage?: string;
  }) =>
    React.createElement(
      "div",
      { "data-testid": "conversation-list" },
      conversations.length === 0
        ? emptyMessage ?? "(empty)"
        : conversations.map((c) =>
            React.createElement("div", { key: c.id }, c.title ?? c.id),
          ),
    ),
}));

mock.module("@/ui/components/org-switcher", () => ({
  OrgSwitcher: () =>
    React.createElement("div", { "data-testid": "org-switcher" }),
}));

mock.module("@/ui/components/user-menu", () => ({
  UserMenu: () => React.createElement("div", { "data-testid": "user-menu" }),
}));

mock.module("@/ui/components/demo-indicator-chip", () => ({
  DemoIndicatorChip: () => React.createElement("span"),
}));

mock.module("@/components/ui/sidebar", () => {
  const Provider = ({ children }: { children: ReactNode }) =>
    React.createElement("div", null, children);
  const passthrough =
    (tag: string) =>
    ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) =>
      React.createElement(tag, rest, children as React.ReactNode);
  return {
    SidebarProvider: Provider,
    SidebarInset: passthrough("main"),
    Sidebar: passthrough("nav"),
    SidebarHeader: passthrough("div"),
    SidebarContent: passthrough("div"),
    SidebarFooter: passthrough("div"),
    SidebarGroup: passthrough("div"),
    SidebarGroupLabel: passthrough("div"),
    SidebarGroupContent: passthrough("div"),
    SidebarMenu: passthrough("ul"),
    SidebarMenuItem: passthrough("li"),
    SidebarMenuButton: ({
      children,
      onClick,
      asChild,
      isActive,
      tooltip,
      ...rest
    }: {
      children?: ReactNode;
      onClick?: () => void;
      asChild?: boolean;
      isActive?: boolean;
      tooltip?: string;
    } & Record<string, unknown>) => {
      void asChild;
      void tooltip;
      return React.createElement(
        "button",
        {
          onClick,
          "data-active": isActive ? "true" : "false",
          ...rest,
        },
        children as React.ReactNode,
      );
    },
    SidebarRail: () => React.createElement("div"),
    SidebarTrigger: () => React.createElement("button"),
    useSidebar: () => ({
      isMobile: false,
      setOpenMobile: () => {},
      open: true,
      setOpen: () => {},
      toggleSidebar: () => {},
      state: "expanded",
    }),
  };
});

import { render, fireEvent, cleanup } from "@testing-library/react";
import { ChatSidebar } from "../components/chat/chat-sidebar";
import { PALETTE_EVENT } from "../components/chat/palette-events";

const baseProps = {
  conversations: [],
  selectedId: null,
  loading: false,
  onSelect: () => {},
  onDelete: async () => {},
  onStar: async () => {},
  onNewChat: () => {},
  onOpenPromptLibrary: () => {},
  onOpenSchemaExplorer: () => {},
};

describe("ChatSidebar admin gate", () => {
  beforeEach(() => {
    currentPathname = "/";
  });
  afterEach(cleanup);

  test("renders the Admin link when isAdmin=true", () => {
    const { container } = render(
      <ChatSidebar {...baseProps} isAdmin={true} />,
    );
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toContain("/admin");
  });

  test("does NOT render the Admin link when isAdmin=false", () => {
    const { container } = render(
      <ChatSidebar {...baseProps} isAdmin={false} />,
    );
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).not.toContain("/admin");
  });
});

describe("ChatSidebar active-state per route", () => {
  afterEach(cleanup);

  function getActiveSection(container: HTMLElement) {
    const activeBtn = container.querySelector(
      'button[data-active="true"]',
    ) as HTMLElement | null;
    return activeBtn?.textContent ?? null;
  }

  test("/ marks Chat active (exact match)", () => {
    currentPathname = "/";
    const { container } = render(<ChatSidebar {...baseProps} isAdmin={false} />);
    expect(getActiveSection(container)).toContain("Chat");
  });

  test("/notebook marks Notebook active", () => {
    currentPathname = "/notebook";
    const { container } = render(<ChatSidebar {...baseProps} isAdmin={false} />);
    expect(getActiveSection(container)).toContain("Notebook");
  });

  test("/dashboards/abc-123 keeps Dashboards active (startsWith)", () => {
    currentPathname = "/dashboards/abc-123";
    const { container } = render(<ChatSidebar {...baseProps} isAdmin={false} />);
    expect(getActiveSection(container)).toContain("Dashboards");
  });

  test("/notebook does NOT match Chat (exact prevents false match)", () => {
    currentPathname = "/notebook";
    const { container } = render(<ChatSidebar {...baseProps} isAdmin={false} />);
    const activeText = getActiveSection(container);
    expect(activeText).not.toMatch(/^Chat$/);
  });
});

describe("ChatSidebar Search dispatches PALETTE_EVENT", () => {
  afterEach(cleanup);

  test("clicking Search dispatches the shared event", () => {
    let received = false;
    const handler = () => {
      received = true;
    };
    window.addEventListener(PALETTE_EVENT, handler);

    const { getByText } = render(
      <ChatSidebar {...baseProps} isAdmin={false} />,
    );
    fireEvent.click(getByText("Search"));

    window.removeEventListener(PALETTE_EVENT, handler);
    expect(received).toBe(true);
  });
});
