import { describe, expect, test, spyOn } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useTransientNotice } from "../use-transient-notice";

describe("useTransientNotice (#4297)", () => {
  test("shows a notice and auto-dismisses it after its timeout", async () => {
    const { result } = renderHook(() => useTransientNotice());
    expect(result.current.notice).toBe("");

    act(() => result.current.showNotice("Pinned as starter prompt.", 30));
    expect(result.current.notice).toBe("Pinned as starter prompt.");

    await waitFor(() => expect(result.current.notice).toBe(""));
  });

  test("a newer notice supersedes the older notice's dismissal timer", async () => {
    const { result } = renderHook(() => useTransientNotice());

    act(() => result.current.showNotice("first", 30));
    act(() => result.current.showNotice("second", 250));

    // Wait past the FIRST notice's deadline: its (superseded) timer must not
    // clip the second notice early.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 90));
    });
    expect(result.current.notice).toBe("second");

    // The second notice still dismisses on its own schedule.
    await waitFor(() => expect(result.current.notice).toBe(""), { timeout: 1000 });
  });

  test("unmount cancels the pending dismissal timer", () => {
    // React 19 silently ignores setState on an unmounted component, so a
    // leaked timer would be invisible to a render-side assertion — assert the
    // cancellation itself instead.
    const clearSpy = spyOn(globalThis, "clearTimeout");
    try {
      const { result, unmount } = renderHook(() => useTransientNotice());
      act(() => result.current.showNotice("bye", 30));
      const callsBefore = clearSpy.mock.calls.length;
      unmount();
      expect(clearSpy.mock.calls.length).toBeGreaterThan(callsBefore);
    } finally {
      clearSpy.mockRestore();
    }
  });
});
