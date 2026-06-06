/**
 * Tests for the grouped-tree's connection→group-metadata pivot (#3235).
 *
 * `connectionGroupsFrom` is the only branching transform behind the group
 * section headers (datasource type + member count). It used to be an inline
 * IIFE in page.tsx with zero coverage; a regression here ships green but
 * silently mislabels groups or miscounts members.
 */

import { describe, expect, test } from "bun:test";
import type { ConnectionInfo } from "@/ui/lib/types";
import { connectionGroupsFrom } from "../normalize-connection-groups";

function conn(over: Partial<ConnectionInfo>): ConnectionInfo {
  return { id: "c1", dbType: "postgres", ...over } as ConnectionInfo;
}

describe("connectionGroupsFrom", () => {
  test("empty input → empty", () => {
    expect(connectionGroupsFrom([])).toEqual([]);
  });

  test("null-groupId connections fold into a single default group", () => {
    const groups = connectionGroupsFrom([
      conn({ id: "a", groupId: null, dbType: "postgres" }),
      conn({ id: "b", groupId: undefined, dbType: "postgres" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      id: null,
      label: "default",
      dbTypeLabel: "PostgreSQL",
      memberCount: 2,
    });
  });

  test("counts members within a group", () => {
    const groups = connectionGroupsFrom([
      conn({ id: "a", groupId: "g_warehouse", dbType: "snowflake" }),
      conn({ id: "b", groupId: "g_warehouse", dbType: "snowflake" }),
      conn({ id: "c", groupId: "g_crm", dbType: "salesforce" }),
    ]);
    const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
    expect(byId["g_warehouse"]!.memberCount).toBe(2);
    expect(byId["g_crm"]!.memberCount).toBe(1);
  });

  test("first non-empty dbType wins for the group label", () => {
    // A member with an empty dbType is dropped entirely; a later member with a
    // real dbType still sets the group's datasource label.
    const groups = connectionGroupsFrom([
      conn({ id: "a", groupId: "g_x", dbType: "" }),
      conn({ id: "b", groupId: "g_x", dbType: "postgres" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.dbTypeLabel).toBe("PostgreSQL");
    // The empty-dbType member was filtered out before counting.
    expect(groups[0]!.memberCount).toBe(1);
  });

  test("label uses the group name (stripped) when present", () => {
    const groups = connectionGroupsFrom([
      conn({ id: "a", groupId: "g_prod_us", groupName: "g_prod_us", dbType: "postgres" }),
    ]);
    expect(groups[0]!.label).toBe("prod_us");
  });

  test("label falls back to the stripped id when groupName is null", () => {
    const groups = connectionGroupsFrom([
      conn({ id: "a", groupId: "g_warehouse", groupName: null, dbType: "snowflake" }),
    ]);
    expect(groups[0]!.label).toBe("warehouse");
    expect(groups[0]!.dbTypeLabel).toBe("Snowflake");
  });

  test("drops connections with no dbType", () => {
    const groups = connectionGroupsFrom([conn({ id: "a", groupId: "g_x", dbType: "" })]);
    // The only member had no dbType → the group has no members → not emitted.
    expect(groups).toEqual([]);
  });

  test("dbTypeLabel is omitted for an unknown datasource type", () => {
    const groups = connectionGroupsFrom([
      conn({ id: "a", groupId: "g_x", dbType: "exotic-engine" }),
    ]);
    // labelForDbType returns the raw value for unknown types (not undefined),
    // so the header still shows *something* rather than dropping it silently.
    expect(groups[0]!.dbTypeLabel).toBe("exotic-engine");
  });
});
