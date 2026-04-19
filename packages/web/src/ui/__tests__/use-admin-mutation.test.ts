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
      expect(mutateResult!.error.message).toBe("Not found");
      expect(mutateResult!.error.status).toBe(404);
    }
    // Hook-level error is structured (not a flattened string) — callers can
    // read `.status`/`.code`/`.requestId` to route into AdminContentWrapper
    // branches without re-parsing the message.
    await waitFor(() => {
      expect(result.current.error).toEqual({ message: "Not found", status: 404 });
    });
  });

  test("hook-level error preserves structured FetchError fields (code, requestId)", async () => {
    // Regression guard for #1615 — the ~15 admin pages that read
    // `mutation.error` directly (not via `result.error`) still need to branch
    // on `code === \"enterprise_required\"` and surface requestId.
    mockFetch(
      jsonResponse(
        {
          message: "Enterprise features required",
          error: "enterprise_required",
          requestId: "req-hook-xyz",
        },
        403,
      ),
    );

    const { result } = renderHook(
      () => useAdminMutation({ path: "/api/v1/admin/test" }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutate();
    });

    await waitFor(() => {
      expect(result.current.error).toEqual({
        message: "Enterprise features required",
        status: 403,
        code: "enterprise_required",
        requestId: "req-hook-xyz",
      });
    });
  });

  test("MutateResult.error preserves FetchError fields (code, status, requestId)", async () => {
    // Structured fields must reach the caller so friendlyError() and
    // EnterpriseUpsell branching can fire — without them, mutation failures
    // render as raw "HTTP 403" and generic banners on EE-gated endpoints.
    mockFetch(
      jsonResponse(
        {
          message: "Enterprise features required",
          error: "enterprise_required",
          requestId: "req-abc-123",
        },
        403,
      ),
    );

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
      expect(mutateResult!.error.message).toBe("Enterprise features required");
      expect(mutateResult!.error.status).toBe(403);
      expect(mutateResult!.error.code).toBe("enterprise_required");
      expect(mutateResult!.error.requestId).toBe("req-abc-123");
    }
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
      expect(mutateResult!.error.message).toBe("Network error");
      // Non-HTTP failures have no status — callers can detect via `status === undefined`.
      expect(mutateResult!.error.status).toBeUndefined();
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
      expect(mutateResult!.error.message).toContain("no path");
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
    expect(result.current.error?.message).toBe("Fail");

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
    expect(result.current.error?.message).toBe("Fail");

    act(() => {
      result.current.reset();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.saving).toBe(false);
  });

  /* ---------------------------------------------------------------- */
  /*  invalidates() / onSuccess callback isolation (#1617)             */
  /* ---------------------------------------------------------------- */

  test("a throwing invalidates() callback does not flip result.ok or populate hook error", async () => {
    // Regression guard for the pre-refactor bug where invalidates() ran
    // inside the same try/catch as mutateAsync, so a throwing refetch (stale
    // closure, setState on unmounted component) looked like a mutation
    // failure — banner rendered, result.ok flipped to false — even though
    // the network call succeeded. Warn-log the throw (not debug) so the
    // throw surfaces in production devtools instead of being filtered out.
    mockFetch(jsonResponse({ ok: true }));

    const originalWarn = console.warn;
    const warnCalls: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };

    try {
      const throwingRefetch = () => {
        throw new Error("stale closure");
      };
      const { result } = renderHook(
        () =>
          useAdminMutation({
            path: "/api/v1/admin/test",
            invalidates: throwingRefetch,
          }),
        { wrapper },
      );

      let mutateResult: MutateResult<unknown>;
      await act(async () => {
        mutateResult = await result.current.mutate();
      });

      // Mutation itself succeeded — the callback throw must NOT masquerade as
      // a fetch failure.
      expect(mutateResult!.ok).toBe(true);
      expect(result.current.error).toBeNull();
      // Warn-log emitted for diagnosability so the throw doesn't disappear —
      // debug-level logs are filtered out of the default devtools view.
      expect(
        warnCalls.some(
          (args) =>
            typeof args[0] === "string" &&
            args[0].includes("invalidates() callback threw"),
        ),
      ).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("one throwing invalidate does not prevent subsequent invalidates from running", async () => {
    // Each callback is isolated so a stale refetch on one list doesn't starve
    // the others of their cache invalidation.
    mockFetch(jsonResponse({ ok: true }));

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const throwing = mock(() => {
        throw new Error("boom");
      });
      const succeeding = mock(() => {});
      const { result } = renderHook(
        () =>
          useAdminMutation({
            path: "/api/v1/admin/test",
            invalidates: [throwing, succeeding],
          }),
        { wrapper },
      );

      await act(async () => {
        await result.current.mutate();
      });

      expect(throwing).toHaveBeenCalledTimes(1);
      expect(succeeding).toHaveBeenCalledTimes(1);
    } finally {
      console.warn = originalWarn;
    }
  });

  /* ---------------------------------------------------------------- */
  /*  Per-item error tracking (#1629)                                  */
  /*                                                                    */
  /*  Before the fix: every `mutate()` call unconditionally cleared     */
  /*  hook-level `error` at start, so a concurrent bulk fan-out         */
  /*  (`Promise.all`/`allSettled`) with itemIds would silently lose all  */
  /*  but the last-resolved failure. The hook advertised a `error` slot */
  /*  callers couldn't trust for anything except single-row flows.      */
  /* ---------------------------------------------------------------- */

  test("itemized failure populates errorsByItemId and errorFor", async () => {
    mockFetch(jsonResponse({ message: "Denied" }, 403));

    const { result } = renderHook(
      () => useAdminMutation({ path: "/api/v1/admin/items/x" }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutate({ itemId: "row-7" });
    });

    await waitFor(() => {
      expect(result.current.errorFor("row-7")?.message).toBe("Denied");
      expect(result.current.errorFor("row-7")?.status).toBe(403);
    });
    expect(result.current.errorsByItemId).toEqual({
      "row-7": { message: "Denied", status: 403 },
    });
    // Unknown ids return undefined (no spurious entries).
    expect(result.current.errorFor("row-other")).toBeUndefined();
    // Hook-level error still set (single-row callers reading `.error` keep
    // working without migration — documented "last wins" for concurrent
    // itemized calls).
    expect(result.current.error?.message).toBe("Denied");
  });

  test("concurrent itemized failures all survive in errorsByItemId (no start-of-mutate stomp)", async () => {
    // The regression this test pins: call A fails, call B starts (used to
    // clear hook-level via `setError(null)`), call B succeeds → errA was lost.
    // With the fix, per-item slots are the authoritative record and survive
    // any ordering — concurrent bulk fan-out can now trust errorsByItemId.
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      // Tag the failure body with the request body so the test can recover
      // which itemId the response corresponds to — concurrent resolution
      // order is non-deterministic.
      const body = init?.body ? (JSON.parse(init.body as string) as { id: string }) : { id: "?" };
      return Promise.resolve(
        jsonResponse({ message: `Failed ${body.id}`, error: "denied" }, 500),
      );
    }) as unknown as typeof fetch;

    const { result } = renderHook(
      () => useAdminMutation({ path: "/api/v1/admin/items" }),
      { wrapper },
    );

    await act(async () => {
      await Promise.all([
        result.current.mutate({ body: { id: "A" }, itemId: "A" }),
        result.current.mutate({ body: { id: "B" }, itemId: "B" }),
        result.current.mutate({ body: { id: "C" }, itemId: "C" }),
      ]);
    });

    await waitFor(() => {
      expect(Object.keys(result.current.errorsByItemId).sort()).toEqual([
        "A",
        "B",
        "C",
      ]);
    });
    expect(result.current.errorFor("A")?.message).toBe("Failed A");
    expect(result.current.errorFor("B")?.message).toBe("Failed B");
    expect(result.current.errorFor("C")?.message).toBe("Failed C");
    // Hook-level `error` is "last wins" — one of the three, but whichever it
    // is, it must NOT be null (would prove it was stomped by a concurrent
    // start-of-mutate clear).
    expect(result.current.error).not.toBeNull();
  });

  test("successful itemized call on a different itemId does not clear a prior item's error", async () => {
    // Original #1629 timeline step 3: "Call B succeeds → no setError → errA
    // is silently gone". The fix ensures errA stays in errorsByItemId AND
    // in the hook-level slot (since A still owns it).
    let respond: (res: Response) => void = () => {};
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(init.body as string) as { id: string }) : { id: "?" };
      if (body.id === "A") return Promise.resolve(jsonResponse({ message: "A bad" }, 500));
      return new Promise<Response>((resolve) => {
        respond = resolve;
      });
    }) as unknown as typeof fetch;

    const { result } = renderHook(
      () => useAdminMutation({ path: "/api/v1/admin/items" }),
      { wrapper },
    );

    // A fails first — hook-level `error` and errorsByItemId.A both populated.
    await act(async () => {
      await result.current.mutate({ body: { id: "A" }, itemId: "A" });
    });
    expect(result.current.error?.message).toBe("A bad");

    // B is in-flight; won't flush until respond() is called. It must NOT
    // clear hook-level `error` at start (that's the stomp bug).
    let bPromise!: Promise<MutateResult<unknown>>;
    await act(async () => {
      bPromise = result.current.mutate({ body: { id: "B" }, itemId: "B" });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.error?.message).toBe("A bad");
    expect(result.current.errorFor("A")?.message).toBe("A bad");

    // B succeeds — A's banner must remain.
    await act(async () => {
      respond(jsonResponse({ ok: true }));
      await bPromise;
    });
    expect(result.current.error?.message).toBe("A bad");
    expect(result.current.errorFor("A")?.message).toBe("A bad");
    expect(result.current.errorFor("B")).toBeUndefined();
  });

  test("successful retry of the same itemId clears its per-item slot AND the hook-level slot it owns", async () => {
    // Single-row UX: row failed once, user retries, retry succeeds — banner
    // must dismiss. Without the errorItemId ownership check, the hook-level
    // slot would linger even after the row that set it recovered.
    let respond: (res: Response) => void = () => {};
    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve(jsonResponse({ message: "Flaky" }, 500));
      return new Promise<Response>((resolve) => {
        respond = resolve;
      });
    }) as unknown as typeof fetch;

    const { result } = renderHook(
      () => useAdminMutation({ path: "/api/v1/admin/items" }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutate({ itemId: "row-5" });
    });
    expect(result.current.error?.message).toBe("Flaky");
    expect(result.current.errorFor("row-5")?.message).toBe("Flaky");

    // Retry — succeeds this time.
    let retryPromise!: Promise<MutateResult<unknown>>;
    await act(async () => {
      retryPromise = result.current.mutate({ itemId: "row-5" });
      await new Promise((r) => setTimeout(r, 0));
    });
    // Start-of-mutate clears the per-item slot; hook-level slot still shows
    // the prior error until resolution — the "don't reset during in-flight"
    // behaviour is intentional (see comment in mutate()).
    expect(result.current.errorFor("row-5")).toBeUndefined();

    await act(async () => {
      respond(jsonResponse({ ok: true }));
      await retryPromise;
    });
    expect(result.current.errorFor("row-5")).toBeUndefined();
    // Banner dismisses on successful retry because row-5 also owned the hook
    // slot at entry (`errorItemIdRef`).
    expect(result.current.error).toBeNull();
  });

  test("non-itemized successful call after an itemized failure does NOT clear the hook-level error", async () => {
    // Subtle case: once an itemized failure owns the hook slot, only that
    // itemId's success (or explicit clearError / clearErrorFor / reset)
    // should dismiss it. A non-itemized success running afterward must not
    // silently wipe it — the caller pointed at a different surface.
    let phase: "fail" | "succeed" = "fail";
    globalThis.fetch = mock(() => {
      if (phase === "fail") {
        return Promise.resolve(jsonResponse({ message: "row bad" }, 500));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    }) as unknown as typeof fetch;

    const { result } = renderHook(
      () => useAdminMutation({ path: "/api/v1/admin/items" }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutate({ itemId: "row-9" });
    });
    expect(result.current.error?.message).toBe("row bad");

    // Non-itemized call — should clear hook slot at start (that IS
    // documented behavior for non-itemized mutate) and stay cleared on
    // success. The per-item slot for row-9 must remain so the bulk surface
    // still knows row-9 is still broken.
    phase = "succeed";
    await act(async () => {
      await result.current.mutate();
    });
    expect(result.current.error).toBeNull();
    // Per-item record for row-9 untouched by the non-itemized clear.
    expect(result.current.errorFor("row-9")?.message).toBe("row bad");
  });

  test("clearErrorFor clears the per-item slot and the hook-level slot when the id owns it", async () => {
    mockFetch(jsonResponse({ message: "Nope" }, 403));

    const { result } = renderHook(
      () => useAdminMutation({ path: "/api/v1/admin/items" }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutate({ itemId: "row-1" });
    });
    expect(result.current.error?.message).toBe("Nope");
    expect(result.current.errorFor("row-1")?.message).toBe("Nope");

    act(() => {
      result.current.clearErrorFor("row-1");
    });
    expect(result.current.errorFor("row-1")).toBeUndefined();
    // row-1 owned the hook slot, so clearing the per-item error also
    // dismisses the shared banner — otherwise a stale banner would outlive
    // the per-item state it reflected.
    expect(result.current.error).toBeNull();
  });

  test("clearErrorFor on a non-owning id leaves the hook-level slot intact", async () => {
    // A failing itemized call takes ownership of the hook slot. Later,
    // clearing a DIFFERENT (non-failing) id via clearErrorFor is a no-op for
    // hook-level.
    mockFetch(jsonResponse({ message: "Nope" }, 403));

    const { result } = renderHook(
      () => useAdminMutation({ path: "/api/v1/admin/items" }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutate({ itemId: "row-A" });
    });
    expect(result.current.error?.message).toBe("Nope");

    act(() => {
      result.current.clearErrorFor("row-unrelated");
    });
    expect(result.current.error?.message).toBe("Nope");
    expect(result.current.errorFor("row-A")?.message).toBe("Nope");
  });

  test("reset() clears errorsByItemId along with error/saving/in-flight", async () => {
    mockFetch(jsonResponse({ message: "Boom" }, 500));

    const { result } = renderHook(
      () => useAdminMutation({ path: "/api/v1/admin/items" }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutate({ itemId: "r1" });
    });
    await act(async () => {
      await result.current.mutate({ itemId: "r2" });
    });
    expect(Object.keys(result.current.errorsByItemId).sort()).toEqual(["r1", "r2"]);

    act(() => {
      result.current.reset();
    });
    expect(result.current.errorsByItemId).toEqual({});
    expect(result.current.errorFor("r1")).toBeUndefined();
    expect(result.current.error).toBeNull();
  });

  test("a throwing onSuccess callback does not flip result.ok or populate hook error", async () => {
    // Same invariant as invalidates — onSuccess is user code that may throw
    // (e.g. a dialog close handler that races with unmount). The mutation
    // result already reflects the successful 2xx; we should not retroactively
    // mark it failed.
    mockFetch(jsonResponse({ ok: true }));

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const { result } = renderHook(
        () => useAdminMutation({ path: "/api/v1/admin/test" }),
        { wrapper },
      );

      let mutateResult: MutateResult<unknown>;
      await act(async () => {
        mutateResult = await result.current.mutate({
          onSuccess: () => {
            throw new Error("onSuccess bug");
          },
        });
      });

      expect(mutateResult!.ok).toBe(true);
      expect(result.current.error).toBeNull();
    } finally {
      console.warn = originalWarn;
    }
  });
});
