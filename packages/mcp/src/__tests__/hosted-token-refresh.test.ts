/**
 * Hosted-MCP token refresh + expiry verifier-level tests (#2066).
 *
 * The browser e2e (`e2e/browser/mcp-token-refresh.spec.ts`) covers the
 * full register → expire → refresh dance against a live Better Auth
 * issuer. This file mirrors the failure-mode branches at the verifier
 * level — no browser, no real OAuth server — so a regression in the
 * 401 + WWW-Authenticate shape fails fast on every PR.
 *
 * Three branches the production hosted route must handle correctly:
 *
 *   1. Stale JWT (post-expiry, pre-refresh) — verify the route 401s
 *      with `WWW-Authenticate: Bearer ... resource_metadata=...`. The
 *      MCP SDK reads that header to bootstrap the refresh exchange.
 *      A regression that drops the header silently breaks every
 *      compliant client in production.
 *
 *   2. Refresh-token-expired path (post-refresh-failure, post-resource-
 *      server retry) — same 401 shape as expired-access. The contract
 *      is "client treats both the same"; the auth server is the only
 *      site that knows the difference.
 *
 *   3. Client-revoked-mid-session — when an admin or the user revokes
 *      the OAuth client between two frames, the next bearer-bearing
 *      frame must 401 with the same envelope. No leakage of *why*
 *      (user-revoke vs admin-revoke vs natural expiry) in the body.
 *
 * verifyAccessToken is mocked to fold each underlying failure mode
 * (signature / audience / expired / revoked) into the single
 * `throws` path the production verifier collapses them to.
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
import type { AdminActionEntry } from "@atlas/api/lib/audit";
import { ATLAS_OAUTH_WORKSPACE_CLAIM as WORKSPACE_CLAIM } from "@atlas/api/lib/auth/oauth-claims";

// ── Module-scope mocks (mirrors hosted.test.ts) ──────────────────────

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
  authorizationCodeRequest: () => {
    throw new Error("authorizationCodeRequest called from refresh test");
  },
  clientCredentialsToken: () => {
    throw new Error("clientCredentialsToken called from refresh test");
  },
  clientCredentialsTokenRequest: () => {
    throw new Error("clientCredentialsTokenRequest called from refresh test");
  },
  createAuthorizationCodeRequest: () => {
    throw new Error("createAuthorizationCodeRequest called from refresh test");
  },
  createAuthorizationURL: () => {
    throw new Error("createAuthorizationURL called from refresh test");
  },
  createClientCredentialsTokenRequest: () => {
    throw new Error("createClientCredentialsTokenRequest called from refresh test");
  },
  createRefreshAccessTokenRequest: () => {
    throw new Error("createRefreshAccessTokenRequest called from refresh test");
  },
  decryptOAuthToken: () => {
    throw new Error("decryptOAuthToken called from refresh test");
  },
  generateCodeChallenge: () => {
    throw new Error("generateCodeChallenge called from refresh test");
  },
  generateState: () => {
    throw new Error("generateState called from refresh test");
  },
  getJwks: () => {
    throw new Error("getJwks called from refresh test");
  },
  getOAuth2Tokens: () => {
    throw new Error("getOAuth2Tokens called from refresh test");
  },
  handleOAuthUserInfo: () => {
    throw new Error("handleOAuthUserInfo called from refresh test");
  },
  parseState: () => {
    throw new Error("parseState called from refresh test");
  },
  refreshAccessToken: () => {
    throw new Error("refreshAccessToken called from refresh test");
  },
  refreshAccessTokenRequest: () => {
    throw new Error("refreshAccessTokenRequest called from refresh test");
  },
  setTokenUtil: () => {
    throw new Error("setTokenUtil called from refresh test");
  },
  validateAuthorizationCode: () => {
    throw new Error("validateAuthorizationCode called from refresh test");
  },
  validateToken: () => {
    throw new Error("validateToken called from refresh test");
  },
  verifyJwsAccessToken: () => {
    throw new Error("verifyJwsAccessToken called from refresh test");
  },
}));

mock.module("@atlas/api/lib/residency/misrouting", () => ({
  detectMisrouting: async () => null,
  getApiRegion: () => null,
  isStrictRoutingEnabled: () => false,
  getMisroutedCount: () => 0,
  _resetMisroutedCount: () => undefined,
  _resetRegionCache: () => undefined,
}));

mock.module("@atlas/api/lib/db/internal", () => {
  const notUsed = (name: string) => () => {
    throw new Error(`db/internal.${name} called from refresh test — add a mock`);
  };
  return {
    getWorkspaceRegion: async () => null,
    hasInternalDB: () => true,
    internalQuery: notUsed("internalQuery"),
    internalExecute: notUsed("internalExecute"),
    getInternalDB: notUsed("getInternalDB"),
    assignWorkspaceRegion: notUsed("assignWorkspaceRegion"),
    isWorkspaceMigrating: async () => false,
    closeInternalDB: async () => undefined,
  };
});

const auditedEntries: AdminActionEntry[] = [];
const mockLogAdminAction: Mock<(entry: AdminActionEntry) => void> = mock(
  (entry) => {
    auditedEntries.push(entry);
  },
);

mock.module("@atlas/api/lib/audit", () => ({
  ADMIN_ACTIONS: {
    mcp_session: { start: "mcp_session.start" },
    oauth_token: { refresh: "oauth_token.refresh" },
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
}

const __mockedConfig: MockedConfig = {
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
    execute: mock(async () => "catalog.yml"),
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
const { createHostedMcpRouter, _resetHostedSessions } = await import("../hosted.js");

// ── Test fixtures ─────────────────────────────────────────────────────

const ORG = "org_a";
const CLIENT_ID = "claude-desktop";
const SUB = "user_a";
const STALE_TOKEN = "fake.jwt.stale";

beforeEach(() => {
  mockVerifyAccessToken.mockReset();
  mockLogAdminAction.mockReset();
  mockLogAdminAction.mockImplementation((entry) => {
    auditedEntries.push(entry);
  });
  auditedEntries.length = 0;
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

// ── Tests ─────────────────────────────────────────────────────────────

describe("hosted MCP — refresh contract", () => {
  it("rejects a stale (expired) JWT with 401 + WWW-Authenticate pointing at resource metadata", async () => {
    // Production verifier collapses signature / audience / expired into
    // a single throw. We mimic the expired-token shape jose emits — the
    // route's behavior is identical regardless of underlying cause, but
    // the assertion comment names the intent.
    mockVerifyAccessToken.mockImplementation(async () => {
      throw new Error('"exp" claim timestamp check failed');
    });

    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/mcp/${ORG}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${STALE_TOKEN}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string; requestId: string };
      expect(body.error).toBe("invalid_bearer");
      expect(body.requestId).toBeTruthy();

      const wwwAuth = res.headers.get("www-authenticate");
      expect(wwwAuth).toBeTruthy();
      // RFC 9728 + MCP spec: the resource_metadata pointer is the
      // contract that lets the SDK bootstrap a refresh exchange (or
      // re-DCR) without out-of-band config.
      expect(wwwAuth).toContain("Bearer");
      expect(wwwAuth).toContain("resource_metadata=");
      expect(wwwAuth).toContain(`/mcp/${ORG}`);
    } finally {
      handle.close();
    }
  });

  it("returns the same 401 envelope when the OAuth client is revoked mid-session", async () => {
    // Better Auth's verifyAccessToken throws on a token whose underlying
    // oauth client was deleted (the JWKS still verifies the signature,
    // but the introspect/lookup paths fail). The route's contract: same
    // envelope as expired — clients cannot distinguish revoke from
    // expiry from the response body.
    mockVerifyAccessToken.mockImplementation(async () => {
      throw new Error("client not found");
    });

    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/mcp/${ORG}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${STALE_TOKEN}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      // Body must NOT carry the underlying revocation reason — that
      // would let an adversary distinguish "user revoked" from "admin
      // revoked" from "natural expiry" via timing or copy.
      expect(body.error).toBe("invalid_bearer");
      const bodyText = JSON.stringify(body);
      expect(bodyText).not.toContain("revoked");
      expect(bodyText).not.toContain("client not found");

      const wwwAuth = res.headers.get("www-authenticate");
      expect(wwwAuth).toContain("resource_metadata=");
    } finally {
      handle.close();
    }
  });

  it("returns 401 + WWW-Authenticate when the refresh attempt itself failed (refresh-token expired)", async () => {
    // The MCP SDK contract: if the refresh exchange returns
    // 400 invalid_grant, the SDK retries the original frame against
    // the resource server with the still-stale access token. The
    // resource server's response must again be 401 with the
    // resource_metadata pointer so the SDK then triggers re-DCR.
    mockVerifyAccessToken.mockImplementation(async () => {
      throw new Error("invalid_grant");
    });

    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/mcp/${ORG}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${STALE_TOKEN}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: "explore", arguments: { path: "" } },
          id: 1,
        }),
      });

      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain(
        "resource_metadata=",
      );

      // Audit invariant: the resource server's 401 path does NOT emit
      // an `oauth_token.refresh` row — that's the auth server's job
      // (and only fires when refresh succeeded). A regression that
      // emits it here would inflate the success counter.
      expect(
        auditedEntries.some((e) => e.actionType === "oauth_token.refresh"),
      ).toBe(false);
    } finally {
      handle.close();
    }
  });

  it("WWW-Authenticate's resource_metadata URL is workspace-specific", async () => {
    // Each workspace has its own resource. Cross-workspace collisions
    // (same metadata URL for org_a and org_b) would let a token issued
    // for one workspace be replayed against another by following the
    // metadata pointer to the same auth server. The metadata path
    // includes the workspace id explicitly — pin it so a future
    // refactor of `wwwAuthenticateHeader` can't drop the segment.
    mockVerifyAccessToken.mockImplementation(async () => {
      throw new Error("expired");
    });

    const handle = await startServer();
    try {
      const resA = await fetch(`${handle.url}/mcp/org_alpha/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${STALE_TOKEN}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      const resB = await fetch(`${handle.url}/mcp/org_beta/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${STALE_TOKEN}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });

      const wwwAlpha = resA.headers.get("www-authenticate") ?? "";
      const wwwBeta = resB.headers.get("www-authenticate") ?? "";
      expect(wwwAlpha).toContain("/mcp/org_alpha");
      expect(wwwBeta).toContain("/mcp/org_beta");
      expect(wwwAlpha).not.toBe(wwwBeta);
    } finally {
      handle.close();
    }
  });

  it("happy-path verify keeps a fresh token unchallenged (regression guard)", async () => {
    // Negative control: the refresh contract is only loadbearing on the
    // 401 path. A regression that caused every verified token to also
    // emit WWW-Authenticate would silently force every working session
    // through the recovery flow. This pins the negative invariant.
    mockVerifyAccessToken.mockImplementation(async () => ({
      sub: SUB,
      jti: "jti_fresh",
      azp: CLIENT_ID,
      scope: "openid mcp:read",
      [WORKSPACE_CLAIM]: ORG,
    }));

    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/mcp/${ORG}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer fresh.jwt.token`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "0.0.0" },
          },
          id: 1,
        }),
      });

      // The MCP SDK transport may negotiate via SSE; we only assert
      // *not 401* and *no WWW-Authenticate* — the contract for fresh
      // tokens, regardless of whether the response is 200 / 202 /
      // streamed.
      expect(res.status).not.toBe(401);
      expect(res.headers.get("www-authenticate")).toBeNull();
    } finally {
      handle.close();
    }
  });
});
