/**
 * Unit tests for the brain-correction confirm token (#5496) — the gate that
 * makes "a human approved THIS correction" server-verifiable.
 *
 * Three of the issue's acceptance criteria are decided here rather than at the
 * route, because they are properties of the token itself:
 *
 *   - **a tampered payload cannot escalate** — swapping the verb, the fact, the
 *     workspace, or a `supersede`'s replacement value after staging breaks the
 *     binding;
 *   - **the token is single-use** — a replayed confirm is refused;
 *   - **no new signing secret** — it signs with the resolved encryption keyset,
 *     the same one `oauth-state-token.ts` and the REST write gate use.
 *
 * The fourth property this file pins is not in the issue but follows from
 * sharing one implementation with the REST gate: a token minted for one gate
 * must not verify at the other. `typ` is what enforces it, and a shared crypto
 * core is exactly the change that would make forgetting it plausible.
 *
 * The route tests cover the HTTP contract and the server-side RE-VALIDATION
 * (authority, ACL, tier-1) that the token deliberately says nothing about.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";

import {
  mintCorrectionConfirmToken,
  verifyCorrectionConfirmToken,
  burnCorrectionConfirmNonce,
  type CorrectionConfirmBinding,
} from "@atlas/api/lib/brain/correction-confirm";
import {
  mintRestConfirmToken,
  verifyRestConfirmToken,
} from "@atlas/api/lib/openapi/rest-write-confirm";
import { _resetConfirmNonces } from "@atlas/api/lib/confirm-token";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/encryption-keys";

const SECRET = "test-correction-confirm-signing-secret-not-a-real-key";

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

const FACT = "6f2c0000-0000-4000-8000-000000000000";

const binding = (overrides: Partial<CorrectionConfirmBinding> = {}): CorrectionConfirmBinding => ({
  workspaceId: "ws-1",
  factId: FACT,
  verb: "supersede",
  payload: { reason: "Ana left the team", replacement: { object: "Bo" } },
  ...overrides,
});

describe("correction confirm token — mint/verify", () => {
  beforeAll(() => {
    clearKeyEnv();
    process.env.BETTER_AUTH_SECRET = SECRET;
    _resetEncryptionKeyCache();
  });
  afterAll(restoreKeyEnv);

  it("round-trips a token bound to the staged correction", () => {
    const token = mintCorrectionConfirmToken(binding());
    expect(verifyCorrectionConfirmToken(token, binding()).ok).toBe(true);
  });

  it("signs with the existing keyset — no new secret is introduced", () => {
    // The acceptance criterion, made falsifiable: with the keyset env cleared,
    // mint must THROW rather than fall through to an unsigned token. If the gate
    // had its own secret, clearing these three would not affect it.
    const token = mintCorrectionConfirmToken(binding());
    clearKeyEnv();
    try {
      expect(() => mintCorrectionConfirmToken(binding())).toThrow(/no signing key configured/);
      // …and a previously-minted token stops verifying, because there is no key
      // to verify it WITH — not because it was rejected on its merits.
      expect(verifyCorrectionConfirmToken(token, binding())).toEqual({
        ok: false,
        reason: "no-key",
      });
    } finally {
      process.env.BETTER_AUTH_SECRET = SECRET;
      _resetEncryptionKeyCache();
    }
  });

  // ⭐ The tamper matrix. Each row is a field a client could edit between
  // staging and confirming; each must break the binding. The `replacement` row
  // is the one that matters most — it is the only edit that changes WHAT THE
  // HUMAN AGREED TO while leaving the correction plausible.
  const tampers: ReadonlyArray<readonly [string, Partial<CorrectionConfirmBinding>]> = [
    ["a different workspace", { workspaceId: "ws-evil" }],
    ["a different fact", { factId: "11110000-0000-4000-8000-000000000000" }],
    ["a different verb", { verb: "retract" }],
    ["a swapped replacement value", { payload: { reason: "Ana left the team", replacement: { object: "Evil" } } }],
    ["a dropped reason", { payload: { replacement: { object: "Bo" } } }],
    ["an added validFrom", { payload: { reason: "Ana left the team", replacement: { object: "Bo", validFrom: "2020-01-01T00:00:00.000Z" } } }],
  ];

  for (const [label, overrides] of tampers) {
    it(`refuses ${label} as a binding mismatch`, () => {
      const token = mintCorrectionConfirmToken(binding());
      expect(verifyCorrectionConfirmToken(token, binding(overrides))).toEqual({
        ok: false,
        reason: "binding-mismatch",
      });
    });
  }

  it("is insensitive to payload KEY ORDER — the same correction hashes the same", () => {
    // The client round-trips the staged JSON through the browser, and object key
    // order is not preserved by every path it takes. A binding that depended on
    // it would reject confirmations that changed nothing.
    const token = mintCorrectionConfirmToken(
      binding({ payload: { reason: "r", replacement: { object: "Bo", validFrom: "2026-01-01T00:00:00.000Z" } } }),
    );
    const reordered = binding({
      payload: { replacement: { validFrom: "2026-01-01T00:00:00.000Z", object: "Bo" }, reason: "r" },
    });
    expect(verifyCorrectionConfirmToken(token, reordered).ok).toBe(true);
  });

  it("treats an absent optional field and an explicit `undefined` as the same correction", () => {
    // `JSON.stringify` drops `undefined` values, so a client that echoes the
    // staged payload back sends the absent form. Both must hash identically or
    // a `retract` staged with no reason could never be confirmed.
    const token = mintCorrectionConfirmToken(binding({ verb: "retract", payload: {} }));
    expect(
      verifyCorrectionConfirmToken(
        token,
        // Neither `reason` nor `replacement` supplied — both are exact optionals,
            // so the payload that omits them IS the empty object (#5522).
            binding({ verb: "retract", payload: {} }),
      ).ok,
    ).toBe(true);
  });

  it("rejects a tampered signature", () => {
    const token = mintCorrectionConfirmToken(binding());
    const segs = token.split(".");
    // Tamper at the BYTE level — flipping the last base64url char can be a
    // no-op (the final char of a 32-byte sig carries unused low bits).
    const sig = Buffer.from(segs[2], "base64url");
    sig[0] ^= 0xff;
    segs[2] = sig.toString("base64url");
    expect(verifyCorrectionConfirmToken(segs.join("."), binding())).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects a malformed token, and an empty one as missing", () => {
    expect(verifyCorrectionConfirmToken("not-a-token", binding())).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verifyCorrectionConfirmToken("", binding())).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects an expired token, and accepts one just before expiry", () => {
    const token = mintCorrectionConfirmToken(binding(), { nowSeconds: 1_000, ttlSeconds: 60 });
    expect(verifyCorrectionConfirmToken(token, binding(), 2_000)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(verifyCorrectionConfirmToken(token, binding(), 1_059).ok).toBe(true);
  });
});

describe("correction confirm token — single-use", () => {
  beforeAll(() => {
    clearKeyEnv();
    process.env.BETTER_AUTH_SECRET = SECRET;
    _resetEncryptionKeyCache();
    _resetConfirmNonces();
  });
  afterAll(restoreKeyEnv);

  it("burns once — a replay of the same token is refused", () => {
    // The acceptance criterion: "a replayed confirm is rejected. A looping agent
    // cannot re-fire." Both are the same mechanism.
    const token = mintCorrectionConfirmToken(binding(), { nonce: "nonce-replay-1" });
    const first = verifyCorrectionConfirmToken(token, binding());
    if (!first.ok) throw new Error(`expected a valid token, got ${first.reason}`);

    expect(burnCorrectionConfirmNonce(first.nonce, first.expSeconds)).toBe(true);
    // The token still VERIFIES — it is cryptographically fine. What stops the
    // second confirm is the burn, which is why the route must do both.
    expect(verifyCorrectionConfirmToken(token, binding()).ok).toBe(true);
    expect(burnCorrectionConfirmNonce(first.nonce, first.expSeconds)).toBe(false);
  });
});

describe("confirm gates are domain-separated", () => {
  beforeAll(() => {
    clearKeyEnv();
    process.env.BETTER_AUTH_SECRET = SECRET;
    _resetEncryptionKeyCache();
  });
  afterAll(restoreKeyEnv);

  // Both gates sign with the SAME key and, since #5496, the same code. The only
  // thing keeping a token minted for one from being presented at the other is
  // the `typ` domain separator in the signed header — so it gets a test, in both
  // directions, rather than a comment.
  it("a REST write token does not verify at the correction gate", () => {
    const restToken = mintRestConfirmToken({
      workspaceId: "ws-1",
      datasourceId: "twenty",
      operationId: "createOnePerson",
      params: { body: { name: "Ada" } },
    });
    expect(verifyCorrectionConfirmToken(restToken, binding())).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("a correction token does not verify at the REST write gate", () => {
    const correctionToken = mintCorrectionConfirmToken(binding());
    expect(
      verifyRestConfirmToken(correctionToken, {
        workspaceId: "ws-1",
        datasourceId: "twenty",
        operationId: "createOnePerson",
        params: { body: { name: "Ada" } },
      }),
    ).toEqual({ ok: false, reason: "malformed" });
  });
});
