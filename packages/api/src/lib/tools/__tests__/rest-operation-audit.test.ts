/**
 * Audit-coverage tests for the `executeRestOperation` tool.
 *
 * The gap this closes: `executeSQL` records every execution to the query audit
 * log, but the REST path recorded only `log.info` breadcrumbs — so a reviewer
 * asking "what did the agent do against customer datasources" saw SQL and was
 * blind to REST. These pin that a DISPATCHED REST operation now lands in the
 * audit log (mapped into the SQL-shaped `AuditEntry` with a `${method}
 * ${operationId}` descriptor), while a PRE-dispatch rejection does not.
 *
 * `logQueryAudit` is mocked (all exports) and dynamically imported before the
 * tool, so the assertions are on the exact entry the tool hands it.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  mock,
  type Mock,
} from "bun:test";
import * as fs from "fs";
import * as path from "path";
import type { RestDatasource } from "@atlas/api/lib/openapi/datasource";
import type { AuditEntry } from "@atlas/api/lib/auth/audit";
import type { ExecuteRestOperationResult } from "../rest-operation";
import type { TwentyMock } from "@atlas/api/lib/openapi/__tests__/twenty-acceptance/mock-server";

const mockLogQueryAudit: Mock<(entry: AuditEntry) => void> = mock(() => {});
void mock.module("@atlas/api/lib/auth/audit", () => ({ logQueryAudit: mockLogQueryAudit }));

// Import after the mock so the tool's audit call resolves to the spy.
const { buildOperationGraph } = await import("@atlas/api/lib/openapi/spec");
const { createExecuteRestOperationTool } = await import("../rest-operation");
const { _resetRestRateLimits } = await import("@atlas/api/lib/openapi/validate-rest-operation");
const { startTwentyMockServer } = await import(
  "@atlas/api/lib/openapi/__tests__/twenty-acceptance/mock-server"
);

const SPEC = JSON.parse(
  fs.readFileSync(
    path.join(import.meta.dir, "..", "..", "openapi", "__tests__", "twenty-acceptance", "spec.json"),
    "utf8",
  ),
);
const graph = buildOperationGraph(SPEC);

let twentyMock: TwentyMock;

const ORIGINAL_EGRESS_FLAG = process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
const ORIGINAL_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;

beforeAll(async () => {
  process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS = "true";
  process.env.BETTER_AUTH_SECRET = "test-confirm-token-signing-secret-not-a-real-key";
  twentyMock = await startTwentyMockServer();
});
afterAll(async () => {
  if (ORIGINAL_EGRESS_FLAG === undefined) delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
  else process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS = ORIGINAL_EGRESS_FLAG;
  if (ORIGINAL_AUTH_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = ORIGINAL_AUTH_SECRET;
  await twentyMock.close();
});
beforeEach(() => {
  twentyMock.reset();
  _resetRestRateLimits();
  mockLogQueryAudit.mockClear();
});

function datasource(overrides: Partial<RestDatasource> = {}): RestDatasource {
  return {
    id: "twenty",
    displayName: "Twenty",
    graph,
    baseUrl: twentyMock.restBaseUrl,
    auth: { kind: "bearer", token: "test-token" },
    representationMode: "operation-graph",
    writeAllowlist: new Set<string>(),
    sideEffectingOperations: new Set<string>(),
    ...overrides,
  };
}

async function call(
  input: Record<string, unknown>,
  resolve: () => Promise<RestDatasource | null> = async () => datasource(),
): Promise<ExecuteRestOperationResult> {
  const t = createExecuteRestOperationTool({ resolveDatasource: resolve });
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- ToolCallOptions stub for a unit invocation
  return (await t.execute!(input as any, { toolCallId: "t1", messages: [] } as any)) as ExecuteRestOperationResult;
}

describe("executeRestOperation — query-audit coverage", () => {
  it("audits a dispatched GET read once with success:true, the `${method} ${operationId}` sql, and sourceId", async () => {
    const result = await call({ operationId: "findManyPeople" });
    expect(result.status).toBe("ok");

    expect(mockLogQueryAudit).toHaveBeenCalledTimes(1);
    const entry = mockLogQueryAudit.mock.calls[0][0];
    expect(entry.success).toBe(true);
    expect(entry.sql).toBe("GET findManyPeople");
    expect(entry.sourceId).toBe("twenty");
    // sourceType is a SQL DBType — a REST op must leave it unset.
    expect(entry.sourceType).toBeUndefined();
    // targetHost is the upstream host (the loopback mock).
    expect(entry.targetHost).toBe(new URL(twentyMock.restBaseUrl).host);
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("audits an upstream http_error with success:false and the error message", async () => {
    const result = await call({ operationId: "findOnePerson", pathParams: { id: "does-not-exist" } });
    expect(result.status).toBe("http_error");

    expect(mockLogQueryAudit).toHaveBeenCalledTimes(1);
    const entry = mockLogQueryAudit.mock.calls[0][0];
    expect(entry.success).toBe(false);
    expect(entry.sql).toBe("GET findOnePerson");
    if (entry.success) return; // narrow to the failure variant
    expect(entry.error).toContain("HTTP 404");
    expect(entry.rowCount).toBeNull();
  });

  it("does NOT audit a PRE-dispatch rejection (invalid_params never touched the datasource)", async () => {
    const ds = datasource({ writeAllowlist: new Set(["createOnePerson"]) });
    const result = await call({ operationId: "createOnePerson" }, async () => ds);
    expect(result.status).toBe("invalid_params");

    // The op was rejected before dispatch — nothing reached the upstream, nothing audited.
    expect(twentyMock.requests).toHaveLength(0);
    expect(mockLogQueryAudit).not.toHaveBeenCalled();
  });

  it("does NOT audit a staged write (needs_confirmation) — the CONFIRMED execution is audited by the route", async () => {
    const ds = datasource({ writeAllowlist: new Set(["createOnePerson"]) });
    const result = await call(
      { operationId: "createOnePerson", body: { name: { firstName: "Ada" } } },
      async () => ds,
    );
    expect(result.status).toBe("needs_confirmation");
    expect(twentyMock.requests.some((r) => r.method !== "GET")).toBe(false);
    expect(mockLogQueryAudit).not.toHaveBeenCalled();
  });
});
