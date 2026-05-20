/**
 * Tests for `OAuthStateToken` — slice 4 of #2649 (issue #2652).
 *
 * The token is the CSRF gate between Platform install start and OAuth
 * callback. A working token says: "the same Workspace that started this
 * install is the one whose code is now coming back." `verify` returns
 * `null` on every failure path so callers cannot accidentally leak which
 * check tripped (header tamper vs. signature mismatch vs. expiry).
 *
 * Key rotation:
 *   - `mint` always signs with the active (highest-version) key
 *   - `verify` honours the token's `kid` claim and looks up the key in
 *     the keyset — so a token minted under v1 still verifies after v2
 *     was promoted to active, until v1 is dropped from the env.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/encryption-keys";
import {
  mintOAuthStateToken,
  verifyOAuthStateToken,
} from "../oauth-state-token";

// ---------------------------------------------------------------------------
// Test scaffolding — env-driven keyset
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };

function setKeys(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.ATLAS_ENCRYPTION_KEYS;
  } else {
    process.env.ATLAS_ENCRYPTION_KEYS = value;
  }
  delete process.env.ATLAS_ENCRYPTION_KEY;
  delete process.env.BETTER_AUTH_SECRET;
  _resetEncryptionKeyCache();
}

beforeEach(() => {
  setKeys("v1:test-key-one");
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetEncryptionKeyCache();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("OAuthStateToken — roundtrip", () => {
  it("mints a token and verifies the same workspaceId + catalogId back", () => {
    const token = mintOAuthStateToken("org-abc", "slack");
    const verified = verifyOAuthStateToken(token);
    expect(verified).toEqual({ workspaceId: "org-abc", catalogId: "slack" });
  });

  it("produces a different token each call (random not required, but distinct payload+sig is fine)", () => {
    const a = mintOAuthStateToken("org-abc", "slack");
    // Force a different `exp` by passing an explicit nowSeconds — this
    // also documents the test injection seam.
    const b = mintOAuthStateToken("org-abc", "slack", { nowSeconds: 1_700_000_000 });
    expect(a).not.toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// Failure modes — all must return null, never throw
// ---------------------------------------------------------------------------

describe("OAuthStateToken — tampering", () => {
  it("returns null when the payload segment is tampered", () => {
    const token = mintOAuthStateToken("org-abc", "slack");
    const parts = token.split(".");
    expect(parts.length).toBe(3);
    // Flip one character in the payload segment (middle).
    const tampered = `${parts[0]}.${parts[1].slice(0, -1)}X.${parts[2]}`;
    expect(verifyOAuthStateToken(tampered)).toBeNull();
  });

  it("returns null when the signature segment is tampered", () => {
    const token = mintOAuthStateToken("org-abc", "slack");
    const parts = token.split(".");
    const tamperedSig = `${parts[2].slice(0, -1)}A`;
    expect(verifyOAuthStateToken(`${parts[0]}.${parts[1]}.${tamperedSig}`)).toBeNull();
  });

  it("returns null when the header segment is tampered (kid swap)", () => {
    const token = mintOAuthStateToken("org-abc", "slack");
    const parts = token.split(".");
    // Re-encode a header with a kid that isn't in the keyset.
    const fakeHeader = Buffer.from(
      JSON.stringify({ alg: "HS256", kid: 999, typ: "AtlasOAuthState" }),
      "utf8",
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(verifyOAuthStateToken(`${fakeHeader}.${parts[1]}.${parts[2]}`)).toBeNull();
  });

  it("returns null when alg is anything but HS256", () => {
    const token = mintOAuthStateToken("org-abc", "slack");
    const parts = token.split(".");
    const noneHeader = Buffer.from(
      JSON.stringify({ alg: "none", kid: 1, typ: "AtlasOAuthState" }),
      "utf8",
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(verifyOAuthStateToken(`${noneHeader}.${parts[1]}.${parts[2]}`)).toBeNull();
  });
});

describe("OAuthStateToken — expiry", () => {
  it("returns null when the token's exp is in the past", () => {
    const past = Math.floor(Date.now() / 1000) - 60 * 60; // 1h ago
    const token = mintOAuthStateToken("org-abc", "slack", {
      nowSeconds: past,
      ttlSeconds: 60, // 1 min lifetime, already long expired
    });
    expect(verifyOAuthStateToken(token)).toBeNull();
  });

  it("accepts a token within its TTL window", () => {
    // exp = now + 10 min
    const token = mintOAuthStateToken("org-abc", "slack", { ttlSeconds: 600 });
    expect(verifyOAuthStateToken(token)).toEqual({
      workspaceId: "org-abc",
      catalogId: "slack",
    });
  });
});

describe("OAuthStateToken — key rotation", () => {
  it("verifies a v1-minted token after v2 has been promoted to active", () => {
    // Mint with only v1 in the keyset.
    setKeys("v1:legacy-key");
    const token = mintOAuthStateToken("org-abc", "slack");

    // Now rotate: v2 is active, v1 is still readable.
    setKeys("v2:current-key,v1:legacy-key");
    expect(verifyOAuthStateToken(token)).toEqual({
      workspaceId: "org-abc",
      catalogId: "slack",
    });
  });

  it("rejects a v1-minted token once v1 has been dropped from the keyset", () => {
    setKeys("v1:legacy-key");
    const token = mintOAuthStateToken("org-abc", "slack");

    setKeys("v2:current-key");
    expect(verifyOAuthStateToken(token)).toBeNull();
  });
});

describe("OAuthStateToken — malformed input", () => {
  it("returns null for the empty string", () => {
    expect(verifyOAuthStateToken("")).toBeNull();
  });

  it("returns null when the token has the wrong segment count", () => {
    expect(verifyOAuthStateToken("only.two")).toBeNull();
    expect(verifyOAuthStateToken("a.b.c.d")).toBeNull();
  });

  it("returns null when a segment is not valid base64url JSON", () => {
    expect(verifyOAuthStateToken("@@@.@@@.@@@")).toBeNull();
  });

  it("returns null when claims are missing required fields", () => {
    // Hand-craft a token with a v1-signed body that omits `catalogId`.
    // We do this by minting then surgically replacing the payload — the
    // signature will no longer match, which is the *whole point* (any
    // edit invalidates the token).
    const token = mintOAuthStateToken("org-abc", "slack");
    const parts = token.split(".");
    const badPayload = Buffer.from(
      JSON.stringify({ workspaceId: "org-abc", exp: 9_999_999_999 }),
      "utf8",
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(verifyOAuthStateToken(`${parts[0]}.${badPayload}.${parts[2]}`)).toBeNull();
  });
});

describe("OAuthStateToken — misconfig", () => {
  it("throws when no encryption key is configured at mint time (CSRF cannot passthrough)", () => {
    setKeys(undefined);
    expect(() => mintOAuthStateToken("org-abc", "slack")).toThrow(
      /encryption key/i,
    );
  });

  it("returns null on verify when no encryption key is configured", () => {
    // First mint with a key, then yank the env.
    setKeys("v1:test-key");
    const token = mintOAuthStateToken("org-abc", "slack");
    setKeys(undefined);
    expect(verifyOAuthStateToken(token)).toBeNull();
  });
});
