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
    const ids = getInvitationColumns().map((c) => c.id);
    expect(ids).toEqual(["email", "role", "status", "expires_at", "created_at"]);
  });
});
