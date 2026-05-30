import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";

import { buildOperationGraph } from "@atlas/api/lib/openapi/spec";
import type { RestDatasource } from "@atlas/api/lib/openapi/datasource";
import {
  createExecuteRestOperationTool,
  type ExecuteRestOperationResult,
} from "../rest-operation";
import { _resetRestRateLimits } from "@atlas/api/lib/openapi/validate-rest-operation";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/encryption-keys";
import {
  startTwentyMockServer,
  type TwentyMock,
} from "@atlas/api/lib/openapi/__tests__/twenty-acceptance/mock-server";
import { createOpenApiDatasourceMock } from "@atlas/api/testing/openapi-datasource";

const SPEC = JSON.parse(
  fs.readFileSync(
    path.join(import.meta.dir, "..", "..", "openapi", "__tests__", "twenty-acceptance", "spec.json"),
    "utf8",
  ),
);
const graph = buildOperationGraph(SPEC);

let mock: TwentyMock;

// The mock REST server binds to 127.0.0.1 (loopback), which the #3006 SSRF guard
// blocks by default. A local test server is the "internal service" case the
// operator opt-out exists for — enable it for this file and restore it after.
const ORIGINAL_EGRESS_FLAG = process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
// Staging an allowlisted write now mints a signed single-use confirm token (#3007),
// which needs a signing key resolvable from the encryption keyset. Restore after.
const ORIGINAL_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;

beforeAll(async () => {
  process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS = "true";
  process.env.BETTER_AUTH_SECRET = "test-confirm-token-signing-secret-not-a-real-key";
  mock = await startTwentyMockServer();
});
afterAll(async () => {
  if (ORIGINAL_EGRESS_FLAG === undefined) delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
  else process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS = ORIGINAL_EGRESS_FLAG;
  if (ORIGINAL_AUTH_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = ORIGINAL_AUTH_SECRET;
  await mock.close();
});
beforeEach(() => {
  mock.reset();
  // The tool now runs validateRestOperation (which debits a per-operation rate
  // bucket) on every read — reset it so a generous default never bleeds across tests.
  _resetRestRateLimits();
});

function datasource(overrides: Partial<RestDatasource> = {}): RestDatasource {
  return {
    id: "twenty",
    displayName: "Twenty",
    graph,
    baseUrl: mock.restBaseUrl,
    auth: { kind: "bearer", token: "test-token" },
    representationMode: "operation-graph",
    writeAllowlist: new Set<string>(),
    sideEffectingOperations: new Set<string>(),
    ...overrides,
  };
}

/** Invoke the tool's execute with a minimal ToolCallOptions stub. */
async function call(
  input: Record<string, unknown>,
  resolve: () => Promise<RestDatasource | null> = async () => datasource(),
): Promise<ExecuteRestOperationResult> {
  const t = createExecuteRestOperationTool({ resolveDatasource: resolve });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ToolCallOptions stub for a unit invocation
  return (await t.execute!(input as any, { toolCallId: "t1", messages: [] } as any)) as ExecuteRestOperationResult;
}

describe("executeRestOperation tool", () => {
  it("executes a GET and returns the upstream body (status ok)", async () => {
    const result = await call({ operationId: "findManyPeople" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.httpStatus).toBe(200);
    expect((result.body as { data: { people: unknown[] } }).data.people.length).toBe(2);
    // Bearer auth reached the upstream.
    const req = mock.matching("/rest/people").at(-1);
    expect(req?.headers["authorization"]).toBe("Bearer test-token");
  });

  it("TRAP 1 — round-trips the field[op]:value filter (not bracket-nested)", async () => {
    const result = await call({
      operationId: "findManyPeople",
      query: { filter: "emails.primaryEmail[eq]:matt@example.com", limit: 1 },
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const people = (result.body as { data: { people: Array<{ emails: { primaryEmail: string } }> } }).data.people;
    expect(people).toHaveLength(1);
    expect(people[0].emails.primaryEmail).toBe("matt@example.com");
    // The captured upstream query carries the decoded field[op]:value form.
    const req = mock.matching("/rest/people").at(-1);
    expect(req?.query.filter).toBe("emails.primaryEmail[eq]:matt@example.com");
    expect(req?.query.filter).not.toContain("filter[");
  });

  it("TRAP 3 — custom fields come back inline on Person (no customFields wrapper)", async () => {
    const result = await call({
      operationId: "findManyPeople",
      query: { filter: "emails.primaryEmail[eq]:matt@example.com" },
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const person = (result.body as { data: { people: Array<Record<string, unknown>> } }).data.people[0];
    expect(person.atlasFirstSource).toBe("DEMO");
    expect(person.atlasLastSource).toBe("SIGNUP");
    expect(person).not.toHaveProperty("customFields");
  });

  it("forwards in:header parameters to the upstream", async () => {
    // The Twenty spec has no header params, so use a synthetic graph that
    // declares one on a GET — the tool must thread `header` into the client.
    const headerGraph = buildOperationGraph({
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      servers: [{ url: "https://ignored" }],
      paths: {
        "/people": {
          get: {
            operationId: "listWithHeader",
            security: [],
            parameters: [{ name: "X-Schema-Version", in: "header", required: true, schema: { type: "string" } }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const result = await call(
      { operationId: "listWithHeader", header: { "X-Schema-Version": "2024-01" } },
      async () => ({ id: "twenty", displayName: "Twenty", graph: headerGraph, baseUrl: mock.restBaseUrl, auth: { kind: "bearer", token: "test-token" }, representationMode: "operation-graph", writeAllowlist: new Set<string>(), sideEffectingOperations: new Set<string>() }),
    );
    expect(result.status).toBe("ok");
    const req = mock.matching("/rest/people").at(-1);
    expect(req?.headers["x-schema-version"]).toBe("2024-01");
  });

  it("substitutes path params for {id}-style operations", async () => {
    const result = await call({ operationId: "findOnePerson", pathParams: { id: "p-matt" } });
    expect(result.status).toBe("ok");
    const req = mock.matching("/rest/people/p-matt").at(-1);
    expect(req?.method).toBe("GET");
  });

  it("blocks NON-allowlisted writes (writes_disabled, default-deny)", async () => {
    // The default datasource has an empty write allowlist → every write is denied.
    for (const op of ["createOnePerson", "updateOnePerson", "deleteOnePerson", "createOneNote"]) {
      const result = await call({ operationId: op, pathParams: { id: "p-matt" }, body: { x: 1 } });
      expect(result.status, `${op} should be blocked`).toBe("writes_disabled");
    }
    // No write ever reached the upstream.
    expect(mock.requests.some((r) => r.method !== "GET")).toBe(false);
  });

  it("returns unknown_operation with the available list for a bad operationId", async () => {
    const result = await call({ operationId: "deleteEverything" });
    expect(result.status).toBe("unknown_operation");
    if (result.status !== "unknown_operation") return;
    expect(result.availableOperations).toContain("findManyPeople");
  });

  it("returns no_datasource when none is configured", async () => {
    const result = await call({ operationId: "findManyPeople" }, async () => null);
    expect(result.status).toBe("no_datasource");
  });

  it("returns datasource_unavailable (NOT no_datasource) when the registry load fails", async () => {
    // A DB outage loading the install registry must not be reported to the agent
    // as "no datasource connected" — that false claim would hide the outage.
    const result = await call({ operationId: "findManyPeople" }, async () => {
      throw new Error("pg down");
    });
    expect(result.status).toBe("datasource_unavailable");
  });

  it("surfaces an upstream 404 as http_error (not a throw)", async () => {
    const result = await call({ operationId: "findOnePerson", pathParams: { id: "does-not-exist" } });
    expect(result.status).toBe("http_error");
    if (result.status !== "http_error") return;
    expect(result.httpStatus).toBe(404);
  });
});

// ── Write-side opt-in (slice 5, #2929) ───────────────────────────────────────
// The agent stages writes; it never dispatches them. An allowlisted write comes
// back as `needs_confirmation` (the confirm-before-write banner fires it later);
// a non-allowlisted write is `writes_disabled`. The upstream sees no mutation.
describe("executeRestOperation — write-side opt-in", () => {
  it("stages an ALLOWLISTED write as needs_confirmation, never dispatching it", async () => {
    const ds = datasource({ writeAllowlist: new Set(["createOnePerson"]) });
    const result = await call(
      { operationId: "createOnePerson", body: { name: { firstName: "Ada" } } },
      async () => ds,
    );
    expect(result.status).toBe("needs_confirmation");
    if (result.status !== "needs_confirmation") return;
    expect(result.method).toBe("POST");
    expect(result.operationId).toBe("createOnePerson");
    expect(result.datasourceId).toBe("twenty");
    // The replay payload round-trips the agent's inputs for the confirm endpoint.
    expect(result.confirm.operationId).toBe("createOnePerson");
    expect(result.confirm.datasourceId).toBe("twenty");
    expect(result.confirm.body).toEqual({ name: { firstName: "Ada" } });
    // Critically: NO write reached the upstream — confirmation is still pending.
    expect(mock.requests.some((r) => r.method !== "GET")).toBe(false);
  });

  it("stages an allowlisted DELETE (highest blast radius) without firing it", async () => {
    const ds = datasource({ writeAllowlist: new Set(["deleteOnePerson"]) });
    const result = await call(
      { operationId: "deleteOnePerson", pathParams: { id: "p-matt" } },
      async () => ds,
    );
    expect(result.status).toBe("needs_confirmation");
    if (result.status !== "needs_confirmation") return;
    expect(result.method).toBe("DELETE");
    expect(result.confirm.pathParams).toEqual({ id: "p-matt" });
    expect(mock.requests.some((r) => r.method !== "GET")).toBe(false);
  });

  it("needs_confirmation carries exactly the fields the chat banner + confirm endpoint read", async () => {
    // Guards the web-local mirror (rest-operation-types.ts) against drift — if a
    // field is added/renamed here, this assertion flags the mirror needs updating.
    const ds = datasource({ writeAllowlist: new Set(["createOnePerson"]) });
    const result = await call({ operationId: "createOnePerson", body: { x: 1 } }, async () => ds);
    expect(result.status).toBe("needs_confirmation");
    if (result.status !== "needs_confirmation") return;
    expect(Object.keys(result).toSorted()).toEqual(
      ["confirm", "datasourceId", "datasourceName", "method", "operationId", "status", "summary"],
    );
    // #3007: the staged write carries a single-use confirm token the banner forwards.
    expect(typeof result.confirm.token).toBe("string");
    expect(result.confirm.token.length).toBeGreaterThan(0);
  });

  it("REFUSES to stage a write when no confirm-token signing key is configured (client_error, no dispatch)", async () => {
    // Fail-loud (#3007): without a signing key the confirm gate can't be enforced,
    // so the tool must NOT stage an unverifiable confirm — it returns client_error
    // and tells the agent not to claim the write ran.
    const ds = datasource({ writeAllowlist: new Set(["createOnePerson"]) });
    const saved = {
      keys: process.env.ATLAS_ENCRYPTION_KEYS,
      key: process.env.ATLAS_ENCRYPTION_KEY,
      auth: process.env.BETTER_AUTH_SECRET,
    };
    delete process.env.ATLAS_ENCRYPTION_KEYS;
    delete process.env.ATLAS_ENCRYPTION_KEY;
    delete process.env.BETTER_AUTH_SECRET;
    _resetEncryptionKeyCache();
    try {
      const result = await call(
        { operationId: "createOnePerson", body: { name: { firstName: "Ada" } } },
        async () => ds,
      );
      expect(result.status).toBe("client_error");
      // Never staged as needs_confirmation, and nothing dispatched upstream.
      expect(mock.requests.some((r) => r.method !== "GET")).toBe(false);
    } finally {
      if (saved.keys === undefined) delete process.env.ATLAS_ENCRYPTION_KEYS;
      else process.env.ATLAS_ENCRYPTION_KEYS = saved.keys;
      if (saved.key === undefined) delete process.env.ATLAS_ENCRYPTION_KEY;
      else process.env.ATLAS_ENCRYPTION_KEY = saved.key;
      if (saved.auth === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = saved.auth;
      _resetEncryptionKeyCache();
    }
  });

  it("blocks a write whose op is NOT in the allowlist even when others are", async () => {
    const ds = datasource({ writeAllowlist: new Set(["createOnePerson"]) });
    const result = await call(
      { operationId: "deleteOnePerson", pathParams: { id: "p-matt" } },
      async () => ds,
    );
    expect(result.status).toBe("writes_disabled");
    expect(mock.requests.some((r) => r.method !== "GET")).toBe(false);
  });

  it("rejects an allowlisted write missing its required body (invalid_params)", async () => {
    const ds = datasource({ writeAllowlist: new Set(["createOnePerson"]) });
    const result = await call({ operationId: "createOnePerson" }, async () => ds);
    expect(result.status).toBe("invalid_params");
    if (result.status !== "invalid_params") return;
    expect(result.missingParams).toContain("body");
    expect(mock.requests.some((r) => r.method !== "GET")).toBe(false);
  });

  it("rate-limits reads per operation (rate_limited) once the bucket is empty", async () => {
    const ds = datasource({ rateLimitPerMinute: 1 });
    const first = await call({ operationId: "findManyPeople" }, async () => ds);
    expect(first.status).toBe("ok");
    const second = await call({ operationId: "findManyPeople" }, async () => ds);
    expect(second.status).toBe("rate_limited");
    if (second.status !== "rate_limited") return;
    expect(second.retryAfterMs).toBeGreaterThan(0);
  });

  it("stages a config-flagged side-effecting GET as needs_confirmation, never dispatching it (#3008)", async () => {
    // A GET the install marks side-effecting is treated exactly like a write: it
    // stages with dispatch:false, so it never hits the upstream and never burns the
    // per-operation quota at stage time (the same GET runs as a plain read sans flag).
    const ds = datasource({
      writeAllowlist: new Set(["findManyPeople"]),
      sideEffectingOperations: new Set(["findManyPeople"]),
    });
    const result = await call({ operationId: "findManyPeople" }, async () => ds);
    expect(result.status).toBe("needs_confirmation");
    if (result.status !== "needs_confirmation") return;
    expect(result.method).toBe("GET");
    expect(result.operationId).toBe("findManyPeople");
    // dispatch:false — the flagged GET did NOT reach the upstream (quota untouched).
    expect(mock.requests).toHaveLength(0);
  });

  it("blocks a config-flagged side-effecting GET that is NOT allowlisted (writes_disabled, #3008)", async () => {
    const ds = datasource({ sideEffectingOperations: new Set(["findManyPeople"]) });
    const result = await call({ operationId: "findManyPeople" }, async () => ds);
    expect(result.status).toBe("writes_disabled");
    if (result.status !== "writes_disabled") return;
    expect(result.method).toBe("GET");
    expect(mock.requests).toHaveLength(0);
  });
});

// ── Multi-datasource routing (slice 2, #2926) ────────────────────────────────
// The agent-facing disambiguation when a workspace has more than one REST
// datasource. `widgets` is a non-live mock (never executed in these cases — we
// only assert which datasource is picked / which error branch fires).
describe("executeRestOperation — multi-datasource routing", () => {
  /** Invoke with the slice-2 multi-datasource resolver seam. */
  async function callMany(
    input: Record<string, unknown>,
    datasources: RestDatasource[],
  ): Promise<ExecuteRestOperationResult> {
    const t = createExecuteRestOperationTool({ resolveDatasources: async () => datasources });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ToolCallOptions stub
    return (await t.execute!(input as any, { toolCallId: "t1", messages: [] } as any)) as ExecuteRestOperationResult;
  }

  const widgets = () => createOpenApiDatasourceMock({ id: "widgets", displayName: "Widgets" });

  it("routes to the datasource named by datasourceId (not datasources[0])", async () => {
    // widgets is first, but the call names twenty → executes against the live
    // twenty mock, proving id-routing rather than first-wins.
    const result = await callMany(
      { operationId: "findManyPeople", datasourceId: "twenty" },
      [widgets(), datasource()],
    );
    expect(result.status).toBe("ok");
    expect(mock.matching("/rest/people").length).toBeGreaterThan(0);
  });

  it("returns datasource_not_found + availableDatasources for an unknown datasourceId", async () => {
    const result = await callMany(
      { operationId: "findManyPeople", datasourceId: "ghost" },
      [datasource(), widgets()],
    );
    expect(result.status).toBe("datasource_not_found");
    if (result.status !== "datasource_not_found") return;
    expect(result.availableDatasources).toEqual(["twenty", "widgets"]);
    expect(mock.requests).toHaveLength(0); // nothing dispatched
  });

  it("requires datasourceId when more than one datasource is connected", async () => {
    const result = await callMany({ operationId: "findManyPeople" }, [datasource(), widgets()]);
    expect(result.status).toBe("datasource_not_found");
    if (result.status !== "datasource_not_found") return;
    expect(result.message).toContain("More than one");
    expect(result.availableDatasources).toEqual(["twenty", "widgets"]);
    expect(mock.requests).toHaveLength(0); // never silently picks the first
  });

  it("resolves the sole datasource without a datasourceId (single-install shape)", async () => {
    const result = await callMany({ operationId: "findManyPeople" }, [datasource()]);
    expect(result.status).toBe("ok");
  });

  it("returns no_datasource when the workspace has none installed", async () => {
    const result = await callMany({ operationId: "findManyPeople" }, []);
    expect(result.status).toBe("no_datasource");
  });
});
