/**
 * Tests for the hosted MCP Hono router (#2024 PR B / #2028).
 *
 * Covers the route-layer behavior:
 *   - bearer required (401 on missing/invalid token, via mcpBearerAuth)
 *   - path workspaceId must match bearer's orgId (403 on mismatch)
 *   - cross-region detected by detectMisrouting → 421 with correctApiUrl
 *   - successful initialize → MCP session created, tools listable
 *   - mcp_token.use audit emitted exactly once per session, not per call
 *
 * Mocks the bearer lookup, residency check, and audit emitter so the
 * test exercises the route's branching without standing up the
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
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import type { ResolvedMcpIdentity } from "@atlas/api/lib/auth/mcp-token";
import type { MisroutingResult } from "@atlas/api/lib/residency/misrouting";
import type { AdminActionEntry } from "@atlas/api/lib/audit";

// ── Module-scope mocks ────────────────────────────────────────────────
//
// Same partial-mock guidance as the sse.test.ts neighbour: every named
// export from a mocked module must be present, otherwise sibling files
// that import a different export from the same module break with
// `SyntaxError: Export named 'X' not found`.

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

const mockMisrouting: Mock<
  (orgId: string | undefined, requestId: string) => Promise<MisroutingResult | null>
> = mock(async () => null);
const mockApiRegion: Mock<() => string | null> = mock(() => null);

mock.module("@atlas/api/lib/residency/misrouting", () => ({
  detectMisrouting: (orgId: string | undefined, requestId: string) =>
    mockMisrouting(orgId, requestId),
  getApiRegion: () => mockApiRegion(),
  isStrictRoutingEnabled: () => false,
  getMisroutedCount: () => 0,
  _resetMisroutedCount: () => undefined,
  _resetRegionCache: () => undefined,
}));

// Capture every audit emission so we can assert the per-session
// sampling contract.
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

// Atlas config mock — same shape as sse.test.ts so server boot
// doesn't require a real database.
const __mockedConfig = {
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

// Import after mocks. Use dynamic imports so module-graph cache picks
// up the mocked versions.
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

function userFor(orgId: string, tokenId: string) {
  return createAtlasUser(`u_${tokenId}`, "managed", `member-${tokenId}`, {
    role: "member",
    activeOrganizationId: orgId,
    claims: { mcpTokenId: tokenId, mcpScopes: [] },
  });
}

beforeEach(() => {
  mockLookup.mockReset();
  mockMisrouting.mockReset();
  mockApiRegion.mockReset();
  mockLogAdminAction.mockReset();
  auditedEntries.length = 0;
  mockMisrouting.mockImplementation(async () => null);
  mockApiRegion.mockImplementation(() => null);
  mockLogAdminAction.mockImplementation((entry) => {
    auditedEntries.push(entry);
  });
});

afterEach(async () => {
  await _resetHostedSessions();
});

afterAll(() => {
  mock.restore();
});

// Build a Hono app with the router mounted under /mcp — mirrors the
// production mount point in packages/api/src/api/index.ts. Bun.serve
// off port 0 gives an ephemeral port for in-process tests.
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
  it("returns 403 when the path workspaceId does not match the bearer's org", async () => {
    mockLookup.mockImplementation(async (bearer) => {
      // Bearer A is bound to ORG_A — but the path will say ORG_B.
      if (bearer === BEARER_A) {
        return {
          tokenId: TOKEN_ID_A,
          orgId: ORG_A,
          userId: `u_${TOKEN_ID_A}`,
          scopes: [],
        };
      }
      return null;
    });
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
      // 403, NOT 404 — 404 would leak whether the path workspace exists.
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("forbidden");
      // No audit row — the request never made it to session-init.
      const useRows = auditedEntries.filter(
        (e) => e.actionType === "mcp_token.use",
      );
      expect(useRows).toHaveLength(0);
    } finally {
      handle.close();
    }
  });
});

// ── Cross-region 421 ──────────────────────────────────────────────────

describe("hosted MCP — cross-region residency", () => {
  it("returns 421 with correctApiUrl when workspace region differs from this instance", async () => {
    mockLookup.mockImplementation(async () => ({
      tokenId: TOKEN_ID_A,
      orgId: ORG_A,
      userId: `u_${TOKEN_ID_A}`,
      scopes: [],
    }));
    // Workspace lives in eu-west, this instance is us-east — fire 421
    // even though strictRouting is off.
    mockMisrouting.mockImplementation(async () => ({
      expectedRegion: "eu-west",
      actualRegion: "us-east",
      correctApiUrl: "https://api-eu.useatlas.dev",
    }));
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

  it("does not emit mcp_token.use when residency check fires 421", async () => {
    mockLookup.mockImplementation(async () => ({
      tokenId: TOKEN_ID_A,
      orgId: ORG_A,
      userId: `u_${TOKEN_ID_A}`,
      scopes: [],
    }));
    mockMisrouting.mockImplementation(async () => ({
      expectedRegion: "eu-west",
      actualRegion: "us-east",
    }));
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
      const useRows = auditedEntries.filter(
        (e) => e.actionType === "mcp_token.use",
      );
      expect(useRows).toHaveLength(0);
    } finally {
      handle.close();
    }
  });
});

// ── End-to-end MCP session ────────────────────────────────────────────

describe("hosted MCP — successful session", () => {
  it("connects an MCP client through the route and lists tools", async () => {
    mockLookup.mockImplementation(async () => ({
      tokenId: TOKEN_ID_A,
      orgId: ORG_A,
      userId: `u_${TOKEN_ID_A}`,
      scopes: [],
    }));
    void userFor;
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
      // Should include the typed semantic-layer tools shipped in #2031
      // alongside explore and executeSQL.
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
    mockLookup.mockImplementation(async () => ({
      tokenId: TOKEN_ID_A,
      orgId: ORG_A,
      userId: `u_${TOKEN_ID_A}`,
      scopes: [],
    }));
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

      // Multiple JSON-RPC frames in the same session.
      await client.listTools();
      await client.listTools();
      await client.listResources();

      const useRows = auditedEntries.filter(
        (e) => e.actionType === "mcp_token.use",
      );
      expect(useRows).toHaveLength(1);
      expect(useRows[0].targetType).toBe("mcp_token");
      expect(useRows[0].targetId).toBe(TOKEN_ID_A);
      // Audit metadata pivots forensic queries on session/region.
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

  it("isolates sessions across workspaces — bearer A and bearer B never share state", async () => {
    mockLookup.mockImplementation(async (bearer) => {
      if (bearer === BEARER_A) {
        return {
          tokenId: TOKEN_ID_A,
          orgId: ORG_A,
          userId: `u_${TOKEN_ID_A}`,
          scopes: [],
        };
      }
      if (bearer === BEARER_B) {
        return {
          tokenId: TOKEN_ID_B,
          orgId: ORG_B,
          userId: `u_${TOKEN_ID_B}`,
          scopes: [],
        };
      }
      return null;
    });
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

      await clientA.close();
      await clientB.close();
    } finally {
      handle.close();
    }
  });
});
