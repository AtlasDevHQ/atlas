import { describe, expect, test, afterEach, mock } from "bun:test";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { ReasonDialog } from "../components/admin/queue";

/**
 * Regression guard for the compliance contract: the reason captured in
 * the audit log must be exactly what the user typed (whitespace-trimmed),
 * including the empty string. The dialog must NOT substitute a
 * hardcoded placeholder like "Denied by admin".
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

describe("ReasonDialog compliance contract", () => {
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

  test("onConfirm throwing does not bubble — dialog catches and logs", async () => {
    const thrown = new Error("kaboom");
    const onConfirm = mock(() => Promise.reject(thrown));
    const errSpy = (await import("bun:test")).spyOn(console, "error").mockImplementation(() => {});

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

    expect(onConfirm).toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      "ReasonDialog: onConfirm threw",
      thrown,
    );
    errSpy.mockRestore();
  });
});
