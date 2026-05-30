/**
 * Route tests for POST /api/v1/rest-operations/confirm — the confirm-before-write
 * execution point (PRD #2868 slice 5, #2929).
 *
 * Mirrors validate-sql.test.ts's isolation: a minimal Hono app with only this
 * route mounted, the auth middleware mocked to an authenticated workspace user,
 * and the datasource resolver injected via the route factory (no DB) pointing at
 * the live Twenty mock server (real executeOperation path).
 *
 * The security contract under test: the endpoint is NOT a trusted fast-path — it
 * re-runs validateRestOperation, so a confirm payload for a non-allowlisted op is
 * refused with 403 and no upstream write fires.
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
import type { AuthResult } from "@atlas/api/lib/auth/types";

// --- Mocks (mirrors validate-sql.test.ts) ---

const mockAuthenticateRequest: Mock<(req: Request) => Promise<AuthResult>> = mock(() =>
  Promise.resolve({
    authenticated: true as const,
    mode: "session" as const,
    user: {
      id: "u-1",
      email: "ada@example.com",
      role: "admin",
      activeOrganizationId: "ws-1",
      mode: "session",
    },
  } as unknown as AuthResult),
);

const mockCheckRateLimit: Mock<(key: string) => { allowed: boolean; retryAfterMs?: number }> = mock(
  () => ({ allowed: true }),
);
const mockGetClientIP: Mock<(req: Request) => string | null> = mock(() => null);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mockCheckRateLimit,
  getClientIP: mockGetClientIP,
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getRequestContext: () => null,
}));

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "session",
  resetAuthModeCache: () => {},
}));

// Import after mocks.
const { Hono } = await import("hono");
const { buildOperationGraph } = await import("@atlas/api/lib/openapi/spec");
const { createRestOperationsRoute } = await import("../rest-operations");
const { _resetRestRateLimits } = await import("@atlas/api/lib/openapi/validate-rest-operation");
const { startTwentyMockServer } = await import(
  "@atlas/api/lib/openapi/__tests__/twenty-acceptance/mock-server"
);
import type { RestDatasource } from "@atlas/api/lib/openapi/datasource";
import type { TwentyMock } from "@atlas/api/lib/openapi/__tests__/twenty-acceptance/mock-server";

const SPEC = JSON.parse(
  fs.readFileSync(
    path.join(import.meta.dir, "..", "..", "..", "lib", "openapi", "__tests__", "twenty-acceptance", "spec.json"),
    "utf8",
  ),
);
const graph = buildOperationGraph(SPEC);

let twentyMock: TwentyMock;

beforeAll(async () => {
  twentyMock = await startTwentyMockServer();
});
afterAll(async () => {
  await twentyMock.close();
});
beforeEach(() => {
  twentyMock.reset();
  _resetRestRateLimits();
});

/** A workspace-resolved Twenty datasource with a configurable write allowlist. */
function datasource(overrides: Partial<RestDatasource> = {}): RestDatasource {
  return {
    id: "twenty",
    displayName: "Twenty",
    graph,
    baseUrl: twentyMock.restBaseUrl,
    auth: { kind: "bearer", token: "confirm-token" },
    representationMode: "operation-graph",
    writeAllowlist: new Set<string>(),
    sideEffectingOperations: new Set<string>(),
    ...overrides,
  };
}

/** Mount the route with an injected resolver returning `datasources` for ws-1. */
function appWith(datasources: RestDatasource[]) {
  return appWithResolver(async (workspaceId: string) => (workspaceId === "ws-1" ? datasources : []));
}

/** Mount the route with an arbitrary resolver (e.g. one that throws). */
function appWithResolver(resolveDatasources: (workspaceId: string) => Promise<RestDatasource[]>) {
  const route = createRestOperationsRoute({ resolveDatasources });
  const app = new Hono();
  app.route("/api/v1/rest-operations", route);
  return app;
}

async function post(app: ReturnType<typeof appWith>, body: unknown): Promise<Response> {
  return app.request("/api/v1/rest-operations/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /rest-operations/confirm", () => {
  it("executes a confirmed, ALLOWLISTED write and dispatches it upstream", async () => {
    const app = appWith([datasource({ writeAllowlist: new Set(["createOnePerson"]) })]);
    const res = await post(app, {
      datasourceId: "twenty",
      operationId: "createOnePerson",
      body: { name: { firstName: "Ada" } },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string; httpStatus: number; body: unknown };
    expect(json.status).toBe("executed");
    expect(json.httpStatus).toBe(201);
    // The POST really reached the upstream, carrying the bearer + body.
    const req = twentyMock.matching("/rest/people").at(-1);
    expect(req?.method).toBe("POST");
    expect(req?.headers["authorization"]).toBe("Bearer confirm-token");
  });

  it("REFUSES a write that is NOT allowlisted, even on the confirm path (403, no upstream write)", async () => {
    // Defense in depth: the banner should never let an op past the allowlist,
    // but a tampered client payload is re-checked server-side.
    const app = appWith([datasource({ writeAllowlist: new Set(["createOnePerson"]) })]);
    const res = await post(app, {
      datasourceId: "twenty",
      operationId: "deleteOnePerson",
      pathParams: { id: "p-matt" },
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("writes_disabled");
    expect(twentyMock.requests.some((r) => r.method !== "GET")).toBe(false);
  });

  it("re-gates a CONFIG-flagged side-effecting GET on the confirm replay (the bypass this closes, #3008)", async () => {
    // A direct confirm POST for a GET the install config marks side-effecting must
    // still hit the write allowlist. The config flag does NOT live on the graph
    // (unlike the x-atlas-side-effecting spec extension), so the route has to thread
    // `sideEffectingOperations` onto the policy itself. Drop that wiring and this GET
    // slips through as an unconfirmed read — this test is the regression guard.
    const app = appWith([datasource({ sideEffectingOperations: new Set(["findManyPeople"]) })]);
    const res = await post(app, { datasourceId: "twenty", operationId: "findManyPeople" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("writes_disabled");
    // Rejected before dispatch — nothing reached the upstream.
    expect(twentyMock.requests.length).toBe(0);
  });

  it("dispatches an ALLOWLISTED config-flagged side-effecting GET on confirm (#3008)", async () => {
    // The re-gate must not over-block: once the side-effecting GET is allowlisted,
    // a confirm replay dispatches it upstream like any other confirmed write.
    const app = appWith([
      datasource({
        writeAllowlist: new Set(["findManyPeople"]),
        sideEffectingOperations: new Set(["findManyPeople"]),
      }),
    ]);
    const res = await post(app, { datasourceId: "twenty", operationId: "findManyPeople" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("executed");
    // The GET really reached the upstream (the re-gate allowed it through).
    expect(twentyMock.matching("/rest/people").at(-1)?.method).toBe("GET");
  });

  it("500s (datasource_unavailable) when the registry load fails — not a misleading 404", async () => {
    // A DB outage resolving the workspace's installs must surface as a correlated
    // 500, not a 404 "datasource_not_found" (which would imply the id is wrong).
    const app = appWithResolver(async () => {
      throw new Error("pg down");
    });
    const res = await post(app, { datasourceId: "twenty", operationId: "createOnePerson", body: {} });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("datasource_unavailable");
    // Nothing reached the upstream — the failure is before dispatch.
    expect(twentyMock.requests.length).toBe(0);
  });

  it("404s an unknown datasource", async () => {
    const app = appWith([datasource({ writeAllowlist: new Set(["createOnePerson"]) })]);
    const res = await post(app, { datasourceId: "ghost", operationId: "createOnePerson", body: {} });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("datasource_not_found");
  });

  it("404s an unknown operation", async () => {
    const app = appWith([datasource({ writeAllowlist: new Set(["createOnePerson"]) })]);
    const res = await post(app, { datasourceId: "twenty", operationId: "nukeEverything", body: {} });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("unknown_operation");
  });

  it("422s an allowlisted write missing its required body", async () => {
    const app = appWith([datasource({ writeAllowlist: new Set(["createOnePerson"]) })]);
    const res = await post(app, { datasourceId: "twenty", operationId: "createOnePerson" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_params");
    expect(twentyMock.requests.some((r) => r.method !== "GET")).toBe(false);
  });

  it("429s once the per-operation rate quota is exhausted", async () => {
    const app = appWith([
      datasource({ writeAllowlist: new Set(["createOnePerson"]), rateLimitPerMinute: 1 }),
    ]);
    const first = await post(app, { datasourceId: "twenty", operationId: "createOnePerson", body: { name: { firstName: "A" } } });
    expect(first.status).toBe(200);
    const second = await post(app, { datasourceId: "twenty", operationId: "createOnePerson", body: { name: { firstName: "B" } } });
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).not.toBeNull();
  });

  it("500s (timeout_misconfigured) when the per-install timeout exceeds the cap", async () => {
    // request_timeout_ms above ATLAS_OPENAPI_TIMEOUT (default 30s) is rejected by
    // validateRestOperation layer 5 — surfaced as a 500 with a requestId.
    const app = appWith([
      datasource({ writeAllowlist: new Set(["createOnePerson"]), requestTimeoutMs: 120_000 }),
    ]);
    const res = await post(app, { datasourceId: "twenty", operationId: "createOnePerson", body: {} });
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string; requestId?: string };
    expect(json.error).toBe("timeout_misconfigured");
    // No write fired — the misconfig is caught before dispatch.
    expect(twentyMock.requests.some((r) => r.method !== "GET")).toBe(false);
  });

  it("never caches a write — a second identical confirm re-hits the upstream", async () => {
    const app = appWith([datasource({ writeAllowlist: new Set(["createOnePerson"]) })]);
    const body = { datasourceId: "twenty", operationId: "createOnePerson", body: { name: { firstName: "Ada" } } };
    expect((await post(app, body)).status).toBe(200);
    expect((await post(app, body)).status).toBe(200);
    // Two confirms ⇒ two POSTs reached the upstream (a cache would have served the 2nd).
    const writes = twentyMock.matching("/rest/people").filter((r) => r.method === "POST");
    expect(writes.length).toBe(2);
  });

  it("422s an invalid JSON body", async () => {
    const app = appWith([datasource()]);
    const res = await app.request("/api/v1/rest-operations/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });
    // Hono rejects unparseable JSON before the handler — normalized envelope.
    expect([400, 422]).toContain(res.status);
  });
});
