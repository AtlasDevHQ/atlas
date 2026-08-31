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
 * Nor the per-verb bindings' substance — `staged-correct.test.ts` still pins
 * what a correction token binds and what tampering with each field does, and
 * the two route suites still pin the HTTP contract. This file sits between
 * them, on the part that used to be written twice.
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
import type { MintConfirmTokenOptions } from "@atlas/api/lib/confirm-token";
import { _resetConfirmNonces } from "@atlas/api/lib/confirm-token";
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
      it("admits a correctly-bound token exactly once", () => {
        expect(row.gate(row.mint())).toEqual({ ok: true });
      });

      it("⭐ refuses the SECOND presentation of one token — the nonce is single-use", () => {
        const token = row.mint();
        expect(row.gate(token)).toEqual({ ok: true });
        expect(
          row.gate(token),
          "a replayed confirm was admitted — a looping agent could re-fire one human confirmation",
        ).toEqual({ ok: false, failure: "replayed" });
      });

      it("⭐ burns the nonce on the ATTEMPT, so a token whose write then fails cannot be re-spent", () => {
        // The gate returns `ok: true` and the caller goes on to a write that
        // refuses or throws. That is the interesting case: the nonce must stay
        // spent, or one confirmation could be re-fired against many claims or
        // many target states — a graph probe.
        const token = row.mint();
        expect(row.gate(token)).toEqual({ ok: true });
        // …the verb refused. Nothing hands the nonce back.
        expect(row.gate(token)).toEqual({ ok: false, failure: "replayed" });
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
