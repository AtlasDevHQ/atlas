/**
 * Unit tests for the MCP load-test JWT minter (#2135).
 *
 * Strategy: generate a fresh Ed25519 keypair with `jose`, write it into a
 * mocked `internalQuery` exactly the way Better Auth's `createJwk` would
 * (JSON-stringified JWK in `publicKey`, JSON-stringified `symmetricEncrypt`
 * envelope in `privateKey`), then invoke `mintLoadTestToken` and verify
 * the returned bearer with the matching public key. This keeps the test
 * a pure unit (no DB, no Better Auth bootstrap) while exercising every
 * load-bearing branch:
 *
 *   - Encrypted-private-key unwrap path (the production default).
 *   - Plain-private-key unwrap path (operator-disabled encryption).
 *   - Empty-jwks → `JwksNotInitializedError`.
 *   - Algorithm fallback to EdDSA when the JWK omits `alg`.
 *   - Claim shape — exact match against the MCP verifier's contract.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import * as jose from "jose";
import { symmetricEncrypt } from "better-auth/crypto";
import { ATLAS_OAUTH_WORKSPACE_CLAIM } from "../oauth-claims";

// ── Mock the internal-DB read so the test runs in isolation ─────────

const mockInternalQuery = mock<(sql: string, params?: unknown[]) => Promise<unknown[]>>(
  () => Promise.resolve([]),
);

mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: mockInternalQuery,
  hasInternalDB: () => true,
}));

const {
  mintLoadTestToken,
  JwksNotInitializedError,
  LOAD_TEST_TOKEN_DEFAULT_TTL_SECONDS,
  LOAD_TEST_TOKEN_MAX_TTL_SECONDS,
  LOAD_TEST_CLIENT_ID,
  LOAD_TEST_SCOPE,
  LOAD_TEST_SUBJECT_PREFIX,
} = await import("../load-test-tokens");

// ── Fixtures ────────────────────────────────────────────────────────

const TEST_SECRET = "test-secret-must-be-at-least-32-characters-long";
const ISSUER = "https://api.test.useatlas.dev/api/auth";
const AUDIENCE = "https://api.test.useatlas.dev/mcp";
const WORKSPACE_ID = "ws-fixture-1";

interface JwkFixture {
  readonly id: string;
  readonly publicJwk: jose.JWK;
  readonly publicJwkString: string;
  readonly encryptedPrivateKeyColumn: string;
  readonly plainPrivateKeyColumn: string;
}

/**
 * Build a fresh Ed25519 keypair stored in the same shape Better Auth's
 * `createJwk` writes. Two flavours:
 *
 *   - `encryptedPrivateKeyColumn` — what the production default writes:
 *     `JSON.stringify(symmetricEncrypt(JSON.stringify(privateJwk)))`.
 *   - `plainPrivateKeyColumn` — what an operator with
 *     `disablePrivateKeyEncryption: true` writes:
 *     `JSON.stringify(JSON.stringify(privateJwk))` (still JSON-wrapped
 *     because Better Auth always JSON-stringifies the column value).
 */
async function buildKeyFixture(): Promise<JwkFixture> {
  const { publicKey, privateKey } = await jose.generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  const publicJwk = await jose.exportJWK(publicKey);
  const privateJwk = await jose.exportJWK(privateKey);

  const id = `kid-${Math.random().toString(36).slice(2, 10)}`;
  const privateJwkJson = JSON.stringify(privateJwk);
  const envelope = await symmetricEncrypt({ key: TEST_SECRET, data: privateJwkJson });

  return {
    id,
    publicJwk,
    publicJwkString: JSON.stringify(publicJwk),
    encryptedPrivateKeyColumn: JSON.stringify(envelope),
    // Plaintext flavour: Better Auth writes the JWK JSON string directly
    // to the column (no second `JSON.stringify` wrap, unlike the encrypted
    // path which stringifies the envelope before storing).
    plainPrivateKeyColumn: privateJwkJson,
  };
}

interface JwkRow {
  id: string;
  publicKey: string;
  privateKey: string;
  alg: string | null;
  createdAt: Date;
  expiresAt: Date | null;
}

function buildRow(fixture: JwkFixture, useEncrypted: boolean): JwkRow {
  return {
    id: fixture.id,
    publicKey: fixture.publicJwkString,
    privateKey: useEncrypted
      ? fixture.encryptedPrivateKeyColumn
      : fixture.plainPrivateKeyColumn,
    alg: null,
    createdAt: new Date(),
    expiresAt: null,
  };
}

beforeEach(() => {
  mockInternalQuery.mockReset();
});

describe("mintLoadTestToken", () => {
  it("mints a JWT that verifies against the matching public key (encrypted private key path)", async () => {
    const fixture = await buildKeyFixture();
    mockInternalQuery.mockImplementation(async () => [buildRow(fixture, true)]);

    const minted = await mintLoadTestToken({
      workspaceId: WORKSPACE_ID,
      ttlSeconds: 300,
      issuer: ISSUER,
      audience: AUDIENCE,
      secret: TEST_SECRET,
    });

    expect(minted.bearer).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(minted.scope).toBe(LOAD_TEST_SCOPE);
    expect(minted.audience).toBe(AUDIENCE);
    expect(minted.issuer).toBe(ISSUER);
    expect(minted.sub).toMatch(new RegExp(`^${LOAD_TEST_SUBJECT_PREFIX}${WORKSPACE_ID}:`));
    expect(minted.jti).toMatch(/^[0-9a-f-]{36}$/);

    const publicKey = await jose.importJWK(fixture.publicJwk, "EdDSA");
    const { payload, protectedHeader } = await jose.jwtVerify(minted.bearer, publicKey, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });

    expect(protectedHeader.alg).toBe("EdDSA");
    expect(protectedHeader.kid).toBe(fixture.id);
    expect(payload.azp).toBe(LOAD_TEST_CLIENT_ID);
    expect(payload.scope).toBe(LOAD_TEST_SCOPE);
    expect(payload[ATLAS_OAUTH_WORKSPACE_CLAIM]).toBe(WORKSPACE_ID);
    expect(payload.sub).toBe(minted.sub);
    expect(payload.jti).toBe(minted.jti);
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect(typeof payload.nbf).toBe("number");
    expect(payload.exp! - payload.iat!).toBe(300);
  });

  it("mints against a plaintext private-key column (disablePrivateKeyEncryption=true)", async () => {
    const fixture = await buildKeyFixture();
    mockInternalQuery.mockImplementation(async () => [buildRow(fixture, false)]);

    const minted = await mintLoadTestToken({
      workspaceId: WORKSPACE_ID,
      ttlSeconds: 300,
      issuer: ISSUER,
      audience: AUDIENCE,
      // No secret needed when the private key isn't encrypted.
      secret: null,
    });

    const publicKey = await jose.importJWK(fixture.publicJwk, "EdDSA");
    const { payload } = await jose.jwtVerify(minted.bearer, publicKey, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(payload[ATLAS_OAUTH_WORKSPACE_CLAIM]).toBe(WORKSPACE_ID);
  });

  it("respects the requested TTL exactly (no silent clamping)", async () => {
    const fixture = await buildKeyFixture();
    mockInternalQuery.mockImplementation(async () => [buildRow(fixture, true)]);

    const minted = await mintLoadTestToken({
      workspaceId: WORKSPACE_ID,
      ttlSeconds: LOAD_TEST_TOKEN_MAX_TTL_SECONDS,
      issuer: ISSUER,
      audience: AUDIENCE,
      secret: TEST_SECRET,
    });

    const decoded = jose.decodeJwt(minted.bearer);
    expect(decoded.exp! - decoded.iat!).toBe(LOAD_TEST_TOKEN_MAX_TTL_SECONDS);

    const expDate = new Date(decoded.exp! * 1000);
    expect(minted.expiresAt).toBe(expDate.toISOString());
  });

  it("issues a unique synthetic subject per call so two mints for the same workspace do not collide", async () => {
    const fixture = await buildKeyFixture();
    mockInternalQuery.mockImplementation(async () => [buildRow(fixture, true)]);

    const a = await mintLoadTestToken({
      workspaceId: WORKSPACE_ID,
      ttlSeconds: 300,
      issuer: ISSUER,
      audience: AUDIENCE,
      secret: TEST_SECRET,
    });
    const b = await mintLoadTestToken({
      workspaceId: WORKSPACE_ID,
      ttlSeconds: 300,
      issuer: ISSUER,
      audience: AUDIENCE,
      secret: TEST_SECRET,
    });

    expect(a.sub).not.toBe(b.sub);
    expect(a.jti).not.toBe(b.jti);
    expect(a.bearer).not.toBe(b.bearer);
    // Both must carry the loadtest:<workspaceId>: prefix so audit queries
    // pivoting on `actor_id LIKE 'loadtest:%'` see them.
    expect(a.sub.startsWith(`${LOAD_TEST_SUBJECT_PREFIX}${WORKSPACE_ID}:`)).toBe(true);
    expect(b.sub.startsWith(`${LOAD_TEST_SUBJECT_PREFIX}${WORKSPACE_ID}:`)).toBe(true);
  });

  it("default TTL constant matches the issue contract (300s)", () => {
    // Pinned constants — bumping these is a contract change and should
    // also bump the route's OpenAPI description and the docs page. The
    // test assertion makes the constant change a tracked diff rather
    // than silent behaviour drift.
    expect(LOAD_TEST_TOKEN_DEFAULT_TTL_SECONDS).toBe(300);
    expect(LOAD_TEST_TOKEN_MAX_TTL_SECONDS).toBe(3600);
  });

  it("throws JwksNotInitializedError when the jwks table is empty", async () => {
    mockInternalQuery.mockImplementation(async () => []);

    await expect(
      mintLoadTestToken({
        workspaceId: WORKSPACE_ID,
        ttlSeconds: 300,
        issuer: ISSUER,
        audience: AUDIENCE,
        secret: TEST_SECRET,
      }),
    ).rejects.toBeInstanceOf(JwksNotInitializedError);
  });

  it("throws when the encrypted private key requires a secret but none was supplied", async () => {
    const fixture = await buildKeyFixture();
    mockInternalQuery.mockImplementation(async () => [buildRow(fixture, true)]);

    await expect(
      mintLoadTestToken({
        workspaceId: WORKSPACE_ID,
        ttlSeconds: 300,
        issuer: ISSUER,
        audience: AUDIENCE,
        secret: null,
      }),
    ).rejects.toThrow(/no secret was supplied/);
  });

  it("issuer + audience claims match the supplied region values verbatim (no host munging)", async () => {
    const fixture = await buildKeyFixture();
    mockInternalQuery.mockImplementation(async () => [buildRow(fixture, true)]);

    const euIssuer = "https://api-eu.useatlas.dev/api/auth";
    const euAudience = "https://api-eu.useatlas.dev/mcp";

    const minted = await mintLoadTestToken({
      workspaceId: WORKSPACE_ID,
      ttlSeconds: 300,
      issuer: euIssuer,
      audience: euAudience,
      secret: TEST_SECRET,
    });

    expect(minted.issuer).toBe(euIssuer);
    expect(minted.audience).toBe(euAudience);
    const decoded = jose.decodeJwt(minted.bearer);
    expect(decoded.iss).toBe(euIssuer);
    expect(decoded.aud).toBe(euAudience);
  });
});

describe("JwksNotInitializedError", () => {
  it("carries a stable code so route layer can map to 503 without string matching", () => {
    const err = new JwksNotInitializedError();
    expect(err.code).toBe("jwks_not_initialized");
    expect(err.name).toBe("JwksNotInitializedError");
    expect(err.message).toMatch(/seed/i);
  });
});
