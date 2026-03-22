import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { renderHook, waitFor, cleanup, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { friendlyError, useAdminFetch, type FetchError } from "../hooks/use-admin-fetch";
import { AtlasUIProvider } from "../context";

/* ------------------------------------------------------------------ */
/*  friendlyError (pure function)                                      */
/* ------------------------------------------------------------------ */

describe("friendlyError", () => {
  test("returns auth message for 401", () => {
    const err: FetchError = { message: "HTTP 401", status: 401 };
    expect(friendlyError(err)).toContain("Not authenticated");
  });

  test("returns access denied for 403", () => {
    const err: FetchError = { message: "HTTP 403", status: 403 };
    expect(friendlyError(err)).toContain("Access denied");
    expect(friendlyError(err)).toContain("Admin role");
  });

  test("returns feature not enabled for 404", () => {
    const err: FetchError = { message: "HTTP 404", status: 404 };
    expect(friendlyError(err)).toContain("not enabled");
  });

  test("returns raw message for other errors", () => {
    const err: FetchError = { message: "Connection refused" };
    expect(friendlyError(err)).toBe("Connection refused");
  });

  test("returns raw message for 500", () => {
    const err: FetchError = { message: "Internal Server Error", status: 500 };
    expect(friendlyError(err)).toBe("Internal Server Error");
  });

  test("appends requestId when present", () => {
    const err: FetchError = { message: "Internal Server Error", status: 500, requestId: "req-xyz" };
    expect(friendlyError(err)).toBe("Internal Server Error (Request ID: req-xyz)");
  });

  test("appends requestId to status-specific messages", () => {
    const err: FetchError = { message: "HTTP 401", status: 401, requestId: "req-abc" };
    expect(friendlyError(err)).toContain("Not authenticated");
    expect(friendlyError(err)).toContain("(Request ID: req-abc)");
  });
});

/* ------------------------------------------------------------------ */
/*  useAdminFetch hook                                                 */
/* ------------------------------------------------------------------ */

const stubAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null }),
};

function wrapper({ children }: { children: ReactNode }) {
  return createElement(
    AtlasUIProvider,
    { config: { apiUrl: "http://localhost:3001", isCrossOrigin: false as const, authClient: stubAuthClient }, children },
  );
}

const originalFetch = globalThis.fetch;

describe("useAdminFetch", () => {
  beforeEach(() => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ value: 42 }), { status: 200 })),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  test("starts in loading state", () => {
    const { result } = renderHook(() => useAdminFetch<{ value: number }>("/api/test"), { wrapper });
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  test("fetches data and sets loading to false", async () => {
    const { result } = renderHook(() => useAdminFetch<{ value: number }>("/api/test"), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toEqual({ value: 42 });
    expect(result.current.error).toBeNull();
  });

  test("sets error on non-OK response with non-JSON body", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("", { status: 403 })),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useAdminFetch("/api/test"), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).not.toBeNull();
    expect(result.current.error!.status).toBe(403);
    expect(result.current.error!.message).toBe("HTTP 403");
    expect(result.current.error!.requestId).toBeUndefined();
    expect(result.current.data).toBeNull();
  });

  test("extracts message and requestId from JSON error body", async () => {
    const body = JSON.stringify({ message: "Failed to fetch usage summary", requestId: "req-abc123" });
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(body, { status: 500, headers: { "Content-Type": "application/json" } })),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useAdminFetch("/api/test"), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).not.toBeNull();
    expect(result.current.error!.status).toBe(500);
    expect(result.current.error!.message).toBe("Failed to fetch usage summary");
    expect(result.current.error!.requestId).toBe("req-abc123");
  });

  test("extracts message without requestId from JSON error body", async () => {
    const body = JSON.stringify({ message: "Rate limit exceeded" });
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(body, { status: 429, headers: { "Content-Type": "application/json" } })),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useAdminFetch("/api/test"), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).not.toBeNull();
    expect(result.current.error!.status).toBe(429);
    expect(result.current.error!.message).toBe("Rate limit exceeded");
    expect(result.current.error!.requestId).toBeUndefined();
  });

  test("sets error on network failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("Network error")),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useAdminFetch("/api/test"), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).not.toBeNull();
    expect(result.current.error!.message).toBe("Network error");
  });

  test("applies transform function", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ items: [1, 2, 3] }), { status: 200 })),
    ) as unknown as typeof fetch;

    const { result } = renderHook(
      () => useAdminFetch<number>("/api/test", { transform: (json: unknown) => (json as { items: number[] }).items.length }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toBe(3);
  });

  test("refetch re-fetches data", async () => {
    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;
      return Promise.resolve(new Response(JSON.stringify({ n: callCount }), { status: 200 }));
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useAdminFetch<{ n: number }>("/api/test"), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.data).toEqual({ n: 1 });

    await act(async () => {
      result.current.refetch();
    });

    await waitFor(() => {
      expect(result.current.data).toEqual({ n: 2 });
    });
  });

  test("uses same-origin credentials when not cross-origin", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    renderHook(() => useAdminFetch("/api/test"), { wrapper });

    await waitFor(() => {
      expect((fetchMock as unknown as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0);
    });

    const [, opts] = (fetchMock as unknown as ReturnType<typeof mock>).mock.calls[0] as [string, RequestInit];
    expect(opts.credentials).toBe("same-origin");
  });

  test("silently ignores AbortError on unmount", async () => {
    // Simulate a fetch that takes time, then abort
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const { result, unmount } = renderHook(() => useAdminFetch("/api/test"), { wrapper });

    // Component is still loading
    expect(result.current.loading).toBe(true);

    // Unmount triggers abort
    unmount();

    // No error should be set (AbortError is silently ignored)
    // Loading stays true because the finally block checks signal.aborted
    expect(result.current.error).toBeNull();
  });
});
