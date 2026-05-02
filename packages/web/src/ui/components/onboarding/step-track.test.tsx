import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { StepTrack } from "./step-track";

const STEPS = [
  { id: "a", label: "Account" },
  { id: "b", label: "Workspace" },
  { id: "c", label: "Done" },
] as const;

describe("StepTrack", () => {
  test("renders all step labels", () => {
    const { container } = render(<StepTrack steps={STEPS} current="a" />);
    expect(container.textContent).toContain("Account");
    expect(container.textContent).toContain("Workspace");
    expect(container.textContent).toContain("Done");
  });

  test("renders the desktop step number for each non-completed step", () => {
    const { container } = render(<StepTrack steps={STEPS} current="b" />);
    // Completed step has the check icon (no "1" rendered), current and later get their number.
    const numbers = Array.from(container.querySelectorAll("ol span")).map((el) => el.textContent);
    expect(numbers).toContain("2");
    expect(numbers).toContain("3");
  });

  test("renders the mobile pill with Step X of Y · label", () => {
    const { container } = render(<StepTrack steps={STEPS} current="b" />);
    expect(container.textContent).toContain("Step 2 of 3");
    expect(container.textContent).toContain("Workspace");
  });

  test("marks the current step with aria-current", () => {
    const { container } = render(<StepTrack steps={STEPS} current="b" />);
    const current = container.querySelector('[aria-current="step"]');
    expect(current).not.toBeNull();
    expect(current?.textContent).toContain("Workspace");
  });

  test("uses the custom aria-label when provided", () => {
    const { container } = render(
      <StepTrack steps={STEPS} current="a" ariaLabel="Custom progress" />,
    );
    const nav = container.querySelector("nav");
    expect(nav?.getAttribute("aria-label")).toBe("Custom progress");
  });

  test("throws when current is not in steps", () => {
    expect(() => render(<StepTrack steps={STEPS} current="not-a-step" />)).toThrow(
      /not found/i,
    );
  });
});
