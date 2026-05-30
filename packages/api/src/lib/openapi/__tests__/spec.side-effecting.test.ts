/**
 * #3008 — `buildOperationGraph` reads the `x-atlas-side-effecting` operation
 * extension into {@link Operation.sideEffecting}. This is the ONE vendor
 * extension the parse boundary surfaces; only an explicit `true` escalates (a
 * missing or `false` value leaves classification to the HTTP method, and can
 * never DOWNGRADE a write to a read).
 */
import { describe, expect, it } from "bun:test";

import { buildOperationGraph } from "../spec";

function doc() {
  return {
    openapi: "3.1.0",
    info: { title: "Jobs", version: "1.0.0" },
    paths: {
      "/jobs/{id}/cancel": {
        get: {
          operationId: "cancelJob",
          "x-atlas-side-effecting": true,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "ok" } },
        },
      },
      "/people": {
        get: {
          operationId: "listPeople",
          responses: { "200": { description: "ok" } },
        },
      },
      "/jobs/{id}": {
        get: {
          operationId: "getJob",
          "x-atlas-side-effecting": false,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}

describe("buildOperationGraph — x-atlas-side-effecting (#3008)", () => {
  it("sets sideEffecting:true when the extension is true", () => {
    const graph = buildOperationGraph(doc());
    expect(graph.operations.get("cancelJob")?.sideEffecting).toBe(true);
  });

  it("leaves sideEffecting undefined when the extension is absent", () => {
    const graph = buildOperationGraph(doc());
    expect(graph.operations.get("listPeople")?.sideEffecting).toBeUndefined();
  });

  it("does not escalate when the extension is explicitly false", () => {
    const graph = buildOperationGraph(doc());
    expect(graph.operations.get("getJob")?.sideEffecting).toBeUndefined();
  });
});
