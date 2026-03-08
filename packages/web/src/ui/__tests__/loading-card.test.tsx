import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { LoadingCard } from "../components/chat/loading-card";

describe("LoadingCard", () => {
  test("renders label text", () => {
    const { container } = render(<LoadingCard label="Executing query..." />);
    expect(container.textContent).toContain("Executing query...");
  });

  test("renders spinner element", () => {
    const { container } = render(<LoadingCard label="Loading" />);
    const spinner = container.querySelector(".animate-spin");
    expect(spinner).not.toBeNull();
  });

  test("renders different labels", () => {
    const { container } = render(<LoadingCard label="Running Python..." />);
    expect(container.textContent).toContain("Running Python...");
  });
});
