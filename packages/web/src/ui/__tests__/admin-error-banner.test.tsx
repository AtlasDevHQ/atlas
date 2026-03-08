import { describe, expect, test, mock } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { ErrorBanner } from "../components/admin/error-banner";

describe("Admin ErrorBanner", () => {
  test("renders error message", () => {
    const { container } = render(<ErrorBanner message="Something went wrong" />);
    expect(container.textContent).toContain("Something went wrong");
  });

  test("shows retry button when onRetry is provided", () => {
    const onRetry = mock(() => {});
    const { container } = render(<ErrorBanner message="Failed" onRetry={onRetry} />);
    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button!.textContent).toContain("Retry");
  });

  test("calls onRetry when retry button is clicked", () => {
    const onRetry = mock(() => {});
    const { container } = render(<ErrorBanner message="Failed" onRetry={onRetry} />);
    const button = container.querySelector("button")!;
    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test("hides retry button when onRetry is not provided", () => {
    const { container } = render(<ErrorBanner message="Error" />);
    const button = container.querySelector("button");
    expect(button).toBeNull();
  });

  test("has destructive styling", () => {
    const { container } = render(<ErrorBanner message="Error" />);
    const div = container.firstElementChild as HTMLElement;
    expect(div.className).toContain("border-destructive/50");
  });
});
