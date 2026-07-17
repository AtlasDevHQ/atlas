/**
 * #4322 — the createDashboard handoff carries the originating conversation id
 * into bound mode. `CreateDashboardCard`'s "Continue editing" link appends
 * `&conversationId=<id>` when a conversation is in context, and degrades to a
 * plain `?openChat=true` outside a provider (no live conversation).
 */

import { describe, expect, test, afterEach, mock } from "bun:test";
import React from "react";

// Stub next/link to a plain anchor so we can read the href in jsdom.
void mock.module("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

import { render, cleanup } from "@testing-library/react";

const { CreateDashboardCard } = await import("../create-dashboard-card");
const { ChatConversationProvider } = await import("../chat-conversation-context");

afterEach(cleanup);

const okPart = {
  type: "tool-createDashboard",
  toolCallId: "call-1",
  state: "output-available" as const,
  input: {},
  output: {
    kind: "ok",
    dashboardId: "dash-9",
    title: "Sales",
    description: null,
    cardCount: 2,
    draft: true,
  },
} as unknown;

function hrefOf(container: HTMLElement): string {
  const link = container.querySelector('a[aria-label^="Continue editing"]');
  return link?.getAttribute("href") ?? "";
}

describe("CreateDashboardCard — continuity handoff link", () => {
  test("inside a conversation provider → link carries conversationId", () => {
    const { container } = render(
      <ChatConversationProvider conversationId="conv-42">
        <CreateDashboardCard part={okPart} />
      </ChatConversationProvider>,
    );
    expect(hrefOf(container)).toBe("/dashboards/dash-9?openChat=true&conversationId=conv-42");
  });

  test("outside a provider → plain openChat link (fresh bound session)", () => {
    const { container } = render(<CreateDashboardCard part={okPart} />);
    expect(hrefOf(container)).toBe("/dashboards/dash-9?openChat=true");
  });

  test("URL-encodes a conversation id with reserved characters", () => {
    const { container } = render(
      <ChatConversationProvider conversationId="a/b?c">
        <CreateDashboardCard part={okPart} />
      </ChatConversationProvider>,
    );
    expect(hrefOf(container)).toContain(`conversationId=${encodeURIComponent("a/b?c")}`);
  });

  // #4566 — the link base comes from the tool's host-resolved `dashboardUrl`,
  // not a hard-coded workspace path.
  test("uses the tool's resolved dashboardUrl as the handoff base", () => {
    const hostPart = {
      ...(okPart as Record<string, unknown>),
      output: {
        kind: "ok",
        dashboardId: "dash-9",
        title: "Sales",
        description: null,
        cardCount: 2,
        draft: true,
        dashboardUrl: "/analytics/boards/dash-9",
      },
    } as unknown;
    const { container } = render(
      <ChatConversationProvider conversationId="conv-42">
        <CreateDashboardCard part={hostPart} />
      </ChatConversationProvider>,
    );
    expect(hrefOf(container)).toBe(
      "/analytics/boards/dash-9?openChat=true&conversationId=conv-42",
    );
  });

  test("appends to a resolved dashboardUrl that already carries a query string", () => {
    const hostPart = {
      ...(okPart as Record<string, unknown>),
      output: {
        kind: "ok",
        dashboardId: "dash-9",
        title: "Sales",
        description: null,
        cardCount: 2,
        draft: true,
        dashboardUrl: "/analytics/boards/dash-9?embed=1",
      },
    } as unknown;
    const { container } = render(<CreateDashboardCard part={hostPart} />);
    expect(hrefOf(container)).toBe("/analytics/boards/dash-9?embed=1&openChat=true");
  });

  test("falls back to the workspace path when dashboardUrl is a non-string malformed value", () => {
    const badPart = {
      ...(okPart as Record<string, unknown>),
      output: {
        kind: "ok",
        dashboardId: "dash-9",
        title: "Sales",
        description: null,
        cardCount: 2,
        draft: true,
        // A malformed payload — the card narrows only kind/dashboardId/title, so
        // this reaches the render guard, which must reject a non-string.
        dashboardUrl: 123,
      },
    } as unknown;
    const { container } = render(<CreateDashboardCard part={badPart} />);
    expect(hrefOf(container)).toBe("/dashboards/dash-9?openChat=true");
  });
});
