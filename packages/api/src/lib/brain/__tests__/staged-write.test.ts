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
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";

import {
  mintStagedConfirmToken,
  verifyAndBurnStagedConfirm,
  verifyStagedConfirmToken,
  type StagedVerb,
} from "@atlas/api/lib/brain/staged-write";
import { PROPOSAL_STAGED_VERB } from "@atlas/api/lib/brain/staged-propose";
import { CORRECTION_STAGED_VERB } from "@atlas/api/lib/brain/staged-correct";
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
 * One row per staged verb.
 *
 * `binding` is what the confirm endpoint re-derives; `tampered` is the same
 * binding with ONE bound field changed — whichever field, for that verb, means
 * the human agreed to a different write. The gate must reject it identically for
 * every verb, which is the property a per-route copy could not give you.
 *
 * ⚠️ **A third staged verb goes here, and nowhere else.** If adding it needs a
 * new case below rather than a new row, the gate grew a per-verb branch and the
 * refactor has been undone. `registry.test.ts` pins the confirm-capable delta as
 * an exact set, so the verb has to be named there too — that is the other half
 * of the same guard.
 */
interface VerbRow {
  readonly label: string;
  // The gate is generic in its binding, and each row closes over its own; the
  // table is deliberately heterogeneous, so the shared type is the erased one.
  readonly verb: StagedVerb<never>;
  readonly binding: () => unknown;
  readonly tampered: () => unknown;
  /** What was changed in `tampered`, for the assertion message. */
  readonly tamperedField: string;
}

const PROPOSAL_ROW: VerbRow = {
  label: "proposeFact",
  verb: PROPOSAL_STAGED_VERB as StagedVerb<never>,
  binding: () => ({
    workspaceId: "ws-1",
    claim: { subject: "Ana", predicate: "is the DRI for", object: "billing" },
  }),
  tampered: () => ({
    workspaceId: "ws-1",
    claim: { subject: "Ana", predicate: "is the DRI for", object: "payroll" },
  }),
  tamperedField: "the claim's object — what would be asserted",
};

const CORRECTION_ROW: VerbRow = {
  label: "correct_fact",
  verb: CORRECTION_STAGED_VERB as StagedVerb<never>,
  binding: () => ({
    workspaceId: "ws-1",
    factId: "fact-1",
    verb: "supersede" as const,
    payload: { replacement: { object: "Bo" } },
  }),
  tampered: () => ({
    workspaceId: "ws-1",
    factId: "fact-1",
    verb: "supersede" as const,
    payload: { replacement: { object: "Cy" } },
  }),
  tamperedField: "the replacement value — what the fact would become",
};

const STAGED_VERBS: readonly VerbRow[] = [PROPOSAL_ROW, CORRECTION_ROW];

/** Mint against a row's own binding, typed through the row's erased verb. */
function mint(row: VerbRow, binding: unknown = row.binding(), options = {}): string {
  return mintStagedConfirmToken(row.verb, binding as never, options);
}

function gate(row: VerbRow, token: string, binding: unknown = row.binding(), now?: number) {
  return now === undefined
    ? verifyAndBurnStagedConfirm(row.verb, token, binding as never)
    : verifyAndBurnStagedConfirm(row.verb, token, binding as never, now);
}

describe("the staged-write gate — every registered verb", () => {
  it("registers each verb under a DISTINCT typ, so no token is spendable at another gate", () => {
    // Not a loop: the whole point is the set, and a duplicate `typ` would make
    // one verb's confirmation spendable on another's write.
    const typs = STAGED_VERBS.map((r) => r.verb.kind.typ);
    expect(new Set(typs).size).toBe(typs.length);
    // Distinct TTL vars too — an operator tuning one gate's window must not
    // silently move the other's.
    const envVars = STAGED_VERBS.map((r) => r.verb.kind.ttlEnvVar);
    expect(new Set(envVars).size).toBe(envVars.length);
  });

  for (const row of STAGED_VERBS) {
    describe(row.label, () => {
      it("admits a correctly-bound token exactly once", () => {
        expect(gate(row, mint(row))).toEqual({ ok: true });
      });

      it("⭐ refuses the SECOND presentation of one token — the nonce is single-use", () => {
        const token = mint(row);
        expect(gate(row, token)).toEqual({ ok: true });
        expect(
          gate(row, token),
          "a replayed confirm was admitted — a looping agent could re-fire one human confirmation",
        ).toEqual({ ok: false, failure: "replayed" });
      });

      it("⭐ burns the nonce on the ATTEMPT, so a token whose write then fails cannot be re-spent", () => {
        // The gate returns `ok: true` and the caller goes on to a write that
        // refuses or throws. That is the interesting case: the nonce must stay
        // spent, or one confirmation could be re-fired against many claims or
        // many target states — a graph probe.
        const token = mint(row);
        expect(gate(row, token)).toEqual({ ok: true });
        // …the verb refused. Nothing hands the nonce back.
        expect(gate(row, token)).toEqual({ ok: false, failure: "replayed" });
      });

      it("⭐ rejects a payload edited after staging, without burning anything", () => {
        const token = mint(row);
        expect(
          gate(row, token, row.tampered()),
          `a token survived a tamper of ${row.tamperedField}`,
        ).toEqual({ ok: false, failure: "invalid", reason: "binding-mismatch" });
        // The tampered attempt must not have spent the nonce: an attacker who
        // could burn a pending confirmation by POSTing a mangled copy of it
        // would have a denial-of-service on every staged write.
        expect(gate(row, token)).toEqual({ ok: true });
      });

      it("rejects a token minted for another workspace", () => {
        const token = mint(row, { ...(row.binding() as object), workspaceId: "ws-other" });
        expect(gate(row, token)).toEqual({
          ok: false,
          failure: "invalid",
          reason: "binding-mismatch",
        });
      });

      it("rejects a missing and a malformed token under the one neutral arm", () => {
        expect(gate(row, "")).toEqual({ ok: false, failure: "invalid", reason: "missing" });
        expect(gate(row, "not-a-token")).toEqual({
          ok: false,
          failure: "invalid",
          reason: "malformed",
        });
      });

      it("rejects an expired token, and does not burn it", () => {
        const token = mint(row, row.binding(), { nowSeconds: 1_000, ttlSeconds: 60 });
        expect(gate(row, token, row.binding(), 2_000)).toEqual({
          ok: false,
          failure: "invalid",
          reason: "expired",
        });
        // Still inside its window it is admitted — proving the rejection above
        // was the clock and not a burn the expired attempt performed.
        expect(gate(row, token, row.binding(), 1_059)).toEqual({ ok: true });
      });

      it("⭐ separates a missing signing key from an invalid token — a 500, never the neutral 400", () => {
        // `no-key` is an operator misconfiguration. Collapsing it into the
        // neutral client rejection would tell a caller their confirmation was
        // bad when the server was, and hide a broken deployment behind a 400.
        clearKeyEnv();
        try {
          expect(gate(row, "a.b.c")).toEqual({ ok: false, failure: "unverifiable" });
          expect(() => mint(row)).toThrow(/no signing key configured/);
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
      const token = mint(minter);
      for (const presenter of STAGED_VERBS) {
        if (presenter === minter) continue;
        expect(
          gate(presenter, token),
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
      const token = mint(row);
      expect(verifyStagedConfirmToken(row.verb, token, row.binding() as never).ok).toBe(true);
      expect(verifyStagedConfirmToken(row.verb, token, row.binding() as never).ok).toBe(true);
      // …and the nonce is still there to be spent.
      expect(gate(row, token)).toEqual({ ok: true });
    }
  });
});
