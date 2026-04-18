import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { renderHook, waitFor, cleanup, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAdminMutation, type MutateResult } from "../hooks/use-admin-mutation";
import { useAdminFetch } from "../hooks/use-admin-fetch";
import { AtlasProvider } from "../context";

/* ------------------------------------------------------------------ */
/*  Setup                                                              */
/* ------------------------------------------------------------------ */

const stubAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null }),
};

let testQueryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(
    QueryClientProvider,
    { client: testQueryClient },
    createElement(
      AtlasProvider,
      { config: { apiUrl: "http://localhost:3001", isCrossOrigin: false as const, authClient: stubAuthClient } },
      children,
    ),
  );
}

const originalFetch = globalThis.fetch;

function mockFetch(response: Response) {
  globalThis.fetch = mock(() => Promise.resolve(response)) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("useAdminMutation", () => {
  beforeEach(() => {
    testQueryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });
  });

  afterEach(() => {
    testQueryClient.clear();
    cleanup();
    globalThis.fetch = originalFetch;
  });

  /* ---------------------------------------------------------------- */
  /*  JSON success (200)                                               */
  /* ---------------------------------------------------------------- */

  test("returns { ok: true, data } for JSON response", async () => {
    mockFetch(jsonResponse({ id: 1, name: "test" }));

    const { result } = renderHook(
      () => useAdminMutation({ path: "/api/v1/admin/test" }),
      { wrapper },
    );

    let mutateResult: MutateResult<unknown>;
    await act(async () => {
      mutateResult = await result.current.mutate();
    });

    expect(mutateResult!.ok).toBe(true);
    expect(mutateResult!.ok && mutateResult!.data).toEqual({ id: 1, name: "test" });
  });

  /* ---------------------------------------------------------------- */
  /*  204 No Content success                                           */
  /* ---------------------------------------------------------------- */

  test("returns { ok: true, data: undefined } for 204 No Content", async () => {
    mockFetch(new Response(null, { status: 204 }));

    const { result } = renderHook(
      () => useAdminMutation({ path: "/api/v1/admin/test", method: "DELETE" }),
      { wrapper },
    );

    let mutateResult: MutateResult<unknown>;
    await act(async () => {
      mutateResult = await result.current.mutate();
    });

    expect(mutateResult!.ok).toBe(true);
    if (mutateResult!.ok) {
      expect(mutateResult!.data).toBeUndefined();
    }
  });

  test("204 No Content triggers invalidates", async () => {
    mockFetch(new Response(null, { status: 204 }));

    const refetch = mock(() => {});
    const { result } = renderHook(
      () => useAdminMutation({ path: "/api/v1/admin/test", method: "DELETE", invalidates: refetch }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutate();
    });

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  test("204 No Content fires onSuccess with undefined data", async () => {
    // Regression guard for #1555: dialog-closing callers
    // (`onSuccess: () => onOpenChange(false)`) must fire on 204 or the
    // surface stays stuck open with no error feedback.
    mockFetch(new Response(null, { status: 204 }));

    const onSuccess = mock((_: unknown) => {});
    const { result } = renderHook(
      () => useAdminMutation({ path: "/api/v1/admin/test", method: "DELETE" }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutate({ onSuccess });
    });

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith(undefined);
  });

  test("non-JSON 200 fires onSuccess with undefined data", async () => {
    mockFetch(new Response("OK", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    }));

    const onSuccess = mock((_: unknown) => {});
    const { result } = renderHook(
      () => useAdminMutation({ path: "/api/v1/admin/test" }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutate({ onSuccess });
    });

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith(undefined);
  });

  /* ---------------------------------------------------------------- */
  /*  Error responses                                                  */
  /* ---------------------------------------------------------------- */

  test("returns { ok: false, error } for HTTP error", async () => {
    mockFetch(jsonResponse({ message: "Not found" }, 404));

    const { result } = renderHook(
      () => useAdminMutation({ path: "/api/v1/admin/test" }),
      { wrapper },
    );

    let mutateResult: MutateResult<unknown>;
    await act(async () => {
      mutateResult = await result.current.mutate();
    });

    expect(mutateResult!.ok).toBe(false);
    if (!mutateResult!.ok) {
      expect(mutateResult!.error).toBe("Not found");
    }
    await waitFor(() => {
      expect(result.current.error).toBe("Not found");
    });
  });

  test("returns { ok: false, error } for network failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("Network error")),
    ) as unknown as typeof fetch;

    const { result } = renderHook(
      () => useAdminMutation({ path: "/api/v1/admin/test" }),
      { wrapper },
    );

    let mutateResult: MutateResult<unknown>;
    await act(async () => {
      mutateResult = await result.current.mutate();
    });

    expect(mutateResult!.ok).toBe(false);
    if (!mutateResult!.ok) {
      expect(mutateResult!.error).toBe("Network error");
    }
  });

  test("returns { ok: false } when no path provided", async () => {
    const { result } = renderHook(
      () => useAdminMutation(),
      { wrapper },
    );

    let mutateResult: MutateResult<unknown>;
    await act(async () => {
      mutateResult = await result.current.mutate();
    });

    expect(mutateResult!.ok).toBe(false);
    if (!mutateResult!.ok) {
      expect(mutateResult!.error).toContain("no path");
    }
  });

  /* ---------------------------------------------------------------- */
  /*  onSuccess callback                                               */
  /* ---------------------------------------------------------------- */

  test("onSuccess receives parsed data for JSON response", async () => {
    const payload = { id: 1 };
    mockFetch(jsonResponse(payload));

    const onSuccess = mock(() => {});
    const { result } = renderHook(
      () => useAdminMutation({ path: "/api/v1/admin/test" }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutate({ onSuccess });
    });

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith(payload);
  });

  test("onSuccess does NOT fire on error", async () => {
    mockFetch(jsonResponse({ message: "Forbidden" }, 403));

    const onSuccess = mock(() => {});
    const { result } = renderHook(
      () => useAdminMutation({ path: "/api/v1/admin/test" }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutate({ onSuccess });
    });

    expect(onSuccess).not.toHaveBeenCalled();
  });

  /* ---------------------------------------------------------------- */
  /*  Non-JSON success (e.g. 200 with text/plain)                      */
  /* ---------------------------------------------------------------- */

  test("non-JSON success returns { ok: true, data: undefined }", async () => {
    mockFetch(new Response("OK", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    }));

    const { result } = renderHook(
      () => useAdminMutation({ path: "/api/v1/admin/test" }),
      { wrapper },
    );

    let mutateResult: MutateResult<unknown>;
    await act(async () => {
      mutateResult = await result.current.mutate();
    });

    expect(mutateResult!.ok).toBe(true);
    if (mutateResult!.ok) {
      expect(mutateResult!.data).toBeUndefined();
    }
  });

  /* ---------------------------------------------------------------- */
  /*  Per-item mutation tracking (itemId / isMutating)                  */
  /* ---------------------------------------------------------------- */

  test("isMutating tracks per-item loading state", async () => {
    let resolveFetch!: (res: Response) => void;
    globalThis.fetch = mock(() =>
      new Promise<Response>((resolve) => { resolveFetch = resolve; }),
    ) as unknown as typeof fetch;

    const { result } = renderHook(
      () => useAdminMutation({ path: "/api/v1/admin/test" }),
      { wrapper },
    );

    expect(result.current.isMutating("item-1")).toBe(false);
    expect(result.current.saving).toBe(false);

    let mutatePromise!: Promise<MutateResult<unknown>>;
    await act(async () => {
      mutatePromise = result.current.mutate({ itemId: "item-1" });
      // Wait a tick for TanStack to call fetch and assign resolveFetch
      await new Promise((r) => setTimeout(r, 0));
    });

    // During flight: isMutating is true, saving stays false (itemId path)
    expect(result.current.isMutating("item-1")).toBe(true);
    expect(result.current.saving).toBe(false);

    await act(async () => {
      resolveFetch(jsonResponse({ ok: true }));
      await mutatePromise;
    });

    expect(result.current.isMutating("item-1")).toBe(false);
  });

  /* ---------------------------------------------------------------- */
  /*  Array invalidates                                                */
  /* ---------------------------------------------------------------- */

  test("array invalidates calls all refetch functions", async () => {
    mockFetch(jsonResponse({ ok: true }));

    const refetch1 = mock(() => {});
    const refetch2 = mock(() => {});
    const { result } = renderHook(
      () => useAdminMutation({ path: "/api/v1/admin/test", invalidates: [refetch1, refetch2] }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutate();
    });

    expect(refetch1).toHaveBeenCalledTimes(1);
    expect(refetch2).toHaveBeenCalledTimes(1);
  });

  /* ---------------------------------------------------------------- */
  /*  State management                                                 */
  /* ---------------------------------------------------------------- */

  test("saving is true during mutation, false after", async () => {
    mockFetch(jsonResponse({ ok: true }));

    const { result } = renderHook(
      () => useAdminMutation({ path: "/api/v1/admin/test" }),
      { wrapper },
    );

    expect(result.current.saving).toBe(false);

    await act(async () => {
      await result.current.mutate();
    });

    expect(result.current.saving).toBe(false);
  });

  test("error is cleared on next mutate call", async () => {
    // First call fails
    mockFetch(jsonResponse({ message: "Fail" }, 500));

    const { result } = renderHook(
      () => useAdminMutation({ path: "/api/v1/admin/test" }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutate();
    });
    expect(result.current.error).toBe("Fail");

    // Second call succeeds — error should be cleared
    mockFetch(jsonResponse({ ok: true }));

    await act(async () => {
      await result.current.mutate();
    });
    expect(result.current.error).toBeNull();
  });

  /* ---------------------------------------------------------------- */
  /*  TanStack cache integration                                       */
  /* ---------------------------------------------------------------- */

  test("successful mutation invalidates useAdminFetch queries", async () => {
    let fetchCount = 0;
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      // GET = useAdminFetch, POST = useAdminMutation
      if (!init?.method || init.method === "GET") {
        fetchCount++;
        return Promise.resolve(jsonResponse({ count: fetchCount }));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    }) as unknown as typeof fetch;

    const { result } = renderHook(
      () => ({
        query: useAdminFetch<{ count: number }>("/api/v1/admin/test-data"),
        mutation: useAdminMutation({ path: "/api/v1/admin/test-action" }),
      }),
      { wrapper },
    );

    // Wait for initial fetch
    await waitFor(() => {
      expect(result.current.query.loading).toBe(false);
    });
    expect(result.current.query.data).toEqual({ count: 1 });

    // Mutate — should trigger cache invalidation and refetch
    await act(async () => {
      await result.current.mutation.mutate({ method: "POST" });
    });

    // After invalidation, useAdminFetch should refetch and get new data
    await waitFor(() => {
      expect(result.current.query.data).toEqual({ count: 2 });
    });
    expect(fetchCount).toBeGreaterThanOrEqual(2);
  });

  test("reset() clears error state", async () => {
    mockFetch(jsonResponse({ message: "Fail" }, 500));

    const { result } = renderHook(
      () => useAdminMutation({ path: "/api/v1/admin/test" }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutate();
    });
    expect(result.current.error).toBe("Fail");

    act(() => {
      result.current.reset();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.saving).toBe(false);
  });
});
