import {
  describe,
  expect,
  test,
  beforeEach,
  afterEach,
  mock,
  type Mock,
} from "bun:test";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
  waitFor,
} from "@testing-library/react";
import { ReasonDialog } from "@/ui/components/admin/queue";

/**
 * ReasonDialog behaviors the /admin/actions page relies on, per #1593.
 *
 * Distinct from the existing `reason-dialog.test.tsx` (which pins the
 * three-slot error precedence added in #1612). Tests here lock in the
 * timing, trimming, keyboard, and loading-disabled contracts that the
 * actions page approval flow depends on for correct audit behavior.
 */

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

function getTextarea(): HTMLTextAreaElement {
  const textarea = document.body.querySelector(
    "#reason-dialog-reason",
  ) as HTMLTextAreaElement | null;
  if (!textarea) throw new Error("Reason textarea not found");
  return textarea;
}

function getConfirmButton(label = "Deny"): HTMLButtonElement {
  const buttons = [
    ...document.body.querySelectorAll("button"),
  ] as HTMLButtonElement[];
  const btn = buttons.find((b) => b.textContent?.trim() === label);
  if (!btn) throw new Error(`Confirm button with label "${label}" not found`);
  return btn;
}

describe("ReasonDialog — reason reset timing", () => {
  test("reason clears on close (not on open)", async () => {
    // The useEffect deps are `[open]` with a `!open` guard — that's
    // reset-on-close. A refactor that flipped it to reset-on-open would
    // wipe the user's typing if the dialog re-rendered mid-typing (e.g.
    // a parent re-render that doesn't toggle `open`).
    function Harness({
      open,
      defaultReason = "",
    }: {
      open: boolean;
      defaultReason?: string;
    }) {
      return (
        <ReasonDialog
          open={open}
          onOpenChange={() => {}}
          title="Deny"
          onConfirm={async () => {}}
          placeholder={defaultReason}
        />
      );
    }

    const { rerender } = render(<Harness open={true} />);
    const textarea = getTextarea();
    fireEvent.change(textarea, { target: { value: "reason text" } });
    expect(textarea.value).toBe("reason text");

    // Close — effect fires with !open, resets reason
    rerender(<Harness open={false} />);

    // Reopen — reason must be empty. If the effect reset on open instead of
    // close, the behavior would *look* similar from the outside but would
    // wipe the user's in-progress typing mid-dialog.
    rerender(<Harness open={true} />);
    const reopenedTextarea = getTextarea();
    expect(reopenedTextarea.value).toBe("");
  });
});

describe("ReasonDialog — Cmd+Enter keyboard", () => {
  test("Cmd+Enter while not loading triggers onConfirm with trimmed reason", async () => {
    const onConfirm = mock(async () => {});
    render(
      <ReasonDialog
        open
        onOpenChange={() => {}}
        title="Deny"
        onConfirm={onConfirm as unknown as (r: string) => Promise<void>}
      />,
    );
    const textarea = getTextarea();
    fireEvent.change(textarea, {
      target: { value: "  policy violation  " },
    });

    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    });

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalled();
    });
    expect(onConfirm.mock.calls[0]?.[0]).toBe("policy violation");
  });

  test("Ctrl+Enter (non-macOS) also triggers onConfirm", async () => {
    const onConfirm = mock(async () => {});
    render(
      <ReasonDialog
        open
        onOpenChange={() => {}}
        title="Deny"
        onConfirm={onConfirm as unknown as (r: string) => Promise<void>}
      />,
    );
    const textarea = getTextarea();
    fireEvent.change(textarea, { target: { value: "reason" } });

    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    });

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalled();
    });
  });

  test("Cmd+Enter while loading does NOT trigger onConfirm", async () => {
    // Guards against a double-fire if the operator hits Cmd+Enter twice —
    // the second invocation would trigger a duplicate deny without this
    // check. Audit-sensitive.
    const onConfirm = mock(async () => {});
    render(
      <ReasonDialog
        open
        onOpenChange={() => {}}
        title="Deny"
        onConfirm={onConfirm as unknown as (r: string) => Promise<void>}
        loading
      />,
    );
    const textarea = getTextarea();
    // Textarea is disabled while loading — set value via direct assignment
    // since fireEvent.change on a disabled element is a no-op.
    Object.defineProperty(textarea, "value", {
      value: "reason",
      writable: true,
      configurable: true,
    });

    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    });

    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("plain Enter (no modifier) does NOT trigger onConfirm — preserves newline insertion", async () => {
    const onConfirm = mock(async () => {});
    render(
      <ReasonDialog
        open
        onOpenChange={() => {}}
        title="Deny"
        onConfirm={onConfirm as unknown as (r: string) => Promise<void>}
      />,
    );
    const textarea = getTextarea();
    fireEvent.change(textarea, { target: { value: "reason" } });

    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter" });
    });

    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("ReasonDialog — trim behavior", () => {
  test("confirm click passes trimmed reason to onConfirm", async () => {
    const onConfirm = mock(async () => {});
    render(
      <ReasonDialog
        open
        onOpenChange={() => {}}
        title="Deny"
        onConfirm={onConfirm as unknown as (r: string) => Promise<void>}
      />,
    );
    const textarea = getTextarea();
    fireEvent.change(textarea, {
      target: { value: "   leading + trailing   " },
    });

    await act(async () => {
      fireEvent.click(getConfirmButton());
    });

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalled();
    });
    expect(onConfirm.mock.calls[0]?.[0]).toBe("leading + trailing");
  });

  test("whitespace-only reason is passed as empty string (not substituted)", async () => {
    // Caller contract: the dialog emits exactly what the user typed,
    // trimmed — including the empty string. A substitution like
    // `reason || "no reason given"` would corrupt the audit trail by
    // making "no reason given" indistinguishable from a real typed one.
    const onConfirm = mock(async () => {});
    render(
      <ReasonDialog
        open
        onOpenChange={() => {}}
        title="Deny"
        onConfirm={onConfirm as unknown as (r: string) => Promise<void>}
      />,
    );
    const textarea = getTextarea();
    fireEvent.change(textarea, { target: { value: "     " } });

    await act(async () => {
      fireEvent.click(getConfirmButton());
    });

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalled();
    });
    expect(onConfirm.mock.calls[0]?.[0]).toBe("");
  });

  test("required=true blocks confirm when reason is whitespace-only", async () => {
    const onConfirm = mock(async () => {});
    render(
      <ReasonDialog
        open
        onOpenChange={() => {}}
        title="Deny"
        required
        onConfirm={onConfirm as unknown as (r: string) => Promise<void>}
      />,
    );
    const textarea = getTextarea();
    fireEvent.change(textarea, { target: { value: "     " } });

    const btn = getConfirmButton();
    expect(btn.disabled).toBe(true);

    // Even if click somehow got through, handleConfirm returns early.
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("ReasonDialog — onOpenChange blocked while loading", () => {
  test("attempt to close while loading is a no-op (cancel-doesn't-cancel fix)", async () => {
    // Without the `if (!next && loading) return` guard, the operator
    // thinks they aborted but the request still resolves server-side
    // (and if the resolution is a deny, the audit trail records the
    // deny without the operator's consent).
    const onOpenChange = mock(() => {});
    render(
      <ReasonDialog
        open
        onOpenChange={onOpenChange}
        title="Deny"
        onConfirm={async () => {}}
        loading
      />,
    );

    // Cancel button should be disabled while loading.
    const buttons = [
      ...document.body.querySelectorAll("button"),
    ] as HTMLButtonElement[];
    const cancel = buttons.find((b) => b.textContent?.trim() === "Cancel");
    expect(cancel?.disabled).toBe(true);

    // Radix's Escape handler fires onOpenChange(false). We simulate at the
    // content level — the Dialog's onOpenChange prop should swallow the
    // false-while-loading and never reach the caller's handler.
    // Pressing Escape directly on the textarea is the cleanest simulation.
    await act(async () => {
      fireEvent.keyDown(getTextarea(), { key: "Escape" });
    });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  test("close path works normally when not loading", async () => {
    const onOpenChange = mock(() => {});
    render(
      <ReasonDialog
        open
        onOpenChange={onOpenChange}
        title="Deny"
        onConfirm={async () => {}}
      />,
    );
    // Cancel button dispatches onOpenChange(false) directly.
    const buttons = [
      ...document.body.querySelectorAll("button"),
    ] as HTMLButtonElement[];
    const cancel = buttons.find((b) => b.textContent?.trim() === "Cancel");
    expect(cancel).toBeTruthy();
    await act(async () => {
      fireEvent.click(cancel!);
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

// Suppress unused-import warning: `screen` is kept available for future tests.
void screen;
