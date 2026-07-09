/**
 * Component tests for the in-conversation durable working-memory control
 * (#3758): opening it reads the conversation's slots, and Reset clears them.
 */

import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import React, { type ReactNode } from "react";

// Dialog primitives portal their content; stub them to passthrough divs so the
// rendered tree contains the dialog body. CLAUDE.md "Mock all exports".
void mock.module("@/components/ui/dialog", () => {
  const passthrough =
    (tag: string) =>
    ({ children, asChild: _asChild, open: _open, onOpenChange: _onOpenChange, ...rest }: {
      children?: ReactNode;
      asChild?: boolean;
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
    } & Record<string, unknown>) =>
      React.createElement(tag, rest, children as React.ReactNode);
  const div = passthrough("div");
  return {
    Dialog: div,
    DialogTrigger: div,
    DialogPortal: div,
    DialogOverlay: div,
    DialogContent: div,
    DialogHeader: div,
    DialogFooter: div,
    DialogTitle: passthrough("h2"),
    DialogDescription: passthrough("p"),
    DialogClose: div,
  };
});

void mock.module("@/ui/context", () => ({
  useAtlasConfig: () => ({ apiUrl: "http://localhost", isCrossOrigin: false }),
}));

import { render, cleanup, waitFor, fireEvent } from "@testing-library/react";

const { ConversationMemoryControl } = await import("../conversation-memory-control");

/** Fetch mock that serves slots on GET and a cleared count on DELETE. */
function installFetchMock() {
  const fetchMock = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "DELETE") {
      return new Response(JSON.stringify({ cleared: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ slots: [{ namespace: "region", value: "EU", updatedAt: "2026-06-20T10:00:00.000Z" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function buttonByLabel(container: HTMLElement, label: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find(
    (b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label,
  );
  if (!btn) throw new Error(`button "${label}" not found`);
  return btn as HTMLButtonElement;
}

afterEach(() => cleanup());

describe("ConversationMemoryControl", () => {
  beforeEach(() => {
    installFetchMock();
  });

  test("opening the control reads the conversation's memory slots", async () => {
    const { container } = render(<ConversationMemoryControl conversationId="conv-1" />);

    fireEvent.click(buttonByLabel(container, "View session memory"));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
      expect(container.textContent).toContain("region");
    });
    // GET to the conversation's memory endpoint.
    const firstCall = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(firstCall[0]).toBe("http://localhost/api/v1/conversations/conv-1/memory");
  });

  test("Reset clears the slots and DELETEs the memory endpoint", async () => {
    const { container } = render(<ConversationMemoryControl conversationId="conv-1" />);

    fireEvent.click(buttonByLabel(container, "View session memory"));
    await waitFor(() => expect(container.textContent).toContain("region"));

    fireEvent.click(buttonByLabel(container, "Reset memory"));

    await waitFor(() => {
      expect(container.textContent).toContain("No working memory yet");
    });
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls;
    const deleteCall = calls.find((c) => (c[1]?.method ?? "GET") === "DELETE");
    expect(deleteCall?.[0]).toBe("http://localhost/api/v1/conversations/conv-1/memory");
  });
});
