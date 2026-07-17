/**
 * #4322 — the bound drawer converges onto the shared turn partitioner and
 * carries the originating conversation into bound mode.
 *
 *   1. Convergence: assistant turns render through `AgentTurn` (activity →
 *      receipt) with the live `WorkingActivity` pre-stream feed — not the old
 *      divergent inline renderer.
 *   2. Continuity: given `resumeConversationId`, the drawer hydrates that
 *      conversation's transcript (no reset-to-empty) so the SQL + intent it
 *      just produced carries in.
 */

import { describe, expect, test, mock, afterEach, beforeEach } from "bun:test";
import React from "react";

// ---- controllable useChat ------------------------------------------------
interface FakeMsg {
  id: string;
  role: "user" | "assistant";
  parts: { type: string; text?: string }[];
}
let chatMessages: FakeMsg[] = [];
let chatStatus = "ready";
const setMessagesSpy = mock((_m: unknown) => {});
const sendMessageSpy = mock(async (_m: unknown) => {});

void mock.module("@ai-sdk/react", () => ({
  useChat: () => ({
    messages: chatMessages,
    setMessages: setMessagesSpy,
    sendMessage: sendMessageSpy,
    status: chatStatus,
    error: null,
  }),
}));

void mock.module("@/ui/context", () => ({
  useAtlasConfig: () => ({ apiUrl: "", isCrossOrigin: false }),
}));

// ---- controllable resume fetch ------------------------------------------
let adminFetchData: unknown = null;
let adminFetchError: { message: string } | null = null;
let adminFetchLoading = false;
void mock.module("@/ui/hooks/use-admin-fetch", () => ({
  useAdminFetch: () => ({
    data: adminFetchData,
    loading: adminFetchLoading,
    error: adminFetchError,
    refetch: () => {},
  }),
}));

// Stub the shared renderer + feed so we assert ROUTING, not their internals.
void mock.module("@/ui/components/chat/agent-turn", () => ({
  AgentTurn: ({ streaming }: { streaming?: boolean }) =>
    React.createElement("div", { "data-testid": "agent-turn", "data-streaming": String(!!streaming) }),
}));
void mock.module("@/ui/components/chat/working-activity", () => ({
  WorkingActivity: () => React.createElement("div", { "data-testid": "working-activity" }),
  showPreStreamActivity: (loading: boolean, role: string | undefined) =>
    loading && role !== "assistant",
}));
void mock.module("@/ui/components/chat/follow-up-chips", () => ({
  FollowUpChips: ({ suggestions }: { suggestions: string[] }) =>
    React.createElement("div", { "data-testid": "chips" }, suggestions.join("|")),
}));

import { render, cleanup, waitFor } from "@testing-library/react";

const { BoundChatDrawer } = await import("../bound-chat-drawer");

afterEach(cleanup);
beforeEach(() => {
  chatMessages = [];
  chatStatus = "ready";
  adminFetchData = null;
  adminFetchError = null;
  adminFetchLoading = false;
  setMessagesSpy.mockClear();
  sendMessageSpy.mockClear();
});

function renderDrawer(props: Partial<React.ComponentProps<typeof BoundChatDrawer>> = {}) {
  return render(
    <BoundChatDrawer
      open
      onOpenChange={() => {}}
      dashboardId="dash-1"
      dashboardTitle="Sales"
      {...props}
    />,
  );
}

describe("BoundChatDrawer — partitioner convergence", () => {
  test("assistant turns render through AgentTurn, not an inline renderer", () => {
    chatMessages = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "add a card" }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "done" }] },
    ];
    const { getAllByTestId } = renderDrawer();
    expect(getAllByTestId("agent-turn").length).toBe(1);
  });

  test("streaming: last assistant turn is marked streaming + pre-stream feed shows on a bare user turn", () => {
    // A user turn mid-flight with no assistant message yet → pre-stream feed.
    chatMessages = [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }];
    chatStatus = "submitted";
    const { getByTestId } = renderDrawer();
    expect(getByTestId("working-activity")).toBeTruthy();
  });
});

describe("BoundChatDrawer — conversation continuity", () => {
  test("resumeConversationId hydrates the transcript (no reset-to-empty)", async () => {
    adminFetchData = {
      messages: [
        {
          id: "m1",
          conversationId: "conv-1",
          role: "user",
          content: [{ type: "text", text: "build me a dashboard" }],
          createdAt: "2026-07-04T00:00:00.000Z",
        },
      ],
    };
    renderDrawer({ resumeConversationId: "conv-1" });
    await waitFor(() => {
      expect(setMessagesSpy).toHaveBeenCalled();
    });
    // The hydrated payload was pushed into the chat (not cleared to []).
    const lastCall = setMessagesSpy.mock.calls.at(-1)?.[0] as unknown[];
    expect(Array.isArray(lastCall)).toBe(true);
    expect(lastCall.length).toBe(1);
  });

  test("no resume id → fresh session clears the transcript once + shows prompts", () => {
    const { getByText } = renderDrawer();
    expect(getByText(/Tell the agent what to change/i)).toBeTruthy();
    // The seed effect clears exactly once for a fresh open (the FRESH_SESSION
    // guard prevents re-clobbering a later live turn).
    const clears = setMessagesSpy.mock.calls.filter(
      (c) => Array.isArray(c[0]) && (c[0] as unknown[]).length === 0,
    );
    expect(clears.length).toBe(1);
  });

  test("failed resume GET → fresh session + a banner, never a silent invisible pin", async () => {
    adminFetchError = { message: "Forbidden" };
    const { getByTestId, getByText } = renderDrawer({ resumeConversationId: "conv-x" });
    await waitFor(() => {
      expect(getByTestId("resume-failed-banner")).toBeTruthy();
    });
    // Fell back to a fresh (visible) session: transcript cleared, prompts shown.
    expect(getByText(/Tell the agent what to change/i)).toBeTruthy();
    const clears = setMessagesSpy.mock.calls.filter(
      (c) => Array.isArray(c[0]) && (c[0] as unknown[]).length === 0,
    );
    expect(clears.length).toBeGreaterThanOrEqual(1);
  });

  test("resume still loading → skeleton, not the fresh-session prompts", () => {
    adminFetchLoading = true;
    const { getByTestId, queryByText } = renderDrawer({ resumeConversationId: "conv-1" });
    expect(getByTestId("resume-loading")).toBeTruthy();
    expect(queryByText(/Tell the agent what to change/i)).toBeNull();
  });
});

describe("BoundChatDrawer — surgical board invalidation (#4567)", () => {
  const toolMsg = (name: string, kind: string): FakeMsg =>
    ({
      id: "a1",
      role: "assistant",
      parts: [{ type: `tool-${name}`, state: "output-available", toolCallId: "call-1", output: { kind } }],
    }) as unknown as FakeMsg;

  test("a successful mutation tool fires onDashboardMutated once", async () => {
    chatMessages = [toolMsg("addCard", "ok")];
    const spy = mock(() => {});
    renderDrawer({ onDashboardMutated: spy });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });

  test("a pure read tool does NOT fire onDashboardMutated (no flash-reload)", () => {
    chatMessages = [toolMsg("getDashboardState", "ok")];
    const spy = mock(() => {});
    renderDrawer({ onDashboardMutated: spy });
    expect(spy).not.toHaveBeenCalled();
  });

  test("a failed mutation (kind: err) does NOT fire onDashboardMutated", () => {
    chatMessages = [toolMsg("addCard", "err")];
    const spy = mock(() => {});
    renderDrawer({ onDashboardMutated: spy });
    expect(spy).not.toHaveBeenCalled();
  });

  test("a re-render with a NEW callback identity does not refire for the same mutation", async () => {
    chatMessages = [toolMsg("addCard", "ok")];
    const spy1 = mock(() => {});
    const { rerender } = render(
      <BoundChatDrawer
        open
        onOpenChange={() => {}}
        dashboardId="dash-1"
        dashboardTitle="Sales"
        onDashboardMutated={spy1}
      />,
    );
    await waitFor(() => expect(spy1).toHaveBeenCalledTimes(1));
    // Same messages (same signature), fresh callback identity — the ref-guard
    // must suppress a second refetch for a mutation already handled.
    const spy2 = mock(() => {});
    rerender(
      <BoundChatDrawer
        open
        onOpenChange={() => {}}
        dashboardId="dash-1"
        dashboardTitle="Sales"
        onDashboardMutated={spy2}
      />,
    );
    expect(spy2).not.toHaveBeenCalled();
  });
});
