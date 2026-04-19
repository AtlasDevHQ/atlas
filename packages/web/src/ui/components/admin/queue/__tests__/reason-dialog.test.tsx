import { describe, expect, test, beforeEach, afterEach, mock, type Mock } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { ReasonDialog } from "../reason-dialog";

// Silence + assert the observability log the component fires when
// onConfirm throws. Without a spy, each test that triggers the throw
// path emits the stack to stderr and muddles CI output. Spying also
// enforces the "log so observability still sees it" contract.
let consoleWarnSpy: Mock<(...args: unknown[]) => void>;
const originalConsoleWarn = console.warn;

beforeEach(() => {
  consoleWarnSpy = mock(() => {});
  console.warn = consoleWarnSpy as unknown as typeof console.warn;
});

afterEach(() => {
  console.warn = originalConsoleWarn;
  cleanup();
});

function errorText(): string | null {
  // Radix Dialog portals outside `container` — query from document.body.
  return document.body.querySelector('[role="alert"]')?.textContent?.trim() ?? null;
}

function denyButton(): HTMLButtonElement {
  // The destructive confirm button carries the `confirmLabel` text (default "Deny").
  // Radix portals the footer — scope to the document, not the render container.
  const buttons = [...document.body.querySelectorAll("button")] as HTMLButtonElement[];
  const btn = buttons.find((b) => b.textContent?.trim() === "Deny");
  if (!btn) throw new Error("Deny button not found in dialog");
  return btn;
}

describe("ReasonDialog error precedence (#1612)", () => {
  test("renders the `error` prop when no localError is set", () => {
    render(
      <ReasonDialog
        open
        onOpenChange={() => {}}
        title="Deny"
        onConfirm={async () => {}}
        error="server rejected the retry"
      />,
    );
    expect(errorText()).toBe("server rejected the retry");
  });

  test("fresh caller `error` prop clears stale localError from a prior throw", async () => {
    // Retry-flow scenario:
    //  1. onConfirm throws → localError "Unexpected error: boom"
    //  2. Caller fixes its bug, a real server error arrives via `error` prop
    //  3. The fresh server error should win, not the stale local one.
    // Without the useEffect on `error`, displayError stays on the stale
    // localError because `localError ?? error` picks local first.
    function Harness({ error }: { error: string | null }) {
      return (
        <ReasonDialog
          open
          onOpenChange={() => {}}
          title="Deny"
          onConfirm={async () => {
            throw new Error("boom");
          }}
          error={error}
        />
      );
    }

    const { rerender } = render(<Harness error={null} />);

    await act(async () => {
      fireEvent.click(denyButton());
    });

    await waitFor(() => {
      expect(errorText() ?? "").toContain("Unexpected error");
    });

    // Component promises to log when onConfirm throws — enforce that contract.
    expect(consoleWarnSpy).toHaveBeenCalled();
    const firstCallArgs = consoleWarnSpy.mock.calls[0] ?? [];
    expect(firstCallArgs[0]).toBe("ReasonDialog: onConfirm threw");

    rerender(<Harness error="server rejected the retry" />);

    await waitFor(() => {
      expect(errorText()).toBe("server rejected the retry");
    });
  });

  test("error prop transitioning between distinct non-null values still clears localError on each retry", async () => {
    // A future refactor that guards `if (prevError == null && error != null)`
    // would pass the null→non-null test but break the sequential retry flow:
    //   - retry 1: onConfirm throws → localError set, caller surfaces serverA
    //   - retry 2: onConfirm throws again → localError re-set, caller surfaces serverB
    //   - the fresh serverB must win, not the stale localError from retry 2.
    function Harness({ error }: { error: string | null }) {
      return (
        <ReasonDialog
          open
          onOpenChange={() => {}}
          title="Deny"
          onConfirm={async () => {
            throw new Error("boom");
          }}
          error={error}
        />
      );
    }

    const { rerender } = render(<Harness error={null} />);
    // Retry 1 — throw → localError; caller pushes first error prop → cleared
    await act(async () => {
      fireEvent.click(denyButton());
    });
    await waitFor(() => expect(errorText() ?? "").toContain("Unexpected error"));
    rerender(<Harness error="first server error" />);
    await waitFor(() => expect(errorText()).toBe("first server error"));
    // Retry 2 — throw → localError; caller pushes second (distinct) error prop
    await act(async () => {
      fireEvent.click(denyButton());
    });
    await waitFor(() => expect(errorText() ?? "").toContain("Unexpected error"));
    rerender(<Harness error="second server error" />);
    await waitFor(() => expect(errorText()).toBe("second server error"));
  });

  test("error prop going null → null does not clobber localError", async () => {
    // Guard against an over-eager effect clearing localError on every prop
    // change — we only clear when a non-null error arrives.
    function Harness({ error }: { error: string | null }) {
      return (
        <ReasonDialog
          open
          onOpenChange={() => {}}
          title="Deny"
          onConfirm={async () => {
            throw new Error("boom");
          }}
          error={error}
        />
      );
    }

    const { rerender } = render(<Harness error={null} />);
    await act(async () => {
      fireEvent.click(denyButton());
    });
    await waitFor(() => {
      expect(errorText() ?? "").toContain("Unexpected error");
    });

    rerender(<Harness error={null} />);
    // localError must still dominate — no fresh caller error to honor.
    expect(errorText() ?? "").toContain("Unexpected error");
  });
});

// Suppress unused-import warning: `screen` is kept available for future tests.
void screen;
