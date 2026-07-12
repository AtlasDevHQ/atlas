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

  test("inserts the connection-group column only when showGroup is set (#4578)", () => {
    // Default (single-group / self-hosted) leaves the column set untouched — the
    // contract test above pins that. `showGroup` inserts one non-sortable
    // `connectionGroup` column right after `sourceEntity`, so a multi-group admin
    // can tell near-identical twins apart before approving one.
    const withGroup = getLearnedPatternColumns({ showGroup: true });
    const ids = withGroup.map((c) => c.id);
    expect(ids).toContain("connectionGroup");
    expect(ids.indexOf("connectionGroup")).toBe(ids.indexOf("sourceEntity") + 1);

    // The group column is display-only — it must not add a sort affordance the
    // server ignores.
    const groupCol = withGroup.find((c) => c.id === "connectionGroup");
    expect(groupCol?.enableSorting).toBe(false);

    // Opting out is exactly the default column set (no leakage).
    expect(getLearnedPatternColumns({ showGroup: false }).map((c) => c.id)).toEqual(
      getLearnedPatternColumns().map((c) => c.id),
    );
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
