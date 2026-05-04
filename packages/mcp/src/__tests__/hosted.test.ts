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

// ── Module-scope mocks ────────────────────────────────────────────────
//
// CLAUDE.md: every named export of a mocked module must be present.
// Partial mocks leak via the in-process Bun runner and break unrelated
// test files with `Export named 'X' not found`.

// The custom claim hosted.ts reads to derive the workspace.
const WORKSPACE_CLAIM = "https://atlas.useatlas.dev/workspace_id";

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
const { createHostedMcpRouter, _resetHostedSessions, _hostedSessionCount } =
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

  it("returns 401 when verifyAccessToken throws", async () => {
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
    } finally {
      handle.close();
    }
  });

  it("returns 401 missing_workspace_claim when token has no workspace_id custom claim", async () => {
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
    } finally {
      handle.close();
    }
  });

  it("returns 401 missing_subject when JWT carries no sub claim", async () => {
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
    } finally {
      handle.close();
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
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("forbidden");
      expect(
        auditedEntries.filter((e) => e.actionType === "mcp_session.start"),
      ).toHaveLength(0);
    } finally {
      handle.close();
    }
  });
});

// ── Cross-region residency ────────────────────────────────────────────

describe("hosted MCP — residency", () => {
  it("returns 421 with correctApiUrl when workspace region differs from this instance", async () => {
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
      expect(body.correctApiUrl).toBe("https://api-eu.useatlas.dev");
      expect(body.expectedRegion).toBe("eu-west");
      expect(body.actualRegion).toBe("us-east");
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
