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
