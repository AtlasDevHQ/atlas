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
import {
  identityAlias,
  identityVocabulary,
  SLOT_POSITIONS,
  identityKey,
  lexicalNorm,
  slotKey,
} from "@atlas/api/lib/brain/identity";
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

  describe("slotKey — the whole composition (#5020)", () => {
    it("is `identityKey` while the vocabulary is empty", () => {
      // The day-one claim, and the reason #5019's slice changed no behaviour:
      // `alias` is the identity function, so every key produced today is
      // exactly what migration 0187's backfill wrote.
      for (const surface of ["Owned_By", "  Reports   To  ", "led_by", "leads", "$499"]) {
        expect(slotKey(surface, identityAlias), surface).toBe(identityKey(surface));
      }
      for (const degenerate of DEGENERATE_SURFACES) {
        expect(slotKey(degenerate, identityAlias)).toBeNull();
      }
    });

    it("composes the vocabulary OVER the norm, not over the surface", () => {
      // The seam's shape, which is what this slice pins. An entry maps a
      // NORMALIZED spelling, so one entry covers every casing and separator
      // variant of both sides — a lookup keyed on raw surfaces would need
      // `Is_Priced At`, `IS PRICED AT`, and the rest spelled out.
      const seen: string[] = [];
      const vocabulary = (norm: string): string => {
        seen.push(norm);
        return norm === "is priced at" ? "priced at" : norm;
      };

      expect(slotKey("Is_Priced  At", vocabulary)).toBe("priced at");
      expect(slotKey("priced at", vocabulary)).toBe("priced at");
      expect(seen).toEqual(["is priced at", "priced at"]);
    });

    it("never consults the vocabulary for a surface that asserts nothing", () => {
      // A claim whose subject norms away has no slot to look up, so there is
      // nothing for an entry to map — and calling out with `""` would invite a
      // vocabulary that answers it.
      let consulted = 0;
      const vocabulary = (norm: string): string => {
        consulted++;
        return norm;
      };
      for (const degenerate of DEGENERATE_SURFACES) {
        expect(slotKey(degenerate, vocabulary)).toBeNull();
      }
      expect(consulted).toBe(0);
    });

    it("RE-NORMS the vocabulary's answer instead of trusting it", () => {
      // The failure this defends against is an authoring mistake, not a bug: an
      // admin types the canonical DISPLAY form as an entry's target. Trusted
      // verbatim, `Priced At` is a key that joins nothing to anything,
      // corpus-wide, with nothing anywhere saying so.
      //
      // A vocabulary that does NOT already return norms, on purpose — a
      // conforming one cannot tell `alias(norm)` from `identityKey(alias(norm))`
      // and would make this assertion unfalsifiable.
      expect(slotKey("is_priced  at", () => "Priced   At")).toBe("priced at");
      // …and the empty-key arm falls out of the same call rather than being a
      // special case: a target that norms away is the `DEFAULT ''` hazard
      // reached from the vocabulary side, and `null` joins nothing.
      expect(slotKey("owned by", () => "")).toBeNull();
      expect(slotKey("owned by", () => " - _ ")).toBeNull();
    });

    it("leaves the fixpoint intact — a key re-keys to itself", () => {
      // `f(f(x)) === f(x)`, which is what lets ADR-0037 §7's drift re-key run
      // over a corpus without walking rows to a new slot on each pass. Driven
      // off the shared corpus with the REAL default alias, rather than off a
      // hand-written vocabulary that satisfies idempotence by construction.
      for (const surface of [
        ...PAIRED_SURFACES.inverseRelations,
        ...PAIRED_SURFACES.copulaPair,
        ...PAIRED_SURFACES.caseFold,
        ...PAIRED_SURFACES.nonAsciiSpace,
        "  __Reports-_ To\t\t",
        "$499",
      ]) {
        const once = slotKey(surface, identityAlias);
        if (once === null) continue;
        expect(
          slotKey(once, identityAlias),
          `${JSON.stringify(surface)} does not re-key to itself`,
        ).toBe(once);
      }
    });

    it("identityAlias returns its input unchanged, including the empty norm", () => {
      // Only `identityAlias` itself is pinned here. That the DEFAULT is this
      // function is not separately assertable — any identity-behaving default
      // satisfies the same equality — and the day-one equivalence above
      // (`slotKey === identityKey` across the corpus) is what covers it.
      expect(identityAlias("owned by")).toBe("owned by");
      expect(identityAlias("")).toBe("");
    });

    it("identityVocabulary is the empty vocabulary at every position (#5022)", () => {
      // Three positions, all the identity function — a workspace that has
      // approved no alias. Enumerated from SLOT_POSITIONS rather than written
      // out, so adding a fourth slot to the claim shape fails HERE rather than
      // silently shipping a position with no vocabulary arm at all.
      expect(Object.keys(identityVocabulary).toSorted()).toEqual([...SLOT_POSITIONS].toSorted());
      for (const position of SLOT_POSITIONS) {
        expect(identityVocabulary[position]("owned by"), position).toBe("owned by");
        expect(identityVocabulary[position](""), position).toBe("");
      }
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
