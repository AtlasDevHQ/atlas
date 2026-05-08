/**
 * Tests for the SDK MCP onboarding helpers.
 *
 * Strategy: every external dep (fetch, RNG) is replaced with deterministic
 * stubs via the public option seams so the suite never opens a network
 * connection or depends on the platform's CSPRNG. Mirrors
 * `plugins/mcp/__tests__/init/hosted.test.ts` — same code, different
 * surface.
 */
import { describe, expect, test, beforeEach, afterAll, mock } from "bun:test";

import {
  AtlasMcpError,
  beginConnect,
  buildConfig,
  completeConnect,
  connectMachineToMachine,
  type BeginConnectOptions,
  type CompleteConnectOptions,
} from "../mcp";
import { createAtlasClient } from "../client";

// ── Constants + helpers ───────────────────────────────────────────────

const API_URL = "https://atlas.test";
const REDIRECT_URI = "https://my-app.test/oauth/callback";
const WORKSPACE_ID = "ws-123";

const DISCOVERY_BODY = {
  authorization_endpoint: `${API_URL}/api/auth/oauth2/authorize`,
  token_endpoint: `${API_URL}/api/auth/oauth2/token`,
  registration_endpoint: `${API_URL}/api/auth/oauth2/register`,
  issuer: `${API_URL}/api/auth`,
};

function jwt(payload: Record<string, unknown>): string {
  const enc = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${enc({ alg: "RS256", typ: "JWT" })}.${enc(payload)}.sig`;
}

const VALID_TOKEN = jwt({
  iss: `${API_URL}/api/auth`,
  sub: "user-1",
  aud: `${API_URL}/mcp`,
  azp: "client-abc",
  exp: Math.floor(Date.now() / 1000) + 3600,
  scope: "mcp:read offline_access",
  "https://atlas.useatlas.dev/workspace_id": WORKSPACE_ID,
});

function deterministicRandom(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = i & 0xff;
  return bytes;
}

interface FetchStub {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface CapturedRequest {
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
}

function captureFetch(handlers: Record<string, () => Response>): {
  fetchImpl: FetchStub;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const fetchImpl: FetchStub = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders) {
      // Headers can be Record, [key,val][], or Headers — normalise.
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((v, k) => (headers[k.toLowerCase()] = v));
      } else if (Array.isArray(rawHeaders)) {
        for (const [k, v] of rawHeaders) headers[k.toLowerCase()] = v;
      } else {
        for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = String(v);
      }
    }
    calls.push({ url, method, body, headers });

    // Match by url substring → handler.
    for (const [key, handler] of Object.entries(handlers)) {
      if (url.includes(key)) return handler();
    }
    throw new Error(`captureFetch: no handler for ${method} ${url}`);
  };
  return { fetchImpl, calls };
}

const baseBeginOptions: Omit<BeginConnectOptions, "fetchImpl" | "randomBytesImpl"> = {
  apiUrl: API_URL,
  clientName: "Test Embed",
  redirectUri: REDIRECT_URI,
};

// ── beginConnect ──────────────────────────────────────────────────────

describe("beginConnect", () => {
  test("returns authorizationUrl, state, codeVerifier, clientId", async () => {
    const { fetchImpl, calls } = captureFetch({
      ".well-known/oauth-authorization-server": () => jsonResponse(DISCOVERY_BODY),
      "/oauth2/register": () => jsonResponse({ client_id: "client-abc" }),
    });

    const result = await beginConnect({
      ...baseBeginOptions,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      randomBytesImpl: deterministicRandom,
    });

    expect(result.clientId).toBe("client-abc");
    expect(result.state).toBeTruthy();
    expect(result.codeVerifier).toBeTruthy();
    expect(result.authorizationUrl).toContain(DISCOVERY_BODY.authorization_endpoint);
    expect(result.authorizationUrl).toContain(`client_id=client-abc`);
    expect(result.authorizationUrl).toContain(`state=${result.state}`);
    expect(result.authorizationUrl).toContain("code_challenge_method=S256");
    expect(result.tokenEndpoint).toBe(DISCOVERY_BODY.token_endpoint);
    expect(result.issuer).toBe(DISCOVERY_BODY.issuer);

    expect(calls.length).toBe(2);
    expect(calls[0].url).toContain("/.well-known/oauth-authorization-server");
    expect(calls[1].url).toBe(DISCOVERY_BODY.registration_endpoint);
    expect(calls[1].method).toBe("POST");
    const regBody = JSON.parse(calls[1].body) as Record<string, unknown>;
    expect(regBody.redirect_uris).toEqual([REDIRECT_URI]);
    expect(regBody.client_name).toBe("Test Embed");
  });

  test("rejects non-https / non-loopback apiUrl", async () => {
    await expect(
      beginConnect({ ...baseBeginOptions, apiUrl: "http://evil.example.com" }),
    ).rejects.toThrowError(AtlasMcpError);
  });

  test("accepts http://localhost for dev", async () => {
    const { fetchImpl } = captureFetch({
      ".well-known/oauth-authorization-server": () =>
        jsonResponse({
          ...DISCOVERY_BODY,
          authorization_endpoint: "http://localhost:3001/api/auth/oauth2/authorize",
          token_endpoint: "http://localhost:3001/api/auth/oauth2/token",
          registration_endpoint: "http://localhost:3001/api/auth/oauth2/register",
          issuer: "http://localhost:3001/api/auth",
        }),
      "/oauth2/register": () => jsonResponse({ client_id: "dev-client" }),
    });

    await expect(
      beginConnect({
        ...baseBeginOptions,
        apiUrl: "http://localhost:3001",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        randomBytesImpl: deterministicRandom,
      }),
    ).resolves.toBeDefined();
  });

  test("propagates DCR failure as registration_failed", async () => {
    const { fetchImpl } = captureFetch({
      ".well-known/oauth-authorization-server": () => jsonResponse(DISCOVERY_BODY),
      "/oauth2/register": () =>
        new Response(JSON.stringify({ error: "invalid_client_metadata" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    });

    try {
      await beginConnect({
        ...baseBeginOptions,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        randomBytesImpl: deterministicRandom,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasMcpError);
      expect((err as AtlasMcpError).code).toBe("registration_failed");
    }
  });

  test("custom scopes flow into the authorize URL", async () => {
    const { fetchImpl } = captureFetch({
      ".well-known/oauth-authorization-server": () => jsonResponse(DISCOVERY_BODY),
      "/oauth2/register": () => jsonResponse({ client_id: "client-abc" }),
    });

    const result = await beginConnect({
      ...baseBeginOptions,
      scopes: ["mcp:read", "mcp:write"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      randomBytesImpl: deterministicRandom,
    });
    const url = new URL(result.authorizationUrl);
    expect(url.searchParams.get("scope")).toBe("mcp:read mcp:write");
  });
});

// ── completeConnect ───────────────────────────────────────────────────

describe("completeConnect", () => {
  const baseComplete: Omit<CompleteConnectOptions, "fetchImpl"> = {
    apiUrl: API_URL,
    state: "expected-state",
    expectedState: "expected-state",
    code: "auth-code-123",
    codeVerifier: "verifier-abc",
    clientId: "client-abc",
    redirectUri: REDIRECT_URI,
    tokenEndpoint: DISCOVERY_BODY.token_endpoint,
    issuer: DISCOVERY_BODY.issuer,
  };

  test("exchanges code → access token, refresh token, expiry, workspaceId", async () => {
    const { fetchImpl, calls } = captureFetch({
      "/oauth2/token": () =>
        jsonResponse({
          access_token: VALID_TOKEN,
          refresh_token: "rfr-xyz",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "mcp:read offline_access",
        }),
    });

    const before = Date.now();
    const result = await completeConnect({
      ...baseComplete,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const after = Date.now();

    expect(result.accessToken).toBe(VALID_TOKEN);
    expect(result.refreshToken).toBe("rfr-xyz");
    expect(result.workspaceId).toBe(WORKSPACE_ID);
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000 - 100);
    expect(result.expiresAt).toBeLessThanOrEqual(after + 3600 * 1000 + 100);

    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(calls[0].body);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("auth-code-123");
    expect(params.get("client_id")).toBe("client-abc");
    expect(params.get("code_verifier")).toBe("verifier-abc");
    expect(params.get("redirect_uri")).toBe(REDIRECT_URI);
  });

  test("state mismatch → callback_state_mismatch", async () => {
    await expect(
      completeConnect({
        ...baseComplete,
        state: "wrong",
        expectedState: "expected-state",
      }),
    ).rejects.toThrowError(/state mismatch/i);
  });

  test("missing workspace claim → missing_workspace_claim", async () => {
    const tokenWithoutClaim = jwt({
      iss: `${API_URL}/api/auth`,
      sub: "user-1",
      azp: "client-abc",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const { fetchImpl } = captureFetch({
      "/oauth2/token": () =>
        jsonResponse({ access_token: tokenWithoutClaim, expires_in: 3600 }),
    });

    try {
      await completeConnect({
        ...baseComplete,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasMcpError);
      expect((err as AtlasMcpError).code).toBe("missing_workspace_claim");
    }
  });

  test("issuer mismatch → issuer_mismatch", async () => {
    const tokenWithBadIssuer = jwt({
      iss: "https://impostor.example.com/api/auth",
      sub: "user-1",
      azp: "client-abc",
      "https://atlas.useatlas.dev/workspace_id": WORKSPACE_ID,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const { fetchImpl } = captureFetch({
      "/oauth2/token": () =>
        jsonResponse({ access_token: tokenWithBadIssuer, expires_in: 3600 }),
    });
    try {
      await completeConnect({
        ...baseComplete,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasMcpError);
      expect((err as AtlasMcpError).code).toBe("issuer_mismatch");
    }
  });

  test("token endpoint 4xx → token_exchange_failed", async () => {
    const { fetchImpl } = captureFetch({
      "/oauth2/token": () =>
        new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "code expired" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
    });
    try {
      await completeConnect({
        ...baseComplete,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasMcpError);
      expect((err as AtlasMcpError).code).toBe("token_exchange_failed");
    }
  });
});

// ── buildConfig ───────────────────────────────────────────────────────

describe("buildConfig", () => {
  const args = {
    apiUrl: API_URL,
    accessToken: "access-token-xyz",
    workspaceId: WORKSPACE_ID,
  };

  test("claude-desktop returns mcpServers wrapper with url + Authorization header", () => {
    const cfg = buildConfig({ client: "claude-desktop", ...args });
    expect(cfg).toEqual({
      mcpServers: {
        atlas: {
          url: `${API_URL}/mcp/${WORKSPACE_ID}/sse`,
          headers: { Authorization: "Bearer access-token-xyz" },
        },
      },
    });
  });

  test("cursor uses same mcpServers shape", () => {
    const cfg = buildConfig({ client: "cursor", ...args });
    expect(cfg.mcpServers?.atlas?.url).toBe(`${API_URL}/mcp/${WORKSPACE_ID}/sse`);
    expect(cfg.mcpServers?.atlas?.headers?.Authorization).toBe("Bearer access-token-xyz");
  });

  test("continue uses same mcpServers shape", () => {
    const cfg = buildConfig({ client: "continue", ...args });
    expect(cfg.mcpServers?.atlas?.url).toBe(`${API_URL}/mcp/${WORKSPACE_ID}/sse`);
  });

  test("chatgpt uses same mcpServers shape", () => {
    const cfg = buildConfig({ client: "chatgpt", ...args });
    expect(cfg.mcpServers?.atlas?.url).toBe(`${API_URL}/mcp/${WORKSPACE_ID}/sse`);
  });

  test("generic returns the bare {url, headers} block", () => {
    const cfg = buildConfig({ client: "generic", ...args });
    expect(cfg).toEqual({
      url: `${API_URL}/mcp/${WORKSPACE_ID}/sse`,
      headers: { Authorization: "Bearer access-token-xyz" },
    });
  });

  test("custom serverName parameter overrides 'atlas'", () => {
    const cfg = buildConfig({ client: "claude-desktop", serverName: "atlas-prod", ...args });
    expect(cfg.mcpServers?.["atlas-prod"]).toBeDefined();
    expect(cfg.mcpServers?.atlas).toBeUndefined();
  });

  test("trims trailing slashes from apiUrl", () => {
    const cfg = buildConfig({ client: "generic", ...args, apiUrl: `${API_URL}/` });
    expect(cfg).toEqual({
      url: `${API_URL}/mcp/${WORKSPACE_ID}/sse`,
      headers: { Authorization: "Bearer access-token-xyz" },
    });
  });
});

// ── connectMachineToMachine ──────────────────────────────────────────

describe("connectMachineToMachine", () => {
  test("throws AtlasMcpError with grant_not_supported until OAuth provider exposes client_credentials", async () => {
    try {
      await connectMachineToMachine({
        apiUrl: API_URL,
        clientId: "ci-bot",
        clientSecret: "secret",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasMcpError);
      expect((err as AtlasMcpError).code).toBe("grant_not_supported");
      expect((err as AtlasMcpError).message).toContain("#2024");
    }
  });
});

// ── client.mcp.listAgents / revokeAgent ───────────────────────────────

const originalFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = originalFetch;
});

let lastRequest: Request | null = null;
function installFetchMock(response: Response) {
  lastRequest = null;
  const fn = mock(async (input: string | URL | Request, init?: RequestInit) => {
    lastRequest = new Request(input as string, init);
    return response.clone();
  });
  globalThis.fetch = Object.assign(fn, { preconnect: () => {} }) as unknown as typeof fetch;
}

describe("client.mcp.listAgents", () => {
  beforeEach(() => {
    lastRequest = null;
  });

  test("GETs /api/v1/me/oauth-clients and returns the typed response", async () => {
    installFetchMock(
      jsonResponse({
        clients: [
          {
            clientId: "claude-desktop",
            clientName: "Claude Desktop",
            redirectUris: ["http://127.0.0.1:0/callback"],
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: null,
            disabled: false,
            type: "public",
            lastUsedAt: "2026-05-01T00:00:00.000Z",
            tokenCount: 1,
            tokenState: "active",
          },
        ],
        deployMode: "saas",
      }),
    );
    const atlas = createAtlasClient({ baseUrl: API_URL, bearerToken: "tok" });
    const res = await atlas.mcp.listAgents();
    expect(res.deployMode).toBe("saas");
    expect(res.clients).toHaveLength(1);
    expect(res.clients[0].clientId).toBe("claude-desktop");
    expect(lastRequest).not.toBeNull();
    expect(lastRequest?.url).toBe(`${API_URL}/api/v1/me/oauth-clients`);
    expect(lastRequest?.headers.get("Authorization")).toBe("Bearer tok");
  });
});

describe("client.mcp.revokeAgent", () => {
  beforeEach(() => {
    lastRequest = null;
  });

  test("POSTs /api/v1/me/oauth-clients/:id/revoke", async () => {
    installFetchMock(jsonResponse({ success: true, tokensRevoked: 2 }));
    const atlas = createAtlasClient({ baseUrl: API_URL, bearerToken: "tok" });
    const res = await atlas.mcp.revokeAgent("claude-desktop");
    expect(res.success).toBe(true);
    expect(res.tokensRevoked).toBe(2);
    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.url).toBe(
      `${API_URL}/api/v1/me/oauth-clients/claude-desktop/revoke`,
    );
  });

  test("URL-encodes the client id", async () => {
    installFetchMock(jsonResponse({ success: true, tokensRevoked: 0 }));
    const atlas = createAtlasClient({ baseUrl: API_URL, bearerToken: "tok" });
    await atlas.mcp.revokeAgent("a/b c");
    expect(lastRequest?.url).toBe(
      `${API_URL}/api/v1/me/oauth-clients/${encodeURIComponent("a/b c")}/revoke`,
    );
  });
});
