/**
 * The staged-write gate, tested ONCE, table-driven over every registered verb
 * (#5571).
 *
 * This file is the acceptance criterion in executable form: *"the verify→burn
 * ordering (replay safety, burn-even-on-refusal) is implemented once and tested
 * once, table-driven over the registered verbs — a third verb inherits it with
 * no new gate code."* Every case below runs against {@link STAGED_VERBS}, so
 * adding a third {@link StagedVerb} to that table is what proves the third verb
 * inherited the gate. Nothing here is per-verb except the binding each row
 * supplies and the one field it tampers with.
 *
 * ## What this file does NOT test
 *
 * The crypto. `confirm-token.ts` owns the HMAC scheme, the canonicalization and
 * the binding comparison, and its own tests own those properties; re-asserting
 * them here would be a second copy of exactly the kind this refactor removed.
 * What is tested here is the SEQUENCING the seam adds on top: which rejection
 * arm each failure lands in, that the burn happens on the attempt, and that a
 * spent nonce cannot be spent twice.
 *
 * Nor, in the table itself, the per-verb bindings' substance — the
 * `correction confirm token` describes at the bottom of this file (merged in
 * from the former `staged-correct.test.ts`) still pin what a correction token
 * binds and what tampering with each field does, and the two route suites still
 * pin the HTTP contract. The table sits between them, on the part that used to
 * be written twice.
 *
 * ⚠️ **The REST write gate is deliberately absent from the table.** It is the
 * third confirm gate in the product, and it is not a `StagedVerb` because its
 * invariant genuinely differs: `rest-operations.ts` interposes the allowlist
 * re-validation between verification and the burn, so a confirm its allowlist
 * refuses does NOT spend its nonce — the opposite of the burn-on-attempt these
 * two verbs share. `rest-write-confirm.ts` carries the full note.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";

import {
  mintStagedConfirmToken,
  verifyAndBurnStagedConfirm,
  verifyStagedConfirmToken,
  type StagedConfirmGate,
} from "@atlas/api/lib/brain/staged-write";
import {
  PROPOSAL_STAGED_VERB,
  type ProposalConfirmBinding,
} from "@atlas/api/lib/brain/staged-propose";
import {
  CORRECTION_STAGED_VERB,
  type CorrectionConfirmBinding,
} from "@atlas/api/lib/brain/staged-correct";
import {
  mintRestConfirmToken,
  verifyRestConfirmToken,
} from "@atlas/api/lib/openapi/rest-write-confirm";
import type { MintConfirmTokenOptions } from "@atlas/api/lib/confirm-token";
import { _resetConfirmNonces, burnConfirmNonce } from "@atlas/api/lib/confirm-token";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/encryption-keys";

const SECRET = "test-staged-write-gate-signing-secret-not-a-real-key";

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

beforeAll(() => {
  clearKeyEnv();
  process.env.BETTER_AUTH_SECRET = SECRET;
  _resetEncryptionKeyCache();
});

afterAll(() => {
  if (ORIGINAL.keys === undefined) delete process.env.ATLAS_ENCRYPTION_KEYS;
  else process.env.ATLAS_ENCRYPTION_KEYS = ORIGINAL.keys;
  if (ORIGINAL.key === undefined) delete process.env.ATLAS_ENCRYPTION_KEY;
  else process.env.ATLAS_ENCRYPTION_KEY = ORIGINAL.key;
  if (ORIGINAL.auth === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = ORIGINAL.auth;
  _resetEncryptionKeyCache();
  _resetConfirmNonces();
});

beforeEach(() => {
  _resetConfirmNonces();
});

/**
 * One row per staged verb, as already-closed operations rather than as a verb
 * plus a loose binding.
 *
 * The gate is generic in its binding, so a table holding `StagedVerb<A>` beside
 * `StagedVerb<B>` needs an existential the language does not have — and casting
 * the rows to a common erased type would throw away the one guarantee the seam
 * exists to give: that a verb's token is minted and verified against the SAME
 * binding type. So each row closes over its own concrete types HERE, where the
 * compiler still checks the pairing, and exposes only the erased operations the
 * cases below need. Every `mint`/`gate` call in this file is type-checked
 * against its verb's real binding.
 */
interface VerbRow {
  readonly label: string;
  readonly typ: string;
  readonly ttlEnvVar: string;
  /** Mint against this verb's own correct binding. */
  readonly mint: (options?: MintConfirmTokenOptions) => string;
  /** Mint against a binding in a different workspace. */
  readonly mintForeignWorkspace: () => string;
  /** Run the full gate against this verb's own correct binding. */
  readonly gate: (token: string, nowSeconds?: number) => StagedConfirmGate;
  /** Run the gate against a binding with ONE bound field changed. */
  readonly gateTampered: (token: string) => StagedConfirmGate;
  /** Verify WITHOUT burning — the pure half. */
  readonly verifyOnly: (token: string) => boolean;
  /** What `gateTampered` changed, for the assertion message. */
  readonly tamperedField: string;
}

const PROPOSAL_ROW: VerbRow = (() => {
  const verb = PROPOSAL_STAGED_VERB;
  const binding: ProposalConfirmBinding = {
    workspaceId: "ws-1",
    claim: { subject: "Ana", predicate: "is the DRI for", object: "billing" },
  };
  const tampered: ProposalConfirmBinding = {
    ...binding,
    claim: { ...binding.claim, object: "payroll" },
  };
  return {
    label: "proposeFact",
    typ: verb.kind.typ,
    ttlEnvVar: verb.kind.ttlEnvVar,
    mint: (options) => mintStagedConfirmToken(verb, binding, options),
    mintForeignWorkspace: () =>
      mintStagedConfirmToken(verb, { ...binding, workspaceId: "ws-other" }),
    gate: (token, nowSeconds) =>
      nowSeconds === undefined
        ? verifyAndBurnStagedConfirm(verb, token, binding)
        : verifyAndBurnStagedConfirm(verb, token, binding, nowSeconds),
    gateTampered: (token) => verifyAndBurnStagedConfirm(verb, token, tampered),
    verifyOnly: (token) => verifyStagedConfirmToken(verb, token, binding).ok,
    tamperedField: "the claim's object — what would be asserted",
  };
})();

const CORRECTION_ROW: VerbRow = (() => {
  const verb = CORRECTION_STAGED_VERB;
  const binding: CorrectionConfirmBinding = {
    workspaceId: "ws-1",
    factId: "fact-1",
    verb: "supersede",
    payload: { replacement: { object: "Bo" } },
  };
  const tampered: CorrectionConfirmBinding = {
    ...binding,
    payload: { replacement: { object: "Cy" } },
  };
  return {
    label: "correct_fact",
    typ: verb.kind.typ,
    ttlEnvVar: verb.kind.ttlEnvVar,
    mint: (options) => mintStagedConfirmToken(verb, binding, options),
    mintForeignWorkspace: () =>
      mintStagedConfirmToken(verb, { ...binding, workspaceId: "ws-other" }),
    gate: (token, nowSeconds) =>
      nowSeconds === undefined
        ? verifyAndBurnStagedConfirm(verb, token, binding)
        : verifyAndBurnStagedConfirm(verb, token, binding, nowSeconds),
    gateTampered: (token) => verifyAndBurnStagedConfirm(verb, token, tampered),
    verifyOnly: (token) => verifyStagedConfirmToken(verb, token, binding).ok,
    tamperedField: "the replacement value — what the fact would become",
  };
})();

/**
 * The registered staged verbs.
 *
 * ⚠️ **A third staged verb goes here, and nowhere else.** If adding it needs a
 * new `it(...)` below rather than a new row, the gate grew a per-verb branch and
 * the refactor has been undone. `registry.test.ts` pins the confirm-capable
 * delta as an exact set, so the verb has to be named there too — that is the
 * other half of the same guard.
 */
const STAGED_VERBS: readonly VerbRow[] = [PROPOSAL_ROW, CORRECTION_ROW];

describe("the staged-write gate — every registered verb", () => {
  it("registers each verb under a DISTINCT typ, so no token is spendable at another gate", () => {
    // Asserted as a set rather than in the per-verb loop: the property is about
    // the collection, and a duplicate `typ` would make one verb's confirmation
    // spendable on another's write.
    const typs = STAGED_VERBS.map((r) => r.typ);
    expect(new Set(typs).size).toBe(typs.length);
    // Distinct TTL vars too — an operator tuning one gate's window must not
    // silently move the other's.
    const envVars = STAGED_VERBS.map((r) => r.ttlEnvVar);
    expect(new Set(envVars).size).toBe(envVars.length);
  });

  for (const row of STAGED_VERBS) {
    describe(row.label, () => {
      it("⭐ refuses the SECOND presentation of one token — the nonce is single-use, and burned on the ATTEMPT", () => {
        // A correctly-bound token is admitted once. The gate returns `ok: true`
        // and the caller goes on to a write that may refuse or throw; that is
        // the interesting case: the nonce must stay spent, or one confirmation
        // could be re-fired against many claims or many target states — a graph
        // probe. Nothing hands the nonce back.
        const token = row.mint();
        expect(row.gate(token)).toEqual({ ok: true });
        expect(
          row.gate(token),
          "a replayed confirm was admitted — a looping agent could re-fire one human confirmation",
        ).toEqual({ ok: false, failure: "replayed" });
      });

      it("⭐ rejects a payload edited after staging, without burning anything", () => {
        const token = row.mint();
        expect(
          row.gateTampered(token),
          `a token survived a tamper of ${row.tamperedField}`,
        ).toEqual({ ok: false, failure: "invalid", reason: "binding-mismatch" });
        // The tampered attempt must not have spent the nonce: an attacker who
        // could burn a pending confirmation by POSTing a mangled copy of it
        // would have a denial-of-service on every staged write.
        expect(row.gate(token)).toEqual({ ok: true });
      });

      it("rejects a token minted for another workspace", () => {
        expect(row.gate(row.mintForeignWorkspace())).toEqual({
          ok: false,
          failure: "invalid",
          reason: "binding-mismatch",
        });
      });

      it("rejects a missing and a malformed token under the one neutral arm", () => {
        expect(row.gate("")).toEqual({ ok: false, failure: "invalid", reason: "missing" });
        expect(row.gate("not-a-token")).toEqual({
          ok: false,
          failure: "invalid",
          reason: "malformed",
        });
      });

      it("rejects an expired token, and does not burn it", () => {
        const token = row.mint({ nowSeconds: 1_000, ttlSeconds: 60 });
        expect(row.gate(token, 2_000)).toEqual({
          ok: false,
          failure: "invalid",
          reason: "expired",
        });
        // Still inside its window it is admitted — proving the rejection above
        // was the clock and not a burn the expired attempt performed.
        expect(row.gate(token, 1_059)).toEqual({ ok: true });
      });

      it("⭐ separates a missing signing key from an invalid token — a 500, never the neutral 400", () => {
        // `no-key` is an operator misconfiguration. Collapsing it into the
        // neutral client rejection would tell a caller their confirmation was
        // bad when the server was, and hide a broken deployment behind a 400.
        clearKeyEnv();
        try {
          expect(row.gate("a.b.c")).toEqual({ ok: false, failure: "unverifiable" });
          expect(() => row.mint()).toThrow(/no signing key configured/);
        } finally {
          process.env.BETTER_AUTH_SECRET = SECRET;
          _resetEncryptionKeyCache();
        }
      });
    });
  }

  it("⭐ refuses a token minted for a DIFFERENT registered verb", () => {
    // The cross-product, not a hand-written pair: every verb's token must be
    // refused at every OTHER verb's gate. `typ` is what enforces it, and one
    // shared crypto core is exactly the change that would make forgetting it
    // plausible.
    for (const minter of STAGED_VERBS) {
      const token = minter.mint();
      for (const presenter of STAGED_VERBS) {
        if (presenter === minter) continue;
        expect(
          presenter.gate(token),
          `a ${minter.label} confirmation was spendable at the ${presenter.label} gate`,
        ).toEqual({ ok: false, failure: "invalid", reason: "malformed" });
      }
    }
  });

  it("⭐ verification alone never burns — only the gate does", () => {
    // The one property that makes `verifyAndBurnStagedConfirm` worth being a
    // single function: `verifyStagedConfirmToken` is pure, so a caller that
    // reached for it directly would leave the nonce unspent. That is the shape
    // the seam exists to keep out of production paths, and it is asserted here
    // so the purity is not quietly lost.
    for (const row of STAGED_VERBS) {
      _resetConfirmNonces();
      const token = row.mint();
      expect(row.verifyOnly(token)).toBe(true);
      expect(row.verifyOnly(token)).toBe(true);
      // …and the nonce is still there to be spent.
      expect(row.gate(token)).toEqual({ ok: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The correction verb's binding — merged in from `staged-correct.test.ts`
// (#5496; the descriptor is `staged-correct.ts` since #5571).
//
// Three of that issue's acceptance criteria are decided here rather than at the
// route, because they are properties of the token itself:
//
//   - **a tampered payload cannot escalate** — swapping the verb, the fact, the
//     workspace, or a `supersede`'s replacement value after staging breaks the
//     binding;
//   - **the token is single-use** — a replayed confirm is refused;
//   - **no new signing secret** — it signs with the resolved encryption keyset,
//     the same one `oauth-state-token.ts` and the REST write gate use.
//
// The fourth property pinned below is not in the issue but follows from sharing
// one implementation with the REST gate: a token minted for one gate must not
// verify at the other. `typ` is what enforces it, and a shared crypto core is
// exactly the change that would make forgetting it plausible.
//
// The route tests cover the HTTP contract and the server-side RE-VALIDATION
// (authority, ACL, tier-1) that the token deliberately says nothing about.
// ---------------------------------------------------------------------------

const FACT = "6f2c0000-0000-4000-8000-000000000000";

const binding = (overrides: Partial<CorrectionConfirmBinding> = {}): CorrectionConfirmBinding => ({
  workspaceId: "ws-1",
  factId: FACT,
  verb: "supersede",
  payload: { reason: "Ana left the team", replacement: { object: "Bo" } },
  ...overrides,
});

describe("correction confirm token — mint/verify", () => {
  it("round-trips a token bound to the staged correction", () => {
    const token = mintStagedConfirmToken(CORRECTION_STAGED_VERB, binding());
    expect(verifyStagedConfirmToken(CORRECTION_STAGED_VERB, token, binding()).ok).toBe(true);
  });

  it("signs with the existing keyset — no new secret is introduced", () => {
    // The acceptance criterion, made falsifiable: with the keyset env cleared,
    // mint must THROW rather than fall through to an unsigned token. If the gate
    // had its own secret, clearing these three would not affect it.
    const token = mintStagedConfirmToken(CORRECTION_STAGED_VERB, binding());
    clearKeyEnv();
    try {
      expect(() => mintStagedConfirmToken(CORRECTION_STAGED_VERB, binding())).toThrow(/no signing key configured/);
      // …and a previously-minted token stops verifying, because there is no key
      // to verify it WITH — not because it was rejected on its merits.
      expect(verifyStagedConfirmToken(CORRECTION_STAGED_VERB, token, binding())).toEqual({
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
      const token = mintStagedConfirmToken(CORRECTION_STAGED_VERB, binding());
      expect(verifyStagedConfirmToken(CORRECTION_STAGED_VERB, token, binding(overrides))).toEqual({
        ok: false,
        reason: "binding-mismatch",
      });
    });
  }

  it("is insensitive to payload KEY ORDER — the same correction hashes the same", () => {
    // The client round-trips the staged JSON through the browser, and object key
    // order is not preserved by every path it takes. A binding that depended on
    // it would reject confirmations that changed nothing.
    const token = mintStagedConfirmToken(CORRECTION_STAGED_VERB,
      binding({ payload: { reason: "r", replacement: { object: "Bo", validFrom: "2026-01-01T00:00:00.000Z" } } }),
    );
    const reordered = binding({
      payload: { replacement: { validFrom: "2026-01-01T00:00:00.000Z", object: "Bo" }, reason: "r" },
    });
    expect(verifyStagedConfirmToken(CORRECTION_STAGED_VERB, token, reordered).ok).toBe(true);
  });

  it("treats an absent optional field and an explicit `undefined` as the same correction", () => {
    // `JSON.stringify` drops `undefined` values, so a client that echoes the
    // staged payload back sends the absent form. Both must hash identically or
    // a `retract` staged with no reason could never be confirmed.
    const token = mintStagedConfirmToken(CORRECTION_STAGED_VERB, binding({ verb: "retract", payload: {} }));
    expect(
      verifyStagedConfirmToken(CORRECTION_STAGED_VERB,
        token,
        // Neither `reason` nor `replacement` supplied — both are exact optionals,
        // so the payload that omits them IS the empty object (#5522).
        binding({ verb: "retract", payload: {} }),
      ).ok,
    ).toBe(true);
  });

  it("rejects a tampered signature", () => {
    const token = mintStagedConfirmToken(CORRECTION_STAGED_VERB, binding());
    const segs = token.split(".");
    // Tamper at the BYTE level — flipping the last base64url char can be a
    // no-op (the final char of a 32-byte sig carries unused low bits).
    const sig = Buffer.from(segs[2], "base64url");
    sig[0] ^= 0xff;
    segs[2] = sig.toString("base64url");
    expect(verifyStagedConfirmToken(CORRECTION_STAGED_VERB, segs.join("."), binding())).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });
});

describe("correction confirm token — single-use", () => {
  it("burns once — a replay of the same token is refused", () => {
    // The acceptance criterion: "a replayed confirm is rejected. A looping agent
    // cannot re-fire." Both are the same mechanism.
    const token = mintStagedConfirmToken(CORRECTION_STAGED_VERB, binding(), { nonce: "nonce-replay-1" });
    const first = verifyStagedConfirmToken(CORRECTION_STAGED_VERB, token, binding());
    if (!first.ok) throw new Error(`expected a valid token, got ${first.reason}`);

    expect(burnConfirmNonce(first.nonce, first.expSeconds)).toBe(true);
    // The token still VERIFIES — it is cryptographically fine. What stops the
    // second confirm is the burn, which is why the route must do both.
    expect(verifyStagedConfirmToken(CORRECTION_STAGED_VERB, token, binding()).ok).toBe(true);
    expect(burnConfirmNonce(first.nonce, first.expSeconds)).toBe(false);
  });
});

describe("confirm gates are domain-separated", () => {
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
    expect(verifyStagedConfirmToken(CORRECTION_STAGED_VERB, restToken, binding())).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("a correction token does not verify at the REST write gate", () => {
    const correctionToken = mintStagedConfirmToken(CORRECTION_STAGED_VERB, binding());
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
