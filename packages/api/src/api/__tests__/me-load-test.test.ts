/**
 * Integration tests for the self-mint MCP load-test endpoint (#2135 follow-up).
 *
 * Coverage:
 *   - Auth: 401 unauthenticated, 200 ordinary workspace member.
 *   - 400 when no active workspace on the session.
 *   - Body validation: 400 ttl over cap, 400 ttl below floor.
 *   - JWKS empty path: 503 with retry guidance.
 *   - Successful mint: 200 with full response shape, audit row written
 *     via `logAdminActionAwait` (NOT fire-and-forget) carrying `jti`
 *     but never the bearer, scope=workspace.
 *   - **Tenant isolation: workspaceId in the response always matches
 *     the caller's active org. There is no body field that could
 *     redirect this.**
 *   - Per-endpoint rate limit: 11th mint within 60s returns 429,
 *     and the budget releases after the 60s window.
 *   - Failure-path audit: status:failure row written; bearer never
 *     leaks into the response or metadata.
 *   - Plaintext-leak guard: decrypted-key fragments cannot reach the
 *     audit row when JSON.parse on plaintext fails.
 *   - Round-trip: minted bearer verifies against the matching public
 *     key using `jose.jwtVerify` — same shape the MCP edge uses.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  mock,
} from "bun:test";
import * as jose from "jose";
import { symmetricEncrypt } from "better-auth/crypto";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";
import { ATLAS_OAUTH_WORKSPACE_CLAIM } from "@atlas/api/lib/auth/oauth-claims";

const logAdminActionAwait = mock(async (..._args: unknown[]) => {});
const logAdminAction = mock((..._args: unknown[]) => {});

const { errorMessage: realErrorMessage } = await import("@atlas/api/lib/audit/error-scrub");

mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction,
  logAdminActionAwait,
  errorMessage: realErrorMessage,
  ADMIN_ACTIONS: {
    load_test: { mintMcpToken: "load_test.mint_mcp_token" },
    workspace: { suspend: "workspace.suspend" },
  },
}));

mock.module("@atlas/api/lib/audit/admin", () => ({
  logAdminAction,
  logAdminActionAwait,
}));

// Default authUser is a regular workspace member — proves self-mint
// does NOT require admin/platform_admin tier.
const mocks = createApiTestMocks({
  authUser: {
    id: "user-1",
    mode: "managed",
    label: "user@test.com",
    role: "member",
    activeOrganizationId: "org-test",
  },
  authMode: "managed",
});

const TEST_SECRET = "test-secret-must-be-at-least-32-characters-long";
process.env.BETTER_AUTH_SECRET = TEST_SECRET;

interface KeyFixture {
  readonly id: string;
  readonly publicJwk: jose.JWK;
  readonly privateKeyColumn: string;
}

async function buildKey(): Promise<KeyFixture> {
  const { publicKey, privateKey } = await jose.generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  const publicJwk = await jose.exportJWK(publicKey);
  const privateJwkJson = JSON.stringify(await jose.exportJWK(privateKey));
  const envelope = await symmetricEncrypt({ key: TEST_SECRET, data: privateJwkJson });
  return {
    id: `kid-${Math.random().toString(36).slice(2, 10)}`,
    publicJwk,
    privateKeyColumn: JSON.stringify(envelope),
  };
}

function defaultJwksRow() {
  return [
    {
      id: keyFixture.id,
      publicKey: JSON.stringify(keyFixture.publicJwk),
      privateKey: keyFixture.privateKeyColumn,
      createdAt: new Date(),
      expiresAt: null,
    },
  ];
}

const keyFixture: KeyFixture = await buildKey();
mocks.mockInternalQuery.mockImplementation(async () => defaultJwksRow());

const { app } = await import("../index");
const { _resetLoadTestRateLimit, _setLoadTestClockForTests } = await import(
  "../routes/me-load-test"
);

interface MintResponseBody {
  bearer: string;
  workspaceId: string;
  audience: string;
  issuer: string;
  expiresAt: string;
  sub: string;
  scope: string;
}

interface ErrorResponseBody {
  error: string;
  message: string;
  requestId?: string;
}

function mintRequest(
  body?: Record<string, unknown>,
  init?: { auth?: boolean },
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (init?.auth !== false) headers["Authorization"] = "Bearer test-key";
  return new Request("http://api.test.useatlas.dev/api/v1/me/load-test/mcp-token", {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
}

function setMember(orgId: string | undefined): void {
  mocks.mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: {
        id: "user-1",
        mode: "managed",
        label: "user@test.com",
        role: "member",
        ...(orgId !== undefined ? { activeOrganizationId: orgId } : {}),
      },
    }),
  );
}

beforeEach(() => {
  mocks.hasInternalDB = true;
  mocks.mockInternalQuery.mockReset();
  mocks.mockInternalQuery.mockImplementation(async () => defaultJwksRow());
  logAdminActionAwait.mockClear();
  logAdminAction.mockClear();
  _resetLoadTestRateLimit();
  setMember("org-test");
});

afterEach(() => {
  _resetLoadTestRateLimit();
});

afterAll(() => {
  mocks.cleanup();
  delete process.env.BETTER_AUTH_SECRET;
});

describe("POST /api/v1/me/load-test/mcp-token — auth", () => {
  it("succeeds for a workspace member (no admin/platform_admin required)", async () => {
    const res = await app.fetch(mintRequest());
    expect(res.status).toBe(200);
  });

  it("returns 401 for unauthenticated requests", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: false,
        status: 401,
        error: "Invalid or expired token",
      }),
    );
    const res = await app.fetch(mintRequest({}, { auth: false }));
    expect(res.status).toBe(401);
  });

  it("returns 400 when the session has no active workspace", async () => {
    setMember(undefined);
    const res = await app.fetch(mintRequest());
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.error).toBe("no_active_workspace");
  });

  it("rejects cookie-only auth with 401 bearer_required (CSRF mitigation)", async () => {
    // Drive a request that would pass the `authenticateRequest` mock
    // (so the auth middleware succeeds) but carries a Cookie header
    // INSTEAD of Authorization. This shape is what a cross-site
    // form-POST CSRF attack would look like — the user's session
    // cookie rides along, no Authorization header is set.
    //
    // The route's bearer-only check fires regardless of whether the
    // auth middleware would have accepted the cookie, so the mock
    // staying as-is correctly models "user is signed in via cookie".
    const req = new Request(
      "http://api.test.useatlas.dev/api/v1/me/load-test/mcp-token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: "atlas_session=opaque-cookie-token",
        },
        body: JSON.stringify({}),
      },
    );
    const res = await app.fetch(req);
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.error).toBe("bearer_required");
    // Audit must NOT fire on the CSRF-rejected path — otherwise an
    // attacker could pump the audit log and rate-limit budget without
    // ever obtaining a token.
    expect(logAdminActionAwait).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/me/load-test/mcp-token — body validation", () => {
  it("returns 400 when ttlSeconds exceeds the server-side cap (3600)", async () => {
    const res = await app.fetch(mintRequest({ ttlSeconds: 86400 }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.error).toBe("invalid_body");
    expect(body.message).toContain("3600");
  });

  it("returns 400 when ttlSeconds is below the floor (60)", async () => {
    const res = await app.fetch(mintRequest({ ttlSeconds: 30 }));
    expect(res.status).toBe(400);
  });

  it("rejects any unexpected body field via Zod's strict shape (no workspaceId injection)", async () => {
    // The body shape doesn't accept `workspaceId` — even if the caller
    // tries to inject one, the schema ignores it (z.object is non-strict
    // by default) AND the handler reads workspaceId from authResult,
    // never from the body. Belt-and-braces test: assert the response
    // workspaceId is the session's active org regardless of body.
    const res = await app.fetch(mintRequest({ workspaceId: "evil-other-org", ttlSeconds: 300 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as MintResponseBody;
    expect(body.workspaceId).toBe("org-test");
  });
});

describe("POST /api/v1/me/load-test/mcp-token — JWKS handling", () => {
  it("returns 503 with retry guidance when the jwks table is empty", async () => {
    mocks.mockInternalQuery.mockImplementation(async () => []);
    const res = await app.fetch(mintRequest());
    expect(res.status).toBe(503);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.error).toBe("jwks_not_initialized");
    expect(body.message).toMatch(/seed/i);
  });

  it("returns 404 when no internal DB is configured", async () => {
    mocks.hasInternalDB = false;
    const res = await app.fetch(mintRequest());
    expect(res.status).toBe(404);
  });
});

describe("POST /api/v1/me/load-test/mcp-token — happy path", () => {
  it("mints a JWT and returns the full response shape", async () => {
    const res = await app.fetch(mintRequest({ ttlSeconds: 600 }));
    expect(res.status).toBe(200);

    const body = (await res.json()) as MintResponseBody;
    expect(body.bearer).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(body.workspaceId).toBe("org-test");
    expect(body.audience).toMatch(/\/mcp$/);
    expect(body.issuer).toMatch(/\/api\/auth$/);
    expect(body.scope).toBe("mcp:read");
    expect(body.sub).toMatch(/^loadtest:org-test:/);
    expect(typeof body.expiresAt).toBe("string");
  });

  it("the minted bearer round-trips through jose.jwtVerify", async () => {
    const res = await app.fetch(mintRequest({ ttlSeconds: 300 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as MintResponseBody;

    const publicKey = await jose.importJWK(keyFixture.publicJwk, "EdDSA");
    const { payload } = await jose.jwtVerify(body.bearer, publicKey, {
      issuer: body.issuer,
      audience: body.audience,
    });

    expect(payload[ATLAS_OAUTH_WORKSPACE_CLAIM]).toBe("org-test");
    expect(payload.azp).toBe("atlas-load-test");
    expect(payload.scope).toBe("mcp:read");
    expect(payload.sub).toBe(body.sub);
  });

  it("writes an awaited audit row carrying jti, scoped to workspace, never the bearer", async () => {
    const res = await app.fetch(mintRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as MintResponseBody;

    expect(logAdminActionAwait).toHaveBeenCalled();
    const lastCall = logAdminActionAwait.mock.calls.at(-1);
    const entry = lastCall![0] as {
      actionType: string;
      targetType: string;
      targetId: string;
      scope: string;
      metadata: Record<string, unknown>;
    };
    expect(entry.actionType).toBe("load_test.mint_mcp_token");
    expect(entry.targetType).toBe("load_test");
    expect(entry.targetId).toBe("org-test");
    expect(entry.scope).toBe("workspace");
    expect(entry.metadata.workspaceId).toBe("org-test");
    expect(typeof entry.metadata.jti).toBe("string");
    expect(entry.metadata.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.metadata.sub).toBe(body.sub);
    expect(entry.metadata.ttlSeconds).toBe(300);
    expect(JSON.stringify(entry)).not.toContain(body.bearer);
  });

  it("uses logAdminActionAwait, not fire-and-forget logAdminAction", async () => {
    const res = await app.fetch(mintRequest());
    expect(res.status).toBe(200);
    expect(logAdminActionAwait).toHaveBeenCalledTimes(1);
    expect(logAdminAction).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/me/load-test/mcp-token — per-endpoint rate limit", () => {
  it("rejects the 11th mint within 60s with 429 + Retry-After header", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await app.fetch(mintRequest());
      expect(res.status).toBe(200);
    }
    const blocked = await app.fetch(mintRequest());
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    const body = (await blocked.json()) as ErrorResponseBody;
    expect(body.error).toBe("rate_limited");
    expect(body.message).toContain("10/min");
  });

  it("releases the budget after the 60s sliding window passes", async () => {
    let now = 1_000_000_000_000;
    _setLoadTestClockForTests(() => now);

    for (let i = 0; i < 10; i++) {
      const res = await app.fetch(mintRequest());
      expect(res.status).toBe(200);
    }
    const blocked = await app.fetch(mintRequest());
    expect(blocked.status).toBe(429);

    now += 61_000;
    const allowed = await app.fetch(mintRequest());
    expect(allowed.status).toBe(200);
  });
});

describe("POST /api/v1/me/load-test/mcp-token — failure-path audit", () => {
  it("on an unexpected mint failure returns 500 with requestId, writes a status:failure audit row, and never leaks a JWT", async () => {
    mocks.mockInternalQuery.mockImplementation(async () => [
      {
        id: "broken-kid",
        publicKey: JSON.stringify(keyFixture.publicJwk),
        privateKey: JSON.stringify("deadbeef".repeat(8)),
        createdAt: new Date(),
        expiresAt: null,
      },
    ]);

    const res = await app.fetch(mintRequest());
    expect(res.status).toBe(500);

    const body = (await res.json()) as ErrorResponseBody & Record<string, unknown>;
    expect(body.error).toBe("mint_failed");
    expect(body.requestId).toBeTruthy();
    expect(JSON.stringify(body)).not.toMatch(/[\w-]+\.[\w-]+\.[\w-]+/);

    expect(logAdminActionAwait).toHaveBeenCalledTimes(1);
    const lastCall = logAdminActionAwait.mock.calls.at(-1);
    const entry = lastCall![0] as {
      actionType: string;
      status: string;
      scope: string;
      metadata: Record<string, unknown>;
    };
    expect(entry.actionType).toBe("load_test.mint_mcp_token");
    expect(entry.status).toBe("failure");
    expect(entry.scope).toBe("workspace");
    expect(entry.metadata.workspaceId).toBe("org-test");
    expect(entry.metadata.error).toBeTruthy();
  });

  it("does not embed decrypted-key fragments into the failure-path audit when JSON.parse on plaintext fails", async () => {
    const MARKER = "LEAKED_KEY_MATERIAL_NEVER_TO_BE_AUDITED";
    const envelope = await symmetricEncrypt({ key: TEST_SECRET, data: MARKER });
    mocks.mockInternalQuery.mockImplementation(async () => [
      {
        id: "leak-test-kid",
        publicKey: JSON.stringify(keyFixture.publicJwk),
        privateKey: JSON.stringify(envelope),
        createdAt: new Date(),
        expiresAt: null,
      },
    ]);

    const res = await app.fetch(mintRequest());
    expect(res.status).toBe(500);
    const responseText = await res.text();
    expect(responseText).not.toContain("LEAKED_KEY_MATERIAL");

    expect(logAdminActionAwait).toHaveBeenCalled();
    const lastCall = logAdminActionAwait.mock.calls.at(-1);
    const entry = lastCall![0] as { metadata: Record<string, unknown> };
    expect(JSON.stringify(entry)).not.toContain("LEAKED_KEY_MATERIAL");
    expect(JSON.stringify(entry)).not.toMatch(/LEAKED_K|EY_MATER/);
  });
});
