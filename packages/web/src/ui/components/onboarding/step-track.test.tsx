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

  test("renders the desktop step number for non-completed steps", () => {
    const { container } = render(<StepTrack steps={STEPS} current="b" />);
    // Filter to circles only — they're aria-hidden so labels don't pollute the match.
    const circles = Array.from(container.querySelectorAll('ol [aria-hidden="true"]'));
    const circleText = circles.map((el) => el.textContent ?? "");
    expect(circleText).toContain("2");
    expect(circleText).toContain("3");
  });

  test("renders the mobile pill with Step X of Y", () => {
    const { container } = render(<StepTrack steps={STEPS} current="b" />);
    expect(container.textContent).toContain("Step 2 of 3");
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

  test("first step renders no completed checks", () => {
    const { container } = render(<StepTrack steps={STEPS} current="a" />);
    // The check icon only renders for completed steps. Use the lucide class
    // signature; if the icon library renames, this assertion needs updating.
    expect(container.querySelectorAll(".lucide-check").length).toBe(0);
  });

  test("last step renders checks for all prior steps", () => {
    const { container } = render(<StepTrack steps={STEPS} current="c" />);
    expect(container.querySelectorAll(".lucide-check").length).toBe(2);
  });

  test("single-step list renders without divide-by-zero", () => {
    const single = [{ id: "only", label: "Only" }] as const;
    const { container } = render(<StepTrack steps={single} current="only" />);
    expect(container.textContent).toContain("Step 1 of 1");
  });

  test("throws when current is not in steps", () => {
    expect(() =>
      // @ts-expect-error — intentionally violating the generic constraint to verify the runtime guard
      render(<StepTrack steps={STEPS} current="not-a-step" />),
    ).toThrow(/not found/i);
  });
});
