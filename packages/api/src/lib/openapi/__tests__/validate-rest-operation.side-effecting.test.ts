/**
 * #3008 — side-effecting-GET classification escape hatch.
 *
 * GET=read is only a DEFAULT, never ground truth. A mutating RPC-over-GET
 * (`GET /jobs/{id}/cancel`) can be flagged side-effecting — via the
 * `x-atlas-side-effecting: true` spec extension ({@link Operation.sideEffecting})
 * or the install config's `side_effecting_operations` list (threaded onto the
 * policy as `sideEffectingOperations`) — and is then forced through the SAME
 * write allowlist + confirm path as a POST.
 *
 * Self-contained fixtures (no shared helpers) so this file is robust on its own.
 */
import { describe, expect, it, beforeEach } from "bun:test";

import {
  validateRestOperation,
  isSideEffectingOperation,
  _resetRestRateLimits,
  type RestOperationPolicy,
} from "../validate-rest-operation";
import type { Operation, OperationGraph } from "../types";

function makeOperation(overrides: Partial<Operation> = {}): Operation {
  return {
    operationId: "op",
    method: "GET",
    path: "/op",
    tags: [],
    parameters: [],
    security: [],
    responses: new Map(),
    ...overrides,
  };
}

function makeGraph(operations: Operation[]): OperationGraph {
  return {
    operations: new Map(operations.map((op) => [op.operationId, op])),
    schemas: new Map(),
    security: new Map(),
    servers: [],
    info: { title: "Test", version: "1.0.0", openapiVersion: "3.1.0" },
  };
}

function makePolicy(overrides: Partial<RestOperationPolicy> = {}): RestOperationPolicy {
  return {
    workspaceId: "ws",
    datasourceId: "ds",
    writeAllowlist: new Set<string>(),
    now: () => 0,
    ...overrides,
  };
}

describe("isSideEffectingOperation (#3008)", () => {
  it("treats a plain GET/HEAD as a read", () => {
    expect(isSideEffectingOperation(makeOperation({ method: "GET" }))).toBe(false);
    expect(isSideEffectingOperation(makeOperation({ method: "HEAD" }))).toBe(false);
  });

  it("treats every non-GET/HEAD method as a write regardless of flags", () => {
    expect(isSideEffectingOperation(makeOperation({ method: "POST" }))).toBe(true);
    // De-escalation is impossible: sideEffecting:false on a write stays a write.
    expect(
      isSideEffectingOperation(makeOperation({ method: "DELETE", sideEffecting: false })),
    ).toBe(true);
  });

  it("escalates a GET flagged via the x-atlas-side-effecting spec extension", () => {
    expect(isSideEffectingOperation(makeOperation({ method: "GET", sideEffecting: true }))).toBe(
      true,
    );
  });

  it("escalates a GET listed in the install config's side_effecting_operations", () => {
    const op = makeOperation({ operationId: "cancelJob", method: "GET" });
    expect(isSideEffectingOperation(op, new Set(["cancelJob"]))).toBe(true);
    expect(isSideEffectingOperation(op, new Set(["other"]))).toBe(false);
  });
});

describe("validateRestOperation — side-effecting overrides (#3008)", () => {
  beforeEach(() => {
    _resetRestRateLimits();
  });

  it("rejects a side-effecting GET (spec extension) absent from the allowlist", () => {
    const graph = makeGraph([
      makeOperation({ operationId: "cancelJob", method: "GET", sideEffecting: true }),
    ]);
    const verdict = validateRestOperation(graph, "cancelJob", {}, makePolicy());
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.error.reason).toBe("writes-disabled");
      // The message names the side-effecting flag, not the misleading "GET (write)".
      expect(verdict.error.message).toContain("side-effecting");
    }
  });

  it("requires confirmation for an allowlisted side-effecting GET (spec extension)", () => {
    const graph = makeGraph([
      makeOperation({ operationId: "cancelJob", method: "GET", sideEffecting: true }),
    ]);
    const verdict = validateRestOperation(
      graph,
      "cancelJob",
      {},
      makePolicy({ writeAllowlist: new Set(["cancelJob"]) }),
    );
    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) {
      expect(verdict.requiresConfirmation).toBe(true);
    }
  });

  it("rejects a side-effecting GET (config list) absent from the allowlist", () => {
    const graph = makeGraph([makeOperation({ operationId: "cancelJob", method: "GET" })]);
    const verdict = validateRestOperation(
      graph,
      "cancelJob",
      {},
      makePolicy({ sideEffectingOperations: new Set(["cancelJob"]) }),
    );
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.error.reason).toBe("writes-disabled");
    }
  });

  it("requires confirmation for an allowlisted side-effecting GET (config list)", () => {
    const graph = makeGraph([makeOperation({ operationId: "cancelJob", method: "GET" })]);
    const verdict = validateRestOperation(
      graph,
      "cancelJob",
      {},
      makePolicy({
        writeAllowlist: new Set(["cancelJob"]),
        sideEffectingOperations: new Set(["cancelJob"]),
      }),
    );
    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) {
      expect(verdict.requiresConfirmation).toBe(true);
    }
  });

  it("leaves an unmarked GET a read needing neither allowlist nor confirmation (regression)", () => {
    const graph = makeGraph([makeOperation({ operationId: "getPerson", method: "GET" })]);
    const verdict = validateRestOperation(
      graph,
      "getPerson",
      {},
      makePolicy({ sideEffectingOperations: new Set(["somethingElse"]) }),
    );
    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) {
      expect(verdict.requiresConfirmation).toBe(false);
    }
  });
});
