import { describe, expect, test, mock } from "bun:test";
import { render, fireEvent } from "@testing-library/react";

// Mock next/dynamic
mock.module("next/dynamic", () => ({
  default: () => {
    return function DynamicStub() {
      return <div data-testid="chart-placeholder" />;
    };
  },
}));

import { PythonResultCard } from "../components/chat/python-result-card";

function makePart(overrides: Record<string, unknown> = {}) {
  return {
    input: {
      code: "print('hello')",
      explanation: "Print greeting",
    },
    output: {
      success: true,
      output: "hello",
    },
    state: "output-available",
    ...overrides,
  };
}

describe("PythonResultCard", () => {
  test("renders loading state when not complete", () => {
    const { container } = render(
      <PythonResultCard part={makePart({ state: "running" })} />,
    );
    expect(container.textContent).toContain("Running Python");
  });

  test("renders Python badge", () => {
    const { container } = render(<PythonResultCard part={makePart()} />);
    expect(container.textContent).toContain("Python");
  });

  test("renders explanation text", () => {
    const { container } = render(<PythonResultCard part={makePart()} />);
    expect(container.textContent).toContain("Print greeting");
  });

  test("renders stdout output", () => {
    const { container } = render(<PythonResultCard part={makePart()} />);
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toBe("hello");
  });

  test("renders error state for failed execution", () => {
    const { container } = render(
      <PythonResultCard
        part={makePart({
          output: {
            success: false,
            error: "NameError: name 'foo' is not defined",
          },
        })}
      />,
    );
    expect(container.textContent).toContain("Python execution failed");
    expect(container.textContent).toContain("NameError");
  });

  test("renders error with output context", () => {
    const { container } = render(
      <PythonResultCard
        part={makePart({
          output: {
            success: false,
            error: "ZeroDivisionError",
            output: "partial output before crash",
          },
        })}
      />,
    );
    expect(container.textContent).toContain("ZeroDivisionError");
    expect(container.textContent).toContain("partial output before crash");
  });

  test("renders unexpected result format warning", () => {
    const { container } = render(
      <PythonResultCard part={makePart({ output: "unexpected string" })} />,
    );
    expect(container.textContent).toContain("unexpected result format");
  });

  test("renders unexpected result format for array output", () => {
    const { container } = render(
      <PythonResultCard part={makePart({ output: [1, 2, 3] })} />,
    );
    expect(container.textContent).toContain("unexpected result format");
  });

  test("renders null output as unexpected format", () => {
    const { container } = render(
      <PythonResultCard part={makePart({ output: null })} />,
    );
    expect(container.textContent).toContain("unexpected result format");
  });

  test("renders table data", () => {
    const { container } = render(
      <PythonResultCard
        part={makePart({
          output: {
            success: true,
            table: {
              columns: ["name", "score"],
              rows: [
                ["Alice", 95],
                ["Bob", 87],
              ],
            },
          },
        })}
      />,
    );
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.textContent).toContain("Alice");
  });

  test("renders chart images", () => {
    const { container } = render(
      <PythonResultCard
        part={makePart({
          output: {
            success: true,
            output: "chart generated",
            charts: [{ base64: "iVBOR...", mimeType: "image/png" }],
          },
        })}
      />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toContain("data:image/png;base64,");
  });

  test("filters out non-image MIME types in charts", () => {
    const { container } = render(
      <PythonResultCard
        part={makePart({
          output: {
            success: true,
            charts: [{ base64: "abc", mimeType: "text/html" }],
          },
        })}
      />,
    );
    const img = container.querySelector("img");
    expect(img).toBeNull();
  });

  test("collapse/expand toggle works", () => {
    const { container } = render(<PythonResultCard part={makePart()} />);

    // Initially open — output visible
    expect(container.querySelector("pre")).not.toBeNull();

    // Click to collapse
    const toggleBtn = container.querySelector("button")!;
    fireEvent.click(toggleBtn);
    expect(container.querySelector("pre")).toBeNull();

    // Click to expand
    fireEvent.click(toggleBtn);
    expect(container.querySelector("pre")).not.toBeNull();
  });

  test("renders default explanation when none provided", () => {
    const { container } = render(
      <PythonResultCard
        part={makePart({ input: { code: "1+1" } })}
      />,
    );
    expect(container.textContent).toContain("Python result");
  });
});
