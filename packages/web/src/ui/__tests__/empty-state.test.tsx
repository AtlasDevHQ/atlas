import { describe, expect, test, mock } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
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

  test("renders title prop", () => {
    const { container } = render(<EmptyState icon={Search} title="No users yet" />);
    expect(container.textContent).toContain("No users yet");
  });

  test("title takes precedence over message", () => {
    const { container } = render(
      <EmptyState icon={Search} title="Title wins" message="Message loses" />,
    );
    expect(container.textContent).toContain("Title wins");
    expect(container.textContent).not.toContain("Message loses");
  });

  test("renders description when provided", () => {
    const { container } = render(
      <EmptyState icon={Search} title="Empty" description="Try something else" />,
    );
    expect(container.textContent).toContain("Try something else");
  });

  test("renders action button and fires onClick", () => {
    const onClick = mock(() => {});
    const { container } = render(
      <EmptyState
        icon={Search}
        title="No results"
        action={{ label: "Clear filters", onClick }}
      />,
    );
    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button!.textContent).toContain("Clear filters");
    fireEvent.click(button!);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("omits action button when not provided", () => {
    const { container } = render(<EmptyState icon={Search} title="Empty" />);
    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBe(0);
  });
});
