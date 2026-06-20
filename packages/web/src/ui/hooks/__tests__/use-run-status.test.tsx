/**
 * #3749 — `useRunStatus`: load-time durable-run-status fetch driving the resume /
 * waiting-on-approval affordance. Covers the happy fetch, the disabled gate
 * (no conversation / pre-auth), fail-soft (a fetch error collapses to `null` so
 * opening a conversation is never blocked), `refetch`/`clear`, and the shared
 * stale-guard (a previous conversation's late response never commits over the
 * current one).
 */
import { describe, expect, test, afterEach, mock } from "bun:test";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useRunStatus } from "@/ui/hooks/use-run-status";
import type { RunStatusResponse } from "@/ui/lib/types";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetchOnce(status: number, body: unknown) {
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

const baseOpts = {
  apiUrl: "https://api.example.com",
  getHeaders: () => ({}),
  getCredentials: () => "include" as const,
};

describe("useRunStatus (#3749)", () => {
  test("fetches the latest run status for an enabled conversation", async () => {
    const payload: RunStatusResponse = { status: "running", runId: "run-1", parkedReason: null };
    mockFetchOnce(200, payload);
    const { result } = renderHook(() =>
      useRunStatus({ ...baseOpts, conversationId: "conv-1", enabled: true }),
    );
    await waitFor(() => expect(result.current.runStatus).toEqual(payload));
    // It hit the run-status endpoint for the right conversation.
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]!;
    expect(String(call[0])).toBe("https://api.example.com/api/v1/chat/conv-1/run-status");
  });

  test("surfaces a parked status with its approval ref", async () => {
    mockFetchOnce(200, { status: "parked", runId: "run-2", parkedReason: "req-42" });
    const { result } = renderHook(() =>
      useRunStatus({ ...baseOpts, conversationId: "conv-1", enabled: true }),
    );
    await waitFor(() =>
      expect(result.current.runStatus).toEqual({ status: "parked", runId: "run-2", parkedReason: "req-42" }),
    );
  });

  test("disabled (no conversation): never fetches, status stays null", async () => {
    globalThis.fetch = mock(async () => new Response("{}")) as unknown as typeof fetch;
    const { result } = renderHook(() =>
      useRunStatus({ ...baseOpts, conversationId: null, enabled: true }),
    );
    // Give any (erroneous) effect a tick to run.
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.runStatus).toBeNull();
    expect((globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  test("disabled (pre-auth): never fetches", async () => {
    globalThis.fetch = mock(async () => new Response("{}")) as unknown as typeof fetch;
    renderHook(() => useRunStatus({ ...baseOpts, conversationId: "conv-1", enabled: false }));
    await new Promise((r) => setTimeout(r, 10));
    expect((globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  test("fail-soft: a fetch error degrades to null (no affordance), never throws", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const { result } = renderHook(() =>
      useRunStatus({ ...baseOpts, conversationId: "conv-1", enabled: true }),
    );
    // The hook must not throw; it settles to null.
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.runStatus).toBeNull();
  });

  test("fail-soft: a non-OK response degrades to null", async () => {
    mockFetchOnce(500, { error: "boom" });
    const { result } = renderHook(() =>
      useRunStatus({ ...baseOpts, conversationId: "conv-1", enabled: true }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.runStatus).toBeNull();
  });

  test("refetch() re-reads the status — the mechanism that clears a parked banner after approval resolves", async () => {
    // First load: parked (waiting on approval). After the approval resolves the
    // server flips the run to a terminal state; refetch() must reflect it.
    mockFetchOnce(200, { status: "parked", runId: "run-1", parkedReason: "req-1" });
    const { result } = renderHook(() =>
      useRunStatus({ ...baseOpts, conversationId: "conv-1", enabled: true }),
    );
    await waitFor(() =>
      expect(result.current.runStatus).toEqual({ status: "parked", runId: "run-1", parkedReason: "req-1" }),
    );

    mockFetchOnce(200, { status: "done", runId: "run-1", parkedReason: null });
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.runStatus).toEqual({ status: "done", runId: "run-1", parkedReason: null });
  });

  test("clear() locally drops the surfaced status (optimistic banner clear on resume)", async () => {
    mockFetchOnce(200, { status: "running", runId: "run-1", parkedReason: null });
    const { result } = renderHook(() =>
      useRunStatus({ ...baseOpts, conversationId: "conv-1", enabled: true }),
    );
    await waitFor(() => expect(result.current.runStatus?.status).toBe("running"));
    act(() => result.current.clear());
    expect(result.current.runStatus).toBeNull();
  });

  test("a stale response for a previous conversation never commits over the current one", async () => {
    // conv-1's load is slow (its promise is held open); the hook then switches to
    // conv-2, which resolves first. When conv-1 finally resolves, its (stale)
    // result must NOT overwrite conv-2's — the shared isStale guard drops it.
    let resolveConv1: (r: Response) => void = () => {};
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/conv-1/")) {
        return new Promise<Response>((res) => { resolveConv1 = res; });
      }
      return Promise.resolve(
        new Response(JSON.stringify({ status: "running", runId: "run-2", parkedReason: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useRunStatus({ ...baseOpts, conversationId: id, enabled: true }),
      { initialProps: { id: "conv-1" } },
    );

    // Switch to conv-2 while conv-1 is still in flight; conv-2 resolves.
    rerender({ id: "conv-2" });
    await waitFor(() => expect(result.current.runStatus?.runId).toBe("run-2"));

    // conv-1's stale response now lands — it must be dropped, conv-2 stays.
    await act(async () => {
      resolveConv1(
        new Response(JSON.stringify({ status: "parked", runId: "run-1", parkedReason: "req-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      await Promise.resolve();
    });
    expect(result.current.runStatus?.runId).toBe("run-2");
  });
});
