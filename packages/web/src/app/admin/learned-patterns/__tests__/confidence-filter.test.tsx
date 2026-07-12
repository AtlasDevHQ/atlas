import { describe, expect, test, mock, afterEach } from "bun:test";
import { render, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { ConfidenceFilter } from "../confidence-filter";

afterEach(() => {
  cleanup();
});

/** Open the popover by clicking the trigger; return its content root. */
async function openPopover(container: HTMLElement): Promise<HTMLElement> {
  const trigger = container.querySelector("button");
  if (!trigger) throw new Error("trigger button not found");
  fireEvent.click(trigger);
  await waitFor(() => {
    if (!document.querySelector("#confidence-min")) throw new Error("popover not open");
  });
  return document.body;
}

describe("ConfidenceFilter", () => {
  test("shows a neutral label when no bounds are set", () => {
    const { container } = render(
      <ConfidenceFilter min="" max="" onApply={() => {}} />,
    );
    expect(container.querySelector("button")?.textContent).toContain("Confidence");
    expect(container.querySelector("button")?.textContent).not.toContain("%");
  });

  test("shows the applied range as a percentage in the trigger label", () => {
    const { container } = render(
      <ConfidenceFilter min="0.5" max="0.9" onApply={() => {}} />,
    );
    expect(container.querySelector("button")?.textContent).toContain("Confidence 50–90%");
  });

  test("labels a one-sided range with the open bound's placeholder", () => {
    const minOnly = render(<ConfidenceFilter min="0.5" max="" onApply={() => {}} />);
    expect(minOnly.container.querySelector("button")?.textContent).toContain("Confidence 50–100%");
    cleanup();
    const maxOnly = render(<ConfidenceFilter min="" max="0.9" onApply={() => {}} />);
    expect(maxOnly.container.querySelector("button")?.textContent).toContain("Confidence 0–90%");
  });

  test("apply converts percentage inputs to the API decimal bounds", async () => {
    const onApply = mock((_bounds: { min: string; max: string }) => {});
    const { container } = render(
      <ConfidenceFilter min="" max="" onApply={onApply} />,
    );
    const body = await openPopover(container);
    fireEvent.change(within(body).getByLabelText("Min %"), { target: { value: "50" } });
    fireEvent.change(within(body).getByLabelText("Max %"), { target: { value: "90" } });
    fireEvent.click(within(body).getByText("Apply"));

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toEqual({ min: "0.5", max: "0.9" });
  });

  test("apply swaps an inverted range so it is never sent min > max", async () => {
    const onApply = mock((_bounds: { min: string; max: string }) => {});
    const { container } = render(
      <ConfidenceFilter min="" max="" onApply={onApply} />,
    );
    const body = await openPopover(container);
    fireEvent.change(within(body).getByLabelText("Min %"), { target: { value: "90" } });
    fireEvent.change(within(body).getByLabelText("Max %"), { target: { value: "50" } });
    fireEvent.click(within(body).getByText("Apply"));

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toEqual({ min: "0.5", max: "0.9" });
  });

  test("clear emits empty bounds", async () => {
    const onApply = mock((_bounds: { min: string; max: string }) => {});
    const { container } = render(
      <ConfidenceFilter min="0.5" max="0.9" onApply={onApply} />,
    );
    const body = await openPopover(container);
    fireEvent.click(within(body).getByText("Clear"));

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toEqual({ min: "", max: "" });
  });

  test("seeds the draft inputs from the applied bounds on open", async () => {
    const { container } = render(
      <ConfidenceFilter min="0.25" max="0.75" onApply={() => {}} />,
    );
    const body = await openPopover(container);
    expect((within(body).getByLabelText("Min %") as HTMLInputElement).value).toBe("25");
    expect((within(body).getByLabelText("Max %") as HTMLInputElement).value).toBe("75");
  });
});
