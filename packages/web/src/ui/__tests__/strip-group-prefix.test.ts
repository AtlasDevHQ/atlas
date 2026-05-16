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
