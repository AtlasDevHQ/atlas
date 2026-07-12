import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, fireEvent } from "@testing-library/react";
import type { KeyboardEvent, MouseEvent } from "react";
import {
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  useReactTable,
  type ColumnDef,
  type Row,
} from "@tanstack/react-table";
import { DataTable } from "./data-table";
import { ExpandableDataTable } from "./data-table-expandable";

interface Item {
  id: string;
  name: string;
}

const data: Item[] = [
  { id: "1", name: "Alpha" },
  { id: "2", name: "Beta" },
];

function makeColumns(withNestedButton = false): ColumnDef<Item>[] {
  const cols: ColumnDef<Item>[] = [
    {
      id: "name",
      accessorKey: "name",
      header: () => "Name",
      cell: ({ row }) => row.original.name,
    },
  ];
  if (withNestedButton) {
    cols.push({
      id: "actions",
      header: () => null,
      cell: () => (
        <button type="button" data-testid="nested-btn">
          Act
        </button>
      ),
    });
  }
  return cols;
}

/**
 * Renders the shared `DataTable` around a real TanStack table instance. Uses the
 * plain row models directly (no nuqs/react-query) so the seam test exercises the
 * component in isolation.
 */
function Harness({
  onRowClick,
  withNestedButton,
}: {
  onRowClick?: (row: Row<Item>, event: MouseEvent | KeyboardEvent) => void;
  withNestedButton?: boolean;
}) {
  const table = useReactTable({
    data,
    columns: makeColumns(withNestedButton),
    getRowId: (r) => r.id,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });
  return <DataTable table={table} onRowClick={onRowClick} />;
}

/** The expandable sibling — its row rows share the same `interactiveRowProps`. */
function ExpandableHarness({
  onRowClick,
}: {
  onRowClick?: (row: Row<Item>) => void;
}) {
  const table = useReactTable({
    data,
    columns: makeColumns(),
    getRowId: (r) => r.id,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });
  return (
    <ExpandableDataTable
      table={table}
      onRowClick={onRowClick}
      isRowExpanded={(row) => row.id === "1"}
      renderExpandedRow={() => <div data-testid="expanded">details</div>}
    />
  );
}

describe("DataTable (shared server table) — interactive rows", () => {
  afterEach(cleanup);

  test("rows are inert (no button role, not focusable) when onRowClick is omitted", () => {
    const { container } = render(<Harness />);
    const rows = container.querySelectorAll("tbody tr");
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.getAttribute("role")).toBeNull();
      expect(row.getAttribute("tabindex")).toBeNull();
    }
  });

  test("onRowClick makes rows focusable buttons", () => {
    const { container } = render(<Harness onRowClick={() => {}} />);
    const firstRow = container.querySelector("tbody tr")!;
    expect(firstRow.getAttribute("role")).toBe("button");
    expect(firstRow.getAttribute("tabindex")).toBe("0");
    expect(firstRow.className).toContain("cursor-pointer");
  });

  test("clicking a row forwards the row object + event", () => {
    const onRowClick = mock((_row: Row<Item>, _e: MouseEvent | KeyboardEvent) => {});
    const { container } = render(<Harness onRowClick={onRowClick} />);
    const firstRow = container.querySelector("tbody tr")!;
    fireEvent.click(firstRow);
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick.mock.calls[0]?.[0]?.original).toEqual(data[0]);
  });

  test("Enter and Space on a focused row activate it (keyboard a11y)", () => {
    const onRowClick = mock((_row: Row<Item>, _e: MouseEvent | KeyboardEvent) => {});
    const { container } = render(<Harness onRowClick={onRowClick} />);
    const firstRow = container.querySelector("tbody tr")!;
    fireEvent.keyDown(firstRow, { key: "Enter" });
    fireEvent.keyDown(firstRow, { key: " " });
    expect(onRowClick).toHaveBeenCalledTimes(2);
    // The row forwards its own row object on keyboard activation.
    expect(onRowClick.mock.calls[0]?.[0]?.original).toEqual(data[0]);
  });

  test("keydown bubbling from a nested control does NOT activate the row", () => {
    // Rows may contain their own interactive controls (checkbox, action menu).
    // Enter/Space on one bubbles to the row's onKeyDown, but the row must only
    // activate when it is itself the keydown target — otherwise the row's
    // preventDefault would also swallow the nested control's own activation.
    const onRowClick = mock((_row: Row<Item>, _e: MouseEvent | KeyboardEvent) => {});
    const { container } = render(
      <Harness onRowClick={onRowClick} withNestedButton />,
    );
    const nested = container.querySelector<HTMLButtonElement>(
      '[data-testid="nested-btn"]',
    )!;
    fireEvent.keyDown(nested, { key: "Enter" });
    fireEvent.keyDown(nested, { key: " " });
    expect(onRowClick).not.toHaveBeenCalled();
  });

  test("non-activating keys on a focused row do nothing", () => {
    const onRowClick = mock((_row: Row<Item>, _e: MouseEvent | KeyboardEvent) => {});
    const { container } = render(<Harness onRowClick={onRowClick} />);
    const firstRow = container.querySelector("tbody tr")!;
    fireEvent.keyDown(firstRow, { key: "a" });
    fireEvent.keyDown(firstRow, { key: "Tab" });
    fireEvent.keyDown(firstRow, { key: "ArrowDown" });
    expect(onRowClick).not.toHaveBeenCalled();
  });

  test("Space on the row is consumed, but a nested control's Space is left intact", () => {
    // `fireEvent` returns false when a handler called preventDefault on the
    // (cancelable) event, true otherwise. The row must preventDefault its own
    // Space (so activation doesn't also scroll the page), yet must NOT touch a
    // Space that bubbled up from a nested control — else it would swallow that
    // control's own activation.
    const { container } = render(
      <Harness onRowClick={() => {}} withNestedButton />,
    );
    const firstRow = container.querySelector("tbody tr")!;
    const nested = container.querySelector<HTMLButtonElement>(
      '[data-testid="nested-btn"]',
    )!;
    expect(fireEvent.keyDown(firstRow, { key: " " })).toBe(false);
    expect(fireEvent.keyDown(nested, { key: " " })).toBe(true);
  });

  test("expandable variant: data rows are focusable buttons; the expanded row is inert", () => {
    const onRowClick = mock((_row: Row<Item>) => {});
    const { container } = render(<ExpandableHarness onRowClick={onRowClick} />);
    const dataRow = container.querySelector("tbody tr")!;
    expect(dataRow.getAttribute("role")).toBe("button");
    expect(dataRow.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(dataRow, { key: "Enter" });
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick.mock.calls[0]?.[0]?.original).toEqual(data[0]);

    // The rendered expanded-content row must stay a plain, non-interactive row.
    const expandedRow = container
      .querySelector('[data-testid="expanded"]')!
      .closest("tr")!;
    expect(expandedRow.getAttribute("role")).toBeNull();
    expect(expandedRow.getAttribute("tabindex")).toBeNull();
  });
});
