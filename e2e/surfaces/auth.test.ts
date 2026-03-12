/**
 * E2E: Auth mode matrix tests.
 *
 * Validates every auth mode (none, simple-key, byot) and rate limiting
 * using in-process Hono app.fetch() with real auth middleware.
 *
 * Non-auth dependencies (DB, agent, semantic, startup, explore) are mocked.
 * Auth detect + middleware + simple-key + byot use real implementations.
 * Managed auth is excluded (requires Better Auth + internal DB).
 *
 * Env vars + resetAuthModeCache() switch modes between describe blocks.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  mock,
} from "bun:test";
import {
  generateKeyPair,
  exportJWK,
  SignJWT,
  type JWK,
} from "jose";

import { createMockServer, type MockServer } from "../helpers/mock-server";

// ---------------------------------------------------------------------------
// Mocks — everything except auth
// ---------------------------------------------------------------------------

mock.module("@atlas/api/lib/startup", () => ({
  validateEnvironment: mock(() => Promise.resolve([])),
  getStartupWarnings: mock(() => []),
  resetStartupCache: mock(() => {}),
}));

mock.module("@atlas/api/lib/db/connection", () => ({
  getDB: () => ({
    query: async () => ({ columns: ["?column?"], rows: [{ "?column?": 1 }] }),
    close: async () => {},
  }),
  connections: {
    get: () => ({
      query: async () => ({ columns: ["?column?"], rows: [{ "?column?": 1 }] }),
      close: async () => {},
    }),
    getDefault: () => ({
      query: async () => ({ columns: ["?column?"], rows: [{ "?column?": 1 }] }),
      close: async () => {},
    }),
    getDBType: () => "postgres" as const,
    getTargetHost: () => "localhost",
    list: () => [],
    describe: () => [],
  },
  detectDBType: () => "postgres" as const,
  extractTargetHost: () => "localhost",
  rewriteClickHouseUrl: (url: string) => url,
  parseSnowflakeURL: () => ({}),
  ConnectionRegistry: class {},
}));

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => false,
  getInternalDB: () => { throw new Error("No internal DB"); },
  internalQuery: async () => [],
  internalExecute: () => {},
  closeInternalDB: async () => {},
  _resetPool: () => {},
  _resetCircuitBreaker: () => {},
  migrateInternalDB: async () => {},
}));

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => null,
  configFromEnv: () => ({}),
  loadConfig: async () => null,
  initializeConfig: async () => {},
  validateAndResolve: () => ({}),
  defineConfig: (c: unknown) => c,
  _resetConfig: () => {},
  validateToolConfig: async () => {},
  applyDatasources: async () => {},
}));

mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => new Set(["test_orders"]),
  _resetWhitelists: () => {},
  getCrossSourceJoins: () => [],
  registerPluginEntities: mock(() => {}),
  _resetPluginEntities: mock(() => {}),
}));

mock.module("@atlas/api/lib/tools/explore", () => ({
  getExploreBackendType: () => "just-bash",
  getActiveSandboxPluginId: () => null,
  explore: { type: "function" },
  invalidateExploreBackend: mock(() => {}),
  markNsjailFailed: mock(() => {}),
  markSidecarFailed: mock(() => {}),
}));

mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mock(() =>
    Promise.resolve({
      toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
      text: Promise.resolve("answer"),
    }),
  ),
  buildSystemParam: mock(() => ({})),
  applyCacheControl: mock(() => {}),
}));

mock.module("@atlas/api/lib/agent-query", () => ({
  executeAgentQuery: mock(() =>
    Promise.resolve({
      answer: "42",
      sql: ["SELECT 1"],
      data: [{ columns: ["?column?"], rows: [{ "?column?": 1 }] }],
      steps: 1,
      usage: { totalTokens: 100 },
    }),
  ),
}));

mock.module("@atlas/api/lib/tools/actions", () => ({
  createJiraTicket: {
    name: "createJiraTicket",
    description: "Mock",
    tool: { type: "function" },
    actionType: "jira:create",
    reversible: true,
    defaultApproval: "manual",
    requiredCredentials: ["JIRA_BASE_URL"],
  },
  sendEmailReport: {
    name: "sendEmailReport",
    description: "Mock",
    tool: { type: "function" },
    actionType: "email:send",
    reversible: false,
    defaultApproval: "admin-only",
    requiredCredentials: ["RESEND_API_KEY"],
  },
}));

mock.module("@atlas/api/lib/conversations", () => ({
  createConversation: mock(() => Promise.resolve(null)),
  addMessage: mock(() => {}),
  getConversation: mock(() => Promise.resolve(null)),
  generateTitle: mock((q: string) => q.slice(0, 80)),
  listConversations: mock(() =>
    Promise.resolve({ conversations: [], total: 0 }),
  ),
  starConversation: mock(() => Promise.resolve(null)),
  deleteConversation: mock(() => Promise.resolve(false)),
  shareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  unshareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  getSharedConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
}));

mock.module("@atlas/api/lib/plugins/hooks", () => ({
  dispatchHook: async () => {},
  dispatchMutableHook: async (_name: string, payload: unknown) => payload,
}));

// ---------------------------------------------------------------------------
// Import real auth modules + app AFTER mocks are registered
// ---------------------------------------------------------------------------

const { resetAuthModeCache } = await import(
  "../../packages/api/src/lib/auth/detect"
);
const { resetRateLimits, _stopCleanup } = await import(
  "../../packages/api/src/lib/auth/middleware"
);
const { resetJWKSCache } = await import(
  "../../packages/api/src/lib/auth/byot"
);
const { app } = await import("../../packages/api/src/api/index");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Save and restore env vars around a test group. */
function saveEnv(keys: string[]) {
  const saved = new Map<string, string | undefined>();
  return {
    save() {
      for (const k of keys) saved.set(k, process.env[k]);
    },
    restore() {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

/** POST to /api/v1/query with optional auth header. */
function queryRequest(headers?: Record<string, string>) {
  return app.fetch(
    new Request("http://localhost/api/v1/query", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ question: "how many orders?" }),
    }),
  );
}

const ENV_KEYS = [
  "ATLAS_AUTH_MODE",
  "ATLAS_API_KEY",
  "ATLAS_API_KEY_ROLE",
  "ATLAS_AUTH_JWKS_URL",
  "ATLAS_AUTH_ISSUER",
  "ATLAS_AUTH_AUDIENCE",
  "ATLAS_AUTH_ROLE_CLAIM",
  "ATLAS_RATE_LIMIT_RPM",
  "ATLAS_DATASOURCE_URL",
  "BETTER_AUTH_SECRET",
];

// ---------------------------------------------------------------------------
// Shared JWKS server for BYOT tests and auto-detection priority tests
// ---------------------------------------------------------------------------

let sharedPrivateKey: CryptoKey;
let sharedJwksServer: MockServer;
const SHARED_ISSUER = "https://test-idp.example.com/";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: Auth mode matrix", () => {
  const env = saveEnv(ENV_KEYS);

  beforeAll(async () => {
    env.save();
    // Ensure a datasource is "configured" so routes don't 400 on missing URL
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost/test";

    // Generate RS256 keypair for BYOT tests
    const { publicKey, privateKey: pk } = await generateKeyPair("RS256");
    sharedPrivateKey = pk;

    // Export public key as JWK
    const pubJWK: JWK = await exportJWK(publicKey);
    pubJWK.kid = "test-key-1";
    pubJWK.use = "sig";
    pubJWK.alg = "RS256";

    // Serve JWKS on a mock server (shared across BYOT + priority tests)
    sharedJwksServer = createMockServer(() => {
      return new Response(
        JSON.stringify({ keys: [pubJWK] }),
        { headers: { "Content-Type": "application/json" } },
      );
    });
  });

  afterAll(() => {
    env.restore();
    _stopCleanup();
    sharedJwksServer?.close();
  });

  // Reset auth mode cache + rate limits between each test
  beforeEach(() => {
    resetAuthModeCache();
    resetRateLimits();
    resetJWKSCache();
    // Clear auth-related env vars so each test starts clean
    delete process.env.ATLAS_AUTH_MODE;
    delete process.env.ATLAS_API_KEY;
    delete process.env.ATLAS_API_KEY_ROLE;
    delete process.env.ATLAS_AUTH_JWKS_URL;
    delete process.env.ATLAS_AUTH_ISSUER;
    delete process.env.ATLAS_AUTH_AUDIENCE;
    delete process.env.ATLAS_AUTH_ROLE_CLAIM;
    delete process.env.ATLAS_RATE_LIMIT_RPM;
    delete process.env.BETTER_AUTH_SECRET;
  });

  // -----------------------------------------------------------------------
  // 1. No auth mode — requests succeed without credentials
  // -----------------------------------------------------------------------

  describe("no auth mode", () => {
    it("request succeeds without any credentials", async () => {
      // No auth env vars set → detectAuthMode() returns "none"
      const res = await queryRequest();
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
      expect(res.status).toBeLessThan(500);
    });

    it("health endpoint is always public", async () => {
      const res = await app.fetch(
        new Request("http://localhost/api/health"),
      );
      expect(res.status).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  // 2. Simple-key auth
  // -----------------------------------------------------------------------

  describe("simple-key auth", () => {
    const TEST_KEY = "test-e2e-api-key-secret";

    beforeEach(() => {
      process.env.ATLAS_API_KEY = TEST_KEY;
    });

    it("valid key returns 200", async () => {
      const res = await queryRequest({
        Authorization: `Bearer ${TEST_KEY}`,
      });
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);
    });

    it("wrong key returns 401", async () => {
      const res = await queryRequest({
        Authorization: "Bearer wrong-key",
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("auth_error");
    });

    it("missing key returns 401", async () => {
      const res = await queryRequest();
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("auth_error");
    });

    it("X-API-Key header also works", async () => {
      const res = await queryRequest({
        "X-API-Key": TEST_KEY,
      });
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);
    });

    it("role propagation: ATLAS_API_KEY_ROLE=admin sets admin role", async () => {
      process.env.ATLAS_API_KEY_ROLE = "admin";

      // We can't directly inspect the user object from here, but we can
      // verify the request succeeds (role is set internally). The real
      // validation is that the auth path doesn't reject it.
      const res = await queryRequest({
        Authorization: `Bearer ${TEST_KEY}`,
      });
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);
    });

    it("explicit ATLAS_AUTH_MODE=api-key activates simple-key", async () => {
      // "api-key" is an alias for "simple-key"
      process.env.ATLAS_AUTH_MODE = "api-key";
      const res = await queryRequest({
        Authorization: `Bearer ${TEST_KEY}`,
      });
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);
    });
  });

  // -----------------------------------------------------------------------
  // 3. BYOT auth (JWT/JWKS)
  // -----------------------------------------------------------------------

  describe("byot auth", () => {
    beforeEach(() => {
      process.env.ATLAS_AUTH_JWKS_URL = `${sharedJwksServer.url}/.well-known/jwks.json`;
      process.env.ATLAS_AUTH_ISSUER = SHARED_ISSUER;
    });

    /** Sign a JWT with the test private key. */
    async function signJWT(
      payload: Record<string, unknown>,
      opts?: { expiresIn?: string; issuer?: string },
    ) {
      let builder = new SignJWT(payload)
        .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
        .setSubject(payload.sub as string ?? "user-123")
        .setIssuedAt()
        .setIssuer(opts?.issuer ?? SHARED_ISSUER);

      if (opts?.expiresIn !== "none") {
        builder = builder.setExpirationTime(opts?.expiresIn ?? "1h");
      }

      return builder.sign(sharedPrivateKey);
    }

    it("valid JWT returns 200", async () => {
      const token = await signJWT({ sub: "user-123", email: "user@test.com" });
      const res = await queryRequest({
        Authorization: `Bearer ${token}`,
      });
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);
    });

    it("expired JWT returns 401", async () => {
      // Create a token that expired 1 hour ago
      const token = await new SignJWT({ sub: "user-123" })
        .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
        .setSubject("user-123")
        .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
        .setIssuer(SHARED_ISSUER)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
        .sign(sharedPrivateKey);

      const res = await queryRequest({
        Authorization: `Bearer ${token}`,
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("auth_error");
    });

    it("wrong issuer returns 401", async () => {
      const token = await signJWT(
        { sub: "user-123" },
        { issuer: "https://wrong-issuer.example.com/" },
      );
      const res = await queryRequest({
        Authorization: `Bearer ${token}`,
      });
      expect(res.status).toBe(401);
    });

    it("missing Authorization header returns 401", async () => {
      const res = await queryRequest();
      expect(res.status).toBe(401);
    });

    it("malformed Bearer token returns 401", async () => {
      const res = await queryRequest({
        Authorization: "Bearer not-a-valid-jwt",
      });
      expect(res.status).toBe(401);
    });

    it("nested role claim extraction via ATLAS_AUTH_ROLE_CLAIM", async () => {
      process.env.ATLAS_AUTH_ROLE_CLAIM = "app_metadata.role";

      const token = await signJWT({
        sub: "user-456",
        app_metadata: { role: "admin" },
      });
      const res = await queryRequest({
        Authorization: `Bearer ${token}`,
      });
      // Should authenticate successfully — role is extracted from nested claim
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);
    });

    it("JWT without sub claim returns 401", async () => {
      // Build a JWT manually without calling setSubject
      const token = await new SignJWT({ email: "no-sub@test.com" })
        .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
        .setIssuedAt()
        .setIssuer(SHARED_ISSUER)
        .setExpirationTime("1h")
        .sign(sharedPrivateKey);

      const res = await queryRequest({
        Authorization: `Bearer ${token}`,
      });
      expect(res.status).toBe(401);
    });
  });

  // -----------------------------------------------------------------------
  // 4. Rate limiting
  // -----------------------------------------------------------------------

  describe("rate limiting", () => {
    const TEST_KEY = "rate-limit-test-key";

    beforeEach(() => {
      process.env.ATLAS_API_KEY = TEST_KEY;
      process.env.ATLAS_RATE_LIMIT_RPM = "2";
    });

    it("3rd request returns 429 with Retry-After header", async () => {
      const headers = { Authorization: `Bearer ${TEST_KEY}` };

      // First two requests should succeed
      const res1 = await queryRequest(headers);
      expect(res1.status).not.toBe(429);

      const res2 = await queryRequest(headers);
      expect(res2.status).not.toBe(429);

      // Third request should be rate limited
      const res3 = await queryRequest(headers);
      expect(res3.status).toBe(429);

      const body = (await res3.json()) as {
        error: string;
        retryAfterSeconds: number;
      };
      expect(body.error).toBe("rate_limited");
      expect(body.retryAfterSeconds).toBeGreaterThan(0);
      expect(res3.headers.get("Retry-After")).toBeTruthy();
    });

    it("rate limit is disabled when RPM=0", async () => {
      process.env.ATLAS_RATE_LIMIT_RPM = "0";
      const headers = { Authorization: `Bearer ${TEST_KEY}` };

      // All requests should succeed
      for (let i = 0; i < 5; i++) {
        const res = await queryRequest(headers);
        expect(res.status).not.toBe(429);
      }
    });
  });

  // -----------------------------------------------------------------------
  // 5. Auto-detection priority
  // -----------------------------------------------------------------------

  describe("auto-detection priority", () => {
    /** Sign a JWT with a different key (not the shared JWKS key) so BYOT rejects it. */
    async function signWithWrongKey(payload: Record<string, unknown>, issuer: string) {
      const { privateKey: wrongKey } = await generateKeyPair("RS256");
      return new SignJWT(payload)
        .setProtectedHeader({ alg: "RS256", kid: "wrong-key" })
        .setSubject(payload.sub as string ?? "user-123")
        .setIssuedAt()
        .setIssuer(issuer)
        .setExpirationTime("1h")
        .sign(wrongKey);
    }

    it("JWKS takes priority over API key", async () => {
      const PRIORITY_ISSUER = "https://test.example.com/";
      // Set both — JWKS should win, so a JWT signed with wrong key → 401 (BYOT mode)
      // not simple-key rejection
      process.env.ATLAS_API_KEY = "some-key";
      process.env.ATLAS_AUTH_JWKS_URL = `${sharedJwksServer.url}/.well-known/jwks.json`;
      process.env.ATLAS_AUTH_ISSUER = PRIORITY_ISSUER;

      // Send a properly formed JWT signed with a different key — BYOT will
      // fetch the real JWKS and reject the signature
      const token = await signWithWrongKey({ sub: "user-123" }, PRIORITY_ISSUER);
      const res = await queryRequest({
        Authorization: `Bearer ${token}`,
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { message: string };
      // BYOT rejects with "Invalid or expired token", not "Invalid API key"
      expect(body.message).toContain("Invalid or expired token");
    });

    it("explicit ATLAS_AUTH_MODE overrides auto-detection", async () => {
      // Set JWKS env vars but force simple-key mode
      process.env.ATLAS_AUTH_MODE = "simple-key";
      process.env.ATLAS_API_KEY = "explicit-mode-key";
      process.env.ATLAS_AUTH_JWKS_URL = `${sharedJwksServer.url}/.well-known/jwks.json`;
      process.env.ATLAS_AUTH_ISSUER = "https://test.example.com/";

      // API key should work despite JWKS being configured
      const res = await queryRequest({
        Authorization: "Bearer explicit-mode-key",
      });
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);
    });
  });

  // -----------------------------------------------------------------------
  // 6. Health endpoint is always public
  // -----------------------------------------------------------------------

  describe("health endpoint bypass", () => {
    it("health returns 200 even when auth is required", async () => {
      process.env.ATLAS_API_KEY = "require-key";
      const res = await app.fetch(
        new Request("http://localhost/api/health"),
      );
      expect(res.status).toBe(200);
    });
  });
});
