/**
 * ReasonDialog.
 *
 * Merged 2026-09-04; formerly also src/ui/__tests__/reason-dialog.test.tsx,
 * which carried the compliance + error-surfacing guards:
 *
 * 1. Compliance contract — the reason captured in the audit log must be
 *    exactly what the user typed (whitespace-trimmed), including the
 *    empty string. The dialog must NOT substitute a hardcoded
 *    placeholder like "Denied by admin".
 * 2. Error surfacing — a throwing `onConfirm` must be visible to the
 *    operator (alert + dialog stays mounted) and still reach
 *    observability, rather than failing silently.
 */

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

describe("ReasonDialog mutationError without feature (#1652, #1716)", () => {
  test("warns in dev when mutationError is supplied without feature", () => {
    // Dev-only breadcrumb so future callers who forget `feature` surface
    // the regression during review, not after an enterprise_required 403
    // renders the wrong copy in prod.
    render(
      <ReasonDialog
        open
        onOpenChange={() => {}}
        title="Deny"
        onConfirm={async () => {}}
        mutationError={{ message: "Something broke", status: 500 }}
      />,
    );
    const calls = consoleWarnSpy.mock.calls;
    const warned = calls.some((args) =>
      String(args[0] ?? "").includes("`mutationError` supplied without `feature`"),
    );
    expect(warned).toBe(true);
  });

  test("does not warn when both mutationError and feature are supplied", () => {
    render(
      <ReasonDialog
        open
        onOpenChange={() => {}}
        title="Deny"
        onConfirm={async () => {}}
        feature="Approval Workflows"
        mutationError={{ message: "Something broke", status: 500 }}
      />,
    );
    const calls = consoleWarnSpy.mock.calls;
    const warned = calls.some((args) =>
      String(args[0] ?? "").includes("`mutationError` supplied without `feature`"),
    );
    expect(warned).toBe(false);
  });

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

  test("server-typed 403 message reaches the user in the feature-less fallback", () => {
    // Post-#2081 the server message wins over canned 403 copy — proof
    // the structured FetchError survives the fallback path even though
    // we lose the EnterpriseUpsell routing. The canned "Access denied"
    // text now only appears for empty-body 403s.
    render(
      <ReasonDialog
        open
        onOpenChange={() => {}}
        title="Deny"
        onConfirm={async () => {}}
        mutationError={{ message: "Forbidden by policy.", status: 403 }}
      />,
    );
    const text = errorText() ?? "";
    expect(text).toContain("Forbidden by policy.");
  });

  test("canned 403 copy still fires when 403 body is empty", () => {
    // `extractFetchError` substitutes `HTTP 403` when the response body
    // had no usable message — `friendlyError` swaps in the canned copy
    // so the user doesn't see the placeholder.
    render(
      <ReasonDialog
        open
        onOpenChange={() => {}}
        title="Deny"
        onConfirm={async () => {}}
        mutationError={{ message: "HTTP 403", status: 403 }}
      />,
    );
    const text = errorText() ?? "";
    expect(text).toContain("Access denied");
  });
});

// Suppress unused-import warning: `screen` is kept available for future tests.
void screen;

function renderDialog(props: Partial<React.ComponentProps<typeof ReasonDialog>> = {}) {
  const onConfirm = mock((_reason: string) => Promise.resolve());
  const onOpenChange = mock((_open: boolean) => {});
  const utils = render(
    <ReasonDialog
      open={props.open ?? true}
      onOpenChange={onOpenChange}
      title={props.title ?? "Deny action"}
      onConfirm={onConfirm}
      {...props}
    />,
  );
  return { onConfirm, onOpenChange, ...utils };
}

describe("ReasonDialog", () => {
  test("empty textarea → onConfirm receives empty string, not a placeholder", async () => {
    const { onConfirm } = renderDialog();

    const confirm = screen.getByRole("button", { name: /deny/i });
    await act(async () => {
      fireEvent.click(confirm);
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith("");
  });

  test("whitespace-only textarea → onConfirm receives empty string (trimmed)", async () => {
    const { onConfirm } = renderDialog();

    const textarea = screen.getByLabelText(/reason/i);
    fireEvent.change(textarea, { target: { value: "   \n  \t  " } });

    const confirm = screen.getByRole("button", { name: /deny/i });
    await act(async () => {
      fireEvent.click(confirm);
    });

    expect(onConfirm).toHaveBeenCalledWith("");
  });

  test("non-empty reason is passed through verbatim after trimming", async () => {
    const { onConfirm } = renderDialog();

    const textarea = screen.getByLabelText(/reason/i);
    fireEvent.change(textarea, { target: { value: "  Conflicts with policy  " } });

    const confirm = screen.getByRole("button", { name: /deny/i });
    await act(async () => {
      fireEvent.click(confirm);
    });

    expect(onConfirm).toHaveBeenCalledWith("Conflicts with policy");
  });

  test("required: true + empty textarea → confirm button disabled, onConfirm NOT called", async () => {
    const { onConfirm } = renderDialog({ required: true });

    const confirm = screen.getByRole("button", { name: /deny/i });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("required: true + whitespace-only → confirm stays disabled", () => {
    renderDialog({ required: true });

    const textarea = screen.getByLabelText(/reason/i);
    fireEvent.change(textarea, { target: { value: "   " } });

    const confirm = screen.getByRole("button", { name: /deny/i });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
  });

  test("required: true + real reason → confirm enabled and passes through", async () => {
    const { onConfirm } = renderDialog({ required: true });

    const textarea = screen.getByLabelText(/reason/i);
    fireEvent.change(textarea, { target: { value: "audited" } });

    const confirm = screen.getByRole("button", { name: /deny/i });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(onConfirm).toHaveBeenCalledWith("audited");
  });

  test("close blocked while loading — cancel button disabled, dialog stays mounted", () => {
    renderDialog({ loading: true });

    const cancel = screen.getByRole("button", { name: /cancel/i });
    const confirm = screen.getByRole("button", { name: /deny/i });
    expect((cancel as HTMLButtonElement).disabled).toBe(true);
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    // Dialog content stays mounted (textarea still reachable) so the
    // operator can't race the dialog close against a persisting request.
    expect(screen.getByLabelText(/reason/i)).not.toBeNull();
  });

  test("onConfirm throwing surfaces in alert AND logs — dialog stays open", async () => {
    const thrown = new Error("boom");
    const onConfirm = mock(() => Promise.reject(thrown));
    const onOpenChange = mock((_open: boolean) => {});
    const warnSpy = (await import("bun:test")).spyOn(console, "warn").mockImplementation(() => {});

    render(
      <ReasonDialog
        open
        onOpenChange={onOpenChange}
        title="Deny action"
        onConfirm={onConfirm}
      />,
    );

    const confirm = screen.getByRole("button", { name: /deny/i });
    await act(async () => {
      fireEvent.click(confirm);
    });

    expect(onConfirm).toHaveBeenCalled();
    // UI surface — operator sees the failure
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Unexpected error: boom");
    // Dialog must NOT close on its own — caller owns close via onOpenChange
    expect(onOpenChange).not.toHaveBeenCalled();
    // Observability — still reaches dev tools
    expect(warnSpy).toHaveBeenCalledWith("ReasonDialog: onConfirm threw", thrown);
    warnSpy.mockRestore();
  });

  test("onConfirm rejecting non-Error → stringified in alert", async () => {
    const onConfirm = mock(() => Promise.reject("raw string"));
    const warnSpy = (await import("bun:test")).spyOn(console, "warn").mockImplementation(() => {});

    render(
      <ReasonDialog
        open
        onOpenChange={() => {}}
        title="Deny action"
        onConfirm={onConfirm}
      />,
    );

    const confirm = screen.getByRole("button", { name: /deny/i });
    await act(async () => {
      fireEvent.click(confirm);
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Unexpected error: raw string");
    warnSpy.mockRestore();
  });

  test("localError takes precedence over caller-provided error prop", async () => {
    const thrown = new Error("local failure");
    const onConfirm = mock(() => Promise.reject(thrown));
    const warnSpy = (await import("bun:test")).spyOn(console, "warn").mockImplementation(() => {});

    render(
      <ReasonDialog
        open
        onOpenChange={() => {}}
        title="Deny action"
        onConfirm={onConfirm}
        error="caller-provided error"
      />,
    );

    // Before confirm — caller error shows
    expect(screen.getByRole("alert").textContent).toBe("caller-provided error");

    const confirm = screen.getByRole("button", { name: /deny/i });
    await act(async () => {
      fireEvent.click(confirm);
    });

    // After throw — local error takes over
    expect(screen.getByRole("alert").textContent).toBe("Unexpected error: local failure");
    warnSpy.mockRestore();
  });

  test("localError cleared when dialog reopens", async () => {
    const thrown = new Error("first attempt");
    const onConfirm = mock(() => Promise.reject(thrown));
    const warnSpy = (await import("bun:test")).spyOn(console, "warn").mockImplementation(() => {});

    const { rerender } = render(
      <ReasonDialog
        open
        onOpenChange={() => {}}
        title="Deny action"
        onConfirm={onConfirm}
      />,
    );

    const confirm = screen.getByRole("button", { name: /deny/i });
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(screen.getByRole("alert").textContent).toBe("Unexpected error: first attempt");

    // Close
    rerender(
      <ReasonDialog
        open={false}
        onOpenChange={() => {}}
        title="Deny action"
        onConfirm={onConfirm}
      />,
    );

    // Reopen — alert should be gone
    rerender(
      <ReasonDialog
        open
        onOpenChange={() => {}}
        title="Deny action"
        onConfirm={onConfirm}
      />,
    );

    expect(screen.queryByRole("alert")).toBeNull();
    warnSpy.mockRestore();
  });

  test("retry after failure clears localError within the same open session", async () => {
    // First call rejects, second resolves — simulates the operator fixing
    // the reason and retrying without closing the dialog.
    let attempt = 0;
    const onConfirm = mock(() => {
      attempt++;
      return attempt === 1 ? Promise.reject(new Error("boom")) : Promise.resolve();
    });
    const warnSpy = (await import("bun:test")).spyOn(console, "warn").mockImplementation(() => {});

    render(
      <ReasonDialog
        open
        onOpenChange={() => {}}
        title="Deny action"
        onConfirm={onConfirm}
      />,
    );

    const confirm = screen.getByRole("button", { name: /deny/i });
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(screen.getByRole("alert").textContent).toBe("Unexpected error: boom");

    // Retry — alert must clear at the start of the new attempt, not linger
    // behind a now-succeeding call.
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onConfirm).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });
});
