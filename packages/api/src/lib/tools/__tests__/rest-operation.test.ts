import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";

import { buildOperationGraph } from "@atlas/api/lib/openapi/spec";
import type { RestDatasource } from "@atlas/api/lib/openapi/datasource";
import {
  createExecuteRestOperationTool,
  type ExecuteRestOperationResult,
} from "../rest-operation";
import {
  startTwentyMockServer,
  type TwentyMock,
} from "@atlas/api/lib/openapi/__tests__/twenty-acceptance/mock-server";

const SPEC = JSON.parse(
  fs.readFileSync(
    path.join(import.meta.dir, "..", "..", "openapi", "__tests__", "twenty-acceptance", "spec.json"),
    "utf8",
  ),
);
const graph = buildOperationGraph(SPEC);

let mock: TwentyMock;

beforeAll(async () => {
  mock = await startTwentyMockServer();
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => mock.reset());

function datasource(): RestDatasource {
  return {
    id: "twenty",
    displayName: "Twenty",
    graph,
    baseUrl: mock.restBaseUrl,
    auth: { kind: "bearer", token: "test-token" },
    representationMode: "operation-graph",
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
      async () => ({ id: "twenty", displayName: "Twenty", graph: headerGraph, baseUrl: mock.restBaseUrl, auth: { kind: "bearer", token: "test-token" }, representationMode: "operation-graph" }),
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

  it("blocks write operations (read-only until slice 5)", async () => {
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

  it("surfaces an upstream 404 as http_error (not a throw)", async () => {
    const result = await call({ operationId: "findOnePerson", pathParams: { id: "does-not-exist" } });
    expect(result.status).toBe("http_error");
    if (result.status !== "http_error") return;
    expect(result.httpStatus).toBe(404);
  });
});
