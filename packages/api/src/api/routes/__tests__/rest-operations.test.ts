/**
 * Route tests for POST /api/v1/rest-operations/confirm — the confirm-before-write
 * execution point (PRD #2868 slice 5, #2929; single-use token gate #3007).
 *
 * Mirrors validate-sql.test.ts's isolation: a minimal Hono app with only this
 * route mounted, the auth middleware mocked to an authenticated workspace user,
 * and the datasource resolver injected via the route factory (no DB) pointing at
 * the live Twenty mock server (real executeOperation path).
 *
 * The security contract under test (#3007 — Path A, enforce):
 *   - The endpoint is NOT a trusted fast-path — it re-runs validateRestOperation,
 *     so a confirm payload for a non-allowlisted op is refused with 403 and no
 *     upstream write fires.
 *   - The staged write carries a server-signed, single-use confirm token binding
 *     (workspace, datasource, operation, canonical params, nonce, exp). The
 *     endpoint requires it, verifies it matches THIS re-resolved request, and
 *     BURNS the nonce — so a missing / tampered / expired / replayed token is
 *     rejected and the human-in-the-loop guarantee is server-verifiable.
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
import type { RestWriteConfirmRequest } from "@atlas/api/lib/openapi/rest-write-confirm";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/encryption-keys";

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
const { mintRestConfirmToken, confirmRequestToParams, _resetRestConfirmNonces } = await import(
  "@atlas/api/lib/openapi/rest-write-confirm"
);
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

// The mock REST server binds to 127.0.0.1 (loopback), which the #3006 SSRF guard
// blocks by default. A local test server is the "internal service" case the
// operator opt-out exists for — enable it for this file and restore it after.
const ORIGINAL_EGRESS_FLAG = process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
// The confirm token (#3007) is HMAC-signed with the resolved encryption keyset.
// Set a signing secret so mint/verify use a real key — restored after.
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
  _resetRestConfirmNonces();
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

type ConfirmInput = {
  datasourceId: string;
  operationId: string;
  pathParams?: Record<string, string | number | boolean>;
  query?: Record<string, string | number | boolean | Array<string | number | boolean>>;
  header?: Record<string, string | number | boolean>;
  body?: unknown;
};

/**
 * Build a confirm POST body with a freshly-minted, binding-matching token for the
 * authenticated workspace (ws-1) — the realistic staged-write shape. Pass
 * `opts.token` to substitute a tampered / foreign / pre-minted token; pass
 * `opts.omitToken` to drop it entirely (missing-token rejection).
 */
function confirmBody(
  input: ConfirmInput,
  opts: { token?: string; omitToken?: boolean } = {},
): Record<string, unknown> {
  if (opts.omitToken) return { ...input };
  const params = confirmRequestToParams(input as RestWriteConfirmRequest);
  const token =
    opts.token ??
    mintRestConfirmToken({
      workspaceId: "ws-1",
      datasourceId: input.datasourceId,
      operationId: input.operationId,
      params,
    });
  return { ...input, token };
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
    const res = await post(
      app,
      confirmBody({
        datasourceId: "twenty",
        operationId: "createOnePerson",
        body: { name: { firstName: "Ada" } },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string; httpStatus: number; body: unknown };
    expect(json.status).toBe("executed");
    expect(json.httpStatus).toBe(201);
    // The POST really reached the upstream, carrying the bearer + body.
    const req = twentyMock.matching("/rest/people").at(-1);
    expect(req?.method).toBe("POST");
    expect(req?.headers["authorization"]).toBe("Bearer confirm-token");
  });

  it("forwards the datasource quirk so required headers ride the confirmed write (#3029)", async () => {
    // A data-candidate (e.g. Notion) carries a declarative quirk — required static
    // headers / query shaping — applied via the client's header/query seams. The
    // confirm path must forward it exactly like the read tool path; otherwise an
    // allowlisted, human-confirmed write reaches the upstream WITHOUT the required
    // header (Notion-Version) and the vendor rejects it. Regression guard for the
    // confirm-path/read-path parity gap.
    const app = appWith([
      datasource({
        writeAllowlist: new Set(["createOnePerson"]),
        quirk: { requiredHeaders: { "X-Vendor-Version": "2025-09-03" } },
      }),
    ]);
    const res = await post(
      app,
      confirmBody({
        datasourceId: "twenty",
        operationId: "createOnePerson",
        body: { name: { firstName: "Ada" } },
      }),
    );
    expect(res.status).toBe(200);
    const req = twentyMock.matching("/rest/people").at(-1);
    // The quirk's required header rode the confirmed write, alongside bearer auth.
    expect(req?.headers["x-vendor-version"]).toBe("2025-09-03");
    expect(req?.headers["authorization"]).toBe("Bearer confirm-token");
  });

  it("REFUSES a write that is NOT allowlisted, even on the confirm path (403, no upstream write)", async () => {
    // Defense in depth: the banner should never let an op past the allowlist,
    // but a tampered client payload is re-checked server-side.
    const app = appWith([datasource({ writeAllowlist: new Set(["createOnePerson"]) })]);
    const res = await post(
      app,
      confirmBody({ datasourceId: "twenty", operationId: "deleteOnePerson", pathParams: { id: "p-matt" } }),
    );
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
    const res = await post(app, confirmBody({ datasourceId: "twenty", operationId: "findManyPeople" }));
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
    const res = await post(app, confirmBody({ datasourceId: "twenty", operationId: "findManyPeople" }));
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
    const res = await post(app, confirmBody({ datasourceId: "twenty", operationId: "createOnePerson", body: {} }));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("datasource_unavailable");
    // Nothing reached the upstream — the failure is before dispatch.
    expect(twentyMock.requests.length).toBe(0);
  });

  it("404s an unknown datasource", async () => {
    const app = appWith([datasource({ writeAllowlist: new Set(["createOnePerson"]) })]);
    const res = await post(app, confirmBody({ datasourceId: "ghost", operationId: "createOnePerson", body: {} }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("datasource_not_found");
  });

  it("404s an unknown operation", async () => {
    const app = appWith([datasource({ writeAllowlist: new Set(["createOnePerson"]) })]);
    const res = await post(app, confirmBody({ datasourceId: "twenty", operationId: "nukeEverything", body: {} }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("unknown_operation");
  });

  it("422s an allowlisted write missing its required body", async () => {
    const app = appWith([datasource({ writeAllowlist: new Set(["createOnePerson"]) })]);
    const res = await post(app, confirmBody({ datasourceId: "twenty", operationId: "createOnePerson" }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_params");
    expect(twentyMock.requests.some((r) => r.method !== "GET")).toBe(false);
  });

  it("429s once the per-operation rate quota is exhausted", async () => {
    const app = appWith([
      datasource({ writeAllowlist: new Set(["createOnePerson"]), rateLimitPerMinute: 1 }),
    ]);
    const first = await post(
      app,
      confirmBody({ datasourceId: "twenty", operationId: "createOnePerson", body: { name: { firstName: "A" } } }),
    );
    expect(first.status).toBe(200);
    const second = await post(
      app,
      confirmBody({ datasourceId: "twenty", operationId: "createOnePerson", body: { name: { firstName: "B" } } }),
    );
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).not.toBeNull();
  });

  it("500s (timeout_misconfigured) when the per-install timeout exceeds the cap", async () => {
    // request_timeout_ms above ATLAS_OPENAPI_TIMEOUT (default 30s) is rejected by
    // validateRestOperation layer 5 — surfaced as a 500 with a requestId.
    const app = appWith([
      datasource({ writeAllowlist: new Set(["createOnePerson"]), requestTimeoutMs: 120_000 }),
    ]);
    const res = await post(app, confirmBody({ datasourceId: "twenty", operationId: "createOnePerson", body: {} }));
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string; requestId?: string };
    expect(json.error).toBe("timeout_misconfigured");
    // No write fired — the misconfig is caught before dispatch.
    expect(twentyMock.requests.some((r) => r.method !== "GET")).toBe(false);
  });

  it("never caches a write — two SEPARATE confirmations both re-hit the upstream", async () => {
    // Each staged write mints its own single-use token (distinct nonces), so two
    // legitimate confirmations both dispatch. (Replaying the SAME token is rejected
    // — that's the single-use test below; this one proves writes aren't cached.)
    const app = appWith([datasource({ writeAllowlist: new Set(["createOnePerson"]) })]);
    const make = () =>
      confirmBody({ datasourceId: "twenty", operationId: "createOnePerson", body: { name: { firstName: "Ada" } } });
    expect((await post(app, make())).status).toBe(200);
    expect((await post(app, make())).status).toBe(200);
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

// ── Single-use confirm token gate (#3007 — Path A, enforce) ──────────────────
// The confirm endpoint is a server-verifiable single-use gate, not stateless UX:
// the staged write's token binds (workspace, datasource, operation, params, nonce,
// exp); a missing / tampered / expired / replayed token never reaches the upstream.
describe("POST /rest-operations/confirm — single-use token gate (#3007)", () => {
  it("REJECTS a confirm POST with no token (the request shape requires one)", async () => {
    const app = appWith([datasource({ writeAllowlist: new Set(["createOnePerson"]) })]);
    const res = await post(
      app,
      confirmBody(
        { datasourceId: "twenty", operationId: "createOnePerson", body: { name: { firstName: "Ada" } } },
        { omitToken: true },
      ),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("validation_error");
    // No write fired.
    expect(twentyMock.requests.some((r) => r.method !== "GET")).toBe(false);
  });

  it("REJECTS a TAMPERED payload — params mutated after staging fail the binding (400, no write)", async () => {
    // Token minted for { firstName: "Ada" }; the client then swaps in a different
    // body. The token binds the canonical params, so the swap fails verification.
    const app = appWith([datasource({ writeAllowlist: new Set(["createOnePerson"]) })]);
    const token = mintRestConfirmToken({
      workspaceId: "ws-1",
      datasourceId: "twenty",
      operationId: "createOnePerson",
      params: confirmRequestToParams({
        datasourceId: "twenty",
        operationId: "createOnePerson",
        body: { name: { firstName: "Ada" } },
      } as RestWriteConfirmRequest),
    });
    const res = await post(app, {
      datasourceId: "twenty",
      operationId: "createOnePerson",
      body: { name: { firstName: "Mallory" } }, // tampered after staging
      token,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("confirm_token_invalid");
    expect(twentyMock.requests.some((r) => r.method !== "GET")).toBe(false);
  });

  it("REJECTS a token with a tampered signature (400, no write)", async () => {
    const app = appWith([datasource({ writeAllowlist: new Set(["createOnePerson"]) })]);
    const good = mintRestConfirmToken({
      workspaceId: "ws-1",
      datasourceId: "twenty",
      operationId: "createOnePerson",
      params: confirmRequestToParams({
        datasourceId: "twenty",
        operationId: "createOnePerson",
        body: {},
      } as RestWriteConfirmRequest),
    });
    // Tamper at the BYTE level so the decoded signature is guaranteed to differ.
    // (Flipping the last base64url char can be a no-op: the final char of a 32-byte
    // sig carries unused low bits, so e.g. "A"↔"B" can decode to the SAME bytes.)
    const segs = good.split(".");
    const sig = Buffer.from(segs[2], "base64url");
    sig[0] ^= 0xff;
    segs[2] = sig.toString("base64url");
    const res = await post(app, {
      datasourceId: "twenty",
      operationId: "createOnePerson",
      body: {},
      token: segs.join("."),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("confirm_token_invalid");
    expect(twentyMock.requests.some((r) => r.method !== "GET")).toBe(false);
  });

  it("REJECTS an EXPIRED token (400, no write)", async () => {
    const app = appWith([datasource({ writeAllowlist: new Set(["createOnePerson"]) })]);
    // Mint with a far-past clock so the token is already expired by real now.
    const expired = mintRestConfirmToken(
      {
        workspaceId: "ws-1",
        datasourceId: "twenty",
        operationId: "createOnePerson",
        params: confirmRequestToParams({
          datasourceId: "twenty",
          operationId: "createOnePerson",
          body: {},
        } as RestWriteConfirmRequest),
      },
      { nowSeconds: 1_000, ttlSeconds: 60 }, // exp = 1060 (1970) — long past
    );
    const res = await post(app, { datasourceId: "twenty", operationId: "createOnePerson", body: {}, token: expired });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("confirm_token_invalid");
    expect(twentyMock.requests.some((r) => r.method !== "GET")).toBe(false);
  });

  it("REJECTS a REPLAYED token — single-use: first fires, second is refused (one upstream write)", async () => {
    const app = appWith([datasource({ writeAllowlist: new Set(["createOnePerson"]) })]);
    const body = confirmBody({
      datasourceId: "twenty",
      operationId: "createOnePerson",
      body: { name: { firstName: "Ada" } },
    });
    const first = await post(app, body);
    expect(first.status).toBe(200);
    expect(((await first.json()) as { status: string }).status).toBe("executed");
    // Same token, second time — the nonce is burned.
    const second = await post(app, body);
    expect(second.status).toBe(400);
    expect(((await second.json()) as { error: string }).error).toBe("confirm_token_invalid");
    // Exactly ONE write reached the upstream.
    const writes = twentyMock.matching("/rest/people").filter((r) => r.method === "POST");
    expect(writes.length).toBe(1);
  });

  it("REJECTS a read driven through the write-only confirm endpoint (400, no dispatch)", async () => {
    // A valid token can be minted for any binding; the endpoint still refuses a
    // non-write — verdict.requiresConfirmation must hold. A plain GET is a read.
    const app = appWith([datasource()]);
    const res = await post(app, confirmBody({ datasourceId: "twenty", operationId: "findManyPeople" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("not_a_write");
    // Nothing dispatched — the read was refused before any upstream call.
    expect(twentyMock.requests.length).toBe(0);
  });

  it("REJECTS a candidate-declared read-safe POST through the confirm endpoint (400, no dispatch) (#3035)", async () => {
    // A demoted read-safe POST reaches `not_a_write` through a DIFFERENT validator
    // branch than the GET above (the #3035 demotion, not the GET=read default), so
    // it needs its own guard: the route MUST thread `readSafePostOperations` into
    // the confirm policy. If that threading regressed, this POST would classify as a
    // write and a minted token could fire it as a confirmed mutation. The Twenty
    // mock has no read-over-POST, so `createOnePerson` exercises the mechanism (the
    // realistic notion-data `post-search` case is covered by the candidate/resolver/
    // validator tests). With an EMPTY write allowlist it is demoted, never gated.
    const app = appWith([datasource({ readSafePostOperations: new Set(["createOnePerson"]) })]);
    const res = await post(
      app,
      confirmBody({
        datasourceId: "twenty",
        operationId: "createOnePerson",
        body: { name: { firstName: "Ada" } },
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("not_a_write");
    // The demoted read was refused BEFORE any upstream call — never fired as a write.
    expect(twentyMock.requests.length).toBe(0);
  });

  it("is single-use under CONCURRENCY — two simultaneous replays yield one 200 + one 400, one write", async () => {
    // The burn is a synchronous check-and-set with no `await` between verify and
    // burn, so concurrent replays of the same token can't both reach the upstream.
    const app = appWith([datasource({ writeAllowlist: new Set(["createOnePerson"]) })]);
    const body = confirmBody({
      datasourceId: "twenty",
      operationId: "createOnePerson",
      body: { name: { firstName: "Ada" } },
    });
    const [a, b] = await Promise.all([post(app, body), post(app, body)]);
    expect([a.status, b.status].toSorted()).toEqual([200, 400]);
    // Exactly one write reached the upstream.
    const writes = twentyMock.matching("/rest/people").filter((r) => r.method === "POST");
    expect(writes.length).toBe(1);
  });

  it("500s (confirm_token_unverifiable) when the server has no signing key — misconfig, not a client 400", async () => {
    // A missing/rotated-to-empty signing key at confirm time is a SERVER fault — it
    // surfaces as a correlated 500, never as the neutral "your confirmation is invalid"
    // 400 (and still fail-closed: no write fires).
    const app = appWith([datasource({ writeAllowlist: new Set(["createOnePerson"]) })]);
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
      const res = await post(app, {
        datasourceId: "twenty",
        operationId: "createOnePerson",
        body: {},
        token: "any.nonempty.token",
      });
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toBe("confirm_token_unverifiable");
      expect(twentyMock.requests.some((r) => r.method !== "GET")).toBe(false);
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

  it("REJECTS a token minted for a DIFFERENT workspace (binding mismatch, 400)", async () => {
    // The auth middleware resolves ws-1; a token bound to ws-evil must not confirm
    // a write here even if its op/params line up — the workspace is in the binding.
    const app = appWith([datasource({ writeAllowlist: new Set(["createOnePerson"]) })]);
    const foreign = mintRestConfirmToken({
      workspaceId: "ws-evil",
      datasourceId: "twenty",
      operationId: "createOnePerson",
      params: confirmRequestToParams({
        datasourceId: "twenty",
        operationId: "createOnePerson",
        body: {},
      } as RestWriteConfirmRequest),
    });
    const res = await post(app, { datasourceId: "twenty", operationId: "createOnePerson", body: {}, token: foreign });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("confirm_token_invalid");
    expect(twentyMock.requests.some((r) => r.method !== "GET")).toBe(false);
  });
});
