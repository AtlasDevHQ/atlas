import { describe, expect, test } from "bun:test";
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

  test("unmount clears the pending timer without state updates", async () => {
    const { result, unmount } = renderHook(() => useTransientNotice());
    act(() => result.current.showNotice("bye", 30));
    unmount();
    // Let the timer deadline pass — a leaked timer would fire setState on an
    // unmounted hook (surfacing as a console error under strict test runners).
    await new Promise((r) => setTimeout(r, 60));
  });
});
