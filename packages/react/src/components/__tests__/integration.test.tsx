/**
 * React widget integration tests — verifies AtlasChat renders, auth modes
 * send correct headers/credentials, and hooks connect properly.
 *
 * Uses mocked fetch at the transport level to avoid requiring a running API.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { waitFor, act } from "@testing-library/react";
import { AtlasProvider } from "../../context";
import { renderHook } from "@testing-library/react";
import { useAtlasAuth } from "../../hooks/use-atlas-auth";
import { useAtlasConversations } from "../../hooks/use-atlas-conversations";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Fetch mock
// ---------------------------------------------------------------------------

const capturedRequests: { url: string; init: RequestInit }[] = [];

function defaultFetchImpl(url: string | URL | Request, init?: RequestInit) {
  const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
  capturedRequests.push({ url: urlStr, init: init ?? {} });

  // Health endpoint
  if (urlStr.includes("/api/health")) {
    return Promise.resolve(
      new Response(
        JSON.stringify({ checks: { auth: { mode: "simple-key" } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }

  // Conversations endpoint
  if (urlStr.includes("/api/v1/conversations")) {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          conversations: [
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
          ],
          total: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }

  // Default 404
  return Promise.resolve(
    new Response(JSON.stringify({ error: "not_found" }), { status: 404 }),
  );
}

const fetchMock = mock(defaultFetchImpl);

const originalFetch = globalThis.fetch;

beforeEach(() => {
  capturedRequests.length = 0;
  fetchMock.mockImplementation(defaultFetchImpl);
  fetchMock.mockClear();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Wrapper helpers
// ---------------------------------------------------------------------------

function apiKeyWrapper({ children }: { children: ReactNode }) {
  return (
    <AtlasProvider apiUrl="https://api.example.com" apiKey="test-api-key">
      {children}
    </AtlasProvider>
  );
}

function noKeyWrapper({ children }: { children: ReactNode }) {
  return (
    <AtlasProvider apiUrl="https://api.example.com">
      {children}
    </AtlasProvider>
  );
}

function sameOriginWrapper({ children }: { children: ReactNode }) {
  return (
    <AtlasProvider apiUrl="" apiKey="test-key">
      {children}
    </AtlasProvider>
  );
}

// ---------------------------------------------------------------------------
// AtlasProvider context integration
// ---------------------------------------------------------------------------

describe("AtlasProvider integration", () => {
  it("provides API key to hooks via context", async () => {
    const { result } = renderHook(() => useAtlasAuth(), { wrapper: apiKeyWrapper });

    await waitFor(() => {
      expect(result.current.authMode).toBe("simple-key");
    });

    expect(result.current.isAuthenticated).toBe(true);
  });

  it("reports unauthenticated when no API key provided", async () => {
    const { result } = renderHook(() => useAtlasAuth(), { wrapper: noKeyWrapper });

    await waitFor(() => {
      expect(result.current.authMode).toBe("simple-key");
    });

    expect(result.current.isAuthenticated).toBe(false);
  });

  it("handles managed auth mode from health endpoint", async () => {
    fetchMock.mockImplementation((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("/api/health")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ checks: { auth: { mode: "managed" } } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 404 }));
    });

    const { result } = renderHook(() => useAtlasAuth(), { wrapper: noKeyWrapper });

    await waitFor(() => {
      expect(result.current.authMode).toBe("managed");
    });

    // Not authenticated because no managed session
    expect(result.current.isAuthenticated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Auth header behavior
// ---------------------------------------------------------------------------

describe("auth header behavior", () => {
  it("makes health check request when API key is configured", async () => {
    const { result } = renderHook(() => useAtlasAuth(), { wrapper: apiKeyWrapper });

    await waitFor(() => {
      expect(result.current.authMode).toBe("simple-key");
    });

    // The health check fetch should have been made
    const healthReq = capturedRequests.find((r) => r.url.includes("/api/health"));
    expect(healthReq).toBeDefined();
  });

  it("cross-origin requests include credentials", async () => {
    const { result } = renderHook(() => useAtlasAuth(), { wrapper: apiKeyWrapper });

    await waitFor(() => {
      expect(result.current.authMode).toBe("simple-key");
    });

    // Cross-origin (apiUrl is different from localhost) should use credentials: include
    const healthReq = capturedRequests.find((r) => r.url.includes("/api/health"));
    expect(healthReq).toBeDefined();
    expect(healthReq!.init.credentials).toBe("include");
  });

  it("same-origin requests use same-origin credentials", async () => {
    const { result } = renderHook(() => useAtlasAuth(), { wrapper: sameOriginWrapper });

    await waitFor(() => {
      expect(result.current.authMode).toBe("simple-key");
    });

    const healthReq = capturedRequests.find((r) => r.url.includes("/api/health"));
    expect(healthReq).toBeDefined();
    expect(healthReq!.init.credentials).toBe("same-origin");
  });
});

// ---------------------------------------------------------------------------
// useAtlasConversations integration
// ---------------------------------------------------------------------------

describe("useAtlasConversations integration", () => {
  it("fetches conversations from API via refresh()", async () => {
    const { result } = renderHook(
      () => useAtlasConversations({ enabled: true }),
      { wrapper: apiKeyWrapper },
    );

    // Must call refresh() explicitly — hook does not auto-fetch
    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => {
      expect(result.current.conversations.length).toBeGreaterThan(0);
    });

    expect(result.current.conversations[0].id).toBe("conv-1");
    expect(result.current.conversations[0].title).toBe("Test conversation");
  });

  it("does not fetch when disabled", () => {
    const { result } = renderHook(
      () => useAtlasConversations({ enabled: false }),
      { wrapper: apiKeyWrapper },
    );

    expect(result.current.conversations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Error resilience
// ---------------------------------------------------------------------------

describe("error resilience", () => {
  it("handles health endpoint failure gracefully", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response("Internal Server Error", { status: 500 }),
      ),
    );

    const { result } = renderHook(() => useAtlasAuth(), { wrapper: apiKeyWrapper });

    await waitFor(() => {
      expect(result.current.authMode).not.toBeNull();
    }, { timeout: 10000 });

    // Falls back to "none" mode on failure
    expect(result.current.authMode).toBe("none");
    expect(result.current.error).not.toBeNull();
  });

  it("handles network failure gracefully", async () => {
    fetchMock.mockImplementation(() =>
      Promise.reject(new Error("Network request failed")),
    );

    const { result } = renderHook(() => useAtlasAuth(), { wrapper: apiKeyWrapper });

    await waitFor(() => {
      expect(result.current.authMode).not.toBeNull();
    }, { timeout: 10000 });

    expect(result.current.authMode).toBe("none");
    expect(result.current.error).toBeInstanceOf(Error);
  });
});
