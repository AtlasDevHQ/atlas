import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { renderHook, waitFor, cleanup, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { z } from "zod";
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

  test("falls back to HTTP status when JSON body has no message field", async () => {
    const body = JSON.stringify({ error: "something_broke" });
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(body, { status: 502, headers: { "Content-Type": "application/json" } })),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useAdminFetch("/api/test"), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).not.toBeNull();
    expect(result.current.error!.status).toBe(502);
    expect(result.current.error!.message).toBe("HTTP 502");
    expect(result.current.error!.requestId).toBeUndefined();
  });

  test("falls back to HTTP status when JSON body is a non-object value", async () => {
    const body = JSON.stringify([1, 2, 3]);
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(body, { status: 500, headers: { "Content-Type": "application/json" } })),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useAdminFetch("/api/test"), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).not.toBeNull();
    expect(result.current.error!.status).toBe(500);
    expect(result.current.error!.message).toBe("HTTP 500");
    expect(result.current.error!.requestId).toBeUndefined();
  });

  test("extracts requestId even without message field", async () => {
    const body = JSON.stringify({ error: "internal", requestId: "req-orphan" });
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(body, { status: 500, headers: { "Content-Type": "application/json" } })),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useAdminFetch("/api/test"), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).not.toBeNull();
    expect(result.current.error!.message).toBe("HTTP 500");
    expect(result.current.error!.requestId).toBe("req-orphan");
  });

  test("sets error on network failure and logs warning", async () => {
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args); };

    globalThis.fetch = mock(() =>
      Promise.reject(new Error("Network error")),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useAdminFetch("/api/test"), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).not.toBeNull();
    expect(result.current.error!.message).toBe("Network error");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]![0]).toContain("useAdminFetch");

    console.warn = originalWarn;
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

  test("clears stale data when refetch returns HTTP error", async () => {
    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;
      // First call: success. Second call: HTTP 500.
      if (callCount === 1) {
        return Promise.resolve(new Response(JSON.stringify({ value: 42 }), { status: 200 }));
      }
      return Promise.resolve(new Response(
        JSON.stringify({ message: "Internal error" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      ));
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useAdminFetch<{ value: number }>("/api/test"), { wrapper });

    // First fetch succeeds
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.data).toEqual({ value: 42 });
    expect(result.current.error).toBeNull();

    // Refetch returns HTTP 500 — stale data must be cleared
    await act(async () => {
      result.current.refetch();
    });

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.data).toBeNull();
    expect(result.current.error!.status).toBe(500);
    expect(result.current.error!.message).toBe("Internal error");
  });

  test("clears stale data when refetch throws network error", async () => {
    let callCount = 0;
    const originalWarn = console.warn;
    console.warn = mock(() => {}) as typeof console.warn;

    globalThis.fetch = mock(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(new Response(JSON.stringify({ value: 7 }), { status: 200 }));
      }
      return Promise.reject(new Error("Network error"));
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useAdminFetch<{ value: number }>("/api/test"), { wrapper });

    // First fetch succeeds
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.data).toEqual({ value: 7 });
    expect(result.current.error).toBeNull();

    // Refetch throws network error — stale data must be cleared
    await act(async () => {
      result.current.refetch();
    });

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.data).toBeNull();
    expect(result.current.error!.message).toBe("Network error");

    console.warn = originalWarn;
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

  test("validates response with schema and returns parsed data", async () => {
    const TestSchema = z.object({ name: z.string(), count: z.number() });

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ name: "atlas", count: 42 }), { status: 200 })),
    ) as unknown as typeof fetch;

    const { result } = renderHook(
      () => useAdminFetch("/api/test", { schema: TestSchema }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toEqual({ name: "atlas", count: 42 });
    expect(result.current.error).toBeNull();
  });

  test("sets error when schema validation fails", async () => {
    const TestSchema = z.object({ name: z.string(), count: z.number() });

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ name: "atlas", count: "not-a-number" }), { status: 200 })),
    ) as unknown as typeof fetch;

    const warnMock = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnMock as typeof console.warn;

    const { result } = renderHook(
      () => useAdminFetch("/api/test", { schema: TestSchema }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toBeNull();
    expect(result.current.error).not.toBeNull();
    expect(result.current.error!.message).toContain("Unexpected response format");
    expect(result.current.error!.message).toContain("/api/test");
    expect(warnMock).toHaveBeenCalled();

    console.warn = originalWarn;
  });

  test("sets error when schema validation fails on missing field", async () => {
    const TestSchema = z.object({ name: z.string(), count: z.number() });

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ name: "atlas" }), { status: 200 })),
    ) as unknown as typeof fetch;

    const originalWarn = console.warn;
    console.warn = mock(() => {}) as typeof console.warn;

    const { result } = renderHook(
      () => useAdminFetch("/api/test", { schema: TestSchema }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).not.toBeNull();
    expect(result.current.error!.message).toContain("Unexpected response format");

    console.warn = originalWarn;
  });

  test("schema with transform extracts nested data", async () => {
    const WrappedSchema = z.object({
      items: z.array(z.string()),
    }).transform((r) => r.items);

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ items: ["a", "b", "c"] }), { status: 200 })),
    ) as unknown as typeof fetch;

    const { result } = renderHook(
      () => useAdminFetch("/api/test", { schema: WrappedSchema }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toEqual(["a", "b", "c"]);
  });

  test("clears stale data when refetch returns invalid response", async () => {
    const TestSchema = z.object({ value: z.number() });
    let callCount = 0;

    globalThis.fetch = mock(() => {
      callCount++;
      // First call: valid. Second call: invalid (string instead of number).
      const body = callCount === 1
        ? JSON.stringify({ value: 42 })
        : JSON.stringify({ value: "oops" });
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as unknown as typeof fetch;

    const originalWarn = console.warn;
    console.warn = mock(() => {}) as typeof console.warn;

    const { result } = renderHook(
      () => useAdminFetch("/api/test", { schema: TestSchema }),
      { wrapper },
    );

    // First fetch succeeds
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.data).toEqual({ value: 42 });
    expect(result.current.error).toBeNull();

    // Refetch returns invalid data — stale data must be cleared
    await act(async () => {
      result.current.refetch();
    });

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.data).toBeNull();
    expect(result.current.error!.message).toContain("Unexpected response format");

    console.warn = originalWarn;
  });

  test("schema takes precedence over transform when both provided", async () => {
    const TestSchema = z.object({ value: z.number() });

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ value: 99 }), { status: 200 })),
    ) as unknown as typeof fetch;

    const { result } = renderHook(
      () => useAdminFetch("/api/test", {
        schema: TestSchema,
        // transform would return something different — schema should win
        transform: () => ({ value: -1 }) as { value: number },
      }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Schema parsed the response (value: 99), not transform (value: -1)
    expect(result.current.data).toEqual({ value: 99 });
  });

  test("sets error when schema transform throws", async () => {
    // In Zod 4, safeParse does NOT catch transform throws — they propagate
    // to the outer catch block, which reports them as generic request errors.
    const ThrowingSchema = z.object({
      items: z.array(z.string()),
    }).transform(() => { throw new Error("transform boom"); });

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ items: ["a"] }), { status: 200 })),
    ) as unknown as typeof fetch;

    const originalWarn = console.warn;
    console.warn = mock(() => {}) as typeof console.warn;

    const { result } = renderHook(
      () => useAdminFetch("/api/test", { schema: ThrowingSchema }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toBeNull();
    expect(result.current.error).not.toBeNull();
    expect(result.current.error!.message).toContain("transform boom");

    console.warn = originalWarn;
  });
});
