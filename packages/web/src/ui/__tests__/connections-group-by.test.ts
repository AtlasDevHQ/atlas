import { describe, expect, test } from "bun:test";
import type { ConnectionInfo } from "@useatlas/types/connection";
import {
  NO_ENVIRONMENT_KEY,
  bucketizeConnections,
} from "../../app/admin/connections/group-by";

const conn = (overrides: Partial<ConnectionInfo> & { id: string }): ConnectionInfo => ({
  dbType: "postgres",
  status: "published",
  ...overrides,
});

describe("bucketizeConnections — by type", () => {
  test("groups connections by dbType", () => {
    const buckets = bucketizeConnections(
      [
        conn({ id: "a", dbType: "postgres" }),
        conn({ id: "b", dbType: "snowflake" }),
        conn({ id: "c", dbType: "postgres" }),
      ],
      "type",
    );

    const keyed = Object.fromEntries(buckets.map((b) => [b.key, b.connections.map((c) => c.id)]));
    expect(keyed).toEqual({ postgres: ["a", "c"], snowflake: ["b"] });
  });

  test("preserves input order within each bucket", () => {
    const buckets = bucketizeConnections(
      [
        conn({ id: "c1", dbType: "postgres" }),
        conn({ id: "c2", dbType: "postgres" }),
        conn({ id: "c3", dbType: "postgres" }),
      ],
      "type",
    );

    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.connections.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  });

  test("ignores groupId when grouping by type", () => {
    const buckets = bucketizeConnections(
      [
        conn({ id: "a", dbType: "postgres", groupId: "g_prod" }),
        conn({ id: "b", dbType: "postgres", groupId: null }),
      ],
      "type",
    );

    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.key).toBe("postgres");
    expect(buckets[0]?.connections.map((c) => c.id)).toEqual(["a", "b"]);
  });

  test("returns no buckets when input is empty", () => {
    expect(bucketizeConnections([], "type")).toEqual([]);
  });
});

describe("bucketizeConnections — by environment", () => {
  test("groups connections by groupId", () => {
    const buckets = bucketizeConnections(
      [
        conn({ id: "a", groupId: "g_prod" }),
        conn({ id: "b", groupId: "g_staging" }),
        conn({ id: "c", groupId: "g_prod" }),
      ],
      "environment",
    );

    const keyed = Object.fromEntries(buckets.map((b) => [b.key, b.connections.map((c) => c.id)]));
    expect(keyed).toEqual({ g_prod: ["a", "c"], g_staging: ["b"] });
  });

  test("collapses null and undefined groupId into a single no-environment bucket", () => {
    const buckets = bucketizeConnections(
      [
        conn({ id: "a", groupId: null }),
        conn({ id: "b" }), // groupId undefined
        conn({ id: "c", groupId: "g_prod" }),
      ],
      "environment",
    );

    const noEnv = buckets.find((b) => b.key === NO_ENVIRONMENT_KEY);
    expect(noEnv).toBeDefined();
    expect(noEnv?.connections.map((c) => c.id)).toEqual(["a", "b"]);

    const prod = buckets.find((b) => b.key === "g_prod");
    expect(prod?.connections.map((c) => c.id)).toEqual(["c"]);
  });

  test("returns no buckets when input is empty", () => {
    expect(bucketizeConnections([], "environment")).toEqual([]);
  });
});
