/**
 * Direct render contract for the shared <DiffCard> (#2461). The drawer test
 * exercises this transitively, but `defaultOpen={false}` and `removedColumns`
 * aren't covered there — locking them here keeps the contract pinned.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { render, cleanup, fireEvent } from "@testing-library/react";
import type { SemanticTableDiff } from "@useatlas/types";
import { DiffCard } from "../components/admin/diff-card";

afterEach(() => {
  cleanup();
});

function makeDiff(overrides: Partial<SemanticTableDiff> = {}): SemanticTableDiff {
  return {
    table: "orders",
    addedColumns: [],
    removedColumns: [],
    typeChanges: [],
    ...overrides,
  };
}

describe("DiffCard", () => {
  test("defaults to collapsed — header visible, rows hidden", () => {
    const { container } = render(
      <DiffCard
        diff={makeDiff({
          addedColumns: [{ name: "shipped_at", type: "timestamp" }],
        })}
      />,
    );
    // Header renders the table name + change count.
    expect(container.textContent).toContain("orders");
    expect(container.textContent).toContain("1 change");
    // Collapsible body should not have surfaced the added column yet.
    expect(container.textContent).not.toContain("shipped_at");
  });

  test("defaultOpen expands the body on first render", () => {
    const { container } = render(
      <DiffCard
        defaultOpen
        diff={makeDiff({
          addedColumns: [{ name: "shipped_at", type: "timestamp" }],
        })}
      />,
    );
    expect(container.textContent).toContain("shipped_at");
    expect(container.textContent).toContain("(in DB, missing from YAML)");
  });

  test("renders removed columns with the YAML-only detail message", () => {
    const { container } = render(
      <DiffCard
        defaultOpen
        diff={makeDiff({
          removedColumns: [{ name: "legacy_col", type: "string" }],
        })}
      />,
    );
    expect(container.textContent).toContain("legacy_col");
    expect(container.textContent).toContain("(in YAML, missing from DB)");
    expect(container.textContent).toContain("removed");
  });

  test("renders type changes with both YAML and DB types", () => {
    const { container } = render(
      <DiffCard
        defaultOpen
        diff={makeDiff({
          typeChanges: [{ name: "total", yamlType: "number", dbType: "decimal" }],
        })}
      />,
    );
    expect(container.textContent).toContain("total");
    expect(container.textContent).toContain("number");
    expect(container.textContent).toContain("decimal");
  });

  test("uses singular 'change' for a single-column diff", () => {
    const { container } = render(
      <DiffCard
        diff={makeDiff({
          addedColumns: [{ name: "shipped_at", type: "timestamp" }],
        })}
      />,
    );
    expect(container.textContent).toContain("1 change");
    expect(container.textContent).not.toContain("1 changes");
  });

  test("plural 'changes' for multi-column diffs across all three buckets", () => {
    const { container } = render(
      <DiffCard
        diff={makeDiff({
          addedColumns: [{ name: "shipped_at", type: "timestamp" }],
          removedColumns: [{ name: "legacy_col", type: "string" }],
          typeChanges: [{ name: "total", yamlType: "number", dbType: "decimal" }],
        })}
      />,
    );
    expect(container.textContent).toContain("3 changes");
  });

  test("clicking the header toggles the collapsible body", () => {
    const { container } = render(
      <DiffCard
        diff={makeDiff({
          addedColumns: [{ name: "shipped_at", type: "timestamp" }],
        })}
      />,
    );
    expect(container.textContent).not.toContain("shipped_at");
    // Radix Collapsible.Trigger renders its child with `aria-expanded` — that's
    // the most stable handle regardless of which DOM element shadcn picks.
    const trigger = container.querySelector("[aria-expanded]") as HTMLElement | null;
    expect(trigger).not.toBeNull();
    fireEvent.click(trigger as HTMLElement);
    expect(container.textContent).toContain("shipped_at");
  });
});
