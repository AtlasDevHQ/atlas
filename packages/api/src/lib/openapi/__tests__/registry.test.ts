/**
 * Tests for the `OpenApiDatasourceRegistry` Effect service (#2926, AC6).
 *
 * Demonstrates the two test seams the slice ships so consumers never reach for
 * `mock.module()`:
 *   - `createOpenApiDatasourceTestLayer` — canned datasources per workspace.
 *   - `createOpenApiDatasourceRegistryLayer` — real resolution against an
 *     injected `workspace_plugins` query.
 * Both compose via `Layer.provide`, the CLAUDE.md-preferred pattern.
 */

import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  OpenApiDatasourceRegistry,
  createOpenApiDatasourceTestLayer,
  createOpenApiDatasourceRegistryLayer,
} from "../registry";
import { createOpenApiDatasourceMock } from "@atlas/api/testing/openapi-datasource";
import { buildOperationGraph } from "../spec";
import { buildSnapshot } from "../probe";
import { MOCK_OPENAPI_SPEC } from "@atlas/api/testing/openapi-datasource";

const resolveFor = (workspaceId: string) =>
  OpenApiDatasourceRegistry.pipe(Effect.flatMap((r) => r.resolveForWorkspace(workspaceId)));

describe("createOpenApiDatasourceTestLayer", () => {
  it("returns canned datasources per workspace via Layer.provide", async () => {
    const twenty = createOpenApiDatasourceMock({ id: "twenty", displayName: "Twenty" });
    const layer = createOpenApiDatasourceTestLayer({ "org-1": [twenty] });

    const got = await Effect.runPromise(resolveFor("org-1").pipe(Effect.provide(layer)));
    expect(got).toHaveLength(1);
    expect(got[0].id).toBe("twenty");

    const none = await Effect.runPromise(resolveFor("org-2").pipe(Effect.provide(layer)));
    expect(none).toEqual([]);
  });

  it("accepts a resolver function form", async () => {
    const layer = createOpenApiDatasourceTestLayer((ws) =>
      ws === "org-x" ? [createOpenApiDatasourceMock({ id: "x" })] : [],
    );
    const got = await Effect.runPromise(resolveFor("org-x").pipe(Effect.provide(layer)));
    expect(got[0].id).toBe("x");
  });
});

describe("createOpenApiDatasourceRegistryLayer (real resolution, injected query)", () => {
  it("resolves through the real workspace resolver against a fixture query", async () => {
    const graph = buildOperationGraph(MOCK_OPENAPI_SPEC);
    const layer = createOpenApiDatasourceRegistryLayer({
      query: async () => [
        {
          install_id: "ds-1",
          config: {
            openapi_url: "https://widgets.example.com/openapi.json",
            auth_kind: "bearer",
            auth_value: "tok",
            representation_mode: "operation-graph",
            openapi_snapshot: buildSnapshot(MOCK_OPENAPI_SPEC, graph, "2026-05-29T00:00:00.000Z"),
          },
        },
      ],
    });
    const got = await Effect.runPromise(resolveFor("org-1").pipe(Effect.provide(layer)));
    expect(got).toHaveLength(1);
    expect(got[0].id).toBe("ds-1");
    expect(got[0].graph.operations.has("listWidgets")).toBe(true);
  });
});
