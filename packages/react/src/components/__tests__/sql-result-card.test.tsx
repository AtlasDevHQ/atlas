import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { SQLResultCard, type SqlResultActionContext } from "../chat/sql-result-card";

// Single-row results keep detectCharts non-chartable (needs >= 2 rows), so the
// card never mounts the lazy recharts chunk in these tests.
function makePart(overrides: Record<string, unknown> = {}) {
  return {
    input: {
      sql: "SELECT name, revenue FROM companies LIMIT 1",
      explanation: "Top company by revenue",
    },
    output: {
      success: true,
      columns: ["name", "revenue"],
      rows: [{ name: "Acme Corp", revenue: 500000 }],
    },
    state: "output-available",
    ...overrides,
  };
}

describe("SQLResultCard", () => {
  test("renders row count and explanation for a successful query", () => {
    const { container } = render(<SQLResultCard part={makePart()} />);
    expect(container.textContent).toContain("1 row");
    expect(container.textContent).toContain("Top company by revenue");
    expect(container.textContent).toContain("Acme Corp");
  });

  test("renders loading state when not complete", () => {
    const { container } = render(
      <SQLResultCard part={{ input: {}, state: "input-available" }} />,
    );
    expect(container.textContent).toContain("Executing query...");
  });

  test("renders error state with message and SQL for failed query", () => {
    const { container } = render(
      <SQLResultCard
        part={makePart({ output: { success: false, error: "relation \"companies\" does not exist" } })}
      />,
    );
    expect(container.textContent).toContain("relation \"companies\" does not exist");
    expect(container.textContent).toContain("SELECT name, revenue FROM companies LIMIT 1");
  });

  test("renders 'Tried N times' badge on failure card when repeatedCount >= 2", () => {
    const { container } = render(
      <SQLResultCard
        part={makePart({ output: { success: false, error: "table missing" } })}
        repeatedCount={3}
      />,
    );
    expect(container.textContent).toContain("Tried 3 times");
  });

  test("does not render the badge when repeatedCount is 1 or undefined", () => {
    const { container: c1 } = render(
      <SQLResultCard
        part={makePart({ output: { success: false, error: "x" } })}
        repeatedCount={1}
      />,
    );
    expect(c1.textContent).not.toContain("Tried");

    const { container: c2 } = render(
      <SQLResultCard part={makePart({ output: { success: false, error: "x" } })} />,
    );
    expect(c2.textContent).not.toContain("Tried");
  });

  // -------------------------------------------------------------------------
  // Host slots — the per-side seams the web app fills (#4193)
  // -------------------------------------------------------------------------

  test("headerBadge slot renders inside the header meta span", () => {
    const { container } = render(
      <SQLResultCard part={makePart()} headerBadge={<span data-testid="on-dashboard">DB</span>} />,
    );
    expect(container.querySelector("[data-testid='on-dashboard']")).not.toBeNull();
  });

  test("renderActions receives the parsed result context and renders in the actions row", () => {
    let seen: SqlResultActionContext | null = null;
    const { container } = render(
      <SQLResultCard
        part={makePart()}
        renderActions={(ctx) => {
          seen = ctx;
          return <button data-testid="dashboard-action">Dashboard</button>;
        }}
      />,
    );
    expect(container.querySelector("[data-testid='dashboard-action']")).not.toBeNull();
    expect(seen).not.toBeNull();
    expect(seen!.columns).toEqual(["name", "revenue"]);
    expect(seen!.rows.length).toBe(1);
    expect(seen!.sql).toContain("SELECT name, revenue");
    expect(seen!.explanation).toBe("Top company by revenue");
    expect(seen!.chartResult.chartable).toBe(false);
  });

  test("renderActions is not invoked for a failed query (no data)", () => {
    let called = false;
    render(
      <SQLResultCard
        part={makePart({ output: { success: false, error: "x" } })}
        renderActions={() => {
          called = true;
          return null;
        }}
      />,
    );
    expect(called).toBe(false);
  });

  test("renderActions is not invoked for a successful query with zero rows", () => {
    let called = false;
    render(
      <SQLResultCard
        part={makePart({ output: { success: true, columns: ["x"], rows: [] } })}
        renderActions={() => {
          called = true;
          return null;
        }}
      />,
    );
    expect(called).toBe(false);
  });

  test("previousExecution renders a rerun comparison next to the timing", () => {
    const { container } = render(
      <SQLResultCard
        part={makePart({
          output: {
            success: true,
            columns: ["name"],
            rows: [{ name: "Acme" }],
            executionMs: 1200,
          },
        })}
        previousExecution={{ executionMs: 3400, rowCount: 512 }}
      />,
    );
    expect(container.textContent).toContain("was 512 rows · 3.4s");
  });

  test("previousExecution shows time only when the row count is unchanged", () => {
    const { container } = render(
      <SQLResultCard
        part={makePart({
          output: { success: true, columns: ["name"], rows: [{ name: "Acme" }], executionMs: 1200 },
        })}
        // rowCount matches the current single row → row count suppressed
        previousExecution={{ executionMs: 3400, rowCount: 1 }}
      />,
    );
    // The comparison parenthetical shows time only — no "N rows" prefix.
    expect(container.textContent).toContain("(was 3.4s)");
    expect(container.textContent).not.toContain("(was 1 row");
  });

  test("previousExecution renders no comparison when there is nothing to compare", () => {
    const { container } = render(
      <SQLResultCard
        part={makePart({
          output: { success: true, columns: ["name"], rows: [{ name: "Acme" }] },
        })}
        // no finite executionMs and rowCount unchanged → formatPreviousExecution returns null
        previousExecution={{ rowCount: 1 }}
      />,
    );
    expect(container.textContent).not.toContain("was ");
  });
});
