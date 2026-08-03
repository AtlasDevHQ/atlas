/**
 * `lexicalNorm` — the lexical layer of a claim's identity key (#5019,
 * ADR-0037).
 *
 * Scope note, because a green file here is easy to over-read: this proves what
 * the TypeScript does. It says nothing about migration 0187, which is a SECOND
 * implementation of the same function written in SQL — that pairing is
 * `identity-pg.test.ts`'s, against a real database, and it is the assertion
 * that actually matters.
 *
 * The cases below are grouped by what they would catch, not by input shape.
 * Most of them exist to pin something the function must NOT do.
 */

import { describe, expect, it } from "bun:test";
import { identityKey, lexicalNorm } from "@atlas/api/lib/brain/identity";
import { DEGENERATE_SURFACES, PAIRED_SURFACES } from "./identity-fixtures";

describe("lexicalNorm", () => {
  describe("what it does", () => {
    it("folds ASCII case", () => {
      expect(lexicalNorm("OWNED BY")).toBe("owned by");
      expect(lexicalNorm("Acme Corp")).toBe("acme corp");
    });

    it("unifies `_`, `-`, and ASCII whitespace into a single space", () => {
      expect(lexicalNorm("owned_by")).toBe("owned by");
      expect(lexicalNorm("owned-by")).toBe("owned by");
      expect(lexicalNorm("owned\tby")).toBe("owned by");
      expect(lexicalNorm("owned\nby")).toBe("owned by");
      expect(lexicalNorm("owned\vby")).toBe("owned by");
      expect(lexicalNorm("owned\fby")).toBe("owned by");
      expect(lexicalNorm("owned\rby")).toBe("owned by");
    });

    it("collapses mixed runs and trims the edges", () => {
      expect(lexicalNorm("  Reports   To  ")).toBe("reports to");
      expect(lexicalNorm("__Reports-_ To\t\t")).toBe("reports to");
    });

    it("is idempotent — a norm is its own norm", () => {
      // The fixpoint the vocabulary's forest invariant will rest on: applying
      // the table to its own output has to terminate.
      for (const surface of ["  Owned_By ", "led_by", "ACME-CORP", "$499", ""]) {
        expect(lexicalNorm(lexicalNorm(surface))).toBe(lexicalNorm(surface));
      }
    });

    it("is total — every string has a norm, including degenerate ones", () => {
      // Totality is what gives the vocabulary's forest invariant a fixpoint to
      // rest on. `""` is a NORM; whether it may be STORED is `identityKey`'s
      // question, below.
      expect(lexicalNorm("")).toBe("");
      expect(lexicalNorm("___")).toBe("");
      expect(lexicalNorm("   ")).toBe("");
    });
  });

  describe("identityKey — the storage decision", () => {
    it("is the norm for anything that norms to something", () => {
      expect(identityKey("Owned_By")).toBe("owned by");
      expect(identityKey("  Reports   To  ")).toBe("reports to");
    });

    it("REFUSES the empty key, which would collide every degenerate row", () => {
      // The hazard, concretely: with `""` stored, `"-"` and `"___"` share one
      // slot, so two unrelated placeholder claims corroborate as one — and at
      // `single` cardinality publishing either stamps `valid_to` on the other.
      // That is an over-match at a join arm, the one direction this module is
      // not allowed to be wrong in, reached from the input class the lexical
      // layer cannot tell apart.
      for (const degenerate of DEGENERATE_SURFACES) {
        expect(lexicalNorm(degenerate), `${JSON.stringify(degenerate)} norms to ""`).toBe("");
        expect(
          identityKey(degenerate),
          `${JSON.stringify(degenerate)} must not produce a storable key`,
        ).toBeNull();
      }
    });

    it("is reachable — the ingest guard does not screen these surfaces out", () => {
      // `reconcile.ts`'s MALFORMED_CLAIM test is `surface.trim() === ""`, and
      // `String#trim` strips whitespace but NOT `_` or `-`. So a producer
      // emitting `-` for a missing value lands a storable claim today, which is
      // why the arm above is a live rule rather than defence in depth.
      expect("-".trim()).not.toBe("");
      expect("___".trim()).not.toBe("");
    });
  });

  describe("what it must NOT do", () => {
    it("keeps `led_by` and `leads` apart — they are INVERSE relations", () => {
      const [ledBy, leads] = PAIRED_SURFACES.inverseRelations;
      // The single most important negative in this file. Any stemmer collapses
      // these into one slot, and the slot is a JOIN arm: publishing "Alice
      // leads Platform" would then stamp `valid_to` on "Platform led_by Alice".
      expect(lexicalNorm(ledBy)).not.toBe(lexicalNorm(leads));
      expect(lexicalNorm(ledBy)).toBe("led by");
      expect(lexicalNorm(leads)).toBe("leads");
    });

    it("keeps `is owned by` and `owns` apart — no copula or stopword stripping", () => {
      expect(lexicalNorm("is owned by")).not.toBe(lexicalNorm("owns"));
      expect(lexicalNorm("is owned by")).toBe("is owned by");
    });

    it("does NOT close #5000's pair — that repair is a vocabulary entry", () => {
      // `is priced at` → `priced at` is safe for THAT predicate and unsafe as a
      // general rule: the same rule collapses `is owned by` into `owns`. Pinned
      // so nobody "finishes the job" here with a regex.
      const [withCopula, without] = PAIRED_SURFACES.copulaPair;
      expect(lexicalNorm(withCopula)).not.toBe(lexicalNorm(without));
    });

    it("does not stem, singularize, or lemmatise", () => {
      expect(lexicalNorm("reports")).not.toBe(lexicalNorm("report"));
      expect(lexicalNorm("escalates_to")).not.toBe(lexicalNorm("escalate to"));
    });

    it("folds ASCII ONLY, so it cannot disagree with Postgres's `lower()`", () => {
      // Measured, not assumed: `lower()` and `String#toLowerCase()` part ways
      // on U+0130 and on Greek word-final sigma, and Postgres's answer moves
      // with the database collation on top of that. The cost is an under-match
      // — `Café`/`CAFÉ` stay apart — which is a duplicate row and a missed
      // corroboration, both recoverable, and both repairable by a vocabulary
      // entry. See `identity-pg.test.ts` for the half that runs the real
      // migration over these same characters.
      // Driven off the shared list, so a surface cannot be dropped from the pg
      // pairing while staying pinned here.
      expect(lexicalNorm("CAFÉ")).toBe("cafÉ");
      for (const surface of PAIRED_SURFACES.caseFold) {
        expect(
          lexicalNorm(surface).toLowerCase() === lexicalNorm(surface) &&
            surface.toLowerCase() !== surface,
          `${JSON.stringify(surface)} was case-folded above ASCII — Postgres would disagree`,
        ).toBe(false);
      }
    });

    it("does not treat non-ASCII spaces as separators", () => {
      // JavaScript's `\s` would; Postgres's `[[:space:]]` consults the locale.
      // Neither is a set the two implementations can agree on, so U+00A0 stays
      // an ordinary character in the key. Written as an ESCAPE on purpose: a
      // literal NBSP in the source is indistinguishable from a space on sight,
      // and this assertion is worthless if it is silently testing a space.
      const [nbsp] = PAIRED_SURFACES.nonAsciiSpace;
      expect(lexicalNorm(nbsp)).toBe(nbsp);
      expect(lexicalNorm(nbsp)).not.toBe("owned by");
    });

    it("does not touch the interior of a token", () => {
      expect(lexicalNorm("$499")).toBe("$499");
      expect(lexicalNorm("499 USD")).toBe("499 usd");
      expect(lexicalNorm("a.b/c")).toBe("a.b/c");
    });
  });
});
