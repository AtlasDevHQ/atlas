/**
 * Lifecycle tests for `useVisibilityGatedPoll` (#2216).
 *
 * The e2e covers the foreground/background path end-to-end, but the
 * hook has non-trivial state (interval id, listener registration,
 * immediate refetch on hidden→visible, double-fire avoidance) and a
 * regression in any of these branches surfaces only as a flake or an
 * audit-volume incident. These unit tests pin the contract directly
 * against the hook so a regression fails fast.
 */

import { describe, expect, mock, test, beforeEach, afterEach } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { useVisibilityGatedPoll } from "../hooks/use-visibility-gated-poll";

// happy-dom's `document.visibilityState` is read-only ("visible" by
// default). We override it via a getter so individual tests can flip
// the value, then dispatch a `visibilitychange` event to let the hook
// observe the transition. Production behavior is identical — the
// browser fires `visibilitychange` on tab focus changes and the hook
// reads the same property. Each test resets the override in afterEach.
function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

function dispatchVisibilityChange(): void {
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  setVisibility("visible");
});

afterEach(() => {
  setVisibility("visible");
});

describe("useVisibilityGatedPoll", () => {
  test("does NOT call refetch synchronously on mount", () => {
    // Load-bearing — the hook's docstring calls this out: a regression
    // that fired refetch on mount would double-fire with the parent
    // `useAdminFetch`'s queryFn, doubling MCP audit volume.
    const refetch = mock(() => undefined);
    renderHook(() => useVisibilityGatedPoll(refetch, 1000));
    expect(refetch).not.toHaveBeenCalled();
  });

  test("fires refetch on each interval tick while foregrounded", async () => {
    const refetch = mock(() => undefined);
    renderHook(() => useVisibilityGatedPoll(refetch, 50));

    // Two ticks of the 50ms interval — a regression that never started
    // the interval would leave `refetch.mock.calls.length === 0`.
    await new Promise((resolve) => setTimeout(resolve, 130));
    expect(refetch.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("clears the interval when visibility flips to hidden", async () => {
    const refetch = mock(() => undefined);
    renderHook(() => useVisibilityGatedPoll(refetch, 50));

    // Let one tick land so we have a baseline.
    await new Promise((resolve) => setTimeout(resolve, 80));
    const callsAtForegroundEnd = refetch.mock.calls.length;
    expect(callsAtForegroundEnd).toBeGreaterThanOrEqual(1);

    // Hide the tab.
    act(() => {
      setVisibility("hidden");
      dispatchVisibilityChange();
    });

    // Wait long enough that any leaked interval would tick again.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(refetch.mock.calls.length).toBe(callsAtForegroundEnd);
  });

  test("refetches immediately on hidden→visible AND restarts the interval", async () => {
    const refetch = mock(() => undefined);
    renderHook(() => useVisibilityGatedPoll(refetch, 50));

    // Hide first to clear the interval.
    act(() => {
      setVisibility("hidden");
      dispatchVisibilityChange();
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const callsBeforeReturn = refetch.mock.calls.length;

    // Returning to foreground must trigger an immediate refetch (the
    // user shouldn't wait `intervalMs` for fresh data on tab switch)
    // AND restart the interval so subsequent ticks resume.
    act(() => {
      setVisibility("visible");
      dispatchVisibilityChange();
    });
    expect(refetch.mock.calls.length).toBe(callsBeforeReturn + 1);

    // Confirm the interval resumed.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(refetch.mock.calls.length).toBeGreaterThan(callsBeforeReturn + 1);
  });

  test("removes the visibilitychange listener and clears the interval on unmount", async () => {
    const refetch = mock(() => undefined);
    const { unmount } = renderHook(() =>
      useVisibilityGatedPoll(refetch, 50),
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    const callsBeforeUnmount = refetch.mock.calls.length;
    expect(callsBeforeUnmount).toBeGreaterThanOrEqual(1);

    unmount();

    // Both signals: (a) the interval must be cleared, (b) the listener
    // must be removed. Dispatch a visibilitychange after unmount; if
    // the listener is still attached and `safeRefetch` runs, the call
    // count would grow.
    act(() => {
      setVisibility("visible");
      dispatchVisibilityChange();
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(refetch.mock.calls.length).toBe(callsBeforeUnmount);
  });

  test("swallows a rejected refetch promise without breaking the loop", async () => {
    // CLAUDE.md "Never silently swallow errors — every catch must log."
    // The hook's `.catch` calls `console.warn` so the rejection is
    // surfaced; the loop must continue so a single bad refetch
    // doesn't freeze the chip.
    const warn = mock(() => undefined);
    const originalWarn = console.warn;
    console.warn = warn;

    let calls = 0;
    const refetch = mock(() => {
      calls += 1;
      return Promise.reject(new Error("boom"));
    });
    renderHook(() => useVisibilityGatedPoll(refetch, 50));

    await new Promise((resolve) => setTimeout(resolve, 130));
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(warn).toHaveBeenCalled();

    console.warn = originalWarn;
  });

  test("survives a synchronous throw from refetch and keeps polling", async () => {
    const warn = mock(() => undefined);
    const originalWarn = console.warn;
    console.warn = warn;

    let calls = 0;
    const refetch = mock(() => {
      calls += 1;
      throw new Error("sync boom");
    });
    renderHook(() => useVisibilityGatedPoll(refetch, 50));

    await new Promise((resolve) => setTimeout(resolve, 130));
    // The first tick throws synchronously inside `setInterval`'s
    // callback; without the try/catch in safeRefetch the throw would
    // propagate to the host and (under jsdom/happy-dom) tear down the
    // test process. Reaching `calls >= 2` proves the loop survived.
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(warn).toHaveBeenCalled();

    console.warn = originalWarn;
  });
});
