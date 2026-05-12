import { describe, expect, test, mock } from "bun:test";
import { render, fireEvent, waitFor } from "@testing-library/react";

import { DatePicker } from "./date-picker";
import { DateRangePicker } from "./date-range-picker";

function getTrigger(container: HTMLElement) {
  const trigger = container.querySelector<HTMLButtonElement>(
    'button[data-slot="date-picker-trigger"]',
  );
  if (!trigger) throw new Error("Trigger button not found");
  return trigger;
}

function getRangeTrigger(container: HTMLElement) {
  const trigger = container.querySelector<HTMLButtonElement>(
    'button[data-slot="date-range-picker-trigger"]',
  );
  if (!trigger) throw new Error("Range trigger button not found");
  return trigger;
}

describe("DatePicker", () => {
  test("renders placeholder when value is undefined", () => {
    const { container } = render(
      <DatePicker value={undefined} onChange={() => {}} placeholder="Pick a date" />,
    );
    expect(getTrigger(container).textContent).toContain("Pick a date");
  });

  test("renders formatted date when value is set", () => {
    const value = new Date(2026, 2, 27); // March 27, 2026 local
    const { container } = render(
      <DatePicker value={value} onChange={() => {}} />,
    );
    const text = getTrigger(container).textContent ?? "";
    expect(text).toContain("March");
    expect(text).toContain("2026");
  });

  test("opens calendar popover when trigger clicked", async () => {
    const { container, baseElement } = render(
      <DatePicker value={undefined} onChange={() => {}} />,
    );
    fireEvent.click(getTrigger(container));
    await waitFor(() => {
      expect(baseElement.querySelector('[data-slot="calendar"]')).not.toBeNull();
    });
  });

  test("forwards aria-label and disabled to trigger", () => {
    const { container } = render(
      <DatePicker
        value={undefined}
        onChange={() => {}}
        aria-label="From date"
        disabled
      />,
    );
    const trigger = getTrigger(container);
    expect(trigger.getAttribute("aria-label")).toBe("From date");
    expect(trigger.disabled).toBe(true);
  });

  test("calls onChange with a Date when a day is picked", async () => {
    const onChange = mock((_: Date | undefined) => {});
    const value = new Date(2026, 2, 1); // March 1, 2026
    const { container, baseElement } = render(
      <DatePicker value={value} onChange={onChange} />,
    );

    fireEvent.click(getTrigger(container));
    await waitFor(() => {
      expect(baseElement.querySelector('[data-slot="calendar"]')).not.toBeNull();
    });

    const day = baseElement.querySelector<HTMLButtonElement>(
      'button[data-day="3/15/2026"]',
    );
    if (!day) {
      // happy-dom may not surface the data-day attribute; fall back to clicking
      // any day cell button inside the popover.
      const fallback = baseElement.querySelector<HTMLButtonElement>(
        '[data-slot="calendar"] button[data-day]',
      );
      if (!fallback) throw new Error("No day cell rendered");
      fireEvent.click(fallback);
    } else {
      fireEvent.click(day);
    }

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });
    const arg = onChange.mock.calls[0]?.[0];
    expect(arg).toBeInstanceOf(Date);
  });
});

describe("DateRangePicker", () => {
  test("renders placeholder when range empty", () => {
    const { container } = render(
      <DateRangePicker
        value={undefined}
        onChange={() => {}}
        placeholder="Date range"
      />,
    );
    expect(getRangeTrigger(container).textContent).toContain("Date range");
  });

  test("renders single date when only from is set", () => {
    const { container } = render(
      <DateRangePicker
        value={{ from: new Date(2026, 4, 1), to: undefined }}
        onChange={() => {}}
      />,
    );
    expect(getRangeTrigger(container).textContent).toContain("May");
  });

  test("renders 'from – to' when both ends set", () => {
    const { container } = render(
      <DateRangePicker
        value={{ from: new Date(2026, 4, 1), to: new Date(2026, 4, 10) }}
        onChange={() => {}}
      />,
    );
    expect(getRangeTrigger(container).textContent).toMatch(/May.*May/);
  });

  test("opens calendar popover when trigger clicked", async () => {
    const { container, baseElement } = render(
      <DateRangePicker value={undefined} onChange={() => {}} />,
    );
    fireEvent.click(getRangeTrigger(container));
    await waitFor(() => {
      expect(baseElement.querySelector('[data-slot="calendar"]')).not.toBeNull();
    });
  });
});
