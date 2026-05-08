/**
 * Tests for the hosted MCP Hono router (#2024 PR C).
 *
 * Authentication path: OAuth 2.1 access tokens verified via
 * `verifyAccessToken` from `better-auth/oauth2`. We mock that helper so
 * the test exercises the route's branching without standing up an OAuth
 * server, JWKS endpoint, or real Better Auth instance.
 *
 * The mock returns a synthetic JWT payload shape that mirrors what
 * Better Auth's `oauthProvider` emits — the route only reads `sub`,
 * `jti`, `azp`, `scope`, and the custom workspace claim, so we only
 * need those fields populated.
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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AdminActionEntry } from "@atlas/api/lib/audit";
// Import the same constant the production code reads — keeps the
// fixture from drifting out of sync with the issuer's claim key.
import { ATLAS_OAUTH_WORKSPACE_CLAIM as WORKSPACE_CLAIM } from "@atlas/api/lib/auth/oauth-claims";

// ── Module-scope mocks ────────────────────────────────────────────────
//
// CLAUDE.md: every named export of a mocked module must be present.
// Partial mocks leak via the in-process Bun runner and break unrelated
// test files with `Export named 'X' not found`.

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

mock.module("better-auth/oauth2", () => ({
  verifyAccessToken: (token: string, opts: unknown) =>
    mockVerifyAccessToken(token, opts),
  // Other re-exports from better-auth/oauth2 — none read by hosted.ts,
  // but partial mocks leak across test files so include throw-on-call
  // stubs for everything we know is exported.
  authorizationCodeRequest: () => {
    throw new Error("authorizationCodeRequest called from hosted test");
  },
  clientCredentialsToken: () => {
    throw new Error("clientCredentialsToken called from hosted test");
  },
  clientCredentialsTokenRequest: () => {
    throw new Error("clientCredentialsTokenRequest called from hosted test");
  },
  createAuthorizationCodeRequest: () => {
    throw new Error("createAuthorizationCodeRequest called from hosted test");
  },
  createAuthorizationURL: () => {
    throw new Error("createAuthorizationURL called from hosted test");
  },
  createClientCredentialsTokenRequest: () => {
    throw new Error("createClientCredentialsTokenRequest called from hosted test");
  },
  createRefreshAccessTokenRequest: () => {
    throw new Error("createRefreshAccessTokenRequest called from hosted test");
  },
  decryptOAuthToken: () => {
    throw new Error("decryptOAuthToken called from hosted test");
  },
  generateCodeChallenge: () => {
    throw new Error("generateCodeChallenge called from hosted test");
  },
  generateState: () => {
    throw new Error("generateState called from hosted test");
  },
  getJwks: () => {
    throw new Error("getJwks called from hosted test");
  },
  getOAuth2Tokens: () => {
    throw new Error("getOAuth2Tokens called from hosted test");
  },
  handleOAuthUserInfo: () => {
    throw new Error("handleOAuthUserInfo called from hosted test");
  },
  parseState: () => {
    throw new Error("parseState called from hosted test");
  },
  refreshAccessToken: () => {
    throw new Error("refreshAccessToken called from hosted test");
  },
  refreshAccessTokenRequest: () => {
    throw new Error("refreshAccessTokenRequest called from hosted test");
  },
  setTokenUtil: () => {
    throw new Error("setTokenUtil called from hosted test");
  },
  validateAuthorizationCode: () => {
    throw new Error("validateAuthorizationCode called from hosted test");
  },
  validateToken: () => {
    throw new Error("validateToken called from hosted test");
  },
  verifyJwsAccessToken: () => {
    throw new Error("verifyJwsAccessToken called from hosted test");
  },
}));

const mockApiRegion: Mock<() => string | null> = mock(() => null);

mock.module("@atlas/api/lib/residency/misrouting", () => ({
  // hosted.ts no longer uses detectMisrouting — kept here so any
  // sibling test that imports it still resolves.
  detectMisrouting: async () => null,
  getApiRegion: () => mockApiRegion(),
  isStrictRoutingEnabled: () => false,
  getMisroutedCount: () => 0,
  _resetMisroutedCount: () => undefined,
  _resetRegionCache: () => undefined,
}));

const mockWorkspaceRegion: Mock<(orgId: string) => Promise<string | null>> =
  mock(async () => null);

// `@atlas/api/lib/db/internal` has many exports. The hosted route only
// uses `getWorkspaceRegion`; mocking the rest as throw-on-call surfaces
// any accidental dep clearly.
mock.module("@atlas/api/lib/db/internal", () => {
  const notUsed = (name: string) => () => {
    throw new Error(`db/internal.${name} called from hosted.test — add a mock`);
  };
  return {
    getWorkspaceRegion: (orgId: string) => mockWorkspaceRegion(orgId),
    hasInternalDB: () => true,
    internalQuery: notUsed("internalQuery"),
    internalExecute: notUsed("internalExecute"),
    getInternalDB: notUsed("getInternalDB"),
    assignWorkspaceRegion: notUsed("assignWorkspaceRegion"),
    isWorkspaceMigrating: async () => false,
    closeInternalDB: async () => undefined,
  };
});

// #2073 — workspace-grants helper. Default to the legacy single-scope
// path (no scope row, no grants) so existing tests don't have to opt
// in. Multi-scope tests override these mocks per-case.
const mockGetOAuthClientScope: Mock<(clientId: string) => Promise<"single" | "multi">> = mock(
  async () => "single",
);
const mockHasWorkspaceGrant: Mock<(clientId: string, workspaceId: string) => Promise<boolean>> = mock(
  async () => false,
);
const mockUserIsWorkspaceMember: Mock<(userId: string, workspaceId: string) => Promise<boolean>> = mock(
  async () => false,
);
mock.module("@atlas/api/lib/auth/oauth-workspace-grants", () => ({
  getOAuthClientScope: (clientId: string) => mockGetOAuthClientScope(clientId),
  hasWorkspaceGrant: (clientId: string, workspaceId: string) =>
    mockHasWorkspaceGrant(clientId, workspaceId),
  userIsWorkspaceMember: (userId: string, workspaceId: string) =>
    mockUserIsWorkspaceMember(userId, workspaceId),
  listUserWorkspaceIds: async () => [],
  listWorkspaceGrantsForClient: async () => [],
  setWorkspaceScopeAndGrants: async () => undefined,
  revokeWorkspaceGrant: async () => 0,
}));

const auditedEntries: AdminActionEntry[] = [];
const mockLogAdminAction: Mock<(entry: AdminActionEntry) => void> = mock(
  (entry: AdminActionEntry) => {
    auditedEntries.push(entry);
  },
);

mock.module("@atlas/api/lib/audit", () => ({
  ADMIN_ACTIONS: {
    mcp_session: {
      start: "mcp_session.start",
      denied: "mcp_session.denied",
    },
  },
  logAdminAction: (entry: AdminActionEntry) => mockLogAdminAction(entry),
  logAdminActionAwait: async (entry: AdminActionEntry) => {
    mockLogAdminAction(entry);
  },
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
  residency?: {
    regions: Record<string, { apiUrl?: string }>;
  };
}

let __mockedConfig: MockedConfig = {
  datasources: {},
  tools: ["explore", "executeSQL"],
  auth: "auto",
  semanticLayer: "./semantic",
  source: "env",
};

mock.module("@atlas/api/lib/config", () => ({
  initializeConfig: mock(async () => __mockedConfig),
  getConfig: mock(() => __mockedConfig),
  loadConfig: mock(async () => __mockedConfig),
  configFromEnv: mock(() => __mockedConfig),
  validateAndResolve: mock(() => __mockedConfig),
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

const { Hono } = await import("hono");
const { createHostedMcpRouter, _resetHostedSessions, _hostedSessionCount, _sweepIdleSessionsForTests, _setIdleTimeoutForTests } =
  await import("../hosted.js");

// ── Test fixtures ─────────────────────────────────────────────────────

const ORG_A = "org_a";
const ORG_B = "org_b";
const CLIENT_A = "claude-desktop";
const CLIENT_B = "cursor";
const SUB_A = "user_a";
const SUB_B = "user_b";
const TOKEN_A = "fake.jwt.token-a";
const TOKEN_B = "fake.jwt.token-b";

beforeEach(() => {
  mockVerifyAccessToken.mockReset();
  mockApiRegion.mockReset();
  mockWorkspaceRegion.mockReset();
  mockLogAdminAction.mockReset();
  // #2073 — reset workspace-grants mocks to legacy defaults so tests
  // not exercising the cross-workspace path see the unchanged single-
  // scope behavior. Multi-scope tests opt in via mockResolvedValue.
  mockGetOAuthClientScope.mockReset();
  mockHasWorkspaceGrant.mockReset();
  mockUserIsWorkspaceMember.mockReset();
  mockGetOAuthClientScope.mockResolvedValue("single");
  mockHasWorkspaceGrant.mockResolvedValue(false);
  mockUserIsWorkspaceMember.mockResolvedValue(false);
  auditedEntries.length = 0;
  __mockedConfig = {
    datasources: {},
    tools: ["explore", "executeSQL"],
    auth: "auto",
    semanticLayer: "./semantic",
    source: "env",
  };
  mockApiRegion.mockImplementation(() => null);
  mockWorkspaceRegion.mockImplementation(async () => null);
  mockLogAdminAction.mockImplementation((entry) => {
    auditedEntries.push(entry);
  });
  delete process.env.ATLAS_MCP_MAX_SESSIONS;
});

afterEach(async () => {
  await _resetHostedSessions();
});

afterAll(() => {
  mock.restore();
});

async function startServer() {
  const app = new Hono();
  app.route("/mcp", createHostedMcpRouter());
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: app.fetch,
  });
  return {
    url: `http://localhost:${server.port}`,
    close: () => server.stop(true),
  };
}

/** Stub `verifyAccessToken` to return a fixed payload for `token`. */
function bindToken(
  token: string,
  payload: Omit<FakeJwtPayload, "sub"> & { sub: string },
): void {
  mockVerifyAccessToken.mockImplementation(async (incoming) => {
    if (incoming === token) return payload;
    throw new Error(`Unknown token in test: ${incoming}`);
  });
}

/** Stub two tokens A/B for cross-workspace tests. */
function bindTokensAB(): void {
  const payloadA: FakeJwtPayload = {
    sub: SUB_A,
    jti: "jti_a",
    azp: CLIENT_A,
    scope: "openid mcp:read",
    [WORKSPACE_CLAIM]: ORG_A,
  };
  const payloadB: FakeJwtPayload = {
    sub: SUB_B,
    jti: "jti_b",
    azp: CLIENT_B,
    scope: "openid mcp:read",
    [WORKSPACE_CLAIM]: ORG_B,
  };
  mockVerifyAccessToken.mockImplementation(async (incoming) => {
    if (incoming === TOKEN_A) return payloadA;
    if (incoming === TOKEN_B) return payloadB;
    throw new Error(`Unknown token in test: ${incoming}`);
  });
}

// ── Bearer / authorization ────────────────────────────────────────────

describe("hosted MCP — bearer enforcement", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/mcp/${ORG_A}/sse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string; requestId: string };
      expect(body.error).toBe("missing_bearer");
      expect(body.requestId).toBeTruthy();
      // RFC 9728 + MCP spec — 401 must point clients at the resource
      // metadata so DCR can bootstrap.
      const wwwAuth = res.headers.get("www-authenticate");
      expect(wwwAuth).toBeTruthy();
      expect(wwwAuth).toContain("Bearer");
      expect(wwwAuth).toContain("resource_metadata=");
    } finally {
      handle.close();
    }
  });

  it("returns 401 when verifyAccessToken throws (bad signature / audience / issuer / expired)", async () => {
    // verifyAccessToken collapses these distinct failure modes into a
    // single thrown Error / APIError("UNAUTHORIZED"). Our route
    // uniformly maps them to 401 invalid_bearer (RFC 6750 §3.1) — the
    // client retries via the discovery doc the WWW-Authenticate header
    // points at.
    mockVerifyAccessToken.mockImplementation(async () => {
      throw new Error("bad signature");
    });
    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/mcp/${ORG_A}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN_A}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_bearer");
      // RFC 9728 / MCP spec — 401 from the resource server MUST point
      // clients at the protected-resource metadata so DCR can recover.
      // The header presence is the contract; specific URL is asserted
      // in the missing-bearer test above.
      expect(res.headers.get("www-authenticate")).toContain(
        "resource_metadata=",
      );
    } finally {
      handle.close();
    }
  });

  // Parameterized verifyAccessToken-throw cases pin the specific error
  // shapes Better Auth's `verifyAccessToken` emits. These maintain a
  // working alarm if a future better-auth bump changes how a specific
  // failure mode (audience mismatch / issuer mismatch / expiry) gets
  // surfaced — without these, a regression where audience verification
  // gets silently dropped in the verify call ships unchallenged.
  for (const [name, message] of [
    ["audience mismatch", "unexpected audience"],
    ["issuer mismatch", "unexpected issuer"],
    ["expired token", '"exp" claim timestamp check failed'],
  ] as const) {
    it(`returns 401 invalid_bearer + WWW-Authenticate when verifyAccessToken throws: ${name}`, async () => {
      mockVerifyAccessToken.mockImplementation(async () => {
        throw new Error(message);
      });
      const handle = await startServer();
      try {
        const res = await fetch(`${handle.url}/mcp/${ORG_A}/sse`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TOKEN_A}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
        });
        expect(res.status).toBe(401);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("invalid_bearer");
        expect(res.headers.get("www-authenticate")).toContain(
          "resource_metadata=",
        );
        expect(
          auditedEntries.filter((e) => e.actionType === "mcp_session.start"),
        ).toHaveLength(0);
      } finally {
        handle.close();
      }
    });
  }

  it("returns 403 insufficient_scope when verifyAccessToken throws APIError(FORBIDDEN, scope)", async () => {
    // Better Auth's verifyAccessToken throws `APIError("FORBIDDEN",
    // "invalid scope mcp:read")` when a token authenticates but lacks
    // a required scope. RFC 6750 §3.1 mandates 403 + the `scope`
    // attribute on the WWW-Authenticate header — collapsing this to
    // 401 (the prior catch-all) tells the client to refresh, which
    // won't add a missing scope.
    const apiErr = Object.assign(new Error("invalid scope mcp:read"), {
      name: "APIError",
      status: "FORBIDDEN",
      statusCode: 403,
      body: { message: "invalid scope mcp:read" },
    });
    mockVerifyAccessToken.mockImplementation(async () => {
      throw apiErr;
    });
    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/mcp/${ORG_A}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN_A}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; scope?: string };
      expect(body.error).toBe("insufficient_scope");
      expect(body.scope).toBe("mcp:read");
      // 403 insufficient_scope is NOT an auth challenge — re-running
      // DCR / refresh wouldn't help. WWW-Authenticate is suppressed.
      expect(res.headers.get("www-authenticate")).toBeNull();
      expect(
        auditedEntries.filter((e) => e.actionType === "mcp_session.start"),
      ).toHaveLength(0);
    } finally {
      handle.close();
    }
  });

  it("returns 503 auth_unavailable when JWKS is unreachable", async () => {
    // `Error("Jwks failed: …")` is the better-auth contract for
    // "couldn't fetch the JWKS doc". This is a server-side outage,
    // not a client error — flattening it to 401 would mask a JWKS
    // outage as a flood of attacker-bad-tokens and confuse triage.
    mockVerifyAccessToken.mockImplementation(async () => {
      throw new Error("Jwks failed: connection refused");
    });
    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/mcp/${ORG_A}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN_A}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("auth_unavailable");
      // WWW-Authenticate suppressed — pointing the client at the
      // metadata document during a JWKS outage would just send them
      // around the same broken loop.
      expect(res.headers.get("www-authenticate")).toBeNull();
      expect(
        auditedEntries.filter((e) => e.actionType === "mcp_session.start"),
      ).toHaveLength(0);
    } finally {
      handle.close();
    }
  });

  it("returns 401 missing_workspace_claim WITHOUT WWW-Authenticate when the JWT verified but carries no workspace claim", async () => {
    // Structurally-bad token: signature/exp/aud all valid but the
    // issuer didn't stamp the workspace claim. Re-running DCR would
    // not fix this; the discovery pointer is suppressed.
    mockVerifyAccessToken.mockImplementation(async () => ({
      sub: SUB_A,
      jti: "jti_a",
      azp: CLIENT_A,
      scope: "openid",
      // No WORKSPACE_CLAIM key.
    }));
    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/mcp/${ORG_A}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN_A}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("missing_workspace_claim");
      expect(res.headers.get("www-authenticate")).toBeNull();
      expect(
        auditedEntries.filter((e) => e.actionType === "mcp_session.start"),
      ).toHaveLength(0);
    } finally {
      handle.close();
    }
  });

  it("returns 401 missing_subject WITHOUT WWW-Authenticate when JWT carries no sub claim", async () => {
    mockVerifyAccessToken.mockImplementation(async () => ({
      sub: "", // empty falsey
      jti: "jti_a",
      azp: CLIENT_A,
      [WORKSPACE_CLAIM]: ORG_A,
    }));
    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/mcp/${ORG_A}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN_A}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("missing_subject");
      expect(res.headers.get("www-authenticate")).toBeNull();
    } finally {
      handle.close();
    }
  });

  it("returns 401 missing_client_id when the JWT carries no azp claim — never the audit-poisoning 'unknown_client' fallback", async () => {
    // Pre-fix this test would have passed silently: the route accepted
    // the token, fed the audit row a literal "unknown_client" string,
    // and forensic queries on `clientId` couldn't tell that apart from
    // a real client legitimately registered as "unknown_client".
    mockVerifyAccessToken.mockImplementation(async () => ({
      sub: SUB_A,
      jti: "jti_a",
      // no `azp`
      [WORKSPACE_CLAIM]: ORG_A,
    }));
    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/mcp/${ORG_A}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN_A}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("missing_client_id");
      expect(res.headers.get("www-authenticate")).toBeNull();
      // No audit row written under the "unknown_client" literal.
      expect(
        auditedEntries.filter((e) => e.actionType === "mcp_session.start"),
      ).toHaveLength(0);
    } finally {
      handle.close();
    }
  });
});

// ── Brand hostname (#2068) ───────────────────────────────────────────

describe("hosted MCP — mcp.useatlas.dev brand hostname", () => {
  // #2068 — `mcp.useatlas.dev` is the canonical hostname for the hosted
  // MCP endpoint, fronting the same Railway services as the regional
  // `api.*` siblings. Tokens minted post-cutover bind to the brand
  // audience; tokens minted pre-cutover bound to the regional host. The
  // verifier must accept BOTH so the cutover is non-destructive — there
  // are no production tokens at the moment of the flip (#2024 PR C
  // dropped `mcp_tokens` and OAuth tokens are <2 days old at cutover),
  // but the contract still has to hold for any token already in flight.
  it("passes both regional + brand audiences to verifyAccessToken when ATLAS_PUBLIC_API_URL points at the us-region api host", async () => {
    const prev = process.env.ATLAS_PUBLIC_API_URL;
    process.env.ATLAS_PUBLIC_API_URL = "https://api.useatlas.dev";
    bindToken(TOKEN_A, {
      sub: SUB_A,
      azp: CLIENT_A,
      scope: "openid mcp:read",
      [WORKSPACE_CLAIM]: ORG_A,
    });
    const handle = await startServer();
    try {
      await fetch(`${handle.url}/mcp/${ORG_A}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN_A}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      const lastCall =
        mockVerifyAccessToken.mock.calls[
          mockVerifyAccessToken.mock.calls.length - 1
        ];
      const opts = lastCall?.[1] as
        | { verifyOptions?: { audience?: unknown } }
        | undefined;
      const audience = opts?.verifyOptions?.audience;
      expect(Array.isArray(audience)).toBe(true);
      expect(audience).toEqual([
        "https://api.useatlas.dev/mcp",
        "https://mcp.useatlas.dev/mcp",
      ]);
    } finally {
      handle.close();
      if (prev === undefined) delete process.env.ATLAS_PUBLIC_API_URL;
      else process.env.ATLAS_PUBLIC_API_URL = prev;
    }
  });

  it("symmetrically accepts both audiences when ATLAS_PUBLIC_API_URL is the brand host (operator post-cutover flip)", async () => {
    // The CLI default writes `https://mcp.useatlas.dev` into client
    // configs; some operators reasonably re-set ATLAS_PUBLIC_API_URL
    // to match. The verifier's `mirrorUseatlasHost` is symmetric —
    // pre-cutover tokens bound to the regional `api.useatlas.dev/mcp`
    // audience must keep verifying. Asymmetric mirroring here would
    // silently lock out every in-flight token at the moment the
    // operator flipped the env var. This test guards against the
    // verifier-side regex drifting away from the issuer-side
    // (`oauth-config.test.ts:resolveOAuthValidAudiences`) regex.
    const prev = process.env.ATLAS_PUBLIC_API_URL;
    process.env.ATLAS_PUBLIC_API_URL = "https://mcp.useatlas.dev";
    bindToken(TOKEN_A, {
      sub: SUB_A,
      azp: CLIENT_A,
      scope: "openid mcp:read",
      [WORKSPACE_CLAIM]: ORG_A,
    });
    const handle = await startServer();
    try {
      await fetch(`${handle.url}/mcp/${ORG_A}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN_A}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      const lastCall =
        mockVerifyAccessToken.mock.calls[
          mockVerifyAccessToken.mock.calls.length - 1
        ];
      const opts = lastCall?.[1] as
        | { verifyOptions?: { audience?: unknown } }
        | undefined;
      expect(opts?.verifyOptions?.audience).toEqual([
        "https://mcp.useatlas.dev/mcp",
        "https://api.useatlas.dev/mcp",
      ]);
    } finally {
      handle.close();
      if (prev === undefined) delete process.env.ATLAS_PUBLIC_API_URL;
      else process.env.ATLAS_PUBLIC_API_URL = prev;
    }
  });

  it("WWW-Authenticate resource_metadata points at the brand hostname when ATLAS_PUBLIC_API_URL is the regional api host", async () => {
    // Standards-compliant MCP clients read the `resource_metadata` URL
    // from the 401 challenge to bootstrap discovery. Post-#2068 the
    // metadata endpoint sits on the brand hostname so a client that
    // never sees the regional `api.*` URL can still complete DCR + the
    // PKCE dance.
    const prev = process.env.ATLAS_PUBLIC_API_URL;
    process.env.ATLAS_PUBLIC_API_URL = "https://api.useatlas.dev";
    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/mcp/${ORG_A}/sse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(res.status).toBe(401);
      const wwwAuth = res.headers.get("www-authenticate") ?? "";
      expect(wwwAuth).toContain(
        `resource_metadata="https://mcp.useatlas.dev/.well-known/oauth-protected-resource/mcp/${ORG_A}"`,
      );
    } finally {
      handle.close();
      if (prev === undefined) delete process.env.ATLAS_PUBLIC_API_URL;
      else process.env.ATLAS_PUBLIC_API_URL = prev;
    }
  });
});

// ── Path/claim workspace match ───────────────────────────────────────

describe("hosted MCP — path/claim workspace match", () => {
  it("returns 403 — never 404 — when path workspaceId does not match the claim's workspace", async () => {
    bindToken(TOKEN_A, {
      sub: SUB_A,
      jti: "jti_a",
      azp: CLIENT_A,
      scope: "openid mcp:read",
      [WORKSPACE_CLAIM]: ORG_A,
    });
    // Single-scope (default) — path/claim mismatch must 403.
    mockGetOAuthClientScope.mockResolvedValue("single");
    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/mcp/${ORG_B}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN_A}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(res.status).toBe(403);
      // #2073 — opaque single-scope mismatch surfaces under the
      // structured `cross_workspace_denied` envelope so the CLI / agent
      // can render the actionable hint without parsing log lines.
      const body = (await res.json()) as { error: string; hint?: string };
      expect(body.error).toBe("cross_workspace_denied");
      expect(body.hint).toBeDefined();
      expect(
        auditedEntries.filter((e) => e.actionType === "mcp_session.start"),
      ).toHaveLength(0);
    } finally {
      handle.close();
    }
  });
});

// ── #2073 cross-workspace agent identity ──────────────────────────────

describe("hosted MCP — cross-workspace agent identity (#2073)", () => {
  beforeEach(() => {
    // Default to legacy single-scope. Multi-scope tests opt in.
    mockGetOAuthClientScope.mockReset();
    mockHasWorkspaceGrant.mockReset();
    mockUserIsWorkspaceMember.mockReset();
    mockGetOAuthClientScope.mockResolvedValue("single");
    mockHasWorkspaceGrant.mockResolvedValue(false);
    mockUserIsWorkspaceMember.mockResolvedValue(false);
  });

  it("multi-scope: X-Atlas-Workspace header overrides path workspace", async () => {
    bindToken(TOKEN_A, {
      sub: SUB_A,
      jti: "jti_a",
      azp: CLIENT_A,
      scope: "openid mcp:read",
      [WORKSPACE_CLAIM]: ORG_A,
    });
    mockGetOAuthClientScope.mockResolvedValue("multi");
    mockHasWorkspaceGrant.mockImplementation(
      async (_clientId, workspaceId) => workspaceId === ORG_B,
    );
    mockUserIsWorkspaceMember.mockImplementation(
      async (_userId, workspaceId) => workspaceId === ORG_B,
    );

    const handle = await startServer();
    try {
      // Path pins to ORG_A, but the header redirects to ORG_B and the
      // grant + membership for ORG_B succeed → request is admitted.
      const res = await fetch(`${handle.url}/mcp/${ORG_A}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN_A}`,
          "X-Atlas-Workspace": ORG_B,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      // The dispatch reaches session creation (status not 401/403); the
      // exact body shape depends on the SDK's handshake. We're only
      // gating on "did we get past the workspace authorization layer."
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
      // The grant lookup ran for ORG_B (the resolved workspace), not ORG_A.
      const grantArgs = mockHasWorkspaceGrant.mock.calls.map((c) => c[1]);
      expect(grantArgs).toContain(ORG_B);
    } finally {
      handle.close();
    }
  });

  it("multi-scope: X-Atlas-Default-Workspace fills in when X-Atlas-Workspace is absent", async () => {
    bindToken(TOKEN_A, {
      sub: SUB_A,
      jti: "jti_a",
      azp: CLIENT_A,
      scope: "openid mcp:read",
      [WORKSPACE_CLAIM]: ORG_A,
    });
    mockGetOAuthClientScope.mockResolvedValue("multi");
    mockHasWorkspaceGrant.mockImplementation(
      async (_clientId, workspaceId) => workspaceId === ORG_B,
    );
    mockUserIsWorkspaceMember.mockImplementation(
      async (_userId, workspaceId) => workspaceId === ORG_B,
    );

    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/mcp/${ORG_A}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN_A}`,
          "X-Atlas-Default-Workspace": ORG_B,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(res.status).not.toBe(403);
      const grantArgs = mockHasWorkspaceGrant.mock.calls.map((c) => c[1]);
      expect(grantArgs).toContain(ORG_B);
    } finally {
      handle.close();
    }
  });

  it("multi-scope: falls back to path workspace when no override header is set", async () => {
    bindToken(TOKEN_A, {
      sub: SUB_A,
      jti: "jti_a",
      azp: CLIENT_A,
      scope: "openid mcp:read",
      [WORKSPACE_CLAIM]: ORG_A,
    });
    mockGetOAuthClientScope.mockResolvedValue("multi");
    mockHasWorkspaceGrant.mockResolvedValue(true);
    mockUserIsWorkspaceMember.mockResolvedValue(true);

    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/mcp/${ORG_A}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN_A}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(res.status).not.toBe(403);
      // The path workspace IS the resolved workspace.
      const grantArgs = mockHasWorkspaceGrant.mock.calls.map((c) => c[1]);
      expect(grantArgs).toContain(ORG_A);
    } finally {
      handle.close();
    }
  });

  it("multi-scope: 403 cross_workspace_denied when no grant exists for the resolved workspace", async () => {
    bindToken(TOKEN_A, {
      sub: SUB_A,
      jti: "jti_a",
      azp: CLIENT_A,
      scope: "openid mcp:read",
      [WORKSPACE_CLAIM]: ORG_A,
    });
    mockGetOAuthClientScope.mockResolvedValue("multi");
    mockHasWorkspaceGrant.mockResolvedValue(false);
    mockUserIsWorkspaceMember.mockResolvedValue(true);

    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/mcp/${ORG_A}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN_A}`,
          "X-Atlas-Workspace": ORG_B,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; hint?: string };
      expect(body.error).toBe("cross_workspace_denied");
      expect(body.hint).toContain("Settings");
    } finally {
      handle.close();
    }
  });

  it("multi-scope: 403 when grant exists but the user is no longer a workspace member", async () => {
    bindToken(TOKEN_A, {
      sub: SUB_A,
      jti: "jti_a",
      azp: CLIENT_A,
      scope: "openid mcp:read",
      [WORKSPACE_CLAIM]: ORG_A,
    });
    mockGetOAuthClientScope.mockResolvedValue("multi");
    mockHasWorkspaceGrant.mockResolvedValue(true);
    // Membership revoked since token issuance — must take effect immediately.
    mockUserIsWorkspaceMember.mockResolvedValue(false);

    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/mcp/${ORG_A}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN_A}`,
          "X-Atlas-Workspace": ORG_B,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; hint?: string };
      expect(body.error).toBe("cross_workspace_denied");
      // The hint differs between "no grant" and "no membership" so the
      // user gets actionable advice. Membership revoked → guides them
      // to reconfirm membership; grant missing → points to Settings.
      expect(body.hint).toContain("membership");
      // Audit must record the denial with the membership_revoked reason
      // so forensic queries can split the two failure modes.
      const denial = auditedEntries.find(
        (e) => e.actionType === "mcp_session.denied",
      );
      expect(denial).toBeDefined();
      expect((denial!.metadata as { reason: string }).reason).toBe(
        "membership_revoked",
      );
      expect((denial!.metadata as { resolvedWorkspaceId: string }).resolvedWorkspaceId).toBe(
        ORG_B,
      );
    } finally {
      handle.close();
    }
  });

  it("multi-scope: 500 + denied audit when the admission DB lookup itself throws", async () => {
    bindToken(TOKEN_A, {
      sub: SUB_A,
      jti: "jti_a",
      azp: CLIENT_A,
      scope: "openid mcp:read",
      [WORKSPACE_CLAIM]: ORG_A,
    });
    // Simulate a Postgres outage on the scope lookup. The router catches,
    // logs error, returns 500 internal_error — but MUST emit a denied
    // audit row so the request appears in forensic queries asking
    // "show me every cross-workspace denial today" even when the
    // underlying failure was an internal-DB outage rather than a
    // missing grant.
    mockGetOAuthClientScope.mockRejectedValue(new Error("connection refused"));

    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/mcp/${ORG_A}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN_A}`,
          "X-Atlas-Workspace": ORG_B,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string; requestId: string };
      expect(body.error).toBe("internal_error");
      expect(body.requestId).toBeDefined();
      // No session-start audit (request never reached dispatch).
      expect(
        auditedEntries.filter((e) => e.actionType === "mcp_session.start"),
      ).toHaveLength(0);
      // Denial audit fired with the admission_lookup_failed reason.
      const denial = auditedEntries.find(
        (e) => e.actionType === "mcp_session.denied",
      );
      expect(denial).toBeDefined();
      expect((denial!.metadata as { reason: string }).reason).toBe(
        "admission_lookup_failed",
      );
    } finally {
      handle.close();
    }
  });

  it("multi-scope: session-start audit records the resolved workspace + claim workspace separately", async () => {
    bindToken(TOKEN_A, {
      sub: SUB_A,
      jti: "jti_a",
      azp: CLIENT_A,
      scope: "openid mcp:read",
      [WORKSPACE_CLAIM]: ORG_A,
    });
    mockGetOAuthClientScope.mockResolvedValue("multi");
    mockHasWorkspaceGrant.mockResolvedValue(true);
    mockUserIsWorkspaceMember.mockResolvedValue(true);

    const handle = await startServer();
    try {
      // Path workspace = ORG_A, header overrides to ORG_B → resolved is ORG_B.
      // The audit row's `metadata.orgId` MUST be the resolved workspace
      // (so forensic queries asking "what happened in workspace B today"
      // find this row) and `metadata.claimOrgId` MUST be the JWT singular
      // claim (ORG_A) so the cross-workspace pivot stays reconstructable.
      const res = await fetch(`${handle.url}/mcp/${ORG_A}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN_A}`,
          "X-Atlas-Workspace": ORG_B,
          // Use a JSON-RPC initialize so the session creates and the
          // start audit fires.
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "initialize",
          id: 1,
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "0.0.1" },
          },
        }),
      });
      expect(res.status).toBe(200);
      const startAudit = auditedEntries.find(
        (e) => e.actionType === "mcp_session.start",
      );
      expect(startAudit).toBeDefined();
      const meta = startAudit!.metadata as { orgId: string; claimOrgId?: string };
      expect(meta.orgId).toBe(ORG_B);
      expect(meta.claimOrgId).toBe(ORG_A);
    } finally {
      handle.close();
    }
  });
});

// ── Cross-region residency ────────────────────────────────────────────

describe("hosted MCP — residency", () => {
  it("returns 421 with correctApiUrl mapped to the brand mcp-<region> hostname for SaaS regions (#2068)", async () => {
    // residency.regions[X].apiUrl is the operator-configured public API
    // URL for region X. For the MCP misrouting body we want to direct
    // a client at the brand-mirror surface its config already advertises
    // — `https://mcp-eu.useatlas.dev` — not the underlying `api-eu.*`
    // infra. The mapping is a no-op for self-hosted operators whose
    // apiUrl doesn't match the SaaS regional pattern.
    bindToken(TOKEN_A, {
      sub: SUB_A,
      azp: CLIENT_A,
      scope: "openid mcp:read",
      [WORKSPACE_CLAIM]: ORG_A,
    });
    mockApiRegion.mockImplementation(() => "us-east");
    mockWorkspaceRegion.mockImplementation(async () => "eu-west");
    __mockedConfig.residency = {
      regions: { "eu-west": { apiUrl: "https://api-eu.useatlas.dev" } },
    };
    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/mcp/${ORG_A}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN_A}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(res.status).toBe(421);
      const body = (await res.json()) as {
        error: string;
        correctApiUrl?: string;
        expectedRegion: string;
        actualRegion: string;
      };
      expect(body.error).toBe("misdirected_request");
      expect(body.correctApiUrl).toBe("https://mcp-eu.useatlas.dev");
      expect(body.expectedRegion).toBe("eu-west");
      expect(body.actualRegion).toBe("us-east");
    } finally {
      handle.close();
    }
  });

  it("returns 421 with correctApiUrl unchanged when the configured region apiUrl is non-SaaS (self-hosted)", async () => {
    bindToken(TOKEN_A, {
      sub: SUB_A,
      azp: CLIENT_A,
      scope: "openid mcp:read",
      [WORKSPACE_CLAIM]: ORG_A,
    });
    mockApiRegion.mockImplementation(() => "us-east");
    mockWorkspaceRegion.mockImplementation(async () => "eu-west");
    __mockedConfig.residency = {
      regions: { "eu-west": { apiUrl: "https://api.example.test" } },
    };
    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/mcp/${ORG_A}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN_A}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      const body = (await res.json()) as { correctApiUrl?: string };
      expect(body.correctApiUrl).toBe("https://api.example.test");
    } finally {
      handle.close();
    }
  });

  it("returns 503 region_unavailable (fail-closed) when the region lookup throws", async () => {
    bindToken(TOKEN_A, {
      sub: SUB_A,
      azp: CLIENT_A,
      scope: "openid mcp:read",
      [WORKSPACE_CLAIM]: ORG_A,
    });
    mockApiRegion.mockImplementation(() => "us-east");
    mockWorkspaceRegion.mockImplementation(async () => {
      throw new Error("internal db down");
    });
    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/mcp/${ORG_A}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN_A}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        error: string;
        requestId: string;
      };
      expect(body.error).toBe("region_unavailable");
      expect(body.requestId).toBeTruthy();
      expect(
        auditedEntries.filter((e) => e.actionType === "mcp_session.start"),
      ).toHaveLength(0);
      expect(_hostedSessionCount()).toBe(0);
    } finally {
      handle.close();
    }
  });

  it("does not emit mcp_session.start when residency check fires 421", async () => {
    bindToken(TOKEN_A, {
      sub: SUB_A,
      azp: CLIENT_A,
      scope: "openid mcp:read",
      [WORKSPACE_CLAIM]: ORG_A,
    });
    mockApiRegion.mockImplementation(() => "us-east");
    mockWorkspaceRegion.mockImplementation(async () => "eu-west");
    const handle = await startServer();
    try {
      await fetch(`${handle.url}/mcp/${ORG_A}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN_A}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(
        auditedEntries.filter((e) => e.actionType === "mcp_session.start"),
      ).toHaveLength(0);
    } finally {
      handle.close();
    }
  });
});

// ── End-to-end MCP session ────────────────────────────────────────────

describe("hosted MCP — successful session", () => {
  it("connects an MCP client through the route and lists tools", async () => {
    bindToken(TOKEN_A, {
      sub: SUB_A,
      azp: CLIENT_A,
      scope: "openid mcp:read",
      [WORKSPACE_CLAIM]: ORG_A,
    });
    const handle = await startServer();
    try {
      const client = new Client({
        name: "test-hosted-client",
        version: "0.0.1",
      });
      const transport = new StreamableHTTPClientTransport(
        new URL(`${handle.url}/mcp/${ORG_A}/sse`),
        {
          requestInit: {
            headers: { Authorization: `Bearer ${TOKEN_A}` },
          },
        },
      );
      await client.connect(transport);

      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toContain("listEntities");
      expect(names).toContain("describeEntity");
      expect(names).toContain("explore");
      expect(names).toContain("executeSQL");

      await client.close();
    } finally {
      handle.close();
    }
  });

  it("emits mcp_session.start exactly once per session — not per JSON-RPC frame", async () => {
    bindToken(TOKEN_A, {
      sub: SUB_A,
      jti: "jti_a",
      azp: CLIENT_A,
      scope: "openid mcp:read",
      [WORKSPACE_CLAIM]: ORG_A,
    });
    mockApiRegion.mockImplementation(() => "us-east");
    const handle = await startServer();
    try {
      const client = new Client({
        name: "test-hosted-client",
        version: "0.0.1",
      });
      const transport = new StreamableHTTPClientTransport(
        new URL(`${handle.url}/mcp/${ORG_A}/sse`),
        {
          requestInit: {
            headers: { Authorization: `Bearer ${TOKEN_A}` },
          },
        },
      );
      await client.connect(transport);

      await client.listTools();
      await client.listTools();
      await client.listResources();

      const startRows = auditedEntries.filter(
        (e) => e.actionType === "mcp_session.start",
      );
      expect(startRows).toHaveLength(1);
      expect(startRows[0].targetType).toBe("mcp_session");
      const meta = startRows[0].metadata as
        | {
            sessionId: string;
            orgId: string;
            clientId: string;
            tokenJti?: string;
            region?: string;
            scopes?: string[];
          }
        | undefined;
      expect(meta?.orgId).toBe(ORG_A);
      expect(meta?.clientId).toBe(CLIENT_A);
      expect(meta?.region).toBe("us-east");
      expect(meta?.tokenJti).toBe("jti_a");
      expect(meta?.scopes).toEqual(["openid", "mcp:read"]);
      expect(typeof meta?.sessionId).toBe("string");

      await client.close();
    } finally {
      handle.close();
    }
  });

  it("isolates sessions across workspaces — distinct audit rows per client/workspace", async () => {
    // The audit row's `metadata.orgId` and `metadata.clientId` come
    // from the verified JWT payload that is also used to construct
    // the `actor` for `createAtlasMcpServer`. Distinct values per
    // session prove the bearer-derived identity is threaded through
    // the whole pipeline, not shared across concurrent sessions.
    bindTokensAB();
    const handle = await startServer();
    try {
      const clientA = new Client({ name: "client-a", version: "0.0.1" });
      const transportA = new StreamableHTTPClientTransport(
        new URL(`${handle.url}/mcp/${ORG_A}/sse`),
        {
          requestInit: { headers: { Authorization: `Bearer ${TOKEN_A}` } },
        },
      );
      const clientB = new Client({ name: "client-b", version: "0.0.1" });
      const transportB = new StreamableHTTPClientTransport(
        new URL(`${handle.url}/mcp/${ORG_B}/sse`),
        {
          requestInit: { headers: { Authorization: `Bearer ${TOKEN_B}` } },
        },
      );

      await clientA.connect(transportA);
      await clientB.connect(transportB);

      expect(_hostedSessionCount()).toBeGreaterThanOrEqual(2);

      const startRows = auditedEntries.filter(
        (e) => e.actionType === "mcp_session.start",
      );
      expect(startRows).toHaveLength(2);

      const orgIds = startRows
        .map((r) => (r.metadata as { orgId: string }).orgId)
        .sort();
      expect(orgIds).toEqual([ORG_A, ORG_B].sort());

      const clientIds = startRows
        .map((r) => (r.metadata as { clientId: string }).clientId)
        .sort();
      expect(clientIds).toEqual([CLIENT_A, CLIENT_B].sort());

      // Each (orgId, clientId) pair is consistent — workspace A's
      // audit row carries claude-desktop, not cursor.
      for (const row of startRows) {
        const meta = row.metadata as { orgId: string; clientId: string };
        if (meta.orgId === ORG_A) expect(meta.clientId).toBe(CLIENT_A);
        if (meta.orgId === ORG_B) expect(meta.clientId).toBe(CLIENT_B);
      }

      await clientA.close();
      await clientB.close();
    } finally {
      handle.close();
    }
  });
});

// ── Session lifecycle ────────────────────────────────────────────────

describe("hosted MCP — session lifecycle", () => {
  it("returns 404 unknown_session when mcp-session-id points at a nonexistent session", async () => {
    bindToken(TOKEN_A, {
      sub: SUB_A,
      azp: CLIENT_A,
      scope: "openid mcp:read",
      [WORKSPACE_CLAIM]: ORG_A,
    });
    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/mcp/${ORG_A}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN_A}`,
          "mcp-session-id": "00000000-0000-0000-0000-000000000000",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as {
        error: string;
        requestId: string;
      };
      expect(body.error).toBe("unknown_session");
      expect(body.requestId).toBeTruthy();
    } finally {
      handle.close();
    }
  });

  it("supports DELETE for explicit session termination", async () => {
    bindToken(TOKEN_A, {
      sub: SUB_A,
      azp: CLIENT_A,
      scope: "openid mcp:read",
      [WORKSPACE_CLAIM]: ORG_A,
    });
    const handle = await startServer();
    try {
      const client = new Client({ name: "client-delete", version: "0.0.1" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`${handle.url}/mcp/${ORG_A}/sse`),
        {
          requestInit: { headers: { Authorization: `Bearer ${TOKEN_A}` } },
        },
      );
      await client.connect(transport);
      expect(_hostedSessionCount()).toBeGreaterThanOrEqual(1);

      // The SDK's transport.terminateSession() issues the DELETE on
      // the session URL with the mcp-session-id header — the canonical
      // way for clients to tear down. We exercise it here so a future
      // regression that drops DELETE from HANDLED_METHODS is caught.
      await transport.terminateSession();
      // Allow the SDK's onsessionclosed callback to drain.
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(_hostedSessionCount()).toBe(0);

      await client.close().catch(() => {});
    } finally {
      handle.close();
    }
  });
});

// ── Capacity and reliability ─────────────────────────────────────────

describe("hosted MCP — capacity", () => {
  it("returns 503 too_many_sessions when the cap is reached", async () => {
    bindToken(TOKEN_A, {
      sub: SUB_A,
      azp: CLIENT_A,
      scope: "openid mcp:read",
      [WORKSPACE_CLAIM]: ORG_A,
    });
    process.env.ATLAS_MCP_MAX_SESSIONS = "1";
    const handle = await startServer();
    try {
      const client = new Client({ name: "client-capacity", version: "0.0.1" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`${handle.url}/mcp/${ORG_A}/sse`),
        {
          requestInit: { headers: { Authorization: `Bearer ${TOKEN_A}` } },
        },
      );
      await client.connect(transport);
      expect(_hostedSessionCount()).toBe(1);

      // Second session-init must be rejected before any McpServer is
      // even allocated.
      const res = await fetch(`${handle.url}/mcp/${ORG_A}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${TOKEN_A}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "raw", version: "0.0.1" },
          },
          id: 1,
        }),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("too_many_sessions");

      await client.close();
    } finally {
      handle.close();
    }
  });

  it("evicts idle sessions on cap-pressure so a new connection can land", async () => {
    // Reproduces the prod incident: prior runs leaked sessions
    // (Streamable HTTP has no transport-disconnect event for clients
    // that vanish), pinning the cap until container restart. With the
    // sweep, a cap-hit triggers eviction of stale entries first.
    bindToken(TOKEN_A, {
      sub: SUB_A,
      azp: CLIENT_A,
      scope: "openid mcp:read",
      [WORKSPACE_CLAIM]: ORG_A,
    });
    process.env.ATLAS_MCP_MAX_SESSIONS = "1";
    process.env.ATLAS_MCP_SESSION_IDLE_TIMEOUT_MS = "60000"; // 1 min — at the floor
    const handle = await startServer();
    try {
      // Open one session — fills the cap.
      const first = new Client({ name: "client-stale", version: "0.0.1" });
      const firstTransport = new StreamableHTTPClientTransport(
        new URL(`${handle.url}/mcp/${ORG_A}/sse`),
        { requestInit: { headers: { Authorization: `Bearer ${TOKEN_A}` } } },
      );
      await first.connect(firstTransport);
      expect(_hostedSessionCount()).toBe(1);

      // Without the sweep this would 503. The sweep with a clock far
      // enough in the future evicts the stale entry, freeing a slot.
      // The test drives the sweep directly (not via cap-hit) so the
      // assertion is unambiguous: sweep evicts, count drops, cap clears.
      const farFuture = Date.now() + 24 * 60 * 60 * 1000; // +1 day
      const evicted = _sweepIdleSessionsForTests(farFuture, 60_000);
      expect(evicted).toBe(1);
      expect(_hostedSessionCount()).toBe(0);

      // The originally-leaked client object is now orphaned; the
      // server-side transport+server were closed by the sweep. A new
      // connection can land cleanly because the cap is no longer
      // saturated.
      const second = new Client({ name: "client-fresh", version: "0.0.1" });
      const secondTransport = new StreamableHTTPClientTransport(
        new URL(`${handle.url}/mcp/${ORG_A}/sse`),
        { requestInit: { headers: { Authorization: `Bearer ${TOKEN_A}` } } },
      );
      await second.connect(secondTransport);
      expect(_hostedSessionCount()).toBe(1);

      await second.close();
    } finally {
      delete process.env.ATLAS_MCP_SESSION_IDLE_TIMEOUT_MS;
      handle.close();
    }
  });

  it("preserves recently-active sessions across a sweep", async () => {
    // The sweep must NOT touch sessions whose lastSeenAt is within
    // the idle window — a busy region with hundreds of healthy
    // sessions cannot have one stray sweep wipe legitimate users.
    bindToken(TOKEN_A, {
      sub: SUB_A,
      azp: CLIENT_A,
      scope: "openid mcp:read",
      [WORKSPACE_CLAIM]: ORG_A,
    });
    process.env.ATLAS_MCP_MAX_SESSIONS = "5";
    process.env.ATLAS_MCP_SESSION_IDLE_TIMEOUT_MS = "60000";
    const handle = await startServer();
    try {
      const client = new Client({ name: "client-active", version: "0.0.1" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`${handle.url}/mcp/${ORG_A}/sse`),
        { requestInit: { headers: { Authorization: `Bearer ${TOKEN_A}` } } },
      );
      await client.connect(transport);
      expect(_hostedSessionCount()).toBe(1);

      // Sweep with a clock that is JUST under the idle threshold —
      // session was created moments ago, so lastSeenAt is fresh.
      // Eviction count must be 0; session must still be usable.
      const evicted = _sweepIdleSessionsForTests(Date.now(), 60_000);
      expect(evicted).toBe(0);
      expect(_hostedSessionCount()).toBe(1);

      // Verify the preserved session still functions — listTools is
      // the cheapest dispatch that hits the existing-session path.
      const tools = await client.listTools();
      expect(tools.tools.length).toBeGreaterThan(0);

      await client.close();
    } finally {
      delete process.env.ATLAS_MCP_SESSION_IDLE_TIMEOUT_MS;
      handle.close();
    }
  });

  it("on cap-pressure triggers the sweep automatically (regression for the prod incident)", async () => {
    // End-to-end check: cap=1, open one session, IMMEDIATELY hand-pin
    // its lastSeenAt to a past value to simulate a leaked client, then
    // attempt a new init. The route's lazy sweep should evict the
    // stale entry and accept the new connection without 503.
    bindToken(TOKEN_A, {
      sub: SUB_A,
      azp: CLIENT_A,
      scope: "openid mcp:read",
      [WORKSPACE_CLAIM]: ORG_A,
    });
    process.env.ATLAS_MCP_MAX_SESSIONS = "1";
    // Bypass the production 1-min floor so the test can drive the
    // age-out path with a sub-second sleep instead of a 60s wait.
    // _setIdleTimeoutForTests is the documented test seam; the
    // floor stays in place for production callers.
    _setIdleTimeoutForTests(50); // 50 ms
    const handle = await startServer();
    try {
      // Step 1 — open the session that occupies the cap.
      const leaker = new Client({ name: "client-leaker", version: "0.0.1" });
      const leakerTransport = new StreamableHTTPClientTransport(
        new URL(`${handle.url}/mcp/${ORG_A}/sse`),
        { requestInit: { headers: { Authorization: `Bearer ${TOKEN_A}` } } },
      );
      await leaker.connect(leakerTransport);
      expect(_hostedSessionCount()).toBe(1);

      // Step 2 — wait past the idle window so the leaker is sweepable.
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Step 3 — a fresh init should now succeed because the route's
      // cap-check sweep evicts the stale leaker.
      const fresh = new Client({ name: "client-fresh", version: "0.0.1" });
      const freshTransport = new StreamableHTTPClientTransport(
        new URL(`${handle.url}/mcp/${ORG_A}/sse`),
        { requestInit: { headers: { Authorization: `Bearer ${TOKEN_A}` } } },
      );
      await fresh.connect(freshTransport);

      // Final state: only the fresh session remains; the leaker was
      // swept. The assertion is on count so a future bug that
      // double-counts during the eviction transition would fail it.
      expect(_hostedSessionCount()).toBe(1);

      await fresh.close();
    } finally {
      _setIdleTimeoutForTests(null);
      handle.close();
    }
  });
});

describe("hosted MCP — audit failure", () => {
  it("audit emission failures must not break session creation", async () => {
    bindToken(TOKEN_A, {
      sub: SUB_A,
      azp: CLIENT_A,
      scope: "openid mcp:read",
      [WORKSPACE_CLAIM]: ORG_A,
    });
    mockLogAdminAction.mockImplementation(() => {
      throw new Error("pino broken");
    });
    const handle = await startServer();
    try {
      const client = new Client({ name: "client-audit", version: "0.0.1" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`${handle.url}/mcp/${ORG_A}/sse`),
        {
          requestInit: { headers: { Authorization: `Bearer ${TOKEN_A}` } },
        },
      );
      // `connect()` performs initialize + listTools — both must succeed
      // even though the audit emit threw on session-init.
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.length).toBeGreaterThan(0);
      await client.close();
    } finally {
      handle.close();
    }
  });
});
