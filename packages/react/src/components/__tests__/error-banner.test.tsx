import { describe, expect, test, mock, afterEach } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { ErrorBanner } from "../chat/error-banner";

function makeError(json: Record<string, unknown>): Error {
  return new Error(JSON.stringify(json));
}

describe("ErrorBanner", () => {
  test("shows Try again button for retryable errors when onRetry provided", () => {
    const onRetry = mock(() => {});
    const err = makeError({ error: "provider_timeout", message: "timed out" });
    const { container } = render(
      <ErrorBanner error={err} authMode="none" onRetry={onRetry} />,
    );
    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button!.textContent).toContain("Try again");
    fireEvent.click(button!);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test("does not show Try again button for non-retryable errors", () => {
    const onRetry = mock(() => {});
    const err = makeError({ error: "auth_error" });
    const { container } = render(
      <ErrorBanner error={err} authMode="none" onRetry={onRetry} />,
    );
    expect(container.querySelector("button")).toBeNull();
  });

  // ------------------------------------------------------------------
  // F-77 — conversation_budget_exceeded swaps retry for a new-conversation CTA
  // ------------------------------------------------------------------

  test("budget-exceeded shows Start a new conversation CTA instead of retry", () => {
    const onRetry = mock(() => {});
    const onStartNew = mock(() => {});
    const err = makeError({ error: "conversation_budget_exceeded", message: "budget hit" });
    const { container } = render(
      <ErrorBanner
        error={err}
        authMode="none"
        onRetry={onRetry}
        onStartNewConversation={onStartNew}
      />,
    );
    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button!.textContent).toContain("Start a new conversation");
    expect(container.textContent).not.toContain("Try again");
    fireEvent.click(button!);
    expect(onStartNew).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  test("budget-exceeded without onStartNewConversation renders no CTA", () => {
    const err = makeError({ error: "conversation_budget_exceeded" });
    const { container } = render(<ErrorBanner error={err} authMode="none" />);
    expect(container.querySelector("button")).toBeNull();
  });

  // ------------------------------------------------------------------
  // #3342 — postMessage("atlas:error") to the host frame is OPT-IN
  // ------------------------------------------------------------------

  const realParent = window.parent;
  afterEach(() => {
    Object.defineProperty(window, "parent", { value: realParent, configurable: true });
  });

  function withMockParent() {
    const postMessage = mock((_msg: unknown, _origin: string) => {});
    // Simulate an embedded iframe: window.parent !== window
    Object.defineProperty(window, "parent", {
      value: { postMessage },
      configurable: true,
    });
    return postMessage;
  }

  test("notifyHostOnError posts an opaque atlas:error event to the parent frame", () => {
    const postMessage = withMockParent();
    const err = makeError({ error: "provider_timeout", message: "secret detail" });
    render(<ErrorBanner error={err} authMode="none" notifyHostOnError />);
    expect(postMessage).toHaveBeenCalledTimes(1);
    const [msg, origin] = postMessage.mock.calls[0]!;
    expect(origin).toBe("*");
    expect(msg).toEqual({
      type: "atlas:error",
      error: { code: "provider_timeout", retryable: true },
    });
    // Opaque codes only — no server-derived strings leak to the host frame.
    expect(JSON.stringify(msg)).not.toContain("secret detail");
  });

  test("without notifyHostOnError no postMessage is sent (web default)", () => {
    const postMessage = withMockParent();
    const err = makeError({ error: "provider_timeout", message: "timed out" });
    render(<ErrorBanner error={err} authMode="none" />);
    expect(postMessage).not.toHaveBeenCalled();
  });
});
