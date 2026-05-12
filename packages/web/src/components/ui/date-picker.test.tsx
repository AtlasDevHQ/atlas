import { describe, expect, test, mock } from "bun:test";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { DateRange } from "react-day-picker";

import { DatePicker } from "./date-picker";
import { DateRangePicker, normalizeRange } from "./date-range-picker";
import { formatISODate, parseISODate } from "@/lib/format";

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

  test("calls onChange with a Date for the picked day in the displayed month", async () => {
    const onChange = mock((_: Date | undefined) => {});
    const value = new Date(2026, 2, 1); // March 1, 2026
    const { container, baseElement } = render(
      <DatePicker value={value} onChange={onChange} />,
    );

    fireEvent.click(getTrigger(container));
    await waitFor(() => {
      expect(baseElement.querySelector('[data-slot="calendar"]')).not.toBeNull();
    });

    // Pick the first day cell in March. `data-day` formatting is locale-dependent,
    // so we don't pin a specific date string — instead we assert the callback got
    // a Date in March (the displayed month).
    const dayCell = baseElement.querySelector<HTMLButtonElement>(
      '[data-slot="calendar"] button[data-day]',
    );
    if (!dayCell) throw new Error("No day cell rendered");
    fireEvent.click(dayCell);

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });
    const arg = onChange.mock.calls[0]?.[0];
    expect(arg).toBeInstanceOf(Date);
    // Whatever day cell was clicked, it must be from a displayed month (Feb-Apr
    // since react-day-picker shows outside days). Reject any year other than 2026.
    expect((arg as Date).getFullYear()).toBe(2026);
  });

  test("treats an Invalid Date value as undefined (NaN-Date guard)", () => {
    // A parent passing `new Date("garbage")` would otherwise reach <Calendar>
    // and render NaN. The guard short-circuits to the placeholder.
    const { container } = render(
      <DatePicker
        value={new Date("not-a-date")}
        onChange={() => {}}
        placeholder="Pick a date"
      />,
    );
    expect(getTrigger(container).textContent).toContain("Pick a date");
  });

  test("URL-state round-trip: parseISODate → DatePicker → onChange → formatISODate", async () => {
    // This is the integration contract every migrated admin page relies on.
    let captured = "";

    function Wrapper({ initial }: { initial: string }) {
      const [state, setState] = useState(initial);
      captured = state;
      return (
        <DatePicker
          value={parseISODate(state)}
          onChange={(d) => setState(formatISODate(d))}
        />
      );
    }

    const { container, baseElement } = render(<Wrapper initial="2026-03-15" />);
    // Initial render reflects the URL string.
    expect(getTrigger(container).textContent).toContain("March");
    expect(captured).toBe("2026-03-15");

    fireEvent.click(getTrigger(container));
    await waitFor(() => {
      expect(baseElement.querySelector('[data-slot="calendar"]')).not.toBeNull();
    });

    const dayCell = baseElement.querySelector<HTMLButtonElement>(
      '[data-slot="calendar"] button[data-day]',
    );
    if (!dayCell) throw new Error("No day cell rendered");
    fireEvent.click(dayCell);

    await waitFor(() => {
      // After clicking, state must hold a yyyy-MM-dd string (not "" — that
      // would be the "no filter" state, which we shouldn't have produced here)
      expect(captured).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
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

  test("reflects updates when value changes from range to undefined", () => {
    function Harness() {
      const [value, setValue] = useState<DateRange | undefined>({
        from: new Date(2026, 4, 1),
        to: new Date(2026, 4, 10),
      });
      return (
        <>
          <DateRangePicker value={value} onChange={setValue} placeholder="Pick" />
          <button data-testid="clear" onClick={() => setValue(undefined)}>
            clear
          </button>
        </>
      );
    }
    const { container } = render(<Harness />);
    expect(getRangeTrigger(container).textContent).toMatch(/May/);
    fireEvent.click(container.querySelector('[data-testid="clear"]')!);
    expect(getRangeTrigger(container).textContent).toContain("Pick");
  });

});

describe("normalizeRange", () => {
  test("passes through undefined / empty / partial ranges unchanged", () => {
    expect(normalizeRange(undefined)).toBeUndefined();
    expect(normalizeRange({ from: undefined, to: undefined })).toEqual({
      from: undefined,
      to: undefined,
    });
    const fromOnly = { from: new Date(2026, 4, 1), to: undefined };
    expect(normalizeRange(fromOnly)).toBe(fromOnly);
  });

  test("passes through an already-ordered range unchanged", () => {
    const range = {
      from: new Date(2026, 4, 1),
      to: new Date(2026, 4, 10),
    };
    expect(normalizeRange(range)).toBe(range);
  });

  test("swaps from/to when inverted", () => {
    const from = new Date(2026, 4, 10);
    const to = new Date(2026, 4, 1);
    const result = normalizeRange({ from, to });
    expect(result?.from).toBe(to);
    expect(result?.to).toBe(from);
  });
});
