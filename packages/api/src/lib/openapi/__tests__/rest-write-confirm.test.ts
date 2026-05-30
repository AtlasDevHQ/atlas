/**
 * Unit tests for the single-use confirm token primitives (#3007) in
 * `rest-write-confirm.ts`: mint → verify round-trip, tamper / expiry / binding
 * rejection, canonical-param order-independence, the single-use nonce burn, and
 * the fail-loud no-signing-key path.
 *
 * The route tests (`api/routes/__tests__/rest-operations.test.ts`) cover the
 * end-to-end HTTP contract; these isolate the crypto core so a regression in the
 * binding/canonicalization shows up here, close to the cause.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";

import {
  mintRestConfirmToken,
  verifyRestConfirmToken,
  burnRestConfirmNonce,
  _resetRestConfirmNonces,
  type RestConfirmBinding,
} from "@atlas/api/lib/openapi/rest-write-confirm";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/encryption-keys";

const SECRET = "test-confirm-token-signing-secret-not-a-real-key";

const ORIGINAL = {
  keys: process.env.ATLAS_ENCRYPTION_KEYS,
  key: process.env.ATLAS_ENCRYPTION_KEY,
  auth: process.env.BETTER_AUTH_SECRET,
};

function clearKeyEnv() {
  delete process.env.ATLAS_ENCRYPTION_KEYS;
  delete process.env.ATLAS_ENCRYPTION_KEY;
  delete process.env.BETTER_AUTH_SECRET;
  _resetEncryptionKeyCache();
}

function restoreKeyEnv() {
  if (ORIGINAL.keys === undefined) delete process.env.ATLAS_ENCRYPTION_KEYS;
  else process.env.ATLAS_ENCRYPTION_KEYS = ORIGINAL.keys;
  if (ORIGINAL.key === undefined) delete process.env.ATLAS_ENCRYPTION_KEY;
  else process.env.ATLAS_ENCRYPTION_KEY = ORIGINAL.key;
  if (ORIGINAL.auth === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = ORIGINAL.auth;
  _resetEncryptionKeyCache();
}

const binding = (overrides: Partial<RestConfirmBinding> = {}): RestConfirmBinding => ({
  workspaceId: "ws-1",
  datasourceId: "twenty",
  operationId: "createOnePerson",
  params: { body: { name: { firstName: "Ada", lastName: "Lovelace" } } },
  ...overrides,
});

describe("rest confirm token — mint/verify", () => {
  beforeAll(() => {
    clearKeyEnv();
    process.env.BETTER_AUTH_SECRET = SECRET;
    _resetEncryptionKeyCache();
  });
  afterAll(() => {
    restoreKeyEnv();
    _resetRestConfirmNonces();
  });

  it("round-trips a freshly minted token", () => {
    const b = binding();
    const token = mintRestConfirmToken(b);
    const v = verifyRestConfirmToken(token, b);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(typeof v.nonce).toBe("string");
    expect(v.nonce.length).toBeGreaterThan(0);
    expect(v.expSeconds).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("binds params by canonical hash — key order does NOT matter", () => {
    // Mint over one key order; verify against the SAME logical params in a
    // different insertion order. JSON key order isn't guaranteed to round-trip,
    // so canonicalization must make these equal — else legit confirms get rejected.
    const token = mintRestConfirmToken(
      binding({ params: { body: { a: 1, b: 2, nested: { x: 1, y: 2 } } } }),
    );
    const v = verifyRestConfirmToken(token, binding({ params: { body: { nested: { y: 2, x: 1 }, b: 2, a: 1 } } }));
    expect(v.ok).toBe(true);
  });

  it("rejects a token whose params were tampered after minting (binding-mismatch)", () => {
    const token = mintRestConfirmToken(binding({ params: { body: { amount: 10 } } }));
    const v = verifyRestConfirmToken(token, binding({ params: { body: { amount: 1_000_000 } } }));
    expect(v).toEqual({ ok: false, reason: "binding-mismatch" });
  });

  it.each([
    ["workspaceId", binding({ workspaceId: "ws-evil" })],
    ["datasourceId", binding({ datasourceId: "stripe" })],
    ["operationId", binding({ operationId: "deleteOnePerson" })],
  ])("rejects a token minted for a different %s (binding-mismatch)", (_dim, expected) => {
    const token = mintRestConfirmToken(binding());
    const v = verifyRestConfirmToken(token, expected);
    expect(v).toEqual({ ok: false, reason: "binding-mismatch" });
  });

  it("rejects a token with a tampered signature (bad-signature)", () => {
    const token = mintRestConfirmToken(binding());
    const segs = token.split(".");
    segs[2] = segs[2].slice(0, -1) + (segs[2].endsWith("A") ? "B" : "A");
    expect(verifyRestConfirmToken(segs.join("."), binding())).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a tampered payload segment (signature no longer matches)", () => {
    const token = mintRestConfirmToken(binding());
    const segs = token.split(".");
    // Re-encode a payload claiming a different workspace; the signature was over
    // the original payload bytes, so it can't validate.
    segs[1] = Buffer.from(JSON.stringify({ w: "ws-evil", ds: "twenty", op: "x", ph: "0", n: "z", exp: 9e9 })).toString(
      "base64url",
    );
    expect(verifyRestConfirmToken(segs.join("."), binding()).ok).toBe(false);
  });

  it("rejects a malformed (non-three-part) token", () => {
    expect(verifyRestConfirmToken("not-a-token", binding())).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects an empty token as missing", () => {
    expect(verifyRestConfirmToken("", binding())).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects an expired token", () => {
    const token = mintRestConfirmToken(binding(), { nowSeconds: 1_000, ttlSeconds: 60 }); // exp = 1060
    expect(verifyRestConfirmToken(token, binding(), 2_000)).toEqual({ ok: false, reason: "expired" });
    // …and valid just before expiry.
    expect(verifyRestConfirmToken(token, binding(), 1_059).ok).toBe(true);
  });
});

describe("rest confirm nonce — single-use store", () => {
  beforeAll(() => _resetRestConfirmNonces());
  afterAll(() => _resetRestConfirmNonces());

  it("burns a nonce exactly once (replay returns false)", () => {
    _resetRestConfirmNonces();
    const exp = Math.floor(Date.now() / 1000) + 600;
    expect(burnRestConfirmNonce("nonce-A", exp)).toBe(true);
    expect(burnRestConfirmNonce("nonce-A", exp)).toBe(false); // replay
    expect(burnRestConfirmNonce("nonce-B", exp)).toBe(true); // a different nonce is independent
  });

  it("evicts an expired burned nonce so its slot is reclaimed", () => {
    _resetRestConfirmNonces();
    // Burn a nonce that expires at t=1000; at a later 'now' the eviction sweep drops
    // it. (A token with that nonce would already be rejected by the expiry check.)
    expect(burnRestConfirmNonce("ephemeral", 1_000, 900)).toBe(true);
    // Re-burning the same nonce at a 'now' past its exp succeeds — it was evicted.
    expect(burnRestConfirmNonce("ephemeral", 5_000, 2_000)).toBe(true);
  });
});

describe("rest confirm token — no signing key (fail loud)", () => {
  beforeAll(() => clearKeyEnv());
  afterAll(() => restoreKeyEnv());

  it("mint throws (the confirm gate can't degrade to an unsigned token)", () => {
    expect(() => mintRestConfirmToken(binding())).toThrow(/no signing key configured/);
  });

  it("verify rejects with no-key (never validates without a key)", () => {
    expect(verifyRestConfirmToken("a.b.c", binding())).toEqual({ ok: false, reason: "no-key" });
  });
});
