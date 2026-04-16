import { describe, expect, test, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { flexRender, type Cell, type Row, type Table } from "@tanstack/react-table";
import type { ConnectionInfo } from "@useatlas/types/connection";
import {
  DEMO_CONNECTION_ID,
  getConnectionColumns,
} from "../../app/admin/connections/columns";

/**
 * Render a single column's cell for a given row. Uses the tanstack-react-table
 * flexRender helper so we exercise the same path the DataTable does — avoids
 * shipping tests that pass because they bypass the library.
 */
function renderIdCell(row: ConnectionInfo) {
  const columns = getConnectionColumns();
  const idCol = columns.find((c) => c.id === "id");
  if (!idCol) throw new Error("id column missing");
  // Minimal fake TanStack row/cell context — we only need `getValue` and
  // `original`. The cell renderer uses both.
  const fakeRow = {
    getValue: (key: string) => (row as unknown as Record<string, unknown>)[key],
    original: row,
  } as unknown as Row<ConnectionInfo>;
  const fakeCell = { getContext: () => ({ row: fakeRow, table: {} as Table<ConnectionInfo>, cell: {} as Cell<ConnectionInfo, unknown>, column: idCol, getValue: () => row.id, renderValue: () => row.id }) };
  const ctx = fakeCell.getContext();
  return render(<>{flexRender(idCol.cell, ctx)}</>);
}

describe("connection columns — id cell", () => {
  afterEach(() => {
    cleanup();
  });

  test("no demo/draft badge on a vanilla published connection", () => {
    const { container } = renderIdCell({ id: "warehouse", dbType: "postgres", status: "published" });
    expect(container.textContent).toContain("warehouse");
    expect(container.textContent).not.toContain("Demo");
    expect(container.textContent).not.toContain("Draft");
  });

  test("renders Demo badge on the reserved __demo__ id", () => {
    const { container } = renderIdCell({ id: DEMO_CONNECTION_ID, dbType: "postgres", status: "published" });
    expect(container.textContent).toContain(DEMO_CONNECTION_ID);
    expect(container.textContent).toContain("Demo");
    expect(container.textContent).not.toContain("Draft");
  });

  test("renders Draft badge on status === 'draft'", () => {
    const { container } = renderIdCell({ id: "stage", dbType: "postgres", status: "draft" });
    expect(container.textContent).toContain("stage");
    expect(container.textContent).toContain("Draft");
    expect(container.textContent).not.toContain("Demo");
  });

  test("renders both badges when a __demo__ connection is also in draft", () => {
    const { container } = renderIdCell({ id: DEMO_CONNECTION_ID, dbType: "postgres", status: "draft" });
    expect(container.textContent).toContain("Demo");
    expect(container.textContent).toContain("Draft");
  });
});
