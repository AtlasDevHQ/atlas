/**
 * #4322 — FollowUpChips gains a `disabled` mode for the read-only History
 * transcript: the parsed <suggestions> still render, but clicking is a no-op
 * (a finished session has no live composer). The live drawer/chat keeps them
 * interactive.
 */

import { describe, expect, test, afterEach, mock } from "bun:test";
import { render, cleanup, fireEvent } from "@testing-library/react";

const { FollowUpChips } = await import("../follow-up-chips");

afterEach(cleanup);

describe("FollowUpChips", () => {
  test("renders nothing for empty suggestions", () => {
    const { container } = render(<FollowUpChips suggestions={[]} onSelect={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  test("interactive: clicking a chip fires onSelect with its text", () => {
    const onSelect = mock((_t: string) => {});
    const { getByText } = render(
      <FollowUpChips suggestions={["Add a regional card"]} onSelect={onSelect} />,
    );
    fireEvent.click(getByText("Add a regional card"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toBe("Add a regional card");
  });

  test("disabled: chips render but clicking is a no-op", () => {
    const onSelect = mock((_t: string) => {});
    const { getByText } = render(
      <FollowUpChips suggestions={["Stack the KPIs"]} onSelect={onSelect} disabled />,
    );
    const chip = getByText("Stack the KPIs");
    expect(chip).toBeTruthy();
    fireEvent.click(chip);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
