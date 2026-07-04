/**
 * #4294 — `useStopHandler`: the Stop-button orchestration extracted from
 * AtlasChat. Covers the AC-bearing contract: client stop fires FIRST and
 * unconditionally (the composer unlocks without waiting on the network), the
 * server-side stop POSTs against the captured run id with the transport's
 * headers/credentials, the pre-header sliver (no run id yet) stays client-only,
 * a 404 (expected race) is tolerated silently, and any other HTTP failure
 * logs a console.warn — never a user-facing error surface (the visible
 * outcome already happened).
 */
import { describe, expect, test, mock, afterEach, spyOn } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useStopHandler } from "@/ui/hooks/use-stop-handler";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(response: Response | Promise<Response>) {
  const fetchMock = mock(() => Promise.resolve(response));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function makeOpts(over: Partial<Parameters<typeof useStopHandler>[0]> = {}) {
  return {
    stop: mock(() => {}),
    getRunId: () => "run-1" as string | null,
    apiUrl: "http://api.test",
    getHeaders: () => ({ "x-test-header": "yes" }),
    getCredentials: () => "include" as RequestCredentials,
    ...over,
  };
}

describe("useStopHandler (#4294)", () => {
  test("stops the client stream AND posts the server-side stop for the captured run id", async () => {
    const fetchMock = mockFetch(new Response(JSON.stringify({ stopped: true }), { status: 200 }));
    const opts = makeOpts();
    const { result } = renderHook(() => useStopHandler(opts));

    act(() => {
      result.current.stopTurn();
    });

    expect(opts.stop).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api.test/api/v1/chat/runs/run-1/stop");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect((init.headers as Record<string, string>)["x-test-header"]).toBe("yes");
  });

  test("no run id yet (pre-header sliver) — client stop only, no network call", () => {
    const fetchMock = mockFetch(new Response(null, { status: 200 }));
    const opts = makeOpts({ getRunId: () => null });
    const { result } = renderHook(() => useStopHandler(opts));

    act(() => {
      result.current.stopTurn();
    });

    expect(opts.stop).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a 404 from the server (run already finished / other instance) is a silent no-op", async () => {
    const fetchMock = mockFetch(new Response(JSON.stringify({ error: "not_found" }), { status: 404 }));
    const opts = makeOpts();
    const { result } = renderHook(() => useStopHandler(opts));

    act(() => {
      result.current.stopTurn();
    });

    expect(opts.stop).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // Nothing thrown, nothing surfaced — the assertion is that we got here.
  });

  test("a non-404 HTTP failure logs a console.warn — a persistent 401/500 must not wear the benign-race label", async () => {
    const fetchMock = mockFetch(new Response(JSON.stringify({ error: "auth_error" }), { status: 500 }));
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const opts = makeOpts();
      const { result } = renderHook(() => useStopHandler(opts));

      act(() => {
        result.current.stopTurn();
      });

      expect(opts.stop).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(
          warnSpy.mock.calls.some((c) => String(c[0]).includes("Server-side stop failed: HTTP 500")),
        ).toBe(true),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("a network failure never blocks or throws — the client stop already delivered the outcome", async () => {
    const fetchMock = mock(() => Promise.reject(new Error("offline")));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const opts = makeOpts();
    const { result } = renderHook(() => useStopHandler(opts));

    act(() => {
      result.current.stopTurn();
    });

    expect(opts.stop).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
