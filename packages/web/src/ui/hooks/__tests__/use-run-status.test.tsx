/**
 * #3749 — `useRunStatus`: load-time durable-run-status fetch driving the resume /
 * waiting-on-approval affordance. Covers the happy fetch, the disabled gate
 * (no conversation / pre-auth), fail-soft (a fetch error collapses to `null` so
 * opening a conversation is never blocked), `refetch`/`clear`, and the shared
 * stale-guard (a previous conversation's late response never commits over the
 * current one).
 */
import { describe, expect, test, afterEach, mock } from "bun:test";
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";
import { useRunStatus } from "@/ui/hooks/use-run-status";
import type { RunStatusResponse } from "@/ui/lib/types";

const realFetch = globalThis.fetch;
afterEach(() => {
  // Unmount every rendered hook so a parked test's polling interval is torn down
  // before the next test — a leaked interval + the shared `fetch` mock otherwise
  // cross-contaminates fetch-call counts and the parked→running transition.
  cleanup();
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

  // ── Polling — AC3 for a passively-waiting user ──────────────────────────────
  // A parked turn resumes once an admin approves; the server re-arms it
  // parked→running (`resolveApprovalPark`) but does NOT push to the browser. So
  // while non-terminal the hook polls; on the parked→running flip it fires
  // `onParkedResolved` (the chat auto-resumes) so no manual reload is needed.

  /** Queue run-status payloads; each fetch returns the next (last repeats). */
  function mockFetchSequence(bodies: unknown[]) {
    let i = 0;
    globalThis.fetch = mock(async () => {
      const body = bodies[Math.min(i, bodies.length - 1)];
      i += 1;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  }

  test("polls a parked run and fires onParkedResolved when the server flips it to running (AC3)", async () => {
    // First load: parked. A later poll observes the approval-park re-arm (running).
    mockFetchSequence([
      { status: "parked", runId: "run-1", parkedReason: "req-1" },
      { status: "parked", runId: "run-1", parkedReason: "req-1" },
      { status: "running", runId: "run-1", parkedReason: null },
    ]);
    const onParkedResolved = mock(() => {});
    const { result } = renderHook(() =>
      useRunStatus({
        ...baseOpts,
        conversationId: "conv-1",
        enabled: true,
        onParkedResolved,
        // Comfortably above testing-library's ~50ms waitFor cadence so the
        // initial `parked` commit is observable before the first poll tick
        // advances the sequence to `running`.
        pollIntervalMs: 80,
      }),
    );
    await waitFor(() => expect(result.current.runStatus?.status).toBe("parked"));
    // Polling drives the parked→running transition and the auto-resume callback,
    // exactly once, without any manual refetch/reload.
    await waitFor(() => expect(onParkedResolved).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.runStatus?.status).toBe("running"));
  });

  test("stops polling once the run reaches a terminal state (no further fetches)", async () => {
    // parked → done: the poll that observes `done` is the last; nothing fires
    // after, and `onParkedResolved` is NOT called (no resumable transition).
    mockFetchSequence([
      { status: "parked", runId: "run-1", parkedReason: "req-1" },
      { status: "done", runId: "run-1", parkedReason: null },
    ]);
    const onParkedResolved = mock(() => {});
    const { result } = renderHook(() =>
      useRunStatus({
        ...baseOpts,
        conversationId: "conv-1",
        enabled: true,
        onParkedResolved,
        pollIntervalMs: 20,
      }),
    );
    await waitFor(() => expect(result.current.runStatus?.status).toBe("done"));
    const callsAtTerminal = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls.length;
    // Give several poll intervals a chance to (wrongly) fire.
    await new Promise((r) => setTimeout(r, 100));
    expect((globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls.length).toBe(callsAtTerminal);
    expect(onParkedResolved).not.toHaveBeenCalled();
  });

  test("cleans up the poll on unmount (no fetch after teardown)", async () => {
    mockFetchSequence([{ status: "parked", runId: "run-1", parkedReason: "req-1" }]);
    const { result, unmount } = renderHook(() =>
      useRunStatus({
        ...baseOpts,
        conversationId: "conv-1",
        enabled: true,
        pollIntervalMs: 20,
      }),
    );
    await waitFor(() => expect(result.current.runStatus?.status).toBe("parked"));
    unmount();
    const callsAtUnmount = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls.length;
    await new Promise((r) => setTimeout(r, 100));
    expect((globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls.length).toBe(callsAtUnmount);
  });

  test("an initial `running` load does NOT auto-fire onParkedResolved (only a parked→running flip does)", async () => {
    // A conversation opened on an already-interrupted (`running`) turn shows the
    // MANUAL resume button — it must never auto-resume itself (prev baseline is
    // null, not "parked", so the transition guard stays closed).
    mockFetchSequence([{ status: "running", runId: "run-1", parkedReason: null }]);
    const onParkedResolved = mock(() => {});
    const { result } = renderHook(() =>
      useRunStatus({ ...baseOpts, conversationId: "conv-1", enabled: true, onParkedResolved, pollIntervalMs: 20 }),
    );
    await waitFor(() => expect(result.current.runStatus?.status).toBe("running"));
    await new Promise((r) => setTimeout(r, 80));
    expect(onParkedResolved).not.toHaveBeenCalled();
  });

  test("parked → failed (terminal) stops polling and never fires onParkedResolved", async () => {
    // The `done` companion is covered above; `failed` shares the path — assert it
    // explicitly so the doc's "parked → done/failed do not fire" contract holds.
    mockFetchSequence([
      { status: "parked", runId: "run-1", parkedReason: "req-1" },
      { status: "failed", runId: "run-1", parkedReason: null },
    ]);
    const onParkedResolved = mock(() => {});
    const { result } = renderHook(() =>
      useRunStatus({ ...baseOpts, conversationId: "conv-1", enabled: true, onParkedResolved, pollIntervalMs: 20 }),
    );
    await waitFor(() => expect(result.current.runStatus?.status).toBe("failed"));
    const calls = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls.length;
    await new Promise((r) => setTimeout(r, 100));
    expect((globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls.length).toBe(calls);
    expect(onParkedResolved).not.toHaveBeenCalled();
  });

  test("switching conversation while parked tears down the old poll (no more fetches to the old conversation)", async () => {
    // conv-1 is parked (polling); switching to conv-2 (also parked) must stop
    // polling conv-1 — a leaked cross-conversation poll would keep hitting the old
    // URL and could mis-fire the transition against the now-current conversation.
    globalThis.fetch = mock((input: RequestInfo | URL) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            String(input).includes("/conv-1/")
              ? { status: "parked", runId: "run-1", parkedReason: "req-1" }
              : { status: "parked", runId: "run-2", parkedReason: "req-2" },
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    ) as unknown as typeof fetch;

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) =>
        useRunStatus({ ...baseOpts, conversationId: id, enabled: true, pollIntervalMs: 20 }),
      { initialProps: { id: "conv-1" } },
    );
    await waitFor(() => expect(result.current.runStatus?.runId).toBe("run-1"));

    rerender({ id: "conv-2" });
    await waitFor(() => expect(result.current.runStatus?.runId).toBe("run-2"));

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    const conv1CallsBefore = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/conv-1/")).length;
    await new Promise((r) => setTimeout(r, 100));
    const conv1CallsAfter = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/conv-1/")).length;
    // No NEW conv-1 fetches after the switch — the old poll was torn down.
    expect(conv1CallsAfter).toBe(conv1CallsBefore);
  });

  test("a transient poll error keeps the parked banner and still auto-resumes on the later flip (HIGH fix)", async () => {
    // The most likely moment for a blip is during a long park. A poll error must
    // NOT clear the parked status (which would hide the banner and kill the poll);
    // the poll survives and still catches the parked→running re-arm.
    let call = 0;
    globalThis.fetch = mock(async () => {
      call += 1;
      // 1st: parked (initial). 2nd: transient error. 3rd+: running (re-armed).
      if (call === 2) throw new Error("transient blip");
      const body =
        call >= 3
          ? { status: "running", runId: "run-1", parkedReason: null }
          : { status: "parked", runId: "run-1", parkedReason: "req-1" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const onParkedResolved = mock(() => {});
    const { result } = renderHook(() =>
      useRunStatus({ ...baseOpts, conversationId: "conv-1", enabled: true, onParkedResolved, pollIntervalMs: 30 }),
    );
    await waitFor(() => expect(result.current.runStatus?.status).toBe("parked"));
    // Despite the blip on the 2nd fetch, the banner stays parked and the poll
    // keeps running until it catches the re-arm and auto-resumes — exactly once.
    await waitFor(() => expect(onParkedResolved).toHaveBeenCalledTimes(1), { timeout: 2000 });
    await waitFor(() => expect(result.current.runStatus?.status).toBe("running"));
  });
});
