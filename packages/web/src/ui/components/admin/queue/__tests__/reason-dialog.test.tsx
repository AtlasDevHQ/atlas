import { describe, expect, test, beforeEach, afterEach, mock, type Mock } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { ReasonDialog } from "../reason-dialog";
import type { FetchError } from "@/ui/lib/fetch-error";

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

  test("three-slot precedence: localError > mutationError > error, and mutationError change clears stale localError", async () => {
    // Locks: (1) the three-way precedence ordering in the render body,
    // (2) the widened `useEffect(…, [error, mutationError])` deps — a
    // later cleanup that drops `mutationError` from the deps would
    // silently regress step 2 without any existing test catching it.
    function Harness({
      error,
      mutationError,
    }: {
      error: string | null;
      mutationError: FetchError | null;
    }) {
      return (
        <ReasonDialog
          open
          onOpenChange={() => {}}
          title="Deny"
          onConfirm={async () => {
            throw new Error("boom");
          }}
          feature="Approval Workflows"
          error={error}
          mutationError={mutationError}
        />
      );
    }

    const { rerender } = render(
      <Harness error="bulk summary" mutationError={{ message: "server X", status: 500 }} />,
    );

    // Trigger the throw so localError is set. Starting caller errors are
    // already non-null so the effect has already fired once — subsequent
    // setLocalError wins.
    await act(async () => {
      fireEvent.click(denyButton());
    });
    await waitFor(() => expect(errorText() ?? "").toContain("Unexpected error"));

    // Step 1: with localError set, neither mutationError nor error shows.
    expect(errorText()).not.toContain("server X");
    expect(errorText()).not.toContain("bulk summary");

    // Step 2: caller pushes a fresh mutationError instance. useEffect fires
    // (mutationError identity changed), clears localError, and the
    // MutationErrorSurface inline chrome renders the new server message.
    rerender(
      <Harness
        error="bulk summary"
        mutationError={{ message: "server Y", status: 500 }}
      />,
    );
    await waitFor(() => {
      const text = errorText() ?? "";
      expect(text).toContain("server Y");
      expect(text).not.toContain("Unexpected error");
      expect(text).not.toContain("bulk summary");
    });

    // Step 3: caller drops mutationError — error string fallthrough wins.
    rerender(<Harness error="bulk summary" mutationError={null} />);
    await waitFor(() => expect(errorText()).toBe("bulk summary"));
  });
});

describe("ReasonDialog mutationError without feature (#1652)", () => {
  test("renders friendlyError in alert chrome when mutationError is set but feature is omitted", () => {
    // When a caller passes `mutationError` but forgets `feature`, the dialog
    // can't route through `<MutationErrorSurface>` (which requires a
    // `FeatureName`). Fallback: render the friendly message in the same
    // `role="alert"` chrome as the string `error` branch so the failure is
    // still announced to screen readers.
    render(
      <ReasonDialog
        open
        onOpenChange={() => {}}
        title="Deny"
        onConfirm={async () => {}}
        mutationError={{ message: "Something broke", status: 500 }}
      />,
    );
    const text = errorText() ?? "";
    expect(text).toContain("Something broke");
    // No EnterpriseUpsell chrome — the "requires an enterprise plan" copy
    // only reaches the user via `<MutationErrorSurface>` with a feature.
    expect(text).not.toContain("enterprise");
  });

  test("friendlyError's 403 mapping still applies in the feature-less fallback", () => {
    // A 403 arriving without a feature still gets `friendlyError`'s
    // admin-role translation — proof the structured status survives the
    // fallback path even though we lose the EnterpriseUpsell routing.
    render(
      <ReasonDialog
        open
        onOpenChange={() => {}}
        title="Deny"
        onConfirm={async () => {}}
        mutationError={{ message: "Forbidden", status: 403 }}
      />,
    );
    const text = errorText() ?? "";
    expect(text).toContain("Access denied");
  });
});

// Suppress unused-import warning: `screen` is kept available for future tests.
void screen;
