import { describe, expect, test } from "bun:test";
import { getUserColumns, getInvitationColumns } from "../columns";

describe("getUserColumns", () => {
  test("returns the documented column ids in order", () => {
    // Column ids are the wire contract for the DataTable toolbar (sort list,
    // visibility menu) and `page.tsx` defaults sort to `{ id: "createdAt",
    // desc: true }` — a silent rename breaks the default sort.
    const ids = getUserColumns().map((c) => c.id);
    expect(ids).toEqual(["email", "name", "role", "status", "createdAt"]);
  });
});

describe("getInvitationColumns", () => {
  test("returns the documented column ids in order", () => {
    // Column ids mirror Better Auth's `invitation` table fields after the
    // cutover from the legacy `invitations` (plural, snake_case) table.
    // The DataTable contract takes id literals here, so a rename in
    // `columns.tsx` that diverges from this list breaks sort/filter.
    const ids = getInvitationColumns().map((c) => c.id);
    expect(ids).toEqual(["email", "role", "status", "expiresAt", "createdAt"]);
  });
});
