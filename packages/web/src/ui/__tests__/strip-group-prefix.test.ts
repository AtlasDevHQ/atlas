/**
 * Tests for the shared connection-group display helpers.
 *
 * The util is consumed from four admin surfaces (env-picker, the admin
 * connections page + columns, scheduled-tasks task-form-dialog, and the
 * /admin/connections/groups environment page) so a regression here leaks
 * raw migration shapes into user-facing copy across the product. Pin both
 * branches and the disambiguation rule that distinguishes auto-backfilled
 * `g_<connId>` singletons from `g_<random>` user-created groups.
 */

import { describe, it, expect } from "bun:test";
import {
  stripGroupPrefix,
  isAutoBackfilledSingleton,
  isEmptyBackfillOrphan,
} from "@/ui/lib/strip-group-prefix";

describe("stripGroupPrefix", () => {
  it("strips a __global__: prefix (0065/0068 synthetic-name leak)", () => {
    expect(stripGroupPrefix("__global__:warehouse")).toBe("warehouse");
  });

  it("strips a g_ prefix (0062 backfill leak surfaced via admin rename)", () => {
    expect(stripGroupPrefix("g_warehouse")).toBe("warehouse");
  });

  it("returns the input unchanged when neither prefix matches", () => {
    expect(stripGroupPrefix("Production")).toBe("Production");
    expect(stripGroupPrefix("eu-prod")).toBe("eu-prod");
  });

  it("strips the first matching prefix only (does not chain)", () => {
    // A name literally beginning `__global__:g_foo` strips the outer
    // synthetic prefix, leaving `g_foo` intact — operators renaming a
    // group to literal `g_foo` chose that string deliberately.
    expect(stripGroupPrefix("__global__:g_foo")).toBe("g_foo");
  });
});

describe("isAutoBackfilledSingleton", () => {
  it("returns true for the exact 0062 auto-backfill shape", () => {
    expect(
      isAutoBackfilledSingleton({
        id: "g_warehouse",
        name: "warehouse",
        memberCount: 1,
      }),
    ).toBe(true);
  });

  it("returns false for a user-created `g_<random>` group with a different name", () => {
    // The id-prefix-only check would mistakenly catch this; the
    // name-equality disambiguation is the load-bearing constraint.
    expect(
      isAutoBackfilledSingleton({
        id: "g_abc123def",
        name: "Production",
        memberCount: 1,
      }),
    ).toBe(false);
  });

  it("returns false for an admin-renamed singleton (g_id but name mutated)", () => {
    // After an admin renames `g_warehouse` to "Warehouse", the cleanup
    // signature no longer matches and the group is preserved across
    // merges.
    expect(
      isAutoBackfilledSingleton({
        id: "g_warehouse",
        name: "Warehouse",
        memberCount: 1,
      }),
    ).toBe(false);
  });

  it("returns false for multi-member groups regardless of id shape", () => {
    expect(
      isAutoBackfilledSingleton({
        id: "g_warehouse",
        name: "warehouse",
        memberCount: 2,
      }),
    ).toBe(false);
  });

  it("returns false for zero-member groups (an admin actively curated them empty)", () => {
    expect(
      isAutoBackfilledSingleton({
        id: "g_warehouse",
        name: "warehouse",
        memberCount: 0,
      }),
    ).toBe(false);
  });
});

describe("isEmptyBackfillOrphan", () => {
  it("returns true for the exact #2506 ghost shape (g_<connId>, name=connId, 0 members)", () => {
    // This is the prod orphan that pollutes the env combobox: the
    // `us-prod` connection has been merged into the `prod` group, but
    // its source backfill row survived as a 0-member group whose label
    // still collides with the live connection id.
    expect(
      isEmptyBackfillOrphan({
        id: "g_us-prod",
        name: "us-prod",
        memberCount: 0,
      }),
    ).toBe(true);
  });

  it("returns false when membership is non-zero (live or singleton)", () => {
    expect(
      isEmptyBackfillOrphan({ id: "g_us-prod", name: "us-prod", memberCount: 1 }),
    ).toBe(false);
    expect(
      isEmptyBackfillOrphan({ id: "g_us-prod", name: "us-prod", memberCount: 3 }),
    ).toBe(false);
  });

  it("returns false for a user-created `g_<random>` group whose admin emptied it", () => {
    // A user-created group that's been emptied (every member moved out)
    // still has a meaningful name the admin assigned — preserve so the
    // wizard can rehydrate it. Disambiguation is the same `name == id
    // suffix` rule that gates `isAutoBackfilledSingleton`.
    expect(
      isEmptyBackfillOrphan({
        id: "g_abc123def",
        name: "Production",
        memberCount: 0,
      }),
    ).toBe(false);
  });

  it("returns false for an admin-renamed singleton emptied to zero members", () => {
    expect(
      isEmptyBackfillOrphan({
        id: "g_warehouse",
        name: "Warehouse",
        memberCount: 0,
      }),
    ).toBe(false);
  });

  it("returns false for groups whose id does not match the g_ backfill prefix", () => {
    expect(
      isEmptyBackfillOrphan({
        id: "prod",
        name: "prod",
        memberCount: 0,
      }),
    ).toBe(false);
  });
});
