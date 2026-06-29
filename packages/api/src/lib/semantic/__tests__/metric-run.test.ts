/**
 * Tests for the shared metric-run resolver (#4048).
 *
 * Covers metric lookup, default-group routing, grouped-metric routing,
 * explicit-connection validation (group id / group member / wrong group),
 * the unknown-metric path, and the filters-unsupported guard.
 */

import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// The resolver's only DB dependency is loadGroupRoutingContext → internalQuery.
// Mock it so an explicit member-connection case resolves deterministically to a
// group, and the default cases run with the internal DB "offline".
let groupForConnection: Record<string, string | undefined> = {};
mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  internalQuery: async (_sql: string, params: unknown[]) => {
    // loadGroupRoutingContext step 1 query selects config->>'group_id' for the
    // install id at params[0].
    const connId = params?.[0] as string | undefined;
    const group = connId ? groupForConnection[connId] : undefined;
    return group ? [{ group_id: group }] : [{ group_id: null }];
  },
  internalExecute: async () => {},
  encryptSecret: (s: string) => s,
  decryptSecret: (s: string) => s,
  getInternalDB: () => {
    throw new Error("not configured");
  },
  _resetPool: () => {},
}));

import { resolveMetricRun, DEFAULT_SEMANTIC_GROUP } from "../metric-run";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-metric-run-"));
  // Flat/default metric.
  fs.mkdirSync(path.join(tmpRoot, "metrics"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, "metrics", "revenue.yml"),
    [
      "metrics:",
      "  - id: total_gmv",
      "    label: Total GMV",
      "    sql: SELECT SUM(total_cents) / 100.0 AS total_gmv FROM orders",
    ].join("\n"),
  );
  // Grouped metric under groups/prod/metrics/.
  fs.mkdirSync(path.join(tmpRoot, "groups", "prod", "metrics"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(tmpRoot, "groups", "prod", "metrics", "signups.yml"),
    [
      "metrics:",
      "  - id: prod_signups",
      "    label: Prod Signups",
      "    sql: SELECT COUNT(*) AS signups FROM users",
    ].join("\n"),
  );
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("resolveMetricRun", () => {
  it("resolves a default-group metric to default routing (undefined connection)", async () => {
    const res = await resolveMetricRun({ id: "total_gmv", semanticRoot: tmpRoot });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.metric.id).toBe("total_gmv");
    // SQL is used exactly as defined.
    expect(res.metric.sql).toBe(
      "SELECT SUM(total_cents) / 100.0 AS total_gmv FROM orders",
    );
    expect(res.metric.source).toBe(DEFAULT_SEMANTIC_GROUP);
    expect(res.targetConnectionId).toBeUndefined();
  });

  it("routes a grouped metric to its own group connection", async () => {
    const res = await resolveMetricRun({ id: "prod_signups", semanticRoot: tmpRoot });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.metric.source).toBe("prod");
    expect(res.targetConnectionId).toBe("prod");
  });

  it("returns unknown_metric for an id that does not exist", async () => {
    const res = await resolveMetricRun({ id: "nope", semanticRoot: tmpRoot });
    expect(res.kind).toBe("unknown_metric");
  });

  it("rejects a non-empty filters set as filters_unsupported", async () => {
    const res = await resolveMetricRun({
      id: "total_gmv",
      filters: { region: "us" },
      semanticRoot: tmpRoot,
    });
    expect(res.kind).toBe("filters_unsupported");
  });

  it("ignores an empty filters object", async () => {
    const res = await resolveMetricRun({
      id: "total_gmv",
      filters: {},
      semanticRoot: tmpRoot,
    });
    expect(res.kind).toBe("ok");
  });

  it("accepts an explicit connectionId equal to the metric's group id", async () => {
    const res = await resolveMetricRun({
      id: "prod_signups",
      connectionId: "prod",
      orgId: "org-1",
      semanticRoot: tmpRoot,
    });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.targetConnectionId).toBe("prod");
  });

  it("accepts an explicit member connection that belongs to the metric's group", async () => {
    groupForConnection = { "us-prod": "prod" };
    const res = await resolveMetricRun({
      id: "prod_signups",
      connectionId: "us-prod",
      orgId: "org-1",
      semanticRoot: tmpRoot,
    });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    // Routes to the specific member, not the group id.
    expect(res.targetConnectionId).toBe("us-prod");
    groupForConnection = {};
  });

  it("rejects an explicit connection in a different group as wrong_connection", async () => {
    groupForConnection = { "eu-staging": "staging" };
    const res = await resolveMetricRun({
      id: "prod_signups",
      connectionId: "eu-staging",
      orgId: "org-1",
      semanticRoot: tmpRoot,
    });
    expect(res.kind).toBe("wrong_connection");
    if (res.kind !== "wrong_connection") return;
    expect(res.group).toBe("prod");
    expect(res.metricConnectionId).toBe("prod");
    groupForConnection = {};
  });

  it("rejects any explicit non-default connection for an ungrouped metric", async () => {
    const res = await resolveMetricRun({
      id: "total_gmv",
      connectionId: "some-other",
      orgId: "org-1",
      semanticRoot: tmpRoot,
    });
    expect(res.kind).toBe("wrong_connection");
    if (res.kind !== "wrong_connection") return;
    expect(res.metricConnectionId).toBe("default");
  });

  it("accepts the literal 'default' connection for a default-group metric", async () => {
    const res = await resolveMetricRun({
      id: "total_gmv",
      connectionId: "default",
      orgId: "org-1",
      semanticRoot: tmpRoot,
    });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    // metricConnectionId === "default" === connectionId, so no group lookup;
    // targetConnectionId echoes the explicit "default".
    expect(res.targetConnectionId).toBe("default");
  });
});
