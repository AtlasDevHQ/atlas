import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type createRemoteJWKSet } from "jose";
import { validateBYOT, resetJWKSCache, _setJWKS } from "../byot";

// Generate an RS256 key pair for test JWT signing
const { publicKey, privateKey } = await generateKeyPair("RS256");
const publicJwk = await exportJWK(publicKey);
publicJwk.kid = "test-key-1";
publicJwk.alg = "RS256";
publicJwk.use = "sig";

const TEST_ISSUER = "https://auth.example.com";
const TEST_AUDIENCE = "atlas-api";

/** Helper: sign a JWT with the test private key. */
async function signJWT(
  claims: Record<string, unknown> = {},
  opts: { expiresIn?: string; issuer?: string; audience?: string } = {},
): Promise<string> {
  let builder = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
    .setSubject(claims.sub as string ?? "user_123")
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "1h");

  if (opts.issuer !== undefined) builder = builder.setIssuer(opts.issuer);
  else builder = builder.setIssuer(TEST_ISSUER);

  if (opts.audience !== undefined) builder = builder.setAudience(opts.audience);
  else builder = builder.setAudience(TEST_AUDIENCE);

  return builder.sign(privateKey);
}

function makeRequest(headers?: Record<string, string>): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: headers ?? {},
  });
}

describe("validateBYOT()", () => {
  const origJwksUrl = process.env.ATLAS_AUTH_JWKS_URL;
  const origIssuer = process.env.ATLAS_AUTH_ISSUER;
  const origAudience = process.env.ATLAS_AUTH_AUDIENCE;
  const origRoleClaim = process.env.ATLAS_AUTH_ROLE_CLAIM;

  beforeEach(() => {
    process.env.ATLAS_AUTH_JWKS_URL = "https://auth.example.com/.well-known/jwks.json";
    process.env.ATLAS_AUTH_ISSUER = TEST_ISSUER;
    process.env.ATLAS_AUTH_AUDIENCE = TEST_AUDIENCE;
    delete process.env.ATLAS_AUTH_ROLE_CLAIM;
    resetJWKSCache();
    // Inject a local JWKS verifier instead of fetching a remote URL
    _setJWKS(createLocalJWKSet({ keys: [publicJwk] }) as unknown as ReturnType<typeof createRemoteJWKSet>);
  });

  afterEach(() => {
    if (origJwksUrl !== undefined) process.env.ATLAS_AUTH_JWKS_URL = origJwksUrl;
    else delete process.env.ATLAS_AUTH_JWKS_URL;

    if (origIssuer !== undefined) process.env.ATLAS_AUTH_ISSUER = origIssuer;
    else delete process.env.ATLAS_AUTH_ISSUER;

    if (origAudience !== undefined) process.env.ATLAS_AUTH_AUDIENCE = origAudience;
    else delete process.env.ATLAS_AUTH_AUDIENCE;

    if (origRoleClaim !== undefined) process.env.ATLAS_AUTH_ROLE_CLAIM = origRoleClaim;
    else delete process.env.ATLAS_AUTH_ROLE_CLAIM;

    resetJWKSCache();
  });

  it("valid JWT returns authenticated with user", async () => {
    const token = await signJWT({ sub: "user_123", email: "alice@example.com" });
    const result = await validateBYOT(
      makeRequest({ Authorization: `Bearer ${token}` }),
    );

    expect(result).toMatchObject({
      authenticated: true,
      mode: "byot",
      user: {
        id: "user_123",
        mode: "byot",
        label: "alice@example.com",
      },
    });
    // Verify claims are populated from JWT payload
    if (result.authenticated && result.user) {
      expect(result.user.claims).toBeDefined();
      expect(result.user.claims!.sub).toBe("user_123");
      expect(result.user.claims!.email).toBe("alice@example.com");
    }
  });

  it("expired JWT returns 401", async () => {
    const token = await signJWT({ sub: "user_123" }, { expiresIn: "-1h" });
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
    const token = await signJWT({ sub: "user_123" }, { issuer: "https://wrong.example.com" });
    const result = await validateBYOT(
      makeRequest({ Authorization: `Bearer ${token}` }),
    );

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(401);
    }
  });

  it("no Authorization header returns 401", async () => {
    const result = await validateBYOT(makeRequest());

    expect(result).toEqual({
      authenticated: false,
      mode: "byot",
      status: 401,
      error: "Missing or malformed Authorization header",
    });
  });

  it("malformed token returns 401", async () => {
    const result = await validateBYOT(
      makeRequest({ Authorization: "Bearer garbage.not.valid" }),
    );

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(401);
    }
  });

  it("JWT without sub claim returns 401", async () => {
    const token = await new SignJWT({ email: "nosub@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
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

  it("wrong audience returns 401", async () => {
    const token = await signJWT(
      { sub: "user_123" },
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

  it("missing JWKS URL throws (middleware catches as 500)", async () => {
    delete process.env.ATLAS_AUTH_JWKS_URL;
    resetJWKSCache();

    await expect(
      validateBYOT(makeRequest({ Authorization: "Bearer some-token" })),
    ).rejects.toThrow("ATLAS_AUTH_JWKS_URL is required");
  });

  it("missing ATLAS_AUTH_ISSUER throws (middleware catches as 500)", async () => {
    delete process.env.ATLAS_AUTH_ISSUER;
    resetJWKSCache();

    const token = await signJWT({ sub: "user_123" });
    await expect(
      validateBYOT(makeRequest({ Authorization: `Bearer ${token}` })),
    ).rejects.toThrow("ATLAS_AUTH_ISSUER is required");
  });

  it("uses sub claim as user.id", async () => {
    const token = await signJWT({ sub: "usr_abc_456" });
    const result = await validateBYOT(
      makeRequest({ Authorization: `Bearer ${token}` }),
    );

    expect(result.authenticated).toBe(true);
    if (result.authenticated && result.user) {
      expect(result.user.id).toBe("usr_abc_456");
    }
  });

  it("uses email claim as label when present", async () => {
    const token = await signJWT({ sub: "user_123", email: "bob@corp.com" });
    const result = await validateBYOT(
      makeRequest({ Authorization: `Bearer ${token}` }),
    );

    expect(result.authenticated).toBe(true);
    if (result.authenticated && result.user) {
      expect(result.user.label).toBe("bob@corp.com");
    }
  });

  it("falls back to sub for label when email absent", async () => {
    const token = await signJWT({ sub: "user_no_email" });
    const result = await validateBYOT(
      makeRequest({ Authorization: `Bearer ${token}` }),
    );

    expect(result.authenticated).toBe(true);
    if (result.authenticated && result.user) {
      expect(result.user.label).toBe("user_no_email");
    }
  });

  describe("audience-optional (ATLAS_AUTH_AUDIENCE unset)", () => {
    beforeEach(() => {
      delete process.env.ATLAS_AUTH_AUDIENCE;
    });

    it("JWT with arbitrary audience passes when ATLAS_AUTH_AUDIENCE is unset", async () => {
      const token = await signJWT(
        { sub: "user_123" },
        { audience: "some-random-audience" },
      );
      const result = await validateBYOT(
        makeRequest({ Authorization: `Bearer ${token}` }),
      );

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.id).toBe("user_123");
      }
    });

    it("JWT with no audience claim passes when ATLAS_AUTH_AUDIENCE is unset", async () => {
      // Build JWT manually without setting audience
      const token = await new SignJWT({ sub: "user_456" })
        .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
        .setSubject("user_456")
        .setIssuedAt()
        .setExpirationTime("1h")
        .setIssuer(TEST_ISSUER)
        .sign(privateKey);

      const result = await validateBYOT(
        makeRequest({ Authorization: `Bearer ${token}` }),
      );

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.id).toBe("user_456");
      }
    });
  });

  describe("role extraction from JWT claims", () => {
    it("JWT with role: 'admin' claim propagates to user object", async () => {
      const token = await signJWT({ sub: "user_123", role: "admin" });
      const result = await validateBYOT(
        makeRequest({ Authorization: `Bearer ${token}` }),
      );

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.role).toBe("admin");
      }
    });

    it("JWT with atlas_role: 'analyst' fallback claim", async () => {
      const token = await signJWT({ sub: "user_123", atlas_role: "analyst" });
      const result = await validateBYOT(
        makeRequest({ Authorization: `Bearer ${token}` }),
      );

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.role).toBe("analyst");
      }
    });

    it("nested claim via ATLAS_AUTH_ROLE_CLAIM env var", async () => {
      process.env.ATLAS_AUTH_ROLE_CLAIM = "app_metadata.role";
      const token = await signJWT({
        sub: "user_123",
        app_metadata: { role: "admin" },
      });
      const result = await validateBYOT(
        makeRequest({ Authorization: `Bearer ${token}` }),
      );

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.role).toBe("admin");
      }
    });

    it("invalid role value falls back — no role on user", async () => {
      const token = await signJWT({ sub: "user_123", role: "superadmin" });
      const result = await validateBYOT(
        makeRequest({ Authorization: `Bearer ${token}` }),
      );

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.role).toBeUndefined();
      }
    });

    it("non-string role (number) is ignored", async () => {
      const token = await signJWT({ sub: "user_123", role: 42 });
      const result = await validateBYOT(
        makeRequest({ Authorization: `Bearer ${token}` }),
      );

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.role).toBeUndefined();
      }
    });

    it("non-string role (array) is ignored", async () => {
      const token = await signJWT({ sub: "user_123", role: ["admin"] });
      const result = await validateBYOT(
        makeRequest({ Authorization: `Bearer ${token}` }),
      );

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.role).toBeUndefined();
      }
    });

    it("ATLAS_AUTH_ROLE_CLAIM pointing to missing path returns undefined", async () => {
      process.env.ATLAS_AUTH_ROLE_CLAIM = "nonexistent.deep.path";
      const token = await signJWT({ sub: "user_123" });
      const result = await validateBYOT(
        makeRequest({ Authorization: `Bearer ${token}` }),
      );

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.role).toBeUndefined();
      }
    });
  });
});
