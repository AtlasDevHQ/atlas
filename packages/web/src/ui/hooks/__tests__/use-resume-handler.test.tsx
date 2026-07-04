/**
 * #3749 — `useResumeHandler`: the resume orchestration extracted from AtlasChat.
 * Covers the AC-bearing contract: regenerate-with-marker (no phantom user
 * message), the re-entrancy guard, the optimistic banner clear, and the
 * refetch-on-settle that clears a completed resume / restores the affordance on
 * failure (AC 1 & 3).
 */
import { describe, expect, test, mock } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useResumeHandler } from "@/ui/hooks/use-resume-handler";
import { ATLAS_RESUME_MARKER } from "@/ui/hooks/use-atlas-transport";

function makeOpts(over: Partial<Parameters<typeof useResumeHandler>[0]> = {}) {
  return {
    regenerate: mock(() => Promise.resolve()),
    clearRunStatus: mock(() => {}),
    refetchRunStatus: mock(() => {}),
    isLoading: false,
    resetPendingWarnings: mock(() => {}),
    onError: mock(() => {}),
    ...over,
  };
}

describe("useResumeHandler (#3749)", () => {
  test("resume() calls regenerate with the marker body (NOT a new user message)", async () => {
    const opts = makeOpts();
    const { result } = renderHook(() => useResumeHandler(opts));

    await act(async () => {
      result.current.resume();
    });

    expect(opts.regenerate).toHaveBeenCalledTimes(1);
    const arg = (opts.regenerate.mock.calls[0] as unknown[])[0] as { body: Record<string, unknown> };
    expect(arg.body[ATLAS_RESUME_MARKER]).toBe(true);
    // Optimistic clear + pending-warning reset happen on activate.
    expect(opts.clearRunStatus).toHaveBeenCalledTimes(1);
    expect(opts.resetPendingWarnings).toHaveBeenCalledTimes(1);
  });

  test("re-fetches the run status once the resume stream settles (clears/re-shows the banner)", async () => {
    const opts = makeOpts();
    const { result } = renderHook(() => useResumeHandler(opts));
    await act(async () => {
      result.current.resume();
    });
    await waitFor(() => expect(opts.refetchRunStatus).toHaveBeenCalledTimes(1));
    // The in-flight flag clears after settle.
    await waitFor(() => expect(result.current.resuming).toBe(false));
  });

  test("a failed resume surfaces an error AND still re-fetches (restores the affordance)", async () => {
    const opts = makeOpts({ regenerate: mock(() => Promise.reject(new Error("boom"))) });
    const { result } = renderHook(() => useResumeHandler(opts));
    await act(async () => {
      result.current.resume();
    });
    await waitFor(() => expect(opts.onError).toHaveBeenCalledTimes(1));
    // AC 3 mechanism: the status is re-fetched even on failure so a still-resumable
    // run re-shows the banner rather than silently swallowing the affordance.
    await waitFor(() => expect(opts.refetchRunStatus).toHaveBeenCalledTimes(1));
  });

  test("is re-entrant-safe: a second resume while one is in flight is a no-op (no fork / double-charge)", async () => {
    let resolveFirst: () => void = () => {};
    const regenerate = mock(
      () => new Promise<void>((res) => { resolveFirst = res; }),
    );
    const opts = makeOpts({ regenerate });
    const { result } = renderHook(() => useResumeHandler(opts));

    await act(async () => {
      result.current.resume();
    });
    expect(result.current.resuming).toBe(true);
    // Second activate while the first stream is open — must not fire regenerate again.
    await act(async () => {
      result.current.resume();
    });
    expect(regenerate).toHaveBeenCalledTimes(1);

    // Settle the first so the hook returns to idle.
    await act(async () => {
      resolveFirst();
    });
    await waitFor(() => expect(result.current.resuming).toBe(false));
  });

  test("does not resume while a normal turn is streaming (isLoading)", async () => {
    const opts = makeOpts({ isLoading: true });
    const { result } = renderHook(() => useResumeHandler(opts));
    await act(async () => {
      result.current.resume();
    });
    expect(opts.regenerate).not.toHaveBeenCalled();
  });

  // #4297 — onStart is the caller's supersede seam for its failure banner: it
  // must fire exactly when a resume actually begins, and NEVER on a guarded
  // no-op call (otherwise a click could erase the banner without retrying).
  test("onStart fires when a resume actually begins", async () => {
    const onStart = mock(() => {});
    const opts = makeOpts({ onStart });
    const { result } = renderHook(() => useResumeHandler(opts));
    await act(async () => {
      result.current.resume();
    });
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  test("onStart does NOT fire on a guarded no-op call (isLoading)", async () => {
    const onStart = mock(() => {});
    const opts = makeOpts({ onStart, isLoading: true });
    const { result } = renderHook(() => useResumeHandler(opts));
    await act(async () => {
      result.current.resume();
    });
    expect(onStart).not.toHaveBeenCalled();
    expect(opts.regenerate).not.toHaveBeenCalled();
  });

  test("onStart does NOT fire on a re-entrant call while a resume is in flight", async () => {
    let resolveFirst: () => void = () => {};
    const regenerate = mock(
      () => new Promise<void>((res) => { resolveFirst = res; }),
    );
    const onStart = mock(() => {});
    const opts = makeOpts({ regenerate, onStart });
    const { result } = renderHook(() => useResumeHandler(opts));

    await act(async () => {
      result.current.resume();
    });
    await act(async () => {
      result.current.resume();
    });
    // One real start, one guarded no-op — the supersede seam fired exactly once.
    expect(onStart).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst();
    });
    await waitFor(() => expect(result.current.resuming).toBe(false));
  });

  test("onStart fires before onError on a failed resume (clear-then-report ordering)", async () => {
    const order: string[] = [];
    const opts = makeOpts({
      regenerate: mock(() => Promise.reject(new Error("boom"))),
      onStart: mock(() => {
        order.push("onStart");
      }),
      onError: mock(() => {
        order.push("onError");
      }),
    });
    const { result } = renderHook(() => useResumeHandler(opts));
    await act(async () => {
      result.current.resume();
    });
    await waitFor(() => expect(order).toEqual(["onStart", "onError"]));
  });

  test("onError receives the narrowed underlying error as detail (#4297)", async () => {
    const opts = makeOpts({ regenerate: mock(() => Promise.reject(new Error("socket hang up"))) });
    const { result } = renderHook(() => useResumeHandler(opts));
    await act(async () => {
      result.current.resume();
    });
    await waitFor(() => expect(opts.onError).toHaveBeenCalledTimes(1));
    expect(opts.onError.mock.calls[0]).toEqual([
      "Failed to resume the interrupted turn. Please try again.",
      "socket hang up",
    ]);
  });
});
