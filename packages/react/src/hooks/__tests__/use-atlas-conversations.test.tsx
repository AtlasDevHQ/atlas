import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { renderHook, waitFor, act } from "@testing-library/react";
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
  // mockClear only clears call history, not implementation — restore the default
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({ conversations: mockConversations, total: 1 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ),
  );
  fetchMock.mockClear();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
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
    expect(result.current.isLoading).toBe(false);
    expect(result.current.available).toBe(true);
    expect(result.current.selectedId).toBeNull();
  });

  it("fetches conversations with correct auth headers", async () => {
    const { result } = renderHook(
      () => useAtlasConversations({ enabled: true }),
      { wrapper },
    );

    await result.current.refresh();

    await waitFor(() => {
      expect(result.current.conversations).toHaveLength(1);
    });

    expect(result.current.conversations[0].id).toBe("conv-1");
    expect(result.current.total).toBe(1);

    // Verify fetch called with correct URL and auth header
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0][0]).toBe("https://api.example.com/api/v1/conversations?limit=50");
    const headers = calls[0][1]?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-key");
  });

  it("disables on 404 response", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response("", { status: 404 })),
    );

    const { result } = renderHook(
      () => useAtlasConversations({ enabled: true }),
      { wrapper },
    );

    await result.current.refresh();

    await waitFor(() => {
      expect(result.current.available).toBe(false);
    });
  });

  it("deleteConversation removes from local state", async () => {
    const { result } = renderHook(
      () => useAtlasConversations({ enabled: true }),
      { wrapper },
    );

    // Wait for TanStack Query to load the initial data
    await waitFor(() => {
      expect(result.current.conversations).toHaveLength(1);
    });

    // Mock DELETE response (also returns empty list for any subsequent GET refetch)
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return Promise.resolve(new Response("", { status: 200 }));
      }
      return Promise.resolve(new Response(
        JSON.stringify({ conversations: [], total: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));
    });

    await act(async () => {
      await result.current.deleteConversation("conv-1");
    });
    await waitFor(() => {
      expect(result.current.conversations).toHaveLength(0);
    });
    expect(result.current.total).toBe(0);
  });

  it("starConversation does optimistic update and rolls back on failure", async () => {
    const { result } = renderHook(
      () => useAtlasConversations({ enabled: true }),
      { wrapper },
    );

    // Wait for TanStack Query to load the initial data
    await waitFor(() => {
      expect(result.current.conversations).toHaveLength(1);
    });

    // Mock PATCH to fail
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response("", { status: 500 })),
    );

    await act(async () => {
      await expect(
        result.current.starConversation("conv-1", true),
      ).rejects.toThrow("Failed to update star (HTTP 500)");
    });
    // Should roll back to unstarred
    expect(result.current.conversations[0].starred).toBe(false);
  });
});
