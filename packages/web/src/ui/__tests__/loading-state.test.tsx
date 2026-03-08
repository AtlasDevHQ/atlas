import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { LoadingState } from "../components/admin/loading-state";

describe("LoadingState", () => {
  test("renders default message", () => {
    const { container } = render(<LoadingState />);
    expect(container.textContent).toContain("Loading...");
  });

  test("renders custom message", () => {
    const { container } = render(<LoadingState message="Checking authentication..." />);
    expect(container.textContent).toContain("Checking authentication...");
  });

  test("has spinner element", () => {
    const { container } = render(<LoadingState />);
    // Lucide Loader2 renders an SVG with animate-spin
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
  });
});
