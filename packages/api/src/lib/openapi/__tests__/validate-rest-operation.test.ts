/**
 * Boundary tests for `validateRestOperation` — the REST write-side safety stack
 * (PRD #2868 slice 5, #2929). The sibling to `validateSQL`'s 4-layer test file:
 * one rejection path per layer, asserted in isolation, plus the happy paths and
 * the layer-ordering guarantees.
 *
 * The five layers, enforced in order:
 *   1. Operation must exist in the probed graph     → unknown-operation
 *   2. Method allowlist (GET/HEAD, or write_allowlist) → writes-disabled
 *   3. Parameter shape (required present, no extras)  → invalid-params
 *   4. Per-tenant per-operation rate limit (dispatch)  → rate-limit-exceeded
 *   5. Per-request timeout cap (ATLAS_OPENAPI_TIMEOUT)  → timeout-exceeded
 *
 * This is a SECURITY boundary — treat it like validateSQL. A default-deny on
 * writes, a fail-loud on unknown operations, and never a silent dispatch.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import { buildOperationGraph } from "@atlas/api/lib/openapi/spec";
import type { OperationGraph } from "@atlas/api/lib/openapi/types";
import {
  validateRestOperation,
  getOpenApiTimeoutCap,
  _resetRestRateLimits,
  type RestOperationPolicy,
} from "../validate-rest-operation";

// ── A small synthetic spec exercising every layer ──────────────────────────
// One read (GET, optional + required query), one read-by-id (path param), one
// write (POST with required body), one delete (DELETE, optional query).
const SPEC = {
  openapi: "3.1.0",
  info: { title: "Boundary API", version: "1.0.0" },
  servers: [{ url: "https://api.example.com" }],
  paths: {
    "/people": {
      get: {
        operationId: "listPeople",
        security: [],
        parameters: [
          { name: "filter", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: true, schema: { type: "integer" } },
        ],
        responses: { "200": { description: "ok" } },
      },
      post: {
        operationId: "createPerson",
        security: [],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: { "201": { description: "created" } },
      },
    },
    "/people/{id}": {
      get: {
        operationId: "getPerson",
        security: [],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "ok" } },
      },
      delete: {
        operationId: "deletePerson",
        security: [],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "soft_delete", in: "query", required: false, schema: { type: "boolean" } },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
  },
} as const;

const graph: OperationGraph = buildOperationGraph(SPEC);

/** A policy with a generous quota so the rate-limit layer never trips by accident. */
function policy(overrides: Partial<RestOperationPolicy> = {}): RestOperationPolicy {
  return {
    workspaceId: "ws-1",
    datasourceId: "ds-1",
    writeAllowlist: new Set<string>(),
    rateLimitPerMinute: 1000,
    ...overrides,
  };
}

beforeEach(() => _resetRestRateLimits());
afterEach(() => {
  _resetRestRateLimits();
  delete process.env.ATLAS_OPENAPI_TIMEOUT;
});

describe("validateRestOperation — happy paths", () => {
  it("allows a GET with its required params, no confirmation needed", () => {
    const v = validateRestOperation(graph, "listPeople", { query: { limit: 10 } }, policy());
    expect(v.allowed).toBe(true);
    if (!v.allowed) return;
    expect(v.requiresConfirmation).toBe(false);
    expect(v.operation.method).toBe("GET");
    expect(v.timeoutMs).toBe(getOpenApiTimeoutCap());
  });

  it("allows a GET with a path param", () => {
    const v = validateRestOperation(graph, "getPerson", { path: { id: "p-1" } }, policy());
    expect(v.allowed).toBe(true);
  });

  it("allows an allowlisted write but flags requiresConfirmation", () => {
    const v = validateRestOperation(
      graph,
      "createPerson",
      { body: { name: "Ada" } },
      policy({ writeAllowlist: new Set(["createPerson"]) }),
    );
    expect(v.allowed).toBe(true);
    if (!v.allowed) return;
    expect(v.requiresConfirmation).toBe(true);
    expect(v.operation.method).toBe("POST");
  });
});

describe("validateRestOperation — layer 1: unknown operation (fail loud)", () => {
  it("rejects an operationId not in the probed graph", () => {
    const v = validateRestOperation(graph, "deleteEverything", {}, policy());
    expect(v.allowed).toBe(false);
    if (v.allowed) return;
    expect(v.error.reason).toBe("unknown-operation");
    expect(v.error.availableOperations).toContain("listPeople");
    // Never reports a method/confirmation for a fabricated op.
    expect(v.error.operationId).toBe("deleteEverything");
  });
});

describe("validateRestOperation — layer 2: method allowlist (default-deny writes)", () => {
  it("rejects a write with NO write_allowlist entry (writes disabled)", () => {
    const v = validateRestOperation(graph, "deletePerson", { path: { id: "p-1" } }, policy());
    expect(v.allowed).toBe(false);
    if (v.allowed) return;
    expect(v.error.reason).toBe("writes-disabled");
    expect(v.error.message.toLowerCase()).toContain("write");
  });

  it("rejects a write when the allowlist contains a DIFFERENT operation", () => {
    const v = validateRestOperation(
      graph,
      "deletePerson",
      { path: { id: "p-1" } },
      policy({ writeAllowlist: new Set(["createPerson"]) }),
    );
    expect(v.allowed).toBe(false);
    if (v.allowed) return;
    expect(v.error.reason).toBe("writes-disabled");
  });

  it("never rate-limits a GET into a writes-disabled answer (GET is always allowed by method)", () => {
    const v = validateRestOperation(graph, "listPeople", { query: { limit: 1 } }, policy());
    expect(v.allowed).toBe(true);
  });
});

describe("validateRestOperation — layer 3: parameter shape", () => {
  it("rejects a GET missing a required query param", () => {
    const v = validateRestOperation(graph, "listPeople", {}, policy());
    expect(v.allowed).toBe(false);
    if (v.allowed) return;
    expect(v.error.reason).toBe("invalid-params");
    expect(v.error.missingParams).toContain("limit");
  });

  it("rejects a GET-by-id missing its required path param", () => {
    const v = validateRestOperation(graph, "getPerson", {}, policy());
    expect(v.allowed).toBe(false);
    if (v.allowed) return;
    expect(v.error.reason).toBe("invalid-params");
    expect(v.error.missingParams).toContain("id");
  });

  it("rejects an allowlisted write missing its required body", () => {
    const v = validateRestOperation(
      graph,
      "createPerson",
      {},
      policy({ writeAllowlist: new Set(["createPerson"]) }),
    );
    expect(v.allowed).toBe(false);
    if (v.allowed) return;
    expect(v.error.reason).toBe("invalid-params");
    expect(v.error.missingParams).toContain("body");
  });

  it("rejects a param not declared in the spec (no extras)", () => {
    const v = validateRestOperation(
      graph,
      "listPeople",
      { query: { limit: 1, bogus: "x" } },
      policy(),
    );
    expect(v.allowed).toBe(false);
    if (v.allowed) return;
    expect(v.error.reason).toBe("invalid-params");
    expect(v.error.unexpectedParams).toContain("bogus");
  });

  it("accepts optional params alongside required ones", () => {
    const v = validateRestOperation(
      graph,
      "listPeople",
      { query: { limit: 1, filter: "name[eq]:Ada" } },
      policy(),
    );
    expect(v.allowed).toBe(true);
  });
});

describe("validateRestOperation — layer 4: rate limit (per-tenant per-operation token bucket)", () => {
  it("rejects once the per-operation quota is exhausted (dispatch only)", () => {
    const t = 1_000_000;
    const p = policy({ rateLimitPerMinute: 2, dispatch: true, now: () => t });
    expect(validateRestOperation(graph, "listPeople", { query: { limit: 1 } }, p).allowed).toBe(true);
    expect(validateRestOperation(graph, "listPeople", { query: { limit: 1 } }, p).allowed).toBe(true);
    const third = validateRestOperation(graph, "listPeople", { query: { limit: 1 } }, p);
    expect(third.allowed).toBe(false);
    if (third.allowed) return;
    expect(third.error.reason).toBe("rate-limit-exceeded");
    expect(third.error.retryAfterMs).toBeGreaterThan(0);
  });

  it("refills over time", () => {
    let t = 1_000_000;
    const p = policy({ rateLimitPerMinute: 2, dispatch: true, now: () => t });
    validateRestOperation(graph, "listPeople", { query: { limit: 1 } }, p);
    validateRestOperation(graph, "listPeople", { query: { limit: 1 } }, p);
    expect(validateRestOperation(graph, "listPeople", { query: { limit: 1 } }, p).allowed).toBe(false);
    // One token refills after 60s/2 = 30s.
    t += 30_000;
    expect(validateRestOperation(graph, "listPeople", { query: { limit: 1 } }, p).allowed).toBe(true);
  });

  it("buckets are isolated per (workspace, datasource, operation)", () => {
    const t = 1_000_000;
    const base = { rateLimitPerMinute: 1, dispatch: true, now: () => t } as const;
    // Exhaust ws-1/ds-1/listPeople.
    validateRestOperation(graph, "listPeople", { query: { limit: 1 } }, policy(base));
    expect(
      validateRestOperation(graph, "listPeople", { query: { limit: 1 } }, policy(base)).allowed,
    ).toBe(false);
    // A different operation in the same datasource is unaffected.
    expect(
      validateRestOperation(graph, "getPerson", { path: { id: "p-1" } }, policy(base)).allowed,
    ).toBe(true);
    // A different workspace is unaffected.
    expect(
      validateRestOperation(
        graph,
        "listPeople",
        { query: { limit: 1 } },
        policy({ ...base, workspaceId: "ws-2" }),
      ).allowed,
    ).toBe(true);
  });

  it("does NOT debit the quota when staging (dispatch:false)", () => {
    const t = 1_000_000;
    const stage = policy({ rateLimitPerMinute: 1, dispatch: false, now: () => t, writeAllowlist: new Set(["createPerson"]) });
    // Stage the same write many times — never rate-limited (no upstream call yet).
    for (let i = 0; i < 5; i++) {
      const v = validateRestOperation(graph, "createPerson", { body: { name: "Ada" } }, stage);
      expect(v.allowed).toBe(true);
    }
  });

  it("staging never consumes the single token the confirm later needs (debited exactly once)", () => {
    // The full stage→confirm seam, the invariant the `dispatch` flag protects:
    // with a budget of ONE call, staging the write 5× must leave that token
    // intact so the eventual confirm (dispatch:true) succeeds — then a second
    // confirm is throttled. A regression that debited on staging would 429 the
    // legitimate confirm; a regression that double-debited would too.
    const t = 1_000_000;
    const wl = new Set(["createPerson"]);
    const stage = policy({ rateLimitPerMinute: 1, dispatch: false, now: () => t, writeAllowlist: wl });
    for (let i = 0; i < 5; i++) {
      expect(validateRestOperation(graph, "createPerson", { body: {} }, stage).allowed).toBe(true);
    }
    const confirm = policy({ rateLimitPerMinute: 1, dispatch: true, now: () => t, writeAllowlist: wl });
    expect(validateRestOperation(graph, "createPerson", { body: {} }, confirm).allowed).toBe(true);
    // The one token is now spent — a second confirm is throttled.
    const second = validateRestOperation(graph, "createPerson", { body: {} }, confirm);
    expect(second.allowed).toBe(false);
    if (second.allowed) return;
    expect(second.error.reason).toBe("rate-limit-exceeded");
  });
});

describe("validateRestOperation — layer 5: timeout cap", () => {
  it("uses the configured cap as the effective timeout by default", () => {
    process.env.ATLAS_OPENAPI_TIMEOUT = "12000";
    const v = validateRestOperation(graph, "listPeople", { query: { limit: 1 } }, policy());
    expect(v.allowed).toBe(true);
    if (!v.allowed) return;
    expect(v.timeoutMs).toBe(12000);
  });

  it("rejects a per-install requested timeout above the cap", () => {
    process.env.ATLAS_OPENAPI_TIMEOUT = "30000";
    const v = validateRestOperation(
      graph,
      "listPeople",
      { query: { limit: 1 } },
      policy({ requestedTimeoutMs: 120_000 }),
    );
    expect(v.allowed).toBe(false);
    if (v.allowed) return;
    expect(v.error.reason).toBe("timeout-exceeded");
  });

  it("rejects a non-positive requested timeout", () => {
    const v = validateRestOperation(
      graph,
      "listPeople",
      { query: { limit: 1 } },
      policy({ requestedTimeoutMs: 0 }),
    );
    expect(v.allowed).toBe(false);
    if (v.allowed) return;
    expect(v.error.reason).toBe("timeout-exceeded");
  });

  it("honours a requested timeout at or below the cap", () => {
    process.env.ATLAS_OPENAPI_TIMEOUT = "30000";
    const v = validateRestOperation(
      graph,
      "listPeople",
      { query: { limit: 1 } },
      policy({ requestedTimeoutMs: 5000 }),
    );
    expect(v.allowed).toBe(true);
    if (!v.allowed) return;
    expect(v.timeoutMs).toBe(5000);
  });
});

describe("validateRestOperation — layer ordering", () => {
  it("reports unknown-operation before any method/param check", () => {
    const v = validateRestOperation(graph, "ghost", { query: { bogus: 1 } }, policy());
    expect(v.allowed).toBe(false);
    if (v.allowed) return;
    expect(v.error.reason).toBe("unknown-operation");
  });

  it("reports writes-disabled before param validation for a non-allowlisted write", () => {
    // createPerson needs a body (param check would fail), but the method gate
    // fires first — a disabled write must never leak its param requirements.
    const v = validateRestOperation(graph, "createPerson", {}, policy());
    expect(v.allowed).toBe(false);
    if (v.allowed) return;
    expect(v.error.reason).toBe("writes-disabled");
  });

  it("getOpenApiTimeoutCap defaults to 30s and clamps invalid values", () => {
    delete process.env.ATLAS_OPENAPI_TIMEOUT;
    expect(getOpenApiTimeoutCap()).toBe(30_000);
    process.env.ATLAS_OPENAPI_TIMEOUT = "not-a-number";
    expect(getOpenApiTimeoutCap()).toBe(30_000);
    process.env.ATLAS_OPENAPI_TIMEOUT = "-5";
    expect(getOpenApiTimeoutCap()).toBe(30_000);
  });
});
