/**
 * Dashboard parameter bar tests (#2267).
 *
 * Pins the bar's contract: renders a control per parameter, reports empty
 * overrides on mount ("use defaults"), commits text/number values, and
 * collapses to nothing when there are no parameters. nuqs is mocked with a
 * `useState`-backed `useQueryState` so the commit→re-render→onChange loop runs
 * without a URL adapter.
 */
import { describe, expect, test, afterEach, mock } from "bun:test";
import { useState } from "react";

mock.module("nuqs", () => ({
  parseAsString: {},
  useQueryState: () => useState<string | null>(null),
}));

import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { DashboardParameterBar } from "../dashboard-parameter-bar";
import type { DashboardParameter } from "@/ui/lib/types";

afterEach(cleanup);

const TEXT: DashboardParameter = { key: "region", type: "text", default: null, label: "Region" };
const NUM: DashboardParameter = { key: "limit_n", type: "number", default: 10, label: "Top N" };

describe("DashboardParameterBar", () => {
  test("renders a control per parameter and reports empty overrides on mount", () => {
    const onChange = mock((_: Record<string, string | number | null>) => {});
    render(<DashboardParameterBar parameters={[TEXT, NUM]} onChange={onChange} />);

    expect(screen.getByLabelText("Region")).toBeDefined();
    expect(screen.getByLabelText("Top N")).toBeDefined();
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({});
  });

  test("commits a text parameter on blur", () => {
    const onChange = mock((_: Record<string, string | number | null>) => {});
    render(<DashboardParameterBar parameters={[TEXT]} onChange={onChange} />);

    const input = screen.getByLabelText("Region") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "us" } });
    fireEvent.blur(input);

    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({ region: "us" });
  });

  test("coerces a number parameter to a number on commit", () => {
    const onChange = mock((_: Record<string, string | number | null>) => {});
    render(<DashboardParameterBar parameters={[NUM]} onChange={onChange} />);

    const input = screen.getByLabelText("Top N") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "25" } });
    fireEvent.blur(input);

    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({ limit_n: 25 });
  });

  test("renders nothing when there are no parameters", () => {
    const onChange = mock((_: Record<string, string | number | null>) => {});
    const { container } = render(<DashboardParameterBar parameters={[]} onChange={onChange} />);
    expect(container.firstChild).toBeNull();
  });
});
