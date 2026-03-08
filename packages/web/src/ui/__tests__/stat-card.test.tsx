import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { StatCard } from "../components/admin/stat-card";

describe("StatCard", () => {
  test("renders title and value", () => {
    const { container } = render(<StatCard title="Connections" value={5} />);
    expect(container.textContent).toContain("Connections");
    expect(container.textContent).toContain("5");
  });

  test("renders string value", () => {
    const { container } = render(<StatCard title="Status" value="Active" />);
    expect(container.textContent).toContain("Active");
  });

  test("renders icon when provided", () => {
    const { container } = render(
      <StatCard title="Test" value={0} icon={<span data-testid="icon">IC</span>} />,
    );
    expect(container.textContent).toContain("IC");
  });

  test("renders description when provided", () => {
    const { container } = render(
      <StatCard title="Entities" value={12} description="Tables & views in semantic layer" />,
    );
    expect(container.textContent).toContain("Tables & views in semantic layer");
  });

  test("omits description element when not provided", () => {
    const { container } = render(<StatCard title="T" value={0} />);
    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs.length).toBe(0);
  });

  test("renders zero value", () => {
    const { container } = render(<StatCard title="Plugins" value={0} />);
    expect(container.textContent).toContain("0");
  });

  test("applies custom className", () => {
    const { container } = render(<StatCard title="T" value={1} className="custom-class" />);
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain("custom-class");
  });
});
