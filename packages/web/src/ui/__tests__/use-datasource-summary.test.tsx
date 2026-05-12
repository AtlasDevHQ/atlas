import { describe, expect, test, afterEach, beforeEach, mock } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useDatasourceSummary } from "../hooks/use-datasource-summary";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useDatasourceSummary", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("returns table count from a successful response", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ entities: [{ name: "users" }, { name: "orders" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const { result } = renderHook(
      () =>
        useDatasourceSummary({
          apiUrl: "",
          isCrossOrigin: false,
          getHeaders: () => ({}),
          enabled: true,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toEqual({ tableCount: 2 }));
  });

  test("soft-fails to null on a 5xx response (so the empty state stays neutral)", async () => {
    const warn = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warn;

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ requestId: "req_abc" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    try {
      const { result } = renderHook(
        () =>
          useDatasourceSummary({
            apiUrl: "",
            isCrossOrigin: false,
            getHeaders: () => ({}),
            enabled: true,
          }),
        { wrapper },
      );

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
        expect(result.current.data).toBe(null);
      });
      // The contract is "soft-fail to null but log the breadcrumb so a
      // backend regression isn't invisible." Assert the breadcrumb was
      // emitted with the request id from the body.
      expect(warn).toHaveBeenCalled();
      const args = warn.mock.calls[0] as unknown[];
      expect(args).toContain("req_abc");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("treats a missing entities array as zero tables, not an error", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ entities: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    const { result } = renderHook(
      () =>
        useDatasourceSummary({
          apiUrl: "",
          isCrossOrigin: false,
          getHeaders: () => ({}),
          enabled: true,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toEqual({ tableCount: 0 }));
  });
});
