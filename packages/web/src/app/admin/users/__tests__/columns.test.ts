import { describe, expect, test } from "bun:test";
import { getUserColumns, getInvitationColumns } from "../columns";

describe("getUserColumns", () => {
  test("returns the documented column ids in order", () => {
    const ids = getUserColumns().map((c) => c.id);
    // The wire contract the DataTable toolbar sort list + visibility menu key
    // off of. Bucket-2 polish swapped the `createdAt` cell to RelativeTimestamp
    // — pin the id + position so a future polish pass can't accidentally
    // rename it (breaks the default sort `{ id: "createdAt", desc: true }` in
    // page.tsx) or drop the column entirely.
    expect(ids).toEqual(["email", "name", "role", "status", "createdAt"]);
  });
});

describe("getInvitationColumns", () => {
  test("returns the documented column ids in order", () => {
    const ids = getInvitationColumns().map((c) => c.id);
    // Same pinning intent as the users table: `expires_at` and `created_at`
    // both now render through RelativeTimestamp, and the column order is the
    // reading-order operators expect (email → role → status → expiration →
    // sent date). Rename/reorder should be a deliberate change.
    expect(ids).toEqual(["email", "role", "status", "expires_at", "created_at"]);
  });
});
