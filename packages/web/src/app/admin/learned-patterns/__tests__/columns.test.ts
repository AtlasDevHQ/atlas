import { describe, expect, test } from "bun:test";
import { getLearnedPatternColumns } from "../columns";
import { SORT_PARAM_BY_COLUMN } from "../list-query";

describe("getLearnedPatternColumns", () => {
  test("returns the documented column ids in order", () => {
    // Column ids are the wire contract for the DataTable toolbar (sort list,
    // visibility menu) and the `?sort=` state parser. A silent rename here
    // breaks the sort → API mapping in `list-query.ts`.
    const ids = getLearnedPatternColumns().map((c) => c.id);
    expect(ids).toEqual([
      "select",
      "status",
      "patternSql",
      "description",
      "sourceEntity",
      "confidence",
      "avgDurationMs",
      "repetitionCount",
      "proposedBy",
      "createdAt",
    ]);
  });

  test("exactly the sortable columns map to a whitelisted API sort key", () => {
    // A column renders a sort affordance iff `enableSorting !== false`
    // (`DataTableColumnHeader` gates the chevron on `column.getCanSort()`).
    // That set must match the API sort whitelist 1:1 — a sortable column with
    // no wire mapping would flip an arrow that the server ignores (the bug this
    // fixes); a mapping with no sortable column would be dead config.
    const sortableIds = getLearnedPatternColumns()
      .filter((c) => c.enableSorting !== false)
      .map((c) => c.id as string)
      .toSorted();

    const mappedIds = [...SORT_PARAM_BY_COLUMN.keys()].toSorted();

    expect(sortableIds).toEqual(mappedIds);
    expect(sortableIds).toEqual(
      ["avgDurationMs", "confidence", "createdAt", "repetitionCount"].toSorted(),
    );
  });
});
