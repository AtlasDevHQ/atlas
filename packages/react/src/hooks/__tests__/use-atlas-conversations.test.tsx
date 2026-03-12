import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import { AtlasProvider } from "../provider";
import { useAtlasConversations } from "../use-atlas-conversations";
import type { ReactNode } from "react";

const mockConversations = [
  {
    id: "conv-1",
    userId: "user-1",
    title: "Test conversation",
    surface: "web",
    connectionId: null,
    starred: false,
    createdAt: "2026-03-12T00:00:00Z",
    updatedAt: "2026-03-12T00:00:00Z",
  },
];

const fetchMock = mock(() =>
  Promise.resolve(
    new Response(
      JSON.stringify({ conversations: mockConversations, total: 1 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  ),
);

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockClear();
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

describe("useAtlasConversations", () => {
  it("initializes with empty state", () => {
    const { result } = renderHook(
      () => useAtlasConversations({ enabled: false }),
      { wrapper },
    );

    expect(result.current.conversations).toEqual([]);
    expect(result.current.total).toBe(0);
    expect(result.current.loading).toBe(false);
    expect(result.current.available).toBe(true);
    expect(result.current.selectedId).toBeNull();
  });

  it("fetches conversations when enabled", async () => {
    const { result } = renderHook(
      () => useAtlasConversations({ enabled: true }),
      { wrapper },
    );

    await result.current.fetchList();

    await waitFor(() => {
      expect(result.current.conversations).toHaveLength(1);
    });

    expect(result.current.conversations[0].id).toBe("conv-1");
    expect(result.current.total).toBe(1);
  });

  it("disables on 404 response", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response("", { status: 404 })),
    );

    const { result } = renderHook(
      () => useAtlasConversations({ enabled: true }),
      { wrapper },
    );

    await result.current.fetchList();

    await waitFor(() => {
      expect(result.current.available).toBe(false);
    });
  });

  it("exposes CRUD methods", () => {
    const { result } = renderHook(
      () => useAtlasConversations({ enabled: false }),
      { wrapper },
    );

    expect(typeof result.current.fetchList).toBe("function");
    expect(typeof result.current.loadConversation).toBe("function");
    expect(typeof result.current.deleteConversation).toBe("function");
    expect(typeof result.current.starConversation).toBe("function");
    expect(typeof result.current.refresh).toBe("function");
    expect(typeof result.current.setSelectedId).toBe("function");
  });
});
