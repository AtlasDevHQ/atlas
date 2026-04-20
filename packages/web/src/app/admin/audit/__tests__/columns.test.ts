import { describe, expect, test } from "bun:test";
import { getAuditColumns } from "../columns";

describe("getAuditColumns", () => {
  test("returns the documented column ids in order", () => {
    // Column ids are the wire contract for the DataTable toolbar (sort list,
    // visibility menu) and `page.tsx` defaults sort to `{ id: "timestamp",
    // desc: true }` — a silent rename breaks the default sort. The `user`
    // and `success` columns carry `enableColumnFilter: true`, so the toolbar
    // filter UI depends on those ids too.
    const ids = getAuditColumns().map((c) => c.id);
    expect(ids).toEqual([
      "timestamp",
      "user",
      "sql",
      "tables_accessed",
      "duration_ms",
      "row_count",
      "success",
    ]);
  });
});
