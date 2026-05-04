/**
 * Tests for the hosted MCP Hono router.
 *
 * Mocks the bearer lookup, region lookup, audit emitter, and config so
 * the test exercises the route's branching without standing up the
 * internal DB or pulling in real plugin/SQL plumbing.
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
import type { ResolvedMcpIdentity } from "@atlas/api/lib/auth/mcp-token";
import type { AdminActionEntry } from "@atlas/api/lib/audit";

// ── Module-scope mocks ────────────────────────────────────────────────
//
// CLAUDE.md: every named export of a mocked module must be present.
// Partial mocks leak via the in-process Bun runner and break unrelated
// test files with `Export named 'X' not found`.

const mockLookup: Mock<(bearer: string) => Promise<ResolvedMcpIdentity | null>> =
  mock(async () => null);

mock.module("@atlas/api/lib/auth/mcp-token", () => ({
  lookupMcpTokenByBearer: (bearer: string) => mockLookup(bearer),
  generateMcpToken: () => ({
    token: "atl_mcp_aaaaaaaa" + "b".repeat(24),
    prefix: "atl_mcp_aaaaaaaa",
    hashHex: "0".repeat(64),
  }),
  hashTokenSha256: (s: string) => s,
  splitTokenPrefix: (s: string) =>
    s.startsWith("atl_mcp_") && s.length === 40 ? s.slice(0, 16) : null,
  createMcpToken: async () => {
    throw new Error("unexpected createMcpToken in hosted test");
  },
  listMcpTokensForOrg: async () => [],
  revokeMcpToken: async () => ({ revoked: false, alreadyRevokedAt: null }),
  computeMcpTokenStatus: () => "active",
  __INTERNAL: {
    TOKEN_PREFIX: "atl_mcp_",
    TOKEN_TOTAL_LEN: 40,
    LAST_USED_TOUCH_INTERVAL_MS: 60_000,
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
    mcp_token: {
      create: "mcp_token.create",
      revoke: "mcp_token.revoke",
      use: "mcp_token.use",
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
const TOKEN_ID_A = "tok_a";
const TOKEN_ID_B = "tok_b";

const BEARER_A = "atl_mcp_aaaaaaaa" + "1".repeat(24);
const BEARER_B = "atl_mcp_bbbbbbbb" + "2".repeat(24);

beforeEach(() => {
  mockLookup.mockReset();
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

function bindBearer(
  bearer: string,
  orgId: string,
  tokenId: string,
): void {
  mockLookup.mockImplementation(async (b) =>
    b === bearer
      ? { tokenId, orgId, userId: `u_${tokenId}`, scopes: [] }
      : null,
  );
}

function bindBearerAB(): void {
  mockLookup.mockImplementation(async (b) => {
    if (b === BEARER_A)
      return {
        tokenId: TOKEN_ID_A,
        orgId: ORG_A,
        userId: `u_${TOKEN_ID_A}`,
        scopes: [],
      };
    if (b === BEARER_B)
      return {
        tokenId: TOKEN_ID_B,
        orgId: ORG_B,
        userId: `u_${TOKEN_ID_B}`,
        scopes: [],
      };
    return null;
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
      expect(body.error).toBe("unauthorized");
      expect(body.requestId).toBeTruthy();
    } finally {
      handle.close();
    }
  });

  it("returns 401 when bearer is unknown", async () => {
    mockLookup.mockImplementation(async () => null);
    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/mcp/${ORG_A}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${BEARER_A}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(res.status).toBe(401);
    } finally {
      handle.close();
    }
  });
});

// ── Path/bearer workspace match ───────────────────────────────────────

describe("hosted MCP — path/bearer workspace match", () => {
  it("returns 403 — never 404 — when path workspaceId does not match the bearer's org", async () => {
    bindBearer(BEARER_A, ORG_A, TOKEN_ID_A);
    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/mcp/${ORG_B}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${BEARER_A}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("forbidden");
      expect(
        auditedEntries.filter((e) => e.actionType === "mcp_token.use"),
      ).toHaveLength(0);
    } finally {
      handle.close();
    }
  });
});

// ── Cross-region residency ────────────────────────────────────────────

describe("hosted MCP — residency", () => {
  it("returns 421 with correctApiUrl when workspace region differs from this instance", async () => {
    bindBearer(BEARER_A, ORG_A, TOKEN_ID_A);
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
          Authorization: `Bearer ${BEARER_A}`,
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
    bindBearer(BEARER_A, ORG_A, TOKEN_ID_A);
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
          Authorization: `Bearer ${BEARER_A}`,
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
      // No session was created — no audit row.
      expect(
        auditedEntries.filter((e) => e.actionType === "mcp_token.use"),
      ).toHaveLength(0);
      expect(_hostedSessionCount()).toBe(0);
    } finally {
      handle.close();
    }
  });

  it("does not emit mcp_token.use when residency check fires 421", async () => {
    bindBearer(BEARER_A, ORG_A, TOKEN_ID_A);
    mockApiRegion.mockImplementation(() => "us-east");
    mockWorkspaceRegion.mockImplementation(async () => "eu-west");
    const handle = await startServer();
    try {
      await fetch(`${handle.url}/mcp/${ORG_A}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${BEARER_A}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(
        auditedEntries.filter((e) => e.actionType === "mcp_token.use"),
      ).toHaveLength(0);
    } finally {
      handle.close();
    }
  });
});

// ── End-to-end MCP session ────────────────────────────────────────────

describe("hosted MCP — successful session", () => {
  it("connects an MCP client through the route and lists tools", async () => {
    bindBearer(BEARER_A, ORG_A, TOKEN_ID_A);
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
            headers: { Authorization: `Bearer ${BEARER_A}` },
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

  it("emits mcp_token.use exactly once per session — not per JSON-RPC frame", async () => {
    bindBearer(BEARER_A, ORG_A, TOKEN_ID_A);
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
            headers: { Authorization: `Bearer ${BEARER_A}` },
          },
        },
      );
      await client.connect(transport);

      await client.listTools();
      await client.listTools();
      await client.listResources();

      const useRows = auditedEntries.filter(
        (e) => e.actionType === "mcp_token.use",
      );
      expect(useRows).toHaveLength(1);
      expect(useRows[0].targetType).toBe("mcp_token");
      expect(useRows[0].targetId).toBe(TOKEN_ID_A);
      const meta = useRows[0].metadata as
        | { sessionId: string; orgId: string; region?: string }
        | undefined;
      expect(meta?.orgId).toBe(ORG_A);
      expect(meta?.region).toBe("us-east");
      expect(typeof meta?.sessionId).toBe("string");

      await client.close();
    } finally {
      handle.close();
    }
  });

  it("isolates sessions across workspaces — distinct audit rows per token", async () => {
    // The audit row's `targetId` (= tokenId) and `metadata.orgId` come
    // from the same `factoryCtx` that is passed as `actor` into
    // `createAtlasMcpServer`. Distinct values per session prove the
    // bearer-derived identity is threaded through the whole pipeline,
    // not shared across concurrent sessions.
    bindBearerAB();
    const handle = await startServer();
    try {
      const clientA = new Client({ name: "client-a", version: "0.0.1" });
      const transportA = new StreamableHTTPClientTransport(
        new URL(`${handle.url}/mcp/${ORG_A}/sse`),
        {
          requestInit: { headers: { Authorization: `Bearer ${BEARER_A}` } },
        },
      );
      const clientB = new Client({ name: "client-b", version: "0.0.1" });
      const transportB = new StreamableHTTPClientTransport(
        new URL(`${handle.url}/mcp/${ORG_B}/sse`),
        {
          requestInit: { headers: { Authorization: `Bearer ${BEARER_B}` } },
        },
      );

      await clientA.connect(transportA);
      await clientB.connect(transportB);

      expect(_hostedSessionCount()).toBeGreaterThanOrEqual(2);

      const useRows = auditedEntries.filter(
        (e) => e.actionType === "mcp_token.use",
      );
      expect(useRows).toHaveLength(2);

      const targetIds = useRows.map((r) => r.targetId).sort();
      expect(targetIds).toEqual([TOKEN_ID_A, TOKEN_ID_B].sort());

      const orgIds = useRows
        .map((r) => (r.metadata as { orgId: string }).orgId)
        .sort();
      expect(orgIds).toEqual([ORG_A, ORG_B].sort());

      // Each (tokenId, orgId) pair is consistent — workspace A's audit
      // row carries token A's id, not token B's.
      for (const row of useRows) {
        const meta = row.metadata as { orgId: string };
        if (row.targetId === TOKEN_ID_A) expect(meta.orgId).toBe(ORG_A);
        if (row.targetId === TOKEN_ID_B) expect(meta.orgId).toBe(ORG_B);
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
    bindBearer(BEARER_A, ORG_A, TOKEN_ID_A);
    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/mcp/${ORG_A}/sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${BEARER_A}`,
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
    bindBearer(BEARER_A, ORG_A, TOKEN_ID_A);
    const handle = await startServer();
    try {
      const client = new Client({ name: "client-delete", version: "0.0.1" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`${handle.url}/mcp/${ORG_A}/sse`),
        {
          requestInit: { headers: { Authorization: `Bearer ${BEARER_A}` } },
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
    bindBearer(BEARER_A, ORG_A, TOKEN_ID_A);
    process.env.ATLAS_MCP_MAX_SESSIONS = "1";
    const handle = await startServer();
    try {
      const client = new Client({ name: "client-capacity", version: "0.0.1" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`${handle.url}/mcp/${ORG_A}/sse`),
        {
          requestInit: { headers: { Authorization: `Bearer ${BEARER_A}` } },
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
          Authorization: `Bearer ${BEARER_A}`,
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
    bindBearer(BEARER_A, ORG_A, TOKEN_ID_A);
    mockLogAdminAction.mockImplementation(() => {
      throw new Error("pino broken");
    });
    const handle = await startServer();
    try {
      const client = new Client({ name: "client-audit", version: "0.0.1" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`${handle.url}/mcp/${ORG_A}/sse`),
        {
          requestInit: { headers: { Authorization: `Bearer ${BEARER_A}` } },
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
