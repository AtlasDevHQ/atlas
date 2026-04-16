import { describe, expect, test, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { flexRender, type Row, type Table, type Cell } from "@tanstack/react-table";
import type { PromptCollection } from "@useatlas/types/prompt";
import { getPromptCollectionColumns } from "../../app/admin/prompts/columns";

function baseCollection(partial: Partial<PromptCollection> = {}): PromptCollection {
  return {
    id: "col_1",
    orgId: "org_1",
    name: "Revenue",
    industry: "saas",
    description: "",
    isBuiltin: false,
    sortOrder: 0,
    status: "published",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...partial,
  };
}

function renderNameCell(row: PromptCollection) {
  const columns = getPromptCollectionColumns(new Map());
  const nameCol = columns.find((c) => c.id === "name");
  if (!nameCol) throw new Error("name column missing");
  const fakeRow = {
    getValue: (key: string) => (row as unknown as Record<string, unknown>)[key],
    original: row,
  } as unknown as Row<PromptCollection>;
  const ctx = {
    row: fakeRow,
    table: {} as Table<PromptCollection>,
    cell: {} as Cell<PromptCollection, unknown>,
    column: nameCol,
    getValue: () => row.name,
    renderValue: () => row.name,
  };
  return render(<>{flexRender(nameCol.cell, ctx)}</>);
}

describe("prompt collection columns — name cell", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders Demo badge when isBuiltin is true", () => {
    const { container } = renderNameCell(baseCollection({ name: "SaaS starters", isBuiltin: true }));
    expect(container.textContent).toContain("SaaS starters");
    expect(container.textContent).toContain("Demo");
  });

  test("renders Draft badge when status === 'draft'", () => {
    const { container } = renderNameCell(baseCollection({ name: "WIP", status: "draft" }));
    expect(container.textContent).toContain("WIP");
    expect(container.textContent).toContain("Draft");
  });

  test("no badges on a non-builtin published collection", () => {
    const { container } = renderNameCell(baseCollection({ name: "Custom", isBuiltin: false, status: "published" }));
    expect(container.textContent).toContain("Custom");
    expect(container.textContent).not.toContain("Demo");
    expect(container.textContent).not.toContain("Draft");
  });

  test("renders both badges on a draft built-in collection", () => {
    const { container } = renderNameCell(baseCollection({ name: "Both", isBuiltin: true, status: "draft" }));
    expect(container.textContent).toContain("Demo");
    expect(container.textContent).toContain("Draft");
  });
});
