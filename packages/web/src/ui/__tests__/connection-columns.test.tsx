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
function renderColumnCell(row: ConnectionInfo, columnId: string) {
  const columns = getConnectionColumns();
  const col = columns.find((c) => c.id === columnId);
  if (!col) throw new Error(`${columnId} column missing`);
  // Minimal fake TanStack row/cell context — we only need `getValue` and
  // `original`. The cell renderer uses both.
  const fakeRow = {
    getValue: (key: string) => (row as unknown as Record<string, unknown>)[key],
    original: row,
  } as unknown as Row<ConnectionInfo>;
  const fakeCell = { getContext: () => ({ row: fakeRow, table: {} as Table<ConnectionInfo>, cell: {} as Cell<ConnectionInfo, unknown>, column: col, getValue: () => row.id, renderValue: () => row.id }) };
  const ctx = fakeCell.getContext();
  return render(<>{flexRender(col.cell, ctx)}</>);
}

function renderIdCell(row: ConnectionInfo) {
  return renderColumnCell(row, "id");
}

function renderEnvironmentCell(row: ConnectionInfo) {
  return renderColumnCell(row, "environment");
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

describe("connection columns — environment cell", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders an em-dash when the row has no groupName", () => {
    const { container } = renderEnvironmentCell({
      id: "warehouse",
      dbType: "postgres",
      status: "published",
    });
    expect(container.textContent).toBe("—");
    expect(container.querySelector("a")).toBeNull();
  });

  test("renders a badge deep-linking to the embedded Environments view when groupName is present", () => {
    const { container } = renderEnvironmentCell({
      id: "warehouse",
      dbType: "postgres",
      status: "published",
      groupId: "g_prod",
      groupName: "g_prod",
    });
    // Strip the legacy `g_` prefix so the chip reads naturally.
    expect(container.textContent).toContain("prod");
    expect(container.textContent).not.toContain("g_prod");
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    // PRD #2458 slice 4: the standalone /admin/connections/groups page is
    // a server-side redirect; chips now deep-link directly to the
    // embedded view to avoid a one-frame redirect flash.
    expect(link?.getAttribute("href")).toBe("/admin/connections?groupBy=environment");
  });

  test("does not strip non-prefix names", () => {
    const { container } = renderEnvironmentCell({
      id: "warehouse",
      dbType: "postgres",
      status: "published",
      groupId: "g_prod",
      groupName: "Production EU",
    });
    expect(container.textContent).toContain("Production EU");
  });
});
