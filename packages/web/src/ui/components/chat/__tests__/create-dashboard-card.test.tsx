/**
 * #4322 — the createDashboard handoff carries the originating conversation id
 * into bound mode. `CreateDashboardCard`'s "Continue editing" link appends
 * `&conversationId=<id>` when a conversation is in context, and degrades to a
 * plain `?openChat=true` outside a provider (notebook / no live conversation).
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
});
