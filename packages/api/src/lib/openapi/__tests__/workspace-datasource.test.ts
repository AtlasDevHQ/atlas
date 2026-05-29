/**
 * Tests for the slice-2 DB-backed REST datasource resolver
 * (`workspace-datasource.ts`, #2926). The query is injected (`deps.query`) so the
 * resolver is exercised without a DB — no `mock.module()`. Covers: multi-instance
 * resolution, per-install representation-mode (default + override), auth shapes,
 * base-url override, and the per-install fail-soft skip paths.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  resolveWorkspaceRestDatasources,
  resolveWorkspacePrimaryRestDatasource,
  type OpenApiInstallRow,
} from "../workspace-datasource";
import { buildOperationGraph } from "../spec";
import { buildSnapshot, __resetSnapshotGraphCacheForTests } from "../probe";
import { MOCK_OPENAPI_SPEC } from "@atlas/api/testing/openapi-datasource";
import type { OpenApiSnapshot } from "../catalog";

const graph = buildOperationGraph(MOCK_OPENAPI_SPEC);

function snapshot(probedAt = "2026-05-29T00:00:00.000Z"): OpenApiSnapshot {
  return buildSnapshot(MOCK_OPENAPI_SPEC, graph, probedAt);
}

/** A decrypted-shaped install config (auth_value plaintext — decrypt passes it through). */
function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    openapi_url: "https://widgets.example.com/openapi.json",
    auth_kind: "bearer",
    auth_value: "plaintext-token",
    display_name: "Widgets",
    representation_mode: "operation-graph",
    openapi_snapshot: snapshot(),
    ...overrides,
  };
}

const queryReturning = (rows: OpenApiInstallRow[]) => async () => rows;

beforeEach(() => __resetSnapshotGraphCacheForTests());
afterEach(() => __resetSnapshotGraphCacheForTests());

describe("resolveWorkspaceRestDatasources", () => {
  it("resolves an install into a RestDatasource (graph + bearer auth + baseUrl)", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([{ install_id: "ds-1", config: config() }]),
    });
    expect(result).toHaveLength(1);
    const ds = result[0];
    expect(ds.id).toBe("ds-1");
    expect(ds.displayName).toBe("Widgets");
    expect(ds.graph.operations.has("listWidgets")).toBe(true);
    expect(ds.auth).toEqual({ kind: "bearer", token: "plaintext-token" });
    expect(ds.baseUrl).toBe("https://widgets.example.com/api"); // from servers[0].url
    expect(ds.representationMode).toBe("operation-graph");
  });

  it("honors the per-install representation-mode toggle (semantic-yaml)", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([{ install_id: "ds-1", config: config({ representation_mode: "semantic-yaml" }) }]),
    });
    expect(result[0].representationMode).toBe("semantic-yaml");
  });

  it("coerces an unknown representation-mode to the bake-off default", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([{ install_id: "ds-1", config: config({ representation_mode: "bogus" }) }]),
    });
    expect(result[0].representationMode).toBe("operation-graph");
  });

  it("applies base_url_override over the spec servers", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([
        { install_id: "ds-1", config: config({ base_url_override: "https://staging.example.com/v1/" }) },
      ]),
    });
    expect(result[0].baseUrl).toBe("https://staging.example.com/v1"); // trailing slash stripped
  });

  it("resolves a relative spec server against the spec URL", async () => {
    const relDoc = {
      openapi: "3.1.0",
      info: { title: "Rel", version: "1.0.0" },
      servers: [{ url: "/rest" }],
      paths: { "/things": { get: { operationId: "listThings", responses: { "200": { description: "OK" } } } } },
    };
    const relSnap = buildSnapshot(relDoc, buildOperationGraph(relDoc), "2026-05-29T06:00:00.000Z");
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([
        { install_id: "ds-rel", config: config({ openapi_url: "https://api.example.com/openapi.json", openapi_snapshot: relSnap }) },
      ]),
    });
    expect(result[0].baseUrl).toBe("https://api.example.com/rest");
  });

  it("falls back to the spec URL origin when the doc declares no servers", async () => {
    const noSrvDoc = {
      openapi: "3.1.0",
      info: { title: "NoSrv", version: "1.0.0" },
      paths: { "/things": { get: { operationId: "listThings", responses: { "200": { description: "OK" } } } } },
    };
    const noSrvSnap = buildSnapshot(noSrvDoc, buildOperationGraph(noSrvDoc), "2026-05-29T07:00:00.000Z");
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([
        { install_id: "ds-nosrv", config: config({ openapi_url: "https://api.example.com/v3/openapi.json", openapi_snapshot: noSrvSnap }) },
      ]),
    });
    expect(result[0].baseUrl).toBe("https://api.example.com");
  });

  it("builds apikey-header auth with the configured header name", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([
        {
          install_id: "ds-1",
          config: config({ auth_kind: "apikey-header", auth_value: "k123", auth_header_name: "X-My-Key" }),
        },
      ]),
    });
    expect(result[0].auth).toEqual({ kind: "apiKey", value: "k123", placement: { in: "header", name: "X-My-Key" } });
  });

  it("resolves multiple installs side by side (multi-instance)", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([
        { install_id: "twenty", config: config({ display_name: "Twenty", openapi_snapshot: snapshot("2026-05-29T01:00:00.000Z") }) },
        { install_id: "stripe", config: config({ display_name: "Stripe", openapi_snapshot: snapshot("2026-05-29T02:00:00.000Z") }) },
      ]),
    });
    expect(result.map((d) => d.id)).toEqual(["twenty", "stripe"]);
    expect(result.map((d) => d.displayName)).toEqual(["Twenty", "Stripe"]);
  });

  it("skips an install with no cached snapshot (fail-soft), not the whole set", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([
        { install_id: "broken", config: config({ openapi_snapshot: undefined }) },
        { install_id: "ok", config: config({ openapi_snapshot: snapshot("2026-05-29T03:00:00.000Z") }) },
      ]),
    });
    expect(result.map((d) => d.id)).toEqual(["ok"]);
  });

  it("returns [] when the query throws (fail-soft)", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: async () => {
        throw new Error("pg down");
      },
    });
    expect(result).toEqual([]);
  });

  it("falls back to the snapshot title when display_name is absent", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([{ install_id: "ds-1", config: config({ display_name: undefined }) }]),
    });
    expect(result[0].displayName).toBe("Mock Widget API");
  });
});

describe("resolveWorkspacePrimaryRestDatasource", () => {
  it("returns the first install, or null when none", async () => {
    expect(
      await resolveWorkspacePrimaryRestDatasource("org-1", { query: queryReturning([]) }),
    ).toBeNull();
    const primary = await resolveWorkspacePrimaryRestDatasource("org-1", {
      query: queryReturning([
        { install_id: "first", config: config() },
        { install_id: "second", config: config({ openapi_snapshot: snapshot("2026-05-29T05:00:00.000Z") }) },
      ]),
    });
    expect(primary?.id).toBe("first");
  });
});
