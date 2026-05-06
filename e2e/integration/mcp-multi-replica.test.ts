/**
 * Integration: MCP multi-replica frame routing — Theme B2 (#2069).
 *
 * Pins the contract that Railway's lack of sticky routing turns into a
 * production bug as soon as a regional API service scales past 1 replica.
 *
 * ── What this test verifies ──────────────────────────────────────────
 *
 * MCP sessions live in the API process's memory (the module-scoped
 * `sessions` Map in `packages/mcp/src/hosted.ts`). After a successful
 * `initialize` frame, the SDK assigns a `mcp-session-id` and every
 * subsequent JSON-RPC frame must arrive at the **same replica** that ran
 * the init — otherwise the lookup misses and the response is `404
 * unknown_session`, which breaks the agent's connection mid-conversation.
 *
 * The verified Railway behavior (https://docs.railway.com/reference/scaling):
 *
 *   "For now Railway does not support sticky sessions nor report the
 *    usage of the replicas within the metrics view."
 *   "Railway will randomly distribute public traffic to the replicas
 *    of that region."
 *
 * So a 2-replica deployment with no session affinity gives ~50 %
 * cross-replica frames — half of every active MCP session breaks on
 * every reroute.
 *
 * The mitigation shipped with this PR is `multiRegionConfig.numReplicas:
 * 1` in each `deploy/<service>/railway.json`. The fallback flagged in
 * #2069 (move sessions out of memory into the existing internal Postgres)
 * is documented but not yet built.
 *
 * ── How the simulation works ─────────────────────────────────────────
 *
 * In production, "frame routed to wrong replica" reduces to "frame
 * carrying a session-id this server doesn't have." The byte-for-byte
 * code path is identical: `dispatchExistingSession` looks up the
 * session-id in its in-memory store, misses, and returns 404
 * `unknown_session`.
 *
 * The test runs a single Hono server with a real `createHostedMcpRouter`
 * and treats the test code itself as the load balancer. Two policies
 * exercise the contract:
 *
 *  - **sticky-LB**: every follow-up frame uses the real session-id
 *    returned by `initialize`. All 10 frames must succeed (HTTP 200).
 *
 *  - **round-robin-LB (no sticky)**: every other frame uses a synthetic
 *    UUID that the server has never seen — i.e. as if the load balancer
 *    routed it to a different replica that doesn't have this session.
 *    Half the frames must return HTTP 404 with `error: "unknown_session"`.
 *
 * The test does NOT spin up two real replicas. Production-side validation
 * lives in the OpenStatus synthetic monitor configured by this PR — it
 * sends sequential MCP frames against each regional hostname and pages
 * if any returns `404 unknown_session`. That is where Railway's actual
 * load-balancer behavior is observed under load.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  mock,
  type Mock,
} from "bun:test";
import { ATLAS_OAUTH_WORKSPACE_CLAIM as WORKSPACE_CLAIM } from "../../packages/api/src/lib/auth/oauth-claims";

// ── Module-scope mocks ──────────────────────────────────────────────
// Every named export of a mocked module must be present (CLAUDE.md);
// partial mocks leak across files in Bun's in-process runner.

interface FakeJwtPayload {
  sub: string;
  jti?: string;
  azp?: string;
  scope?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
  iat?: number;
  [WORKSPACE_CLAIM]?: string;
}

const mockVerifyAccessToken: Mock<
  (token: string, opts: unknown) => Promise<FakeJwtPayload>
> = mock(async () => {
  throw new Error("verifyAccessToken called without a stub");
});

mock.module("better-auth/oauth2", () => {
  const notUsed = (name: string) => () => {
    throw new Error(`better-auth/oauth2.${name} called from multi-replica test`);
  };
  return {
    verifyAccessToken: (token: string, opts: unknown) =>
      mockVerifyAccessToken(token, opts),
    authorizationCodeRequest: notUsed("authorizationCodeRequest"),
    clientCredentialsToken: notUsed("clientCredentialsToken"),
    clientCredentialsTokenRequest: notUsed("clientCredentialsTokenRequest"),
    createAuthorizationCodeRequest: notUsed("createAuthorizationCodeRequest"),
    createAuthorizationURL: notUsed("createAuthorizationURL"),
    createClientCredentialsTokenRequest: notUsed(
      "createClientCredentialsTokenRequest",
    ),
    createRefreshAccessTokenRequest: notUsed("createRefreshAccessTokenRequest"),
    decryptOAuthToken: notUsed("decryptOAuthToken"),
    generateCodeChallenge: notUsed("generateCodeChallenge"),
    generateState: notUsed("generateState"),
    getJwks: notUsed("getJwks"),
    getOAuth2Tokens: notUsed("getOAuth2Tokens"),
    handleOAuthUserInfo: notUsed("handleOAuthUserInfo"),
    parseState: notUsed("parseState"),
    refreshAccessToken: notUsed("refreshAccessToken"),
    refreshAccessTokenRequest: notUsed("refreshAccessTokenRequest"),
    setTokenUtil: notUsed("setTokenUtil"),
    validateAuthorizationCode: notUsed("validateAuthorizationCode"),
    validateToken: notUsed("validateToken"),
    verifyJwsAccessToken: notUsed("verifyJwsAccessToken"),
  };
});

const mockApiRegion: Mock<() => string | null> = mock(() => null);

mock.module("@atlas/api/lib/residency/misrouting", () => ({
  detectMisrouting: async () => null,
  getApiRegion: () => mockApiRegion(),
  isStrictRoutingEnabled: () => false,
  getMisroutedCount: () => 0,
  _resetMisroutedCount: () => undefined,
  _resetRegionCache: () => undefined,
}));

const mockWorkspaceRegion: Mock<(orgId: string) => Promise<string | null>> =
  mock(async () => null);

mock.module("@atlas/api/lib/db/internal", () => {
  const notUsed = (name: string) => () => {
    throw new Error(
      `db/internal.${name} called from multi-replica test — add a mock`,
    );
  };
  return {
    getWorkspaceRegion: (orgId: string) => mockWorkspaceRegion(orgId),
    hasInternalDB: () => true,
    // The MCP prompt library calls `internalQuery(...)` and `.map`s
    // over the result, so the mock must return an array (not a
    // {columns,rows} envelope). Empty array keeps the prompt loader
    // quiet without pretending a real DB exists.
    internalQuery: async () => [],
    internalExecute: notUsed("internalExecute"),
    getInternalDB: notUsed("getInternalDB"),
    assignWorkspaceRegion: notUsed("assignWorkspaceRegion"),
    isWorkspaceMigrating: async () => false,
    closeInternalDB: async () => undefined,
  };
});

// The audit-log mock is a no-op: the existing unit tests in
// packages/mcp/src/__tests__/hosted.test.ts already pin the
// "mcp_session.start fires once per session" contract; this suite is
// scoped to frame routing, so it doesn't need to inspect audit rows.
mock.module("@atlas/api/lib/audit", () => ({
  ADMIN_ACTIONS: {
    mcp_session: { start: "mcp_session.start" },
  },
  logAdminAction: () => {},
  logAdminActionAwait: async () => {},
  errorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
  causeToError: (err: unknown) =>
    err instanceof Error ? err : new Error(String(err)),
}));

interface MockedConfig {
  datasources: Record<string, unknown>;
  tools: string[];
  auth: string;
  semanticLayer: string;
  source: string;
  residency?: { regions: Record<string, { apiUrl?: string }> };
}

const mockedConfig: MockedConfig = {
  datasources: {},
  tools: ["explore", "executeSQL"],
  auth: "auto",
  semanticLayer: "./semantic",
  source: "env",
};

mock.module("@atlas/api/lib/config", () => ({
  initializeConfig: mock(async () => mockedConfig),
  getConfig: mock(() => mockedConfig),
  loadConfig: mock(async () => mockedConfig),
  configFromEnv: mock(() => mockedConfig),
  validateAndResolve: mock(() => mockedConfig),
  defineConfig: (c: unknown) => c,
  applyDatasources: mock(async () => undefined),
  validateToolConfig: mock(async () => undefined),
  formatZodErrors: () => "",
  _resetConfig: mock(() => undefined),
  _setConfigForTest: mock(() => undefined),
  _warnPoolDefaultsInSaaS: mock(() => undefined),
}));

mock.module("@atlas/api/lib/tools/explore", () => ({
  explore: {
    description: "Explore the semantic layer",
    execute: mock(async () => "catalog.yml\nentities/\nglossary.yml"),
  },
}));

mock.module("@atlas/api/lib/tools/sql", () => ({
  executeSQL: {
    description: "Execute SQL",
    execute: mock(async () => ({
      success: true,
      explanation: "ok",
      row_count: 0,
      columns: [],
      rows: [],
      truncated: false,
    })),
  },
}));

const { createHostedMcpRouter, _resetHostedSessions, _hostedSessionCount } =
  await import("../../packages/mcp/src/hosted.js");

// ── Test fixtures ────────────────────────────────────────────────────

const ORG_A = "org_a";
const CLIENT_A = "claude-desktop";
const SUB_A = "user_a";
const TOKEN_A = "fake.jwt.token-a";

const FRAMES_PER_RUN = 10;

beforeEach(() => {
  mockVerifyAccessToken.mockReset();
  mockApiRegion.mockReset();
  mockWorkspaceRegion.mockReset();
  mockApiRegion.mockImplementation(() => null);
  mockWorkspaceRegion.mockImplementation(async () => null);
  mockVerifyAccessToken.mockImplementation(async (token) => {
    if (token === TOKEN_A) {
      return {
        sub: SUB_A,
        jti: "jti_a",
        azp: CLIENT_A,
        scope: "openid mcp:read",
        [WORKSPACE_CLAIM]: ORG_A,
      };
    }
    throw new Error(`Unknown token in test: ${token}`);
  });
});

afterEach(async () => {
  await _resetHostedSessions();
});

afterAll(() => {
  mock.restore();
});

interface ServerHandle {
  url: string;
  close: () => Promise<void>;
}

async function startServer(): Promise<ServerHandle> {
  // The hosted router exposes `/:workspaceId/sse`; we serve it as the
  // app root here (rather than mounting under `/mcp`) to avoid taking a
  // direct dependency on `hono` from this test — `e2e/` is not a
  // workspace package so the bare `hono` import doesn't resolve. Path
  // semantics are unchanged because production also strips `/mcp`
  // before the router is reached (Hono routes mounted via `app.route("/mcp", ...)`).
  const router = createHostedMcpRouter();
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: router.fetch });
  return {
    url: `http://localhost:${server.port}`,
    close: async () => {
      await server.stop(true);
    },
  };
}

interface InitOutcome {
  sessionId: string;
}

/** Send the JSON-RPC `initialize` frame; returns the assigned session-id. */
async function initializeSession(handle: ServerHandle): Promise<InitOutcome> {
  const res = await fetch(`${handle.url}/${ORG_A}/sse`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${TOKEN_A}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "multi-replica-sim", version: "0.0.1" },
      },
    }),
  });
  if (res.status !== 200) {
    const body = await res.text();
    throw new Error(
      `initialize failed (${res.status}): ${body.slice(0, 400)}`,
    );
  }
  const sessionId = res.headers.get("mcp-session-id");
  if (!sessionId) {
    throw new Error("initialize response missing mcp-session-id header");
  }
  // Drain the response body — Bun keeps the connection open until consumed.
  await res.text();
  return { sessionId };
}

/**
 * Outcome of one frame, modeled as a discriminated union so the success
 * path can never carry an `error` field by accident. The hosted MCP
 * 4xx contract always returns `{ error, requestId }` JSON
 * (`packages/mcp/src/hosted.ts`); a non-JSON 4xx body would itself be a
 * contract regression, so the parse path throws rather than returning a
 * sentinel that the assertions would have to guard.
 */
type FrameOutcome =
  | { kind: "ok"; status: 200; sentSessionId: string }
  | { kind: "err"; status: number; error: string; sentSessionId: string };

/**
 * Send one JSON-RPC frame with a chosen session-id. The frame payload
 * is a `tools/list` call — the cheapest non-init frame.
 */
async function sendFrame(
  handle: ServerHandle,
  sessionId: string,
  rpcId: number,
): Promise<FrameOutcome> {
  const res = await fetch(`${handle.url}/${ORG_A}/sse`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${TOKEN_A}`,
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId,
      method: "tools/list",
      params: {},
    }),
  });
  if (res.status >= 400) {
    const body = (await res.json()) as { error?: string };
    return {
      kind: "err",
      status: res.status,
      error: body.error ?? "",
      sentSessionId: sessionId,
    };
  }
  // Drain the SSE/JSON body so the connection releases.
  await res.text();
  return { kind: "ok", status: 200, sentSessionId: sessionId };
}

type Policy = "sticky" | "round-robin";

/**
 * The "load balancer" — picks which session-id to send for frame N.
 *
 *   sticky:        always the originating session-id (replica-A)
 *   round-robin:   even N → originating session-id (replica-A); odd N →
 *                  fresh UUID (replica-B, which has no record of it).
 *                  Deterministic alternation rather than true random; the
 *                  property under test is the absence of session affinity,
 *                  not the LB's specific algorithm.
 */
function lbPickSessionId(
  policy: Policy,
  realSessionId: string,
  fakeSessionIds: string[],
  frameIndex: number,
): string {
  switch (policy) {
    case "sticky":
      return realSessionId;
    case "round-robin":
      return frameIndex % 2 === 0
        ? realSessionId
        : fakeSessionIds[Math.floor(frameIndex / 2)];
    default: {
      const _exhaustive: never = policy;
      throw new Error(`Unhandled load-balancer policy: ${String(_exhaustive)}`);
    }
  }
}

// ── Tests ────────────────────────────────────────────────────────────

describe("MCP multi-replica frame routing (Theme B2 #2069)", () => {
  it("contract baseline: a frame carrying an mcp-session-id this replica has never seen returns 404 unknown_session", async () => {
    // The byte-for-byte failure mode that occurs when Railway routes a
    // follow-up frame to a replica that didn't run the originating
    // initialize. If this contract ever regresses (e.g. the lookup
    // silently bypasses the in-memory store), every active MCP session
    // would break on every load-balancer reroute and the failure mode
    // would surface as "agent disconnects mid-conversation."
    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/${ORG_A}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${TOKEN_A}`,
          "mcp-session-id": crypto.randomUUID(),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string; requestId: string };
      expect(body.error).toBe("unknown_session");
      expect(body.requestId).toBeTruthy();
    } finally {
      await handle.close();
    }
  });

  it("sticky LB: 10 sequential frames after initialize all return 200 (the happy path Railway must preserve via single-replica services)", async () => {
    const handle = await startServer();
    try {
      const { sessionId } = await initializeSession(handle);
      expect(_hostedSessionCount()).toBe(1);

      const fakes: string[] = []; // unused under sticky policy
      const outcomes: FrameOutcome[] = [];
      for (let i = 0; i < FRAMES_PER_RUN; i++) {
        const sid = lbPickSessionId("sticky", sessionId, fakes, i);
        outcomes.push(await sendFrame(handle, sid, i + 2));
      }

      const ok = outcomes.filter((o) => o.kind === "ok");
      const failed = outcomes.filter((o) => o.kind === "err");
      expect(ok).toHaveLength(FRAMES_PER_RUN);
      expect(failed).toHaveLength(0);

      // Sanity-check the test infrastructure itself: the originating
      // session must still be registered so the contract assertion above
      // is meaningful.
      expect(_hostedSessionCount()).toBe(1);
    } finally {
      await handle.close();
    }
  });

  it("round-robin LB without sticky: ~50% of frames return 404 unknown_session — matches Railway's documented random-distribution behavior", async () => {
    // The bug we're guarding against. If a regional API service ever
    // scales to >1 replica without the session-store-in-Postgres
    // fallback (#2069 §3), this is what every connected MCP client
    // experiences on every cross-replica frame: 404 unknown_session,
    // forced re-initialize, broken agent connection.
    const handle = await startServer();
    try {
      const { sessionId } = await initializeSession(handle);

      // Pre-generate the synthetic "other-replica" session-ids so the
      // distribution check is deterministic. Five fakes for five
      // odd-indexed frames.
      const fakes = Array.from({ length: FRAMES_PER_RUN / 2 }, () =>
        crypto.randomUUID(),
      );

      const outcomes: FrameOutcome[] = [];
      for (let i = 0; i < FRAMES_PER_RUN; i++) {
        const sid = lbPickSessionId("round-robin", sessionId, fakes, i);
        outcomes.push(await sendFrame(handle, sid, i + 2));
      }

      const onCorrectReplica = outcomes.filter(
        (o) => o.sentSessionId === sessionId,
      );
      const onWrongReplica = outcomes.filter(
        (o) => o.sentSessionId !== sessionId,
      );

      // Exactly half of the frames in this simulation hit the "wrong
      // replica" — Railway's actual round-robin distribution would also
      // average ~50 % over many frames.
      expect(onCorrectReplica).toHaveLength(FRAMES_PER_RUN / 2);
      expect(onWrongReplica).toHaveLength(FRAMES_PER_RUN / 2);

      for (const o of onCorrectReplica) expect(o.kind).toBe("ok");
      for (const o of onWrongReplica) {
        expect(o.kind).toBe("err");
        if (o.kind === "err") {
          expect(o.status).toBe(404);
          expect(o.error).toBe("unknown_session");
        }
      }
    } finally {
      await handle.close();
    }
  });

  it("does not register a phantom session for cross-replica frames — failed frames must not bloat the session map", async () => {
    // Defensive check: if a misrouted frame ever silently created a
    // session keyed on the unknown id, the production session-cap
    // (`ATLAS_MCP_MAX_SESSIONS`) would be defeated by any client that
    // sent a stream of frames with random session-ids.
    const handle = await startServer();
    try {
      const { sessionId } = await initializeSession(handle);
      expect(_hostedSessionCount()).toBe(1);

      for (let i = 0; i < FRAMES_PER_RUN; i++) {
        const sid = i % 2 === 0 ? sessionId : crypto.randomUUID();
        await sendFrame(handle, sid, i + 2);
      }

      // Only the real `initialize` registered a session — the count is
      // still 1 despite five frames carrying unknown session-ids.
      expect(_hostedSessionCount()).toBe(1);
    } finally {
      await handle.close();
    }
  });
});
