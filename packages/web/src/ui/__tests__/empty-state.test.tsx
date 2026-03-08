import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { EmptyState } from "../components/admin/empty-state";
import { Search } from "lucide-react";

describe("EmptyState", () => {
  test("renders message", () => {
    const { container } = render(<EmptyState icon={Search} message="No results found" />);
    expect(container.textContent).toContain("No results found");
  });

  test("renders icon as SVG", () => {
    const { container } = render(<EmptyState icon={Search} message="Empty" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
  });

  test("renders children when provided", () => {
    const { container } = render(
      <EmptyState icon={Search} message="Nothing here">
        <button>Try again</button>
      </EmptyState>,
    );
    expect(container.textContent).toContain("Try again");
  });

  test("renders without children", () => {
    const { container } = render(<EmptyState icon={Search} message="Empty" />);
    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBe(0);
  });
});
