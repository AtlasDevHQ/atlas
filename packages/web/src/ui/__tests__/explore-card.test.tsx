import { describe, expect, test } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { ExploreCard } from "../components/chat/explore-card";

function makePart(overrides: Record<string, unknown> = {}) {
  return {
    input: { command: "ls semantic/" },
    output: "entities/\nmetrics/\ncatalog.yml\nglossary.yml",
    state: "output-available",
    ...overrides,
  };
}

describe("ExploreCard", () => {
  test("renders command text", () => {
    const { container } = render(<ExploreCard part={makePart()} />);
    expect(container.textContent).toContain("ls semantic/");
  });

  test("output is hidden by default (collapsed)", () => {
    const { container } = render(<ExploreCard part={makePart()} />);
    const pre = container.querySelector("pre");
    expect(pre).toBeNull();
  });

  test("clicking expands to show output", () => {
    const { container } = render(<ExploreCard part={makePart()} />);
    const button = container.querySelector("button")!;
    fireEvent.click(button);
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain("entities/");
  });

  test("clicking again collapses output", () => {
    const { container } = render(<ExploreCard part={makePart()} />);
    const button = container.querySelector("button")!;
    fireEvent.click(button); // open
    fireEvent.click(button); // close
    const pre = container.querySelector("pre");
    expect(pre).toBeNull();
  });

  test("shows running state when not complete", () => {
    const { container } = render(
      <ExploreCard part={makePart({ state: "running", output: undefined })} />,
    );
    expect(container.textContent).toContain("running...");
  });

  test("does not expand when still running", () => {
    const { container } = render(
      <ExploreCard part={makePart({ state: "running", output: undefined })} />,
    );
    const button = container.querySelector("button")!;
    fireEvent.click(button);
    // Should NOT expand — still running
    const pre = container.querySelector("pre");
    expect(pre).toBeNull();
  });

  test("shows empty command when input is missing", () => {
    const { container } = render(
      <ExploreCard part={makePart({ input: {} })} />,
    );
    // Should not crash — renders with empty command
    expect(container.querySelector("button")).not.toBeNull();
  });

  test("renders JSON output when result is an object", () => {
    const { container } = render(
      <ExploreCard part={makePart({ output: { files: ["a.yml", "b.yml"] } })} />,
    );
    const button = container.querySelector("button")!;
    fireEvent.click(button);
    const pre = container.querySelector("pre");
    expect(pre!.textContent).toContain("a.yml");
  });

  test("renders null output as no-output message", () => {
    const { container } = render(
      <ExploreCard part={makePart({ output: null })} />,
    );
    const button = container.querySelector("button")!;
    fireEvent.click(button);
    expect(container.textContent).toContain("(no output received)");
  });
});
