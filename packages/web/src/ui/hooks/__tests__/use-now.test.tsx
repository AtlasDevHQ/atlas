import { afterEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useNow } from "../use-now";

const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

afterEach(() => {
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  setSystemTime(); // restore the real clock
  cleanup();
});

describe("useNow", () => {
  test("captures the clock at mount and advances it on each interval tick", () => {
    const t0 = new Date("2026-07-17T12:00:00Z");
    setSystemTime(t0);

    let tick: (() => void) | null = null;
    globalThis.setInterval = mock((fn: () => void) => {
      tick = fn;
      return 7 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = mock(() => {}) as unknown as typeof clearInterval;

    const { result } = renderHook(() => useNow(30_000));
    expect(result.current).toBe(t0.getTime());

    // The clock moves, then the interval fires → the returned value advances,
    // which is what makes a caption tick with no external re-render trigger.
    setSystemTime(new Date(t0.getTime() + 90_000));
    act(() => tick?.());
    expect(result.current).toBe(t0.getTime() + 90_000);
  });

  test("clears its interval on unmount (no leaked per-tile timer)", () => {
    globalThis.setInterval = mock(() => 42 as unknown as ReturnType<typeof setInterval>) as unknown as typeof setInterval;
    const clearSpy = mock(() => {});
    globalThis.clearInterval = clearSpy as unknown as typeof clearInterval;

    const { unmount } = renderHook(() => useNow());
    unmount();
    expect(clearSpy).toHaveBeenCalledWith(42);
  });
});
