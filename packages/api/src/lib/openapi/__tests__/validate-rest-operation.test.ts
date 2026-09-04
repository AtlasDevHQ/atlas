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
import type { Operation, OperationGraph } from "@atlas/api/lib/openapi/types";
import {
  validateRestOperation,
  isSideEffectingOperation,
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

  it("a timeout rejection does NOT debit the rate-limit token (debit runs after the timeout check)", () => {
    // Budget of ONE call, fixed clock so the bucket can't refill mid-test. A
    // request rejected for a misconfigured timeout must not burn that token —
    // otherwise a single bad per-install config would lock the operation out.
    const t = 1_000_000;
    process.env.ATLAS_OPENAPI_TIMEOUT = "30000";

    const overCap = policy({ rateLimitPerMinute: 1, dispatch: true, now: () => t, requestedTimeoutMs: 120_000 });
    const rejected = validateRestOperation(graph, "listPeople", { query: { limit: 1 } }, overCap);
    expect(rejected.allowed).toBe(false);
    if (rejected.allowed) return;
    expect(rejected.error.reason).toBe("timeout-exceeded");

    // The single token survived the rejection: a well-configured dispatch on the
    // SAME (workspace, datasource, operation) bucket still succeeds...
    const ok = policy({ rateLimitPerMinute: 1, dispatch: true, now: () => t });
    expect(validateRestOperation(graph, "listPeople", { query: { limit: 1 } }, ok).allowed).toBe(true);

    // ...and only now — after a real dispatch — is the bucket empty.
    const throttled = validateRestOperation(graph, "listPeople", { query: { limit: 1 } }, ok);
    expect(throttled.allowed).toBe(false);
    if (throttled.allowed) return;
    expect(throttled.error.reason).toBe("rate-limit-exceeded");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Classification overrides — the two escape hatches around "GET = read".
//  Formerly validate-rest-operation.side-effecting.test.ts (#3008) and
//  validate-rest-operation.read-safe-post.test.ts (#3035). Both used the same
//  self-contained synthetic-operation fixtures, shared here.
// ═══════════════════════════════════════════════════════════════════════════

/** A synthetic operation; every call site below states its method explicitly. */
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

/**
 * #3008 — side-effecting-GET classification escape hatch.
 *
 * GET=read is only a DEFAULT, never ground truth. A mutating RPC-over-GET
 * (`GET /jobs/{id}/cancel`) can be flagged side-effecting — via the
 * `x-atlas-side-effecting: true` spec extension ({@link Operation.sideEffecting})
 * or the install config's `side_effecting_operations` list (threaded onto the
 * policy as `sideEffectingOperations`) — and is then forced through the SAME
 * write allowlist + confirm path as a POST.
 */
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
 */
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
