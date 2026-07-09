/**
 * Tests for the POST /api/v1/datasources/{id}/profile route (#4052).
 *
 * Mounts the `datasources` router standalone and mocks the seams it touches
 * (auth admission, billing gate-0, the profiler facade) so the route's gate
 * ordering, NDJSON progress streaming, credential-derived audit context, and
 * cooperative cancellation are tested without a live datasource.
 *
 * The endpoint is the REST sibling of the MCP `profile_datasource` tool: it
 * introspects a registered datasource and generates the semantic layer as
 * DRAFTS (content mode), streaming per-table progress as newline-delimited JSON
 * so a long run never hangs the CLI and stays cancellable.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import type {
  ResolveLiveConnectionResult,
  RunSemanticProfileOutcome,
} from "@atlas/api/lib/datasources/mcp-lifecycle";
import type { ProfileProgressCallbacks } from "@atlas/api/lib/profiler";

// --- Auth admission (adminAuth → authenticateRequest) ---------------------

function adminAuth(role: string = "admin"): AuthResult {
  return {
    authenticated: true as const,
    mode: "managed" as const,
    user: {
      id: "user-1",
      mode: "managed",
      label: "Alice",
      role,
      activeOrganizationId: "org-1",
      claims: { sub: "user-1", org_id: "org-1", origin: "cli" },
    },
  } as unknown as AuthResult;
}

const mockAuthenticateRequest: Mock<(req: Request) => Promise<AuthResult>> = mock(() =>
  Promise.resolve(adminAuth()),
);
const mockCheckRateLimit: Mock<(key: string) => { allowed: boolean; retryAfterMs?: number }> = mock(
  () => ({ allowed: true }),
);

// Curated stub of the auth-middleware surface the `adminAuth` + `requestContext`
// middlewares actually reach: `authenticateRequest` (admission), and
// `checkRateLimit` / `getClientIP` (the rate-limit + IP gate). The remaining
// exports (`isLowSaasChatRpm`, the `_set*Override` test hooks) are NOT on the
// route's middleware path, so spreading the real module — which would drag in
// its heavy auth graph and defeat this standalone-router isolation — buys
// nothing. Bun's per-file `--isolate` keeps the partial mock from leaking.
// Mirrors the curated convention in the sibling metrics.test.ts. If the route's
// middleware grows to reach another export, this stub must grow to cover it.
void mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mockCheckRateLimit,
  getClientIP: mock(() => null),
  resetRateLimits: mock(() => {}),
  rateLimitCleanupTick: mock(() => {}),
}));

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => false,
  internalQuery: async () => [],
  internalExecute: async () => {},
  getInternalDB: () => ({}),
  encryptSecret: (s: string) => s,
  decryptSecret: (s: string) => s,
  _resetPool: () => {},
}));

// --- Billing gate-0 -------------------------------------------------------

type GateResult =
  | { allowed: true }
  | {
      allowed: false;
      errorCode: string;
      errorMessage: string;
      httpStatus: number;
      retryable: boolean;
      retryAfterSeconds?: number;
    };
const mockCheckAgentBillingGate: Mock<(orgId: string | undefined) => Promise<GateResult>> = mock(
  () => Promise.resolve({ allowed: true }),
);
// Curated stub: the route reaches `agent-gate` ONLY for `checkAgentBillingGate`.
// Spreading the real module would transitively load the internal-DB graph
// (defeating this standalone-router isolation), so we stub just the reached
// export — same convention as the sibling metrics.test.ts. `BillingBlockedError`
// is not referenced by this route, so omitting it is safe; Bun's per-file
// `--isolate` keeps the partial mock from leaking.
void mock.module("@atlas/api/lib/billing/agent-gate", () => ({
  checkAgentBillingGate: mockCheckAgentBillingGate,
}));

// --- Profiler facade (mcp-lifecycle) --------------------------------------

const fakeConnection = {
  dbType: "postgres" as const,
  connectionGroupId: null,
  query: async () => ({ columns: [], rows: [] }),
  listObjects: async () => [],
  profile: async () => ({ profiles: [], errors: [], elapsedMs: 0 }),
  close: mock(async () => {}),
};

const mockResolveLiveConnection: Mock<(orgId: string, id: string) => Promise<ResolveLiveConnectionResult>> =
  mock(() =>
    Promise.resolve({
      kind: "ok" as const,
      defaultSchema: "public",
      connection: fakeConnection,
    } as unknown as ResolveLiveConnectionResult),
  );

// Capture the request context the route binds (origin/actor) + the progress
// object the route forwards, and drive a couple of progress callbacks so the
// streaming bridge is exercised.
let capturedContext: { agentOrigin?: unknown; actorKind?: unknown } = {};
let capturedOrgId: string | undefined;
let capturedSchema: string | undefined;

const mockProfileLiveDatasource: Mock<
  (opts: {
    connection: unknown;
    connectionId: string;
    orgId?: string;
    schema?: string;
    progress?: ProfileProgressCallbacks;
  }) => Promise<RunSemanticProfileOutcome>
> = mock(async (opts) => {
  const { getRequestContext } = await import("@atlas/api/lib/logger");
  const ctx = getRequestContext();
  capturedContext = { agentOrigin: ctx?.agentOrigin, actorKind: ctx?.actor?.kind };
  capturedOrgId = opts.orgId;
  capturedSchema = opts.schema;
  // Drive the progress bridge so the route emits start/table events.
  opts.progress?.onStart(2);
  opts.progress?.onTableStart("orders", 0, 2);
  opts.progress?.onTableDone("orders", 0, 2);
  opts.progress?.onTableStart("users", 1, 2);
  opts.progress?.onTableDone("users", 1, 2);
  opts.progress?.onComplete(2, 1234);
  return {
    kind: "ok" as const,
    result: {
      entities: [{ table: "orders" }, { table: "users" }],
      metrics: [{ table: "orders_metric" }],
      profiles: [],
      errors: [],
      elapsedMs: 1234,
    },
    persisted: { entities: 2, metrics: 1 },
  } as unknown as RunSemanticProfileOutcome;
});

void mock.module("@atlas/api/lib/datasources/mcp-lifecycle", () => ({
  resolveLiveConnection: mockResolveLiveConnection,
  profileLiveDatasource: mockProfileLiveDatasource,
}));

// Mount ONLY the datasources router on a fresh app.
const { OpenAPIHono } = await import("@hono/zod-openapi");
const { datasources } = await import("../routes/datasources");
const app = new OpenAPIHono();
app.route("/api/v1/datasources", datasources);

function profileRequest(id: string, init?: RequestInit): Request {
  return new Request(`http://localhost/api/v1/datasources/${id}/profile`, {
    method: "POST",
    headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
    body: "{}",
    ...init,
  });
}

/** Read an NDJSON stream body fully into an array of parsed objects. */
async function readNdjson(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  capturedContext = {};
  capturedOrgId = undefined;
  capturedSchema = undefined;
  fakeConnection.close.mockClear();
  mockAuthenticateRequest.mockReset();
  mockAuthenticateRequest.mockResolvedValue(adminAuth());
  mockCheckRateLimit.mockReset();
  mockCheckRateLimit.mockReturnValue({ allowed: true });
  mockCheckAgentBillingGate.mockReset();
  mockCheckAgentBillingGate.mockResolvedValue({ allowed: true });
  mockResolveLiveConnection.mockReset();
  mockResolveLiveConnection.mockResolvedValue({
    kind: "ok",
    defaultSchema: "public",
    connection: fakeConnection,
  } as unknown as ResolveLiveConnectionResult);
  mockProfileLiveDatasource.mockReset();
  mockProfileLiveDatasource.mockImplementation(async (opts) => {
    const { getRequestContext } = await import("@atlas/api/lib/logger");
    const ctx = getRequestContext();
    capturedContext = { agentOrigin: ctx?.agentOrigin, actorKind: ctx?.actor?.kind };
    capturedOrgId = opts.orgId;
    capturedSchema = opts.schema;
    opts.progress?.onStart(2);
    opts.progress?.onTableStart("orders", 0, 2);
    opts.progress?.onTableDone("orders", 0, 2);
    opts.progress?.onTableStart("users", 1, 2);
    opts.progress?.onTableDone("users", 1, 2);
    opts.progress?.onComplete(2, 1234);
    return {
      kind: "ok" as const,
      result: {
        entities: [{ table: "orders" }, { table: "users" }],
        metrics: [{ table: "orders_metric" }],
        profiles: [],
        errors: [],
        elapsedMs: 1234,
      },
      persisted: { entities: 2, metrics: 1 },
    } as unknown as RunSemanticProfileOutcome;
  });
});

// ---------------------------------------------------------------------------
// Auth + role floor
// ---------------------------------------------------------------------------

describe("POST /datasources/{id}/profile — auth + role floor (#4052)", () => {
  it("401 when unauthenticated", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: false as const,
      status: 401,
      error: "missing bearer",
    } as unknown as AuthResult);
    const res = await app.fetch(profileRequest("prod-us"));
    expect(res.status).toBe(401);
  });

  it("403 when the caller is a non-admin member (admin floor)", async () => {
    mockAuthenticateRequest.mockResolvedValue(adminAuth("member"));
    const res = await app.fetch(profileRequest("prod-us"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("forbidden_role");
  });

  it("allows an owner", async () => {
    mockAuthenticateRequest.mockResolvedValue(adminAuth("owner"));
    const res = await app.fetch(profileRequest("prod-us"));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Billing gate-0
// ---------------------------------------------------------------------------

describe("POST /datasources/{id}/profile — billing gate-0 (#4052)", () => {
  it("blocks an insolvent workspace before resolving the connection", async () => {
    mockCheckAgentBillingGate.mockResolvedValue({
      allowed: false,
      errorCode: "trial_expired",
      errorMessage: "Your trial has expired.",
      httpStatus: 403,
      retryable: false,
    });
    const res = await app.fetch(profileRequest("prod-us"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("trial_expired");
    expect(mockResolveLiveConnection).not.toHaveBeenCalled();
  });

  it("fails closed to 503 when the billing gate throws", async () => {
    mockCheckAgentBillingGate.mockRejectedValue(new Error("billing down"));
    const res = await app.fetch(profileRequest("prod-us"));
    expect(res.status).toBe(503);
    expect(mockResolveLiveConnection).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Connection resolution outcomes (pre-stream, mapped to HTTP)
// ---------------------------------------------------------------------------

describe("POST /datasources/{id}/profile — connection resolution (#4052)", () => {
  it("404 when the datasource is not found", async () => {
    mockResolveLiveConnection.mockResolvedValue({ kind: "not_found" });
    const res = await app.fetch(profileRequest("ghost"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("not_found");
  });

  it("400 when the datasource type is unsupported", async () => {
    mockResolveLiveConnection.mockResolvedValue({
      kind: "unsupported",
      dbType: "weirddb",
      message: "Cannot profile weirddb.",
    });
    const res = await app.fetch(profileRequest("prod-us"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("unsupported");
    expect(body.message).toContain("weirddb");
  });

  it("409 reconnect_required for a stale OAuth datasource", async () => {
    mockResolveLiveConnection.mockResolvedValue({
      kind: "reconnect_required",
      dbType: "salesforce",
      message: "Reconnect Salesforce in Admin → Integrations.",
    });
    const res = await app.fetch(profileRequest("sfdc"));
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("reconnect_required");
  });

  it("503 resolve_unavailable when the resolver THROWS before the stream (correlated requestId, #4113)", async () => {
    // A transient internal-DB fault from the dynamic import or resolveLiveConnection
    // must fail closed to a 503 carrying THIS route's requestId — never escape to
    // the global handler (fresh uncorrelated id) or start the stream. Distinct from
    // the resolver's typed not_found/unsupported/reconnect outcomes above.
    mockResolveLiveConnection.mockRejectedValue(new Error("internal DB down"));
    const res = await app.fetch(profileRequest("prod-us"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("resolve_unavailable");
    expect(body.retryable).toBe(true);
    expect(typeof body.requestId).toBe("string");
    // The stream never started: the profiler + connection-close are never reached.
    expect(mockProfileLiveDatasource).not.toHaveBeenCalled();
    expect(fakeConnection.close).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// NDJSON progress streaming + result
// ---------------------------------------------------------------------------

describe("POST /datasources/{id}/profile — NDJSON streaming (#4052)", () => {
  it("streams start/table events then a terminal result with draft persistence", async () => {
    const res = await app.fetch(profileRequest("prod-us"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const events = await readNdjson(res);
    const start = events.find((e) => e.type === "start");
    expect(start).toBeDefined();
    expect(start?.total).toBe(2);

    const tableEvents = events.filter((e) => e.type === "table");
    expect(tableEvents.length).toBe(2);
    expect(tableEvents[0].name).toBe("orders");
    expect(tableEvents[0].status).toBe("done");

    const result = events.find((e) => e.type === "result");
    expect(result).toBeDefined();
    expect(result?.id).toBe("prod-us");
    expect(result?.entitiesGenerated).toBe(2);
    expect(result?.metricsGenerated).toBe(1);
    expect(result?.persisted).toBe(true);
    expect(result?.persistedStatus).toBe("draft");
    expect(result?.tables).toEqual(["orders", "users"]);
    expect(result?.elapsedMs).toBe(1234);
  });

  it("persists drafts under the bound credential's org, never a request field", async () => {
    await app.fetch(profileRequest("prod-us"));
    expect(capturedOrgId).toBe("org-1");
  });

  it("binds origin=cli + actor.kind=human into the request context", async () => {
    await app.fetch(profileRequest("prod-us"));
    expect(capturedContext.agentOrigin).toBe("cli");
    expect(capturedContext.actorKind).toBe("human");
  });

  it("stamps actor.kind=api_key for an unattended workspace API key (#4046 / ADR-0027 §6)", async () => {
    // The api-key auth path marks the resolved user with claims.api_key=true and
    // keeps origin=cli (the CLI transport). The profiler persists drafts under
    // this bound context, so the trail must distinguish the unattended key from
    // a human device-flow login rather than flatten both to `human`.
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: true as const,
      mode: "managed" as const,
      user: {
        id: "user-1",
        mode: "managed",
        label: "Alice",
        role: "admin",
        activeOrganizationId: "org-1",
        claims: { sub: "user-1", org_id: "org-1", origin: "cli", api_key: true },
      },
    } as unknown as AuthResult);
    await app.fetch(profileRequest("prod-us"));
    expect(capturedContext.agentOrigin).toBe("cli");
    expect(capturedContext.actorKind).toBe("api_key");
  });

  it("does NOT mislabel a non-cli session as cli (origin derived from claims, not hardcoded — #4113)", async () => {
    // A real CLI credential always stamps origin=cli; a credential WITHOUT the
    // claim (e.g. an admin web session reaching this route) must leave agentOrigin
    // undefined, not be forced to "cli". Standardized to the undefined fallback
    // across the four sibling CLI routes so origin-scoped approval matching can't
    // see a fabricated origin.
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: true as const,
      mode: "managed" as const,
      user: {
        id: "user-1",
        mode: "managed",
        label: "Alice",
        role: "admin",
        activeOrganizationId: "org-1",
        claims: { sub: "user-1", org_id: "org-1" }, // no origin claim
      },
    } as unknown as AuthResult);
    await app.fetch(profileRequest("prod-us"));
    expect(capturedContext.agentOrigin).toBeUndefined();
    expect(capturedContext.actorKind).toBe("human");
  });

  it("closes the live connection after profiling settles", async () => {
    await app.fetch(profileRequest("prod-us"));
    expect(fakeConnection.close).toHaveBeenCalled();
  });

  it("emits an incomplete result + incompleteTables when some tables failed", async () => {
    mockProfileLiveDatasource.mockImplementation(async (opts) => {
      opts.progress?.onStart(2);
      return {
        kind: "ok" as const,
        result: {
          entities: [{ table: "orders" }],
          metrics: [],
          profiles: [],
          errors: [{ table: "users", error: "permission denied" }],
          elapsedMs: 500,
        },
        persisted: { entities: 1, metrics: 0 },
      } as unknown as RunSemanticProfileOutcome;
    });
    const res = await app.fetch(profileRequest("prod-us"));
    const events = await readNdjson(res);
    const result = events.find((e) => e.type === "result");
    expect(result?.incomplete).toBe(true);
    expect(result?.incompleteTables).toEqual(["users"]);
    expect(result?.profilingErrors).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Profiling failure outcomes (streamed terminal error)
// ---------------------------------------------------------------------------

describe("POST /datasources/{id}/profile — profiling failure (#4052)", () => {
  it("streams a terminal error event when profiling fails", async () => {
    mockProfileLiveDatasource.mockResolvedValue({
      kind: "error",
      reason: "no_tables",
      message: "The datasource has no profilable tables.",
    } as unknown as RunSemanticProfileOutcome);
    const res = await app.fetch(profileRequest("prod-us"));
    // Stream already started (200) — the failure rides as a terminal error event.
    expect(res.status).toBe(200);
    const events = await readNdjson(res);
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect(err?.error).toBe("profiling_failed");
    expect(err?.message).toContain("no profilable tables");
    expect(fakeConnection.close).toHaveBeenCalled();
  });

  it("streams a reconnect_required terminal error when a token is revoked mid-profile", async () => {
    mockProfileLiveDatasource.mockResolvedValue({
      kind: "reconnect_required",
      dbType: "salesforce",
      message: "Reconnect Salesforce, then retry.",
    } as unknown as RunSemanticProfileOutcome);
    const res = await app.fetch(profileRequest("sfdc"));
    const events = await readNdjson(res);
    const err = events.find((e) => e.type === "error");
    expect(err?.error).toBe("reconnect_required");
  });

  it("streams a terminal error (not a 500) when the profiler throws unexpectedly", async () => {
    mockProfileLiveDatasource.mockRejectedValue(new Error("boom"));
    const res = await app.fetch(profileRequest("prod-us"));
    const events = await readNdjson(res);
    const err = events.find((e) => e.type === "error");
    expect(err?.error).toBe("internal_error");
    expect(fakeConnection.close).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Bound-workspace precondition + schema forwarding
// ---------------------------------------------------------------------------

describe("POST /datasources/{id}/profile — bound-workspace + schema (#4052)", () => {
  it("400 bad_request when the credential carries no bound workspace", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: true as const,
      mode: "managed" as const,
      user: {
        id: "user-1",
        mode: "managed",
        label: "Alice",
        role: "admin",
        // No activeOrganizationId — a multi-workspace login pending the picker.
        claims: { sub: "user-1", origin: "cli" },
      },
    } as unknown as AuthResult);
    const res = await app.fetch(profileRequest("prod-us"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("bad_request");
    // Never reaches the gate or the connection resolver with an undefined org.
    expect(mockCheckAgentBillingGate).not.toHaveBeenCalled();
    expect(mockResolveLiveConnection).not.toHaveBeenCalled();
  });

  it("forwards a schema override from the body to the profiler", async () => {
    const res = await app.fetch(
      profileRequest("prod-us", { body: JSON.stringify({ schema: "analytics" }) }),
    );
    expect(res.status).toBe(200);
    await readNdjson(res); // drain so the handler runs to completion
    expect(capturedSchema).toBe("analytics");
  });

  it("omits schema (profiler default) when the body has none", async () => {
    const res = await app.fetch(profileRequest("prod-us"));
    await readNdjson(res);
    expect(capturedSchema).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("POST /datasources/{id}/profile — cancellation (#4052)", () => {
  it("the progress bridge throws OperationCancelledError once the request is aborted", async () => {
    // The route wires the request's abort signal into the progress callbacks so
    // onTableStart throws once aborted (cooperative cancellation).
    let cancelled = false;
    const controller = new AbortController();
    mockProfileLiveDatasource.mockImplementation(async (opts) => {
      // Simulate the abort happening before the first table.
      controller.abort();
      try {
        opts.progress?.onTableStart("orders", 0, 1);
      } catch (err) {
        // The route names this error EXACTLY "OperationCancelledError" so
        // SemanticGenerator recognizes it as a cancel (not a profiling failure).
        cancelled = err instanceof Error && err.name === "OperationCancelledError";
      }
      return {
        kind: "ok" as const,
        result: { entities: [], metrics: [], profiles: [], errors: [], elapsedMs: 1 },
        persisted: null,
      } as unknown as RunSemanticProfileOutcome;
    });
    await Promise.resolve(
      app.fetch(profileRequest("prod-us", { signal: controller.signal })),
    ).catch(() => {});
    expect(cancelled).toBe(true);
  });

  it("a cancel that surfaces as a thrown OperationCancelledError closes the connection and emits no result/error event", async () => {
    // Simulate the realistic path: the profiler facade re-throws the
    // OperationCancelledError instance (after SemanticGenerator routes it to a
    // defect). The route must treat it as a clean cancel — close the connection,
    // emit NO terminal `result`/`error`/`internal_error` event.
    mockProfileLiveDatasource.mockImplementation(async () => {
      const err = new Error("Profiling was cancelled by the client.");
      err.name = "OperationCancelledError";
      throw err;
    });
    const res = await app.fetch(profileRequest("prod-us"));
    const events = await readNdjson(res);
    expect(events.find((e) => e.type === "result")).toBeUndefined();
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    expect(fakeConnection.close).toHaveBeenCalled();
  });
});
