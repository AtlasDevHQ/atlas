import { describe, expect, test } from "bun:test";
import {
  ConnectionHealthSchema,
  ConnectionInfoSchema,
  ConnectionsResponseSchema,
} from "../connection";
import { CONNECTION_STATUSES } from "@useatlas/types";

const validHealth = {
  status: "healthy" as const,
  latencyMs: 42,
  message: "ok",
  checkedAt: "2026-04-20T12:00:00.000Z",
};

const validInfo = {
  id: "conn_1",
  dbType: "postgres" as const,
  description: "Primary analytics DB",
  status: "published" as const,
  health: validHealth,
};

describe("happy-path parses", () => {
  test("ConnectionHealthSchema parses a healthy check", () => {
    expect(ConnectionHealthSchema.parse(validHealth)).toEqual(validHealth);
  });

  test("ConnectionInfoSchema parses a full connection", () => {
    expect(ConnectionInfoSchema.parse(validInfo)).toEqual(validInfo);
  });

  test("ConnectionInfoSchema parses with optionals omitted", () => {
    const minimal = { id: "conn_2", dbType: "mysql" as const };
    expect(ConnectionInfoSchema.parse(minimal)).toEqual(minimal);
  });

  test("all CONNECTION_STATUSES values parse", () => {
    for (const status of CONNECTION_STATUSES) {
      expect(() => ConnectionInfoSchema.parse({ ...validInfo, status })).not.toThrow();
    }
  });
});

describe("enum strict rejection", () => {
  test("ConnectionInfoSchema rejects unknown status", () => {
    expect(() => ConnectionInfoSchema.parse({ ...validInfo, status: "retired" })).toThrow();
  });
});

describe("timestamp strictness", () => {
  test("ConnectionHealthSchema rejects non-ISO checkedAt", () => {
    expect(() => ConnectionHealthSchema.parse({ ...validHealth, checkedAt: "yesterday" })).toThrow();
  });
});

describe("ConnectionsResponseSchema transforms to array", () => {
  test("with connections key", () => {
    expect(ConnectionsResponseSchema.parse({ connections: [validInfo] })).toHaveLength(1);
  });

  test("missing connections key falls back to empty array", () => {
    expect(ConnectionsResponseSchema.parse({})).toEqual([]);
  });
});

describe("group decoration fields survive parse", () => {
  // Locks in that ConnectionInfoSchema does not strip groupId/groupName.
  // Before #2421 the admin list endpoint already emitted groupId, but the
  // schema's default object strip silently dropped it at parse time and the
  // UI had no way to render an environment chip.
  test("parses populated groupId + groupName", () => {
    const withGroup = { ...validInfo, groupId: "g_prod", groupName: "prod" };
    expect(ConnectionInfoSchema.parse(withGroup)).toEqual(withGroup);
  });

  test("parses explicit null groupId + groupName (ungrouped row)", () => {
    const ungrouped = { ...validInfo, groupId: null, groupName: null };
    expect(ConnectionInfoSchema.parse(ungrouped)).toEqual(ungrouped);
  });
});

describe("billable field survives parse (#2490)", () => {
  // The header at /admin/connections counts only billable rows. If the
  // schema's default object strip drops the field at parse time, the page
  // sees `undefined` on every row, the `!== false` wire-compat fallback
  // counts everything, and the exact bug #2490 fixed silently returns.
  test("parses billable: true (per-org row)", () => {
    const owned = { ...validInfo, billable: true };
    expect(ConnectionInfoSchema.parse(owned)).toEqual(owned);
  });

  test("parses billable: false (lazy default / __global__ shadow)", () => {
    const fallback = { ...validInfo, billable: false };
    expect(ConnectionInfoSchema.parse(fallback)).toEqual(fallback);
  });

  test("billable absent parses cleanly (mixed-version wire compat)", () => {
    const parsed = ConnectionInfoSchema.parse(validInfo);
    expect("billable" in parsed).toBe(false);
  });
});
