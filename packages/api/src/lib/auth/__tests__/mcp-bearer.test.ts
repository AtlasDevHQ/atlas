/**
 * Tests for the MCP bearer-token validator (#2024).
 *
 * Covers `validateMcpBearer(req)` in isolation: the lookup path is
 * mocked at module-scope (via `mock.module`) so this file exercises
 * the validator's branching (header parsing, error mapping,
 * AtlasUser construction) without touching the DB. The full
 * token-lookup path has its own tests in `mcp-token.test.ts`.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  mock,
  type Mock,
} from "bun:test";
import type { ResolvedMcpIdentity } from "../mcp-token";

// ── Module-scope mock ─────────────────────────────────────────────
//
// `mock.module()` runs once at module load and binds for the rest of
// the suite. Tests change behaviour by replacing the impl on
// `mockLookup` via `.mockImplementation`, which the inner factory
// reads on every call.

const mockLookup: Mock<(bearer: string) => Promise<ResolvedMcpIdentity | null>> =
  mock(async () => null);

mock.module("../mcp-token", () => ({
  // Mock every named export — partial mocks throw `SyntaxError:
  // Export not found` when something else in the suite imports a
  // sibling export from the same module.
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
    throw new Error("unexpected createMcpToken in mcp-bearer test");
  },
  listMcpTokensForOrg: async () => [],
  revokeMcpToken: async () => ({ revoked: false, alreadyRevokedAt: null }),
  __INTERNAL: {
    TOKEN_PREFIX: "atl_mcp_",
    TOKEN_TOTAL_LEN: 40,
    LAST_USED_TOUCH_INTERVAL_MS: 60_000,
  },
}));

// Module-under-test imports the mocked module, so this `import` must
// follow the `mock.module` call above.
import { validateMcpBearer } from "../mcp-bearer";

beforeEach(() => {
  mockLookup.mockReset();
  mockLookup.mockImplementation(async () => null);
});

afterAll(() => {
  mock.restore();
});

const VALID_BEARER = "atl_mcp_aaaaaaaa" + "b".repeat(24);

function makeReq(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/mcp/sse", { headers });
}

// ── Header parsing ─────────────────────────────────────────────────

describe("validateMcpBearer — header parsing", () => {
  it("returns 401 'MCP token required' when no Authorization header is present", async () => {
    const result = await validateMcpBearer(makeReq());
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(401);
      expect(result.error).toBe("MCP token required");
    }
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("returns 401 when the Authorization header uses a non-Bearer scheme", async () => {
    const result = await validateMcpBearer(
      makeReq({ Authorization: "Basic abc:def" }),
    );
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(401);
      // Same wording as the no-header case so there's no
      // enumeration oracle.
      expect(result.error).toBe("MCP token required");
    }
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("forwards the bearer body (after `Bearer `) to the lookup", async () => {
    let received = "";
    mockLookup.mockImplementation(async (bearer: string) => {
      received = bearer;
      return null;
    });
    await validateMcpBearer(
      makeReq({ Authorization: "Bearer my-bearer-body" }),
    );
    expect(received).toBe("my-bearer-body");
  });
});

// ── Lookup outcomes ───────────────────────────────────────────────

describe("validateMcpBearer — lookup outcomes", () => {
  it("returns 401 'Invalid MCP token' when the lookup returns null", async () => {
    mockLookup.mockImplementation(async () => null);
    const result = await validateMcpBearer(
      makeReq({ Authorization: `Bearer ${VALID_BEARER}` }),
    );
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(401);
      expect(result.error).toBe("Invalid MCP token");
    }
  });

  it("returns 500 when the lookup throws (DB outage / decrypt error)", async () => {
    mockLookup.mockImplementation(async () => {
      throw new Error("DB exploded");
    });
    const result = await validateMcpBearer(
      makeReq({ Authorization: `Bearer ${VALID_BEARER}` }),
    );
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(500);
      expect(result.error).toBe("MCP authentication system error");
    }
  });

  it("authenticates and builds an AtlasUser from the resolved identity", async () => {
    mockLookup.mockImplementation(async () => ({
      tokenId: "mcp_111",
      orgId: "org-a",
      userId: "user-1",
      scopes: ["mcp:read"],
    }));
    const result = await validateMcpBearer(
      makeReq({ Authorization: `Bearer ${VALID_BEARER}` }),
    );
    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.mode).toBe("managed");
      expect(result.user!.id).toBe("user-1");
      expect(result.user!.mode).toBe("managed");
      expect(result.user!.label).toBe("user-1");
      expect(result.user!.role).toBe("member");
      expect(result.user!.activeOrganizationId).toBe("org-a");
      expect(result.user!.claims?.mcpTokenId).toBe("mcp_111");
      expect(result.user!.claims?.mcpScopes).toEqual(["mcp:read"]);
    }
  });

  it("falls back to a synthetic user id when the token is not bound to a user", async () => {
    mockLookup.mockImplementation(async () => ({
      tokenId: "mcp_111",
      orgId: "org-a",
      userId: null,
      scopes: [],
    }));
    const result = await validateMcpBearer(
      makeReq({ Authorization: `Bearer ${VALID_BEARER}` }),
    );
    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.user!.id).toBe("mcp:mcp_111");
      expect(result.user!.label).toBe("mcp-mcp_111");
      expect(result.user!.activeOrganizationId).toBe("org-a");
    }
  });

  it("isolates workspaces — AuthContext.orgId is taken from the row, not the request", async () => {
    // The validator never reads any caller-supplied org hint. The
    // resolved identity's orgId becomes the AuthContext.orgId, no
    // matter what the request URL or headers claim. This is the
    // workspace-isolation guarantee at the auth boundary: a token
    // for org-a cannot impersonate org-b by URL or header tampering.
    mockLookup.mockImplementation(async () => ({
      tokenId: "mcp_111",
      orgId: "org-a",
      userId: "user-1",
      scopes: [],
    }));
    const result = await validateMcpBearer(
      makeReq({
        Authorization: `Bearer ${VALID_BEARER}`,
        "x-atlas-org": "org-b",
      }),
    );
    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.user!.activeOrganizationId).toBe("org-a");
    }
  });
});
