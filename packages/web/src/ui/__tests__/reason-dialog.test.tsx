import { describe, expect, test, afterEach, mock } from "bun:test";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { ReasonDialog } from "../components/admin/queue";

/**
 * Regression guards for two invariants this dialog owns:
 *
 * 1. Compliance contract — the reason captured in the audit log must be
 *    exactly what the user typed (whitespace-trimmed), including the
 *    empty string. The dialog must NOT substitute a hardcoded
 *    placeholder like "Denied by admin".
 *
 * 2. Error surfacing — a throwing `onConfirm` must be visible to the
 *    operator (alert + dialog stays mounted) and still reach
 *    observability, rather than failing silently.
 */

afterEach(() => cleanup());

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
