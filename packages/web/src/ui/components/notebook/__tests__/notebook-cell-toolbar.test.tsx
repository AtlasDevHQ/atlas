import { describe, expect, test, afterEach, mock } from "bun:test";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { NotebookCellToolbar } from "../notebook-cell-toolbar";

function makeCallbacks() {
  return {
    onEdit: mock(() => {}),
    onRun: mock(() => {}),
    onCopy: mock(() => {}),
    onDelete: mock(() => {}),
  };
}

describe("NotebookCellToolbar", () => {
  afterEach(() => {
    cleanup();
  });

  test("mounts both render trees (md+ icon row AND below-md kebab)", () => {
    const cb = makeCallbacks();
    const { container } = render(
      <NotebookCellToolbar status="idle" editing={false} disabled={false} {...cb} />,
    );

    // Icon row (visible at md+, hidden at <md via Tailwind utilities)
    expect(container.querySelector('[role="toolbar"][aria-label="Cell actions"]')).not.toBeNull();

    // Kebab trigger (visible at <md via md:hidden)
    expect(container.querySelector('button[aria-label="Cell actions"]')).not.toBeNull();
  });

  test("md+ icon row renders Edit / Run / Copy / Delete with their aria-labels", () => {
    const { getByLabelText } = render(
      <NotebookCellToolbar status="idle" editing={false} disabled={false} {...makeCallbacks()} />,
    );
    expect(getByLabelText("Edit cell")).toBeDefined();
    expect(getByLabelText("Run cell")).toBeDefined();
    expect(getByLabelText("Copy cell")).toBeDefined();
    expect(getByLabelText("Delete cell")).toBeDefined();
  });

  test("editing=true flips the Edit button label to Cancel edit", () => {
    const { queryByLabelText } = render(
      <NotebookCellToolbar status="idle" editing={true} disabled={false} {...makeCallbacks()} />,
    );
    expect(queryByLabelText("Cancel edit")).not.toBeNull();
    expect(queryByLabelText("Edit cell")).toBeNull();
  });

  test("status=running disables Edit / Run / Delete in the icon row", () => {
    const { getByLabelText } = render(
      <NotebookCellToolbar status="running" editing={false} disabled={false} {...makeCallbacks()} />,
    );
    expect((getByLabelText("Edit cell") as HTMLButtonElement).disabled).toBe(true);
    expect((getByLabelText("Run cell") as HTMLButtonElement).disabled).toBe(true);
    expect((getByLabelText("Delete cell") as HTMLButtonElement).disabled).toBe(true);
  });

  test("Copy is NOT gated by status or disabled — it's the only safe action mid-run", () => {
    const { getByLabelText } = render(
      <NotebookCellToolbar status="running" editing={false} disabled={true} {...makeCallbacks()} />,
    );
    expect((getByLabelText("Copy cell") as HTMLButtonElement).disabled).toBe(false);
  });

  test("disabled=true (sibling cell running) disables Edit / Run / Delete but not Copy", () => {
    const { getByLabelText } = render(
      <NotebookCellToolbar status="idle" editing={false} disabled={true} {...makeCallbacks()} />,
    );
    expect((getByLabelText("Edit cell") as HTMLButtonElement).disabled).toBe(true);
    expect((getByLabelText("Run cell") as HTMLButtonElement).disabled).toBe(true);
    expect((getByLabelText("Delete cell") as HTMLButtonElement).disabled).toBe(true);
    expect((getByLabelText("Copy cell") as HTMLButtonElement).disabled).toBe(false);
  });

  test("clicking icon-row buttons fires the matching callback once", () => {
    const cb = makeCallbacks();
    const { getByLabelText } = render(
      <NotebookCellToolbar status="idle" editing={false} disabled={false} {...cb} />,
    );

    fireEvent.click(getByLabelText("Edit cell"));
    expect(cb.onEdit).toHaveBeenCalledTimes(1);

    fireEvent.click(getByLabelText("Run cell"));
    expect(cb.onRun).toHaveBeenCalledTimes(1);

    fireEvent.click(getByLabelText("Copy cell"));
    expect(cb.onCopy).toHaveBeenCalledTimes(1);

    fireEvent.click(getByLabelText("Delete cell"));
    expect(cb.onDelete).toHaveBeenCalledTimes(1);
  });

  test("Run shows spinner (Loader2) when status is running", () => {
    const { getByLabelText } = render(
      <NotebookCellToolbar status="running" editing={false} disabled={false} {...makeCallbacks()} />,
    );
    // Loader2 in the icon row replaces the Play icon when running.
    const runBtn = getByLabelText("Run cell");
    expect(runBtn.querySelector(".animate-spin")).not.toBeNull();
  });
});
