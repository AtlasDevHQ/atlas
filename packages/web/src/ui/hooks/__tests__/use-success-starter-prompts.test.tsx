import {
  describe,
  expect,
  test,
  beforeAll,
  afterAll,
  afterEach,
  mock,
} from "bun:test";
import { renderHook, cleanup, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  notifyManager,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useSuccessStarterPrompts } from "../use-success-starter-prompts";
import { STATIC_STARTER_PROMPTS } from "@/ui/lib/starter-prompt-fallback";

/**
 * Success-page starter-prompt resolution (#3935 §F4).
 *
 * The hook reuses the adaptive resolver (`/api/v1/starter-prompts`) and falls
 * back to the shared static set whenever that resolver yields no prompts —
 * cold-start (empty 200), a 5xx soft-fail (SDK returns `[]`), or a 4xx throw.
 *
 * Determinism note (#3455): force synchronous observer notification so the
 * query result propagates inside `waitFor` independent of event-loop load.
 */

function buildWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function newClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

function stubFetch(handler: () => Response) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(typeof input === "string" ? input : input.toString());
    return handler();
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

describe("useSuccessStarterPrompts", () => {
  beforeAll(() => {
    notifyManager.setScheduler((cb) => cb());
  });
  afterAll(() => {
    notifyManager.setScheduler((cb) => setTimeout(cb, 0));
  });
  afterEach(() => {
    cleanup();
    mock.restore();
  });

  test("uses adaptive prompt texts when the resolver returns prompts", async () => {
    const fetchStub = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            prompts: [
              { id: "library:a", text: "What is our total GMV?", provenance: "library" },
              { id: "favorite:b", text: "My pinned question", provenance: "favorite" },
            ],
            total: 2,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    try {
      const { result } = renderHook(() => useSuccessStarterPrompts(), {
        wrapper: buildWrapper(newClient()),
      });

      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.prompts).toEqual([
        "What is our total GMV?",
        "My pinned question",
      ]);
      expect(result.current.isFallback).toBe(false);
      expect(result.current.isError).toBe(false);
      expect(result.current.error).toBeNull();
      expect(fetchStub.calls.length).toBe(1);
      expect(fetchStub.calls[0]).toContain("/api/v1/starter-prompts");
    } finally {
      fetchStub.restore();
    }
  });

  test("drops empty-text adaptive entries and keeps the usable ones", async () => {
    const fetchStub = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            prompts: [
              { id: "library:a", text: "Usable one", provenance: "library" },
              { id: "library:b", text: "", provenance: "library" },
              { id: "library:c", text: "Usable two", provenance: "library" },
            ],
            total: 3,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    try {
      const { result } = renderHook(() => useSuccessStarterPrompts(), {
        wrapper: buildWrapper(newClient()),
      });

      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.prompts).toEqual(["Usable one", "Usable two"]);
      expect(result.current.isFallback).toBe(false);
    } finally {
      fetchStub.restore();
    }
  });

  test("falls back to the static set when every adaptive entry has empty text", async () => {
    const fetchStub = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            prompts: [
              { id: "library:a", text: "", provenance: "library" },
              { id: "library:b", text: "", provenance: "library" },
            ],
            total: 2,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    try {
      const { result } = renderHook(() => useSuccessStarterPrompts(), {
        wrapper: buildWrapper(newClient()),
      });

      await waitFor(() => expect(result.current.loading).toBe(false));

      // The fallback decision keys off the POST-filter length, not the raw
      // response length — an all-blank response collapses to the static set.
      expect(result.current.prompts).toEqual([...STATIC_STARTER_PROMPTS]);
      expect(result.current.isFallback).toBe(true);
    } finally {
      fetchStub.restore();
    }
  });

  test("falls back to the static set on cold-start (empty 200)", async () => {
    const fetchStub = stubFetch(
      () =>
        new Response(JSON.stringify({ prompts: [], total: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    try {
      const { result } = renderHook(() => useSuccessStarterPrompts(), {
        wrapper: buildWrapper(newClient()),
      });

      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.prompts).toEqual([...STATIC_STARTER_PROMPTS]);
      expect(result.current.isFallback).toBe(true);
    } finally {
      fetchStub.restore();
    }
  });

  test("falls back to the static set when the backend 5xx soft-fails to []", async () => {
    const fetchStub = stubFetch(
      () =>
        new Response(JSON.stringify({ error: "boom", requestId: "r-1" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
    );

    try {
      const { result } = renderHook(() => useSuccessStarterPrompts(), {
        wrapper: buildWrapper(newClient()),
      });

      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.prompts).toEqual([...STATIC_STARTER_PROMPTS]);
      expect(result.current.isFallback).toBe(true);
    } finally {
      fetchStub.restore();
    }
  });

  test("falls back to the static set when the request 4xx throws", async () => {
    const fetchStub = stubFetch(
      () =>
        new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    );

    try {
      const { result } = renderHook(() => useSuccessStarterPrompts(), {
        wrapper: buildWrapper(newClient()),
      });

      // 4xx rejects the query; the hook still surfaces the static fallback
      // (a red banner on a celebratory success page is worse than offering
      // sensible defaults). The hook retries once on failure, so wait for the
      // query to fully settle (`loading` false) before asserting the final
      // fallback — `isFallback` is true throughout (it's also the loading-state
      // value), so it can't witness the settle on its own.
      await waitFor(() => expect(result.current.loading).toBe(false), {
        timeout: 3000,
      });

      expect(result.current.prompts).toEqual([...STATIC_STARTER_PROMPTS]);
      expect(result.current.isFallback).toBe(true);
      // The 4xx stays distinguishable from a benign cold-start via isError —
      // it is not collapsed into isFallback.
      expect(result.current.isError).toBe(true);
      expect(result.current.error).toBeInstanceOf(Error);
    } finally {
      fetchStub.restore();
    }
  });
});
