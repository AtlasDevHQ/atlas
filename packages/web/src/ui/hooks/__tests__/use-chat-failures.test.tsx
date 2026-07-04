import { describe, expect, test } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { useChatFailures } from "../use-chat-failures";
import type { StoredActionFailure } from "../../components/chat/error-banner";

const sendFailure: StoredActionFailure = {
  kind: "send",
  title: "Message failed to send",
};
const pinFailure: StoredActionFailure = {
  kind: "pin",
  title: "Couldn't pin starter prompt",
};
const resumeFailure: StoredActionFailure = {
  kind: "resume",
  title: "Couldn't resume the turn",
};

describe("useChatFailures (#4297) — the failure-banner clear-scoping policy", () => {
  test("starts with no banner and stores a reported failure", () => {
    const { result } = renderHook(() => useChatFailures());
    expect(result.current.failure).toBeNull();

    act(() => result.current.report(sendFailure));
    expect(result.current.failure).toEqual(sendFailure);
  });

  test("a newer failure replaces the current banner (single slot — the newest is actionable)", () => {
    const { result } = renderHook(() => useChatFailures());
    act(() => result.current.report(sendFailure));
    act(() => result.current.report(pinFailure));
    expect(result.current.failure).toEqual(pinFailure);
  });

  test("supersede clears ANY kind — a deliberate user attempt supersedes whatever banner is up", () => {
    const { result } = renderHook(() => useChatFailures());
    for (const failure of [sendFailure, pinFailure, resumeFailure]) {
      act(() => result.current.report(failure));
      act(() => result.current.supersede());
      expect(result.current.failure).toBeNull();
    }
  });

  test("clearKind clears only its own kind — a machine-initiated clear can't erase an unseen unrelated failure", () => {
    const { result } = renderHook(() => useChatFailures());

    // The composer-edit path (clearKind("send")) must not dismiss a pin
    // failure the user hasn't acted on…
    act(() => result.current.report(pinFailure));
    act(() => result.current.clearKind("send"));
    expect(result.current.failure).toEqual(pinFailure);

    // …and auto-resume (clearKind("resume")) must not dismiss a send failure…
    act(() => result.current.report(sendFailure));
    act(() => result.current.clearKind("resume"));
    expect(result.current.failure).toEqual(sendFailure);

    // …while each DOES clear its own kind.
    act(() => result.current.clearKind("send"));
    expect(result.current.failure).toBeNull();
    act(() => result.current.report(resumeFailure));
    act(() => result.current.clearKind("resume"));
    expect(result.current.failure).toBeNull();
  });

  test("clearKind on an empty slot stays empty (no-op, no crash)", () => {
    const { result } = renderHook(() => useChatFailures());
    act(() => result.current.clearKind("load"));
    expect(result.current.failure).toBeNull();
  });

  test("dismiss (the banner's ✕) clears the banner", () => {
    const { result } = renderHook(() => useChatFailures());
    act(() => result.current.report(sendFailure));
    act(() => result.current.dismiss());
    expect(result.current.failure).toBeNull();
  });

  test("the transition callbacks are referentially stable across state changes (safe in effect deps / memoized children)", () => {
    const { result } = renderHook(() => useChatFailures());
    const first = {
      report: result.current.report,
      supersede: result.current.supersede,
      clearKind: result.current.clearKind,
      dismiss: result.current.dismiss,
    };
    act(() => result.current.report(sendFailure));
    expect(result.current.report).toBe(first.report);
    expect(result.current.supersede).toBe(first.supersede);
    expect(result.current.clearKind).toBe(first.clearKind);
    expect(result.current.dismiss).toBe(first.dismiss);
  });
});
