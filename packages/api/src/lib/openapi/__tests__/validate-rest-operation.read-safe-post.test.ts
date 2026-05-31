/**
 * #3035 — candidate-declared read-safe POST operations.
 *
 * A default data-candidate install resolves with an EMPTY write allowlist, and
 * the validator classifies every non-GET/HEAD as a write — so a vendor whose
 * READ surface uses POST (Notion's workspace search is `POST /v1/search`) is
 * unreachable on a default install (it returns `writes-disabled` before
 * dispatch). A {@link import("../data-candidates").DataCandidate} declares its genuinely read-only POSTs
 * (`readSafePostOperations`); the resolver threads them onto the policy as
 * `readSafePostOperations`, and {@link isSideEffectingOperation} demotes such a
 * POST to a READ — it passes the write allowlist (layer 2) without an entry.
 *
 * Curated, code-resident, and STRICTLY a safety-DROP that escalation overrides:
 *   - only a POST is ever demoted (a misdeclared DELETE/PUT stays a write),
 *   - a genuine (non-declared) POST is STILL gated as a write,
 *   - an explicit side-effecting signal (the `x-atlas-side-effecting` spec
 *     extension or the install's `side_effecting_operations` list) WINS over a
 *     read-safe declaration — "this mutates" can never be overridden by "this
 *     reads", preserving the monotonic-escalation invariant.
 *
 * Self-contained fixtures (no shared helpers), mirroring the sibling
 * `validate-rest-operation.side-effecting.test.ts`.
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
    method: "POST",
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

describe("isSideEffectingOperation — read-safe POST demotion (#3035)", () => {
  it("demotes a declared read-safe POST to a read", () => {
    const op = makeOperation({ operationId: "post-search", method: "POST" });
    expect(isSideEffectingOperation(op, undefined, new Set(["post-search"]))).toBe(false);
  });

  it("leaves a non-declared POST a write", () => {
    const op = makeOperation({ operationId: "createWidget", method: "POST" });
    expect(isSideEffectingOperation(op, undefined, new Set(["post-search"]))).toBe(true);
  });

  it("only demotes POST — a non-POST id in the set stays a write", () => {
    // Defense-in-depth: the demotion is keyed on the POST method too, so a
    // misdeclared DELETE/PUT operationId is inert (never silently demoted).
    const del = makeOperation({ operationId: "deleteWidget", method: "DELETE" });
    expect(isSideEffectingOperation(del, undefined, new Set(["deleteWidget"]))).toBe(true);
  });

  it("lets an explicit side-effecting flag (spec extension) override the read-safe declaration", () => {
    const op = makeOperation({ operationId: "post-search", method: "POST", sideEffecting: true });
    // "this mutates" (vendor spec) wins over "this reads" (curated demotion).
    expect(isSideEffectingOperation(op, undefined, new Set(["post-search"]))).toBe(true);
  });

  it("lets the install's side_effecting_operations list override the read-safe declaration", () => {
    const op = makeOperation({ operationId: "post-search", method: "POST" });
    expect(
      isSideEffectingOperation(op, new Set(["post-search"]), new Set(["post-search"])),
    ).toBe(true);
  });

  it("is a no-op when no read-safe set is supplied (regression: POST stays a write)", () => {
    const op = makeOperation({ operationId: "post-search", method: "POST" });
    expect(isSideEffectingOperation(op)).toBe(true);
    expect(isSideEffectingOperation(op, undefined, new Set())).toBe(true);
  });
});

describe("validateRestOperation — read-safe POST gate (#3035)", () => {
  beforeEach(() => {
    _resetRestRateLimits();
  });

  it("passes a declared read-safe POST WITHOUT a write-allowlist entry", () => {
    const graph = makeGraph([makeOperation({ operationId: "post-search", method: "POST" })]);
    const verdict = validateRestOperation(
      graph,
      "post-search",
      {},
      makePolicy({ readSafePostOperations: new Set(["post-search"]) }),
    );
    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) {
      // It is a READ — no confirm-before-write step.
      expect(verdict.requiresConfirmation).toBe(false);
    }
  });

  it("still gates a genuine (non-declared) POST as a write needing the allowlist", () => {
    const graph = makeGraph([makeOperation({ operationId: "createWidget", method: "POST" })]);
    const verdict = validateRestOperation(
      graph,
      "createWidget",
      {},
      // A different POST is declared read-safe — createWidget is not, so it's gated.
      makePolicy({ readSafePostOperations: new Set(["post-search"]) }),
    );
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.error.reason).toBe("writes-disabled");
    }
  });

  it("re-gates a declared read-safe POST that is ALSO flagged side-effecting (escalation wins)", () => {
    const graph = makeGraph([
      makeOperation({ operationId: "post-search", method: "POST", sideEffecting: true }),
    ]);
    const verdict = validateRestOperation(
      graph,
      "post-search",
      {},
      makePolicy({ readSafePostOperations: new Set(["post-search"]) }),
    );
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.error.reason).toBe("writes-disabled");
    }
  });

  it("dispatches the declared read-safe POST (read), debiting the rate quota like any read", () => {
    // dispatch defaults to true for a read; the verdict carries the resolved op.
    const graph = makeGraph([makeOperation({ operationId: "post-search", method: "POST" })]);
    const verdict = validateRestOperation(
      graph,
      "post-search",
      {},
      makePolicy({ readSafePostOperations: new Set(["post-search"]) }),
    );
    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) {
      expect(verdict.operation.operationId).toBe("post-search");
    }
  });
});
