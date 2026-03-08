import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { HealthBadge } from "../components/admin/health-badge";

describe("HealthBadge", () => {
  test("renders healthy status with green dot", () => {
    const { container } = render(<HealthBadge status="healthy" />);
    expect(container.textContent).toContain("Healthy");
    const dot = container.querySelector("span span") as HTMLElement;
    expect(dot.className).toContain("bg-emerald-500");
  });

  test("renders degraded status with amber dot", () => {
    const { container } = render(<HealthBadge status="degraded" />);
    expect(container.textContent).toContain("Degraded");
    const dot = container.querySelector("span span") as HTMLElement;
    expect(dot.className).toContain("bg-amber-500");
  });

  test("renders down status with red dot", () => {
    const { container } = render(<HealthBadge status="down" />);
    expect(container.textContent).toContain("Down");
    const dot = container.querySelector("span span") as HTMLElement;
    expect(dot.className).toContain("bg-red-500");
  });

  test("renders unknown status with zinc dot", () => {
    const { container } = render(<HealthBadge status="unknown" />);
    expect(container.textContent).toContain("Unknown");
    const dot = container.querySelector("span span") as HTMLElement;
    expect(dot.className).toContain("bg-zinc-400");
  });

  test("uses custom label when provided", () => {
    const { container } = render(<HealthBadge status="healthy" label="All systems go" />);
    expect(container.textContent).toContain("All systems go");
    expect(container.textContent).not.toContain("Healthy");
  });

  test("applies custom className", () => {
    const { container } = render(<HealthBadge status="healthy" className="ml-2" />);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge.className).toContain("ml-2");
  });
});
