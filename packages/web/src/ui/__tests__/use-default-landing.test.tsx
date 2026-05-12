import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { renderHook, waitFor, cleanup } from "@testing-library/react";

mock.module("@/lib/api-url", () => ({
  getApiUrl: () => "http://localhost:3001",
  isCrossOrigin: () => false,
}));

import { useDefaultLanding } from "../hooks/use-default-landing";

const originalFetch = globalThis.fetch;

function mockFetch(handler: (input: RequestInfo | URL) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    handler(input)) as typeof globalThis.fetch;
}

beforeEach(() => {
  // Re-mount fresh between tests so the in-hook fetchedRef.current=true
  // gate doesn't suppress the second test's request.
  cleanup();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("useDefaultLanding", () => {
  test("returns chat by default when the endpoint responds with chat", async () => {
    mockFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ defaultLanding: "chat" }), { status: 200 }),
      ),
    );

    const { result } = renderHook(() => useDefaultLanding(true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.defaultLanding).toBe("chat");
  });

  test("returns admin when the endpoint flips the preference", async () => {
    mockFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ defaultLanding: "admin" }), { status: 200 }),
      ),
    );

    const { result } = renderHook(() => useDefaultLanding(true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.defaultLanding).toBe("admin");
  });

  test("falls back to chat on 404 (self-hosted-local — no preference column)", async () => {
    mockFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "not_available" }), { status: 404 }),
      ),
    );

    const { result } = renderHook(() => useDefaultLanding(true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.defaultLanding).toBe("chat");
  });

  test("does not fetch when disabled (session still pending)", async () => {
    let fetchCount = 0;
    mockFetch(() => {
      fetchCount += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ defaultLanding: "admin" }), { status: 200 }),
      );
    });

    const { result } = renderHook(() => useDefaultLanding(false));
    // Without an awaited fetch, loading flips to false on the first effect run.
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchCount).toBe(0);
    expect(result.current.defaultLanding).toBe("chat");
  });
});
