/**
 * BYOT integration test — validates JWT auth against a real JWKS HTTP server.
 *
 * Separate from byot.test.ts because that file uses mock.module("jose", ...)
 * which is sticky within its module graph. This file imports jose and byot.ts
 * without any mocking.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { validateBYOT, resetJWKSCache } from "../byot";

const TEST_ISSUER = "https://auth.integration-test.example.com";
const TEST_AUDIENCE = "atlas-integration";

let publicKey: CryptoKey;
let privateKey: CryptoKey;
let wrongPrivateKey: CryptoKey;
let server: ReturnType<typeof Bun.serve>;
let jwksUrl: string;

// Env vars to restore after tests
const origJwksUrl = process.env.ATLAS_AUTH_JWKS_URL;
const origIssuer = process.env.ATLAS_AUTH_ISSUER;
const origAudience = process.env.ATLAS_AUTH_AUDIENCE;

beforeAll(async () => {
  // Generate two RS256 key pairs — one for the JWKS server, one to simulate wrong-key signing
  const primary = await generateKeyPair("RS256");
  publicKey = primary.publicKey;
  privateKey = primary.privateKey;

  const wrong = await generateKeyPair("RS256");
  wrongPrivateKey = wrong.privateKey;

  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "integration-key-1";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  const jwksPayload = JSON.stringify({ keys: [publicJwk] });

  // Start an ephemeral HTTP server serving the JWKS endpoint
  server = Bun.serve({
    port: 0, // OS-assigned ephemeral port
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/jwks.json") {
        return new Response(jwksPayload, {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  jwksUrl = `http://localhost:${server.port}/.well-known/jwks.json`;
});

afterAll(() => {
  if (server) server.stop(true);
});

beforeEach(() => {
  process.env.ATLAS_AUTH_JWKS_URL = jwksUrl;
  process.env.ATLAS_AUTH_ISSUER = TEST_ISSUER;
  process.env.ATLAS_AUTH_AUDIENCE = TEST_AUDIENCE;
  resetJWKSCache();
});

afterEach(() => {
  if (origJwksUrl !== undefined) process.env.ATLAS_AUTH_JWKS_URL = origJwksUrl;
  else delete process.env.ATLAS_AUTH_JWKS_URL;

  if (origIssuer !== undefined) process.env.ATLAS_AUTH_ISSUER = origIssuer;
  else delete process.env.ATLAS_AUTH_ISSUER;

  if (origAudience !== undefined) process.env.ATLAS_AUTH_AUDIENCE = origAudience;
  else delete process.env.ATLAS_AUTH_AUDIENCE;

  resetJWKSCache();
});

/** Sign a JWT with the given key (defaults to the primary private key). */
async function signJWT(
  claims: Record<string, unknown> = {},
  opts: { expiresIn?: string; issuer?: string; audience?: string; key?: CryptoKey } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "integration-key-1" })
    .setSubject((claims.sub as string) ?? "user_integ_1")
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "1h")
    .setIssuer(opts.issuer ?? TEST_ISSUER)
    .setAudience(opts.audience ?? TEST_AUDIENCE)
    .sign(opts.key ?? privateKey);
}

function makeRequest(headers?: Record<string, string>): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: headers ?? {},
  });
}

describe("BYOT integration (real JWKS server)", () => {
  it("valid JWT authenticates successfully via real JWKS fetch", async () => {
    const token = await signJWT({ sub: "user_integ_1", email: "alice@corp.com" });
    const result = await validateBYOT(
      makeRequest({ Authorization: `Bearer ${token}` }),
    );

    expect(result).toMatchObject({
      authenticated: true,
      mode: "byot",
      user: {
        id: "user_integ_1",
        mode: "byot",
        label: "alice@corp.com",
      },
    });
    // Verify claims populated from JWT payload
    if (result.authenticated && result.user) {
      expect(result.user.claims).toBeDefined();
      expect(result.user.claims!.sub).toBe("user_integ_1");
    }
  });

  it("expired JWT returns 401", async () => {
    const token = await signJWT({ sub: "user_integ_1" }, { expiresIn: "-1h" });
    const result = await validateBYOT(
      makeRequest({ Authorization: `Bearer ${token}` }),
    );

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(401);
      expect(result.error).toContain("Invalid or expired");
    }
  });

  it("wrong issuer returns 401", async () => {
    const token = await signJWT(
      { sub: "user_integ_1" },
      { issuer: "https://evil.example.com" },
    );
    const result = await validateBYOT(
      makeRequest({ Authorization: `Bearer ${token}` }),
    );

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(401);
    }
  });

  it("wrong audience returns 401", async () => {
    const token = await signJWT(
      { sub: "user_integ_1" },
      { audience: "wrong-audience" },
    );
    const result = await validateBYOT(
      makeRequest({ Authorization: `Bearer ${token}` }),
    );

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(401);
    }
  });

  it("token signed with wrong key returns 401", async () => {
    const token = await signJWT(
      { sub: "user_integ_1" },
      { key: wrongPrivateKey },
    );
    const result = await validateBYOT(
      makeRequest({ Authorization: `Bearer ${token}` }),
    );

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(401);
    }
  });

  it("empty ATLAS_AUTH_AUDIENCE skips audience check (accepts any audience)", async () => {
    process.env.ATLAS_AUTH_AUDIENCE = "";
    resetJWKSCache();

    const token = await signJWT(
      { sub: "user_integ_1" },
      { audience: "any-audience-should-work" },
    );
    const result = await validateBYOT(
      makeRequest({ Authorization: `Bearer ${token}` }),
    );

    expect(result.authenticated).toBe(true);
  });

  it("JWT missing sub claim returns 401", async () => {
    const token = await new SignJWT({ email: "nosub@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "integration-key-1" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUDIENCE)
      .sign(privateKey);

    const result = await validateBYOT(
      makeRequest({ Authorization: `Bearer ${token}` }),
    );

    expect(result).toEqual({
      authenticated: false,
      mode: "byot",
      status: 401,
      error: "JWT missing sub claim",
    });
  });
});
