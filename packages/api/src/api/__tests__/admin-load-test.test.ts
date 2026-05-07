/**
 * Integration tests for the platform-admin MCP load-test mint endpoint
 * (#2135).
 *
 * Coverage:
 *   - Auth: 401 unauthenticated, 403 non-platform-admin, 200 platform_admin.
 *   - Body validation: 400 ttl over cap, 400 missing workspaceId, 400 unknown region.
 *   - JWKS empty path: 503 with retry guidance.
 *   - Successful mint: 200 with full response shape, audit row written via
 *     `logAdminActionAwait` (NOT fire-and-forget) carrying `jti` but never
 *     the bearer.
 *   - Per-endpoint rate limit: 11th mint within 60s returns 429.
 *   - Round-trip: minted bearer verifies against the matching public key
 *     using the same `jose.jwtVerify` shape the MCP edge uses. This is
 *     the load-bearing test — without it we ship a token-shape regression.
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

// ── Audit mock — must be a fresh mock each test so we can assert on calls.

const logAdminActionAwait = mock(async (..._args: unknown[]) => {});
const logAdminAction = mock((..._args: unknown[]) => {});

// `errorMessage` scrubs `scheme://user:pass@host` userinfo out of pg /
// better-auth error strings before they hit `admin_action_log.metadata`.
// The route imports it from `@atlas/api/lib/audit`, so the mock must
// re-export the real implementation — partial mocks break with
// "Export named 'errorMessage' not found".
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

// ── Unified API mocks (auth, internal DB, etc.).

const mocks = createApiTestMocks({
  authUser: {
    id: "platform-admin-1",
    mode: "managed",
    label: "platform@test.com",
    role: "platform_admin",
    activeOrganizationId: "org-test",
    claims: { twoFactorEnabled: true },
  },
  authMode: "managed",
});

// ── Pre-build a real Ed25519 JWK fixture so the route's mintLoadTestToken
//    call actually succeeds end-to-end. Re-creates the same column shape
//    Better Auth's `createJwk` writes (JSON.stringify of the encrypted
//    envelope) so the unwrap path runs untouched.

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

// Set up the internalQuery default BEFORE the app boots so the first
// admin-load-test request sees a fixture-backed jwks row. Per-test
// overrides reset this in beforeEach.
function defaultJwksRow() {
  return [
    {
      id: keyFixture.id,
      publicKey: JSON.stringify(keyFixture.publicJwk),
      privateKey: keyFixture.privateKeyColumn,
      alg: null,
      createdAt: new Date(),
      expiresAt: null,
    },
  ];
}

const keyFixture: KeyFixture = await buildKey();
mocks.mockInternalQuery.mockImplementation(async () => defaultJwksRow());

// ── Import app after mocks settle.

const { app } = await import("../index");
const { _resetLoadTestRateLimit, _setLoadTestClockForTests } = await import(
  "../routes/admin-load-test"
);

// ── Helpers ─────────────────────────────────────────────────────────

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
  body: Record<string, unknown> | undefined,
  init?: { auth?: boolean },
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (init?.auth !== false) headers["Authorization"] = "Bearer test-key";
  return new Request("http://api.test.useatlas.dev/api/v1/admin/load-test/mcp-token", {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
}

beforeEach(() => {
  mocks.hasInternalDB = true;
  mocks.mockInternalQuery.mockReset();
  mocks.mockInternalQuery.mockImplementation(async () => defaultJwksRow());
  logAdminActionAwait.mockClear();
  logAdminAction.mockClear();
  _resetLoadTestRateLimit();
  mocks.setPlatformAdmin("org-test");
});

afterEach(() => {
  _resetLoadTestRateLimit();
});

afterAll(() => {
  mocks.cleanup();
  delete process.env.BETTER_AUTH_SECRET;
});

// ── Tests ───────────────────────────────────────────────────────────

describe("POST /api/v1/admin/load-test/mcp-token — auth", () => {
  it("returns 403 for an org admin (non-platform-admin role)", async () => {
    mocks.setOrgAdmin("org-test");
    const res = await app.fetch(mintRequest({ workspaceId: "ws-1" }));
    expect(res.status).toBe(403);
  });

  it("returns 401 for unauthenticated requests", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: false,
        status: 401,
        error: "Invalid or expired token",
      }),
    );
    const res = await app.fetch(mintRequest({ workspaceId: "ws-1" }, { auth: false }));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/admin/load-test/mcp-token — body validation", () => {
  it("returns 400 when workspaceId is missing", async () => {
    const res = await app.fetch(mintRequest({}));
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.error).toBe("invalid_body");
    expect(body.message).toContain("workspaceId");
  });

  it("returns 400 when ttlSeconds exceeds the server-side cap (3600)", async () => {
    const res = await app.fetch(mintRequest({ workspaceId: "ws-1", ttlSeconds: 86400 }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.error).toBe("invalid_body");
    expect(body.message).toContain("3600");
  });

  it("returns 400 when ttlSeconds is below the floor (60)", async () => {
    const res = await app.fetch(mintRequest({ workspaceId: "ws-1", ttlSeconds: 30 }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for an unknown region (no silent fallback)", async () => {
    const res = await app.fetch(
      mintRequest({ workspaceId: "ws-1", region: "doesnotexist" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.error).toBe("unknown_region");
  });
});

describe("POST /api/v1/admin/load-test/mcp-token — JWKS handling", () => {
  it("returns 503 with retry guidance when the jwks table is empty", async () => {
    mocks.mockInternalQuery.mockImplementation(async () => []);
    const res = await app.fetch(mintRequest({ workspaceId: "ws-1" }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.error).toBe("jwks_not_initialized");
    expect(body.message).toMatch(/seed/i);
  });

  it("returns 404 when no internal DB is configured", async () => {
    mocks.hasInternalDB = false;
    const res = await app.fetch(mintRequest({ workspaceId: "ws-1" }));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/v1/admin/load-test/mcp-token — happy path", () => {
  it("mints a JWT and returns the full response shape", async () => {
    const res = await app.fetch(mintRequest({ workspaceId: "ws-test", ttlSeconds: 600 }));
    expect(res.status).toBe(200);

    const body = (await res.json()) as MintResponseBody;
    expect(body.bearer).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(body.workspaceId).toBe("ws-test");
    expect(body.audience).toMatch(/\/mcp$/);
    expect(body.issuer).toMatch(/\/api\/auth$/);
    expect(body.scope).toBe("mcp:read");
    expect(body.sub).toMatch(/^loadtest:ws-test:/);
    expect(typeof body.expiresAt).toBe("string");
  });

  it("the minted bearer round-trips through jose.jwtVerify with the matching public key", async () => {
    const res = await app.fetch(mintRequest({ workspaceId: "ws-test", ttlSeconds: 300 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as MintResponseBody;

    const publicKey = await jose.importJWK(keyFixture.publicJwk, "EdDSA");
    const { payload } = await jose.jwtVerify(body.bearer, publicKey, {
      issuer: body.issuer,
      audience: body.audience,
    });

    expect(payload[ATLAS_OAUTH_WORKSPACE_CLAIM]).toBe("ws-test");
    expect(payload.azp).toBe("atlas-load-test");
    expect(payload.scope).toBe("mcp:read");
    expect(payload.sub).toBe(body.sub);
  });

  it("writes an awaited audit row carrying jti — but never the bearer", async () => {
    const res = await app.fetch(mintRequest({ workspaceId: "ws-test" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as MintResponseBody;

    expect(logAdminActionAwait).toHaveBeenCalled();
    const lastCall = logAdminActionAwait.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const entry = lastCall![0] as {
      actionType: string;
      targetType: string;
      targetId: string;
      scope: string;
      metadata: Record<string, unknown>;
    };
    expect(entry.actionType).toBe("load_test.mint_mcp_token");
    expect(entry.targetType).toBe("load_test");
    expect(entry.targetId).toBe("ws-test");
    expect(entry.scope).toBe("platform");
    expect(entry.metadata.workspaceId).toBe("ws-test");
    // jti is intentionally not in the response shape (the bearer carries
    // it, not the JSON envelope). The audit row IS the only place jti
    // is reachable for forensic correlation.
    expect(typeof entry.metadata.jti).toBe("string");
    expect(entry.metadata.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.metadata.sub).toBe(body.sub);
    expect(entry.metadata.ttlSeconds).toBe(300);
    // Non-negotiable: the bearer must NEVER appear in the audit row.
    expect(JSON.stringify(entry)).not.toContain(body.bearer);
  });

  it("uses the synchronous logAdminActionAwait path (NOT fire-and-forget logAdminAction)", async () => {
    const res = await app.fetch(mintRequest({ workspaceId: "ws-test" }));
    expect(res.status).toBe(200);
    expect(logAdminActionAwait).toHaveBeenCalledTimes(1);
    expect(logAdminAction).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/admin/load-test/mcp-token — per-endpoint rate limit", () => {
  it("rejects the 11th mint within 60s with 429 + Retry-After header", async () => {
    // Burn through the 10/min budget.
    for (let i = 0; i < 10; i++) {
      const res = await app.fetch(mintRequest({ workspaceId: `ws-${i}` }));
      expect(res.status).toBe(200);
    }

    const blocked = await app.fetch(mintRequest({ workspaceId: "ws-overflow" }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    const body = (await blocked.json()) as ErrorResponseBody;
    expect(body.error).toBe("rate_limited");
    expect(body.message).toContain("10/min");
  });

  it("releases the budget after the 60s sliding window passes", async () => {
    // Pin the clock so we control window boundaries deterministically.
    let now = 1_000_000_000_000;
    _setLoadTestClockForTests(() => now);

    // Saturate the bucket at t=now.
    for (let i = 0; i < 10; i++) {
      const res = await app.fetch(mintRequest({ workspaceId: `ws-burst-${i}` }));
      expect(res.status).toBe(200);
    }

    // 11th at t=now → 429.
    const blocked = await app.fetch(mintRequest({ workspaceId: "ws-blocked" }));
    expect(blocked.status).toBe(429);

    // Advance past the 60s window. The eviction step (`firstValid`
    // splice in admin-load-test.ts) must drop every stale timestamp so
    // the next request lands in an empty bucket.
    now += 61_000;
    const allowed = await app.fetch(mintRequest({ workspaceId: "ws-after-window" }));
    expect(allowed.status).toBe(200);
  });
});

describe("POST /api/v1/admin/load-test/mcp-token — failure-path audit", () => {
  it("on an unexpected mint failure returns 500 with requestId, writes a status:failure audit row, and never leaks a JWT", async () => {
    // Force the JWKS read to return a row whose private-key envelope
    // is structurally valid JSON but cannot be decrypted (random hex
    // that isn't a real ciphertext under TEST_SECRET). Drives the
    // mint into the unexpected-failure catch — exercises the
    // logAdminActionAwait failure-path AND the 500 response shape.
    mocks.mockInternalQuery.mockImplementation(async () => [
      {
        id: "broken-kid",
        publicKey: JSON.stringify(keyFixture.publicJwk),
        privateKey: JSON.stringify(
          // 32 bytes of garbage hex — symmetricDecrypt will throw.
          "deadbeef".repeat(8),
        ),
        createdAt: new Date(),
        expiresAt: null,
      },
    ]);

    const res = await app.fetch(mintRequest({ workspaceId: "ws-failure-path" }));
    expect(res.status).toBe(500);

    const body = (await res.json()) as ErrorResponseBody & Record<string, unknown>;
    expect(body.error).toBe("mint_failed");
    expect(body.requestId).toBeTruthy();
    // The 500 body must NOT carry a JWT. Header pattern is the
    // cheapest negative signal — the structural invariant is "nothing
    // shaped like a JWT in the response."
    expect(JSON.stringify(body)).not.toMatch(/[\w-]+\.[\w-]+\.[\w-]+/);

    // Failure-path audit: one awaited write with status:failure.
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
    expect(entry.scope).toBe("platform");
    expect(entry.metadata.workspaceId).toBe("ws-failure-path");
    expect(entry.metadata.error).toBeTruthy();
  });

  it("does not embed decrypted-key fragments into the failure-path audit when JSON.parse on plaintext fails", async () => {
    // Encrypt a marker plaintext that is NOT valid JSON, then store
    // the resulting envelope in the JWKS row. The route will:
    //   1. JSON.parse the column value → envelope string (passes).
    //   2. symmetricDecrypt with the test secret → marker plaintext.
    //   3. JSON.parse on the marker → THROWS.
    //
    // Without the unwrapPrivateJwk mitigation, JSC's JSON.parse error
    // would echo a fragment of "LEAKED_KEY_MATERIAL_..." into err.message,
    // and the route's failure-path catch would persist that fragment in
    // admin_action_log.metadata.error. We use real encryption rather
    // than mocking better-auth/crypto so the test does not contaminate
    // module-level state in sibling test files (Bun's mock.module is
    // process-global).
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

    const res = await app.fetch(mintRequest({ workspaceId: "ws-leak-guard" }));
    expect(res.status).toBe(500);
    const responseText = await res.text();
    expect(responseText).not.toContain("LEAKED_KEY_MATERIAL");

    expect(logAdminActionAwait).toHaveBeenCalled();
    const lastCall = logAdminActionAwait.mock.calls.at(-1);
    const entry = lastCall![0] as { metadata: Record<string, unknown> };
    expect(JSON.stringify(entry)).not.toContain("LEAKED_KEY_MATERIAL");
    // Sanity: also no partial leak (any 8+ consecutive chars from the marker)
    expect(JSON.stringify(entry)).not.toMatch(/LEAKED_K|EY_MATER/);
  });
});
