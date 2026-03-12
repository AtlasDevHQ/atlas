import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { AtlasProvider } from "../provider";
import { useAtlasChat } from "../use-atlas-chat";
import type { ReactNode } from "react";

// Mock @ai-sdk/react useChat
const mockSendMessage = mock(() => Promise.resolve());
const mockSetMessages = mock();

mock.module("@ai-sdk/react", () => ({
  useChat: () => ({
    messages: [],
    setMessages: mockSetMessages,
    sendMessage: mockSendMessage,
    status: "ready",
    error: undefined,
  }),
}));

mock.module("ai", () => ({
  DefaultChatTransport: class {
    constructor(public opts: Record<string, unknown>) {}
  },
  isToolUIPart: () => false,
  getToolName: () => "unknown",
  callCompletionApi: () => {},
  callChatApi: () => {},
}));

const originalFetch = globalThis.fetch;
const fetchMock = mock(() =>
  Promise.resolve(
    new Response("", { status: 200, headers: { "Content-Type": "application/json" } }),
  ),
);

beforeEach(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockClear();
  mockSendMessage.mockClear();
  mockSetMessages.mockClear();
  mockSendMessage.mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function wrapper({ children }: { children: ReactNode }) {
  return (
    <AtlasProvider apiUrl="https://api.example.com" apiKey="test-key">
      {children}
    </AtlasProvider>
  );
}

describe("useAtlasChat", () => {
  it("returns initial state with empty messages", () => {
    const { result } = renderHook(() => useAtlasChat(), { wrapper });

    expect(result.current.messages).toEqual([]);
    expect(result.current.input).toBe("");
    expect(result.current.status).toBe("ready");
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.conversationId).toBeNull();
  });

  it("accepts initialConversationId option", () => {
    const { result } = renderHook(
      () => useAtlasChat({ initialConversationId: "conv-123" }),
      { wrapper },
    );

    expect(result.current.conversationId).toBe("conv-123");
  });

  it("setInput updates the input value", () => {
    const { result } = renderHook(() => useAtlasChat(), { wrapper });

    act(() => {
      result.current.setInput("hello");
    });

    expect(result.current.input).toBe("hello");
  });

  it("sendMessage clears input and delegates to useChat", async () => {
    const { result } = renderHook(() => useAtlasChat(), { wrapper });

    act(() => {
      result.current.setInput("test query");
    });

    await act(async () => {
      await result.current.sendMessage("test query");
    });

    expect(result.current.input).toBe("");
    expect(mockSendMessage).toHaveBeenCalledWith({ text: "test query" });
  });

  it("sendMessage restores input on failure", async () => {
    mockSendMessage.mockImplementation(() =>
      Promise.reject(new Error("Stream failed")),
    );

    const { result } = renderHook(() => useAtlasChat(), { wrapper });

    act(() => {
      result.current.setInput("my query");
    });

    let caught: Error | null = null;
    await act(async () => {
      try {
        await result.current.sendMessage("my query");
      } catch (e) {
        caught = e as Error;
      }
    });

    expect(caught).not.toBeNull();
    expect(caught!.message).toBe("Stream failed");
    expect(result.current.input).toBe("my query");
  });

  it("setConversationId updates conversation ID", () => {
    const { result } = renderHook(() => useAtlasChat(), { wrapper });

    act(() => {
      result.current.setConversationId("new-conv");
    });

    expect(result.current.conversationId).toBe("new-conv");
  });

  it("setMessages is exposed from the hook", () => {
    const { result } = renderHook(() => useAtlasChat(), { wrapper });

    expect(result.current.setMessages).toBeDefined();
    expect(typeof result.current.setMessages).toBe("function");
  });

  it("exposes isLoading derived from status", () => {
    // With status "ready", isLoading should be false
    const { result } = renderHook(() => useAtlasChat(), { wrapper });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.status).toBe("ready");
  });

  it("returns null error when useChat has no error", () => {
    const { result } = renderHook(() => useAtlasChat(), { wrapper });
    expect(result.current.error).toBeNull();
  });
});
