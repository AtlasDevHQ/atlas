import { describe, expect, test, mock } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { SQLResultCard } from "../components/chat/sql-result-card";

// Mock next/dynamic to render children synchronously (avoids async chunk loading)
mock.module("next/dynamic", () => ({
  default: (_loader: () => Promise<{ default: unknown }>) => {
    // Return a placeholder component — we test chart rendering via chart-detection tests
    return function DynamicStub() {
      return <div data-testid="chart-placeholder" />;
    };
  },
}));

function makePart(overrides: Record<string, unknown> = {}) {
  return {
    input: {
      sql: "SELECT name, revenue FROM companies ORDER BY revenue DESC LIMIT 5",
      explanation: "Top 5 companies by revenue",
    },
    output: {
      success: true,
      columns: ["name", "revenue"],
      rows: [
        { name: "Acme Corp", revenue: 500000 },
        { name: "Beta Inc", revenue: 300000 },
        { name: "Gamma LLC", revenue: 200000 },
      ],
    },
    state: "output-available",
    ...overrides,
  };
}

describe("SQLResultCard", () => {
  test("renders loading state when not complete", () => {
    const { container } = render(
      <SQLResultCard part={makePart({ state: "running" })} />,
    );
    expect(container.textContent).toContain("Executing query");
  });

  test("renders row count for successful query", () => {
    const { container } = render(<SQLResultCard part={makePart()} />);
    expect(container.textContent).toContain("3 rows");
  });

  test("renders explanation text", () => {
    const { container } = render(<SQLResultCard part={makePart()} />);
    expect(container.textContent).toContain("Top 5 companies by revenue");
  });

  test("renders SQL badge", () => {
    const { container } = render(<SQLResultCard part={makePart()} />);
    expect(container.textContent).toContain("SQL");
  });

  test("renders error state for failed query", () => {
    const { container } = render(
      <SQLResultCard
        part={makePart({
          output: { success: false, error: "relation does not exist" },
        })}
      />,
    );
    // Failure card surfaces the actual error message and the SQL that failed,
    // plus the agent's explanation when present — not a generic "Query failed".
    expect(container.textContent).toContain("relation does not exist");
    expect(container.textContent).toContain("SELECT");
  });

  test("renders generic fallback when failed query has no error message", () => {
    const { container } = render(
      <SQLResultCard
        part={makePart({
          input: { sql: "SELECT 1", explanation: "" },
          output: { success: false },
        })}
      />,
    );
    expect(container.textContent).toContain("Query failed");
  });

  test("renders warning when result is null", () => {
    const { container } = render(
      <SQLResultCard part={makePart({ output: null })} />,
    );
    expect(container.textContent).toContain("no result was returned");
  });

  test("renders 0 rows message for empty result", () => {
    const { container } = render(
      <SQLResultCard
        part={makePart({
          output: { success: true, columns: ["id"], rows: [] },
        })}
      />,
    );
    expect(container.textContent).toContain("0 rows");
  });

  test("shows truncated indicator", () => {
    const { container } = render(
      <SQLResultCard
        part={makePart({
          output: {
            success: true,
            columns: ["id"],
            rows: [{ id: 1 }],
            truncated: true,
          },
        })}
      />,
    );
    expect(container.textContent).toContain("1 row+");
  });

  test("collapse/expand toggle works", () => {
    const { container } = render(<SQLResultCard part={makePart()} />);
    // Card is open by default — table should be visible
    expect(container.querySelector("table")).not.toBeNull();

    // Click the header button to collapse
    const toggleBtn = container.querySelector("button")!;
    fireEvent.click(toggleBtn);
    expect(container.querySelector("table")).toBeNull();

    // Click again to expand
    fireEvent.click(toggleBtn);
    expect(container.querySelector("table")).not.toBeNull();
  });

  test("Show SQL / Hide SQL toggle", () => {
    const { container } = render(<SQLResultCard part={makePart()} />);

    // SQL is hidden by default
    expect(container.textContent).toContain("Show SQL");
    expect(container.textContent).not.toContain("Hide SQL");

    // Find and click "Show SQL" button
    const buttons = Array.from(container.querySelectorAll("button"));
    const showSqlBtn = buttons.find((b) => b.textContent === "Show SQL")!;
    fireEvent.click(showSqlBtn);

    expect(container.textContent).toContain("Hide SQL");
    expect(container.textContent).toContain("SELECT name, revenue");
  });

  test("Download CSV button appears for data", () => {
    const { container } = render(<SQLResultCard part={makePart()} />);
    const buttons = Array.from(container.querySelectorAll("button"));
    const csvBtn = buttons.find((b) => b.textContent?.includes("CSV"));
    expect(csvBtn).not.toBeUndefined();
  });

  test("Download Excel button appears for data", () => {
    const { container } = render(<SQLResultCard part={makePart()} />);
    const buttons = Array.from(container.querySelectorAll("button"));
    const excelBtn = buttons.find((b) => b.textContent?.includes("Excel"));
    expect(excelBtn).not.toBeUndefined();
  });

  test("Download buttons are hidden when result has 0 rows", () => {
    const { container } = render(
      <SQLResultCard
        part={makePart({
          output: { success: true, columns: ["id"], rows: [] },
        })}
      />,
    );
    const buttons = Array.from(container.querySelectorAll("button"));
    const csvBtn = buttons.find((b) => b.textContent?.includes("CSV"));
    const excelBtn = buttons.find((b) => b.textContent?.includes("Excel"));
    expect(csvBtn).toBeUndefined();
    expect(excelBtn).toBeUndefined();
  });

  test("renders data table with correct columns", () => {
    const { container } = render(<SQLResultCard part={makePart()} />);
    const ths = container.querySelectorAll("th");
    const headers = Array.from(ths).map((th) => th.textContent?.trim());
    expect(headers).toContain("name");
    expect(headers).toContain("revenue");
  });

  test("singular row text for 1 row", () => {
    const { container } = render(
      <SQLResultCard
        part={makePart({
          output: {
            success: true,
            columns: ["id"],
            rows: [{ id: 1 }],
          },
        })}
      />,
    );
    expect(container.textContent).toContain("1 row");
    expect(container.textContent).not.toContain("1 rows");
  });
});
